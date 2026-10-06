import type { QueryResult } from '@sempods/client-sdk';
import type { BoundPod, BoundRead, BoundView } from '../runtime/view.js';

export type LoadState<T> =
  | { readonly kind: 'loading' | 'cancelled' | 'unavailable' }
  | { readonly kind: 'ready'; readonly data: T }
  | { readonly kind: 'failed'; readonly error: unknown };
export type ViewRead<T> = (
  view: BoundView,
  signal: AbortSignal,
) => Promise<BoundRead<QueryResult<T>>>;
/** A read of the authorized Pod dataset; never selects a Context or discovers a catalogue. */
export type PodRead<T> = (
  pod: BoundPod,
  signal: AbortSignal,
) => Promise<BoundRead<QueryResult<T>>>;
interface ViewLoader<T> {
  getSnapshot(): LoadState<T>;
  subscribe(listener: () => void): () => void;
  reload(): Promise<void>;
  cancel(): void;
  dispose(): void;
}

/**
 * One cancellable read, plus at most one same-target recovery retry per cycle.
 * The loader starts in `loading` without a request: call `reload()` to start
 * the first read (`useLoad` and `usePodLoad` do this after creating it).
 * The callback receives exactly the supplied handle type. Recovery reuses that
 * handle and callback; a Context read never falls back to a Pod read.
 * Changed grants refresh ready Pod data; failed operations wait for explicit
 * reload or a new handle rather than automatically repeating a refusal.
 */
export function createViewLoader<T>(
  view: BoundView,
  read: ViewRead<T>,
): ViewLoader<T>;
export function createViewLoader<T>(
  pod: BoundPod,
  read: PodRead<T>,
): ViewLoader<T>;
export function createViewLoader<T, H extends BoundView | BoundPod = BoundView>(
  view: H,
  read: (handle: H, signal: AbortSignal) => Promise<BoundRead<QueryResult<T>>>,
): ViewLoader<T>;
export function createViewLoader<T, H extends BoundView | BoundPod>(
  view: H,
  read: (handle: H, signal: AbortSignal) => Promise<BoundRead<QueryResult<T>>>,
) {
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
      (waiting ||
        (next.revision !== previous.revision &&
          (running || (!('contextIri' in view) && state.kind === 'ready'))))
    ) {
      // A completed Pod result belongs to its grants; a new access change starts
      // a fresh bounded cycle. Context write-only changes retain displayed data.
      if (state.kind === 'ready') retries = 0;
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
