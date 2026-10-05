/**
 * Runtime robustness: startup independence, preparation before reset,
 * did:web without a registration endpoint.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { createBrowserRuntime } from './runtime.js';
import { openSessionStore } from '../sessions/store.js';
import { parseSessionRecord } from '../sessions/records.js';
import type { BrowserRuntime } from './types.js';
import {
  callback,
  deferred,
  fixture,
  jwt,
  pod,
  restored,
  settleLease,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));

it('does not hold an ordinary startup open for a saved Pod whose discovery never settles', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const first = await f.login();
  runtimes.push(first.runtime);
  // Connect a second Pod in the same storage.
  const bob = 'https://pod.example/bob';
  const second = await first.runtime.connect(bob);
  await first.runtime.beginAuthorization(second.id);
  first.runtime.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ iss: bob }),
      token_type: 'Bearer',
      refresh_token: 'bob',
    }),
  );
  const completed = f.returned();
  runtimes.push(completed);
  expect(await completed.initialize()).toMatchObject({
    interaction: 'completed',
  });
  completed.dispose();
  await settleLease();
  // Next ordinary start: Alice's discovery hangs, Bob's answers.
  const original = f.fetch.getMockImplementation()!;
  const hang = deferred<Response>();
  f.fetch.mockImplementation((url, init) =>
    url.startsWith(`${pod}/.well-known/`) ? hang.promise : original(url, init),
  );
  const next = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({
    interaction: 'none',
    storage: 'durable',
  });
  // Bob settles on his own while Alice's discovery is still pending.
  await vi.waitFor(() =>
    expect(
      Object.fromEntries(
        next.getSnapshot().map((c) => [c.podUrl, c.session.kind]),
      ),
    ).toEqual({ [pod]: 'restoring', [bob]: 'active' }),
  );
  // When Alice answers later, she becomes active too.
  f.fetch.mockImplementation(original);
  hang.resolve(
    await original(`${pod}/.well-known/oauth-protected-resource`, {}),
  );
  await restored(next);
});

it('keeps the current session working while a new authorization is being prepared', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { runtime, id, view } = await f.login();
  runtimes.push(runtime);
  const original = f.fetch.getMockImplementation()!;
  const hold = deferred<void>();
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) await hold.promise;
    return original(url, init);
  });
  const navigation = runtime.beginAuthorization(id);
  // Discovery is pending: nothing was reset, reads still work.
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(await view.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
  hold.resolve();
  await navigation;
  expect(runtime.getSnapshot()[0]).toMatchObject({
    session: { kind: 'signed-out' },
    selectedContext: null,
  });
  expect(f.navigate).toHaveBeenCalled();
});

it('signs in with did:web when the Pod advertises no registration endpoint', async () => {
  const f = fixture({
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: callback,
    },
  });
  runtimes.push(f.runtime);
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const answer = await original(url, init);
    if (!url.endsWith('/.well-known/oauth-authorization-server')) return answer;
    const { registration_endpoint: _omitted, ...metadata } =
      (await answer.json()) as Record<string, unknown>;
    void _omitted;
    return Response.json(metadata);
  });
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ client_id: 'did:web:app.example' }),
      token_type: 'Bearer',
      refresh_token: 'one',
    }),
  );
  const { runtime } = await f.login();
  runtimes.push(runtime);
  expect(runtime.getSnapshot()[0]).toMatchObject({
    clientKind: 'did-web',
    session: { kind: 'active' },
  });
  expect(f.count('/register')).toBe(0);
});

it('refuses a dynamic sign-in without a registration endpoint and resets nothing', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { runtime, id, view } = await f.login();
  runtimes.push(runtime);
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    const answer = await original(url, init);
    if (!url.endsWith('/.well-known/oauth-authorization-server')) return answer;
    const { registration_endpoint: _omitted, ...metadata } =
      (await answer.json()) as Record<string, unknown>;
    void _omitted;
    return Response.json(metadata);
  });
  // This runtime has no cached registration, so a dynamic client cannot be
  // prepared; the failure leaves the signed-in session exactly as it was.
  await expect(runtime.beginAuthorization(id)).rejects.toMatchObject({
    reason: { problem: 'invalid-config', field: 'registration_endpoint' },
  });
  expect(runtime.getSnapshot()[0]).toMatchObject({
    session: { kind: 'active' },
    selectedContext: expect.any(String),
  });
  expect(await view.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
});

it('does not navigate when disconnect happens while the new attempt is being persisted', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const first = await f.login();
  first.runtime.dispose();
  await settleLease();
  // The attempt commits durably, but its answer is held until disconnect ran.
  const entered = deferred<void>();
  const release = deferred<void>();
  let armed = false;
  const runtime = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
    openStore: async (namespace) => {
      const store = await f.options.openStore!(namespace);
      return new Proxy(store, {
        get(target, property) {
          const value = Reflect.get(target, property, target) as unknown;
          if (typeof value !== 'function') return value;
          if (property !== 'commit') return value.bind(target) as unknown;
          return async (...args: unknown[]) => {
            const result = await (
              value as (...a: unknown[]) => Promise<unknown>
            ).apply(target, args);
            if (armed) {
              armed = false;
              entered.resolve();
              await release.promise;
            }
            return result;
          };
        },
      });
    },
  });
  runtimes.push(runtime);
  await runtime.initialize();
  await restored(runtime);
  f.navigate.mockClear();
  armed = true;
  const begun = runtime.beginAuthorization(first.id);
  await entered.promise;
  const disconnected = runtime.disconnect(first.id);
  release.resolve();
  await expect(begun).rejects.toThrow();
  expect(await disconnected).toEqual({ kind: 'disconnected' });
  expect(f.navigate).not.toHaveBeenCalled();
  expect(runtime.getSnapshot()).toEqual([]);
  // The committed attempt was retired durably, too.
  runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  await next.initialize();
  expect(next.getSnapshot()).toEqual([]);
});

it.each(['consumed-refresh', 'permanent-pre-claim'] as const)(
  'signs in again in the same runtime after the session ended (%s)',
  async (mode) => {
    const f = fixture();
    runtimes.push(f.runtime);
    const { runtime, id, view } = await f.login();
    runtimes.push(runtime);
    const original = f.fetch.getMockImplementation()!;
    if (mode === 'consumed-refresh')
      f.setToken(async () => {
        throw new TypeError('lost response');
      });
    else
      f.fetch.mockImplementation(async (url, init) => {
        const answer = await original(url, init);
        if (!url.endsWith('/.well-known/oauth-authorization-server'))
          return answer;
        const metadata = (await answer.json()) as Record<string, unknown>;
        metadata['token_endpoint'] = `${pod}/_system/auth/token-v2`;
        return Response.json(metadata);
      });
    f.setResource(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    expect(
      await view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
    ).toEqual({ kind: 'refused', status: 401 });
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('ended');
    // The Pod is reachable again with its original metadata.
    f.fetch.mockImplementation(original);
    f.navigate.mockClear();
    await runtime.beginAuthorization(id);
    expect(f.navigate).toHaveBeenCalledTimes(1);
    expect(new URL(f.navigate.mock.calls[0]![0]).pathname).toBe(
      '/alice/_system/auth/authorize',
    );
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('signed-out');
  },
);

it.each(['removed', 'blocked-locally'] as const)(
  'cancels a sign-in after an ended session when disconnect happens during discovery (%s)',
  async (outcome) => {
    const f = fixture();
    runtimes.push(f.runtime);
    const { runtime, id, view } = await f.login();
    runtimes.push(runtime);
    // A permanent pre-claim failure ends the session but keeps its record.
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const answer = await original(url, init);
      if (!url.endsWith('/.well-known/oauth-authorization-server'))
        return answer;
      const metadata = (await answer.json()) as Record<string, unknown>;
      metadata['token_endpoint'] = `${pod}/_system/auth/token-v2`;
      return Response.json(metadata);
    });
    f.setResource(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    await view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' });
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('ended');
    if (outcome === 'blocked-locally') {
      // The entry then stays; only its cancelled lifetime stops the sign-in.
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        if (value?.value?.kind === 'disconnected')
          throw new Error('disk failed');
        return put.call(this, value, key);
      });
    }
    const hold = deferred<void>();
    f.fetch.mockImplementation(async (url, init) => {
      if (url.includes('/.well-known/')) await hold.promise;
      return original(url, init);
    });
    f.navigate.mockClear();
    const begun = runtime.beginAuthorization(id);
    const disconnected = runtime.disconnect(id);
    expect(await disconnected).toEqual({
      kind: outcome === 'removed' ? 'disconnected' : 'blocked-locally',
    });
    hold.resolve();
    await expect(begun).rejects.toThrow();
    expect(f.navigate).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  },
);

const moved = 'https://app.example/auth/return';
function didWebFixture() {
  const f = fixture({
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: callback,
    },
  });
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ client_id: 'did:web:app.example' }),
      token_type: 'Bearer',
      refresh_token: 'one',
    }),
  );
  return f;
}
const didNamespace = JSON.stringify(['did-web', 'did:web:app.example']);

it('restores a did:web session after its callback route moved within the same identity', async () => {
  const f = didWebFixture();
  runtimes.push(f.runtime);
  const { runtime, id } = await f.login();
  runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: moved,
    },
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  expect((await next.initialize()).unreadable).toEqual([]);
  await restored(next);
  expect(next.getSnapshot()[0]).toMatchObject({
    id,
    session: { kind: 'active' },
  });
  // The next refresh writes the moved route into the record (normal CAS).
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ client_id: 'did:web:app.example' }),
      token_type: 'Bearer',
      refresh_token: 'two',
    }),
  );
  let answered = 0;
  f.setResource(async () =>
    ++answered === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : new Response(null, { status: 204 }),
  );
  await next.loadContexts(id);
  next.selectContext(id, work);
  expect(
    await next.bind(id).subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toMatchObject({ kind: 'applied' });
  const store = await openSessionStore(didNamespace, f.factory);
  expect((await store.read(id))?.value).toMatchObject({
    kind: 'ready',
    binding: { client: { redirectUri: moved } },
  });
  store.close();
});

it('keeps an outstanding did:web attempt bound to its exact callback route', async () => {
  const f = didWebFixture();
  runtimes.push(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const store = await openSessionStore(didNamespace, f.factory);
  const before = await store.read(connection.id);
  store.close();
  expect(before?.value).toMatchObject({ kind: 'authorizing' });
  const next = createBrowserRuntime({
    ...f.options,
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: moved,
    },
    location: () => 'https://app.example/',
  });
  runtimes.push(next);
  expect((await next.initialize()).unreadable).toEqual([
    { id: connection.id, problem: 'corrupt' },
  ]);
  next.dispose();
  await settleLease();
  // Reported, never rewritten or deleted.
  const after = await openSessionStore(didNamespace, f.factory);
  expect(await after.read(connection.id)).toEqual(before);
  after.close();
});

it('does not let a did:web session follow a route outside its identity', async () => {
  const f = didWebFixture();
  runtimes.push(f.runtime);
  const { runtime, id } = await f.login();
  runtime.dispose();
  await settleLease();
  const store = await openSessionStore(didNamespace, f.factory);
  const before = await store.read(id);
  store.close();
  const foreign = createBrowserRuntime({
    ...f.options,
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: 'https://other.example/oauth/callback',
    },
    location: () => 'https://other.example/',
  });
  runtimes.push(foreign);
  expect((await foreign.initialize()).unreadable).toEqual([
    { id, problem: 'corrupt' },
  ]);
  expect(foreign.getSnapshot()).toEqual([]);
  foreign.dispose();
  await settleLease();
  const after = await openSessionStore(didNamespace, f.factory);
  expect(await after.read(id)).toEqual(before);
  after.close();
});

it('lets a refresh claim follow a moved did:web route but keeps a code claim exact', async () => {
  const f = didWebFixture();
  runtimes.push(f.runtime);
  const { runtime, id } = await f.login();
  runtime.dispose();
  await settleLease();
  const store = await openSessionStore(didNamespace, f.factory);
  const ready = (await store.read(id))!;
  store.close();
  const binding = (ready.value as { binding: unknown }).binding;
  const config = { configKey: didNamespace, redirectUri: moved };
  const claim = (operation: 'code' | 'refresh') => ({
    id,
    revision: ready.revision,
    value: {
      version: 1,
      kind: 'claimed',
      binding,
      operation,
      subject: operation === 'code' ? null : 'urn:person:me',
    },
  });
  expect(parseSessionRecord(claim('refresh'), config).value).toMatchObject({
    kind: 'claimed',
    binding: { client: { redirectUri: moved } },
  });
  expect(() => parseSessionRecord(claim('code'), config)).toThrow(
    expect.objectContaining({ problem: 'corrupt' }),
  );
});
