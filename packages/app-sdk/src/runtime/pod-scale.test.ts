// Client scale fixtures for Pod-wide reads (#40). They establish client request behaviour
// across catalogue sizes, not backend or live scalability.
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime } from './types.js';
import {
  catalogue,
  deferred,
  fixture,
  jwt,
  pod,
  restored,
  settleLease,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));

const sd = 'http://www.w3.org/ns/sparql-service-description#';
const root = `${pod}/_system/contexts/apps/seeder`;
const people = `${root}/people`;
const space = (i: number) => `${root}/spaces/s${String(i).padStart(5, '0')}`;

/** Catalogue shapes of #40: one Context; ordinary access (100 spaces + people); broad access (10,000 spaces, each with a meta graph, + people). */
const SCALES = [
  { name: 'one Context', spaces: 0, meta: false },
  { name: 'ordinary access (101 Contexts)', spaces: 100, meta: false },
  { name: 'broad access (20,001 Contexts)', spaces: 10_000, meta: true },
] as const;
type Scale = (typeof SCALES)[number];
const broad = SCALES[2];

function contexts({ spaces, meta }: Scale): string[] {
  const iris = [people];
  for (let i = 1; i <= spaces; i++) {
    iris.push(space(i));
    if (meta) iris.push(`${space(i)}/meta`);
  }
  return iris;
}

const SELECT =
  'SELECT ?task ?name ?g WHERE { GRAPH ?g { ?task <https://schema.org/name> ?name } }';
const rows = () =>
  new Response(
    JSON.stringify({
      head: { vars: ['task', 'name', 'g'] },
      results: {
        bindings: [
          {
            task: { type: 'uri', value: 'urn:task:1' },
            name: { type: 'literal', value: 'Task 1' },
            g: { type: 'uri', value: people },
          },
        ],
      },
    }),
    { headers: { 'content-type': 'application/sparql-results+json' } },
  );
const description = (iri: string) =>
  Response.json({
    '@id': iri,
    '@type': [`${sd}NamedGraph`],
    [`${sd}name`]: [{ '@id': iri }],
    'https://schema.sempods.org/public': [{ '@value': false }],
    'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': 'People' }],
  });

/** Signed in through the callback; the catalogue answers with [scale]'s Contexts. */
async function signedIn(scale: Scale) {
  const f = fixture({ preferences: null });
  runtimes.push(f.runtime);
  const iris = contexts(scale);
  f.setCatalogue(async () => catalogue(iris, []));
  f.setDescriptions(async (url) => description(url));
  f.setQuery(async () => rows());
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  runtimes.push(runtime);
  expect(await runtime.initialize()).toMatchObject({
    interaction: 'completed',
  });
  return { ...f, runtime, id: connection.id, iris };
}

/** Requests by route since [mark], so each assertion counts only its own phase. */
function counter(f: ReturnType<typeof fixture>) {
  let mark = 0;
  return {
    mark() {
      mark = f.fetch.mock.calls.length;
    },
    since() {
      const paths = f.fetch.mock.calls
        .slice(mark)
        .map(([url]) => new URL(url).pathname);
      return {
        query: paths.filter((p) => p.endsWith('/_system/sparql/query')).length,
        catalogue: paths.filter((p) => p.endsWith('/_system/contexts')).length,
        descriptions: paths.filter((p) => p.includes('/_system/contexts/'))
          .length,
        resources: paths.filter((p) => p.includes('/_system/resources/'))
          .length,
        token: paths.filter((p) => p.endsWith('/token')).length,
      };
    },
  };
}

it.each(SCALES)(
  'three Pod reads send three requests and no discovery ($name)',
  async (scale) => {
    const f = await signedIn(scale);
    const requests = counter(f);
    requests.mark();
    const reader = f.runtime.bindPod(f.id);
    for (let i = 0; i < 3; i++)
      expect(await reader.sparql.select(SELECT)).toMatchObject({
        kind: 'ok',
        body: { variables: ['task', 'name', 'g'] },
      });
    expect(requests.since()).toEqual({
      query: 3,
      catalogue: 0,
      descriptions: 0,
      resources: 0,
      token: 0,
    });
  },
);

it.each(SCALES)(
  'an active Context flow adds one catalogue and one description request, and Pod reads stay at one request each ($name)',
  async (scale) => {
    const f = await signedIn(scale);
    const requests = counter(f);
    requests.mark();
    await f.runtime.loadContexts(f.id);
    f.runtime.selectContext(f.id, people);
    const reader = f.runtime.bindPod(f.id);
    for (let i = 0; i < 3; i++)
      expect(await reader.sparql.select(SELECT)).toMatchObject({
        kind: 'ok',
      });
    await vi.waitFor(() =>
      expect(requests.since().descriptions).toBeGreaterThan(0),
    );
    expect(requests.since()).toEqual({
      query: 3,
      catalogue: 1,
      descriptions: 1,
      resources: 0,
      token: 0,
    });
    const fact = f.runtime.getSnapshot()[0]!.catalogue;
    expect(fact.kind === 'ready' && fact.contexts.length).toBe(f.iris.length);
  },
);

it('a restored connection reads with one request and no catalogue (broad access)', async () => {
  const f = await signedIn(broad);
  f.runtime.dispose();
  await settleLease();
  const requests = counter(f);
  requests.mark();
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  await next.initialize();
  await restored(next);
  expect(next.getSnapshot()[0]).toMatchObject({
    session: { kind: 'active' },
    catalogue: { kind: 'unknown' },
  });
  expect(await next.bindPod(f.id).sparql.select(SELECT)).toMatchObject({
    kind: 'ok',
  });
  expect(requests.since()).toMatchObject({
    query: 1,
    catalogue: 0,
    descriptions: 0,
    resources: 0,
    token: 0,
  });
});

it('a 401 renews once and resends once; a 403 is refused with no catalogue request (broad access)', async () => {
  const f = await signedIn(broad);
  const reader = f.runtime.bindPod(f.id);
  const requests = counter(f);
  let refused = true;
  f.setQuery(async () => {
    if (!refused) return rows();
    refused = false;
    return new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
    });
  });
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  requests.mark();
  expect(await reader.sparql.select(SELECT)).toMatchObject({ kind: 'ok' });
  expect(requests.since()).toMatchObject({
    query: 2,
    token: 1,
    catalogue: 0,
    descriptions: 0,
  });

  f.setQuery(async () => new Response(null, { status: 403 }));
  requests.mark();
  expect(await reader.sparql.select(SELECT)).toEqual({
    kind: 'refused',
    status: 403,
  });
  expect(requests.since()).toEqual({
    query: 1,
    catalogue: 0,
    descriptions: 0,
    resources: 0,
    token: 0,
  });
  expect(reader.getSnapshot()).toMatchObject({ current: true, read: true });
});

it('two Context switches during a pending Pod read neither cancel nor resend it (broad access)', async () => {
  const f = await signedIn(broad);
  await f.runtime.loadContexts(f.id);
  f.runtime.selectContext(f.id, space(1));
  const reader = f.runtime.bindPod(f.id);
  const gate = deferred<Response>();
  f.setQuery(() => gate.promise);
  const requests = counter(f);
  requests.mark();
  const read = reader.sparql.select(SELECT);
  await vi.waitFor(() => expect(requests.since().query).toBe(1));
  f.runtime.selectContext(f.id, space(2));
  f.runtime.selectContext(f.id, people);
  gate.resolve(rows());
  expect(await read).toMatchObject({ kind: 'ok' });
  expect(requests.since()).toMatchObject({ query: 1, catalogue: 0 });
});

// Opt-in: SEMPODS_SCALE_TIMING=1 (with --silent=false) records how long one explicit load of
// the complete broad catalogue takes in-process: fixture serialization, JSON parsing, decoding
// and publishing, without network. It reports, it does not assert a budget.
it.runIf(process.env['SEMPODS_SCALE_TIMING'])(
  'records complete-catalogue load time (broad access)',
  async () => {
    const f = await signedIn(broad);
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const begin = performance.now();
      await f.runtime.loadContexts(f.id);
      runs.push(performance.now() - begin);
    }
    runs.sort((a, b) => a - b);
    console.info(
      `complete catalogue, ${f.iris.length} Contexts: median ${runs[2]!.toFixed(1)} ms, min ${runs[0]!.toFixed(1)} ms`,
    );
  },
);
