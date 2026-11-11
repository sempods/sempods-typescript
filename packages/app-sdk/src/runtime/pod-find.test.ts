// `BoundPod.find` (#233): the client Find primitive through a Pod handle, with
// the same lifetime and admission as `sparql`. Fixture evidence only.
import { afterEach, expect, it, vi } from 'vitest';
import type { FindGraph } from '@sempods/client-sdk';
import { createViewLoader } from '../authoring/load.js';
import type { BrowserRuntime } from './types.js';
import type { BoundPod } from './view.js';
import {
  deferred,
  fixture,
  jwt,
  pod,
  returnedSession,
  twoPods,
  unauthorized,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
const loaders: { dispose(): void }[] = [];
afterEach(() => {
  loaders.splice(0).forEach((l) => l.dispose());
  runtimes.splice(0).forEach((r) => r.dispose());
});
const keep = (runtime: BrowserRuntime) => void runtimes.push(runtime);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
/** A Find answer naming one hit in `context` of the Pod at `base`. */
const hit = (base: string, name: string, context = 'work') =>
  Response.json([
    {
      '@id': `${base}/_system/contexts/${context}`,
      '@graph': [{ '@id': `${base}/${name}` }],
    },
  ]);
const body = (init?: RequestInit) => JSON.parse(String(init?.body)) as unknown;
/** The first Find request a fixture sent. */
function findCall(f: ReturnType<typeof fixture>) {
  const call = f.fetch.mock.calls.find(([u]) => u.endsWith('/_system/find'));
  if (!call) throw new Error('No Find request was sent.');
  return call;
}

async function signedIn(overrides = {}) {
  const f = await returnedSession(
    keep,
    fixture({ preferences: null, ...overrides }),
  );
  await f.runtime.initialize();
  return { ...f, reader: f.runtime.bindPod(f.id) };
}

it('sends the text, downscope and limit unchanged, never the read priority', async () => {
  const f = await signedIn();
  f.setFind(async () => hit(pod, 'e1'));
  expect(
    await f.reader.find('konzert', {
      contexts: [work],
      limit: 5,
      priority: 'current',
    }),
  ).toEqual({
    kind: 'ok',
    body: [{ context: work, nodes: [{ '@id': `${pod}/e1` }] }],
  });
  const [url, init] = findCall(f);
  expect(url).toBe(`${pod}/_system/find`);
  expect(body(init)).toEqual({
    text: 'konzert',
    include_contexts: true,
    contexts: [work],
    limit: 5,
  });
  expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
});

it('cancels for the caller and invalidates on disconnect, also for a late answer', async () => {
  const f = await signedIn();
  const gate = deferred<Response>();
  const signals: AbortSignal[] = [];
  f.setFind(async (_url, init) => {
    signals.push(init!.signal!);
    return gate.promise;
  });
  const caller = new AbortController();
  const cancelled = f.reader.find('x', { signal: caller.signal });
  await vi.waitFor(() => expect(signals).toHaveLength(1));
  caller.abort();
  expect(await cancelled).toEqual({ kind: 'cancelled' });
  const pending = f.reader.find('x');
  await vi.waitFor(() => expect(signals).toHaveLength(2));
  await f.runtime.disconnect(f.id);
  gate.resolve(hit(pod, 'late'));
  expect(await pending).toEqual({ kind: 'invalidated' });
  expect(signals[1]!.aborted).toBe(true);
});

it('waits for a podReadLimit slot like other Pod reads, and a current find goes first', async () => {
  const f = await signedIn({ podReadLimit: { perPod: 1 } });
  const blocker = deferred<Response>();
  f.setQuery(() => blocker.promise);
  const texts: unknown[] = [];
  f.setFind(async (_url, init) => {
    texts.push((body(init) as { text: string }).text);
    return Response.json([]);
  });
  const running = f.reader.sparql.construct('CONSTRUCT WHERE { ?s ?p ?o }');
  await vi.waitFor(() => expect(f.count('/_system/sparql/query')).toBe(1));
  const older = f.reader.find('older');
  const current = f.reader.find('current', { priority: 'current' });
  await flush();
  expect(texts).toEqual([]);
  blocker.resolve(Response.json([]));
  await Promise.all([running, older, current]);
  expect(texts).toEqual(['current', 'older']);
});

it('finds without a token when reading anonymously', async () => {
  const f = fixture({
    preferences: null,
    signIn: 'optional',
    preset: { podUrl: pod },
  });
  keep(f.runtime);
  await f.runtime.initialize();
  f.setFind(async () => hit(pod, 'public'));
  expect(await f.runtime.bindPod(pod).find('x')).toMatchObject({ kind: 'ok' });
  const [, init] = findCall(f);
  expect(new Headers(init?.headers).get('authorization')).toBeNull();
});

it('one loader per Pod: changed grants refresh a ready source while another still loads, and a lost source is withdrawn', async () => {
  const { f, runtime, other, otherUrl } = await twoPods(
    keep,
    { scopes: { optional: ['ai'] } },
    'ai',
  );
  const bobAnswer = deferred<Response>();
  const aliceRefresh = deferred<Response>();
  let aliceFinds = 0;
  f.setFind(async (url) => {
    if (url.startsWith(otherUrl)) return bobAnswer.promise;
    return ++aliceFinds === 1 ? hit(pod, 'alice-1') : aliceRefresh.promise;
  });
  const load = (reader: BoundPod) => {
    const l = createViewLoader(reader, (p, signal) =>
      p.find('konzert', { signal }),
    );
    loaders.push(l);
    void l.reload();
    return l;
  };
  const alice = load(runtime.bindPod(f.id));
  const bob = load(runtime.bindPod(other.id));
  const hits = (l: ReturnType<typeof load>) => {
    const state = l.getSnapshot();
    return state.kind === 'ready'
      ? (state.data as readonly FindGraph[]).flatMap((g) =>
          g.nodes.map((n) => n['@id']),
        )
      : state.kind;
  };
  await vi.waitFor(() => expect(hits(alice)).toEqual([`${pod}/alice-1`]));
  expect(hits(bob)).toBe('loading');

  // Alice's grants narrow (a renewal after a 401) while Bob still loads.
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: '' }),
      token_type: 'Bearer',
      refresh_token: 'narrowed',
    }),
  );
  let queries = 0;
  f.setQuery(async () =>
    ++queries === 1 ? unauthorized() : Response.json([]),
  );
  const revision = runtime.bindPod(f.id).getSnapshot().revision;
  await runtime.bindPod(f.id).sparql.construct('CONSTRUCT WHERE { ?s ?p ?o }');
  expect(runtime.bindPod(f.id).getSnapshot().revision).toBe(revision + 1);
  // The answer read under the old grants is withdrawn at once, before the
  // refresh under the new grants answers.
  expect(hits(alice)).toBe('loading');
  await vi.waitFor(() => expect(aliceFinds).toBe(2));
  expect(hits(alice)).toBe('loading');
  aliceRefresh.resolve(hit(pod, 'alice-2'));
  await vi.waitFor(() => expect(hits(alice)).toEqual([`${pod}/alice-2`]));
  expect(hits(bob)).toBe('loading');

  bobAnswer.resolve(hit(otherUrl, 'bob-1'));
  await vi.waitFor(() => expect(hits(bob)).toEqual([`${otherUrl}/bob-1`]));
  await runtime.disconnect(f.id);
  expect(hits(alice)).toBe('unavailable');
  expect(hits(bob)).toEqual([`${otherUrl}/bob-1`]);
});
