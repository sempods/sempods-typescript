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
  authorization,
  callback,
  catalogue,
  deferred,
  fixture,
  fixtureNamespace,
  heldDiscovery,
  jwt,
  memoryChannels,
  memoryLocks,
  pod,
  restart,
  restored,
  savedRecords,
  settleLease,
  signInAgain,
  storeWith,
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
  // A sign-in's token is issued by the Pod signed in to.
  f.setToken(async (url) =>
    Response.json({
      access_token: jwt({ iss: url.split('/_system')[0] }),
      token_type: 'Bearer',
      refresh_token: 'refresh',
    }),
  );
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
    const next = await signInAgain(f, f.runtime, f.id, keep);
    expect(sentTo(f, bob).discovery).toBeGreaterThan(0);
    // Discovered only for the Pod signed in to.
    expect(sentTo(f, pod).discovery).toBe(0);
    expect(next.getSnapshot()).toMatchObject([
      {
        id: f.id,
        podUrl: bob,
        session: { kind: 'active' },
        reading: 'session',
      },
      { id: pod, reading: 'anonymous' },
    ]);
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
  /**
   * Two tabs on one IndexedDB, Web Locks and channel, under `optional`; the
   * second one's options can differ, given the first one's and the shared
   * store.
   */
  async function tabs(
    deliver?: Parameters<typeof memoryChannels>[0],
    second:
      | Partial<BrowserRuntimeOptions>
      | ((first: {
          options: BrowserRuntimeOptions;
          factory: IDBFactory;
          channels: ReturnType<typeof memoryChannels>;
        }) => Partial<BrowserRuntimeOptions>) = {},
  ) {
    const factory = new IDBFactory();
    const channels = memoryChannels(deliver);
    const f = optional({
      locks: memoryLocks(),
      openStore: (namespace) => openSessionStore(namespace, factory, channels),
    });
    const a = f.runtime;
    const b = keep(
      createBrowserRuntime({
        ...f.options,
        ...(typeof second === 'function'
          ? second({ options: f.options, factory, channels })
          : second),
      }),
    );
    await a.initialize();
    await b.initialize();
    await restored(b);
    return { ...f, a, b, factory, channels };
  }
  /** Notifications between the tabs, delivered at once or held until `flush()`. */
  const holdable = () => {
    let queued: (() => void)[] | null = null;
    return {
      deliver: (send: () => void) =>
        queued ? void queued.push(send) : void setTimeout(send),
      hold: () => void (queued = []),
      flush: () => {
        const sends = queued ?? [];
        queued = null;
        sends.forEach((send) => send());
      },
    };
  };
  /** A token answer that waits for `release()`; `asked()` tells whether it was requested. */
  const heldToken = (t: {
    setToken: ReturnType<typeof optional>['setToken'];
  }) => {
    const released = deferred<void>();
    let asked = false;
    t.setToken(async (url) => {
      asked = true;
      await released.promise;
      return Response.json({
        access_token: jwt({ iss: url.split('/_system')[0] }),
        token_type: 'Bearer',
        refresh_token: 'refresh',
      });
    });
    return { asked: () => asked, release: () => released.resolve() };
  };
  /** Another tab that holds Bob's Pod lock and never lets it go (suspended). */
  const holdBobsLock = (options: BrowserRuntimeOptions) =>
    void options.locks!.request(
      `sempods:connect:${fixtureNamespace}:${bob}`,
      {},
      () => new Promise<void>(() => {}),
    );
  /** Waits until `runtime` lists connection `id` beside the default Pod. */
  const listedBeside = (runtime: BrowserRuntime, id: string) =>
    vi.waitFor(() => expect(runtime.getSnapshot()[1]).toMatchObject({ id }));
  /** A store wrapper that rejects or holds this tab's writes of some record kinds. */
  const onWrite =
    (hooks: Partial<Record<string, () => Promise<void>>>) =>
    ({
      factory,
      channels,
    }: {
      factory: IDBFactory;
      channels: ReturnType<typeof memoryChannels>;
    }) =>
      storeWith(
        factory,
        (store) => ({
          commit: async (id, revision, value) => {
            await hooks[(value as { kind?: string }).kind ?? '']?.();
            return store.commit(id, revision, value);
          },
        }),
        channels,
      );
  /** A store wrapper that rejects or holds this tab's sign-in attempts. */
  const onAttempt = (attempt: () => Promise<void>) =>
    onWrite({ authorizing: attempt });

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
    holdBobsLock(t.options);
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
    await listedBeside(t.b, added.id);
    held = [];
    // The first tab signs in to Bob's Pod and returns signed in.
    await signInAgain(t, t.a, added.id, keep);
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
    holdBobsLock(t.options);
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

  it('signs in on the address another tab saved, also with rememberPods: false', async () => {
    const t = await tabs(undefined, { rememberPods: false });
    const local = await t.b.connect(bob);
    const remembered = await t.a.connect(bob);
    // Asked to sign in, the opted-out tab uses the saved record: one per Pod.
    await t.b.beginAuthorization(local.id);
    expect(t.navigate).toHaveBeenCalledTimes(1);
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'authorizing' } },
    ]);
  });

  it.each([
    ['denied at the Pod', 'error=access_denied'],
    ['whose code exchange fails', 'code=fixture-code'],
  ])(
    'puts the other tab’s address back after a first sign-in on it %s, also with rememberPods: false',
    async (_, answer) => {
      const t = await tabs(undefined, { rememberPods: false });
      t.setToken(async () =>
        Response.json({ error: 'invalid_grant' }, { status: 400 }),
      );
      const local = await t.b.connect(bob);
      const remembered = await t.a.connect(bob);
      await t.b.beginAuthorization(local.id);
      t.b.dispose();
      await settleLease();
      const state = new URL(t.navigate.mock.calls.at(-1)![0]).searchParams.get(
        'state',
      );
      const back = keep(
        createBrowserRuntime({
          ...t.options,
          rememberPods: false,
          location: () => `${callback}?${answer}&state=${state}`,
        }),
      );
      await back.initialize().catch(() => {});
      await vi.waitFor(async () =>
        expect(await savedRecords(t.factory)).toMatchObject([
          { id: remembered.id, value: { kind: 'address', podUrl: bob } },
        ]),
      );
      // The tab that remembered Bob's Pod still lists it.
      await vi.waitFor(() =>
        expect(t.a.getSnapshot()[1]).toMatchObject({
          id: remembered.id,
          podUrl: bob,
          reading: 'anonymous',
        }),
      );
    },
  );

  it('keeps this page’s reader when the sign-in on another tab’s address cannot be saved', async () => {
    const t = await tabs(undefined, (shared) => ({
      rememberPods: false,
      // This tab cannot save a sign-in attempt.
      openStore: onAttempt(() => Promise.reject(new Error('quota')))(shared),
    }));
    const local = await t.b.connect(bob);
    const pods = t.b.bindPod(local.id);
    const remembered = await t.a.connect(bob);
    await expect(t.b.beginAuthorization(local.id)).rejects.toBeDefined();
    expect(t.navigate).not.toHaveBeenCalled();
    expect(t.b.getSnapshot()[1]).toMatchObject({
      id: local.id,
      reading: 'anonymous',
    });
    expect(pods.getSnapshot().current).toBe(true);
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'address' } },
    ]);
  });

  it('restores the other tab’s address when this page forgets the Pod while its sign-in is saved there', async () => {
    const saved = deferred<void>();
    let saving = false;
    const t = await tabs(undefined, (shared) => ({
      rememberPods: false,
      // This tab's sign-in attempt waits before it is written.
      openStore: onAttempt(() => {
        saving = true;
        return saved.promise;
      })(shared),
    }));
    const local = await t.b.connect(bob);
    const remembered = await t.a.connect(bob);
    const pending = t.b.beginAuthorization(local.id);
    await vi.waitFor(() => expect(saving).toBe(true));
    const forgotten = t.b.forget(local.id);
    saved.resolve();
    expect(await forgotten).toEqual({ kind: 'disconnected' });
    await expect(pending).rejects.toMatchObject({ problem: 'disconnected' });
    expect(t.navigate).not.toHaveBeenCalled();
    // No attempt or verifier is left: the other tab's address is back.
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'address', podUrl: bob } },
    ]);
    expect(t.b.getSnapshot().some((c) => c.podUrl === bob)).toBe(false);
  });

  it('restores the other tab’s address when this page forgets the Pod right after its sign-in is saved there', async () => {
    let written = false;
    const t = await tabs(undefined, (shared) => ({
      rememberPods: false,
      openStore: onAttempt(() => {
        written = true;
        return Promise.resolve();
      })(shared),
    }));
    const local = await t.b.connect(bob);
    const remembered = await t.a.connect(bob);
    // Forgotten from the first update after the attempt was written.
    let forgotten: Promise<unknown> | undefined;
    const unsubscribe = t.b.subscribe(() => {
      if (!written || forgotten) return;
      forgotten = t.b.forget(local.id);
    });
    const pending = t.b.beginAuthorization(local.id);
    await expect(pending).rejects.toMatchObject({ problem: 'disconnected' });
    unsubscribe();
    expect(await forgotten).toEqual({ kind: 'disconnected' });
    expect(t.navigate).not.toHaveBeenCalled();
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'address', podUrl: bob } },
    ]);
    expect(t.b.getSnapshot().some((c) => c.podUrl === bob)).toBe(false);
  });

  it('reports a forget whose putting back of the other tab’s address fails, and puts it back on a retry', async () => {
    const saved = deferred<void>();
    let saving = false;
    let failing = true;
    const t = await tabs(undefined, (shared) => ({
      rememberPods: false,
      openStore: onWrite({
        // The sign-in attempt waits before it is written.
        authorizing: () => {
          saving = true;
          return saved.promise;
        },
        address: () =>
          failing ? Promise.reject(new Error('quota')) : Promise.resolve(),
      })(shared),
    }));
    const local = await t.b.connect(bob);
    const remembered = await t.a.connect(bob);
    const pending = t.b.beginAuthorization(local.id);
    await vi.waitFor(() => expect(saving).toBe(true));
    const forgotten = t.b.forget(local.id);
    saved.resolve();
    expect(await forgotten).toEqual({ kind: 'blocked-locally' });
    await expect(pending).rejects.toMatchObject({ problem: 'disconnected' });
    expect(t.navigate).not.toHaveBeenCalled();
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'authorizing' } },
    ]);
    expect(t.b.getSnapshot().find((c) => c.id === local.id)).toMatchObject({
      session: { kind: 'ended', saved: false, forget: true },
    });
    failing = false;
    expect(await t.b.forget(local.id)).toEqual({ kind: 'disconnected' });
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'address', podUrl: bob } },
    ]);
    expect(t.b.getSnapshot().some((c) => c.podUrl === bob)).toBe(false);
  });

  it('forgets the other tab’s address when a forget follows a sign-out of the first sign-in on it', async () => {
    const t = await tabs(undefined, { rememberPods: false });
    const local = await t.b.connect(bob);
    const remembered = await t.a.connect(bob);
    await t.b.beginAuthorization(local.id);
    expect(t.b.getSnapshot()[1]).toMatchObject({ id: remembered.id });
    // The sign-out puts the address back; the forget then deletes it.
    const signedOut = t.b.disconnect(remembered.id);
    const forgotten = t.b.forget(remembered.id);
    expect(await signedOut).toEqual({ kind: 'disconnected' });
    expect(await forgotten).toEqual({ kind: 'disconnected' });
    expect(await savedRecords(t.factory)).toEqual([]);
    expect(t.b.getSnapshot().some((c) => c.podUrl === bob)).toBe(false);
  });

  it('follows a sign-in another tab began before this tab heard of it', async () => {
    let queued: (() => void)[] | null = null;
    let held!: ReturnType<typeof heldDiscovery>;
    const t = await tabs(
      (send) => (queued ? void queued.push(send) : void setTimeout(send)),
      ({ options }) => {
        held = heldDiscovery(options.fetch!, bob);
        return { fetch: held.fetch };
      },
    );
    const added = await t.a.connect(bob);
    await listedBeside(t.b, added.id);
    const pending = t.b.beginAuthorization(added.id);
    await vi.waitFor(() => expect(held.discovering()).toBe(true));
    // The first tab leaves for Bob's Pod; this tab does not hear of it yet.
    queued = [];
    await t.a.beginAuthorization(added.id);
    const state = new URL(t.navigate.mock.calls[0]![0]).searchParams.get(
      'state',
    );
    held.release();
    await expect(pending).resolves.toBeUndefined();
    expect(t.navigate).toHaveBeenCalledTimes(1);
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: added.id, value: { kind: 'authorizing', attempt: { state } } },
    ]);
    queued.splice(0).forEach((send) => send());
    queued = null;
  });

  it.each([
    ['its own record', 'before the other tab returns'],
    ['its own record', 'during the other tab’s code exchange'],
    ['a page-local connection', 'before the other tab returns'],
    ['a page-local connection', 'during the other tab’s code exchange'],
  ])(
    'lets a first sign-in on %s follow one another tab began unheard of, %s',
    async (on, phase) => {
      const local = on === 'a page-local connection';
      const notes = holdable();
      let held!: ReturnType<typeof heldDiscovery>;
      const t = await tabs(notes.deliver, ({ options }) => {
        held = heldDiscovery(options.fetch!, bob);
        return {
          fetch: held.fetch,
          ...(local ? { rememberPods: false } : {}),
        };
      });
      const token = heldToken(t);
      const added = await t.a.connect(bob);
      const mine = local ? await t.b.connect(bob) : undefined;
      if (!local) await listedBeside(t.b, added.id);
      const pending = t.b.beginAuthorization(mine?.id ?? added.id);
      await vi.waitFor(() => expect(held.discovering()).toBe(true));
      // The first tab leaves for Bob's Pod; this tab does not hear of it.
      notes.hold();
      await t.a.beginAuthorization(added.id);
      t.a.dispose();
      await settleLease();
      const back = keep(t.returned());
      let returned: ReturnType<typeof back.initialize> | undefined;
      if (phase === 'during the other tab’s code exchange') {
        returned = back.initialize();
        await vi.waitFor(() => expect(token.asked()).toBe(true));
        held.release();
        // This sign-in waits for that exchange.
        await new Promise((resolve) => setTimeout(resolve, 20));
        let settled = false;
        void pending.finally(() => (settled = true));
        await Promise.resolve();
        expect(settled).toBe(false);
        token.release();
        await expect(pending).resolves.toBeUndefined();
      } else {
        held.release();
        await expect(pending).resolves.toBeUndefined();
        token.release();
        returned = back.initialize();
      }
      expect(await returned).toMatchObject({ interaction: 'completed' });
      expect(t.navigate).toHaveBeenCalledTimes(1);
      expect(await savedRecords(t.factory)).toMatchObject([
        { id: added.id, value: { kind: 'ready' } },
      ]);
      notes.flush();
      await vi.waitFor(() =>
        expect(t.b.getSnapshot().find((c) => c.podUrl === bob)).toMatchObject({
          id: added.id,
          session: { kind: 'active' },
        }),
      );
    },
  );

  it('resolves a sign-in that waited for the Pod’s lock when it adopts the attempt another tab saved meanwhile', async () => {
    const notes = holdable();
    const requested = deferred<void>();
    const t = await tabs(notes.deliver, ({ options }) => ({
      // Tells when this tab asks for Bob's Pod's lock.
      locks: {
        ...options.locks!,
        request: ((name: string, ...rest: unknown[]) => {
          if (name === `sempods:connect:${fixtureNamespace}:${bob}`)
            requested.resolve();
          return (options.locks!.request as (...args: unknown[]) => unknown)(
            name,
            ...rest,
          );
        }) as NonNullable<BrowserRuntimeOptions['locks']>['request'],
      },
    }));
    const added = await t.a.connect(bob);
    await listedBeside(t.b, added.id);
    // Another tab holds Bob's Pod's lock once its attempt is written.
    const written = deferred<void>();
    const writing = deferred<void>();
    const holder = keep(
      createBrowserRuntime({
        ...t.options,
        openStore: storeWith(
          t.factory,
          (store) => ({
            commit: async (id, revision, value) => {
              const change = await store.commit(id, revision, value);
              if ((value as { kind?: string }).kind === 'authorizing') {
                writing.resolve();
                await written.promise;
              }
              return change;
            },
          }),
          t.channels,
        ),
      }),
    );
    await holder.initialize();
    expect(holder.getSnapshot().some((c) => c.id === added.id)).toBe(true);
    notes.hold();
    const leaving = holder.beginAuthorization(added.id);
    await writing.promise;
    const pending = t.b.beginAuthorization(added.id);
    await requested.promise;
    // This tab hears of that attempt while it waits for the lock.
    notes.flush();
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added.id,
        session: { kind: 'ended', problem: 'interrupted' },
      }),
    );
    written.resolve();
    await leaving;
    await expect(pending).resolves.toBeUndefined();
    expect(t.navigate).toHaveBeenCalledTimes(1);
    holder.dispose();
    await settleLease();
    const back = keep(t.returned());
    expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added.id,
        session: { kind: 'active' },
      }),
    );
  });

  it.each([
    ['its attempt is saved', 1],
    ['the other tab’s connection is listed', 2],
  ])(
    'puts the other tab’s address back when this page is disposed as %s',
    async (_, at) => {
      let written = false;
      const t = await tabs(undefined, (shared) => ({
        rememberPods: false,
        openStore: onAttempt(() => {
          written = true;
          return Promise.resolve();
        })(shared),
      }));
      const local = await t.b.connect(bob);
      const remembered = await t.a.connect(bob);
      let updates = 0;
      t.b.subscribe(() => {
        if (written && ++updates === at) t.b.dispose();
      });
      await expect(t.b.beginAuthorization(local.id)).rejects.toMatchObject({
        problem: 'disconnected',
      });
      expect(t.navigate).not.toHaveBeenCalled();
      await vi.waitFor(async () =>
        expect(await savedRecords(t.factory)).toMatchObject([
          { id: remembered.id, value: { kind: 'address', podUrl: bob } },
        ]),
      );
      expect((await savedRecords(t.factory))[0]!.value).not.toHaveProperty(
        'attempt',
      );
      await settleLease();
      const fresh = keep(createBrowserRuntime(t.options));
      await fresh.initialize();
      const listed = fresh.getSnapshot().find((c) => c.id === remembered.id);
      expect(listed?.session).toEqual({ kind: 'signed-out' });
    },
  );

  it.each([
    ['its write is in flight, on a saved address it lists', 'shared', 'write'],
    [
      'its write is in flight, on a page-local connection',
      'page-local',
      'write',
    ],
    ['it shows leaving, on a saved address it lists', 'shared', 'leaving'],
    [
      'its write is in flight, twice, on a saved address it lists',
      'shared',
      'twice',
    ],
  ])(
    'leaves the saved address as it was when the page is disposed before leaving, as %s',
    async (_, on, at) => {
      const local = on === 'page-local';
      let disposeNow: (() => void) | undefined;
      const t = await tabs(undefined, (shared) => ({
        ...(local ? { rememberPods: false } : {}),
        openStore: storeWith(
          shared.factory,
          (store) => ({
            commit: (id, revision, value) => {
              const committing = store.commit(id, revision, value);
              // Disposed after the attempt's transaction opened.
              if ((value as { kind?: string }).kind === 'authorizing')
                disposeNow?.();
              return committing;
            },
          }),
          shared.channels,
        ),
      }));
      const added = await t.a.connect(bob);
      const mine = local ? await t.b.connect(bob) : undefined;
      if (!local) await listedBeside(t.b, added.id);
      const before = (await savedRecords(t.factory)).map(({ id, value }) => ({
        id,
        value,
      }));
      expect(before).toMatchObject([
        { id: added.id, value: { kind: 'address' } },
      ]);
      if (at === 'write') disposeNow = () => t.b.dispose();
      else if (at === 'twice')
        disposeNow = () => {
          t.b.dispose();
          t.b.dispose();
        };
      else
        t.b.subscribe(() => {
          if (t.b.getSnapshot().some((c) => c.session.kind === 'leaving'))
            t.b.dispose();
        });
      await expect(
        t.b.beginAuthorization(mine?.id ?? added.id),
      ).rejects.toMatchObject({ problem: 'disconnected' });
      expect(t.navigate).not.toHaveBeenCalled();
      await vi.waitFor(async () =>
        expect(
          (await savedRecords(t.factory)).map(({ id, value }) => ({
            id,
            value,
          })),
        ).toEqual(before),
      );
      await settleLease();
      const fresh = keep(createBrowserRuntime(t.options));
      await fresh.initialize();
      const listed = fresh.getSnapshot().find((c) => c.id === added.id);
      expect(listed?.session).toEqual({ kind: 'signed-out' });
    },
  );

  it('leaves the saved address as it was when a page is disposed during another Pod’s callback after it began a sign-in on it', async () => {
    const t = await tabs();
    const added = await t.a.connect(bob);
    const before = (await savedRecords(t.factory)).map(({ id, value }) => ({
      id,
      value,
    }));
    // A sign-in to the default Pod leaves; its callback's token answer waits.
    await t.a.beginAuthorization(pod);
    const state = new URL(t.navigate.mock.calls.at(-1)![0]).searchParams.get(
      'state',
    );
    t.a.dispose();
    await settleLease();
    const gate = deferred<void>();
    let asked = false;
    t.setToken(async (url) => {
      asked = true;
      await gate.promise;
      return Response.json({
        access_token: jwt({ iss: url.split('/_system')[0] }),
        token_type: 'Bearer',
        refresh_token: 'refresh',
      });
    });
    const on: { write?: () => void } = {};
    const back = keep(
      createBrowserRuntime({
        ...t.options,
        location: () => `${callback}?code=fixture-code&state=${state}`,
        openStore: storeWith(
          t.factory,
          (store) => ({
            commit: (id, revision, value) => {
              const committing = store.commit(id, revision, value);
              // Disposed once the attempt on Bob's address is being written.
              if (
                id === added.id &&
                (value as { kind?: string }).kind === 'authorizing'
              )
                on.write?.();
              return committing;
            },
          }),
          t.channels,
        ),
      }),
    );
    const returned = back.initialize().catch(() => undefined);
    await vi.waitFor(() => expect(asked).toBe(true));
    expect(back.getSnapshot().some((c) => c.id === added.id)).toBe(true);
    const navigations = t.navigate.mock.calls.length;
    on.write = () => back.dispose();
    await expect(back.beginAuthorization(added.id)).rejects.toMatchObject({
      problem: 'disconnected',
    });
    await returned;
    gate.resolve();
    expect(t.navigate.mock.calls.slice(navigations)).toEqual([]);
    await vi.waitFor(async () =>
      expect(
        (await savedRecords(t.factory))
          .filter(({ id }) => id === added.id)
          .map(({ id, value }) => ({ id, value })),
      ).toEqual(before),
    );
    await settleLease();
    const fresh = keep(createBrowserRuntime(t.options));
    await fresh.initialize();
    const listed = fresh.getSnapshot().find((c) => c.id === added.id);
    expect(listed?.session).toEqual({ kind: 'signed-out' });
  });

  it('lets a new sign-in leave while the code exchange of one signed out elsewhere still waits', async () => {
    const t = await tabs();
    const added = await t.a.connect(bob);
    await listedBeside(t.b, added.id);
    await t.a.beginAuthorization(added.id);
    t.a.dispose();
    await settleLease();
    // The first callback's token answer waits.
    const first = deferred<void>();
    let asked = 0;
    t.setToken(async (url) => {
      if (++asked === 1) await first.promise;
      return Response.json({
        access_token: jwt({ iss: url.split('/_system')[0] }),
        token_type: 'Bearer',
        refresh_token: 'refresh',
      });
    });
    const back = keep(t.returned());
    const returned = back.initialize();
    await vi.waitFor(() => expect(asked).toBe(1));
    // Signed out in the other tab during that exchange.
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added.id,
        session: { kind: 'ended', problem: 'interrupted' },
      }),
    );
    expect(await t.b.disconnect(added.id)).toEqual({ kind: 'disconnected' });
    await vi.waitFor(() =>
      expect(back.getSnapshot().find((c) => c.id === added.id)).toMatchObject({
        session: { kind: 'signed-out' },
      }),
    );
    // A new sign-in leaves for the Pod while the old answer still waits.
    await t.b.beginAuthorization(added.id);
    expect(t.navigate).toHaveBeenCalledTimes(2);
    first.resolve();
    await expect(returned).resolves.toBeDefined();
    // The late answer installs nothing and leaves the new attempt.
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: added.id, value: { kind: 'authorizing' } },
    ]);
    expect(back.getSnapshot().find((c) => c.id === added.id)?.reading).not.toBe(
      'session',
    );
    t.b.dispose();
    await settleLease();
    const again = keep(t.returned());
    expect(await again.initialize()).toMatchObject({
      interaction: 'completed',
    });
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: added.id, value: { kind: 'ready' } },
    ]);
  });

  it('keeps a sign-in on the other tab’s address that left for the Pod when this page is disposed', async () => {
    const t = await tabs(undefined, { rememberPods: false });
    const local = await t.b.connect(bob);
    const remembered = await t.a.connect(bob);
    await t.b.beginAuthorization(local.id);
    expect(t.navigate).toHaveBeenCalledTimes(1);
    t.b.dispose();
    await settleLease();
    const back = keep(t.returned());
    expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: remembered.id, value: { kind: 'ready' } },
    ]);
  });

  it('completes a sign-in pending in discovery with the session another tab stored meanwhile', async () => {
    let held!: ReturnType<typeof heldDiscovery>;
    const t = await tabs(undefined, ({ options }) => {
      // This tab's discovery of Bob's Pod waits.
      held = heldDiscovery(options.fetch!, bob);
      return { fetch: held.fetch };
    });
    const added = await t.a.connect(bob);
    await listedBeside(t.b, added.id);
    const pending = t.b.beginAuthorization(added.id);
    await vi.waitFor(() => expect(held.discovering()).toBe(true));
    // The first tab signs in to Bob's Pod meanwhile; the other one adopts it.
    await signInAgain(t, t.a, added.id, keep);
    // Restored there (its restoration waits for the same discovery).
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added.id,
        session: { kind: 'restoring' },
      }),
    );
    held.release();
    await expect(pending).resolves.toBeUndefined();
    expect(t.navigate).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        id: added.id,
        session: { kind: 'active' },
        reading: 'session',
      }),
    );
  });

  it('follows a sign-in another tab began meanwhile instead of replacing its attempt', async () => {
    let held!: ReturnType<typeof heldDiscovery>;
    const t = await tabs(undefined, ({ options }) => {
      held = heldDiscovery(options.fetch!, bob);
      return { fetch: held.fetch };
    });
    const added = await t.a.connect(bob);
    await listedBeside(t.b, added.id);
    const pending = t.b.beginAuthorization(added.id);
    await vi.waitFor(() => expect(held.discovering()).toBe(true));
    // The first tab leaves for Bob's Pod and has not come back yet.
    await t.a.beginAuthorization(added.id);
    const state = new URL(t.navigate.mock.calls[0]![0]).searchParams.get(
      'state',
    );
    // This tab lists that attempt while its own discovery still waits.
    await vi.waitFor(() =>
      expect(t.b.getSnapshot()[1]).toMatchObject({
        session: { kind: 'ended', problem: 'interrupted' },
      }),
    );
    held.release();
    await expect(pending).resolves.toBeUndefined();
    expect(t.navigate).toHaveBeenCalledTimes(1);
    expect(await savedRecords(t.factory)).toMatchObject([
      { id: added.id, value: { kind: 'authorizing', attempt: { state } } },
    ]);
  });

  it('cancels a sign-in pending in discovery when another tab forgets the Pod', async () => {
    let held!: ReturnType<typeof heldDiscovery>;
    const t = await tabs(undefined, ({ options }) => {
      held = heldDiscovery(options.fetch!, bob);
      return { fetch: held.fetch };
    });
    const added = await t.a.connect(bob);
    await listedBeside(t.b, added.id);
    const pending = t.b.beginAuthorization(added.id);
    await vi.waitFor(() => expect(held.discovering()).toBe(true));
    expect(await t.a.forget(added.id)).toEqual({ kind: 'disconnected' });
    await expect(pending).rejects.toMatchObject({ problem: 'disconnected' });
    held.release();
    expect(t.navigate).not.toHaveBeenCalled();
    expect(t.b.getSnapshot()).toHaveLength(1);
  });

  it('lists the remaining record when a start removes this tab’s as a duplicate', async () => {
    const t = await tabs();
    const added = await t.a.connect(bob);
    // A duplicate for Bob's Pod, which a start keeps before this tab's.
    const store = await t.options.openStore!(fixtureNamespace);
    await store.commit('0', null, {
      version: 1,
      kind: 'address',
      configKey: fixtureNamespace,
      connectionId: '0',
      podUrl: bob,
    });
    const third = keep(createBrowserRuntime(t.options));
    await third.initialize();
    await vi.waitFor(async () =>
      expect(await savedRecords(t.factory)).toMatchObject([{ id: '0' }]),
    );
    expect(added.id).not.toBe('0');
    await vi.waitFor(() =>
      expect(t.a.getSnapshot()[1]).toMatchObject({ id: '0', podUrl: bob }),
    );
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
