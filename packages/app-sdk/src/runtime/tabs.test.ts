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
  callback,
  catalogue,
  deferred,
  fixture,
  fixtureNamespace,
  jwt,
  memoryHistory,
  memoryLocks,
  memoryStorage,
  pod,
  restart,
  savedRecords,
  settleLease,
  storeWith,
  personal,
  restored,
  unauthorized,
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

it('keeps the other tab working while one tab re-authorizes, and gives it the new session afterwards', async () => {
  const t = await tabs();
  const view = t.b.bind(t.id);
  expect(await view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  const before = t.sent.at(-1);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  // Tab b reads with the session it has, while tab a is at the Pod.
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  expect(await view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(t.sent.at(-1)).toBe(before);
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
  // The new grant replaces the session in tab b: its earlier handle is
  // retired and nothing of it dispatches under the new grant.
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'active' }),
  );
  await vi.waitFor(async () =>
    expect(await view.sparql.construct(query)).toEqual({
      kind: 'invalidated',
    }),
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

it('resends a refresh another tab left for a sign-in this tab missed', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  // Tab b sees tab a leave for a new sign-in, then misses its completion.
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  freeze(true);
  t.a.dispose();
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  await back.loadContexts(t.id);
  back.selectContext(t.id, work);
  // That tab closes during its first refresh.
  t.setToken(() => new Promise<Response>(() => {}));
  advance(3600_000);
  void back.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  back.dispose();
  t.setToken(async () =>
    Response.json({
      access_token: mint('resent'),
      token_type: 'Bearer',
      refresh_token: 'refresh-resent',
    }),
  );
  freeze(false);
  pageshow();
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(2));
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'active' }),
  );
  const [first, resent] = t.refreshes();
  expect(t.refreshes()).toHaveLength(2);
  expect(resent?.get('refresh_token')).toBe(first?.get('refresh_token'));
});

it('lists a new connection to a Pod once it followed the forget of the earlier one it missed', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  t.b.dispose();
  // This tab's store holds its reads while `gate` is set.
  let gate: Promise<void> | undefined;
  const b = createBrowserRuntime({
    ...t.options,
    openStore: storeWith(
      t.factory,
      (store) => ({
        async read(id) {
          const stored = await store.read(id);
          if (gate) await gate;
          return stored;
        },
      }),
      channels,
    ),
  });
  runtimes.push(b);
  await b.initialize();
  await restored(b);
  // Tab b misses a forget and a new sign-in to the same Pod.
  freeze(true);
  expect(await t.a.forget(t.id)).toEqual({ kind: 'disconnected' });
  const connection = await t.a.connect(pod);
  expect(connection.id).not.toBe(t.id);
  await t.a.beginAuthorization(connection.id);
  t.a.dispose();
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  const reads = deferred<void>();
  gate = reads.promise;
  freeze(false);
  pageshow();
  await quiet();
  gate = undefined;
  reads.resolve();
  await vi.waitFor(() =>
    expect(b.getSnapshot()).toMatchObject([
      { id: connection.id, session: { kind: 'active' } },
    ]),
  );
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

it('keeps the session under its own client while a re-authorization registers another, also after a denial', async () => {
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
  await quiet();
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({
    interaction: 'cancelled',
    resumed: true,
  });
  await quiet();
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
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

it('reads Context access again in tab b once a re-authorization ends without a new grant', async () => {
  const t = await tabs();
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  t.a.dispose();
  const catalogues = () =>
    t.fetch.mock.calls.filter(([url]) => url.endsWith('/_system/contexts'))
      .length;
  const before = catalogues();
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ resumed: true });
  // Tab b reads its catalogue again; the callback tab reads none.
  await vi.waitFor(() => expect(catalogues()).toBe(before + 1));
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
});

it('reads Context access again in a tab that started while the re-authorization was out', async () => {
  const t = await tabs();
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  t.b.dispose();
  const c = createBrowserRuntime({ ...t.options, tabStorage: memoryStorage() });
  runtimes.push(c);
  await c.initialize();
  await restored(c);
  expect(await c.loadContexts(t.id)).toMatchObject({ kind: 'ok' });
  const catalogues = () =>
    t.fetch.mock.calls.filter(([url]) => url.endsWith('/_system/contexts'))
      .length;
  const before = catalogues();
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ resumed: true });
  await vi.waitFor(() => expect(catalogues()).toBe(before + 1));
  expect(t.session(c)).toMatchObject({ kind: 'active' });
});

it('reads Context access again after a consent round trip a cached page missed', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  freeze(true);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ resumed: true });
  const catalogues = () =>
    t.fetch.mock.calls.filter(([url]) => url.endsWith('/_system/contexts'))
      .length;
  const before = catalogues();
  freeze(false);
  pageshow();
  await vi.waitFor(() => expect(catalogues()).toBe(before + 1));
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
});

it('reads Context access once more after a read under way when consent ends', async () => {
  const t = await tabs();
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  t.a.dispose();
  const held = deferred<Response>();
  let first = true;
  t.setCatalogue(async () => {
    if (!first) return catalogue([], []);
    first = false;
    return held.promise;
  });
  const catalogues = () =>
    t.fetch.mock.calls.filter(([url]) => url.endsWith('/_system/contexts'))
      .length;
  const before = catalogues();
  void t.b.loadContexts(t.id).catch(() => {});
  await vi.waitFor(() => expect(catalogues()).toBe(before + 1));
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  await back.initialize();
  await quiet();
  // The read under way may describe the access from before consent.
  held.resolve(catalogue());
  await vi.waitFor(() => expect(catalogues()).toBe(before + 2));
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]?.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [],
    }),
  );
});

it('stops a sign-in waiting for the refresh lock when the connection is signed out', async () => {
  const t = await tabs();
  const held = deferred<Response>();
  t.setToken(() => held.promise);
  t.setQuery(async () => unauthorized());
  void t.b.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  const navigations = t.navigate.mock.calls.length;
  const begun = t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  expect(await t.a.disconnect(t.id)).toEqual({ kind: 'disconnected' });
  held.resolve(
    Response.json({
      access_token: mint('late'),
      token_type: 'Bearer',
      refresh_token: 'refresh-late',
    }),
  );
  await expect(begun).rejects.toMatchObject({ problem: 'disconnected' });
  expect(t.navigate.mock.calls.length).toBe(navigations);
  expect(await records(t.factory)).toMatchObject([
    { value: { kind: 'disconnected', reason: 'disconnected' } },
  ]);
});

it('stores the attempt beside a renewal whose announcement has not arrived yet', async () => {
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  const held = deferred<Response>();
  t.setToken(() => held.promise);
  t.setQuery(async () => unauthorized());
  void t.b.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  const navigations = t.navigate.mock.calls.length;
  freeze(true);
  const begun = t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  held.resolve(
    Response.json({
      access_token: mint('renewed'),
      token_type: 'Bearer',
      refresh_token: 'refresh-renewed',
    }),
  );
  await begun;
  expect(t.navigate.mock.calls.length).toBe(navigations + 1);
  expect(await records(t.factory)).toMatchObject([
    {
      value: {
        kind: 'ready',
        credentials: { refreshToken: 'refresh-renewed' },
        pending: { kind: 'open' },
      },
    },
  ]);
});

it('keeps a sign-out that could not be saved blocked while another tab renews the grant stored meanwhile', async () => {
  const channels = memoryChannels();
  const t = await tabs(channels);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  const state = new URL(t.navigate.mock.calls.at(-1)![0]).searchParams.get(
    'state',
  );
  t.a.dispose();
  const gate: { held?: ReturnType<typeof deferred<void>>; reached?: boolean } =
    { held: deferred<void>() };
  const c = createBrowserRuntime({
    ...t.options,
    location: () => `${callback}?code=fixture-code&state=${state}`,
    openStore: storeWith(
      t.factory,
      (store) => ({
        async commit(id, revision, value) {
          const v = value as { kind?: string; pending?: unknown };
          if (gate.reached && v.kind === 'disconnected')
            throw new Error('disk full');
          const result = await store.commit(id, revision, value);
          if (gate.held && v.kind === 'ready' && v.pending === undefined) {
            gate.reached = true;
            await gate.held.promise;
          }
          return result;
        },
      }),
      channels,
    ),
  });
  runtimes.push(c);
  const report = c.initialize();
  await vi.waitFor(() => expect(gate.reached).toBe(true));
  const signOut = c.disconnect(t.id);
  const held = gate.held!;
  delete gate.held;
  held.resolve();
  expect(await signOut).toEqual({ kind: 'blocked-locally' });
  expect(await report).toMatchObject({ problem: 'disconnected' });
  // Tab b uses the stored grant and renews it.
  await vi.waitFor(() =>
    expect(t.session(t.b)).toMatchObject({ kind: 'active' }),
  );
  await t.b.loadContexts(t.id);
  t.b.selectContext(t.id, work);
  advance(3600_000);
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(1);
  await quiet();
  expect(t.session(c)).toMatchObject({
    kind: 'ended',
    problem: 'disconnected',
    saved: false,
  });
});

it('sends no spent refresh token when storing the attempt beside an unannounced renewal fails', async () => {
  const { channels, freeze } = freezable();
  const factory = new IDBFactory();
  let failing = false;
  const t = await tabs(channels, {
    factory,
    options: {
      openStore: storeWith(
        factory,
        (store) => ({
          commit: (id, revision, value) =>
            failing && (value as { pending?: unknown }).pending
              ? Promise.reject(new Error('disk full'))
              : store.commit(id, revision, value),
        }),
        channels,
      ),
    },
  });
  const held = deferred<Response>();
  t.setToken(() => held.promise);
  let refused = true;
  t.setQuery(async (_url, init) => {
    t.sent.push(new Headers(init?.headers).get('authorization')!);
    if (refused) {
      refused = false;
      return unauthorized();
    }
    return Response.json([]);
  });
  void t.b.bind(t.id).sparql.construct(query);
  await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
  freeze(true);
  failing = true;
  const begun = t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  held.resolve(
    Response.json({
      access_token: mint('renewed'),
      token_type: 'Bearer',
      refresh_token: 'refresh-renewed',
    }),
  );
  await expect(begun).rejects.toBeDefined();
  failing = false;
  // Tab a's own request after it: refused once, it renews from the record
  // as it is, never with the token tab b spent.
  refused = true;
  await vi.waitFor(() =>
    expect(t.session(t.a)).toMatchObject({ kind: 'active' }),
  );
  await t.a.loadContexts(t.id);
  t.a.selectContext(t.id, work);
  expect(await t.a.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  const tokens = t.refreshes().map((body) => body.get('refresh_token'));
  expect(new Set(tokens).size).toBe(tokens.length);
});

it('reads Context access again after a renewal and a consent round trip a cached page missed', async () => {
  const pageshow = bfcache();
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  freeze(true);
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ resumed: true });
  // That tab renews the session too.
  await back.loadContexts(t.id);
  back.selectContext(t.id, work);
  advance(3600_000);
  expect(await back.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(1);
  // Meanwhile the Pod removed this app's access.
  t.setCatalogue(async () => catalogue([], []));
  freeze(false);
  pageshow();
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]?.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [],
    }),
  );
});

it('reads Context access once more when a second consent ends during that read', async () => {
  const t = await tabs();
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  t.a.dispose();
  const held = deferred<Response>();
  let first = true;
  t.setCatalogue(async () => {
    if (!first) return catalogue([], []);
    first = false;
    return held.promise;
  });
  const catalogues = () =>
    t.fetch.mock.calls.filter(([url]) => url.endsWith('/_system/contexts'))
      .length;
  const before = catalogues();
  const one = t.returned(undefined, 'error=access_denied');
  runtimes.push(one);
  await one.initialize();
  await vi.waitFor(() => expect(catalogues()).toBe(before + 1));
  // A second consent ends while tab b's recheck read is out.
  await one.beginAuthorization(t.id, { intent: 'change-sharing' });
  one.dispose();
  const two = t.returned(undefined, 'error=access_denied');
  runtimes.push(two);
  await two.initialize();
  await quiet();
  expect(catalogues()).toBe(before + 1);
  held.resolve(catalogue());
  await vi.waitFor(() => expect(catalogues()).toBe(before + 2));
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]?.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [],
    }),
  );
});

it('reads Context access again in every tab when a renewal drops an attempt they saw', async () => {
  const t = await tabs();
  // A tab that starts while the attempt is out, and has read its catalogue.
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  t.a.dispose();
  const c = createBrowserRuntime({ ...t.options, tabStorage: memoryStorage() });
  runtimes.push(c);
  await c.initialize();
  await restored(c);
  expect(await c.loadContexts(t.id)).toMatchObject({ kind: 'ok' });
  // The person consented to less, but the callback never came; the attempt
  // expires, and tab b's renewal drops it.
  t.setCatalogue(async () => catalogue([], []));
  advance(3600_000);
  // The read that renews is retired with the Context the Pod removed.
  await t.b.bind(t.id).sparql.construct(query);
  expect(t.refreshes()).toHaveLength(1);
  const [saved] = await records(t.factory);
  expect(saved?.value).not.toHaveProperty('pending');
  for (const runtime of [t.b, c])
    await vi.waitFor(() =>
      expect(
        runtime.getSnapshot().find((x) => x.id === t.id)?.catalogue,
      ).toMatchObject({ kind: 'ready', contexts: [] }),
    );
});

it('keeps the page that left to re-authorize blocked after a sign-out it could not save, while another tab renews', async () => {
  const channels = memoryChannels();
  const factory = new IDBFactory();
  let failing = false;
  const t = await tabs(channels, {
    factory,
    options: {
      openStore: storeWith(
        factory,
        (store) => ({
          commit: (id, revision, value) =>
            failing && (value as { kind?: string }).kind === 'disconnected'
              ? Promise.reject(new Error('disk full'))
              : store.commit(id, revision, value),
        }),
        channels,
      ),
    },
  });
  // Tab a's navigation stays on the page.
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  failing = true;
  expect(await t.a.disconnect(t.id)).toEqual({ kind: 'blocked-locally' });
  failing = false;
  advance(3600_000);
  expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(1);
  await quiet();
  expect(t.session(t.a)).toMatchObject({
    kind: 'ended',
    problem: 'disconnected',
    saved: false,
  });
});

it('reads Context access again when a background tab hears of a renewal and a denial only together', async () => {
  let holding = false;
  const held: (() => void)[] = [];
  const t = await tabs(
    memoryChannels((send) => {
      if (holding) held.push(send);
      else setTimeout(send);
    }),
  );
  holding = true;
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ resumed: true });
  await back.loadContexts(t.id);
  back.selectContext(t.id, work);
  advance(3600_000);
  expect(await back.bind(t.id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(t.refreshes()).toHaveLength(1);
  t.setCatalogue(async () => catalogue([], []));
  holding = false;
  held.splice(0).forEach((send) => send());
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]?.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [],
    }),
  );
});

it('reads Context access again when a page that stayed missed its consent ending', async () => {
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  await t.a.loadContexts(t.id);
  t.a.selectContext(t.id, work);
  // Tab a's navigation stays on the page; it hears nothing meanwhile.
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  freeze(true);
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ resumed: true });
  t.setCatalogue(async () => catalogue([], []));
  expect(t.a.cancelAuthorization(t.id)).toBe(true);
  await vi.waitFor(() =>
    expect(
      t.a.getSnapshot().find((c) => c.id === t.id)?.catalogue,
    ).toMatchObject({ kind: 'ready', contexts: [] }),
  );
});

it('keeps an explicit Context read in flight when a consent elsewhere ends without changing its access', async () => {
  const t = await tabs();
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  await quiet();
  t.a.dispose();
  const held = deferred<Response>();
  t.setResource(() => held.promise);
  const read = t.b.bindContext(t.id, work).subjects.get('urn:item');
  await vi.waitFor(() =>
    expect(
      t.fetch.mock.calls.some(([url]) => url.includes('/_system/resources/')),
    ).toBe(true),
  );
  const catalogues = () =>
    t.fetch.mock.calls.filter(([url]) => url.endsWith('/_system/contexts'))
      .length;
  const before = catalogues();
  const back = t.returned(undefined, 'error=access_denied');
  runtimes.push(back);
  await back.initialize();
  await vi.waitFor(() => expect(catalogues()).toBe(before + 1));
  held.resolve(
    Response.json({ '@id': 'urn:item' }, { headers: { etag: '"v1"' } }),
  );
  expect(await read).toMatchObject({ kind: 'ok' });
});

it('reads Context access again on a return from the back/forward cache, also without a recorded change', async () => {
  const pageshow = bfcache();
  const t = await tabs();
  // The Pod removed this app's access; no record shows it.
  t.setCatalogue(async () => catalogue([], []));
  pageshow();
  await vi.waitFor(() =>
    expect(t.b.getSnapshot()[0]?.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [],
    }),
  );
});

it('does not carry the page’s Context onto a grant that replaced its session while it stayed', async () => {
  const { channels, freeze } = freezable();
  const t = await tabs(channels);
  await t.a.loadContexts(t.id);
  t.a.selectContext(t.id, work);
  // Tab a's navigation did not leave; meanwhile the attempt completes
  // elsewhere for another account, which tab a has not heard of.
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  freeze(true);
  t.setToken(async () =>
    Response.json({
      access_token: jwt({ jti: 'other', sub: 'urn:other' }),
      token_type: 'Bearer',
      refresh_token: 'refresh-other',
    }),
  );
  const back = t.returned();
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  expect(t.a.cancelAuthorization(t.id)).toBe(true);
  await vi.waitFor(() =>
    expect(t.session(t.a)).toEqual({ kind: 'active', subject: 'urn:other' }),
  );
  expect(t.a.getSnapshot().find((c) => c.id === t.id)).toMatchObject({
    selectedContext: null,
    catalogue: { kind: 'unknown' },
  });
});

describe('a re-authorization another tab is away for', () => {
  /** Tab a leaves for a re-authorization and is at the Pod; tab b is closed. */
  async function away(options: Partial<BrowserRuntimeOptions> = {}) {
    const t = await tabs(memoryChannels(), { options });
    t.b.dispose();
    const history = memoryHistory({ route: 'tasks' });
    vi.stubGlobal('history', history);
    await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
    t.a.dispose();
    const start = async () => {
      const runtime = createBrowserRuntime({
        ...t.options,
        tabStorage: memoryStorage(),
      });
      runtimes.push(runtime);
      await runtime.initialize();
      return runtime;
    };
    return { t, history, start };
  }
  it('restores the session at once in any tab that starts meanwhile, leaving the router’s state alone', async () => {
    const { t, history, start } = await away();
    // That tab coming back, a reload, a tab opened from it or another tab.
    const c = await start();
    await restored(c);
    expect(t.session(c)).toMatchObject({ kind: 'active' });
    expect(history.state).toEqual({ route: 'tasks' });
    const [saved] = await records(t.factory);
    expect(saved?.value).toMatchObject({
      kind: 'ready',
      pending: { kind: 'open' },
    });
    // Its callback still completes, and the tab follows.
    const back = t.returned();
    runtimes.push(back);
    expect(await back.initialize()).toMatchObject({
      interaction: 'completed',
    });
    await vi.waitFor(async () => {
      const [after] = await records(t.factory);
      expect(after?.value).not.toHaveProperty('pending');
    });
    await vi.waitFor(() =>
      expect(t.session(c)).toMatchObject({ kind: 'active' }),
    );
  });
  it('keeps the session past the attempt’s expiry; its late callback changes nothing', async () => {
    const { t, start } = await away({ signIn: 'optional' });
    advance(10 * 60_000);
    const c = await start();
    await restored(c);
    expect(t.session(c)).toMatchObject({ kind: 'active' });
    // It renews under its stored binding, which drops the expired attempt.
    await c.loadContexts(t.id);
    c.selectContext(t.id, work);
    const renewals = t.refreshes().length;
    advance(3600_000);
    expect(await c.bind(t.id).sparql.construct(query)).toMatchObject({
      kind: 'ok',
    });
    expect(t.refreshes()).toHaveLength(renewals + 1);
    const [saved] = await records(t.factory);
    expect(saved?.value).toMatchObject({ kind: 'ready' });
    expect(saved?.value).not.toHaveProperty('pending');
    c.dispose();
    const late = t.returned();
    runtimes.push(late);
    expect(await late.initialize()).toMatchObject({
      interaction: 'failed',
      problem: 'attempt',
    });
  });
});

describe('a re-authorization’s callback beside the other tabs (#393)', () => {
  const grant = (init?: RequestInit) =>
    new URLSearchParams(String(init?.body)).get('grant_type');
  /** Tab a has left for the Pod's consent page and closed; tab b stays. */
  async function consenting() {
    const t = await tabs();
    await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
    const authorization = new URL(t.navigate.mock.calls.at(-1)![0]);
    t.a.dispose();
    const codes = () =>
      t.fetch.mock.calls.filter(
        ([url, init]) =>
          url.endsWith('/token') && grant(init) === 'authorization_code',
      ).length;
    const callback = () => {
      const back = t.returned(authorization);
      runtimes.push(back);
      return back;
    };
    const consented = () =>
      Response.json({
        access_token: mint('consented'),
        token_type: 'Bearer',
        refresh_token: 'refresh-consented',
      });
    return { ...t, authorization, codes, callback, consented };
  }

  it('lets tab b write during consent with the session it has, sent once', async () => {
    const t = await consenting();
    const writes: string[] = [];
    t.setResource(async (_url, init) => {
      if (init?.method && init.method !== 'GET')
        writes.push(new Headers(init.headers).get('authorization')!);
      return Response.json(
        { '@id': 'urn:item' },
        { headers: { etag: '"v2"' } },
      );
    });
    const view = t.b.bind(t.id);
    expect(await view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
    const result = await view.subjects.patch(
      'urn:item',
      {},
      { ifMatch: '"v1"' },
    );
    expect(result.kind).not.toBe('refused');
    expect(writes).toEqual([t.sent.at(-1)]);
  });

  it.each(['disconnect', 'forget'] as const)(
    'lets a %s in tab b before the callback stay in effect',
    async (how) => {
      const t = await consenting();
      expect(await t.b[how](t.id)).toEqual({ kind: 'disconnected' });
      const codes = t.codes();
      expect(await t.callback().initialize()).toMatchObject({
        interaction: 'failed',
        problem: 'attempt',
      });
      expect(t.codes()).toBe(codes);
      const saved = await records(t.factory);
      if (how === 'forget') expect(saved).toEqual([]);
      else
        expect(saved).toMatchObject([
          { value: { kind: 'disconnected', reason: 'disconnected' } },
        ]);
    },
  );

  it('lets a sign-out during the code exchange stay in effect, dropping the new grant', async () => {
    const t = await consenting();
    const held = deferred<Response>();
    t.setToken(() => held.promise);
    const codes = t.codes();
    const report = t.callback().initialize();
    await vi.waitFor(() => expect(t.codes()).toBe(codes + 1));
    expect(await t.b.disconnect(t.id)).toEqual({ kind: 'disconnected' });
    held.resolve(t.consented());
    expect(await report).toMatchObject({
      interaction: 'failed',
      problem: 'disconnected',
    });
    expect(await records(t.factory)).toMatchObject([
      { value: { kind: 'disconnected', reason: 'disconnected' } },
    ]);
    await quiet();
    expect(t.session(t.b)).toMatchObject({
      kind: 'signed-out',
      problem: 'disconnected',
    });
  });

  it('waits for a refresh under way, then exchanges the code once; the new grant wins', async () => {
    const t = await consenting();
    const held = deferred<Response>();
    t.setToken(async (_url, init) =>
      grant(init) === 'refresh_token' ? held.promise : t.consented(),
    );
    t.setQuery(async () => unauthorized());
    const read = t.b.bind(t.id).sparql.construct(query);
    await vi.waitFor(() => expect(t.refreshes()).toHaveLength(1));
    const codes = t.codes();
    const report = t.callback().initialize();
    await quiet();
    // Not while tab b's refresh holds the session's record.
    expect(t.codes()).toBe(codes);
    held.resolve(
      Response.json({
        access_token: mint('renewed'),
        token_type: 'Bearer',
        refresh_token: 'refresh-renewed',
      }),
    );
    expect(await report).toMatchObject({ interaction: 'completed' });
    await read;
    expect(t.codes()).toBe(codes + 1);
    expect(t.refreshes()).toHaveLength(1);
    expect(await records(t.factory)).toMatchObject([
      {
        value: {
          kind: 'ready',
          credentials: { refreshToken: 'refresh-consented' },
        },
      },
    ]);
  });

  it('completes on a refresh claim whose tab closed', async () => {
    const t = await consenting();
    t.setToken(async (_url, init) =>
      grant(init) === 'refresh_token'
        ? new Promise<Response>(() => {})
        : t.consented(),
    );
    t.setQuery(async () => unauthorized());
    void t.b.bind(t.id).sparql.construct(query);
    await vi.waitFor(async () =>
      expect((await records(t.factory))[0]?.value).toMatchObject({
        kind: 'claimed',
        operation: 'refresh',
        pending: { kind: 'open' },
      }),
    );
    t.b.dispose();
    expect(await t.callback().initialize()).toMatchObject({
      interaction: 'completed',
    });
    expect(await records(t.factory)).toMatchObject([
      {
        value: {
          kind: 'ready',
          credentials: { refreshToken: 'refresh-consented' },
        },
      },
    ]);
  });

  it('signs in with the callback after tab b’s renewal was refused for good', async () => {
    const t = await consenting();
    t.setToken(async (_url, init) =>
      grant(init) === 'refresh_token'
        ? Response.json({ error: 'invalid_grant' }, { status: 400 })
        : t.consented(),
    );
    t.setQuery(async () => unauthorized());
    await t.b.bind(t.id).sparql.construct(query);
    await vi.waitFor(() =>
      expect(t.session(t.b)).toMatchObject({ kind: 'ended' }),
    );
    // The attempt became the record, as a sign-in under way.
    await vi.waitFor(async () =>
      expect((await records(t.factory))[0]?.value).toMatchObject({
        kind: 'authorizing',
      }),
    );
    t.setQuery(async () => Response.json([]));
    expect(await t.callback().initialize()).toMatchObject({
      interaction: 'completed',
    });
    await vi.waitFor(() =>
      expect(t.session(t.b)).toMatchObject({ kind: 'active' }),
    );
  });

  it('drops a code exchange that does not answer in time; the session stays and renews', async () => {
    const t = await consenting();
    t.setToken(async (_url, init) =>
      grant(init) === 'authorization_code'
        ? new Promise<Response>(() => {})
        : Response.json({
            access_token: mint('renewed'),
            token_type: 'Bearer',
            refresh_token: 'refresh-renewed',
          }),
    );
    const codes = t.codes();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const report = t.callback().initialize();
      await vi.waitFor(() => expect(t.codes()).toBe(codes + 1));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await report).toMatchObject({
        interaction: 'failed',
        problem: 'interrupted',
        resumed: true,
      });
    } finally {
      vi.useRealTimers();
    }
    const [saved] = await records(t.factory);
    expect(saved?.value).toMatchObject({ kind: 'ready' });
    expect(saved?.value).not.toHaveProperty('pending');
    // The lock passed on: tab b renews.
    advance(3600_000);
    expect(await t.b.bind(t.id).sparql.construct(query)).toMatchObject({
      kind: 'ok',
    });
    expect(t.refreshes()).toHaveLength(1);
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

it('keeps the other tab active when the re-authorization ends with another answer', async () => {
  const t = await tabs(memoryChannels(), { options: { signIn: 'optional' } });
  await t.a.beginAuthorization(t.id, { intent: 'change-sharing' });
  t.a.dispose();
  const back = t.returned(undefined, 'error=login_required');
  runtimes.push(back);
  expect(await back.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'login-required',
    resumed: true,
  });
  await quiet();
  expect(t.session(t.b)).toMatchObject({ kind: 'active' });
  expect(t.b.getSnapshot()[0]?.reading).toBe('session');
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
  it('signs in on the first call after another tab closed during the default Pod’s code exchange', async () => {
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
    freeze(true);
    const { authorization } = await f.begin();
    f.runtime.dispose();
    await settleLease();
    // The callback tab closes while it exchanges the code.
    f.setToken(() => new Promise<Response>(() => {}));
    const back = f.returned(authorization);
    runtimes.push(back);
    void back.initialize().catch(() => {});
    await vi.waitFor(async () =>
      expect((await records(factory))[0]?.value).toMatchObject({
        kind: 'claimed',
        operation: 'code',
      }),
    );
    back.dispose();
    const navigations = f.navigate.mock.calls.length;
    await b.beginAuthorization(pod);
    expect(f.navigate.mock.calls).toHaveLength(navigations + 1);
    const saved = await records(factory);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.value).toMatchObject({ kind: 'authorizing' });
  });
  it('signs in on the first call when another tab’s refresh of the default Pod can no longer be resent', async () => {
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
    freeze(true);
    const { runtime: a, view } = await f.login();
    runtimes.push(a);
    // Tab a closes during a refresh; its grace period passes.
    f.setToken(() => new Promise<Response>(() => {}));
    advance(3600_000);
    void view.sparql.construct(query).catch(() => {});
    await vi.waitFor(async () =>
      expect((await records(factory))[0]?.value).toMatchObject({
        kind: 'claimed',
        operation: 'refresh',
      }),
    );
    a.dispose();
    advance(61_000);
    const navigations = f.navigate.mock.calls.length;
    await b.beginAuthorization(pod);
    expect(f.navigate.mock.calls).toHaveLength(navigations + 1);
    // Stored beside that claim, which no tab sends.
    const saved = await records(factory);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.value).toMatchObject({
      kind: 'claimed',
      operation: 'refresh',
      pending: { kind: 'open' },
    });
  });
  it('lets a silent first sign-in follow the one another tab started at the same time', async () => {
    const channels = memoryChannels();
    const factory = new IDBFactory();
    const identity = {
      kind: 'did-web' as const,
      clientId: 'did:web:app.example',
      redirectUri: callback,
    };
    const f = fixture({
      identity,
      preset: { podUrl: pod },
      firstSignIn: 'silent',
      preferences: null,
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ client_id: identity.clientId }),
        token_type: 'Bearer',
        refresh_token: 'one',
      }),
    );
    // Both fresh tabs start before either reaches the Pod.
    const discovery = deferred<void>();
    let discovering = 0;
    const held: typeof f.fetch = vi.fn(async (url, init) => {
      if (url.endsWith('/.well-known/oauth-protected-resource')) {
        discovering++;
        await discovery.promise;
      }
      return f.fetch(url, init);
    });
    const open = () => {
      const runtime = createBrowserRuntime({
        ...f.options,
        fetch: held,
        tabStorage: memoryStorage(),
      });
      runtimes.push(runtime);
      return runtime;
    };
    const tabsStarted = [open(), open()];
    const started = Promise.all(tabsStarted.map((r) => r.initialize()));
    await vi.waitFor(() => expect(discovering).toBeGreaterThanOrEqual(2));
    discovery.resolve();
    await started;
    const silentAttempts = f.navigate.mock.calls.filter(
      ([url]) => new URL(url).searchParams.get('prompt') === 'none',
    );
    expect(silentAttempts).toHaveLength(1);
    const left = tabsStarted.find(
      (r) => r.getSnapshot()[0]?.session.kind === 'leaving',
    )!;
    const other = tabsStarted.find((r) => r !== left)!;
    left.dispose();
    await settleLease();
    const back = f.returned();
    runtimes.push(back);
    expect(await back.initialize()).toMatchObject({
      interaction: 'completed',
    });
    await vi.waitFor(() =>
      expect(other.getSnapshot()).toMatchObject([
        { session: { kind: 'active' } },
      ]),
    );
  });
  it.each(['preparing', 'exchanging its code'])(
    'lets a silent first sign-in that reaches the Pod later follow the one another tab is %s',
    async (phase) => {
      const channels = memoryChannels();
      const factory = new IDBFactory();
      const identity = {
        kind: 'did-web' as const,
        clientId: 'did:web:app.example',
        redirectUri: callback,
      };
      const f = fixture({
        identity,
        preset: { podUrl: pod },
        firstSignIn: 'silent',
        preferences: null,
        locks: memoryLocks(),
        openStore: (namespace) =>
          openSessionStore(namespace, factory, channels),
      });
      const exchange = deferred<Response>();
      f.setToken(() => exchange.promise);
      // Tab b starts first, with nothing stored, and reaches the Pod late.
      const discovery = deferred<void>();
      let discovering = false;
      const slow: typeof f.fetch = vi.fn(async (url, init) => {
        if (url.endsWith('/.well-known/oauth-protected-resource')) {
          discovering = true;
          await discovery.promise;
        }
        return f.fetch(url, init);
      });
      const open = (fetch: typeof f.fetch) => {
        const runtime = createBrowserRuntime({
          ...f.options,
          fetch,
          tabStorage: memoryStorage(),
        });
        runtimes.push(runtime);
        return runtime;
      };
      const b = open(slow);
      const bStarted = b.initialize();
      await vi.waitFor(() => expect(discovering).toBe(true));
      const a = open(f.fetch);
      await a.initialize();
      const silentAttempts = () =>
        f.navigate.mock.calls.filter(
          ([url]) => new URL(url).searchParams.get('prompt') === 'none',
        );
      expect(silentAttempts()).toHaveLength(1);
      a.dispose();
      await settleLease();
      const back = f.returned();
      runtimes.push(back);
      let returned: ReturnType<typeof back.initialize> | undefined;
      if (phase === 'exchanging its code') {
        returned = back.initialize();
        // Its code is claimed before the token request is sent.
        await vi.waitFor(() =>
          expect(
            f.fetch.mock.calls.some(([url]) => url.endsWith('/token')),
          ).toBe(true),
        );
      }
      // Tab b lists that sign-in (a silent one under way shows signed
      // out), then reaches the Pod.
      await vi.waitFor(() =>
        expect(b.getSnapshot()).toMatchObject([
          {
            session:
              phase === 'preparing'
                ? { kind: 'signed-out' }
                : { kind: 'ended', problem: 'interrupted' },
          },
        ]),
      );
      discovery.resolve();
      await bStarted;
      expect(silentAttempts()).toHaveLength(1);
      exchange.resolve(
        Response.json({
          access_token: jwt({ client_id: identity.clientId }),
          token_type: 'Bearer',
          refresh_token: 'one',
        }),
      );
      expect(await (returned ?? back.initialize())).toMatchObject({
        interaction: 'completed',
      });
      const exchanges = f.fetch.mock.calls.filter(
        ([url, init]) =>
          url.endsWith('/token') &&
          new URLSearchParams(String(init?.body)).get('grant_type') ===
            'authorization_code',
      );
      expect(exchanges).toHaveLength(1);
      await vi.waitFor(() =>
        expect(b.getSnapshot()).toMatchObject([
          { session: { kind: 'active' } },
        ]),
      );
    },
  );
  it('lists the session another tab saved for a Pod while a sign-in here failed to prepare', async () => {
    const channels = memoryChannels();
    const factory = new IDBFactory();
    const f = fixture({
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    runtimes.push(f.runtime);
    // This tab's discovery waits, then fails.
    const discovery = deferred<void>();
    let discovering = false;
    let hold = false;
    const failing: typeof f.fetch = vi.fn(async (url, init) => {
      if (hold && url.endsWith('/.well-known/oauth-protected-resource')) {
        discovering = true;
        await discovery.promise;
        throw new TypeError('offline');
      }
      return f.fetch(url, init);
    });
    const b = createBrowserRuntime({ ...f.options, fetch: failing });
    runtimes.push(b);
    await b.initialize();
    const local = await b.connect(pod);
    hold = true;
    const preparing = b.beginAuthorization(local.id);
    await vi.waitFor(() => expect(discovering).toBe(true));
    // Meanwhile another tab signs in to that Pod.
    const { runtime: a, id } = await f.login();
    runtimes.push(a);
    expect(id).not.toBe(local.id);
    await quiet();
    discovery.resolve();
    await expect(preparing).rejects.toBeDefined();
    hold = false;
    await vi.waitFor(() =>
      expect(b.getSnapshot()).toMatchObject([
        { id, session: { kind: 'active' } },
      ]),
    );
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
