/**
 * Remembered Pods (#237): a Pod address outlives its session. Sign-out and a
 * session that ends keep only the address and why it ended; the next start
 * lists the connection as `signed-out`, and signing in again is one action.
 * `forget(id)` and `rememberPods: false` delete the record.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import { openSessionStore } from '../sessions/store.js';
import {
  fixture,
  jwt,
  pod,
  renewal,
  restored,
  settleLease,
  signInAgain,
  twoPods,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));
const keep = (runtime: BrowserRuntime) => {
  runtimes.push(runtime);
  return runtime;
};
const namespace = JSON.stringify([
  'dynamic',
  'https://app.example/oauth/callback',
]);

async function logged(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({ preferences: null, ...overrides });
  keep(f.runtime);
  const login = await f.login();
  keep(login.runtime);
  return { ...f, ...login };
}
/** A fresh start without a callback, as after a reload. */
async function reload(
  f: ReturnType<typeof fixture>,
  current: BrowserRuntime,
  overrides: Partial<BrowserRuntimeOptions> = {},
) {
  current.dispose();
  await settleLease();
  const next = keep(
    createBrowserRuntime({
      ...f.options,
      location: () => 'https://app.example/',
      ...overrides,
    }),
  );
  await next.initialize();
  await restored(next);
  return next;
}
async function records(f: ReturnType<typeof fixture>) {
  const store = await openSessionStore(namespace, f.factory);
  try {
    return (await store.list()).records;
  } finally {
    store.close();
  }
}
async function stored(f: ReturnType<typeof fixture>, id: string) {
  return (await records(f)).find((r) => r.id === id)?.value as
    Record<string, unknown> | undefined;
}

it('lists a signed-out Pod after a reload with its address and signs in again in one action', async () => {
  const f = await logged();
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
  const signedOut = { kind: 'signed-out', problem: 'disconnected' };
  expect(f.runtime.getSnapshot()).toMatchObject([
    { id: f.id, podUrl: pod, session: signedOut },
  ]);
  const record = await stored(f, f.id);
  expect(record).toMatchObject({
    kind: 'disconnected',
    reason: 'disconnected',
  });
  // Only the address (binding) and the reason stay: no token, no verifier.
  expect(Object.keys(record!).sort()).toEqual(
    ['binding', 'kind', 'reason', 'version'].sort(),
  );
  expect(JSON.stringify(record)).not.toMatch(
    /accessToken|refreshToken|verifier|credentials/,
  );

  const next = await reload(f, f.runtime);
  expect(next.getSnapshot()).toMatchObject([
    {
      id: f.id,
      podUrl: pod,
      session: signedOut,
      catalogue: { kind: 'unknown' },
      selectedContext: null,
      grantedScopes: [],
    },
  ]);
  expect(() => next.bindPod(f.id)).toThrow();
  expect(f.count('/token')).toBe(1);

  const again = await signInAgain(f, next, f.id, keep);
  expect(again.getSnapshot()).toMatchObject([
    { id: f.id, podUrl: pod, session: { kind: 'active' } },
  ]);
  expect(f.count('/token')).toBe(2);
});

it('lists a Pod whose session ended with why it ended', async () => {
  const f = await logged();
  await renewal(f, f.runtime, f.id, 'refused');
  const ended = f.runtime.getSnapshot()[0]!.session;
  expect(ended.kind).toBe('ended');
  const problem = ended.kind === 'ended' ? ended.problem : undefined;
  await vi.waitFor(async () =>
    expect(await stored(f, f.id)).toMatchObject({
      kind: 'disconnected',
      reason: problem,
    }),
  );
  const next = await reload(f, f.runtime);
  expect(next.getSnapshot()).toMatchObject([
    { id: f.id, podUrl: pod, session: { kind: 'signed-out', problem } },
  ]);
});

it('forgets a remembered Pod: the record and the connection are gone', async () => {
  const f = await logged();
  await f.runtime.disconnect(f.id);
  const next = await reload(f, f.runtime);
  expect(await next.forget(f.id)).toEqual({ kind: 'disconnected' });
  expect(next.getSnapshot()).toEqual([]);
  expect(await records(f)).toEqual([]);
  expect((await reload(f, next)).getSnapshot()).toEqual([]);
});

it('forgets a signed-in Pod at once, also during a pending sign-out', async () => {
  const f = await logged();
  expect(await f.runtime.forget(f.id)).toEqual({ kind: 'disconnected' });
  expect(f.runtime.getSnapshot()).toEqual([]);
  expect(await records(f)).toEqual([]);
  expect(await f.view.subjects.get('urn:item')).toEqual({
    kind: 'invalidated',
  });

  const g = await logged();
  const signOut = g.runtime.disconnect(g.id);
  const forgetting = g.runtime.forget(g.id);
  expect(await signOut).toEqual({ kind: 'disconnected' });
  expect(await forgetting).toEqual({ kind: 'disconnected' });
  expect(g.runtime.getSnapshot()).toEqual([]);
  expect(await records(g)).toEqual([]);
});

it.each(['forget', 'disconnect'] as const)(
  'reports a failed deletion as blocked-locally and forgets on a %s retry',
  async (retry) => {
    let failing = true;
    const factory = new IDBFactory();
    const f = await logged({
      openStore: async (name) => {
        const store = await openSessionStore(name, factory);
        return {
          read: (id) => store.read(id),
          list: () => store.list(),
          commit: (...args) => store.commit(...args),
          close: () => store.close(),
          remove: (...args) =>
            failing
              ? Promise.reject(new Error('write failed'))
              : store.remove(...args),
        };
      },
    });
    const failed = {
      kind: 'ended',
      problem: 'disconnected',
      saved: false,
      forget: true,
    };
    expect(await f.runtime.forget(f.id)).toEqual({ kind: 'blocked-locally' });
    expect(f.runtime.getSnapshot()[0]?.session).toEqual(failed);
    // A retry that fails again keeps saying that forgetting failed.
    expect(await f.runtime[retry](f.id)).toEqual({ kind: 'blocked-locally' });
    expect(f.runtime.getSnapshot()[0]?.session).toEqual(failed);
    failing = false;
    // Also a sign-out retry forgets: the address is not kept.
    expect(await f.runtime[retry](f.id)).toEqual({ kind: 'disconnected' });
    expect(f.runtime.getSnapshot()).toEqual([]);
    const store = await openSessionStore(namespace, factory);
    expect((await store.list()).records).toEqual([]);
    store.close();
  },
);

it('marks only a failed forget, not a failed sign-out, as forgetting', async () => {
  let failing = false;
  const factory = new IDBFactory();
  const f = await logged({
    openStore: async (name) => {
      const store = await openSessionStore(name, factory);
      return {
        read: (id) => store.read(id),
        list: () => store.list(),
        commit: (...args) =>
          failing
            ? Promise.reject(new Error('write failed'))
            : store.commit(...args),
        close: () => store.close(),
        remove: () => Promise.reject(new Error('write failed')),
      };
    },
  });
  failing = true;
  expect(await f.runtime.disconnect(f.id)).toEqual({
    kind: 'blocked-locally',
  });
  expect(f.runtime.getSnapshot()[0]?.session).toEqual({
    kind: 'ended',
    problem: 'disconnected',
    saved: false,
  });
});

it('rememberPods: false forgets the address on sign-out', async () => {
  const f = await logged({ rememberPods: false });
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
  expect(f.runtime.getSnapshot()).toEqual([]);
  expect(await records(f)).toEqual([]);
  expect((await reload(f, f.runtime)).getSnapshot()).toEqual([]);
});

it('rememberPods: false keeps an ended session only until the page unloads', async () => {
  const f = await logged({ rememberPods: false });
  await renewal(f, f.runtime, f.id, 'refused');
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('ended');
  await vi.waitFor(async () => expect(await records(f)).toEqual([]));
  // Signing in again from the ended session still works in this page.
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'again',
    }),
  );
  const again = await signInAgain(f, f.runtime, f.id, keep);
  expect(again.getSnapshot()[0]?.session.kind).toBe('active');
  await renewal(f, again, f.id, 'refused');
  await vi.waitFor(async () => expect(await records(f)).toEqual([]));
  expect((await reload(f, again)).getSnapshot()).toEqual([]);
});

it('rememberPods: false deletes addresses an earlier start remembered', async () => {
  const f = await logged();
  await f.runtime.disconnect(f.id);
  const next = await reload(f, f.runtime, { rememberPods: false });
  expect(next.getSnapshot()).toEqual([]);
  await vi.waitFor(async () => expect(await records(f)).toEqual([]));
});

it('rememberPods: false leaves remembered records of Pods outside allowedPods untouched', async () => {
  const f = await logged();
  await f.runtime.disconnect(f.id);
  const next = await reload(f, f.runtime, {
    rememberPods: false,
    allowedPods: ['https://pod.example/bob'],
  });
  expect(next.getSnapshot()).toEqual([]);
  await settleLease();
  expect(await stored(f, f.id)).toMatchObject({ kind: 'disconnected' });
});

it('lists a retired record of SDK 0.7 as signed out without a reason', async () => {
  const f = await logged();
  await f.runtime.disconnect(f.id);
  f.runtime.dispose();
  await settleLease();
  // Rewrite the record as 0.7.0 wrote it: no reason; then an unknown one.
  for (const reason of [undefined, 'from-a-newer-sdk']) {
    const store = await openSessionStore(namespace, f.factory);
    const current = (await store.read(f.id))!;
    const value = { ...(current.value as Record<string, unknown>) };
    delete value.reason;
    await store.commit(
      f.id,
      current.revision,
      reason === undefined ? value : { ...value, reason },
    );
    store.close();
    const next = keep(createBrowserRuntime(f.options));
    expect(await next.initialize()).toMatchObject({ unreadable: [] });
    expect(next.getSnapshot()).toMatchObject([
      { id: f.id, podUrl: pod, session: { kind: 'signed-out' } },
    ]);
    expect(next.getSnapshot()[0]!.session).toEqual({ kind: 'signed-out' });
    next.dispose();
    await settleLease();
  }
});

it('reports a malformed reason as an unreadable record', async () => {
  const f = await logged();
  await f.runtime.disconnect(f.id);
  f.runtime.dispose();
  await settleLease();
  const store = await openSessionStore(namespace, f.factory);
  const current = (await store.read(f.id))!;
  await store.commit(f.id, current.revision, {
    ...(current.value as Record<string, unknown>),
    reason: 42,
  });
  store.close();
  const next = keep(createBrowserRuntime(f.options));
  expect(await next.initialize()).toMatchObject({
    unreadable: [{ id: f.id, problem: 'corrupt' }],
  });
  expect(next.getSnapshot()).toEqual([]);
});

it('keeps each Pod on its own: one ended session never affects another', async () => {
  const { f, runtime, other } = await twoPods(keep);
  await renewal(f, runtime, other.id, 'refused');
  expect(runtime.getSnapshot().find((c) => c.id === f.id)?.session.kind).toBe(
    'active',
  );
  expect(await runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
  const next = await reload(f, runtime);
  expect(
    Object.fromEntries(next.getSnapshot().map((c) => [c.id, c.session.kind])),
  ).toEqual({ [f.id]: 'signed-out', [other.id]: 'signed-out' });
  expect(await next.forget(other.id)).toEqual({ kind: 'disconnected' });
  expect(next.getSnapshot().map((c) => c.id)).toEqual([f.id]);
});

it('reuses the remembered preset Pod on connect instead of adding another', async () => {
  const f = await logged({ preset: { podUrl: pod } });
  await f.runtime.disconnect(f.id);
  const next = await reload(f, f.runtime);
  const connection = await next.connect();
  expect(connection.id).toBe(f.id);
  expect(next.getSnapshot()).toHaveLength(1);
});
