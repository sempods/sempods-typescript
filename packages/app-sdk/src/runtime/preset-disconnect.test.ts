import { afterEach, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { BrowserRuntime, Connection } from './types.js';
import { RuntimeError } from './errors.js';
import { deferred, fixture, pod, storeWith } from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));

async function heldDisconnect(rememberPods = true, preset = true) {
  const factory = new IDBFactory();
  const entered = deferred<void>();
  const release = deferred<void>();
  let holding = false;
  async function hold() {
    if (holding) {
      holding = false;
      entered.resolve();
      await release.promise;
    }
  }
  const f = fixture({
    ...(preset ? { preset: { podUrl: pod } } : {}),
    rememberPods,
    openStore: storeWith(factory, (store) => ({
      async commit(...args) {
        await hold();
        return store.commit(...args);
      },
      async remove(...args) {
        await hold();
        return store.remove(...args);
      },
    })),
  });
  runtimes.push(f.runtime);
  const login = await f.login();
  runtimes.push(login.runtime);
  holding = true;
  return { ...f, ...login, entered, release };
}

it.each([
  ['direct', true, true],
  ['subscriber', true, true],
  ['direct', false, true],
  ['subscriber', false, true],
  ['direct', true, false],
  ['subscriber', true, false],
  ['direct', false, false],
  ['subscriber', false, false],
] as const)(
  'waits for durable disconnect before concurrent reconnects (%s, rememberPods: %s, preset: %s)',
  async (mode, rememberPods, preset) => {
    const f = await heldDisconnect(rememberPods, preset);
    let reconnecting: Promise<Connection> | undefined;
    let duplicateDisconnect:
      ReturnType<BrowserRuntime['disconnect']> | undefined;
    let observed = false;
    const off = f.runtime.subscribe(() => {
      if (mode === 'subscriber' && !observed) {
        observed = true;
        reconnecting = f.runtime.connect(pod);
        duplicateDisconnect = f.runtime.disconnect(f.id);
      }
    });
    const requestsBeforeDisconnect = f.fetch.mock.calls.length;
    const disconnecting = f.runtime.disconnect(f.id);
    reconnecting ??= f.runtime.connect(pod);
    const explicit = f.runtime.connect(pod);
    let settled = false;
    void reconnecting.then(() => {
      settled = true;
    });
    await f.entered.promise;
    // Give an incorrectly immediate reuse its promise continuation.
    await Promise.resolve();
    const settledBeforeRetirement = settled;
    const requestsBeforeRetirement = f.fetch.mock.calls.length;
    f.release.resolve();
    expect(await disconnecting).toEqual({ kind: 'disconnected' });
    const [a, b] = await Promise.all([reconnecting, explicit]);
    off();
    expect(settledBeforeRetirement).toBe(false);
    expect(requestsBeforeRetirement).toBe(requestsBeforeDisconnect);
    if (mode === 'subscriber') expect(duplicateDisconnect).toBe(disconnecting);
    expect(b.id).toBe(a.id);
    expect(f.runtime.getSnapshot()).toEqual([a]);
    if (rememberPods) {
      // The remembered Pod is reused: signed out, at the same address.
      expect(a).toMatchObject({
        id: f.id,
        podUrl: pod,
        session: { kind: 'signed-out', problem: 'disconnected' },
      });
      expect(f.fetch.mock.calls).toHaveLength(requestsBeforeRetirement);
    } else {
      expect(a.id).not.toBe(f.id);
      expect(f.fetch.mock.calls.length).toBeGreaterThan(
        requestsBeforeRetirement,
      );
    }
    expect(f.navigate).toHaveBeenCalledTimes(1);
    expect(await f.view.subjects.get('urn:item')).toEqual({
      kind: 'invalidated',
    });
    await f.runtime.beginAuthorization(a.id);
    expect(f.navigate).toHaveBeenCalledTimes(2);
  },
);

it.each([true, false])(
  'reports a failed retirement to waiting connects and retains explicit disconnect retry (rememberPods: %s)',
  async (rememberPods) => {
    const f = await heldDisconnect(rememberPods);
    const disconnecting = f.runtime.disconnect(f.id);
    const reconnecting = f.runtime
      .connect(pod)
      .catch((error: unknown) => error);
    const explicit = f.runtime.connect(pod).catch((error: unknown) => error);
    await f.entered.promise;
    const requests = f.fetch.mock.calls.length;
    f.release.reject(new Error('write failed'));
    expect(await disconnecting).toEqual({ kind: 'blocked-locally' });
    expect(await reconnecting).toEqual(new RuntimeError('storage'));
    expect(await explicit).toEqual(new RuntimeError('storage'));
    expect(f.fetch.mock.calls).toHaveLength(requests);
    expect(f.runtime.getSnapshot()).toMatchObject([
      {
        id: f.id,
        session: { kind: 'ended', problem: 'disconnected', saved: false },
      },
    ]);
    expect(await f.view.subjects.get('urn:item')).toEqual({
      kind: 'invalidated',
    });
    expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
    const next = await f.runtime.connect(pod);
    if (rememberPods) expect(next.id).toBe(f.id);
    else expect(next.id).not.toBe(f.id);
  },
);

it('does not publish a late sign-out failure after disposal', async () => {
  const f = await heldDisconnect();
  const disconnecting = f.runtime.disconnect(f.id);
  await f.entered.promise;
  f.runtime.dispose();
  f.release.reject(new Error('late storage failure'));
  expect(await disconnecting).toEqual({ kind: 'blocked-locally' });
  expect(f.runtime.getSnapshot()).toEqual([]);
});

it('does not discover or recreate a preset connection after disposal while waiting', async () => {
  const f = await heldDisconnect();
  const disconnecting = f.runtime.disconnect(f.id);
  const reconnecting = f.runtime.connect(pod).catch((error: unknown) => error);
  await f.entered.promise;
  const requests = f.fetch.mock.calls.length;
  f.runtime.dispose();
  f.release.resolve();
  await disconnecting;
  expect(await reconnecting).toEqual(new RuntimeError('disconnected'));
  expect(f.runtime.getSnapshot()).toEqual([]);
  expect(f.fetch.mock.calls).toHaveLength(requests);
  expect(f.navigate).toHaveBeenCalledTimes(1);
});
