/**
 * Protocol conformance: catalogue and
 * target provenance, selected-context queries and representation evidence.
 * Deterministic fixtures, not evidence about a deployed Kotlin Pod.
 */
import { describe, expect, it } from 'vitest';
import {
  bearer,
  createPod,
  type PodFetch,
  type PodRequestInit,
} from './index.js';

const sd = 'http://www.w3.org/ns/sparql-service-description#';
const sps = 'https://schema.sempods.org/';
const SUBJECT = 'https://example.org/shared/item-1';

type Seen = { url: URL; init: PodRequestInit };
/** One fake Pod origin; answers by route, records every request. */
function fakePods(answer: (seen: Seen) => Response | Promise<Response>): {
  fetch: PodFetch;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const fetch: PodFetch = async (url, init) => {
    const entry = { url: new URL(url), init: init ?? {} };
    seen.push(entry);
    return answer(entry);
  };
  return { fetch, seen };
}
const ld = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/ld+json', ...headers },
  });
const catalogue = (pod: string, readable: string[], writable: string[] = []) =>
  ld({
    '@id': `${pod}/_system/contexts`,
    '@type': [`${sd}GraphCollection`],
    ...(readable.length
      ? {
          [`${sd}namedGraph`]: readable.map((iri) => ({ '@id': iri })),
          [`${sps}readableContext`]: readable.map((iri) => ({ '@id': iri })),
        }
      : {}),
    ...(writable.length
      ? { [`${sps}writableContext`]: writable.map((iri) => ({ '@id': iri })) }
      : {}),
  });

describe('catalogue and target provenance', () => {
  const pod = 'https://pod.example/alice';
  const tasks = `${pod}/_system/contexts/tasks`;
  const hidden = `${pod}/_system/contexts/private`;
  const absent = `${pod}/_system/contexts/never-registered`;

  /** `private` exists but is not visible to this caller; both answer like absence. */
  const server = () =>
    fakePods(({ url }) => {
      if (url.pathname.endsWith('/_system/contexts'))
        return catalogue(pod, [tasks], [tasks]);
      const context = url.searchParams.get('context');
      if (context === hidden || context === absent)
        return new Response(null, { status: 404 });
      return new Response(null, { status: 204 });
    });

  it('treats hidden and absent contexts identically, disclosing neither', async () => {
    const { fetch, seen } = server();
    const alice = createPod(pod, { auth: bearer('t'), fetch });
    const listed = await alice.catalogue();
    expect(listed.kind === 'ok' && listed.body.map((c) => c.iri)).toEqual([
      tasks,
    ]);
    const reads = await Promise.all(
      [hidden, absent].map((ctx) => alice.context(ctx).subjects.get(SUBJECT)),
    );
    expect(reads).toEqual([{ kind: 'not-found' }, { kind: 'not-found' }]);
    const writes = await Promise.all(
      [hidden, absent].map((ctx) =>
        alice.context(ctx).subjects.delete(SUBJECT, { ifMatch: '"v1"' }),
      ),
    );
    expect(writes).toEqual([{ kind: 'not-found' }, { kind: 'not-found' }]);
    // One request per operation, each to exactly the requested context.
    expect(
      seen.slice(1).map((s) => s.url.searchParams.getAll('context')),
    ).toEqual([[hidden], [absent], [hidden], [absent]]);
  });

  it('never falls back from a lost saved target to another context', async () => {
    const { fetch, seen } = server();
    const alice = createPod(pod, { auth: bearer('t'), fetch });
    // The app saved `private` earlier; the catalogue no longer lists it.
    const saved = hidden;
    const write = await alice
      .context(saved)
      .subjects.patch(SUBJECT, { 'urn:p': [] }, { ifMatch: '"v1"' });
    expect(write).toEqual({ kind: 'not-found' });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url.searchParams.getAll('context')).toEqual([saved]);
    // There is no implicit or empty target to fall back to.
    expect(() => alice.context('')).toThrow(
      expect.objectContaining({
        reason: { code: 'invalid-argument', argument: 'context' },
      }) as Error,
    );
    expect(seen).toHaveLength(1);
  });

  it('keeps the same subject IRI on two Pods apart, credentials included', async () => {
    const bobPod = 'https://pod.example/bob';
    const { fetch, seen } = fakePods(({ url }) =>
      ld(
        {
          '@id': SUBJECT,
          'https://schema.org/name': [
            { '@value': url.pathname.startsWith('/alice/') ? 'A' : 'B' },
          ],
        },
        { etag: url.pathname.startsWith('/alice/') ? '"a1"' : '"b1"' },
      ),
    );
    const alice = createPod(pod, { auth: bearer('alice-token'), fetch });
    const bob = createPod(bobPod, { auth: bearer('bob-token'), fetch });
    const [a, b] = await Promise.all([
      alice.context(tasks).subjects.get(SUBJECT),
      bob.context(`${bobPod}/_system/contexts/tasks`).subjects.get(SUBJECT),
    ]);
    expect(a).toMatchObject({ kind: 'ok', etag: '"a1"' });
    expect(b).toMatchObject({ kind: 'ok', etag: '"b1"' });
    expect(
      seen.map((s) => [
        s.url.pathname.split('/_system/')[0],
        new Headers(s.init.headers).get('authorization'),
      ]),
    ).toEqual([
      ['/alice', 'Bearer alice-token'],
      ['/bob', 'Bearer bob-token'],
    ]);
    // A context of another Pod is still only an identifier on this Pod's route.
    seen.length = 0;
    await alice
      .context(`${bobPod}/_system/contexts/tasks`)
      .subjects.get(SUBJECT);
    expect(seen[0]!.url.origin + seen[0]!.url.pathname).toMatch(
      /^https:\/\/pod\.example\/alice\/_system\/resources\//,
    );
  });

  it('requests the catalogue without reuse and as a fresh, credential-isolated read', async () => {
    const { fetch, seen } = server();
    await createPod(pod, { auth: bearer('t'), fetch }).catalogue();
    expect(seen[0]!.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
    });
  });
});

describe('selected-context queries', () => {
  const pod = 'https://pod.example/alice';
  const tasks = `${pod}/_system/contexts/tasks`;
  const notes = `${pod}/_system/contexts/notes`;

  it('downscopes to the selected context only, never to another readable one', async () => {
    const { fetch, seen } = fakePods(({ url }) =>
      url.pathname.endsWith('/_system/contexts')
        ? catalogue(pod, [tasks, notes])
        : ld([{ '@id': SUBJECT }]),
    );
    const alice = createPod(pod, { auth: bearer('t'), fetch });
    const listed = await alice.catalogue();
    expect(listed.kind === 'ok' && listed.body.every((c) => c.readable)).toBe(
      true,
    );
    const query = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    expect(await alice.context(tasks).sparql.construct(query)).toEqual({
      kind: 'ok',
      body: [{ '@id': SUBJECT }],
    });
    const request = seen[1]!;
    expect(request.url.pathname).toBe('/alice/_system/sparql/query');
    expect([...request.url.searchParams]).toEqual([
      ['default-graph-uri', tasks],
      ['named-graph-uri', tasks],
    ]);
    // The query text is sent unchanged: no rewrite, no detector, no widening.
    expect(request.init.body).toBe(query);
    expect(String(request.init.body)).not.toContain(notes);
    await expect(
      alice.context(tasks).sparql.construct('  '),
    ).rejects.toMatchObject({
      reason: { code: 'invalid-argument', argument: 'query' },
    });
    expect(seen).toHaveLength(2);
  });
});

describe('representation evidence', () => {
  const pod = 'https://pod.example/alice';
  const tasks = `${pod}/_system/contexts/tasks`;

  it('returns RDF terms, language tags, datatypes and IRIs exactly as answered', async () => {
    const body = {
      '@id': SUBJECT,
      '@type': ['https://example.org/Task'],
      'https://schema.org/name': [
        { '@value': 'Milch', '@language': 'de-CH' },
        { '@value': 'Milk', '@language': 'EN' },
      ],
      'https://schema.org/dateCreated': [
        {
          '@value': '2026-10-03T12:00:00+02:00',
          '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
        },
      ],
      'https://schema.org/isPartOf': [{ '@id': 'did:web:example.org' }],
    };
    const { fetch } = fakePods(() => ld(body, { etag: '"v7"' }));
    const read = await createPod(pod, { auth: bearer('t'), fetch })
      .context(tasks)
      .subjects.get(SUBJECT);
    expect(read).toEqual({ kind: 'ok', body, etag: '"v7"' });
  });

  it('adopts a creation Location only when it names the created subject (SPS-CRUD-043)', async () => {
    const route = `${pod}/_system/resources/${Buffer.from(SUBJECT, 'utf8').toString('base64url')}`;
    const other = `${pod}/_system/resources/${Buffer.from('urn:other', 'utf8').toString('base64url')}`;
    const cases: [string, string | undefined][] = [
      [route, route],
      ...['?', '#', '?#'].flatMap((suffix): [string, string][] => [
        [`${route}${suffix}`, route],
        [`${route.split('/').at(-1)}${suffix}`, route],
      ]),
      [
        `${route}?context=${encodeURIComponent(tasks)}#`,
        `${route}?context=${encodeURIComponent(tasks)}`,
      ],
      [
        `?context=${encodeURIComponent(tasks)}#`,
        `${route}?context=${encodeURIComponent(tasks)}`,
      ],
      [
        `${route}?context=${encodeURIComponent(tasks)}`,
        `${route}?context=${encodeURIComponent(tasks)}`,
      ],
      [`/alice/_system/resources/${route.split('/').at(-1)}`, route],
      [`${pod}/_system/contexts/tasks`, undefined],
      [`${pod}/_system/grants/abc`, undefined],
      [other, undefined],
      [`${route}?context=urn:elsewhere`, undefined],
      [`${route}#fragment`, undefined],
      [`${route}?#fragment`, undefined],
      [`${route}?context=urn:elsewhere#`, undefined],
      [`${other}?#`, undefined],
      [
        `${route.replace('https://pod.example', 'https://evil.example')}?#`,
        undefined,
      ],
      [route.replace('https://pod.example', 'https://evil.example'), undefined],
    ];
    for (const [header, expected] of cases) {
      const { fetch } = fakePods(
        () =>
          new Response(null, { status: 201, headers: { location: header } }),
      );
      const result = await createPod(pod, { auth: bearer('t'), fetch })
        .context(tasks)
        .subjects.put(SUBJECT, { '@id': SUBJECT }, { ifNoneMatch: '*' });
      expect(result).toEqual(
        expected === undefined
          ? { kind: 'applied', status: 201 }
          : { kind: 'applied', status: 201, location: expected },
      );
    }
  });

  it('reports created, replaced and conflicting writes explicitly', async () => {
    const statuses = [201, 200, 412];
    const { fetch } = fakePods(
      () =>
        new Response(null, {
          status: statuses.shift()!,
          headers: { location: 'https://elsewhere.example/x' },
        }),
    );
    const view = createPod(pod, { auth: bearer('t'), fetch }).context(tasks);
    // A foreign Location is not adopted; writes claim no entity tag (SPS-CRUD-030).
    expect(
      await view.subjects.put(
        SUBJECT,
        { '@id': SUBJECT },
        { ifNoneMatch: '*' },
      ),
    ).toEqual({ kind: 'applied', status: 201 });
    expect(
      await view.subjects.put(SUBJECT, { '@id': SUBJECT }, { overwrite: true }),
    ).toEqual({ kind: 'applied', status: 200 });
    expect(await view.subjects.patch(SUBJECT, {}, { ifMatch: '"v1"' })).toEqual(
      { kind: 'precondition-failed' },
    );
  });
});
