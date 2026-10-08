import type { BoundView } from '../runtime/view.js';

// Only consumers of this exact bound target observe their own writes. This is
// not a server subscription, cache, or cross-target invalidation mechanism.
const listeners = new WeakMap<BoundView, Set<() => void>>();
// Counts writes started on this exact bound target. Feedback compares it with
// the count at its own start to retire a success once another write started;
// it never settles or clears an unresolved outcome.
const starts = new WeakMap<
  BoundView,
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
  let entries = listeners.get(view);
  if (!entries) listeners.set(view, (entries = new Set()));
  entries.add(listener);
  return () => {
    entries.delete(listener);
  };
}
export function changed(view: BoundView) {
  notify(listeners.get(view) ?? []);
}
function startsOf(view: BoundView) {
  let entry = starts.get(view);
  if (!entry) starts.set(view, (entry = { count: 0, listeners: new Set() }));
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
  return starts.get(view)?.count ?? 0;
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
