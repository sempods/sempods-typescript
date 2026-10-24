import type { CatalogueContext, CatalogueResult } from '@sempods/client-sdk';
import type { Entry } from './connection.js';
import { RuntimeError } from './errors.js';
import { combineSignals } from './signals.js';

/** Uses the runtime's connection authority; never starts login or renews on a 403. */
export interface CatalogueOwner {
  eligible(entry: Entry, generation?: string): boolean;
  invalidate(entry: Entry): void;
  /** Invalidates pending reads of the explicit view of one Context. */
  invalidateContext(entry: Entry, contextIri: string): void;
  publish(): void;
  /** The configured exact context, or the person's remembered explicit choice. */
  remembered(entry: Entry): string | undefined;
}
export function loadCatalogue(
  e: Entry,
  owner: CatalogueOwner,
): Promise<CatalogueResult> {
  const { eligible, invalidate, invalidateContext, publish, remembered } =
    owner;
  if (e.catalogue) return e.catalogue;
  const generation = e.generation;
  const previous =
    'contexts' in e.view.catalogue ? e.view.catalogue.contexts : undefined;
  const known = () => ({
    ...(previous ? { contexts: previous } : {}),
    ...('labels' in e.view.catalogue && e.view.catalogue.labels
      ? { labels: e.view.catalogue.labels }
      : {}),
  });
  e.view = {
    ...e.view,
    catalogue: Object.freeze({ kind: 'loading', ...known() }),
  };
  publish();
  const operation = (async () => {
    try {
      const result = await e.clientPod.catalogue({
        signal: e.lifetime.signal,
      });
      if (!eligible(e, generation)) throw new RuntimeError('disconnected');
      if (result.kind === 'ok') {
        const contexts = Object.freeze(
          result.body.map((c) => Object.freeze({ ...c })),
        );
        const before = previous?.find((c) => c.iri === e.view.selectedContext);
        const after = contexts.find((c) => c.iri === e.view.selectedContext);
        if (
          before?.readable !== after?.readable ||
          before?.writable !== after?.writable
        )
          invalidate(e);
        // Explicit views compare their own Context; the selection is not theirs.
        for (const iri of e.explicit?.keys() ?? []) {
          const was = previous?.find((c) => c.iri === iri);
          const is = contexts.find((c) => c.iri === iri);
          if (was?.readable !== is?.readable || was?.writable !== is?.writable)
            invalidateContext(e, iri);
        }
        pruneLabels(e, previous, contexts);
        // Keep labels only for contexts with unchanged readable authority.
        const labels =
          'labels' in e.view.catalogue ? e.view.catalogue.labels : undefined;
        const kept = labels
          ? Object.fromEntries(
              Object.entries(labels).filter(
                ([iri]) =>
                  contexts.some((c) => c.iri === iri && c.readable) &&
                  previous?.find((c) => c.iri === iri)?.writable ===
                    contexts.find((c) => c.iri === iri)?.writable &&
                  previous?.find((c) => c.iri === iri)?.manageable ===
                    contexts.find((c) => c.iri === iri)?.manageable,
              ),
            )
          : {};
        e.view = {
          ...e.view,
          catalogue: Object.freeze({
            kind: 'ready',
            contexts,
            ...(Object.keys(kept).length
              ? { labels: Object.freeze(kept) }
              : {}),
          }),
        };
        // Apply an explicit configured/remembered choice only while readable;
        // never a fallback to any other context.
        const choice = e.view.selectedContext ? undefined : remembered(e);
        if (choice && contexts.some((c) => c.iri === choice && c.readable)) {
          e.view = { ...e.view, selectedContext: choice };
          e.selectedVersion++;
          delete e.bound;
        }
      } else {
        e.view = {
          ...e.view,
          catalogue: Object.freeze({ kind: 'failed', ...known() }),
        };
      }
      publish();
      if (result.kind === 'ok') loadSelectedLabel(e, owner);
      return result;
    } catch (error) {
      if (eligible(e, generation)) {
        e.view = {
          ...e.view,
          catalogue: Object.freeze({ kind: 'failed', ...known() }),
        };
        publish();
      }
      throw error;
    } finally {
      if (e.generation === generation) delete e.catalogue;
    }
  })();
  e.catalogue = operation;
  return operation;
}

/** One description read; `done` settles once it finished or was dropped. */
interface LabelRead {
  readonly controller: AbortController;
  readonly done: Promise<void>;
  readonly settle: () => void;
}
function labelRead(): LabelRead {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));
  return { controller: new AbortController(), done, settle };
}
/** Dropped reads settle at once: a joined demand must not wait for others. */
function drop(read: LabelRead) {
  read.controller.abort();
  read.settle();
}

/** Completed attempts are cached, including absent/failed labels, for this access lifetime. */
const labelStates = new WeakMap<
  Entry,
  {
    cache: Map<string, string | undefined>;
    pending?: { iri: string; selection: number; read: LabelRead };
    /**
     * Explicitly demanded labels (`loadContextLabels`), including a selected
     * read they joined; a selection change keeps them.
     */
    requested: Map<string, LabelRead>;
  }
>();
function labelState(e: Entry) {
  let state = labelStates.get(e);
  if (!state)
    labelStates.set(e, (state = { cache: new Map(), requested: new Map() }));
  return state;
}

/** Session/generation/grant changes must not reuse old descriptive authority. */
export function resetLabels(e: Entry) {
  const state = labelStates.get(e);
  if (state?.pending) drop(state.pending.read);
  for (const read of state?.requested.values() ?? []) drop(read);
  labelStates.delete(e);
  if ('labels' in e.view.catalogue) {
    const fact = { ...e.view.catalogue };
    delete fact.labels;
    e.view = { ...e.view, catalogue: Object.freeze(fact) };
  }
}

function pruneLabels(
  e: Entry,
  before: readonly CatalogueContext[] | undefined,
  after: readonly CatalogueContext[],
) {
  const state = labelStates.get(e);
  if (!state) return;
  const changed = (iri: string) => {
    const old = before?.find((c) => c.iri === iri);
    const next = after.find((c) => c.iri === iri);
    return (
      !next?.readable ||
      old?.readable !== next.readable ||
      old?.writable !== next.writable ||
      old?.manageable !== next.manageable
    );
  };
  for (const iri of state.cache.keys())
    if (changed(iri)) state.cache.delete(iri);
  if (state.pending && changed(state.pending.iri)) {
    drop(state.pending.read);
    delete state.pending;
  }
  for (const [iri, read] of state.requested)
    if (changed(iri)) {
      drop(read);
      state.requested.delete(iri);
    }
}

/** Listed as readable, also by the contexts a refreshing catalogue retains. */
function listed(e: Entry, iri: string) {
  const fact = e.view.catalogue;
  return (
    'contexts' in fact &&
    Boolean(fact.contexts?.some((c) => c.iri === iri && c.readable))
  );
}
/** A new read starts only from a ready catalogue. */
function startable(e: Entry, iri: string) {
  return e.view.catalogue.kind === 'ready' && listed(e, iri);
}

function publishLabel(
  e: Entry,
  owner: Pick<CatalogueOwner, 'publish'>,
  iri: string,
  label: string | undefined,
) {
  const current = e.view.catalogue;
  if (!label || !('contexts' in current) || current.labels?.[iri] === label)
    return;
  e.view = {
    ...e.view,
    catalogue: Object.freeze({
      ...current,
      labels: Object.freeze({ ...current.labels, [iri]: label }),
    }),
  };
  owner.publish();
}

/** Display text only: any failure keeps the immediate IRI/name fallback. */
async function readLabel(e: Entry, iri: string, signal: AbortSignal) {
  const combined = combineSignals(e.lifetime.signal, signal);
  try {
    const result = await e.clientPod.contextDescription(iri, {
      signal: combined.signal,
    });
    return result.kind === 'ok'
      ? result.body.label?.trim() || undefined
      : undefined;
  } catch {
    return undefined;
  } finally {
    combined.dispose();
  }
}

/** One nonblocking description, only for the currently selected validated Context. */
export function loadSelectedLabel(
  e: Entry,
  owner: Pick<CatalogueOwner, 'eligible' | 'publish'>,
): void {
  const state = labelState(e);
  const iri = e.view.selectedContext;
  const previous = state.pending;
  if (
    previous &&
    (previous.iri !== iri || previous.selection !== e.selectedVersion)
  ) {
    // An explicit demand that joined this read keeps it; only the
    // selection's own interest ends.
    if (state.requested.get(previous.iri) !== previous.read)
      drop(previous.read);
    delete state.pending;
  }
  if (!iri || !startable(e, iri) || !owner.eligible(e)) return;
  if (state.cache.has(iri)) {
    publishLabel(e, owner, iri, state.cache.get(iri));
    return;
  }
  // An explicit demand for the same Context publishes it when it settles.
  if (state.pending || state.requested.has(iri)) return;
  const read = labelRead();
  const pending = { iri, selection: e.selectedVersion, read };
  state.pending = pending;
  const generation = e.generation;
  void (async () => {
    try {
      const label = await readLabel(e, iri, read.controller.signal);
      const selected =
        state.pending === pending &&
        e.selectedVersion === pending.selection &&
        e.view.selectedContext === iri;
      const demanded = state.requested.get(iri) === read;
      // Never leave a settled read behind: the next selection may start anew.
      if (state.pending === pending) delete state.pending;
      if (demanded) state.requested.delete(iri);
      if (
        !owner.eligible(e, generation) ||
        labelStates.get(e) !== state ||
        read.controller.signal.aborted ||
        !(selected || demanded) ||
        !listed(e, iri)
      )
        return;
      state.cache.set(iri, label);
      publishLabel(e, owner, iri, label);
    } finally {
      read.settle();
    }
  })();
}

/** The most Contexts one explicit label demand may name. */
export const CONTEXT_LABEL_LIMIT = 20;
/** Descriptions read at the same time for one demand. */
const LABEL_CONCURRENCY = 4;

/**
 * Reads the labels of at most `CONTEXT_LABEL_LIMIT` explicitly named Contexts
 * that the ready catalogue lists as readable; others are ignored. Shares the
 * selected label's cache, coalescing and invalidation; never retries a failure.
 * Joins a read already in flight for a named Context, which then survives a
 * selection change. Resolves once every read it started or joined settled or
 * was dropped.
 */
export async function loadContextLabels(
  e: Entry,
  owner: Pick<CatalogueOwner, 'eligible' | 'publish'>,
  iris: readonly string[],
): Promise<void> {
  if (iris.length > CONTEXT_LABEL_LIMIT)
    throw new RuntimeError('configuration');
  if (!owner.eligible(e)) return;
  const state = labelState(e);
  const generation = e.generation;
  const queue: [string, LabelRead][] = [];
  const joined: Promise<void>[] = [];
  for (const iri of new Set(iris)) {
    if (!startable(e, iri)) continue;
    if (state.cache.has(iri)) {
      publishLabel(e, owner, iri, state.cache.get(iri));
      continue;
    }
    const inflight =
      state.requested.get(iri) ??
      (state.pending?.iri === iri ? state.pending.read : undefined);
    if (inflight) {
      state.requested.set(iri, inflight);
      joined.push(inflight.done);
      continue;
    }
    const read = labelRead();
    state.requested.set(iri, read);
    queue.push([iri, read]);
  }
  const current = (iri: string, read: LabelRead) =>
    owner.eligible(e, generation) &&
    labelStates.get(e) === state &&
    state.requested.get(iri) === read &&
    !read.controller.signal.aborted &&
    listed(e, iri);
  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [iri, read] = next;
      try {
        const label = current(iri, read)
          ? await readLabel(e, iri, read.controller.signal)
          : undefined;
        const settled = current(iri, read);
        if (state.requested.get(iri) === read) state.requested.delete(iri);
        if (!settled) continue;
        state.cache.set(iri, label);
        publishLabel(e, owner, iri, label);
      } finally {
        read.settle();
      }
    }
  };
  // The caller waits for its reads, not the workers: a dropped read settles at
  // once even while a transport that ignores abort still holds its worker.
  const started = queue.map(([, read]) => read.done);
  void Promise.all(
    Array.from({ length: Math.min(LABEL_CONCURRENCY, queue.length) }, work),
  );
  await Promise.all([...started, ...joined]);
}
