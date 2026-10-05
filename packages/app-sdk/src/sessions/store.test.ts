import {
  forceCloseDatabase,
  IDBDatabase,
  IDBFactory,
  IDBObjectStore,
} from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openSessionStore,
  type SessionCommit,
  type SessionStore,
} from './store.js';

const opened: SessionStore[] = [];
afterEach(() => {
  opened.splice(0).forEach((store) => store.close());
  vi.restoreAllMocks();
});
async function open(factory = new IDBFactory(), namespace = 'app') {
  const store = await openSessionStore(namespace, factory);
  opened.push(store);
  return store;
}
function committed(result: SessionCommit) {
  expect(result.kind).toBe('committed');
  if (result.kind !== 'committed')
    throw new Error('Expected committed fixture');
  return result.record;
}
async function rawDatabase(factory: IDBFactory) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('sempods:app-sdk:sessions', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('atomic session records (storage only, no session acceptance)', () => {
  it('persists an entire record across reopen and isolates caller mutations', async () => {
    const factory = new IDBFactory();
    const store = await open(factory);
    const value = { state: 'ready', tokens: { access: 'fixture-secret' } };
    const pending = store.commit('pod-a', null, value);
    value.tokens.access = 'caller-mutated';
    const record = committed(await pending);
    expect(record.value).toEqual({
      state: 'ready',
      tokens: { access: 'fixture-secret' },
    });
    (record.value as typeof value).tokens.access = 'result-mutated';
    store.close();
    const reopened = await open(factory);
    expect(await reopened.read('pod-a')).toEqual({
      ...record,
      value: { state: 'ready', tokens: { access: 'fixture-secret' } },
    });
    expect(await reopened.read('missing')).toBeUndefined();
    expect((await reopened.list()).records).toHaveLength(1);
  });

  it('has exactly one winner for competing creation and revision replacement', async () => {
    const factory = new IDBFactory();
    const first = await open(factory);
    const second = await open(factory);
    const created = await Promise.all([
      first.commit('pod', null, 'a'),
      second.commit('pod', null, 'b'),
    ]);
    expect(created.filter((r) => r.kind === 'committed')).toHaveLength(1);
    expect(created.filter((r) => r.kind === 'conflict')).toHaveLength(1);
    const initial = (await first.read('pod'))!;
    const rotated = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 ? first : second).commit('pod', initial.revision, { index }),
      ),
    );
    expect(rotated.filter((r) => r.kind === 'committed')).toHaveLength(1);
    expect(rotated.filter((r) => r.kind === 'conflict')).toHaveLength(9);
    expect((await first.read('pod'))?.revision).not.toBe(initial.revision);
  });

  it('prevents a late result from recreating a tombstoned or reconnected record', async () => {
    const store = await open();
    const ready = committed(
      await store.commit('pod', null, { state: 'ready', token: 'old' }),
    );
    const tombstone = committed(
      await store.commit('pod', ready.revision, { state: 'disconnected' }),
    );
    expect(
      await store.commit('pod', ready.revision, {
        state: 'ready',
        token: 'late',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(
      await store.commit('pod', null, { state: 'ready', token: 'recreate' }),
    ).toEqual({ kind: 'conflict' });
    expect(await store.read('pod')).toEqual(tombstone);
    const newSession = committed(
      await store.commit('pod', tombstone.revision, {
        state: 'ready',
        token: 'new',
      }),
    );
    expect(
      await store.commit('pod', tombstone.revision, {
        state: 'ready',
        token: 'also-late',
      }),
    ).toEqual({ kind: 'conflict' });
    expect(await store.read('pod')).toEqual(newSession);
  });

  it('isolates application namespaces and distinct connection IDs', async () => {
    const factory = new IDBFactory();
    const first = await open(factory, 'app-a');
    const second = await open(factory, 'app-b');
    const a = committed(
      await first.commit('same-id', null, { subject: 'alice' }),
    );
    const b = committed(
      await second.commit('same-id', null, { subject: 'bob' }),
    );
    const other = committed(
      await first.commit('other-id', null, { subject: 'carol' }),
    );
    expect((await first.list()).records).toEqual(
      expect.arrayContaining([a, other]),
    );
    expect((await first.list()).records).toHaveLength(2);
    expect(await second.list()).toEqual({ records: [b], unreadable: [] });
    expect(await second.commit('same-id', a.revision, 'wrong-app')).toEqual({
      kind: 'conflict',
    });
  });

  it('does not report success when the transaction aborts after a successful put', async () => {
    const store = await open();
    const original = committed(await store.commit('pod', null, 'old'));
    const put = IDBObjectStore.prototype.put;
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (this: IDBObjectStore, value, key) {
        const request = put.call(this, value, key);
        request.addEventListener('success', () => this.transaction.abort());
        return request;
      });
    await expect(
      store.commit('pod', original.revision, 'replacement'),
    ).rejects.toMatchObject({ problem: 'unavailable' });
    spy.mockRestore();
    expect(await store.read('pod')).toEqual(original);
  });

  it('reports a failed tombstone write and does not claim durable logout', async () => {
    const store = await open();
    const original = committed(
      await store.commit('pod', null, 'fixture-secret'),
    );
    const spy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(() => {
        throw new DOMException('fixture-secret', 'QuotaExceededError');
      });
    const error = await store
      .commit('pod', original.revision, { state: 'disconnected' })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      problem: 'unavailable',
      message: 'Session storage: unavailable',
    });
    expect(error).not.toHaveProperty('cause');
    expect(JSON.stringify(error)).not.toContain('fixture-secret');
    spy.mockRestore();
    expect(await store.read('pod')).toEqual(original);
  });

  it('lists valid records separately and preserves unreadable rows without allowing replacement', async () => {
    const factory = new IDBFactory();
    const store = await open(factory);
    const raw = await rawDatabase(factory);
    const valid = committed(await store.commit('valid', null, 'usable'));
    const rows = [
      {
        namespace: 'app',
        id: 'future',
        schema: 2,
        revision: 'future',
        value: 'opaque',
      },
      { namespace: 'app', id: 'broken', schema: 1, value: 'opaque' },
      {
        namespace: 'app',
        id: 123,
        schema: 1,
        revision: 'bad-id',
        value: 'opaque',
      },
    ];
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = raw.transaction('connections', 'readwrite');
        rows.forEach((row) => transaction.objectStore('connections').put(row));
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      expect(await store.list()).toEqual({
        records: [valid],
        unreadable: [
          { id: null, problem: 'corrupt' },
          { id: 'broken', problem: 'corrupt' },
          { id: 'future', problem: 'unsupported' },
        ],
      });
      for (const [id, problem] of [
        ['future', 'unsupported'],
        ['broken', 'corrupt'],
      ] as const) {
        await expect(store.read(id)).rejects.toMatchObject({ problem });
        await expect(store.commit(id, null, 'overwrite')).rejects.toMatchObject(
          { problem },
        );
        await expect(
          store.commit(id, 'future', 'overwrite'),
        ).rejects.toMatchObject({ problem });
      }
      for (const row of rows) {
        const request = raw
          .transaction('connections')
          .objectStore('connections')
          .get(['app', row.id]);
        const persisted = await new Promise<unknown>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        expect(persisted).toEqual(row);
      }
      expect(
        (await store.commit('valid', valid.revision, 'still usable')).kind,
      ).toBe('committed');
    } finally {
      raw.close();
    }
  });

  it('reports unavailable storage without a memory fallback', async () => {
    const factory = new IDBFactory();
    vi.spyOn(factory, 'open').mockImplementation(() => {
      throw new Error('native failure');
    });
    await expect(openSessionStore('app', factory)).rejects.toMatchObject({
      problem: 'unavailable',
    });
  });

  it('distinguishes explicitly closed handles from unavailable storage', async () => {
    const store = await open();
    store.close();
    await expect(store.read('pod')).rejects.toMatchObject({
      problem: 'closed',
    });
    await expect(store.commit('pod', null, 'value')).rejects.toMatchObject({
      problem: 'closed',
    });
    await expect(store.list()).rejects.toMatchObject({ problem: 'closed' });
  });

  it('closes an old connection on version change and rejects an unsupported database version', async () => {
    const factory = new IDBFactory();
    const store = await open(factory);
    const newer = await new Promise<globalThis.IDBDatabase>(
      (resolve, reject) => {
        const request = factory.open('sempods:app-sdk:sessions', 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      },
    );
    try {
      await expect(store.read('pod')).rejects.toMatchObject({
        problem: 'closed',
      });
      await expect(openSessionStore('app', factory)).rejects.toMatchObject({
        problem: 'unsupported',
      });
    } finally {
      newer.close();
    }
  });

  it('recognizes an abnormal database close', async () => {
    const factory = new IDBFactory();
    const original = factory.open.bind(factory);
    let request!: IDBOpenDBRequest;
    vi.spyOn(factory, 'open').mockImplementation((name, version) => {
      request = original(name, version);
      return request;
    });
    const store = await open(factory);
    const closed = new Promise<void>((resolve) =>
      request.result.addEventListener('close', () => resolve()),
    );
    // @ts-expect-error fake-indexeddb 6.2.5 declares a constructor here but requires an instance.
    forceCloseDatabase(request.result);
    await closed;
    await expect(store.read('pod')).rejects.toMatchObject({
      problem: 'closed',
    });
    await expect(store.list()).rejects.toMatchObject({ problem: 'closed' });
    await expect(store.commit('pod', null, 'value')).rejects.toMatchObject({
      problem: 'closed',
    });
  });

  it('rejects invalid keys and uncloneable payloads before writing', async () => {
    await expect(openSessionStore('', new IDBFactory())).rejects.toMatchObject({
      problem: 'configuration',
    });
    const store = await open();
    await expect(store.read('')).rejects.toMatchObject({
      problem: 'configuration',
    });
    await expect(store.commit('pod', '', 'value')).rejects.toMatchObject({
      problem: 'configuration',
    });
    await expect(
      store.commit('pod', null, () => 'not cloneable'),
    ).rejects.toMatchObject({ problem: 'configuration' });
    expect(await store.list()).toEqual({ records: [], unreadable: [] });
  });
});
