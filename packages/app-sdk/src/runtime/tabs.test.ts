/**
 * Several tabs of one app share its durable sessions (#374): a refresh is
 * claimed under the connection's refresh lock and compare-and-swap, so its
 * token is sent once; the other tabs adopt the stored result, and a sign-out
 * or forget reaches every tab. Two runtimes on one store and one set of Web
 * Locks stand for two tabs.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import {
  deferred,
  fixture,
  fixtureNamespace,
  jwt,
  memoryLocks,
  memoryStorage,
  pod,
  restart,
  savedRecords,
  storeWith,
  personal,
  restored,
  work,
} from './fixture.test.js';
import { openSessionStore, type SessionChannel } from '../sessions/store.js';

const runtimes: BrowserRuntime[] = [];
const realNow = Date.now.bind(Date);
let offset = 0;
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  offset = 0;
});
/** Moves this device's clock; issued tokens and expiry checks follow it. */
function advance(ms: number) {
  if (!vi.isMockFunction(Date.now))
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  offset += ms;
}

/**
 * `BroadcastChannel`s of one browser profile: a message reaches the others
 * later, by default after a timer; `deliver` can make it arrive sooner.
 */
function memoryChannels(
  deliver: (send: () => void) => void = (send) => void setTimeout(send),
) {
  const members = new Map<string, Set<Member>>();
  type Member = SessionChannel & {
    listeners: Set<(event: { readonly data: unknown }) => void>;
  };
  return (name: string): SessionChannel => {
    const group = members.get(name) ?? new Set<Member>();
    members.set(name, group);
    const self: Member = {
      listeners: new Set(),
      postMessage(message) {
        const data = structuredClone(message);
        for (const other of group)
          if (other !== self)
            deliver(() =>
              other.listeners.forEach((listener) => listener({ data })),
            );
      },
      addEventListener(_type, listener) {
        self.listeners.add(listener);
      },
      close() {
        group.delete(self);
      },
    };
    group.add(self);
    return self;
  };
}

let issued = 0;
/** Access tokens as issued: a token's `iat`/`exp` follow the clock when issued. */
const minted = new Map<string, string>();
function mint(jti: string) {
  const token = jwt({ jti });
  minted.set(jti, token);
  return token;
}
const bearer = (jti: string) => `Bearer ${minted.get(jti)}`;
/** Two tabs on one IndexedDB, Web Locks and channel; the first is signed in. */
async function tabs(
  channels = memoryChannels(),
  {
    refresh = true,
    options = {},
    second = {},
    factory = new IDBFactory(),
  }: {
    refresh?: boolean;
    factory?: IDBFactory;
    /** For both tabs. */
    options?: Partial<BrowserRuntimeOptions>;
    /** For the second tab only. */
    second?: Partial<BrowserRuntimeOptions>;
  } = {},
) {
  const f = fixture({
    locks: memoryLocks(),
    openStore: (namespace) => openSessionStore(namespace, factory, channels),
    ...options,
  });
  // A rotating refresh token and a distinct access token for every answer.
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ jti: String(++issued) }),
      token_type: 'Bearer',
      ...(refresh ? { refresh_token: 'refresh-' + issued } : {}),
    }),
  );
  const sent: string[] = [];
  f.setQuery(async (_url, init) => {
    sent.push(new Headers(init?.headers).get('authorization')!);
    return Response.json([]);
  });
  runtimes.push(f.runtime);
  const { runtime: a, id } = await f.login();
  runtimes.push(a);
  const b = createBrowserRuntime({ ...f.options, ...second });
  runtimes.push(b);
  expect(await b.initialize()).toMatchObject({ storage: 'durable' });
  await restored(b);
  await b.loadContexts(id);
  b.selectContext(id, work);
  const refreshes = () =>
    f.fetch.mock.calls
      .filter(([url]) => url.endsWith('/token'))
      .map(([, init]) => new URLSearchParams(String(init?.body)))
      .filter((body) => body.get('grant_type') === 'refresh_token');
  const session = (runtime: BrowserRuntime) =>
    runtime.getSnapshot().find((c) => c.id === id)?.session;
  return { ...f, factory, a, b, id, sent, refreshes, session };
}
const records = savedRecords;
const query = 'CONSTRUCT {} WHERE {}';
/** Lets announcements and queued writes land. */
const quiet = () => new Promise((resolve) => setTimeout(resolve, 20));
/** Channels that deliver nothing while frozen, as for a page in the back/forward cache. */
function freezable() {
  let frozen = false;
  return {
    channels: memoryChannels((send) => {
      if (!frozen) setTimeout(send);
    }),
    freeze(on: boolean) {
      frozen = on;
    },
  };
}
/** Stubs the page's events; returns a return from the back/forward cache. */
function bfcache() {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  return () =>
    page.dispatchEvent(
      Object.assign(new Event('pageshow'), { persisted: true }),
    );
}

it('starts a second tab on the same session instead of reporting busy', async () => {
  const t = await tabs();
  expect(t.session(t.a)).toMatchObject({ kind: 'active' });
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(0);
});

it('sends one refresh for concurrent requests of two tabs near expiry, and both use its result', async () => {
  const t = await tabs();
  const answer = deferred<void>();
  t.setToken(async () => {
    await answer.promise;
    return Response.json({
      access_token: mint('renewed'),
      token_type: 'Bearer',
      refresh_token: 'refresh-renewed',
    });
  });
  // Expired: neither request is sent before the renewal.
  advance(3600_000);
  const before = t.sent.length;
  const first = t.a.bind(t.id).sparql.construct(query);
  const second = t.b.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  expect(t.sent).toHaveLength(before);
  answer.resolve();
  expect(await first).toMatchObject({ kind: 'ok' });
  expect(await second).toMatchObject({ kind: 'ok' });
  // The other tab adopted the stored result instead of refreshing itself.
  const renewed = bearer('renewed');
  expect(t.sent.slice(before)).toEqual([renewed, renewed]);
  expect(t.refreshes()).toHaveLength(1);
  expect(t.session(t.a)).toMatchObject({ kind: 'active' });
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  const [saved] = await records(t.factory);
  expect(saved?.value).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'refresh-renewed' },
  });
});

it('gives a tab without requests the credential another tab renewed, keeping its own Context', async () => {
  const t = await tabs();
  await t.a.loadContexts(t.id);
  t.a.selectContext(t.id, personal);
  const notified = vi.fn();
  t.b.subscribe(notified);
  advance(3600_000);
  expect(await t.a.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  const renewed = t.sent.at(-1)!;
  expect(t.refreshes()).toHaveLength(1);
  // Announced: tab b takes the new credential without sending anything.
  await vi.waitFor(() => expect(notified).toHaveBeenCalled());
  const sent = t.sent.length;
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.sent.slice(sent)).toEqual([renewed]);
  expect(t.refreshes()).toHaveLength(1);
  expect(t.b.getSnapshot()[0]?.selectedContext).toBe(work);
  expect(t.a.getSnapshot()[0]?.selectedContext).toBe(personal);
});

it('ends the other tab with a sign-out in one tab', async () => {
  const t = await tabs();
  const view = t.b.bind(t.id);
  expect(await t.a.disconnect(t.id)).toEqual({ kind: 'disconnected' });
  await vi.waitFor(() =>
    expect(t.session(t.b)).toEqual({
      kind: 'signed-out',
      problem: 'disconnected',
    }),
  );
  const sent = t.sent.length;
  expect(await view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  expect(t.sent).toHaveLength(sent);
  expect(t.b.getSnapshot()[0]).toMatchObject({
    grantedScopes: [],
    catalogue: { kind: 'unknown' },
    selectedContext: null,
  });
});

it('removes the connection from the other tab with a forget in one tab', async () => {
  const t = await tabs();
  expect(await t.b.forget(t.id)).toEqual({ kind: 'disconnected' });
  await vi.waitFor(() => expect(t.a.getSnapshot()).toEqual([]));
  expect(await records(t.factory)).toEqual([]);
});

it('signs out in one tab while another tab waits for its refresh answer, which is not kept', async () => {
  const t = await tabs();
  const answer = deferred<void>();
  t.setToken(async () => {
    await answer.promise;
    return Response.json({
      access_token: mint('late'),
      token_type: 'Bearer',
      refresh_token: 'refresh-late',
    });
  });
  advance(3600_000 - 30_000);
  const pending = t.a.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  expect(await t.b.disconnect(t.id)).toEqual({ kind: 'disconnected' });
  answer.resolve();
  await pending;
  await vi.waitFor(() =>
    expect(t.session(t.a)).toMatchObject({ kind: 'signed-out' }),
  );
  const [saved] = await records(t.factory);
  expect(saved?.value).toMatchObject({ kind: 'disconnected' });
  expect(JSON.stringify(saved?.value)).not.toContain('refresh-late');
});

it('resends once from another tab a refresh whose tab closed before its answer', async () => {
  const t = await tabs();
  const never = deferred<Response>();
  t.setToken(() => never.promise);
  advance(3600_000);
  void t.a.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  const spent = t.refreshes()[0]!.get('refresh_token');
  // The tab closes with its claim stored and the answer unknown.
  t.a.dispose();
  t.setToken(async () =>
    Response.json({
      access_token: mint('resent'),
      token_type: 'Bearer',
      refresh_token: 'refresh-resent',
    }),
  );
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(2);
  expect(t.refreshes()[1]!.get('refresh_token')).toBe(spent);
  expect(t.sent.at(-1)).toBe(bearer('resent'));
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
});

it('stops the other tab while one tab re-authorizes, and gives it the new session afterwards', async () => {
  const t = await tabs();
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({
      kind: 'ended',
      problem: 'interrupted',
    }),
  );
  t.a.dispose();
  t.setToken(async () =>
    Response.json({
      access_token: mint('consented'),
      token_type: 'Bearer',
      refresh_token: 'refresh-consented',
    }),
  );
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'active' }),
  );
  await t.b.loadContexts(t.id);
  t.b.selectContext(t.id, work);
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.sent.at(-1)).toBe(bearer('consented'));
  expect(t.refreshes()).toHaveLength(0);
});

it('excludes a tab with an exclusive lease, as an earlier SDK takes it', async () => {
  const locks = memoryLocks();
  const factory = new IDBFactory();
  const release = deferred<void>();
  const held = locks.request(
    `sempods:sessions:${fixtureNamespace}`,
    { ifAvailable: true },
    async () => release.promise,
  );
  const f = fixture({
    locks,
    openStore: (namespace) =>
      openSessionStore(namespace, factory, memoryChannels()),
  });
  runtimes.push(f.runtime);
  expect(await f.runtime.initialize()).toMatchObject({ storage: 'busy' });
  release.resolve();
  await held;
});

it('waits at startup for the refresh another tab has out, then restores its result', async () => {
  const t = await tabs();
  t.b.dispose();
  const answer = deferred<void>();
  t.setToken(async () => {
    await answer.promise;
    return Response.json({
      access_token: mint('renewed'),
      token_type: 'Bearer',
      refresh_token: 'refresh-renewed',
    });
  });
  advance(3600_000);
  const pending = t.a.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  // A new tab finds the claim of a refresh whose answer is still out.
  const c = createBrowserRuntime(t.options);
  runtimes.push(c);
  await c.initialize();
  expect(c.getSnapshot()[0]?.session).toEqual({ kind: 'restoring' });
  answer.resolve();
  expect(await pending).toMatchObject({ kind: 'ok' });
  await restored(c);
  expect(c.getSnapshot()[0]?.session).toMatchObject({ kind: 'active' });
  await c.loadContexts(t.id);
  c.selectContext(t.id, work);
  expect(await c.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.sent.at(-1)).toBe(bearer('renewed'));
  expect(t.refreshes()).toHaveLength(1);
});

it('sends no spent refresh token from a tab that restores while another tab renews', async () => {
  // The announcement arrives before the refresh lock passes on.
  const t = await tabs(memoryChannels(queueMicrotask));
  t.b.dispose();
  const answer = deferred<void>();
  t.setToken(async () => {
    await answer.promise;
    return Response.json({
      access_token: mint('renewed'),
      token_type: 'Bearer',
      refresh_token: 'refresh-renewed',
    });
  });
  advance(3600_000);
  // A new tab lists the record still `ready`, then waits in its discovery.
  const discovery = deferred<void>();
  const held: typeof t.fetch = vi.fn(async (url, init) => {
    if (url.endsWith('/.well-known/oauth-protected-resource'))
      await discovery.promise;
    return t.fetch(url, init);
  });
  const c = createBrowserRuntime({ ...t.options, fetch: held });
  runtimes.push(c);
  await c.initialize();
  expect(c.getSnapshot()[0]?.session).toEqual({ kind: 'restoring' });
  // Meanwhile the first tab claims the refresh, and the new tab waits for it.
  const pending = t.a.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  discovery.resolve();
  await quiet();
  answer.resolve();
  expect(await pending).toMatchObject({ kind: 'ok' });
  await restored(c);
  await vi.waitFor(() =>
    expect(c.getSnapshot()[0]?.session).toMatchObject({ kind: 'active' }),
  );
  await quiet();
  expect(t.refreshes()).toHaveLength(1);
  const [saved] = await records(t.factory);
  expect(saved?.value).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'refresh-renewed' },
  });
});

it('reads the records again on a return from the back/forward cache, which missed a sign-out', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  freeze(true);
  expect(await t.a.disconnect(t.id)).toEqual({ kind: 'disconnected' });
  await quiet();
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  pageshow();
  await vi.waitFor(() =>
    expect(t.session(t.b)).toEqual({
      kind: 'signed-out',
      problem: 'disconnected',
    }),
  );
});

it('sends no refresh under a lock that an injected Web Locks did not grant', async () => {
  const t = await tabs();
  const granted = memoryLocks();
  const b = createBrowserRuntime({
    ...t.options,
    // A double written for 0.8 that answers every request like `ifAvailable`.
    locks: {
      request: (name, options, callback) =>
        options.ifAvailable
          ? granted.request(name, options, callback)
          : callback(null),
    },
  });
  runtimes.push(b);
  t.b.dispose();
  await b.initialize();
  await restored(b);
  advance(3600_000);
  await b.loadContexts(t.id).catch(() => {});
  expect(t.refreshes()).toHaveLength(0);
  expect(t.session(b)).toMatchObject({
    kind: 'ended',
    problem: 'coordination',
  });
});

it('checks Context access again for a new session it adopts without the sign-in in between', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  expect(t.b.getSnapshot()[0]).toMatchObject({
    catalogue: { kind: 'ready' },
    selectedContext: work,
  });
  // Tab b sits in the back/forward cache while tab a signs in again.
  freeze(true);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  freeze(false);
  pageshow();
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]).toMatchObject({
      session: { kind: 'active' },
      catalogue: { kind: 'unknown' },
      selectedContext: null,
    }),
  );
  expect(() => t.b.bind(t.id)).toThrow();
});

it('stops the earlier session for a refresh another tab claimed for a newer sign-in', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  // Tab b misses a new sign-in in tab a and that session's refresh claim.
  freeze(true);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  await back.loadContexts(t.id);
  back.selectContext(t.id, work);
  const answer = deferred<Response>();
  t.setToken(() => answer.promise);
  advance(3600_000);
  void back.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  const view = t.b.bind(t.id);
  freeze(false);
  pageshow();
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'restoring' }),
  );
  const sent = t.sent.length;
  expect(await view.sparql.construct(query)).toEqual({ kind: 'invalidated' });
  expect(t.sent).toHaveLength(sent);
});

it('retires only the session that ended, not one it adopted while that waited', async () => {
  const { channels, freeze } = freezable();
  // Sessions without a refresh token: an expired one ends here.
  const t = await tabs(channels, { refresh: false });
  t.b.dispose();
  // This tab's store holds its reads while `gate` is set.
  let gate: Promise<void> | undefined;
  let reading = false;
  const b = createBrowserRuntime({
    ...t.options,
    openStore: storeWith(
      t.factory,
      (store) => ({
        async read(id) {
          if (gate) {
            reading = true;
            await gate;
          }
          return store.read(id);
        },
      }),
      channels,
    ),
  });
  runtimes.push(b);
  await b.initialize();
  await restored(b);
  await b.loadContexts(t.id);
  b.selectContext(t.id, work);
  // Tab b misses the attempt; it reads the completed sign-in slowly.
  freeze(true);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const release = deferred<void>();
  gate = release.promise;
  freeze(false);
  // The newer session outlives tab b's earlier one.
  t.setToken(async () =>
    Response.json({
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3 * 3600 }),
      token_type: 'Bearer',
      expires_in: 3 * 3600,
    }),
  );
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  await vi.waitFor(() => expect(reading).toBe(true));
  // Meanwhile tab b's earlier session expires and ends here.
  advance(3600_000);
  await b.bind(t.id).sparql.construct(query);
  expect(t.session(b)).toMatchObject({ kind: 'ended', problem: 'expired' });
  gate = undefined;
  release.resolve();
  await vi.waitFor(() =>
    expect(t.session(b)).toMatchObject({ kind: 'active' }),
  );
  await quiet();
  const [saved] = await records(t.factory);
  expect(saved?.value).toMatchObject({ kind: 'ready' });
  expect(t.session(b)).toMatchObject({ kind: 'active' });
});

it('reads a change queued for a connection that an earlier change replaced', async () => {
  const channels = memoryChannels();
  const t = await tabs(channels);
  t.b.dispose();
  // While `gate` is set, tab b's reads return the record as it was when
  // read, after the gate opens.
  let gate: Promise<void> | undefined;
  let reading = false;
  const b = createBrowserRuntime({
    ...t.options,
    openStore: storeWith(
      t.factory,
      (store) => ({
        async read(id) {
          const stored = await store.read(id);
          if (gate) {
            reading = true;
            await gate;
          }
          return stored;
        },
      }),
      channels,
    ),
  });
  runtimes.push(b);
  await b.initialize();
  await restored(b);
  const release = deferred<void>();
  gate = release.promise;
  // Tab b reads tab a's attempt, and hears of its completion meanwhile.
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  await vi.waitFor(() => expect(reading).toBe(true));
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  await quiet();
  gate = undefined;
  release.resolve();
  // The attempt replaces tab b's connection; the completion follows it.
  await quiet();
  expect(t.session(b)).toMatchObject({ kind: 'active' });
  expect(b.bindPod(t.id)).toBeDefined();
});

it('restores an earlier grant another tab resumed under its own client', async () => {
  const t = await tabs();
  // Tab a's re-authorization registers another client, then is declined.
  const original = t.fetch.getMockImplementation()!;
  t.fetch.mockImplementation(async (url, init) => {
    const response = await original(url, init);
    if (!url.endsWith('/register')) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return Response.json({ ...body, client_id: 'dyn:second' }, { status: 201 });
  });
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'ended' }),
  );
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'cancelled' });
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'active' }),
  );
  // Tab b renews with the client of the grant it uses.
  await t.b.loadContexts(t.id);
  t.b.selectContext(t.id, work);
  advance(3600_000);
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes().at(-1)?.get('client_id')).toBe('dyn:test');
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
});

describe('a re-authorization another tab is away for', () => {
  /** Tab a leaves for a re-authorization and is at the Pod; tab b is closed. */
  async function away(options: Partial<BrowserRuntimeOptions> = {}) {
    const tabA = memoryStorage();
    const t = await tabs(memoryChannels(), {
      options: { ...options, tabStorage: tabA },
    });
    t.b.dispose();
    await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
    t.a.dispose();
    const start = async (tabStorage = memoryStorage()) => {
      const runtime = createBrowserRuntime({ ...t.options, tabStorage });
      runtimes.push(runtime);
      await runtime.initialize();
      return runtime;
    };
    return { t, tabA, start };
  }
  it('is left to that tab by a tab that starts meanwhile', async () => {
    const { t, start } = await away();
    const c = await start();
    expect(t.session(c)).toMatchObject({
      kind: 'ended',
      problem: 'interrupted',
    });
    const [saved] = await records(t.factory);
    expect(saved?.value).toMatchObject({ kind: 'authorizing' });
    const back = t.returned();
    runtimes.push(back);
    expect(await back.initialize()).toMatchObject({
      interaction: 'completed',
    });
    await vi.waitFor(() =>
      expect(t.session(c)).toMatchObject({ kind: 'active' }),
    );
  });
  it('resumes the earlier session when that tab comes back without a callback', async () => {
    const { t, tabA, start } = await away();
    const again = await start(tabA);
    await restored(again);
    expect(t.session(again)).toMatchObject({ kind: 'active' });
    const [saved] = await records(t.factory);
    expect(saved?.value).toMatchObject({ kind: 'ready' });
  });
  it('resumes the earlier session in another tab once the attempt expired', async () => {
    const { t, start } = await away();
    // Its tab closed at the Pod: the attempt expires shortly.
    advance(10 * 60_000 - 100);
    const c = await start();
    expect(t.session(c)).toMatchObject({ kind: 'ended' });
    await vi.waitFor(() =>
      expect(t.session(c)).toMatchObject({ kind: 'active' }),
    );
    const [saved] = await records(t.factory);
    expect(saved?.value).toMatchObject({ kind: 'ready' });
  });
  it('resumes it with its binding in a tab reading without a token meanwhile', async () => {
    const { t, start } = await away({ signIn: 'optional' });
    advance(10 * 60_000 - 100);
    const c = await start();
    // Under `optional`, the interrupted connection reads without a token.
    expect(t.session(c)).toMatchObject({ kind: 'ended' });
    await vi.waitFor(() =>
      expect(t.session(c)).toMatchObject({ kind: 'active' }),
    );
    // The resumed session renews under its stored binding.
    await c.loadContexts(t.id);
    c.selectContext(t.id, work);
    const renewals = t.refreshes().length;
    advance(3600_000);
    expect(await c.bind(t.id).sparql.construct(query)).toMatchObject({
      kind: 'ok',
    });
    expect(t.refreshes()).toHaveLength(renewals + 1);
    expect(t.session(c)).toMatchObject({ kind: 'active' });
  });
});

it('keeps a sign-out that could not be saved blocked when another tab renews that session', async () => {
  let failing = false;
  const channels = memoryChannels();
  const factory = new IDBFactory();
  const t = await tabs(channels, {
    factory,
    second: {
      openStore: storeWith(
        factory,
        (store) => ({
          commit: (...args) =>
            failing
              ? Promise.reject(new Error('quota'))
              : store.commit(...args),
        }),
        channels,
      ),
    },
  });
  failing = true;
  expect(await t.b.disconnect(t.id)).toEqual({ kind: 'blocked-locally' });
  expect(t.session(t.b)).toMatchObject({ saved: false });
  advance(3600_000);
  expect(await t.a.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(1);
  await quiet();
  expect(t.session(t.b)).toMatchObject({
    kind: 'ended',
    problem: 'disconnected',
    saved: false,
  });
  // The retry signs out the session as the other tab renewed it.
  failing = false;
  expect(await t.b.disconnect(t.id)).toEqual({ kind: 'disconnected' });
  const [saved] = await records(t.factory);
  expect(saved?.value).toMatchObject({ kind: 'disconnected' });
});

it('keeps reading without a token when another tab ends a sign-in it stopped this tab for', async () => {
  const t = await tabs(memoryChannels(), { options: { signIn: 'optional' } });
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]?.reading).toBe('anonymous'),
  );
  t.a.dispose();
  const back = t.returned(undefined, 'error=login_required');
  runtimes.push(back);
  await back.initialize();
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'signed-out' }),
  );
  expect(t.b.getSnapshot()[0]?.reading).toBe('anonymous');
  expect(await t.b.loadContexts(t.id)).toMatchObject({ kind: 'ok' });
});

describe('one saved connection per Pod across tabs', () => {
  /** A signed-out tab b beside tab a, which signs in with `f.login()`. */
  async function opened({
    channels = memoryChannels(),
    held = false,
  }: { channels?: ReturnType<typeof memoryChannels>; held?: boolean } = {}) {
    const factory = new IDBFactory();
    const f = fixture({
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    runtimes.push(f.runtime);
    // With `held`, tab b's discoveries wait for `release()` once `hold()`.
    let gate: Promise<void> | undefined;
    let open = () => {};
    const b = createBrowserRuntime({
      ...f.options,
      ...(held
        ? {
            fetch: (async (url, init) => {
              if (gate && url.endsWith('/.well-known/oauth-protected-resource'))
                await gate;
              return f.fetch(url, init);
            }) satisfies PodFetch,
          }
        : {}),
    });
    runtimes.push(b);
    await b.initialize();
    return {
      f,
      factory,
      b,
      hold() {
        gate = new Promise((resolve) => (open = resolve));
      },
      release() {
        gate = undefined;
        open();
      },
    };
  }
  it('lists the connection another tab signed in to, instead of a second one', async () => {
    const { f, factory, b } = await opened();
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id, session: { kind: 'active' } },
      ]),
    );
    expect((await b.connect(pod)).id).toBe(id);
    expect(await records(factory)).toHaveLength(1);
  });
  it('replaces this tab’s connection without a record by the one another tab signed in to', async () => {
    const { f, factory, b } = await opened();
    const own = await b.connect(pod);
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    expect(id).not.toBe(own.id);
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id, session: { kind: 'active' } },
      ]),
    );
    expect((await b.connect(pod)).id).toBe(id);
    expect(await records(factory)).toHaveLength(1);
  });
  it('connects to a Pod another tab signed in to while this tab was open without listing it', async () => {
    const { f, factory } = await opened();
    const muted = createBrowserRuntime({
      ...f.options,
      // A store that shares the lease but announces nothing to this runtime.
      openStore: storeWith(factory, () => ({ watch: () => () => {} })),
    });
    runtimes.push(muted);
    await muted.initialize();
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    expect(muted.getSnapshot()).toEqual([]);
    expect((await muted.connect(pod)).id).toBe(id);
    expect(muted.getSnapshot()).toMatchObject([{ id }]);
    await vi.waitFor(() =>
      expect(muted.getSnapshot()[0]?.session.kind).toBe('active'),
    );
    expect(await records(factory)).toHaveLength(1);
  });
  it('keeps one connection when another tab signs in while this tab connects', async () => {
    const { f, factory, b, hold, release } = await opened({ held: true });
    hold();
    const connecting = b.connect(pod);
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id, session: { kind: 'active' } },
      ]),
    );
    release();
    expect((await connecting).id).toBe(id);
    expect(b.getSnapshot()).toHaveLength(1);
    expect(await records(factory)).toHaveLength(1);
  });
  it('uses the session another tab signed in to while this tab prepares its own sign-in', async () => {
    const { f, factory, b, hold, release } = await opened({ held: true });
    const own = await b.connect(pod);
    hold();
    const signingIn = b.beginAuthorization(own.id);
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    const navigations = f.navigate.mock.calls.length;
    // Its sign-in keeps this tab's connection listed meanwhile.
    await quiet();
    expect(b.getSnapshot()).toMatchObject([{ id: own.id }]);
    release();
    await signingIn;
    expect(f.navigate.mock.calls).toHaveLength(navigations);
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id, session: { kind: 'active' } },
      ]),
    );
    expect(await records(factory)).toHaveLength(1);
  });
  it('continues on the connection another tab starts signing in to while this tab prepares', async () => {
    const { f, factory, b, hold, release } = await opened({ held: true });
    const own = await b.connect(pod);
    hold();
    const signingIn = b.beginAuthorization(own.id);
    // Tab a stores its attempt for the same Pod first.
    const { connection } = await f.begin();
    expect(connection.id).not.toBe(own.id);
    const navigations = f.navigate.mock.calls.length;
    release();
    await signingIn;
    // One saved connection: tab b's attempt replaced tab a's.
    const saved = await records(factory);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      id: connection.id,
      value: { kind: 'authorizing' },
    });
    expect(f.navigate.mock.calls).toHaveLength(navigations + 1);
    expect(b.getSnapshot()).toMatchObject([{ id: connection.id }]);
  });
  it('joins a sign-in another tab has out instead of starting a second connection', async () => {
    const { f, factory, b } = await opened();
    const { authorization } = await f.begin();
    f.runtime.dispose();
    const own = await b.connect(pod);
    expect(own.session).toEqual({ kind: 'ended', problem: 'interrupted' });
    const back = f.returned(authorization);
    runtimes.push(back);
    expect(await back.initialize()).toMatchObject({
      interaction: 'completed',
    });
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id: own.id, session: { kind: 'active' } },
      ]),
    );
    expect(await records(factory)).toHaveLength(1);
  });
  it('joins the default Pod’s session another tab stored that this tab missed', async () => {
    const { channels, freeze } = freezable();
    const factory = new IDBFactory();
    const f = fixture({
      locks: memoryLocks(),
      signIn: 'optional',
      preset: { podUrl: pod },
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    runtimes.push(f.runtime);
    const b = createBrowserRuntime(f.options);
    runtimes.push(b);
    await b.initialize();
    // The default Pod's connection has the same id in every tab.
    expect(b.getSnapshot()).toMatchObject([
      { id: pod, session: { kind: 'signed-out' } },
    ]);
    freeze(true);
    const { runtime: a } = await f.login();
    runtimes.push(a);
    const navigations = f.navigate.mock.calls.length;
    await b.beginAuthorization(pod);
    expect(f.navigate.mock.calls).toHaveLength(navigations);
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id: pod, session: { kind: 'active' } },
      ]),
    );
    const saved = await records(factory);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.value).toMatchObject({ kind: 'ready' });
  });
  it('leaves the saved connections alone when a first sign-in cannot list them', async () => {
    const { channels, freeze } = freezable();
    const factory = new IDBFactory();
    let failing = false;
    const f = fixture({
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    runtimes.push(f.runtime);
    const b = createBrowserRuntime({
      ...f.options,
      openStore: storeWith(
        factory,
        (store) => ({
          list: () =>
            failing ? Promise.reject(new Error('unreadable')) : store.list(),
        }),
        channels,
      ),
    });
    runtimes.push(b);
    await b.initialize();
    const own = await b.connect(pod);
    freeze(true);
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    failing = true;
    const navigations = f.navigate.mock.calls.length;
    await expect(b.beginAuthorization(own.id)).rejects.toMatchObject({
      problem: 'storage',
    });
    expect(f.navigate.mock.calls).toHaveLength(navigations);
    const saved = await records(factory);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id, value: { kind: 'ready' } });
  });
  it('follows a sign-in another tab completes while its announcements are read', async () => {
    const channels = memoryChannels();
    const factory = new IDBFactory();
    const f = fixture({
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    runtimes.push(f.runtime);
    // While `gate` is set, tab b's reads return the record as it was when
    // read, after the gate opens.
    let gate: Promise<void> | undefined;
    let reads = 0;
    const b = createBrowserRuntime({
      ...f.options,
      openStore: storeWith(
        factory,
        (store) => ({
          async read(id) {
            const stored = await store.read(id);
            if (gate) {
              reads++;
              await gate;
            }
            return stored;
          },
        }),
        channels,
      ),
    });
    runtimes.push(b);
    await b.initialize();
    const release = deferred<void>();
    gate = release.promise;
    // Tab b reads tab a's attempt and its completion, both held.
    const { connection, authorization } = await f.begin();
    f.runtime.dispose();
    await vi.waitFor(() => expect(reads).toBe(1));
    const back = f.returned(authorization);
    runtimes.push(back);
    expect(await back.initialize()).toMatchObject({
      interaction: 'completed',
    });
    await vi.waitFor(() => expect(reads).toBeGreaterThan(1));
    gate = undefined;
    release.resolve();
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id: connection.id, session: { kind: 'active' } },
      ]),
    );
  });
  it('lists a connection another tab added while this page was in the back/forward cache', async () => {
    const pageshow = bfcache();
    const { channels, freeze } = freezable();
    const { f, b } = await opened({ channels });
    freeze(true);
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    await quiet();
    expect(b.getSnapshot()).toEqual([]);
    freeze(false);
    pageshow();
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id, session: { kind: 'active' } },
      ]),
    );
  });
});

it('forgets this tab’s Context for a connection another tab forgot', async () => {
  const shared = memoryStorage();
  const tabB = memoryStorage();
  const t = await tabs(memoryChannels(), {
    options: {
      signIn: 'optional',
      preset: { podUrl: pod },
      preferences: shared,
      tabStorage: memoryStorage(),
    },
    second: { tabStorage: tabB },
  });
  // The default Pod's connection has the same id in every tab.
  expect(t.id).toBe(pod);
  const key = `@sempods/app-sdk:context:${fixtureNamespace}`;
  expect(JSON.parse(tabB.map.get(key)!)).toEqual({ [pod]: work });
  expect(await t.a.forget(t.id)).toEqual({ kind: 'disconnected' });
  await vi.waitFor(() =>
    expect(JSON.parse(tabB.map.get(key) ?? '{}')).toEqual({}),
  );
  // Listed again as a connection never signed in to, without that Context.
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()).toMatchObject([
      { id: pod, session: { kind: 'signed-out' } },
    ]),
  );
  await t.b.loadContexts(pod);
  expect(t.b.getSnapshot()[0]?.selectedContext).toBeNull();
});

it('reselects each tab’s own Context after its reload', async () => {
  const shared = memoryStorage();
  const tabA = memoryStorage();
  const tabB = memoryStorage();
  const t = await tabs(memoryChannels(), {
    options: { preferences: shared, tabStorage: tabA },
    second: { tabStorage: tabB },
  });
  await t.a.loadContexts(t.id);
  t.a.selectContext(t.id, personal);
  // Tab b chose `work` after tab a; reloading tab a keeps its own choice.
  t.b.selectContext(t.id, work);
  const reloaded = await restart(t, t.a, (r) => runtimes.push(r), {
    tabStorage: tabA,
  });
  await reloaded.loadContexts(t.id);
  expect(reloaded.getSnapshot()[0]?.selectedContext).toBe(personal);
  // A new tab starts from the last choice on this device.
  const fresh = createBrowserRuntime({
    ...t.options,
    tabStorage: memoryStorage(),
  });
  runtimes.push(fresh);
  await fresh.initialize();
  await restored(fresh);
  await fresh.loadContexts(t.id);
  expect(fresh.getSnapshot()[0]?.selectedContext).toBe(work);
});
