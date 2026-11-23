import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import { openSessionStore } from '../sessions/store.js';
import { IDBFactory } from 'fake-indexeddb';
import {
  callback,
  fixture,
  jwt,
  memoryHistory,
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

it('does not try again after coming back without an answer, and forgets the attempt', async () => {
  const f = silent();
  await f.runtime.initialize();
  expect(await savedRecords(f.factory)).toHaveLength(1);
  // Back navigation from the Pod: no callback.
  const reloaded = await restart(f, f.runtime, keep);
  expect(silentAttempts(f)).toBe(1);
  expect(reloaded.getSnapshot()).toEqual([]);
  expect(await savedRecords(f.factory)).toEqual([]);
  expect([...f.tab.map.values()]).toEqual(['tried']);
});

it('forgets the attempt when the page that left comes back to its history entry', async () => {
  const history = memoryHistory();
  vi.stubGlobal('history', history);
  const f = silent();
  await f.runtime.initialize();
  // Back navigation, also to a page the back/forward cache restores and the
  // app starts a runtime on again: the same history entry.
  const reloaded = await restart(f, f.runtime, keep);
  expect(reloaded.getSnapshot()).toEqual([]);
  expect(await savedRecords(f.factory)).toEqual([]);
  expect(silentAttempts(f)).toBe(1);
});

it('leaves the attempt to the tab at the Pod in a tab opened from it', async () => {
  // A store the app's tabs share (with `watch`).
  const factory = new IDBFactory();
  const channel = () => ({
    postMessage() {},
    addEventListener() {},
    close() {},
  });
  vi.stubGlobal('history', memoryHistory());
  const f = silent({
    openStore: (namespace) => openSessionStore(namespace, factory, channel),
  });
  await f.runtime.initialize();
  // The opened tab copies the tab storage, note included, but not the
  // history entry that left.
  const copy = memoryStorage();
  f.tab.map.forEach((value, key) => copy.setItem(key, value));
  vi.stubGlobal('history', memoryHistory());
  const opened = createBrowserRuntime({
    ...f.options,
    tabStorage: copy,
    location: () => 'https://app.example/',
  });
  keep(opened);
  await opened.initialize();
  expect(opened.getSnapshot()).toMatchObject([
    { session: { kind: 'ended', problem: 'interrupted' } },
  ]);
  expect(silentAttempts(f)).toBe(1);
  expect(await savedRecords(factory)).toMatchObject([
    { value: { kind: 'authorizing' } },
  ]);
  const back = await answered(f, 'code=fixture-code');
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
});

it('ends signed out, as if never started, when the page stays instead', async () => {
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
  await vi.waitFor(async () =>
    expect(await savedRecords(f.factory)).toEqual([]),
  );
  expect([...f.tab.map.values()]).toEqual(['tried']);
});

it('ends signed out, as if never started, when the page returns from the back/forward cache', async () => {
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
    await vi.waitFor(async () =>
      expect(await savedRecords(f.factory)).toEqual([]),
    );
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
