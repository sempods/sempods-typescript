import type { QueryResult } from '@sempods/client-sdk';
import type { BoundPod, BoundRead, BoundView } from '../runtime/view.js';
import { watchAdmission } from '../runtime/admission-notice.js';

/**
 * What a loader shows for its latest read. `ok` becomes `ready`; `cancelled`
 * stays `cancelled` until reload; `invalidated`, or lost read access or a
 * changed access revision while the read runs, become `unavailable` (one
 * same-target retry). Any other result, such as `refused`, becomes `failed`
 * with that result as `error`; a thrown error becomes `failed` with the thrown
 * value. After settling, lost read access makes a loader `unavailable` unless
 * it is `cancelled`, which stays until reload; a later revision change starts
 * a fresh cycle for a ready Pod loader, while a ready Context loader keeps its
 * data.
 */
export type LoadState<T> =
  | {
      readonly kind: 'loading';
      /** Retained data (`retain`) shown while the same target reloads. */
      readonly previous?: T;
    }
  | { readonly kind: 'cancelled' | 'unavailable' }
  | { readonly kind: 'ready'; readonly data: T }
  | {
      readonly kind: 'failed';
      readonly error: unknown;
      /**
       * Retained data (`retain`) from before this failed refresh: still
       * readable, but not confirmed by it. Show it as such, with a retry.
       */
      readonly previous?: T;
    };
/** What to show: ready data, or `previous` kept while reloading or after a failed refresh. */
export function shownData<T>(state: LoadState<T>): T | undefined {
  return state.kind === 'ready'
    ? state.data
    : 'previous' in state
      ? state.previous
      : undefined;
}
/**
 * `retain` keeps the last ready data of a loader as `previous` while the same
 * target reloads and after a refresh that failed. It is read at each
 * (re)load. Retained data is dropped when read access is lost, the loader is
 * cancelled, a Pod loader's grants change, or a new handle (connection,
 * authorization, target) replaces the loader; a late result never replaces it.
 */
export interface LoaderOptions {
  readonly retain?: boolean;
}
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
  /** `fresh` drops retained data first, for a read whose inputs changed. */
  reload(options?: { readonly fresh?: boolean }): Promise<void>;
  cancel(): void;
  dispose(): void;
}
/** A loader of a `BoundPod`, whose reads can wait for a `podReadLimit` slot. */
interface PodLoader<T> extends ViewLoader<T> {
  /**
   * `'current'` for what the person looks at now: this loader's waiting
   * reads go first, in place, and its later reads start with it, as if they
   * passed `priority: 'current'`; `undefined` makes them normal reads again.
   * It never restarts, aborts or sends a read: a waiting read keeps its place
   * and is not sent twice, and an admitted read keeps its request and
   * signal. It reaches only reads that carry this loader's `signal`
   * unchanged; a read's own `priority: 'current'` stays. After `dispose()` it
   * does nothing. Without `podReadLimit` nothing waits, so it changes nothing.
   */
  setPriority(priority: 'current' | undefined): void;
}

/**
 * One cancellable read, plus at most one same-target recovery retry per cycle.
 * A read that only waits for a `podReadLimit` slot has sent nothing, so a
 * grant change while it waits restarts it on the current grants without
 * spending that retry; pass the callback's `signal` to the read unchanged.
 * The loader starts in `loading` without a request: call `reload()` to start
 * the first read (`useLoad` and `usePodLoad` do this after creating it).
 * The callback receives exactly the supplied handle type. Recovery reuses that
 * handle and callback; a Context read never falls back to a Pod read.
 * Changed grants refresh ready Pod data; failed operations wait for explicit
 * reload or a new handle rather than automatically repeating a refusal.
 * A Pod loader's `setPriority` changes the priority of its waiting reads in
 * place, without restarting them.
 */
export function createViewLoader<T>(
  view: BoundView,
  read: ViewRead<T>,
  options?: LoaderOptions,
): ViewLoader<T>;
export function createViewLoader<T>(
  pod: BoundPod,
  read: PodRead<T>,
  options?: LoaderOptions,
): PodLoader<T>;
export function createViewLoader<T, H extends BoundView | BoundPod = BoundView>(
  view: H,
  read: (handle: H, signal: AbortSignal) => Promise<BoundRead<QueryResult<T>>>,
  options?: LoaderOptions,
): ViewLoader<T>;
export function createViewLoader<T, H extends BoundView | BoundPod>(
  view: H,
  read: (handle: H, signal: AbortSignal) => Promise<BoundRead<QueryResult<T>>>,
  options: LoaderOptions = {},
) {
  return createLoader(view, read, options);
}
/**
 * `createViewLoader` for either handle type, with `setPriority` (which does
 * nothing for a Context loader: its reads are not admitted). Internal.
 */
export function createLoader<T, H extends BoundView | BoundPod>(
  view: H,
  read: (handle: H, signal: AbortSignal) => Promise<BoundRead<QueryResult<T>>>,
  options: LoaderOptions = {},
): PodLoader<T> {
  let state: LoadState<T> = { kind: 'loading' };
  /** The last ready data and the access revision it was read under. */
  let kept: { readonly data: T; readonly revision: number } | undefined;
  const pod = !('contextIri' in view);
  /** Retained data for a read under `revision`, if it still applies. */
  function retained(revision: number) {
    if (!options.retain || !kept) return {};
    // A Pod result belongs to its grants; a Context's revision also moves
    // for write-only changes, which keep its displayed data.
    if (pod && kept.revision !== revision) {
      kept = undefined;
      return {};
    }
    return { previous: kept.data };
  }
  const listeners = new Set<() => void>();
  let abort = new AbortController();
  let serial = 0;
  let disposed = false;
  let cancelled = false;
  let retries = 0;
  let waiting = false;
  let running = false;
  /**
   * What `podReadLimit` admission did with the current run's reads: `queued`
   * while they only waited for a slot, so nothing was sent yet. Restarting
   * such a run is not a recovery and spends no retry.
   */
  let admission: 'unknown' | 'queued' | 'admitted' = 'unknown';
  /** `setPriority`: asked by admission while this loader's reads wait. */
  let current = false;
  const spends = () => admission !== 'queued';
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
      kept = undefined;
      emit({ kind: 'unavailable' });
      return;
    }
    if (recovery && retries++ >= 1) {
      serial++;
      abort.abort();
      running = false;
      waiting = false;
      kept = undefined;
      emit({ kind: 'unavailable' });
      return;
    }
    abort.abort();
    abort = new AbortController();
    const signal = abort.signal;
    const ticket = ++serial;
    admission = 'unknown';
    watchAdmission(
      signal,
      (event) => {
        if (ticket !== serial) return;
        if (event === 'admitted') admission = 'admitted';
        else if (admission === 'unknown') admission = 'queued';
      },
      // Only the current run's reads follow it; `dispose`, `cancel` and a
      // reload supersede a run.
      () => current && ticket === serial,
    );
    waiting = false;
    running = true;
    emit({ kind: 'loading', ...retained(access.revision) });
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
        kept = undefined;
        emit({ kind: 'unavailable' });
        if (now.current && now.read) await run(spends());
      } else if (result.kind === 'ok') {
        kept = { data: result.body, revision: access.revision };
        emit({ kind: 'ready', data: result.body });
      } else if (result.kind === 'cancelled') {
        cancelled = true;
        kept = undefined;
        emit({ kind: 'cancelled' });
      } else
        emit({ kind: 'failed', error: result, ...retained(access.revision) });
    } catch (error) {
      if (!disposed && !cancelled && ticket === serial && !signal.aborted)
        emit({ kind: 'failed', error, ...retained(access.revision) });
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
      kept = undefined;
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
      void run(spends());
    }
    // Retained Pod data belongs to its grants, also while a failed refresh
    // waits for an explicit retry.
    if (pod && kept && next.revision !== kept.revision) {
      kept = undefined;
      if (state.kind === 'failed' && 'previous' in state)
        emit({ kind: 'failed', error: state.error });
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
    reload({ fresh = false }: { readonly fresh?: boolean } = {}) {
      cancelled = false;
      retries = 0;
      if (fresh) kept = undefined;
      return run(false);
    },
    cancel() {
      cancelled = true;
      waiting = false;
      serial++;
      abort.abort();
      kept = undefined;
      emit({ kind: 'cancelled' });
    },
    setPriority(priority: 'current' | undefined) {
      if (!disposed) current = priority === 'current';
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
