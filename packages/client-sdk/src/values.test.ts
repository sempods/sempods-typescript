import { describe, expect, it, vi } from 'vitest';
import {
  bearer,
  createPod,
  type JsonLd,
  type PodFetch,
  type PodRequestInit,
} from './index.js';

const pod = 'https://pod.example/alice';
const ctx = 'https://pod.example/alice/_system/contexts/people';
const bob = 'did:web:bob.example';
const knows = 'http://xmlns.com/foaf/0.1/knows';
const nick = 'http://xmlns.com/foaf/0.1/nick';
const carol = 'https://pod.example/alice/people/carol';
const dave = 'https://pod.example/alice/people/dave';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
const route = (...iris: string[]) =>
  `${pod}/_system/resources/${iris.map(b64).join('/')}`;

type Seen = {
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
};

/**
 * One Context of a Pod's slots, after sempods-spec LOD CRUD §5 and the
 * Kotlin reference server: a slot read in one Context carries a tag, every
 * write echoes the slot's new one, the three idempotent mutations answer
 * `{"outcome": …}`, and a condition is evaluated against the slot.
 */
function slotPod() {
  const slots = new Map<string, JsonLd[]>();
  const versions = new Map<string, number>();
  const seen: Seen[] = [];
  const tag = (key: string) => `"${key.length}-${versions.get(key) ?? 0}"`;
  const outcome = (status: number, value: string, etag: string) =>
    new Response(JSON.stringify({ outcome: value }), {
      status,
      headers: { 'content-type': 'application/json', etag },
    });
  const fetch: PodFetch = async (url: string, init?: PodRequestInit) => {
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : undefined;
    seen.push({ method, url: parsed, headers, body });
    const [s, p, t] = parsed.pathname
      .replace('/alice/_system/resources/', '')
      .split('/')
      .map((part) => Buffer.from(part, 'base64url').toString('utf8'));
    const key = JSON.stringify([s, p]);
    const values = slots.get(key) ?? [];
    const change = (next: JsonLd[]) => {
      slots.set(key, next);
      versions.set(key, (versions.get(key) ?? 0) + 1);
    };
    if (method === 'GET')
      return values.length === 0
        ? new Response(null, { status: 404 })
        : new Response(JSON.stringify(values), {
            status: 200,
            headers: { 'content-type': 'application/ld+json', etag: tag(key) },
          });
    const ifMatch = headers.get('if-match');
    if (
      (ifMatch !== null && ifMatch !== tag(key)) ||
      (headers.get('if-none-match') === '*' && values.length > 0)
    )
      return new Response(null, { status: 412 });
    const same = (a: JsonLd) => (b: JsonLd) =>
      JSON.stringify(a) === JSON.stringify(b);
    if (method === 'PUT') {
      change(JSON.parse(body ?? '[]') as JsonLd[]);
      return new Response(null, { status: 204, headers: { etag: tag(key) } });
    }
    if (method === 'POST') {
      const value = JSON.parse(body ?? '{}') as JsonLd;
      if (values.some(same(value)))
        return outcome(200, 'already_present', tag(key));
      change([...values, value]);
      const created = outcome(201, 'created', tag(key));
      if (typeof value['@id'] === 'string')
        created.headers.set(
          'location',
          `/alice/_system/resources/${b64(s!)}/${b64(p!)}/${b64(value['@id'])}`,
        );
      return created;
    }
    if (t === undefined) {
      if (values.length === 0) return outcome(200, 'already_empty', tag(key));
      change([]);
      return outcome(200, 'cleared', tag(key));
    }
    const edge = values.filter((value) => value['@id'] !== t);
    if (edge.length === values.length)
      return outcome(200, 'already_absent', tag(key));
    change(edge);
    return outcome(200, 'removed', tag(key));
  };
  return { fetch, seen, slots };
}

function viewOf(fetch: PodFetch) {
  return createPod(pod, { auth: bearer('t'), fetch }).context(ctx);
}

function answering(...responses: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  const fetch: PodFetch = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error('unexpected dispatch');
    return next();
  };
  return { fetch, calls };
}

describe('value-level operations on one slot', () => {
  it('adds one value without reading the slot and reports what the Pod did', async () => {
    const { fetch, seen } = slotPod();
    const view = viewOf(fetch);

    const added = await view.values.add(
      bob,
      knows,
      { '@id': carol },
      { overwrite: true },
    );
    expect(added).toEqual({
      kind: 'applied',
      status: 201,
      location: `${route(bob, knows, carol)}`,
      etag: expect.stringMatching(/^".*"$/),
      outcome: 'created',
    });
    expect(seen).toHaveLength(1);
    const [post] = seen;
    expect(post?.method).toBe('POST');
    expect(post?.url.pathname).toBe(
      `/alice/_system/resources/${b64(bob)}/${b64(knows)}`,
    );
    expect(post?.url.searchParams.getAll('context')).toEqual([ctx]);
    expect(post?.headers.get('content-type')).toBe('application/ld+json');
    expect(post?.headers.get('if-match')).toBeNull();
    expect(post?.headers.get('if-none-match')).toBeNull();
    expect(JSON.parse(post?.body ?? '')).toEqual({ '@id': carol });

    // Adding it again changes nothing: applied, already present, no Location.
    expect(
      await view.values.add(bob, knows, { '@id': carol }, { overwrite: true }),
    ).toEqual({
      kind: 'applied',
      status: 200,
      etag: added.kind === 'applied' ? added.etag : '',
      outcome: 'already_present',
    });

    // A literal has no edge, so its creation names none.
    expect(
      await view.values.add(
        bob,
        nick,
        { '@value': 'Bobby', '@language': 'en' },
        { ifNoneMatch: '*' },
      ),
    ).toMatchObject({ kind: 'applied', status: 201, outcome: 'created' });
    expect(seen[2]?.headers.get('if-none-match')).toBe('*');
  });

  it('reads one predicate with its slot tag and chains conditional writes on echoed tags', async () => {
    const { fetch, seen } = slotPod();
    const view = viewOf(fetch);
    expect(await view.values.get(bob, knows)).toEqual({ kind: 'not-found' });
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.headers.get('accept')).toBe('application/ld+json');
    expect(seen[0]?.url.searchParams.getAll('context')).toEqual([ctx]);
    expect(seen[0]?.url.searchParams.has('include_contexts')).toBe(false);

    const replaced = await view.values.replace(
      bob,
      knows,
      [{ '@id': carol }, { '@id': dave }],
      { ifNoneMatch: '*' },
    );
    expect(replaced).toEqual({
      kind: 'applied',
      status: 204,
      etag: expect.any(String),
    });
    expect(seen[1]?.method).toBe('PUT');
    expect(JSON.parse(seen[1]?.body ?? '')).toEqual([
      { '@id': carol },
      { '@id': dave },
    ]);

    const read = await view.values.get(bob, knows);
    expect(read).toEqual({
      kind: 'ok',
      body: [{ '@id': carol }, { '@id': dave }],
      etag: replaced.kind === 'applied' ? replaced.etag : '',
    });
    expect(Object.isFrozen(read.kind === 'ok' && read.body)).toBe(true);

    // The echoed tag is the next version: no read in between.
    const removed = await view.values.remove(bob, knows, dave, {
      ifMatch: replaced.kind === 'applied' ? replaced.etag! : '',
    });
    expect(removed).toMatchObject({ kind: 'applied', outcome: 'removed' });
    expect(seen.at(-1)?.method).toBe('DELETE');
    expect(seen.at(-1)?.url.pathname).toBe(
      `/alice/_system/resources/${b64(bob)}/${b64(knows)}/${b64(dave)}`,
    );
    expect(await view.values.get(bob, knows)).toMatchObject({
      body: [{ '@id': carol }],
    });
    expect(
      await view.values.remove(bob, knows, dave, {
        ifMatch: removed.kind === 'applied' ? removed.etag! : '',
      }),
    ).toMatchObject({
      kind: 'applied',
      status: 200,
      outcome: 'already_absent',
    });

    expect(await view.values.clear(bob, knows, { overwrite: true })).toEqual({
      kind: 'applied',
      status: 200,
      etag: expect.any(String),
      outcome: 'cleared',
    });
    expect(seen.at(-1)?.url.pathname).toBe(
      `/alice/_system/resources/${b64(bob)}/${b64(knows)}`,
    );
    expect(await view.values.clear(bob, knows, { overwrite: true })).toEqual(
      expect.objectContaining({ outcome: 'already_empty' }),
    );
    expect(
      seen.every((req) => req.url.searchParams.getAll('context').length === 1),
    ).toBe(true);
  });

  it('reports a changed slot as precondition-failed, also for the other values of the predicate', async () => {
    const { fetch } = slotPod();
    const view = viewOf(fetch);
    await view.values.add(bob, knows, { '@id': carol }, { overwrite: true });
    const read = await view.values.get(bob, knows);
    if (read.kind !== 'ok') throw new Error('no slot');
    // Someone else adds a value after our read.
    await view.values.add(bob, knows, { '@id': dave }, { overwrite: true });
    const stale = { ifMatch: read.etag };
    expect(await view.values.add(bob, knows, { '@id': dave }, stale)).toEqual({
      kind: 'precondition-failed',
    });
    expect(await view.values.remove(bob, knows, carol, stale)).toEqual({
      kind: 'precondition-failed',
    });
    expect(await view.values.replace(bob, knows, [], stale)).toEqual({
      kind: 'precondition-failed',
    });
    expect(await view.values.clear(bob, knows, stale)).toEqual({
      kind: 'precondition-failed',
    });
    // `*` asks whether the predicate has a value here, not whether bob exists.
    expect(
      await view.values.add(bob, knows, { '@id': dave }, { ifNoneMatch: '*' }),
    ).toEqual({ kind: 'precondition-failed' });
  });

  it('removes one literal by reading, filtering and replacing at the read version', async () => {
    const { fetch, slots } = slotPod();
    const view = viewOf(fetch);
    await view.values.replace(
      bob,
      nick,
      [{ '@value': 'Bobby' }, { '@value': 'Bob', '@language': 'en' }],
      { overwrite: true },
    );
    const read = await view.values.get(bob, nick);
    if (read.kind !== 'ok') throw new Error('no slot');
    const rest = read.body.filter((value) => value['@value'] !== 'Bobby');
    expect(
      await view.values.replace(bob, nick, rest, { ifMatch: read.etag }),
    ).toMatchObject({ kind: 'applied' });
    expect(slots.get(JSON.stringify([bob, nick]))).toEqual([
      { '@value': 'Bob', '@language': 'en' },
    ]);
  });

  it('maps not-found, refused, cancelled and stopped like whole-resource operations', async () => {
    for (const status of [401, 403] as const) {
      const read = answering(() => new Response(null, { status }));
      expect(await viewOf(read.fetch).values.get(bob, knows)).toEqual({
        kind: 'refused',
        status,
      });
      const write = answering(() => new Response(null, { status }));
      expect(
        await viewOf(write.fetch).values.remove(bob, knows, carol, {
          overwrite: true,
        }),
      ).toEqual({ kind: 'refused', status });
    }
    // A Context the caller cannot write may answer 404 (SPS-CORE-018).
    const missing = answering(() => new Response(null, { status: 404 }));
    expect(
      await viewOf(missing.fetch).values.add(
        bob,
        knows,
        { '@id': carol },
        { overwrite: true },
      ),
    ).toEqual({ kind: 'not-found' });

    const controller = new AbortController();
    controller.abort();
    const none = answering();
    const signal = { signal: controller.signal };
    expect(await viewOf(none.fetch).values.get(bob, knows, signal)).toEqual({
      kind: 'cancelled',
    });
    expect(
      await viewOf(none.fetch).values.clear(
        bob,
        knows,
        { overwrite: true },
        signal,
      ),
    ).toEqual({ kind: 'not-sent', reason: 'cancelled' });
    const stopped = createPod(pod, {
      auth: bearer('t'),
      fetch: none.fetch,
      beforeDispatch: () => false,
    }).context(ctx);
    expect(await stopped.values.get(bob, knows)).toEqual({ kind: 'stopped' });
    expect(
      await stopped.values.replace(bob, knows, [], { overwrite: true }),
    ).toEqual({ kind: 'not-sent', reason: 'stopped' });
    expect(none.calls).toHaveLength(0);
  });

  it('reports a value write without a trustworthy answer as uncertain and never resends it', async () => {
    const lost = answering(() => {
      throw new TypeError('fetch failed');
    });
    expect(
      await viewOf(lost.fetch).values.add(
        bob,
        knows,
        { '@id': carol },
        { overwrite: true },
      ),
    ).toEqual({
      kind: 'uncertain',
      failure: { code: 'transport', problem: 'network' },
    });
    expect(lost.calls).toHaveLength(1);

    for (const status of [202, 500, 503]) {
      const unknown = answering(() => new Response(null, { status }));
      expect(
        await viewOf(unknown.fetch).values.remove(bob, knows, carol, {
          overwrite: true,
        }),
      ).toEqual({ kind: 'uncertain', failure: { code: 'http', status } });
    }
    // A 201 is a creation only for `add`.
    const created = answering(() => new Response(null, { status: 201 }));
    expect(
      await viewOf(created.fetch).values.clear(bob, knows, { overwrite: true }),
    ).toEqual({ kind: 'uncertain', failure: { code: 'http', status: 201 } });

    const redirected = answering(() => {
      const response = new Response(JSON.stringify({ outcome: 'removed' }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"x"' },
      });
      Object.defineProperty(response, 'url', {
        value: 'https://evil.example/x',
      });
      return response;
    });
    expect(
      await viewOf(redirected.fetch).values.remove(bob, knows, carol, {
        overwrite: true,
      }),
    ).toEqual({
      kind: 'uncertain',
      failure: { code: 'response', problem: 'redirected' },
    });

    const refused = answering(() => new Response(null, { status: 400 }));
    await expect(
      viewOf(refused.fetch).values.add(bob, knows, {}, { overwrite: true }),
    ).rejects.toMatchObject({ reason: { code: 'http', status: 400 } });
  });

  it('keeps an applied write applied when its outcome, tag or Location do not fit', async () => {
    const answer =
      (status: number, body: string | null, headers: Record<string, string>) =>
      () =>
        new Response(body, { status, headers });
    const json = { 'content-type': 'application/json' };
    const { fetch } = answering(
      // A creation's outcome on a 200, and a weak tag.
      answer(200, '{"outcome":"created"}', { ...json, etag: 'W/"1"' }),
      // An outcome of another operation, and a Location for another value.
      answer(201, '{"outcome":"removed"}', {
        ...json,
        location: route(bob, knows, dave),
      }),
      // Not JSON.
      answer(200, 'cleared', { 'content-type': 'text/plain' }),
      // Unreadable JSON.
      answer(200, '{"outcome":', json),
      // No body (sempods-spec#68 proposes a bare 204).
      answer(204, null, { etag: '"2"' }),
    );
    const view = viewOf(fetch);
    const any = { overwrite: true } as const;
    expect(await view.values.add(bob, knows, { '@id': carol }, any)).toEqual({
      kind: 'applied',
      status: 200,
    });
    expect(await view.values.add(bob, knows, { '@id': carol }, any)).toEqual({
      kind: 'applied',
      status: 201,
    });
    expect(await view.values.clear(bob, knows, any)).toEqual({
      kind: 'applied',
      status: 200,
    });
    expect(await view.values.remove(bob, knows, carol, any)).toEqual({
      kind: 'applied',
      status: 200,
    });
    expect(await view.values.remove(bob, knows, carol, any)).toEqual({
      kind: 'applied',
      status: 204,
      etag: '"2"',
    });
  });

  it('waits for an outcome body only so long, and keeps a write applied when it stalls or is cancelled', async () => {
    const stalled = () =>
      new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { 'content-type': 'application/json', etag: '"7"' },
      });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { fetch } = answering(stalled);
      const pending = viewOf(fetch).values.remove(bob, knows, carol, {
        overwrite: true,
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toEqual({
        kind: 'applied',
        status: 200,
        etag: '"7"',
      });
    } finally {
      vi.useRealTimers();
    }
    // As fetch does, the caller's signal errors a body still arriving.
    const controller = new AbortController();
    const cancelling: PodFetch = async (_url, init) => {
      setTimeout(() => controller.abort(), 0);
      return new Response(
        new ReadableStream({
          start(stream) {
            init?.signal?.addEventListener('abort', () =>
              stream.error(new DOMException('aborted', 'AbortError')),
            );
          },
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json', etag: '"7"' },
        },
      );
    };
    expect(
      await viewOf(cancelling).values.clear(
        bob,
        knows,
        { overwrite: true },
        { signal: controller.signal },
      ),
    ).toEqual({ kind: 'applied', status: 200, etag: '"7"' });
  });

  it("keeps an added value's Location only when it names that value's edge in this Pod", async () => {
    const edge = route(bob, knows, carol);
    const created =
      (location: string, status = 201) =>
      () =>
        new Response(null, { status, headers: { location } });
    const { fetch } = answering(
      created(`${edge}?context=${encodeURIComponent(ctx)}`),
      created(edge.replace('https://pod.example', 'https://other.example')),
      created(edge.replace('/alice/', '/bob/')),
      created(`${edge}?context=other`),
      created(edge, 200),
      created(route(bob, nick, 'urn:x')),
    );
    const view = viewOf(fetch);
    const any = { overwrite: true } as const;
    const add = () => view.values.add(bob, knows, { '@id': carol }, any);
    expect(await add()).toEqual({
      kind: 'applied',
      status: 201,
      location: `${edge}?context=${encodeURIComponent(ctx)}`,
    });
    for (let i = 0; i < 3; i++)
      expect(await add()).toEqual({ kind: 'applied', status: 201 });
    expect(await add()).toEqual({ kind: 'applied', status: 200 });
    // A literal has no edge, so no Location is adopted for it.
    expect(await view.values.add(bob, nick, { '@value': 'x' }, any)).toEqual({
      kind: 'applied',
      status: 201,
    });
  });

  it('sends If-None-Match: * on remove to ask whether the slot is empty', async () => {
    const { fetch, seen } = slotPod();
    const view = viewOf(fetch);
    expect(
      await view.values.remove(bob, knows, carol, { ifNoneMatch: '*' }),
    ).toMatchObject({ kind: 'applied', outcome: 'already_absent' });
    expect(seen[0]?.headers.get('if-none-match')).toBe('*');
    await view.values.add(bob, knows, { '@id': dave }, { overwrite: true });
    expect(
      await view.values.remove(bob, knows, carol, { ifNoneMatch: '*' }),
    ).toEqual({ kind: 'precondition-failed' });
  });

  it('reads an empty array without a tag as no value', async () => {
    const { fetch } = answering(
      () =>
        new Response('[]', {
          status: 200,
          headers: { 'content-type': 'application/ld+json' },
        }),
    );
    expect(await viewOf(fetch).values.get(bob, knows)).toEqual({
      kind: 'not-found',
    });
  });

  it('rejects an untrusted slot read', async () => {
    const reads = answering(
      () =>
        new Response('[{"@id":"urn:x"}]', {
          status: 200,
          headers: { 'content-type': 'application/ld+json' },
        }),
      () =>
        new Response('{"@id":"x"}', {
          status: 200,
          headers: { 'content-type': 'application/ld+json', etag: '"1"' },
        }),
      () =>
        new Response('[1]', {
          status: 200,
          headers: { 'content-type': 'application/ld+json', etag: '"1"' },
        }),
    );
    const view = viewOf(reads.fetch);
    await expect(view.values.get(bob, knows)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'etag' },
    });
    for (let i = 0; i < 2; i++)
      await expect(view.values.get(bob, knows)).rejects.toMatchObject({
        reason: { code: 'response', problem: 'body' },
      });
  });

  it('refuses a relative predicate or target before sending anything', async () => {
    const { fetch, calls } = answering();
    const view = viewOf(fetch);
    const invalid = { reason: { code: 'invalid-argument', argument: 'iri' } };
    await expect(view.values.get(bob, 'name')).rejects.toMatchObject(invalid);
    await expect(
      view.values.remove(bob, knows, '_:b0', { overwrite: true }),
    ).rejects.toMatchObject(invalid);
    await expect(
      view.values.add(bob, 'name', { '@id': carol }, { overwrite: true }),
    ).rejects.toMatchObject(invalid);
    expect(calls).toHaveLength(0);
  });

  it('rejects, never throws, an invalid IRI on whole-resource writes', async () => {
    const { fetch, calls } = answering();
    const view = viewOf(fetch);
    const any = { overwrite: true } as const;
    const invalid = { reason: { code: 'invalid-argument', argument: 'iri' } };
    await expect(view.subjects.put('relative', {}, any)).rejects.toMatchObject(
      invalid,
    );
    await expect(
      view.subjects.patch('relative', {}, any),
    ).rejects.toMatchObject(invalid);
    await expect(view.subjects.delete('relative', any)).rejects.toMatchObject(
      invalid,
    );
    expect(calls).toHaveLength(0);
  });

  it('keeps whole-resource writes without an entity tag (SPS-CRUD-030)', async () => {
    const { fetch } = answering(
      () => new Response(null, { status: 204, headers: { etag: '"v2"' } }),
    );
    expect(
      await viewOf(fetch).subjects.patch(bob, {}, { overwrite: true }),
    ).toEqual({ kind: 'applied', status: 204 });
  });
});
