import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import {
  listSubjects,
  type FieldDefinition,
  type Snapshot,
  type SnapshotList,
} from '@sempods/client-sdk/edit';
import {
  RuntimeError,
  createViewLoader,
  type BoundView,
  type LoadState,
} from '../index.js';
import { shownData } from '../authoring/load.js';
import { observePodWrites, observeWrites } from '../authoring/changes.js';
import {
  shallowEqual,
  useAppFacts,
  useContextDiscovery,
  useController,
} from './app.js';
import { knownContexts } from './access-presentation.js';
import { contextName } from './names.js';
import {
  useDefinition,
  usePodLoad,
  type ContextEditorProblem,
} from './hooks.js';

/** One item of an overview: a snapshot read in its own Context. */
export interface PodListItem<D> {
  readonly context: string;
  readonly snapshot: Snapshot<D>;
}
/** The overview's items across Contexts, and the entries it cannot show. */
export interface PodListData<D> {
  readonly items: readonly PodListItem<D>[];
  readonly skipped: number;
}
/** One Context that holds the type: its own read, problem and retry. */
export interface PodListContext<D> {
  readonly context: string;
  /** Its label, else a readable last path segment. */
  readonly name: string;
  /** This Context's read; kept rows stay in `data` while it reloads or failed. */
  readonly state: LoadState<SnapshotList<D>>;
  /** Why it is not read here at all, before any request. */
  readonly problem: ContextEditorProblem | null;
  readonly retry: () => void;
}

// At most this many Context reads at once; the rest wait their turn.
const PARALLEL = 4;
function limiter() {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running >= PARALLEL)
      await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try {
      return await task();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

/**
 * Items of one type from every readable Context of the active Pod, as real
 * snapshots of their own Context. It discovers which Contexts hold the type
 * (one Pod query), then lists each readable one with `listSubjects`, at most
 * four at a time. A Context that fails or is not readable here does not hide
 * the others: `contexts` reports each one with its state and retry, and
 * `complete` is false until every discovered Context was read. A confirmed
 * write of this app re-reads its Context; one anywhere on the Pod also looks
 * for Contexts again, so the first item in another Context appears. Back in the
 * tab or app, everything reads again. `<LoadNotice {...overview} />` says what
 * is missing, with a retry. The definition needs a `type`.
 */
export function usePodList<D>(definition: FieldDefinition<D>) {
  const { key, definition: canonical } = useDefinition(
    definition,
    'usePodList',
  );
  const type = canonical.type;
  if (!type) throw new TypeError('usePodList needs a definition with a type.');
  const app = useController();
  useContextDiscovery(true);
  const { activeId, catalogue } = useAppFacts((s) => {
    const connection = s.connections.find((c) => c.id === s.activeId);
    const active =
      connection?.session.kind === 'active' ||
      connection?.session.kind === 'renewing';
    return {
      activeId: active ? connection.id : null,
      catalogue: active ? connection.catalogue : undefined,
    };
  }, shallowEqual);
  // Which Contexts hold the type; GRAPH names them, the Pod decides access.
  const discovery = usePodLoad(
    (pod, signal) =>
      pod.sparql.select(
        `SELECT DISTINCT ?graph WHERE { GRAPH ?graph { ?s a <${type}> } }`,
        { signal },
      ),
    { retain: true, key: type },
  );
  const graphs = useMemo(() => {
    const rows = shownData(discovery.state)?.rows ?? [];
    return [
      ...new Set(
        rows.flatMap((row) =>
          row.graph?.type === 'iri' ? [row.graph.value] : [],
        ),
      ),
    ].sort();
  }, [discovery.state]);
  const known = knownContexts(catalogue);
  const readable = (iri: string) =>
    known?.some((c) => c.iri === iri && c.readable) ?? false;
  const labels = catalogue?.kind !== 'unknown' ? catalogue?.labels : undefined;
  const wanted = graphs.filter(readable).join(' ');

  // One loader per readable Context, for this connection and definition.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const loaders = useRef(
    new Map<
      string,
      | {
          view: BoundView;
          loader: ReturnType<typeof createViewLoader<SnapshotList<D>>>;
        }
      | 'refused'
    >(),
  );
  const latest = useRef(canonical);
  latest.current = canonical;
  useEffect(() => {
    const map = new Map<
      string,
      | {
          view: BoundView;
          loader: ReturnType<typeof createViewLoader<SnapshotList<D>>>;
        }
      | 'refused'
    >();
    loaders.current = map;
    if (!activeId || !wanted) {
      rerender();
      return;
    }
    const limit = limiter();
    const stops: (() => void)[] = [];
    for (const iri of wanted.split(' ')) {
      let view: BoundView;
      try {
        view = app.runtime.bindContext(activeId, iri);
      } catch (error) {
        if (!(error instanceof RuntimeError)) throw error;
        map.set(iri, 'refused');
        continue;
      }
      const loader = createViewLoader<SnapshotList<D>>(
        view,
        (target, signal) =>
          limit(() => listSubjects(target, latest.current, { signal, type })),
        { retain: true },
      );
      map.set(iri, { view, loader });
      stops.push(loader.subscribe(rerender));
      stops.push(observeWrites(view, () => void loader.reload()));
      stops.push(() => loader.dispose());
      void loader.reload();
    }
    rerender();
    return () => stops.forEach((stop) => stop());
  }, [app, activeId, wanted, key, type]);

  // A confirmed write anywhere on the Pod may add a Context that holds the type.
  const podUrl = useAppFacts((s) => s.pod?.podUrl ?? null);
  const { reload: discover } = discovery;
  useEffect(
    () =>
      podUrl ? observePodWrites(podUrl, () => void discover()) : undefined,
    [podUrl, discover],
  );
  const reload = useCallback(() => {
    void discover();
    for (const entry of loaders.current.values())
      if (entry !== 'refused') void entry.loader.reload();
  }, [discover]);
  // Back in the tab or app, other devices may have changed it.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const contexts: PodListContext<D>[] = graphs.map((iri) => {
    const entry = loaders.current.get(iri);
    // While the catalogue is not known yet, access is not decided either.
    const problem: ContextEditorProblem | null =
      entry === 'refused'
        ? 'refused'
        : readable(iri) || (!known && catalogue?.kind !== 'failed')
          ? null
          : catalogue?.kind === 'failed'
            ? 'discovery-failed'
            : 'unreadable';
    return {
      context: iri,
      name: contextName(iri, labels),
      state:
        entry && entry !== 'refused'
          ? entry.loader.getSnapshot()
          : problem
            ? { kind: 'unavailable' }
            : { kind: 'loading' },
      problem,
      retry: () => {
        if (problem && activeId)
          void app.runtime.loadContexts(activeId).catch(() => {});
        else if (entry && entry !== 'refused') void entry.loader.reload();
      },
    };
  });
  const parts = contexts.map((c) => shownData(c.state));
  const data: PodListData<D> | undefined =
    shownData(discovery.state) === undefined
      ? undefined
      : {
          items: contexts.flatMap((c, i) =>
            (parts[i]?.items ?? []).map((snapshot) => ({
              context: c.context,
              snapshot,
            })),
          ),
          skipped: parts.reduce((sum, part) => sum + (part?.skipped ?? 0), 0),
        };
  const complete =
    discovery.state.kind === 'ready' &&
    contexts.every((c) => c.state.kind === 'ready');
  // The discovery's state, carrying the items, for `LoadNotice`.
  const d = discovery.state;
  const state: LoadState<PodListData<D>> =
    d.kind === 'ready'
      ? { kind: 'ready', data: data! }
      : d.kind === 'loading'
        ? data
          ? { kind: 'loading', previous: data }
          : { kind: 'loading' }
        : d.kind === 'failed'
          ? data
            ? { kind: 'failed', error: d.error, previous: data }
            : { kind: 'failed', error: d.error }
          : { kind: d.kind };
  return { state, data, contexts, complete, reload };
}
/** What `usePodList` returns. */
export type PodList<D> = ReturnType<typeof usePodList<D>>;
