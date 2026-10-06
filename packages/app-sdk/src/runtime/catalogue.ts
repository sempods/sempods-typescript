import type { CatalogueContext, CatalogueResult } from '@sempods/client-sdk';
import type { Entry } from './connection.js';
import { RuntimeError } from './errors.js';
import { combineSignals } from './signals.js';

/** Uses the runtime's connection authority; never starts login or renews on a 403. */
export interface CatalogueOwner {
  eligible(entry: Entry, generation?: string): boolean;
  invalidate(entry: Entry): void;
  publish(): void;
  /** The configured exact context, or the person's remembered explicit choice. */
  remembered(entry: Entry): string | undefined;
}
export function loadCatalogue(
  e: Entry,
  owner: CatalogueOwner,
): Promise<CatalogueResult> {
  const { eligible, invalidate, publish, remembered } = owner;
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
  }
>();

/** Session/generation/grant changes must not reuse old descriptive authority. */
export function resetLabels(e: Entry) {
  labelStates.get(e)?.pending?.controller.abort();
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
}

/** One nonblocking description, only for the currently selected validated Context. */
export function loadSelectedLabel(
  e: Entry,
  owner: Pick<CatalogueOwner, 'eligible' | 'publish'>,
): void {
  let state = labelStates.get(e);
  if (!state) labelStates.set(e, (state = { cache: new Map() }));
  const iri = e.view.selectedContext;
  if (
    state.pending &&
    (state.pending.iri !== iri || state.pending.selection !== e.selectedVersion)
  ) {
    state.pending.controller.abort();
    delete state.pending;
  }
  const fact = e.view.catalogue;
  if (
    !iri ||
    fact.kind !== 'ready' ||
    !fact.contexts.some((c) => c.iri === iri && c.readable) ||
    !owner.eligible(e)
  )
    return;
  const publishLabel = (label: string | undefined) => {
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
  };
  if (state.cache.has(iri)) {
    publishLabel(state.cache.get(iri));
    return;
  }
  if (state.pending) return;
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
    'contexts' in e.view.catalogue &&
    e.view.catalogue.contexts?.some((c) => c.iri === iri && c.readable);
  void (async () => {
    let label: string | undefined;
    const combined = combineSignals(
      e.lifetime.signal,
      pending.controller.signal,
    );
    try {
      const result = await e.clientPod.contextDescription(iri, {
        signal: combined.signal,
      });
      if (result.kind === 'ok') label = result.body.label?.trim() || undefined;
    } catch {
      // Display text only: failure keeps the immediate IRI/name fallback.
    } finally {
      combined.dispose();
    }
    if (!current()) return;
    state.cache.set(iri, label);
    delete state.pending;
    publishLabel(label);
  })();
}
