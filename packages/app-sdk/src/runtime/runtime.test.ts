import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { openSessionStore } from '../sessions/store.js';
import type { SessionStore } from '../sessions/types.js';
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
  callback,
  work,
  personal,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});
async function logged(overrides: Parameters<typeof fixture>[0] = {}) {
  const f = fixture(overrides);
  runtimes.push(f.runtime);
  const result = await f.login();
  runtimes.push(result.runtime);
  return { ...f, ...result };
}
const query = 'CONSTRUCT {} WHERE {}';
it('shares initialization, accepts once, and never re-exchanges a duplicate callback', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const r = f.returned(authorization);
  runtimes.push(r);
  const startup = r.initialize();
  expect(r.initialize()).toBe(startup);
  expect(await startup).toMatchObject({
    interaction: 'completed',
    storage: 'durable',
  });
  expect(f.count('/token')).toBe(1);
  expect(r.getSnapshot()[0]?.session.kind).toBe('active');
  expect(JSON.stringify(r.getSnapshot())).not.toContain('refresh-private');
  expect(JSON.stringify(r.getSnapshot())).not.toContain('accessToken');
  r.dispose();
  await settleLease();
  const duplicate = f.returned(authorization);
  runtimes.push(duplicate);
  expect(await duplicate.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(f.count('/token')).toBe(1);
  await vi.waitFor(() =>
    expect(duplicate.getSnapshot()[0]?.session.kind).toBe('active'),
  );
});
it('resumes after reload without stale context grants or selection', async () => {
  const f = await logged();
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({
    interaction: 'none',
    storage: 'durable',
  });
  await restored(next);
  expect(next.getSnapshot()[0]).toMatchObject({
    session: { kind: 'active' },
    selectedContext: null,
    catalogue: { kind: 'unknown' },
  });
  await next.loadContexts(f.id);
  next.selectContext(f.id, work);
  expect(await next.bind(f.id).subjects.get('urn:item')).toMatchObject({
    kind: 'ok',
    etag: '"v1"',
  });
});
it('persists did:web and non-empty requested/granted scopes', async () => {
  const f = fixture({
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: callback,
    },
    scopes: { required: ['tasks'], optional: ['ai'] },
  });
  runtimes.push(f.runtime);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ client_id: 'did:web:app.example', scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'one',
    }),
  );
  const { authorization } = await f.begin();
  expect(authorization.searchParams.get('scope')).toBe('tasks ai');
  expect(f.count('/register')).toBe(0);
  f.runtime.dispose();
  await settleLease();
  const r = f.returned(authorization);
  runtimes.push(r);
  expect(await r.initialize()).toMatchObject({ interaction: 'completed' });
  await restored(r);
  expect(r.getSnapshot()[0]).toMatchObject({
    clientKind: 'did-web',
    requestedScopes: ['tasks', 'ai'],
    grantedScopes: ['tasks'],
    missingRequiredScopes: [],
  });
  r.dispose();
  await settleLease();
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  await next.initialize();
  await restored(next);
  expect(next.getSnapshot()[0]).toMatchObject({
    clientKind: 'did-web',
    requestedScopes: ['tasks', 'ai'],
    grantedScopes: ['tasks'],
  });
});
it('keeps two pods across the second authorization redirect', async () => {
  const f = await logged();
  const secondPod = 'https://pod.example/bob';
  const second = await f.runtime.connect(secondPod);
  await f.runtime.beginAuthorization(second.id);
  const auth = new URL(f.navigate.mock.calls.at(-1)![0]);
  f.runtime.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ iss: secondPod }),
      token_type: 'Bearer',
      refresh_token: 'bob',
    }),
  );
  const next = f.returned(auth);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
  expect(
    next.getSnapshot().filter((c) => c.session.kind === 'active'),
  ).toHaveLength(2);
});
it('reports busy storage and releases the lease on dispose', async () => {
  const f = await logged();
  const another = createBrowserRuntime(f.options);
  runtimes.push(another);
  expect(await another.initialize()).toMatchObject({
    storage: 'busy',
    problem: 'busy',
  });
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({ storage: 'durable' });
});
it('reports storage failure without memory fallback', async () => {
  const f = fixture({
    openStore: async () => {
      throw new Error('unavailable');
    },
  });
  runtimes.push(f.runtime);
  expect(await f.runtime.initialize()).toMatchObject({
    storage: 'unavailable',
    problem: 'storage',
  });
  await expect(f.runtime.connect(pod)).rejects.toMatchObject({
    problem: 'configuration',
  });
});
it('does not navigate when durable preparation fails', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  await f.runtime.initialize();
  const c = await f.runtime.connect(pod);
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
    throw new Error('write failed');
  });
  await expect(f.runtime.beginAuthorization(c.id)).rejects.toBeDefined();
  expect(f.navigate).not.toHaveBeenCalled();
});
it('does not publish a token when accepting the result fails', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const original = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value,
    key,
  ) {
    if (value?.value?.kind === 'ready') throw new Error('disk failed');
    return original.call(this, value, key);
  });
  const next = f.returned(authorization);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({ interaction: 'failed' });
  expect(next.getSnapshot().some((c) => c.session.kind === 'active')).toBe(
    false,
  );
});
it.each(['disconnect', 'dispose'] as const)(
  'rejects a late code response after %s',
  async (action) => {
    const f = fixture();
    runtimes.push(f.runtime);
    const { connection, authorization } = await f.begin();
    f.runtime.dispose();
    await settleLease();
    const held = deferred<Response>();
    f.setToken(() => held.promise);
    const next = f.returned(authorization);
    runtimes.push(next);
    const init = next.initialize();
    await vi.waitFor(() => expect(f.count('/token')).toBe(1));
    if (action === 'disconnect') await next.disconnect(connection.id);
    else next.dispose();
    held.resolve(
      Response.json({
        access_token: jwt(),
        token_type: 'Bearer',
        refresh_token: 'late',
      }),
    );
    expect(await init).toMatchObject({ interaction: 'failed' });
    expect(next.getSnapshot().some((c) => c.session.kind === 'active')).toBe(
      false,
    );
  },
);
it('shares refresh while a cancelled caller stops waiting', async () => {
  const f = await logged();
  const token = deferred<Response>();
  let reads = 0;
  f.setQuery(async () =>
    ++reads <= 2
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : Response.json([]),
  );
  f.setToken(() => token.promise);
  const caller = new AbortController();
  const first = f.view.sparql.construct(query, { signal: caller.signal });
  const second = f.view.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/token')).toBe(2));
  caller.abort();
  expect(await first).toEqual({ kind: 'cancelled' });
  token.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  expect(await second).toEqual({ kind: 'ok', body: [] });
  expect(f.count('/token')).toBe(2);
});
it('reuses a replacement for a delayed old-credential 401', async () => {
  const f = await logged();
  const delayed = deferred<Response>();
  let reads = 0;
  f.setQuery(() =>
    ++reads === 1
      ? delayed.promise
      : Promise.resolve(
          reads === 2
            ? new Response(null, {
                status: 401,
                headers: { 'www-authenticate': 'Bearer' },
              })
            : Response.json([]),
        ),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  const first = f.view.sparql.construct(query);
  await vi.waitFor(() => expect(reads).toBe(1));
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'ok',
    body: [],
  });
  delayed.resolve(
    new Response(null, {
      status: 401,
      headers: { 'www-authenticate': 'Bearer' },
    }),
  );
  expect(await first).toEqual({ kind: 'ok', body: [] });
  expect(f.count('/token')).toBe(2);
});
it.each([
  { sub: 'https://other.example/me' },
  { client_id: 'dyn:other' },
  { iss: 'https://other.example' },
  { scope: 'ai' },
])('rejects refresh continuity mismatch %j', async (claims) => {
  const f = await logged();
  f.setQuery(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt(claims),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  expect(await f.view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'claims',
  });
});
it('keeps a confirmed write refusal when refresh fails', async () => {
  const f = await logged();
  f.setResource(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  f.setToken(async () => {
    throw new Error('lost exchange');
  });
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'refused', status: 401 });
  expect(
    f.fetch.mock.calls.filter(([url]) => url.includes('/resources/')),
  ).toHaveLength(1);
});
it('invalidates a read promptly on target switch and never revives A→B→A views', async () => {
  const f = await logged();
  const held = deferred<Response>();
  f.setQuery(() => held.promise);
  const pending = f.view.sparql.construct(query);
  f.runtime.selectContext(f.id, personal);
  expect(await pending).toEqual({ kind: 'invalidated' });
  f.runtime.selectContext(f.id, work);
  expect(f.runtime.bind(f.id).key).not.toBe(f.view.key);
  expect(await f.view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  held.resolve(Response.json([]));
});
it('coalesces 403 catalogue reloads while retaining the original refusal', async () => {
  const f = await logged();
  const held = deferred<Response>();
  const before = f.count('/_system/contexts');
  f.setQuery(async () => new Response(null, { status: 403 }));
  f.setCatalogue(() => held.promise);
  const first = f.view.sparql.construct(query);
  const second = f.view.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/_system/contexts')).toBe(before + 1));
  held.resolve(catalogue([], []));
  expect(await first).toEqual({ kind: 'refused', status: 403 });
  expect(await second).toEqual({ kind: 'refused', status: 403 });
  expect(f.count('/_system/contexts')).toBe(before + 1);
});
it('keeps reads and view identity when only write access is lost', async () => {
  const f = await logged();
  f.setCatalogue(async () => catalogue([work, personal], []));
  await f.runtime.loadContexts(f.id);
  expect(f.runtime.bind(f.id)).toBe(f.view);
  expect(await f.view.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'not-sent', reason: 'stopped' });
});
it('does not turn a failed catalogue reload into verified permission loss', async () => {
  const f = await logged();
  f.setCatalogue(async () => {
    throw new Error('offline');
  });
  await expect(f.runtime.loadContexts(f.id)).rejects.toBeDefined();
  expect(f.runtime.getSnapshot()[0]?.catalogue).toMatchObject({
    kind: 'failed',
    contexts: expect.any(Array),
  });
  expect(await f.view.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
});
it('retains an applied write result after a target switch', async () => {
  const f = await logged();
  const held = deferred<Response>();
  f.setResource(() => held.promise);
  const pending = f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' });
  await vi.waitFor(() =>
    expect(
      f.fetch.mock.calls.some(([url]) => url.includes('/resources/')),
    ).toBe(true),
  );
  f.runtime.selectContext(f.id, personal);
  held.resolve(new Response(null, { status: 204 }));
  expect(await pending).toEqual({ kind: 'applied', status: 204 });
});
it('reports blocked-locally on failed disconnect and permits explicit retry', async () => {
  const f = await logged();
  const spy = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementation(() => {
      throw new Error('write failed');
    });
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'blocked-locally' });
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'not-sent', reason: 'stopped' });
  spy.mockRestore();
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
});

// Recovery cases belong to the coordinator, independent of the executor's own tests.
it('leaves a forged-state attempt unconsumed for the correct callback', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const wrong = new URL(authorization);
  wrong.searchParams.set('state', 'forged');
  const next = f.returned(wrong);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(f.count('/token')).toBe(0);
  next.dispose();
  await settleLease();
  const valid = f.returned(authorization);
  runtimes.push(valid);
  expect(await valid.initialize()).toMatchObject({ interaction: 'completed' });
});
it('rejects an expired callback before any token dispatch', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
  const next = f.returned(authorization);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(f.count('/token')).toBe(0);
});
it('distinguishes a matching denial from a malformed callback and consumes it once', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () =>
      callback +
      '?error=access_denied&state=' +
      authorization.searchParams.get('state'),
  });
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({
    interaction: 'cancelled',
    problem: 'denied',
  });
  expect(f.count('/token')).toBe(0);
  next.dispose();
  await settleLease();
  const duplicate = f.returned(authorization);
  runtimes.push(duplicate);
  expect(await duplicate.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
});
it('does not accept a refresh arriving after disconnect, even when transport ignores abort', async () => {
  const f = await logged();
  const held = deferred<Response>();
  f.setQuery(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  f.setToken(() => held.promise);
  const pending = f.view.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/token')).toBe(2));
  await f.runtime.disconnect(f.id);
  expect(await pending).toEqual({ kind: 'invalidated' });
  held.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'late',
    }),
  );
  await settleLease();
  expect(f.runtime.getSnapshot()).toEqual([]);
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  await next.initialize();
  expect(next.getSnapshot()).toEqual([]);
});
it('keeps an answered write refusal when scope narrowing stops the resend', async () => {
  const f = fixture({ scopes: { required: ['tasks'] } });
  runtimes.push(f.runtime);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  const login = await f.login();
  runtimes.push(login.runtime);
  f.setResource(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  expect(
    await login.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'refused', status: 401 });
  expect(
    f.fetch.mock.calls.filter(([url]) => url.includes('/resources/')),
  ).toHaveLength(1);
  expect(login.runtime.getSnapshot()[0]?.missingRequiredScopes).toEqual([
    'tasks',
  ]);
});

it('reports an unsupported record independently of a valid restored session', async () => {
  const database = new IDBFactory();
  let store: SessionStore | undefined;
  const f = await logged({
    openStore: async (namespace) => {
      store = await openSessionStore(namespace, database);
      return store;
    },
  });
  await store!.commit('future-version', null, { version: 99 });
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({
    interaction: 'none',
    storage: 'durable',
    unreadable: [{ id: 'future-version', problem: 'unsupported' }],
  });
  await restored(next);
  expect(next.getSnapshot()[0]?.session.kind).toBe('active');
  expect((await store!.read('future-version'))?.value).toEqual({ version: 99 });
});
