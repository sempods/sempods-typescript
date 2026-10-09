import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { RuntimeError } from './errors.js';
import type { BrowserRuntime } from './types.js';
import {
  catalogue,
  deferred,
  fixture,
  jwt,
  personal,
  pod,
  settleLease,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});
const third = pod + '/_system/contexts/third';
const item = () =>
  Response.json({ '@id': 'urn:item' }, { headers: { etag: '"v1"' } });
async function signedIn(f = fixture()) {
  const session = await f.login();
  runtimes.push(f.runtime, session.runtime);
  return { ...f, ...session };
}
/**
 * Holds resource reads of the given Contexts until released, ignoring the
 * request's abort signal like a transport that cannot cancel.
 */
function holdReads(
  f: { setResource(fn: PodFetch): void },
  held: readonly string[],
) {
  const gates = new Map<string, ReturnType<typeof deferred<Response>>>();
  f.setResource(async (url) => {
    const context = new URL(url).searchParams.get('context')!;
    if (!held.includes(context)) return item();
    const gate = deferred<Response>();
    gates.set(context, gate);
    return gate.promise;
  });
  return {
    started: (context: string) => gates.has(context),
    release: (context: string) => gates.get(context)!.resolve(item()),
  };
}
function resourceRequests(f: ReturnType<typeof fixture>) {
  return f.fetch.mock.calls.filter(([url]) =>
    url.includes('/_system/resources/'),
  );
}

it('returns its own stable handle, also for the selected Context, and leaves the selection alone', async () => {
  const f = await signedIn();
  const selected = f.runtime.bind(f.id);
  const explicit = f.runtime.bindContext(f.id, work);
  expect(selected.contextIri).toBe(work);
  expect(explicit).not.toBe(selected);
  expect(explicit.key).not.toBe(selected.key);
  expect(explicit.contextIri).toBe(work);
  expect(f.runtime.bindContext(f.id, work)).toBe(explicit);
  const other = f.runtime.bindContext(f.id, personal);
  expect(other.contextIri).toBe(personal);
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
  expect(other.getSnapshot()).toMatchObject({
    current: true,
    read: true,
    write: false,
  });
});

it('survives selection changes with its pending reads, while the selected view is replaced', async () => {
  const f = await signedIn();
  const explicit = f.runtime.bindContext(f.id, personal);
  const selected = f.runtime.bind(f.id);
  const reads = holdReads(f, [personal]);
  const pending = explicit.subjects.get('urn:item');
  await vi.waitFor(() => expect(reads.started(personal)).toBe(true));
  f.runtime.selectContext(f.id, personal);
  f.runtime.selectContext(f.id, work);
  expect(selected.getSnapshot().current).toBe(false);
  expect(explicit.getSnapshot().current).toBe(true);
  reads.release(personal);
  expect(await pending).toMatchObject({ kind: 'ok' });
  expect(f.runtime.bindContext(f.id, personal)).toBe(explicit);
});

it('dispatches nothing without confirmed catalogue evidence, then follows the first listing', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { connection, authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned(authorization);
  runtimes.push(runtime);
  await runtime.initialize();
  const explicit = runtime.bindContext(connection.id, personal);
  expect(explicit.getSnapshot()).toMatchObject({ current: true, read: false });
  expect(await explicit.subjects.get('urn:item')).toEqual({
    kind: 'invalidated',
  });
  expect(resourceRequests(f)).toHaveLength(0);
  await runtime.loadContexts(connection.id);
  expect(explicit.getSnapshot().read).toBe(true);
  expect(await explicit.subjects.get('urn:item')).toMatchObject({
    kind: 'ok',
  });
  expect(resourceRequests(f)).toHaveLength(1);
});

it('denies an unlisted Context and keeps retained evidence through a failed refresh', async () => {
  const f = await signedIn();
  f.setCatalogue(async () => catalogue([work], [work]));
  await f.runtime.loadContexts(f.id);
  const unlisted = f.runtime.bindContext(f.id, personal);
  expect(unlisted.getSnapshot().read).toBe(false);
  expect(await unlisted.subjects.get('urn:item')).toEqual({
    kind: 'invalidated',
  });
  const listed = f.runtime.bindContext(f.id, work);
  f.setCatalogue(async () => {
    throw new TypeError('offline');
  });
  await f.runtime.loadContexts(f.id).catch(() => {});
  expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe('failed');
  expect(listed.getSnapshot()).toMatchObject({ read: true, write: true });
  expect(await listed.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
});

it('invalidates only the pending reads of the Context whose permission changed', async () => {
  const f = await signedIn();
  f.setCatalogue(async () => catalogue([work, personal, third], [work]));
  await f.runtime.loadContexts(f.id);
  const b = f.runtime.bindContext(f.id, personal);
  const c = f.runtime.bindContext(f.id, third);
  const selected = f.runtime.bind(f.id);
  const reads = holdReads(f, [personal, third, work]);
  const fromB = b.subjects.get('urn:item');
  const fromC = c.subjects.get('urn:item');
  const fromSelected = selected.subjects.get('urn:item');
  await vi.waitFor(() =>
    expect([personal, third, work].every(reads.started)).toBe(true),
  );
  // B loses read access; C and the selected Context keep theirs.
  f.setCatalogue(async () => catalogue([work, third], [work]));
  await f.runtime.loadContexts(f.id);
  for (const context of [personal, third, work]) reads.release(context);
  expect(await fromB).toEqual({ kind: 'invalidated' });
  expect(await fromC).toMatchObject({ kind: 'ok' });
  expect(await fromSelected).toMatchObject({ kind: 'ok' });
  expect(b.getSnapshot().read).toBe(false);
});

it('invalidates a read whose transport ignores abort when access is lost and regained', async () => {
  const f = await signedIn();
  const explicit = f.runtime.bindContext(f.id, personal);
  const reads = holdReads(f, [personal]);
  const pending = explicit.subjects.get('urn:item');
  await vi.waitFor(() => expect(reads.started(personal)).toBe(true));
  f.setCatalogue(async () => catalogue([work], [work]));
  await f.runtime.loadContexts(f.id);
  f.setCatalogue(async () => catalogue());
  await f.runtime.loadContexts(f.id);
  expect(explicit.getSnapshot().read).toBe(true);
  reads.release(personal);
  expect(await pending).toEqual({ kind: 'invalidated' });
});

it('revalidates the shared catalogue once on a 403 instead of starting a login', async () => {
  const f = await signedIn();
  const explicit = f.runtime.bindContext(f.id, personal);
  const before = f.count('/_system/contexts');
  f.setResource(async () => new Response(null, { status: 403 }));
  f.setCatalogue(async () => catalogue([work], [work]));
  expect(await explicit.subjects.get('urn:item')).toMatchObject({
    kind: 'refused',
    status: 403,
  });
  expect(f.count('/_system/contexts')).toBe(before + 1);
  expect(explicit.getSnapshot().read).toBe(false);
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active');
});

it('refuses another Context than an exact preset on its Pod only', async () => {
  const f = await signedIn(
    fixture({ preset: { podUrl: pod, contextIri: work } }),
  );
  expect(() => f.runtime.bindContext(f.id, personal)).toThrow(
    new RuntimeError('configuration'),
  );
  expect(f.runtime.bindContext(f.id, work).contextIri).toBe(work);
  const elsewhere = 'https://pod.example/bob';
  const g = await signedIn(
    fixture({
      preset: {
        podUrl: elsewhere,
        contextIri: elsewhere + '/_system/contexts/work',
      },
    }),
  );
  expect(g.runtime.bindContext(g.id, personal).contextIri).toBe(personal);
});

it.each([
  ['a foreign Pod', 'https://pod.example/bob/_system/contexts/work'],
  ['a non-Context path', pod + '/notes'],
  ['a dot segment', pod + '/_system/contexts/../work'],
])('refuses %s without a request', async (_case, iri) => {
  const f = await signedIn();
  const before = f.fetch.mock.calls.length;
  expect(() => f.runtime.bindContext(f.id, iri)).toThrow(
    new RuntimeError('configuration'),
  );
  expect(f.fetch.mock.calls).toHaveLength(before);
});

it('needs a signed-in connection', async () => {
  const f = await signedIn();
  expect(() => f.runtime.bindContext('unknown', work)).toThrow(
    new RuntimeError('disconnected'),
  );
});

it.each([
  'disconnect',
  'dispose',
  'authorize',
  'expired',
  'subject-change',
] as const)(
  'invalidates pending reads and retires its handles on %s',
  async (mode) => {
    const f = await signedIn();
    const explicit = f.runtime.bindContext(f.id, personal);
    const reads = holdReads(f, [personal]);
    const pending = explicit.subjects.get('urn:item').catch((error) => error);
    await vi.waitFor(() => expect(reads.started(personal)).toBe(true));
    if (mode === 'disconnect') await f.runtime.disconnect(f.id);
    else if (mode === 'dispose') f.runtime.dispose();
    else if (mode === 'authorize') await f.runtime.beginAuthorization(f.id);
    else {
      // A refused request makes the runtime renew; the answer ends the session.
      f.setQuery(
        async () =>
          new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          }),
      );
      f.setToken(async () =>
        mode === 'expired'
          ? new Response(null, { status: 400 })
          : Response.json({
              access_token: jwt({ sub: 'urn:another-person' }),
              token_type: 'Bearer',
              refresh_token: 'changed',
            }),
      );
      await f.runtime
        .bindPod(f.id)
        .sparql.construct('CONSTRUCT {} WHERE {}')
        .catch(() => {});
      // Refresh continuity: another subject is never adopted.
      if (mode === 'subject-change')
        expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
          kind: 'ended',
          problem: 'claims',
        });
    }
    reads.release(personal);
    expect(await pending).not.toMatchObject({ kind: 'ok' });
    expect(explicit.getSnapshot()).toMatchObject({
      current: false,
      read: false,
    });
    expect(() => f.runtime.bindContext(f.id, personal)).toThrow(RuntimeError);
  },
);

it('does not revive an old handle after reauthorization in the same connection', async () => {
  const f = await signedIn();
  const old = f.runtime.bindContext(f.id, personal);
  await f.runtime.beginAuthorization(f.id);
  f.runtime.dispose();
  await settleLease();
  const next = f.returned();
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
  await next.loadContexts(f.id);
  const view = next.bindContext(f.id, personal);
  expect(view).not.toBe(old);
  expect(view.key).not.toBe(old.key);
  expect(old.getSnapshot().current).toBe(false);
  expect(await view.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
  expect(await old.subjects.get('urn:item')).not.toMatchObject({ kind: 'ok' });
});

it('invalidates its pending reads and access revision when grants change', async () => {
  const f = fixture({ scopes: { optional: ['ai'] } });
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'ai' }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  const s = await signedIn(f);
  const explicit = s.runtime.bindContext(s.id, personal);
  const revision = explicit.getSnapshot().revision;
  const reads = holdReads(f, [personal]);
  const pending = explicit.subjects.get('urn:item');
  await vi.waitFor(() => expect(reads.started(personal)).toBe(true));
  // A renewal triggered by another request drops the optional grant.
  let calls = 0;
  f.setQuery(async () =>
    ++calls === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : Response.json([]),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  await s.runtime.bindPod(s.id).sparql.construct('CONSTRUCT {} WHERE {}');
  reads.release(personal);
  expect(await pending).toEqual({ kind: 'invalidated' });
  expect(explicit.getSnapshot().revision).toBeGreaterThan(revision);
  expect(s.runtime.bindContext(s.id, personal)).toBe(explicit);
});
