import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import { openSessionStore } from '../sessions/store.js';
import { IDBFactory } from 'fake-indexeddb';
import {
  callback,
  fixture,
  heldDiscovery,
  jwt,
  memoryChannels,
  memoryStorage,
  pod,
  restart,
  settleLease,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  vi.unstubAllGlobals();
});
const keep = (runtime: BrowserRuntime) => void runtimes.push(runtime);

const identity = {
  kind: 'did-web' as const,
  clientId: 'did:web:app.example',
  redirectUri: callback,
};
/** The saved records of the `did:web` app on `factory`. */
async function savedRecords(factory: IDBFactory) {
  const store = await openSessionStore(
    JSON.stringify(['did-web', identity.clientId]),
    factory,
  );
  try {
    return (await store.list()).records;
  } finally {
    store.close();
  }
}
/**
 * A deployed `did:web` app in front of one Pod that signs in silently, with
 * this tab's storage.
 */
function silent(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const tab = memoryStorage();
  const f = fixture({
    identity,
    preset: { podUrl: pod },
    firstSignIn: 'silent',
    tabStorage: tab,
    preferences: null,
    ...overrides,
  });
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ client_id: identity.clientId }),
      token_type: 'Bearer',
      refresh_token: 'one',
    }),
  );
  keep(f.runtime);
  return { ...f, tab };
}
/** The runtime the Pod's answer to the silent attempt opens, in the same tab. */
async function answered(f: ReturnType<typeof silent>, answer: string) {
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned(undefined, answer);
  keep(runtime);
  return runtime;
}
const silentAttempts = (f: ReturnType<typeof silent>) =>
  f.navigate.mock.calls.filter(
    ([url]) => new URL(url).searchParams.get('prompt') === 'none',
  ).length;

it('signs in without a click when the Pod has a session', async () => {
  const f = silent();
  expect(await f.runtime.initialize()).toMatchObject({ interaction: 'none' });
  // Startup asks the Pod once, with prompt=none, before it resolves.
  expect(f.navigate).toHaveBeenCalledTimes(1);
  const authorization = new URL(f.navigate.mock.calls[0]![0]);
  expect(authorization.searchParams.getAll('prompt')).toEqual(['none']);
  const [connection] = f.runtime.getSnapshot();
  expect(connection).toMatchObject({
    podUrl: pod,
    session: { kind: 'leaving' },
  });
  const runtime = await answered(f, 'code=fixture-code');
  const report = await runtime.initialize();
  expect(report).toMatchObject({
    interaction: 'completed',
    connectionId: connection!.id,
  });
  expect(report).not.toHaveProperty('firstSignIn');
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.tab.map.size).toBe(1);
  expect([...f.tab.map.values()]).toEqual(['tried']);
});

it.each([
  [
    'with',
    '&error_uri=https%3A%2F%2Fpod.example%2Flogin',
    'https://pod.example/login',
  ],
  ['without', '', undefined],
] as const)(
  'ends signed out on login_required %s error_uri, remembers nothing and does not try again in this tab',
  async (_, link, providerLink) => {
    const f = silent();
    await f.runtime.initialize();
    const id = f.runtime.getSnapshot()[0]!.id;
    const runtime = await answered(
      f,
      `error=login_required&error_description=Visit+evil.example${link}`,
    );
    const report = await runtime.initialize();
    expect(report).toEqual({
      interaction: 'none',
      storage: 'durable',
      unreadable: [],
      firstSignIn: {
        connectionId: id,
        problem: 'login-required',
        ...(providerLink ? { providerLink } : {}),
      },
    });
    // Signed out as a Pod never signed in to: no failure, no reason.
    expect(runtime.getSnapshot()).toEqual([
      expect.objectContaining({
        id,
        podUrl: pod,
        reading: null,
        session: { kind: 'signed-out' },
      }),
    ]);
    expect(JSON.stringify(report)).not.toContain('evil');
    expect(f.replaceUrl).toHaveBeenLastCalledWith('/');
    // Nothing is remembered on this device.
    await vi.waitFor(async () =>
      expect(await savedRecords(f.factory)).toEqual([]),
    );
    // A reload of this tab asks the Pod no more.
    const reloaded = await restart(f, runtime, keep);
    expect(silentAttempts(f)).toBe(1);
    expect(reloaded.getSnapshot()).toEqual([]);
    // Signing in is one click, without prompt=none.
    const c = await reloaded.connect();
    await reloaded.beginAuthorization(c.id);
    expect(
      new URL(f.navigate.mock.calls.at(-1)![0]).searchParams.has('prompt'),
    ).toBe(false);
  },
);

it.each(['consent_required', 'interaction_required'] as const)(
  'treats %s as signed out too',
  async (code) => {
    const f = silent();
    await f.runtime.initialize();
    const runtime = await answered(f, `error=${code}`);
    expect(await runtime.initialize()).toMatchObject({
      interaction: 'none',
      firstSignIn: { problem: code.replace('_', '-') },
    });
    expect(runtime.getSnapshot()[0]?.session).toEqual({ kind: 'signed-out' });
  },
);

it('fails as a sign-in on any other answer', async () => {
  const f = silent();
  await f.runtime.initialize();
  const runtime = await answered(f, 'error=server_error');
  const report = await runtime.initialize();
  expect(report).toMatchObject({
    interaction: 'failed',
    problem: 'provider-unavailable',
  });
  expect(report).not.toHaveProperty('firstSignIn');
  expect(runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'provider-unavailable',
  });
});

it('does not try again after coming back without an answer; the attempt stays signed out until it expires', async () => {
  const f = silent();
  await f.runtime.initialize();
  expect(await savedRecords(f.factory)).toMatchObject([
    { value: { kind: 'authorizing', silent: true } },
  ]);
  // Back navigation from the Pod, or a reload: no callback.
  const reloaded = await restart(f, f.runtime, keep);
  expect(silentAttempts(f)).toBe(1);
  expect(reloaded.getSnapshot()).toMatchObject([
    { podUrl: pod, session: { kind: 'signed-out' } },
  ]);
  expect(await savedRecords(f.factory)).toHaveLength(1);
  expect([...f.tab.map.values()]).toEqual(['tried']);
  // Once it expired, the next start deletes it; this tab still never tries
  // again.
  const later = Date.now() + 11 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  const expired = await restart(f, reloaded, keep);
  expect(expired.getSnapshot()).toEqual([]);
  expect(await savedRecords(f.factory)).toEqual([]);
  expect(silentAttempts(f)).toBe(1);
  // A new tab with nothing stored tries again.
  expired.dispose();
  await settleLease();
  const fresh = createBrowserRuntime({
    ...f.options,
    tabStorage: memoryStorage(),
  });
  keep(fresh);
  await fresh.initialize();
  expect(silentAttempts(f)).toBe(2);
  vi.restoreAllMocks();
});

it('shows the attempt signed out in a tab opened from the one at the Pod, and lets its answer complete', async () => {
  // A store the app's tabs share (with `watch`).
  const factory = new IDBFactory();
  const channel = () => ({
    postMessage() {},
    addEventListener() {},
    close() {},
  });
  const f = silent({
    openStore: (namespace) => openSessionStore(namespace, factory, channel),
  });
  await f.runtime.initialize();
  // The opened tab copies the tab storage, note included.
  const copy = memoryStorage();
  f.tab.map.forEach((value, key) => copy.setItem(key, value));
  const opened = createBrowserRuntime({
    ...f.options,
    tabStorage: copy,
    location: () => 'https://app.example/',
  });
  keep(opened);
  await opened.initialize();
  expect(opened.getSnapshot()).toMatchObject([
    { session: { kind: 'signed-out' } },
  ]);
  expect(silentAttempts(f)).toBe(1);
  expect(await savedRecords(factory)).toMatchObject([
    { value: { kind: 'authorizing', silent: true } },
  ]);
  opened.dispose();
  const back = await answered(f, 'code=fixture-code');
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
});

it('lets a click replace the silent attempt at once', async () => {
  const f = silent();
  await f.runtime.initialize();
  const reloaded = await restart(f, f.runtime, keep);
  const [connection] = reloaded.getSnapshot();
  await reloaded.beginAuthorization(connection!.id);
  const [saved] = await savedRecords(f.factory);
  const value = saved?.value;
  expect(value).toMatchObject({ kind: 'authorizing' });
  expect(value).not.toHaveProperty('silent');
  expect(
    new URL(f.navigate.mock.calls.at(-1)![0]).searchParams.has('prompt'),
  ).toBe(false);
});

it('ends signed out when the page stays instead, keeping the attempt for its answer', async () => {
  const f = silent();
  await f.runtime.initialize();
  const [connection] = f.runtime.getSnapshot();
  expect(connection?.session.kind).toBe('leaving');
  expect(f.runtime.cancelAuthorization(connection!.id)).toBe(true);
  expect(f.runtime.getSnapshot()).toEqual([
    expect.objectContaining({
      id: connection!.id,
      session: { kind: 'signed-out' },
    }),
  ]);
  await settleLease();
  expect(f.runtime.getSnapshot()).toMatchObject([
    { id: connection!.id, session: { kind: 'signed-out' } },
  ]);
  expect(await savedRecords(f.factory)).toHaveLength(1);
  expect([...f.tab.map.values()]).toEqual(['tried']);
});

it('ends signed out when the page returns from the back/forward cache, keeping the attempt', async () => {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  try {
    const f = silent();
    await f.runtime.initialize();
    const [connection] = f.runtime.getSnapshot();
    const kinds: string[] = [];
    f.runtime.subscribe(() =>
      kinds.push(f.runtime.getSnapshot()[0]?.session.kind ?? 'none'),
    );
    page.dispatchEvent(
      Object.assign(new Event('pageshow'), { persisted: true }),
    );
    // Straight to signed out: no restoring, no error on the way.
    expect(kinds).toEqual(['signed-out']);
    expect(f.runtime.getSnapshot()).toEqual([
      expect.objectContaining({
        id: connection!.id,
        session: { kind: 'signed-out' },
      }),
    ]);
    await settleLease();
    expect(new Set(kinds)).toEqual(new Set(['signed-out']));
    expect(await savedRecords(f.factory)).toHaveLength(1);
    expect([...f.tab.map.values()]).toEqual(['tried']);
    expect(silentAttempts(f)).toBe(1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  ['another state', () => 'error=login_required&state=forged', 'attempt'],
  [
    'both a code and an error',
    (state: string) => `code=x&error=login_required&state=${state}`,
    'callback',
  ],
] as const)(
  'keeps the attempt silent across a callback with %s, refused before its claim',
  async (_, query, problem) => {
    const f = silent();
    await f.runtime.initialize();
    const id = f.runtime.getSnapshot()[0]!.id;
    const state = new URL(f.navigate.mock.calls[0]![0]).searchParams.get(
      'state',
    )!;
    f.runtime.dispose();
    await settleLease();
    const forged = createBrowserRuntime({
      ...f.options,
      location: () => `${callback}?${query(state)}`,
    });
    keep(forged);
    expect(await forged.initialize()).toMatchObject({
      interaction: 'failed',
      problem,
    });
    const runtime = await answered(
      { ...f, runtime: forged },
      'error=login_required',
    );
    expect(await runtime.initialize()).toMatchObject({
      interaction: 'none',
      firstSignIn: { connectionId: id, problem: 'login-required' },
    });
    expect(runtime.getSnapshot()[0]?.session).toEqual({ kind: 'signed-out' });
    expect([...f.tab.map.values()]).toEqual(['tried']);
  },
);

it.each([true, false])(
  'never signs in silently after a sign-out in a tab that restored a session (rememberPods: %s)',
  async (rememberPods) => {
    const plain = silent({ firstSignIn: 'click', rememberPods });
    const { connection } = await plain.begin();
    plain.runtime.dispose();
    await settleLease();
    const back = plain.returned();
    keep(back);
    await back.initialize();
    // A fresh tab restores the existing session, then signs out.
    const tab = memoryStorage();
    const restored = await restart(plain, back, keep, {
      firstSignIn: 'silent',
      tabStorage: tab,
    });
    expect(restored.getSnapshot()[0]?.session.kind).toBe('active');
    await restored.disconnect(connection.id);
    expect(await savedRecords(plain.factory)).toHaveLength(
      rememberPods ? 1 : 0,
    );
    await restart(plain, restored, keep, {
      firstSignIn: 'silent',
      tabStorage: tab,
    });
    expect(
      plain.navigate.mock.calls.filter(
        ([url]) => new URL(url).searchParams.get('prompt') === 'none',
      ),
    ).toEqual([]);
  },
);

it('tries again in a new tab: signing out of the app is not signing out of the Pod', async () => {
  const f = silent({ rememberPods: false });
  await f.runtime.initialize();
  const runtime = await answered(f, 'error=login_required');
  await runtime.initialize();
  runtime.dispose();
  await settleLease();
  const tab = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
    tabStorage: memoryStorage(),
  });
  keep(tab);
  await tab.initialize();
  expect(silentAttempts(f)).toBe(2);
});

it('never asks silently when anything is stored, or without a tab memory', async () => {
  // A remembered Pod (signed out) is stored: a sign-out is not undone.
  const plain = silent({ firstSignIn: 'click' });
  const { connection } = await plain.begin();
  plain.runtime.dispose();
  await settleLease();
  const back = plain.returned();
  keep(back);
  await back.initialize();
  await back.disconnect(connection.id);
  const remembered = await restart(plain, back, keep, {
    firstSignIn: 'silent',
    tabStorage: memoryStorage(),
  });
  expect(remembered.getSnapshot()[0]?.session).toEqual({
    kind: 'signed-out',
    problem: 'disconnected',
  });
  expect(
    plain.navigate.mock.calls.filter(
      ([url]) => new URL(url).searchParams.get('prompt') === 'none',
    ),
  ).toEqual([]);
  // A record of a Pod that a changed `allowedPods` now excludes is still
  // stored: the installation is not new.
  const other = 'https://pod.example/bob';
  const excluded = await restart(plain, remembered, keep, {
    firstSignIn: 'silent',
    tabStorage: memoryStorage(),
    preset: { podUrl: other },
    allowedPods: [other],
  });
  expect(excluded.getSnapshot()).toEqual([]);
  expect(await savedRecords(plain.factory)).toHaveLength(1);
  expect(
    plain.navigate.mock.calls.filter(
      ([url]) => new URL(url).searchParams.get('prompt') === 'none',
    ),
  ).toEqual([]);
  // Without a tab memory nothing could stop a loop.
  for (const tabStorage of [
    null,
    {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    },
    {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {},
      removeItem: () => {},
    },
  ]) {
    const g = silent({ tabStorage });
    expect(await g.runtime.initialize()).toMatchObject({
      interaction: 'none',
    });
    expect(g.navigate).not.toHaveBeenCalled();
  }
});

it('stays signed out without an error when the Pod cannot be reached', async () => {
  const f = silent();
  f.fetch.mockImplementation(async () => {
    throw new TypeError('offline');
  });
  expect(await f.runtime.initialize()).toEqual({
    interaction: 'none',
    storage: 'durable',
    unreadable: [],
  });
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.runtime.getSnapshot()).toEqual([]);
  expect([...f.tab.map.values()]).toEqual(['tried']);
});

it('keeps reading the default Pod without a token when the Pod needs the person', async () => {
  const f = silent({ signIn: 'optional' });
  await f.runtime.initialize();
  expect(silentAttempts(f)).toBe(1);
  const runtime = await answered(f, 'error=login_required');
  const report = await runtime.initialize();
  // The default Pod's stable connection, as without the silent attempt.
  expect(report.firstSignIn?.connectionId).toBe(pod);
  expect(runtime.getSnapshot()).toEqual([
    expect.objectContaining({
      id: pod,
      reading: 'anonymous',
      session: { kind: 'signed-out' },
    }),
  ]);
});

it('still asks silently beside a Pod added without a sign-in (#372)', async () => {
  const f = silent({ signIn: 'optional', firstSignIn: 'click' });
  await f.runtime.initialize();
  await f.runtime.connect('https://pod.example/bob');
  expect(await savedRecords(f.factory)).toMatchObject([
    { value: { kind: 'address' } },
  ]);
  f.runtime.dispose();
  await settleLease();
  const tab = createBrowserRuntime({
    ...f.options,
    firstSignIn: 'silent',
    tabStorage: memoryStorage(),
  });
  keep(tab);
  await tab.initialize();
  expect(silentAttempts(f)).toBe(1);
});

it('keeps the saved address of its own default Pod: no silent attempt that could delete it (#372)', async () => {
  const bob = 'https://pod.example/bob';
  const f = silent({ signIn: 'optional', firstSignIn: 'click' });
  await f.runtime.initialize();
  const added = await f.runtime.connect(bob);
  f.runtime.dispose();
  await settleLease();
  // The same app, now with Bob's Pod as its default one.
  const tab = createBrowserRuntime({
    ...f.options,
    preset: { podUrl: bob },
    firstSignIn: 'silent',
    tabStorage: memoryStorage(),
  });
  keep(tab);
  expect(await tab.initialize()).toMatchObject({ interaction: 'none' });
  expect(silentAttempts(f)).toBe(0);
  expect(tab.getSnapshot()).toMatchObject([
    { id: added.id, podUrl: bob, reading: 'anonymous' },
  ]);
  expect(await savedRecords(f.factory)).toMatchObject([
    { id: added.id, value: { kind: 'address', podUrl: bob } },
  ]);
});

it('leaves the address another tab saves while the silent sign-in discovers that Pod (#372)', async () => {
  const bob = 'https://pod.example/bob';
  const factory = new IDBFactory();
  const channels = memoryChannels();
  const f = silent({
    signIn: 'optional',
    firstSignIn: 'click',
    openStore: (namespace) => openSessionStore(namespace, factory, channels),
  });
  await f.runtime.initialize();
  // Another tab with Bob's Pod as its default one finds nothing stored and
  // asks it silently; its discovery waits.
  const held = heldDiscovery(f.fetch, bob);
  const tab = createBrowserRuntime({
    ...f.options,
    preset: { podUrl: bob },
    firstSignIn: 'silent',
    tabStorage: memoryStorage(),
    fetch: held.fetch,
  });
  keep(tab);
  const started = tab.initialize();
  await vi.waitFor(() => expect(held.discovering()).toBe(true));
  // Meanwhile the first tab adds Bob's Pod and saves its address.
  const added = await f.runtime.connect(bob);
  held.release();
  await started;
  expect(silentAttempts(f)).toBe(0);
  expect(await savedRecords(factory)).toMatchObject([
    { id: added.id, value: { kind: 'address', podUrl: bob } },
  ]);
  await vi.waitFor(() =>
    expect(tab.getSnapshot()).toMatchObject([
      { id: added.id, podUrl: bob, reading: 'anonymous' },
    ]),
  );
});

it('rejects silent without a default Pod or a did:web identity, before any I/O', () => {
  for (const options of [
    { identity, firstSignIn: 'silent' },
    // A Pod never grants a dynamically registered client silently.
    {
      identity: { kind: 'dynamic', name: 'Test', redirectUri: callback },
      preset: { podUrl: pod },
      firstSignIn: 'silent',
    },
    {
      identity,
      firstSignIn: 'silent',
      allowedPods: [pod, 'https://pod.example/bob'],
    },
    { signIn: 'none', preset: { podUrl: pod }, firstSignIn: 'silent' },
    { identity, preset: { podUrl: pod }, firstSignIn: 'loud' },
  ] as BrowserRuntimeOptions[])
    expect(() => createBrowserRuntime(options)).toThrow(
      expect.objectContaining({ problem: 'configuration' }),
    );
  // A single allowed Pod is the default Pod.
  keep(
    createBrowserRuntime({
      identity,
      allowedPods: [pod],
      firstSignIn: 'silent',
    }),
  );
});

it('recognizes the answer to a silent sign-in an SDK 0.9 tab started', async () => {
  const f = silent();
  await f.runtime.initialize();
  const state = new URL(f.navigate.mock.calls.at(-1)![0]).searchParams.get(
    'state',
  )!;
  f.runtime.dispose();
  await settleLease();
  // 0.9 stored an ordinary attempt and noted its state in the tab.
  const store = await openSessionStore(
    JSON.stringify(['did-web', identity.clientId]),
    f.factory,
  );
  const [saved] = (await store.list()).records;
  const { silent: _silent, ...older } = saved!.value as Record<string, unknown>;
  void _silent;
  await store.commit(saved!.id, saved!.revision, older);
  store.close();
  f.tab.setItem([...f.tab.map.keys()][0]!, `attempt:${state}`);
  const back = await answered(f, 'error=login_required');
  expect(await back.initialize()).toMatchObject({
    interaction: 'none',
    firstSignIn: { problem: 'login-required' },
  });
  await vi.waitFor(async () =>
    expect(await savedRecords(f.factory)).toEqual([]),
  );
});

it('leaves an expired silent attempt of a Pod outside allowedPods alone', async () => {
  const f = silent();
  await f.runtime.initialize();
  expect(await savedRecords(f.factory)).toHaveLength(1);
  f.runtime.dispose();
  await settleLease();
  const later = Date.now() + 11 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  // The app now allows only another Pod.
  const other = 'https://pod.example/bob';
  const next = createBrowserRuntime({
    ...f.options,
    preset: { podUrl: other },
    allowedPods: [other],
    tabStorage: memoryStorage(),
  });
  keep(next);
  await next.initialize();
  expect(await savedRecords(f.factory)).toHaveLength(1);
  // An existing installation: no silent sign-in to the other Pod.
  expect(silentAttempts(f)).toBe(1);
  vi.restoreAllMocks();
});
