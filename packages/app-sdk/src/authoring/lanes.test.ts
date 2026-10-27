/** The controller-owned lane store (#156), without React. */
import { expect, it } from 'vitest';
import { fields, text } from '@sempods/client-sdk/edit';
import type { AppController, LeaveGuard } from './app.js';
import type { BoundView } from '../runtime/view.js';
import { CreationLane } from './creation-lane.js';
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
    /** Selects another view without telling anyone yet, as a leave does. */
    select(next: unknown) {
      snapshot = { ...snapshot, view: next };
    },
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

const created = { iri: 'urn:new', run: async () => ({ kind: 'created' }) };
const creations = (f: ReturnType<typeof fakes>) =>
  lanesOf(f.app).group(f.view, 'k', definition, 'explicit', CreationLane);

it('keeps a creation held for a retry: never evicted, guarded until discarded', () => {
  const f = fakes();
  const group = creations(f);
  const lane = group.lane('form a');
  const captured = lane.capture({ title: 'New' }, created as never);
  (captured as { retry: boolean }).retry = true;
  for (let i = 0; i < 205; i++) group.lane(`form ${i}`);
  expect(group.lanes.get('form a')).toBe(lane);
  const guard = [...f.guards].find((g) => g.dirty());
  expect(guard).toBeDefined();
  // Discarding it on leave settles it.
  guard!.discard();
  expect(lane.captured).toBeNull();
  expect(captured.settled).toBe(true);
  expect(guard!.dirty()).toBe(false);
});

it.each([
  ['absent', true, { retry: true, settled: false }, true],
  ['present', false, { retry: false, settled: true }, false],
] as const)(
  'acknowledging a checked creation found %s holds or settles it',
  (_, absent, flags, kept) => {
    const f = fakes();
    const lane = creations(f).lane('form');
    const captured = lane.capture({ title: 'New' }, created as never);
    // An unconfirmed write, checked against the Pod.
    Object.assign(lane, { unresolved: true, checked: true, absent });
    expect(lane.open()).toBe(captured);
    lane.resolve();
    expect(captured).toMatchObject(flags);
    expect(lane.unresolved).toBe(false);
    // The same object stays held for the retry, so every form shows it.
    expect(lane.captured).toBe(kept ? captured : null);
    expect(lane.open()).toBe(kept ? captured : null);
  },
);

it('a discard after its target changed still clears the outcome and notifies', () => {
  const f = fakes();
  f.select(f.view);
  const group = lanesOf(f.app).group(f.view, 'rows', definition, 'target');
  const lane = group.lane('urn:one');
  Object.assign(lane, {
    unresolved: true,
    state: {
      operation: 'update',
      outcome: { kind: 'unconfirmed' },
      busy: false,
      start: 0,
    },
  });
  let notified = 0;
  group.subscribe(() => notified++);
  const guard = [...f.guards][0]!;
  expect(guard.dirty()).toBe(true);
  // A leave runs its action (another view) first, then discards.
  f.select(null);
  guard.discard();
  expect(lane.unresolved).toBe(false);
  expect(lane.state).toBeNull();
  expect(notified).toBe(1);
});

it('keeps the bound also when writes started together settle later', () => {
  const f = fakes();
  const group = lanesOf(f.app).group(f.view, 'k', definition, 'explicit');
  // Each one unresolved at once, so creating the next evicts nothing.
  const lanes = Array.from({ length: 205 }, (_, i) => {
    const lane = group.lane(`urn:${i}`);
    lane.unresolved = true;
    return lane;
  });
  expect(group.lanes.size).toBe(205);
  lanes.forEach((lane) => lane.acknowledge());
  expect(group.lanes.size).toBe(200);
  expect(f.guards.size).toBe(200);
  expect(group.lanes.has('urn:0')).toBe(false);
});
