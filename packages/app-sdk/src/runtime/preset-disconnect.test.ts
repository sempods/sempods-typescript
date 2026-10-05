import { afterEach, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openSessionStore } from '../sessions/store.js';
import type { BrowserRuntime, Connection } from './types.js';
import { RuntimeError } from './errors.js';
import { deferred, fixture, pod } from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));

async function heldDisconnect() {
  const factory = new IDBFactory();
  const entered = deferred<void>();
  const release = deferred<void>();
  let holding = false;
  const f = fixture({
    preset: { podUrl: pod },
    openStore: async (namespace) => {
      const store = await openSessionStore(namespace, factory);
      return {
        read: (id) => store.read(id),
        list: () => store.list(),
        close: () => store.close(),
        async commit(...args) {
          if (holding) {
            holding = false;
            entered.resolve();
            await release.promise;
          }
          return store.commit(...args);
        },
      };
    },
  });
  runtimes.push(f.runtime);
  const login = await f.login();
  runtimes.push(login.runtime);
  holding = true;
  return { ...f, ...login, entered, release };
}

it.each(['direct', 'subscriber'] as const)(
  'waits for durable preset disconnect before concurrent reconnects (%s)',
  async (mode) => {
    const f = await heldDisconnect();
    let reconnecting: Promise<Connection> | undefined;
    let duplicateDisconnect:
      ReturnType<BrowserRuntime['disconnect']> | undefined;
    let observed = false;
    const off = f.runtime.subscribe(() => {
      if (mode === 'subscriber' && !observed) {
        observed = true;
        reconnecting = f.runtime.connect();
        duplicateDisconnect = f.runtime.disconnect(f.id);
      }
    });
    const requestsBeforeDisconnect = f.fetch.mock.calls.length;
    const disconnecting = f.runtime.disconnect(f.id);
    reconnecting ??= f.runtime.connect();
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
    expect(a.id).not.toBe(f.id);
    expect(b.id).toBe(a.id);
    expect(f.runtime.getSnapshot()).toEqual([a]);
    expect(f.fetch.mock.calls.length).toBeGreaterThan(requestsBeforeRetirement);
    expect(f.navigate).toHaveBeenCalledTimes(1);
    expect(await f.view.subjects.get('urn:item')).toEqual({
      kind: 'invalidated',
    });
    await f.runtime.beginAuthorization(a.id);
    expect(f.navigate).toHaveBeenCalledTimes(2);
  },
);

it('reports a failed retirement to waiting connects and retains explicit disconnect retry', async () => {
  const f = await heldDisconnect();
  const disconnecting = f.runtime.disconnect(f.id);
  const reconnecting = f.runtime.connect().catch((error: unknown) => error);
  const explicit = f.runtime.connect(pod).catch((error: unknown) => error);
  await f.entered.promise;
  const requests = f.fetch.mock.calls.length;
  f.release.reject(new Error('write failed'));
  expect(await disconnecting).toEqual({ kind: 'blocked-locally' });
  expect(await reconnecting).toEqual(new RuntimeError('storage'));
  expect(await explicit).toEqual(new RuntimeError('storage'));
  expect(f.fetch.mock.calls).toHaveLength(requests);
  expect(f.runtime.getSnapshot()).toMatchObject([
    { id: f.id, session: { kind: 'ended', problem: 'disconnected' } },
  ]);
  expect(await f.view.subjects.get('urn:item')).toEqual({
    kind: 'invalidated',
  });
  expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
  expect((await f.runtime.connect()).id).not.toBe(f.id);
});

it('does not discover or recreate a preset connection after disposal while waiting', async () => {
  const f = await heldDisconnect();
  const disconnecting = f.runtime.disconnect(f.id);
  const reconnecting = f.runtime.connect().catch((error: unknown) => error);
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
