import type { AppController } from './app.js';
import type { BoundView } from '../runtime/view.js';

/**
 * Internal: the one lifetime rule for captured work (resource editors,
 * creations and row updates) that the controller's stores share.
 *
 * Work is bound to the view it was captured with: that view is its origin
 * and its only write authority. It lasts while the view is current. Once the
 * view is no longer current, it lasts only while it still holds work (a
 * draft, a pending write, an unconfirmed or changed outcome) and its
 * connection lost access without a new authorization: the session ended, it
 * is restoring or leaving for a sign-in, or it reads without a token
 * (`signIn: 'optional'`). Showing, hiding or unmounting a component is no
 * part of it. A new session for the connection, another active connection
 * or controller disposal ends it: earlier work is never adopted by a new
 * authorization, and gets no write authority back. Once a view saw a new
 * session, its work is never kept again, also after that session ended too.
 */
export function keepsWork(
  app: AppController,
  connection: string | null,
  view: BoundView,
  working: boolean,
) {
  if (app.getSnapshot().activeId !== connection) return false;
  if (view.getSnapshot().current) return true;
  if (!accessLost(app, connection)) {
    superseded.add(view);
    return false;
  }
  return working && !superseded.has(view);
}
/** Views a new authorization came after: their work is never kept again. */
const superseded = new WeakSet<BoundView>();

/**
 * Whether a connection's access ended without a new authorization: it reads
 * without a session (without a token, or not at all).
 */
export function accessLost(app: AppController, connection: string | null) {
  const found = app
    .getSnapshot()
    .connections.find((entry) => entry.id === connection);
  return found !== undefined && found.reading !== 'session';
}

/**
 * Internal: how many sessions each connection has begun since this
 * controller was first asked, counted from the controller's own snapshots,
 * so also while the screen that asks is hidden. Work captured under one
 * count belongs to that authorization: a higher count means a new session
 * came in between.
 */
export function sessionsOf(
  app: AppController,
): (connection: string | null) => number {
  const known = counters.get(app);
  if (known) return known;
  const counts = new Map<string, number>();
  const readings = new Map<string, unknown>();
  const observe = () => {
    for (const entry of app.getSnapshot().connections) {
      const before = readings.get(entry.id);
      if (
        entry.reading === 'session' &&
        readings.has(entry.id) &&
        before !== 'session'
      )
        counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
      readings.set(entry.id, entry.reading);
    }
  };
  observe();
  app.subscribe(observe);
  const count = (connection: string | null) =>
    connection === null ? 0 : (counts.get(connection) ?? 0);
  counters.set(app, count);
  return count;
}
const counters = new WeakMap<
  AppController,
  (connection: string | null) => number
>();

/** Whether two views address the same Context of the same Pod. */
export function sameTarget(a: BoundView, b: BoundView) {
  return a.podUrl === b.podUrl && a.contextIri === b.contextIri;
}
