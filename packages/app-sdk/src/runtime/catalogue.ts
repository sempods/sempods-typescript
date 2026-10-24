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

/** Completed attempts are cached, including absent/failed labels, for this access lifetime. */
const labelStates = new WeakMap<
  Entry,
  {
    cache: Map<string, string | undefined>;
    pending?: { iri: string; selection: number; controller: AbortController };
    /** Explicitly demanded labels (`loadContextLabels`); a selection change keeps them. */
    requested: Map<string, AbortController>;
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
  state?.pending?.controller.abort();
  for (const controller of state?.requested.values() ?? []) controller.abort();
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
    state.pending.controller.abort();
    delete state.pending;
  }
  for (const [iri, controller] of state.requested)
    if (changed(iri)) {
      controller.abort();
      state.requested.delete(iri);
    }
}

function listedReadable(e: Entry, iri: string) {
  const fact = e.view.catalogue;
  return (
    fact.kind === 'ready' &&
    fact.contexts.some((c) => c.iri === iri && c.readable)
  );
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
  if (
    state.pending &&
    (state.pending.iri !== iri || state.pending.selection !== e.selectedVersion)
  ) {
    state.pending.controller.abort();
    delete state.pending;
  }
  if (!iri || !listedReadable(e, iri) || !owner.eligible(e)) return;
  if (state.cache.has(iri)) {
    publishLabel(e, owner, iri, state.cache.get(iri));
    return;
  }
  // An explicit demand for the same Context publishes it when it settles.
  if (state.pending || state.requested.has(iri)) return;
  const pending = {
    iri,
    selection: e.selectedVersion,
    controller: new AbortController(),
  };
  state.pending = pending;
  const generation = e.generation;
  const current = () =>
    owner.eligible(e, generation) &&
    labelStates.get(e) === state &&
    state.pending === pending &&
    e.selectedVersion === pending.selection &&
    e.view.selectedContext === iri &&
    listedReadable(e, iri);
  void (async () => {
    const label = await readLabel(e, iri, pending.controller.signal);
    if (!current()) return;
    state.cache.set(iri, label);
    delete state.pending;
    publishLabel(e, owner, iri, label);
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
 * Resolves once every started read settled or was dropped.
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
  const queue: [string, AbortController][] = [];
  for (const iri of new Set(iris)) {
    if (!listedReadable(e, iri)) continue;
    if (state.cache.has(iri)) publishLabel(e, owner, iri, state.cache.get(iri));
    else if (state.pending?.iri !== iri && !state.requested.has(iri)) {
      const controller = new AbortController();
      state.requested.set(iri, controller);
      queue.push([iri, controller]);
    }
  }
  const alive = () =>
    owner.eligible(e, generation) && labelStates.get(e) === state;
  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [iri, controller] = next;
      const current = () =>
        alive() &&
        state.requested.get(iri) === controller &&
        !controller.signal.aborted &&
        listedReadable(e, iri);
      const label = current()
        ? await readLabel(e, iri, controller.signal)
        : undefined;
      const settled = current();
      if (state.requested.get(iri) === controller) state.requested.delete(iri);
      if (!settled) continue;
      state.cache.set(iri, label);
      publishLabel(e, owner, iri, label);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(LABEL_CONCURRENCY, queue.length) }, work),
  );
}
