/** The controller-owned lane store (#156), without React. */
import { expect, it } from 'vitest';
import { fields, text } from '@sempods/client-sdk/edit';
import type { AppController, LeaveGuard } from './app.js';
import type { BoundView } from '../runtime/view.js';
import { lanesOf } from './lanes.js';

const definition = fields({ title: text('urn:title', { language: null }) });

/** A controller and an explicit view, just as much as the store reads. */
function fakes() {
  let snapshot = { activeId: 'a' as string | null, view: null as unknown };
  const appListeners = new Set<() => void>();
  const guards = new Set<LeaveGuard>();
  const app = {
    getSnapshot: () => ({
      ...snapshot,
      changing: false,
      confirmingLeave: false,
    }),
    subscribe(listener: () => void) {
      appListeners.add(listener);
      return () => appListeners.delete(listener);
    },
    register(guard: LeaveGuard) {
      guards.add(guard);
      return () => guards.delete(guard);
    },
  } as unknown as AppController;
  const view = {
    podUrl: 'https://pod.example/alice',
    contextIri: 'https://pod.example/alice/_system/contexts/work',
    getSnapshot: () => ({ current: true, read: true, write: true }),
    subscribe: () => () => {},
  } as unknown as BoundView;
  return {
    app,
    view,
    guards,
    activate(id: string | null) {
      snapshot = { ...snapshot, activeId: id };
      appListeners.forEach((listener) => listener());
    },
  };
}

it('retires an explicit group when another connection becomes active', () => {
  const f = fakes();
  const group = lanesOf(f.app).group(f.view, 'k', definition, 'explicit');
  group.lane('urn:one');
  expect(f.guards.size).toBe(1);
  expect(group.holds()).toBe(true);
  // An unguarded change of the active connection: its guards must go.
  f.activate('b');
  expect(group.holds()).toBe(false);
  expect(f.guards.size).toBe(0);
  // The next lookup starts a fresh group for the same view.
  f.activate('a');
  expect(lanesOf(f.app).group(f.view, 'k', definition, 'explicit')).not.toBe(
    group,
  );
});

it('keeps a group, its lanes and guards while nothing subscribes', () => {
  const f = fakes();
  const store = lanesOf(f.app);
  const group = store.group(f.view, 'k', definition, 'explicit');
  const lane = group.lane('urn:one');
  const stop = group.subscribe(() => {});
  stop();
  expect(store.group(f.view, 'k', definition, 'explicit')).toBe(group);
  expect(group.lanes.get('urn:one')).toBe(lane);
  expect(f.guards.size).toBe(1);
});

it('keeps at most 200 settled lanes and evicts the oldest first', () => {
  const f = fakes();
  const group = lanesOf(f.app).group(f.view, 'k', definition, 'explicit');
  for (let i = 0; i < 205; i++) group.lane(`urn:${i}`);
  expect(group.lanes.size).toBe(200);
  expect(group.lanes.has('urn:0')).toBe(false);
  expect(group.lanes.has('urn:204')).toBe(true);
  expect(f.guards.size).toBe(200);
});

it('keeps a lane held for an explicit retry: adoptable, never evicted, guarded', () => {
  const f = fakes();
  const group = lanesOf(f.app).group(f.view, 'k', definition, 'explicit');
  // Settled and acknowledged, but its form holds the item for a retry.
  group.lane('form a').held = { retry: true };
  for (let i = 0; i < 205; i++) group.lane(`form ${i}`);
  expect(group.lanes.has('form a')).toBe(true);
  expect(group.orphan('form ')).toBe('form a');
  const guard = [...f.guards].find((g) => g.dirty());
  expect(guard).toBeDefined();
  // Discarding it on leave lets it go.
  guard!.discard();
  expect(group.lane('form a').held).toBeNull();
  expect(group.orphan('form ')).toBeNull();
});
