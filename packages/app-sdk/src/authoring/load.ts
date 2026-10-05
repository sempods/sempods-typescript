import type { QueryResult } from '@sempods/client-sdk';
import type { BoundRead, BoundView } from '../runtime/view.js';

export type LoadState<T> =
  | { readonly kind: 'loading' | 'cancelled' | 'unavailable' }
  | { readonly kind: 'ready'; readonly data: T }
  | { readonly kind: 'failed'; readonly error: unknown };
export type ViewRead<T> = (
  view: BoundView,
  signal: AbortSignal,
) => Promise<BoundRead<QueryResult<T>>>;

/**
 * One cancellable read, plus at most one same-target recovery retry per cycle.
 * The loader starts in `loading` without a request: call `reload()` to start
 * the first read (`useLoad` does this right after creating it).
 */
export function createViewLoader<T>(view: BoundView, read: ViewRead<T>) {
  let state: LoadState<T> = { kind: 'loading' };
  const listeners = new Set<() => void>();
  let abort = new AbortController();
  let serial = 0;
  let disposed = false;
  let cancelled = false;
  let retries = 0;
  let waiting = false;
  let running = false;
  let previous = view.getSnapshot();
  const emit = (next: LoadState<T>) => {
    state = Object.freeze(next);
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  };
  async function run(recovery: boolean) {
    if (disposed || cancelled) return;
    const access = view.getSnapshot();
    if (!access.current || !access.read) {
      waiting = access.current;
      emit({ kind: 'unavailable' });
      return;
    }
    if (recovery && retries++ >= 1) {
      serial++;
      abort.abort();
      running = false;
      waiting = false;
      emit({ kind: 'unavailable' });
      return;
    }
    abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    const ticket = ++serial;
    waiting = false;
    running = true;
    emit({ kind: 'loading' });
    try {
      const result = await read(view, signal);
      if (disposed || cancelled || ticket !== serial || signal.aborted) return;
      const now = view.getSnapshot();
      if (
        result.kind === 'invalidated' ||
        !now.current ||
        !now.read ||
        now.revision !== access.revision
      ) {
        waiting = now.current;
        emit({ kind: 'unavailable' });
        if (now.current && now.read) await run(true);
      } else if (result.kind === 'ok')
        emit({ kind: 'ready', data: result.body });
      else if (result.kind === 'cancelled') {
        cancelled = true;
        emit({ kind: 'cancelled' });
      } else emit({ kind: 'failed', error: result });
    } catch (error) {
      if (!disposed && !cancelled && ticket === serial && !signal.aborted)
        emit({ kind: 'failed', error });
    } finally {
      if (ticket === serial) running = false;
    }
  }
  const unsubscribe = view.subscribe(() => {
    const next = view.getSnapshot();
    if (!next.current || !next.read) {
      if (state.kind === 'ready') retries = 0;
      serial++;
      abort.abort();
      running = false;
      waiting = next.current && !cancelled;
      emit({ kind: cancelled ? 'cancelled' : 'unavailable' });
    } else if (
      !cancelled &&
      (waiting || (running && next.revision !== previous.revision))
    ) {
      void run(true);
    }
    previous = next;
  });
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reload() {
      cancelled = false;
      retries = 0;
      return run(false);
    },
    cancel() {
      cancelled = true;
      waiting = false;
      serial++;
      abort.abort();
      emit({ kind: 'cancelled' });
    },
    dispose() {
      disposed = true;
      serial++;
      abort.abort();
      unsubscribe();
      listeners.clear();
    },
  };
}
