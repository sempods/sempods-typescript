// @vitest-environment jsdom
/**
 * The browser's leave prompt (#201): one `beforeunload` listener per
 * controller while a guard holds unsaved work, none while nothing does.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixture } from '../runtime/fixture.test.js';
import { createAppController, type LeaveGuard } from './app.js';

const cleanups: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function connected() {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  return { ...f, ...session };
}
/** Counts the `beforeunload` listeners added to `window` and not removed. */
function watchUnload() {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const of = (spy: typeof add | typeof remove) =>
    spy.mock.calls.filter(([type]) => type === 'beforeunload').length;
  return {
    added: () => of(add),
    listeners: () => of(add) - of(remove),
    /** Whether leaving the document now would ask. */
    asks() {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}
/** A host guard that reports its own changes. */
function hostGuard(scope?: LeaveGuard['scope']) {
  const listeners = new Set<() => void>();
  const state = { dirty: false, blocked: false };
  const guard: LeaveGuard = {
    ...(scope ? { scope } : {}),
    dirty: () => state.dirty,
    blocked: () => state.blocked,
    discard: vi.fn(() => {
      state.dirty = false;
    }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    guard,
    set(next: Partial<typeof state>) {
      Object.assign(state, next);
      listeners.forEach((listener) => listener());
    },
  };
}

it('shares one listener while any guard is dirty or blocked and removes it once none is', async () => {
  const f = await connected();
  const unload = watchUnload();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  const one = hostGuard();
  const two = hostGuard('target');
  app.register(one.guard);
  app.register(two.guard);
  expect(unload.listeners()).toBe(0);
  expect(unload.asks()).toBe(false);
  one.set({ dirty: true });
  expect(unload.listeners()).toBe(1);
  expect(unload.asks()).toBe(true);
  two.set({ dirty: true });
  // One saved, the other still unsaved: the same listener stays.
  one.set({ dirty: false });
  expect(unload.added()).toBe(1);
  expect(unload.asks()).toBe(true);
  two.set({ dirty: false });
  expect(unload.listeners()).toBe(0);
  expect(unload.asks()).toBe(false);
  // A pending write: leaving would lose its outcome.
  one.set({ blocked: true });
  expect(unload.asks()).toBe(true);
  one.set({ blocked: false });
  expect(unload.listeners()).toBe(0);
});

it('follows registration and the controller lifetime', async () => {
  const f = await connected();
  const unload = watchUnload();
  const app = createAppController(f.runtime);
  const draft = hostGuard();
  draft.set({ dirty: true });
  const unregister = app.register(draft.guard);
  // Not started: no listener yet.
  expect(unload.listeners()).toBe(0);
  app.start();
  cleanups.push(() => app.stop());
  expect(unload.asks()).toBe(true);
  unregister();
  expect(unload.listeners()).toBe(0);
  // Unregistered, its changes no longer reach the controller.
  draft.set({ dirty: true });
  expect(unload.listeners()).toBe(0);
  app.register(draft.guard);
  expect(unload.listeners()).toBe(1);
  app.stop();
  expect(unload.listeners()).toBe(0);
  expect(unload.asks()).toBe(false);
  app.start();
  expect(unload.listeners()).toBe(1);
});

it('reads a guard without subscribe again when the controller changes', async () => {
  const f = await connected();
  const unload = watchUnload();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  let dirty = false;
  app.register({ dirty: () => dirty, blocked: () => false, discard: vi.fn() });
  dirty = true;
  expect(unload.listeners()).toBe(0);
  const navigation = app.navigate(() => {});
  expect(app.getSnapshot().confirmingLeave).toBe(true);
  expect(unload.asks()).toBe(true);
  app.cancelLeave();
  expect(await navigation).toBe(false);
  expect(unload.asks()).toBe(true);
});

it('does not ask again during a confirmed sign-in about the drafts it discards', async () => {
  const f = await connected();
  const unload = watchUnload();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  await vi.waitFor(() => expect(app.getSnapshot().activeId).toBe(f.id));
  const draft = hostGuard();
  draft.set({ dirty: true });
  app.register(draft.guard);
  const asked: boolean[] = [];
  const failure = new Error('sign-in failed');
  const begin = vi
    .spyOn(f.runtime, 'beginAuthorization')
    .mockImplementation(() => {
      // The page would navigate to the Pod's sign-in here.
      asked.push(unload.asks());
      return asked.length === 1 ? Promise.reject(failure) : Promise.resolve();
    });
  // A failed action discards nothing: the prompt comes back.
  const failed = app.authorize(f.id);
  await expect(app.confirmLeave()).rejects.toBe(failure);
  expect(await failed).toBe(false);
  expect(unload.asks()).toBe(true);
  const signIn = app.authorize(f.id);
  await app.confirmLeave();
  expect(await signIn).toBe(true);
  expect(begin).toHaveBeenCalledTimes(2);
  expect(asked).toEqual([false, false]);
  expect(draft.guard.discard).toHaveBeenCalledOnce();
  expect(unload.listeners()).toBe(0);
});

it('keeps asking during row navigation about a draft it does not leave', async () => {
  const f = await connected();
  const unload = watchUnload();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  const row = hostGuard('local');
  const kept = hostGuard('target');
  row.set({ dirty: true });
  kept.set({ dirty: true });
  app.register(row.guard);
  app.register(kept.guard);
  const asked: boolean[] = [];
  const navigation = app.navigate(() => {
    asked.push(unload.asks());
  });
  await app.confirmLeave();
  expect(await navigation).toBe(true);
  expect(asked).toEqual([true]);
  expect(row.guard.discard).toHaveBeenCalledOnce();
  expect(kept.guard.discard).not.toHaveBeenCalled();
  expect(unload.asks()).toBe(true);
});

it('never adds a listener with unloadPrompt: false', async () => {
  const f = await connected();
  const unload = watchUnload();
  const app = createAppController(f.runtime, { unloadPrompt: false });
  app.start();
  cleanups.push(() => app.stop());
  const draft = hostGuard();
  app.register(draft.guard);
  draft.set({ dirty: true, blocked: true });
  expect(unload.added()).toBe(0);
  expect(unload.asks()).toBe(false);
});

it('gives each controller its own listener', async () => {
  const f = await connected();
  const unload = watchUnload();
  const first = createAppController(f.runtime);
  const second = createAppController(f.runtime);
  first.start();
  second.start();
  cleanups.push(
    () => first.stop(),
    () => second.stop(),
  );
  const one = hostGuard();
  const two = hostGuard();
  first.register(one.guard);
  second.register(two.guard);
  one.set({ dirty: true });
  two.set({ dirty: true });
  expect(unload.listeners()).toBe(2);
  one.set({ dirty: false });
  // The other controller's draft still asks.
  expect(unload.asks()).toBe(true);
  two.set({ dirty: false });
  expect(unload.asks()).toBe(false);
});
