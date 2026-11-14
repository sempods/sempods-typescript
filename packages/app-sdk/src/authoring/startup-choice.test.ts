/**
 * Which connection becomes active at startup with several saved Pods (#305):
 * the one the app last worked with, and a working one in its place while the
 * startup choice is open. Two Pods signed in, then a reload whose discovery
 * is controlled per Pod.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import {
  deferred,
  fixtureNamespace,
  jwt,
  memoryStorage,
  settleLease,
  twoPods,
  without,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
} from '../runtime/types.js';
import { createAppController, type AppSnapshot } from './app.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const keep = (r: BrowserRuntime) => cleanups.push(() => r.dispose());
const activeKey = '@sempods/app-sdk:active:' + fixtureNamespace;

/**
 * Alice and Bob signed in, without a preset unless `overrides` sets one;
 * `preferences` keeps what a controller remembers across reloads.
 */
async function signedIn(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const preferences = memoryStorage();
  const pods = await twoPods(keep, {
    ...without('preset'),
    preferences,
    ...overrides,
  });
  const bob = pods.runtime.getSnapshot().find((c) => c.id === pods.other.id)!;
  const alice = pods.runtime.getSnapshot().find((c) => c.id !== bob.id)!;
  return { ...pods, alice, bob, preferences };
}
type Pods = Awaited<ReturnType<typeof signedIn>>;
/** Each Pod's discovery on the next start: answered, refused, or held. */
type Discovery = 'answer' | 'hold' | 'refuse';
/** A reload: a new runtime and controller, discovery per Pod URL. */
async function reload(
  pods: Pods,
  discovery: Record<string, Discovery> = {},
  overrides: Partial<BrowserRuntimeOptions> = {},
  before?: (app: ReturnType<typeof createAppController>) => void,
) {
  pods.runtime.dispose();
  await settleLease();
  const held = new Map<string, ReturnType<typeof deferred<boolean>>>();
  const gate = (base: string) => {
    let entry = held.get(base);
    if (!entry) held.set(base, (entry = deferred<boolean>()));
    return entry;
  };
  const fetch: PodFetch = async (url, init) => {
    const base = url.split('/.well-known')[0]!;
    const mode = url.includes('/.well-known/oauth-protected-resource')
      ? (discovery[base] ?? 'answer')
      : 'answer';
    if (mode === 'hold' && !(await gate(base).promise))
      return new Response(null, { status: 404 });
    if (mode === 'refuse') return new Response(null, { status: 404 });
    return pods.f.fetch(url, init);
  };
  const runtime = createBrowserRuntime({
    ...pods.f.options,
    location: () => 'https://app.example/',
    fetch,
    ...overrides,
  });
  keep(runtime);
  const app = createAppController(runtime);
  const seen: AppSnapshot[] = [];
  cleanups.push(app.subscribe(() => seen.push(app.getSnapshot())));
  before?.(app);
  app.start();
  cleanups.push(() => app.stop());
  await until(() => app.getSnapshot().startup !== undefined);
  return {
    runtime,
    app,
    seen,
    /** Answers (`true`) or refuses a held discovery. */
    release: (base: string, answer = true) => gate(base).resolve(answer),
    session: (id: string) =>
      app.getSnapshot().connections.find((c) => c.id === id)?.session,
  };
}
/** Waits without advancing fake timers, as `vi.waitFor` would. */
async function until(done: () => boolean) {
  for (let i = 0; !done(); i++) {
    if (i > 10_000) throw new Error('never happened');
    await new Promise((resolve) => setImmediate(resolve));
  }
}
const settled = (app: ReturnType<typeof createAppController>) =>
  vi.waitFor(() =>
    expect(
      app.getSnapshot().connections.map((c) => c.session.kind),
    ).not.toContain('restoring'),
  );
/** Starts a controller on the current runtime, so it remembers its connection. */
async function worked(pods: Pods, id?: string) {
  const app = createAppController(pods.runtime);
  app.start();
  await vi.waitFor(() => expect(app.getSnapshot().startup).toBeDefined());
  if (id) expect(await app.selectConnection(id)).toBe(true);
  app.stop();
}

it('prefers the connection the app last worked with, in either store order', async () => {
  const pods = await signedIn();
  // Bob's completed sign-in made him active.
  await worked(pods);
  expect(pods.preferences.map.get(activeKey)).toBe(pods.bob.id);
  const first = await reload(pods);
  await settled(first.app);
  expect(first.app.getSnapshot().activeId).toBe(pods.bob.id);
  // The person chooses Alice; the next start prefers her.
  expect(await first.app.selectConnection(pods.alice.id)).toBe(true);
  expect(pods.preferences.map.get(activeKey)).toBe(pods.alice.id);
  first.app.stop();
  const second = await reload({ ...pods, runtime: first.runtime });
  await settled(second.app);
  expect(second.app.getSnapshot().activeId).toBe(pods.alice.id);
});

it('keeps the store order without a remembered connection', async () => {
  const pods = await signedIn({ preferences: null });
  const { app } = await reload(pods);
  const order = app.getSnapshot().connections.map((c) => c.id);
  expect(app.getSnapshot().activeId).toBe(order[0]);
});

it('falls back to a working Pod when the remembered one ends at restoration', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app, seen, session } = await reload(pods, {
    [pods.alice.podUrl]: 'refuse',
  });
  await settled(app);
  expect(session(pods.alice.id)?.kind).toBe('ended');
  expect(app.getSnapshot().activeId).toBe(pods.bob.id);
  expect(seen.every((s) => s.access.blocking === null)).toBe(true);
  expect(app.getSnapshot().access.prompts).toEqual([
    expect.objectContaining({
      reason: 'signed-out',
      severity: 'action',
      connectionId: pods.alice.id,
      actions: ['sign-in', 'forget', 'dismiss'],
    }),
  ]);
  // A stand-in is not remembered: Alice stays preferred.
  expect(pods.preferences.map.get(activeKey)).toBe(pods.alice.id);
});

it('waits for another restoring Pod before an ended remembered one blocks', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app, seen, release } = await reload(pods, {
    [pods.alice.podUrl]: 'refuse',
    [pods.bob.podUrl]: 'hold',
  });
  await vi.waitFor(() =>
    expect(
      app.getSnapshot().connections.find((c) => c.id === pods.alice.id)?.session
        .kind,
    ).toBe('ended'),
  );
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  expect(app.getSnapshot().access.pending).toBe(true);
  release(pods.bob.podUrl);
  await settled(app);
  expect(app.getSnapshot().activeId).toBe(pods.bob.id);
  expect(seen.every((s) => s.access.blocking === null)).toBe(true);
});

it('shows the gate when no other Pod can work', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app, release } = await reload(pods, {
    [pods.alice.podUrl]: 'refuse',
    [pods.bob.podUrl]: 'hold',
  });
  release(pods.bob.podUrl, false);
  await settled(app);
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  expect(app.getSnapshot().access.blocking).toMatchObject({
    reason: 'signed-out',
    connectionId: pods.alice.id,
  });
});

it('switches after the grace period while the remembered one still restores, and never back', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app, release, session } = await reload(
    pods,
    { [pods.alice.podUrl]: 'hold' },
    {},
    // Only the controller's grace timer and the held discovery's deadline
    // are faked; storage and the fixture keep running.
    () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }),
  );
  await until(() => session(pods.bob.id)?.kind === 'active');
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  vi.advanceTimersByTime(4_900);
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  vi.advanceTimersByTime(200);
  expect(app.getSnapshot().activeId).toBe(pods.bob.id);
  vi.useRealTimers();
  release(pods.alice.podUrl);
  await settled(app);
  expect(session(pods.alice.id)?.kind).toBe('active');
  expect(app.getSnapshot().activeId).toBe(pods.bob.id);
  // Alice works but is not active: no prompt about her.
  expect(app.getSnapshot().access.prompts).toEqual([]);
  expect(pods.preferences.map.get(activeKey)).toBe(pods.alice.id);
});

it('gives way when the remembered connection lacks a required scope', async () => {
  const pods = await signedIn({ scopes: { required: ['tasks'] } });
  // Bob signed in with the scope, Alice without it.
  pods.f.setToken(async () =>
    Response.json({
      access_token: jwt({ iss: pods.bob.podUrl, scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'fresh',
    }),
  );
  const { runtime: before } = pods;
  await before.beginAuthorization(pods.bob.id);
  before.dispose();
  await settleLease();
  const returned = pods.f.returned();
  keep(returned);
  await returned.initialize();
  await vi.waitFor(() =>
    expect(
      returned.getSnapshot().find((c) => c.id === pods.alice.id)?.session.kind,
    ).toBe('active'),
  );
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app, seen } = await reload({ ...pods, runtime: returned });
  await settled(app);
  expect(app.getSnapshot().activeId).toBe(pods.bob.id);
  expect(seen.every((s) => s.access.blocking === null)).toBe(true);
  expect(app.getSnapshot().access.prompts).toEqual([
    expect.objectContaining({
      reason: 'missing-scopes',
      severity: 'action',
      connectionId: pods.alice.id,
    }),
  ]);
});

it('does not switch once the person acted', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app, release, session } = await reload(pods, {
    [pods.alice.podUrl]: 'hold',
  });
  await vi.waitFor(() => expect(session(pods.bob.id)?.kind).toBe('active'));
  expect(await app.navigate(() => {})).toBe(true);
  release(pods.alice.podUrl, false);
  await settled(app);
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  expect(app.getSnapshot().access.blocking).toMatchObject({
    reason: 'signed-out',
    connectionId: pods.alice.id,
  });
});

it('does not switch away from a connection the person chose', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.bob.id);
  const { app, release, session } = await reload(pods, {
    [pods.alice.podUrl]: 'hold',
  });
  await vi.waitFor(() => expect(session(pods.bob.id)?.kind).toBe('active'));
  expect(await app.selectConnection(pods.alice.id)).toBe(true);
  release(pods.alice.podUrl, false);
  await settled(app);
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  expect(app.getSnapshot().access.blocking).toMatchObject({
    connectionId: pods.alice.id,
  });
});

it('does not switch while a guard holds work', async () => {
  const pods = await signedIn();
  pods.preferences.map.set(activeKey, pods.alice.id);
  const { app } = await reload(
    pods,
    { [pods.alice.podUrl]: 'refuse' },
    {},
    (app) => {
      app.register({
        scope: 'explicit',
        dirty: () => true,
        blocked: () => false,
        discard: vi.fn(),
      });
    },
  );
  await settled(app);
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  expect(app.getSnapshot().access.blocking).toMatchObject({
    reason: 'signed-out',
    connectionId: pods.alice.id,
  });
});

it('never falls back to a Pod outside the preset', async () => {
  const pods = await signedIn({
    preset: { podUrl: 'https://pod.example/alice' },
  });
  pods.preferences.map.set(activeKey, pods.bob.id);
  const { app, seen } = await reload(pods, {
    [pods.alice.podUrl]: 'refuse',
  });
  await settled(app);
  expect(seen.every((s) => s.activeId !== pods.bob.id)).toBe(true);
  expect(app.getSnapshot().activeId).toBe(pods.alice.id);
  expect(app.getSnapshot().access.blocking).toMatchObject({
    connectionId: pods.alice.id,
  });
});
