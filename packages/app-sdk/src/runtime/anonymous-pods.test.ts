/**
 * Several Pods read without a token in one runtime (#372): under `signIn:
 * 'optional'`, `connect(url)` adds a Pod beside the default one that reads
 * without a token until the person signs in to it. Under `rememberPods` its
 * address is saved, without discovery or client, so the next start and the
 * app's other tabs list it too.
 */
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
  Connection,
} from './types.js';
import {
  catalogue,
  fixture,
  fixtureNamespace,
  jwt,
  memoryChannels,
  memoryLocks,
  pod,
  restart,
  restored,
  savedRecords,
  settleLease,
  work,
} from './fixture.test.js';
import { openSessionStore } from '../sessions/store.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));
const keep = (runtime: BrowserRuntime) => {
  runtimes.push(runtime);
  return runtime;
};

const bob = 'https://pod.example/bob';
const recipes = bob + '/_system/contexts/recipes';
const notes = bob + '/_system/contexts/notes';
const authorization = (init?: RequestInit) =>
  new Headers(init?.headers).get('authorization');
/** Requests to `base`, split by whether they carried a token. */
function sentTo(f: ReturnType<typeof fixture>, base: string) {
  const calls = f.fetch.mock.calls.filter(([url]) =>
    url.startsWith(base + '/'),
  );
  return {
    anonymous: calls.filter(([, init]) => authorization(init) === null).length,
    bearer: calls.filter(([, init]) => authorization(init) !== null).length,
    discovery: calls.filter(([url]) => url.includes('/.well-known/')).length,
  };
}

/** `signIn: 'optional'` with Alice's Pod as the default one. */
function optional(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({
    preferences: null,
    signIn: 'optional',
    preset: { podUrl: pod },
    ...overrides,
  });
  keep(f.runtime);
  // Each Pod answers a request without a token with its public Contexts only.
  f.setCatalogue(async (url, init) => {
    const signedIn = authorization(init) !== null;
    return url.startsWith(bob + '/')
      ? catalogue(signedIn ? [recipes, notes] : [recipes], [], bob)
      : catalogue(signedIn ? undefined : [work], signedIn ? undefined : []);
  });
  return f;
}
/** Bob's Pod added beside the default one. */
async function withBob(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = optional(overrides);
  await f.runtime.initialize();
  const added = await f.runtime.connect(bob);
  return { ...f, id: added.id };
}

describe('a second Pod without a token', () => {
  it('reads beside the default Pod, each with its own catalogue, without discovery', async () => {
    const f = await withBob();
    expect(f.runtime.getSnapshot()).toMatchObject([
      { id: pod, podUrl: pod, reading: 'anonymous' },
      {
        id: f.id,
        podUrl: bob,
        session: { kind: 'signed-out' },
        reading: 'anonymous',
      },
    ]);
    expect(await f.runtime.loadContexts(pod)).toMatchObject({ kind: 'ok' });
    expect(await f.runtime.loadContexts(f.id)).toMatchObject({ kind: 'ok' });
    expect(f.runtime.getSnapshot()[1]!.catalogue).toEqual({
      kind: 'ready',
      contexts: [
        { iri: recipes, readable: true, writable: false, manageable: false },
      ],
    });
    f.runtime.selectContext(f.id, recipes);
    expect(f.runtime.bind(f.id).getSnapshot()).toMatchObject({
      read: true,
      write: false,
    });
    const pods = f.runtime.bindPod(f.id);
    expect(pods.getSnapshot()).toMatchObject({ current: true, read: true });
    expect(await pods.sparql.construct('CONSTRUCT {} WHERE {}')).toMatchObject({
      kind: 'ok',
    });
    expect(sentTo(f, bob)).toMatchObject({ bearer: 0, discovery: 0 });
  });

  it('is remembered across a start, read without a token again', async () => {
    const f = await withBob();
    expect(await savedRecords(f.factory)).toMatchObject([
      { id: f.id, value: { kind: 'address', podUrl: bob } },
    ]);
    const next = await restart(f, f.runtime, keep);
    expect(next.getSnapshot()).toMatchObject([
      { id: f.id, podUrl: bob, reading: 'anonymous' },
      { id: pod, podUrl: pod, reading: 'anonymous' },
    ]);
    // Never signed in to: no reason why it is signed out.
    expect(next.getSnapshot()[0]!.session).toEqual({ kind: 'signed-out' });
    expect(await next.loadContexts(f.id)).toMatchObject({ kind: 'ok' });
    expect(sentTo(f, bob).discovery).toBe(0);
  });

  it('is not remembered with rememberPods: false', async () => {
    const f = await withBob({ rememberPods: false });
    expect(f.runtime.getSnapshot()[1]).toMatchObject({ reading: 'anonymous' });
    expect(await savedRecords(f.factory)).toEqual([]);
    const next = await restart(f, f.runtime, keep);
    expect(next.getSnapshot()).toMatchObject([{ id: pod }]);
    expect(next.getSnapshot()).toHaveLength(1);
  });

  it('deletes remembered addresses at a start with rememberPods: false', async () => {
    const f = await withBob();
    const next = await restart(f, f.runtime, keep, { rememberPods: false });
    expect(next.getSnapshot()).toMatchObject([{ id: pod }]);
    await vi.waitFor(async () =>
      expect(await savedRecords(f.factory)).toEqual([]),
    );
  });

  it('signs in to that Pod alone, and reads without the token again after signing out', async () => {
    const f = await withBob();
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ iss: bob }),
        token_type: 'Bearer',
        refresh_token: 'refresh-bob',
      }),
    );
    await f.runtime.beginAuthorization(f.id);
    expect(sentTo(f, bob).discovery).toBeGreaterThan(0);
    // Discovered only for the Pod signed in to.
    expect(sentTo(f, pod).discovery).toBe(0);
    f.runtime.dispose();
    await settleLease();
    const next = keep(f.returned());
    expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
    expect(next.getSnapshot()).toMatchObject([
      {
        id: f.id,
        podUrl: bob,
        session: { kind: 'active' },
        reading: 'session',
      },
      { id: pod, reading: 'anonymous' },
    ]);
    await next.loadContexts(f.id);
    expect(next.getSnapshot()[0]!.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [{ iri: recipes }, { iri: notes }],
    });
    expect(sentTo(f, bob).bearer).toBe(1);
    expect(await next.disconnect(f.id)).toEqual({ kind: 'disconnected' });
    expect(next.getSnapshot()[0]).toMatchObject({
      id: f.id,
      session: { kind: 'signed-out', problem: 'disconnected' },
      reading: 'anonymous',
    });
    expect(await savedRecords(f.factory)).toMatchObject([
      { id: f.id, value: { kind: 'disconnected' } },
    ]);
  });

  it('keeps its address on a sign-out without a session', async () => {
    const f = await withBob();
    const [saved] = await savedRecords(f.factory);
    expect(await f.runtime.disconnect(f.id)).toEqual({ kind: 'disconnected' });
    expect(f.runtime.getSnapshot()[1]).toMatchObject({
      id: f.id,
      session: { kind: 'signed-out' },
      reading: 'anonymous',
    });
    expect(f.runtime.getSnapshot()[1]!.session).toEqual({ kind: 'signed-out' });
    expect(await savedRecords(f.factory)).toEqual([saved]);
  });

  it('is forgotten: its record and connection are gone, the default Pod stays', async () => {
    const f = await withBob();
    expect(await f.runtime.forget(f.id)).toEqual({ kind: 'disconnected' });
    expect(f.runtime.getSnapshot()).toMatchObject([
      { id: pod, reading: 'anonymous' },
    ]);
    expect(f.runtime.getSnapshot()).toHaveLength(1);
    expect(await savedRecords(f.factory)).toEqual([]);
    const next = await restart(f, f.runtime, keep);
    expect(next.getSnapshot()).toHaveLength(1);
  });

  it('saves no address for the default Pod, which every start lists', async () => {
    const f = optional();
    await f.runtime.initialize();
    expect(await f.runtime.connect(pod)).toMatchObject({ id: pod });
    expect(await savedRecords(f.factory)).toEqual([]);
  });

  it('keeps one address per Pod at a start', async () => {
    const f = await withBob();
    f.runtime.dispose();
    await settleLease();
    const store = await openSessionStore(fixtureNamespace, f.factory);
    await store.commit('duplicate', null, {
      version: 1,
      kind: 'address',
      configKey: fixtureNamespace,
      connectionId: 'duplicate',
      podUrl: bob,
    });
    store.close();
    expect(await savedRecords(f.factory)).toHaveLength(2);
    const next = keep(createBrowserRuntime(f.options));
    await next.initialize();
    expect(next.getSnapshot().filter((c) => c.podUrl === bob)).toHaveLength(1);
    expect(await savedRecords(f.factory)).toHaveLength(1);
  });
});

describe('several tabs', () => {
  /** Two tabs on one IndexedDB, Web Locks and channel, under `optional`. */
  async function tabs(
    deliver?: Parameters<typeof memoryChannels>[0],
    second: Partial<BrowserRuntimeOptions> = {},
  ) {
    const factory = new IDBFactory();
    const channels = memoryChannels(deliver);
    const f = optional({
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    const a = f.runtime;
    const b = keep(createBrowserRuntime({ ...f.options, ...second }));
    await a.initialize();
    await b.initialize();
    await restored(b);
    return { ...f, a, b, factory };
  }

  it('lists a Pod another tab added, and forgets it with that tab', async () => {
    const t = await tabs();
    const added = await t.a.connect(bob);
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()).toMatchObject([
        { id: pod },
        { id: added.id, podUrl: bob, reading: 'anonymous' },
      ]),
    );
    // Connecting there too finds the same connection, not a second record.
    expect(await t.b.connect(bob)).toMatchObject({ id: added.id });
    expect(await savedRecords(t.factory)).toHaveLength(1);
    expect(await t.a.forget(added.id)).toEqual({ kind: 'disconnected' });
    await vi.waitFor(() => expect(t.b.getSnapshot()).toHaveLength(1));
  });

  it('stops waiting for another tab to save the address when disposed', async () => {
    const t = await tabs();
    // Another tab holds the Pod's lock and never lets it go (suspended).
    const held = new Promise<void>(() => {});
    void t.options.locks!.request(
      `sempods:connect:${fixtureNamespace}:${bob}`,
      {},
      () => held,
    );
    const pending = t.b.connect(bob);
    await settleLease();
    t.b.dispose();
    await expect(pending).rejects.toMatchObject({ problem: 'disconnected' });
  });

  it('joins the session another tab signed in with, before its announcement arrives', async () => {
    // Announcements between the tabs wait while `held` is set.
    let held: (() => void)[] | null = null;
    const t = await tabs((send) =>
      held ? void held.push(send) : void setTimeout(send),
    );
    const added = await t.a.connect(bob);
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({ id: added.id }),
    );
    t.setToken(async () =>
      Response.json({
        access_token: jwt({ iss: bob }),
        token_type: 'Bearer',
        refresh_token: 'refresh-bob',
      }),
    );
    held = [];
    // The first tab signs in to Bob's Pod and returns signed in.
    await t.a.beginAuthorization(added.id);
    t.a.dispose();
    await settleLease();
    const back = keep(t.returned());
    expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
    const redirects = t.navigate.mock.calls.length;
    // The other tab still lists the address: signing in there joins the
    // stored session instead of leaving for the Pod.
    expect(t.b.getSnapshot()[1]).toMatchObject({ reading: 'anonymous' });
    await t.b.beginAuthorization(added.id);
    expect(t.navigate.mock.calls).toHaveLength(redirects);
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added.id,
        session: { kind: 'active' },
        reading: 'session',
      }),
    );
    held.splice(0).forEach((send) => send());
    held = null;
  });

  it('keeps a Pod added in a tab with rememberPods: false in that page only', async () => {
    let delivered = 0;
    const t = await tabs(
      (send) =>
        void setTimeout(() => {
          send();
          delivered++;
        }),
      { rememberPods: false },
    );
    const local = await t.b.connect(bob);
    const pods = t.b.bindPod(local.id);
    // The other tab remembers Bob's Pod; this one does not list its address.
    const remembered = await t.a.connect(bob);
    expect(remembered.id).not.toBe(local.id);
    await vi.waitFor(() => expect(delivered).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.b.getSnapshot()[1]).toMatchObject({ id: local.id, podUrl: bob });
    expect(pods.getSnapshot().current).toBe(true);
    // Forgetting it there leaves this page's connection.
    expect(await t.a.forget(remembered.id)).toEqual({ kind: 'disconnected' });
    const before = delivered;
    await vi.waitFor(() => expect(delivered).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.b.getSnapshot()[1]).toMatchObject({ id: local.id, podUrl: bob });
    expect(pods.getSnapshot().current).toBe(true);
  });

  it('reads the Pod in this page only while another tab holds its lock too long', async () => {
    const t = await tabs();
    // Another tab holds the Pod's lock and never lets it go (suspended).
    void t.options.locks!.request(
      `sempods:connect:${fixtureNamespace}:${bob}`,
      {},
      () => new Promise<void>(() => {}),
    );
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let added: Connection | undefined;
      void t.b.connect(bob).then((c) => (added = c));
      // Not before the wait is over; then without the other tab.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(added).toBeUndefined();
      for (let i = 0; i < 20 && !added; i++) {
        await vi.advanceTimersByTimeAsync(500);
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(added).toBeDefined();
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added!.id,
        podUrl: bob,
        reading: 'anonymous',
      });
    } finally {
      vi.useRealTimers();
    }
    expect(await savedRecords(t.factory)).toEqual([]);
  });

  it('saves one address when two tabs add the same Pod at once', async () => {
    const t = await tabs();
    const [first, second] = await Promise.all([
      t.a.connect(bob),
      t.b.connect(bob),
    ]);
    expect(second.id).toBe(first.id);
    expect(await savedRecords(t.factory)).toHaveLength(1);
  });
});
