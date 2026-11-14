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
import { sessionBinding, type SessionRecord } from '../sessions/records.js';
import {
  deferred,
  fixture,
  fixtureNamespace,
  jwt,
  pod,
  renewal,
  restart,
  savedRecords,
  settleLease,
  signInAgain,
  storeWith,
  twoPods,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));
const keep = (runtime: BrowserRuntime) => {
  runtimes.push(runtime);
  return runtime;
};

async function logged(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({ preferences: null, ...overrides });
  keep(f.runtime);
  const login = await f.login();
  keep(login.runtime);
  return { ...f, ...login };
}
/** A fresh start without a callback, as after a reload. */
const reload = (
  f: ReturnType<typeof fixture>,
  current: BrowserRuntime,
  overrides: Partial<BrowserRuntimeOptions> = {},
) => restart(f, current, keep, overrides);
const records = (f: ReturnType<typeof fixture>) => savedRecords(f.factory);
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
      openStore: storeWith(factory, (store) => ({
        remove: (...args) =>
          failing
            ? Promise.reject(new Error('write failed'))
            : store.remove(...args),
      })),
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
    expect(await savedRecords(factory)).toEqual([]);
  },
);

it('marks only a failed forget, not a failed sign-out, as forgetting', async () => {
  let failing = false;
  const factory = new IDBFactory();
  const f = await logged({
    openStore: storeWith(factory, (store) => ({
      commit: (...args) =>
        failing
          ? Promise.reject(new Error('write failed'))
          : store.commit(...args),
      remove: () => Promise.reject(new Error('write failed')),
    })),
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
    const store = await openSessionStore(fixtureNamespace, f.factory);
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

it.each([42, 'session_ended', 'x'.repeat(41)])(
  'keeps the remembered Pod when its reason is unreadable (%s)',
  async (reason) => {
    const f = await logged();
    await f.runtime.disconnect(f.id);
    f.runtime.dispose();
    await settleLease();
    const store = await openSessionStore(fixtureNamespace, f.factory);
    const current = (await store.read(f.id))!;
    await store.commit(f.id, current.revision, {
      ...(current.value as Record<string, unknown>),
      reason,
    });
    store.close();
    const next = keep(createBrowserRuntime(f.options));
    expect(await next.initialize()).toMatchObject({ unreadable: [] });
    expect(next.getSnapshot()).toMatchObject([
      { id: f.id, podUrl: pod, session: { kind: 'signed-out' } },
    ]);
    expect(next.getSnapshot()[0]!.session).toEqual({ kind: 'signed-out' });
  },
);

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

it('remembers a Pod whose first sign-in failed without a reason, and a failed re-authorization with one', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const denied = keep(f.returned(undefined, 'error=access_denied'));
  expect(await denied.initialize()).toMatchObject({
    interaction: 'cancelled',
  });
  await vi.waitFor(async () =>
    expect(await stored(f, connection.id)).toMatchObject({
      kind: 'disconnected',
    }),
  );
  // There was no session to end: no reason, so no "session ended" note.
  expect(await stored(f, connection.id)).not.toHaveProperty('reason');
  const next = await reload(f, denied);
  expect(next.getSnapshot()[0]?.session).toEqual({ kind: 'signed-out' });
});

it('does not let a connect reuse a Pod whose forget waits for a sign-out', async () => {
  const factory = new IDBFactory();
  const held = {
    on: false,
    entered: deferred<void>(),
    release: deferred<void>(),
  };
  const f = await logged({
    preset: { podUrl: pod },
    openStore: storeWith(factory, (store) => ({
      async commit(...args) {
        if (held.on) {
          held.on = false;
          held.entered.resolve();
          await held.release.promise;
        }
        return store.commit(...args);
      },
    })),
  });
  held.on = true;
  const signOut = f.runtime.disconnect(f.id);
  await held.entered.promise;
  // The connect waits for the sign-out first; the forget follows it.
  const connecting = f.runtime.connect();
  const forgetting = f.runtime.forget(f.id);
  held.release.resolve();
  expect(await signOut).toEqual({ kind: 'disconnected' });
  expect(await forgetting).toEqual({ kind: 'disconnected' });
  const connection = await connecting;
  expect(connection.id).not.toBe(f.id);
  expect(f.runtime.getSnapshot().map((c) => c.id)).toEqual([connection.id]);
  expect(await savedRecords(factory)).toEqual([]);
});

it('keeps the remembered Context when deleting an ended session fails (rememberPods: false)', async () => {
  const choices = new Map<string, string>();
  const preferences = {
    getItem: (key: string) => choices.get(key) ?? null,
    setItem: (key: string, value: string) => void choices.set(key, value),
    removeItem: (key: string) => void choices.delete(key),
  };
  const factory = new IDBFactory();
  const f = await logged({
    rememberPods: false,
    preferences,
    openStore: storeWith(factory, () => ({
      remove: () => Promise.reject(new Error('write failed')),
    })),
  });
  expect(choices.size).toBe(1);
  await renewal(f, f.runtime, f.id, 'refused');
  await vi.waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
      kind: 'ended',
      problem: 'storage',
    }),
  );
  // The record still exists, so its Context choice stays with it.
  expect(choices.size).toBe(1);
  expect(await savedRecords(factory)).toHaveLength(1);
});

it('drops a failed forget once the person signs in again', async () => {
  const factory = new IDBFactory();
  const f = await logged({
    openStore: storeWith(factory, () => ({
      remove: () => Promise.reject(new Error('write failed')),
    })),
  });
  expect(await f.runtime.forget(f.id)).toEqual({ kind: 'blocked-locally' });
  await f.runtime.beginAuthorization(f.id);
  // Not a forget any more: signing out keeps the address.
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
  expect(f.runtime.getSnapshot()[0]?.session).toEqual({
    kind: 'signed-out',
    problem: 'disconnected',
  });
});

// Seed records written by older SDKs; ordinary connect no longer creates them.
async function duplicateRecord(
  f: Awaited<ReturnType<typeof logged>>,
  id: string,
  disconnected = false,
) {
  const original = (await records(f)).find((r) => r.id === f.id)!;
  const value = original.value as SessionRecord;
  const binding = { ...sessionBinding(value), connectionId: id };
  const store = await openSessionStore(fixtureNamespace, f.factory);
  try {
    expect(
      await store.commit(
        id,
        null,
        disconnected
          ? {
              version: 1,
              kind: 'disconnected',
              binding,
              reason: 'disconnected',
            }
          : { ...value, binding },
      ),
    ).toMatchObject({ kind: 'committed' });
  } finally {
    store.close();
  }
}

it('coalesces unrestricted connects and reuses the same address after sign-out and reload', async () => {
  const f = fixture();
  keep(f.runtime);
  await f.runtime.initialize();
  const [a, b] = await Promise.all([
    f.runtime.connect(pod),
    f.runtime.connect(pod),
  ]);
  expect(a.id).toBe(b.id);
  expect(f.runtime.getSnapshot()).toHaveLength(1);
  expect(f.count('/.well-known/oauth-protected-resource')).toBe(1);
  expect(f.navigate).not.toHaveBeenCalled();
  const signedIn = await signInAgain(f, f.runtime, a.id, keep);
  await signedIn.disconnect(a.id);
  const next = await reload(f, signedIn);
  expect((await next.connect(pod)).id).toBe(a.id);
  const again = await signInAgain(f, next, a.id, keep);
  await again.disconnect(a.id);
  expect(await records(f)).toHaveLength(1);
  await again.forget(a.id);
  expect((await reload(f, again)).getSnapshot()).toEqual([]);
  expect(await records(f)).toEqual([]);
});

it('removes old duplicate address-only records durably, then forgets the surviving address', async () => {
  const f = await logged();
  await f.runtime.disconnect(f.id);
  await duplicateRecord(f, 'zz-duplicate-a');
  await duplicateRecord(f, 'zz-duplicate-b');
  const next = await reload(f, f.runtime);
  expect(next.getSnapshot()).toMatchObject([{ id: f.id, podUrl: pod }]);
  expect(await records(f)).toHaveLength(1);
  await next.forget(f.id);
  expect((await reload(f, next)).getSnapshot()).toEqual([]);
});

it('keeps legacy live sessions independent while removing their redundant remembered addresses', async () => {
  const f = await logged();
  await duplicateRecord(f, 'zz-live');
  await duplicateRecord(f, 'zz-remembered', true);
  const next = await reload(f, f.runtime);
  expect(
    next
      .getSnapshot()
      .map((c) => c.id)
      .sort(),
  ).toEqual([f.id, 'zz-live'].sort());
  expect(next.getSnapshot().every((c) => c.session.kind === 'active')).toBe(
    true,
  );
  expect(await records(f)).toHaveLength(2);
});

it.each(['failure', 'conflict'] as const)(
  'retains an old address when cleanup cannot be saved (%s)',
  async (result) => {
    const f = await logged();
    await f.runtime.disconnect(f.id);
    await duplicateRecord(f, 'zz-duplicate');
    const next = await reload(f, f.runtime, {
      openStore: storeWith(f.factory, () => ({
        remove: async () => {
          if (result === 'failure') throw new Error('storage');
          return { kind: 'conflict' };
        },
      })),
    });
    expect(next.getSnapshot()).toHaveLength(2);
    expect(await records(f)).toHaveLength(2);
    const retried = await reload(f, next);
    expect(retried.getSnapshot()).toHaveLength(1);
    expect(await records(f)).toHaveLength(1);
  },
);
