import type { BoundView } from '../runtime/view.js';

// Only consumers of this exact bound target observe their own writes. This is
// not a server subscription, cache, or cross-target invalidation mechanism.
const listeners = new WeakMap<BoundView, Set<() => void>>();
export function observeWrites(view: BoundView, listener: () => void) {
  let entries = listeners.get(view);
  if (!entries) listeners.set(view, (entries = new Set()));
  entries.add(listener);
  return () => {
    entries.delete(listener);
  };
}
export function changed(view: BoundView) {
  for (const listener of listeners.get(view) ?? []) {
    try {
      listener();
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}
