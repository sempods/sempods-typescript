/**
 * One lifetime rule for captured work (#274), without React: work bound to a
 * view lasts while the view is current, or while it still holds work and
 * its connection lost access without a new authorization.
 */
import { expect, it } from 'vitest';
import { fields, text, type CreateOutcome } from '@sempods/client-sdk/edit';
import type { AppController, LeaveGuard } from './app.js';
import type { Connection } from '../runtime/types.js';
import type { BoundView } from '../runtime/view.js';
import { CreationLane } from './creation-lane.js';
import { editorsOf } from './editors.js';
import { lanesOf } from './lanes.js';
import { keepsWork, originOf, sessionsOf } from './retention.js';
import { connectionRemovals } from '../runtime/removals.js';

const definition = fields({ title: text('urn:title', { language: null }) });
const work = 'https://pod.example/alice/_system/contexts/work';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** A controller, its active connection and views of one explicit Context. */
function fakes() {
  let reading: Connection['reading'] = 'session';
  let activeId: string | null = 'a';
  const listeners = new Set<() => void>();
  const guards = new Set<LeaveGuard>();
  const app = {
    getSnapshot: () => ({
      activeId,
      view: null,
      connections: [{ id: 'a', reading }],
      changing: false,
      confirmingLeave: false,
    }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    register(guard: LeaveGuard) {
      guards.add(guard);
      return () => guards.delete(guard);
    },
  } as unknown as AppController;
  const views: { current: boolean }[] = [];
  /** A view of `work`, current until `end()` (or `current` set). */
  const view = () => {
    const state = { current: true };
    views.push(state);
    return Object.assign(
      {
        podUrl: 'https://pod.example/alice',
        contextIri: work,
        getSnapshot: () => ({
          current: state.current,
          read: state.current,
          write: state.current,
        }),
        subscribe: () => () => {},
      } as unknown as BoundView,
      { state },
    );
  };
  const tell = () => listeners.forEach((listener) => listener());
  return {
    app,
    guards,
    view,
    /** The session ends: earlier views lose access, the connection reads as given. */
    end(next: Connection['reading']) {
      views.forEach((v) => (v.current = false));
      reading = next;
      tell();
    },
    /** A new session for the same connection. */
    signIn() {
      reading = 'session';
      tell();
    },
    activate(id: string | null) {
      activeId = id;
      tell();
    },
  };
}

it('keeps work only while access is lost without a new authorization', () => {
  const f = fakes();
  const view = f.view();
  expect(keepsWork(f.app, 'a', view, false)).toBe(true);
  f.end('anonymous');
  expect(keepsWork(f.app, 'a', view, false)).toBe(false);
  expect(keepsWork(f.app, 'a', view, true)).toBe(true);
  f.end(null);
  expect(keepsWork(f.app, 'a', view, true)).toBe(true);
  // A new authorization never adopts earlier work, also once that session
  // ends as well.
  f.signIn();
  expect(keepsWork(f.app, 'a', view, true)).toBe(false);
  f.end('anonymous');
  expect(keepsWork(f.app, 'a', view, true)).toBe(false);
  f.end(null);
  expect(keepsWork(f.app, 'a', view, true)).toBe(false);
  // Nor does another active connection.
  f.end('anonymous');
  f.activate('b');
  expect(keepsWork(f.app, 'a', view, true)).toBe(false);
});

it('finds a creation kept through access loss again through the view that replaced it', async () => {
  const f = fakes();
  const store = lanesOf(f.app);
  const before = f.view();
  const group = store.group(
    before,
    'forms',
    definition,
    'explicit',
    CreationLane,
  );
  const answer = deferred<CreateOutcome>();
  const sent = group
    .lane('form')
    .execute('create', 'urn:item', () => answer.promise);
  // Pending, the session ends; the form is gone (nothing holds the group).
  f.end('anonymous');
  expect(group.holds()).toBe(true);
  const after = f.view();
  expect(
    store.group(after, 'forms', definition, 'explicit', CreationLane),
  ).toBe(group);
  expect(store.kept('forms', 'explicit', work)).toBe(before);
  // The late answer is stored in one step from pending to unconfirmed.
  answer.resolve({ kind: 'unconfirmed' });
  expect(await sent).toEqual({ kind: 'unconfirmed' });
  expect(group.lanes.get('form')!.unresolved).toBe(true);
  expect(group.holds()).toBe(true);
  expect(f.guards.size).toBe(1);
  // Written only through its own view, which has no write access left.
  expect(
    await group.lane('form').execute('create', 'urn:item', async () => ({
      kind: 'created',
      iri: 'urn:item',
    })),
  ).toMatchObject({ kind: 'not-sent' });
  // Acknowledged, it is no work any more: the group retires, the guard goes.
  group.lanes.get('form')!.guard('explicit').discard();
  group.lanes.get('form')!.acknowledge();
  expect(group.holds()).toBe(false);
  expect(f.guards.size).toBe(0);
  expect(store.group(after, 'forms', definition, 'explicit')).not.toBe(group);
});

it('never hands kept work to a new authorization', async () => {
  const f = fakes();
  const store = lanesOf(f.app);
  const before = f.view();
  const group = store.group(before, 'rows', definition, 'explicit');
  await group
    .lane('urn:item')
    .execute('update', 'urn:item', async () => ({ kind: 'unconfirmed' }));
  f.end(null);
  expect(group.holds()).toBe(true);
  f.signIn();
  const after = f.view();
  const next = store.group(after, 'rows', definition, 'explicit');
  expect(next).not.toBe(group);
  expect(next.lanes.size).toBe(0);
  expect(group.holds()).toBe(false);
  expect(store.kept('rows', 'explicit', work)).toBeUndefined();
});

it('counts every new session of a connection, also while nobody renders', () => {
  const f = fakes();
  const sessions = sessionsOf(f.app);
  expect(sessionsOf(f.app)).toBe(sessions);
  expect(sessions('a')).toBe(0);
  // A session that ends, read without a token or not at all: no new one.
  f.end('anonymous');
  f.end(null);
  expect(sessions('a')).toBe(0);
  // A new session came, and went again: the count remembers it.
  f.signIn();
  f.end('anonymous');
  expect(sessions('a')).toBe(1);
  f.signIn();
  expect(sessions('a')).toBe(2);
  expect(sessions(null)).toBe(0);
});

/** A view of `work` that an editor can be bound to; its read never answers. */
function editable(f: ReturnType<typeof fakes>) {
  return Object.assign(f.view(), {
    subjects: { get: () => new Promise(() => {}) },
  });
}

it('ends an editor on screen once its connection has a new authorization (#408)', () => {
  const f = fakes();
  const store = editorsOf(f.app);
  const view = editable(f);
  // Held by a component, never released.
  store.claim(view, 'urn:item', 'title', definition, 'connection', 'explicit');
  expect(f.guards.size).toBe(1);
  // A session that ends by itself keeps it on screen.
  f.end('anonymous');
  expect(store.retains(work, 'urn:item', 'connection')).toBe(true);
  // A new sign-in (here from another tab) ends it, also while it is shown.
  f.signIn();
  expect(store.retains(work, 'urn:item', 'connection')).toBe(false);
  expect(f.guards.size).toBe(0);
});

it('keeps origin-bound work with its connection, not with its ID (#408)', async () => {
  const f = fakes();
  let removed = 0;
  const runtime = {};
  connectionRemovals.set(runtime, (id) => (id === 'a' ? removed : 0));
  Object.assign(f.app, { runtime });
  const view = editable(f);
  const life = originOf(f.app, 'a');
  // Rows and an editor bound to connection `a`.
  const group = lanesOf(f.app).group(
    view,
    'origin rows',
    definition,
    'explicit',
    undefined,
    'a',
  );
  await group
    .lane('urn:item')
    .execute('update', 'urn:item', async () => ({ kind: 'unconfirmed' }));
  editorsOf(f.app).claim(
    view,
    'urn:item',
    'title',
    definition,
    'connection',
    'explicit',
    'a',
  );
  expect([...f.guards].map((g) => g.connection)).toEqual(['a', 'a']);
  // Another active connection leaves it alone, also once access is lost.
  f.activate('b');
  f.end('anonymous');
  expect(keepsWork(f.app, 'a', view, true, life)).toBe(true);
  expect(group.holds()).toBe(true);
  expect(editorsOf(f.app).retains(work, 'urn:item', 'connection', 'a')).toBe(
    true,
  );
  // `a` is removed and added again under its ID: another connection.
  removed = 1;
  f.end('anonymous');
  expect(keepsWork(f.app, 'a', view, true, life)).toBe(false);
  expect(group.holds()).toBe(false);
  expect(editorsOf(f.app).retains(work, 'urn:item', 'connection', 'a')).toBe(
    false,
  );
  expect(f.guards.size).toBe(0);
});
