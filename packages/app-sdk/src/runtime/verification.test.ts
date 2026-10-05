/**
 * Runtime verification items that existing tests covered only partially:
 * rotation and spent refresh tokens across reloads (A1), terminal subject
 * failures (A2), a shared refresh failure (A3), disconnect during a code
 * exchange across reload (A4), a failed acceptance after a sent refresh (A5),
 * a superseded attempt (B2/B5), invalid_client cleanup (B3), view identity
 * across rotation (C1), invalidation while a body is read (C2) and a 403 that
 * never renews, resends or navigates (C3).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import type { PodFetch } from '@sempods/client-sdk';
import { openSessionStore } from '../sessions/store.js';
import type { BrowserRuntime } from './types.js';
import { createBrowserRuntime } from './runtime.js';
import {
  fixture,
  settleLease,
  restored,
  deferred,
  jwt,
  catalogue,
  pod,
  personal,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});
async function logged() {
  const f = fixture();
  runtimes.push(f.runtime);
  const result = await f.login();
  runtimes.push(result.runtime);
  return { ...f, ...result };
}
const query = 'CONSTRUCT {} WHERE {}';
const refused = () =>
  new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });
const namespace = JSON.stringify([
  'dynamic',
  'https://app.example/oauth/callback',
]);
/** Answers the first `n` requests with 401, then 200. */
function refusingFirst(n: number): PodFetch {
  let calls = 0;
  return async () => (++calls <= n ? refused() : Response.json([]));
}
/** The refresh_token sent in each token request. */
function sentRefreshTokens(f: Awaited<ReturnType<typeof logged>>) {
  return f.fetch.mock.calls
    .filter(([url]) => url.endsWith('/token'))
    .map(([, init]) =>
      new URLSearchParams(String(init?.body)).get('refresh_token'),
    )
    .filter((t): t is string => t !== null);
}
async function reload(f: Awaited<ReturnType<typeof logged>>) {
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  await next.initialize();
  await restored(next);
  return next;
}

it('A1: sends each rotated refresh token once and never a spent one, also after reload', async () => {
  const f = await logged();
  let issued = 0;
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: `rotated-${++issued}`,
    }),
  );
  f.setQuery(refusingFirst(1));
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  f.setQuery(refusingFirst(1));
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  // The rotation chain: original, then each replacement exactly once.
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'rotated-1']);
  // An invalid replacement ends the session; its spent token is never reused.
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ sub: 'https://other.example/#me' }),
      token_type: 'Bearer',
      refresh_token: 'rotated-x',
    }),
  );
  f.setQuery(refusingFirst(1));
  expect(await f.view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('ended');
  const sent = sentRefreshTokens(f);
  expect(sent).toEqual(['refresh-private', 'rotated-1', 'rotated-2']);
  const next = await reload(f);
  expect(next.getSnapshot().some((c) => c.session.kind === 'active')).toBe(
    false,
  );
  expect(sentRefreshTokens(f)).toEqual(sent);
});

it.each([
  ['missing subject', { sub: undefined }, 'sub'],
  ['malformed subject', { sub: 'not an iri' }, 'sub'],
  ['changed subject', { sub: 'https://other.example/#me' }, 'continuity'],
] as const)(
  'A2: a %s ends the session with its own diagnostic and no retry',
  async (_name, claims, field) => {
    const f = await logged();
    f.setToken(async () =>
      Response.json({
        access_token: jwt(claims),
        token_type: 'Bearer',
        refresh_token: 'rotated',
      }),
    );
    f.setQuery(async () => refused());
    expect(await f.view.sparql.construct(query)).toEqual({
      kind: 'invalidated',
    });
    expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
      kind: 'ended',
      problem: 'claims',
      failure: { code: 'oauth', problem: 'claims', field },
    });
    const tokens = f.count('/token');
    // Terminal: later refusals renew nothing.
    expect(await f.view.sparql.construct(query)).toEqual({
      kind: 'invalidated',
    });
    expect(f.count('/token')).toBe(tokens);
  },
);

it('A3: concurrent refusals share one failed refresh and one outcome', async () => {
  const f = await logged();
  const held = deferred<Response>();
  f.setToken(() => held.promise);
  f.setQuery(async () => refused());
  const before = f.count('/token');
  const first = f.view.sparql.construct(query);
  const second = f.view.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/token')).toBe(before + 1));
  held.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 }));
  const results = await Promise.all([first, second]);
  expect(results[0]).toEqual(results[1]);
  expect(f.count('/token')).toBe(before + 1);
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('ended');
});

it('A4: a disconnect during the code exchange stays disconnected after reload', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { connection, authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const held = deferred<Response>();
  f.setToken(() => held.promise);
  const returned = f.returned(authorization);
  runtimes.push(returned);
  const init = returned.initialize();
  await vi.waitFor(() => expect(f.count('/token')).toBe(1));
  await returned.disconnect(connection.id);
  held.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'late',
    }),
  );
  expect(await init).toMatchObject({ interaction: 'failed' });
  returned.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  await next.initialize();
  expect(next.getSnapshot()).toEqual([]);
  const store = await openSessionStore(namespace, f.factory);
  expect((await store.read(connection.id))?.value).toMatchObject({
    kind: 'disconnected',
  });
  store.close();
  expect(f.count('/token')).toBe(1);
});

it('A5: a failed acceptance after a sent refresh ends visibly and never resurrects', async () => {
  const f = await logged();
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    // The claim is stored; accepting the replacement fails.
    if (value?.value?.kind === 'ready') throw new Error('disk failed');
    return put.call(this, value, key);
  });
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  f.setQuery(async () => refused());
  expect(await f.view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'storage',
  });
  const tokens = f.count('/token');
  vi.restoreAllMocks();
  const next = await reload(f);
  expect(next.getSnapshot().some((c) => c.session.kind === 'active')).toBe(
    false,
  );
  expect(f.count('/token')).toBe(tokens);
});

it('B2/B5: a newer attempt supersedes an older one for the same connection', async () => {
  const f = await logged();
  await f.runtime.beginAuthorization(f.id);
  const older = new URL(f.navigate.mock.calls.at(-1)![0]);
  await f.runtime.beginAuthorization(f.id);
  const newer = new URL(f.navigate.mock.calls.at(-1)![0]);
  expect(older.searchParams.get('state')).not.toBe(
    newer.searchParams.get('state'),
  );
  f.runtime.dispose();
  await settleLease();
  const tokens = f.count('/token');
  // Returning with the older attempt's state is rejected before any exchange.
  const stale = f.returned(older);
  runtimes.push(stale);
  expect(await stale.initialize()).toMatchObject({ interaction: 'failed' });
  expect(f.count('/token')).toBe(tokens);
  stale.dispose();
  await settleLease();
  const current = f.returned(newer);
  runtimes.push(current);
  expect(await current.initialize()).toMatchObject({
    interaction: 'completed',
  });
  expect(f.count('/token')).toBe(tokens + 1);
});

it('B3: invalid_client drops only that Pod registration; the next sign-in registers again', async () => {
  const f = await logged();
  // Cache registrations in this runtime: a second Alice connection and Bob.
  const again = await f.runtime.connect(pod);
  const bob = await f.runtime.connect('https://pod.example/bob');
  const registered = f.count('/register');
  f.setToken(async () =>
    Response.json({ error: 'invalid_client' }, { status: 400 }),
  );
  f.setQuery(async () => refused());
  expect(await f.view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  expect(
    f.runtime.getSnapshot().find((c) => c.id === f.id)?.session,
  ).toMatchObject({ kind: 'ended', problem: 'invalid-client' });
  // Bob's cached registration is kept; Alice's is resolved afresh.
  await f.runtime.beginAuthorization(bob.id);
  expect(f.count('/register')).toBe(registered);
  await f.runtime.beginAuthorization(again.id);
  expect(f.count('/register')).toBe(registered + 1);
});

it('C1: the bound view keeps its identity and key across a credential rotation', async () => {
  const f = await logged();
  const key = f.view.key;
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  f.setQuery(refusingFirst(1));
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(f.runtime.bind(f.id)).toBe(f.view);
  expect(f.view.key).toBe(key);
  expect(f.view.getSnapshot()).toMatchObject({ current: true, read: true });
});

it('C2: losing read access invalidates a read whose body is still arriving', async () => {
  const f = await logged();
  let finish!: () => void;
  f.setResource(async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"@id":"urn:item",'));
        finish = () => {
          controller.enqueue(encoder.encode('"urn:x":[]}'));
          controller.close();
        };
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'application/ld+json', etag: '"v1"' },
    });
  });
  const pending = f.view.subjects.get('urn:item');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  f.setCatalogue(async () => catalogue([personal], []));
  await f.runtime.loadContexts(f.id);
  finish();
  expect(await pending).toEqual({ kind: 'invalidated' });
});

it('C3: a 403 never renews, resends or navigates; each episode revalidates once', async () => {
  const f = await logged();
  let patches = 0;
  f.setResource(async (_url, init) => {
    if (init?.method === 'PATCH') patches++;
    return new Response(null, { status: 403 });
  });
  f.navigate.mockClear(); // the login itself navigated
  const tokens = f.count('/token');
  const catalogues = f.count('/_system/contexts');
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'refused', status: 403 });
  await vi.waitFor(() =>
    expect(f.count('/_system/contexts')).toBe(catalogues + 1),
  );
  expect(patches).toBe(1);
  expect(f.count('/token')).toBe(tokens);
  expect(f.navigate).not.toHaveBeenCalled();
  // A later episode (after the first settled) revalidates exactly once more.
  await new Promise((r) => setTimeout(r, 0));
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'refused', status: 403 });
  await vi.waitFor(() =>
    expect(f.count('/_system/contexts')).toBe(catalogues + 2),
  );
  expect(patches).toBe(2);
  expect(f.count('/token')).toBe(tokens);
});
