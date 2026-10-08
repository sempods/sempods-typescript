import type { BoundView } from '../runtime/view.js';
import { observationOf } from '../runtime/binding.js';

// Consumers of one bound target observe its own writes: one Context of one
// connection's authorization lifetime, across its selected and explicit
// handles. This is not a server subscription, cache, or invalidation across
// Contexts, connections, subjects or generations.
const listeners = new WeakMap<object, Set<() => void>>();
// Counts writes started on that target. Feedback compares it with the count at
// its own start to retire a success once another write started; it never
// settles or clears an unresolved outcome.
const starts = new WeakMap<
  object,
  { count: number; readonly listeners: Set<() => void> }
>();
function notify(entries: Iterable<() => void>) {
  for (const listener of entries) {
    try {
      listener();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
export function observeWrites(view: BoundView, listener: () => void) {
  const target = observationOf(view);
  let entries = listeners.get(target);
  if (!entries) listeners.set(target, (entries = new Set()));
  entries.add(listener);
  return () => {
    entries.delete(listener);
  };
}
export function changed(view: BoundView) {
  notify(listeners.get(observationOf(view)) ?? []);
}
function startsOf(view: BoundView) {
  const target = observationOf(view);
  let entry = starts.get(target);
  if (!entry) starts.set(target, (entry = { count: 0, listeners: new Set() }));
  return entry;
}
export function observeStarts(view: BoundView, listener: () => void) {
  const { listeners } = startsOf(view);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** The number of writes started on this target so far. */
export function startCount(view: BoundView) {
  return starts.get(observationOf(view))?.count ?? 0;
}
/** Records a started write and returns the new count. */
export function started(view: BoundView) {
  const entry = startsOf(view);
  const count = ++entry.count;
  notify([...entry.listeners]);
  return count;
}
/** A settled success, which the next write started on the target retires. */
export const succeeded = (outcome: { readonly kind: string } | null) =>
  outcome?.kind === 'created' ||
  outcome?.kind === 'saved' ||
  outcome?.kind === 'removed';
