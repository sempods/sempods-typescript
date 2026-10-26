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
import { catalogueLists } from '../runtime/binding.js';
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

/** One Context's loader and what to stop with it, or a refused binding. */
type Entry<D> =
  | {
      readonly loader: ReturnType<typeof createViewLoader<SnapshotList<D>>>;
      readonly stops: readonly (() => void)[];
    }
  | 'refused';
function release<D>(entry: Entry<D>) {
  if (entry !== 'refused') entry.stops.forEach((stop) => stop());
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
  // The runtime's own authority: a failed refresh keeps the earlier Contexts,
  // and reads from them stay allowed, so their rows stay too.
  const evidence =
    catalogue !== undefined &&
    'contexts' in catalogue &&
    catalogue.contexts !== undefined;
  const readable = (iri: string) =>
    catalogue !== undefined && catalogueLists(catalogue, iri);
  const labels = catalogue?.kind !== 'unknown' ? catalogue?.labels : undefined;
  const wanted = graphs.filter(readable).join(' ');

  // One loader per readable Context, for this connection and definition.
  // A changed set of Contexts adds and removes loaders; the others keep their
  // rows and reads. Another connection or definition starts over.
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const store = useRef<{
    readonly owner: string;
    readonly map: Map<string, Entry<D>>;
    readonly limit: ReturnType<typeof limiter>;
  } | null>(null);
  const latest = useRef(canonical);
  latest.current = canonical;
  // Whose loaders they are: another connection or definition starts over.
  const owner = `${activeId ?? ''} ${key} ${type}`;
  useEffect(() => {
    if (store.current?.owner !== owner) {
      if (store.current) store.current.map.forEach(release);
      store.current = { owner, map: new Map(), limit: limiter() };
    }
    const { map, limit } = store.current;
    const want = new Set(activeId && wanted ? wanted.split(' ') : []);
    for (const [iri, entry] of map)
      if (!want.has(iri)) {
        release(entry);
        map.delete(iri);
      }
    for (const iri of want) {
      if (map.has(iri)) continue;
      let view: BoundView;
      try {
        view = app.runtime.bindContext(activeId!, iri);
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
      map.set(iri, {
        loader,
        stops: [
          loader.subscribe(rerender),
          observeWrites(view, () => void loader.reload()),
          () => loader.dispose(),
        ],
      });
      void loader.reload();
    }
    rerender();
  }, [app, activeId, wanted, owner, type]);
  // Unmounting releases every loader (StrictMode mounts again from scratch).
  useEffect(
    () => () => {
      store.current?.map.forEach(release);
      store.current = null;
    },
    [],
  );
  // Until this render's connection and definition have loaders of their own,
  // the old ones' rows do not show: they belong to another definition.
  const loaders =
    store.current?.owner === owner ? store.current.map : undefined;

  // A confirmed write anywhere on the Pod may add a Context that holds the type.
  const podUrl = useAppFacts((s) => s.pod?.podUrl ?? null);
  const { reload: discover } = discovery;
  useEffect(
    () =>
      podUrl ? observePodWrites(podUrl, () => void discover()) : undefined,
    [podUrl, discover],
  );
  // A Context the catalogue does not list yet, for example one another app
  // just created: refresh the catalogue once for it, and again on reload.
  // The Contexts it knows, also kept while it reloads or after a failure.
  const listed =
    catalogue !== undefined && 'contexts' in catalogue
      ? catalogue.contexts
      : undefined;
  const unlisted = listed
    ? graphs.filter((iri) => !listed.some((c) => c.iri === iri)).join(' ')
    : '';
  const refreshCatalogue = useCallback(() => {
    if (activeId) void app.runtime.loadContexts(activeId).catch(() => {});
  }, [app, activeId]);
  // Once per set of unlisted Contexts: a catalogue that still omits them stays.
  const refreshedFor = useRef('');
  useEffect(() => {
    if (!unlisted || unlisted === refreshedFor.current) return;
    refreshedFor.current = unlisted;
    refreshCatalogue();
  }, [unlisted, refreshCatalogue]);
  const unlistedNow = useRef(unlisted);
  unlistedNow.current = unlisted;
  const reload = useCallback(() => {
    void discover();
    if (unlistedNow.current) refreshCatalogue();
    for (const entry of store.current?.map.values() ?? [])
      if (entry !== 'refused') void entry.loader.reload();
  }, [discover, refreshCatalogue]);
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
    const entry = loaders?.get(iri);
    // While the catalogue is not known yet, access is not decided either.
    const problem: ContextEditorProblem | null =
      entry === 'refused'
        ? 'refused'
        : readable(iri) || (!evidence && catalogue?.kind !== 'failed')
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
  const all: PodListData<D> | undefined =
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
  // Still finding out: a Context without its first answer, or access not
  // known yet. Until then the overview is loading, not complete or empty.
  const pending = contexts.some(
    (c) =>
      c.state.kind === 'loading' && parts[contexts.indexOf(c)] === undefined,
  );
  const shown = all && (all.items.length > 0 || !pending) ? all : undefined;
  // The discovery's state, carrying the items, for `LoadNotice`.
  const d = discovery.state;
  const state: LoadState<PodListData<D>> =
    d.kind === 'ready'
      ? pending
        ? shown
          ? { kind: 'loading', previous: shown }
          : { kind: 'loading' }
        : { kind: 'ready', data: all! }
      : d.kind === 'loading'
        ? shown
          ? { kind: 'loading', previous: shown }
          : { kind: 'loading' }
        : d.kind === 'failed'
          ? shown
            ? { kind: 'failed', error: d.error, previous: shown }
            : { kind: 'failed', error: d.error }
          : { kind: d.kind };
  const data = shownData(state);
  return { state, data, contexts, complete, reload };
}
/** What `usePodList` returns. */
export type PodList<D> = ReturnType<typeof usePodList<D>>;
