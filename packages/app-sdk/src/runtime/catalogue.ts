import type { CatalogueContext, CatalogueResult } from '@sempods/client-sdk';
import type { Entry } from './connection.js';
import { RuntimeError } from './errors.js';

/** Uses the runtime's connection authority; never starts login or renews on a 403. */
interface CatalogueOwner {
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
  const labels =
    'labels' in e.view.catalogue ? e.view.catalogue.labels : undefined;
  const known = {
    ...(previous ? { contexts: previous } : {}),
    ...(labels ? { labels } : {}),
  };
  e.view = {
    ...e.view,
    catalogue: Object.freeze({ kind: 'loading', ...known }),
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
        // Keep known labels only for contexts this catalogue still lists.
        const kept = labels
          ? Object.fromEntries(
              Object.entries(labels).filter(([iri]) =>
                contexts.some((c) => c.iri === iri),
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
        void loadLabels(e, owner, contexts, generation);
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
          catalogue: Object.freeze({ kind: 'failed', ...known }),
        };
      }
      publish();
      return result;
    } catch (error) {
      if (eligible(e, generation)) {
        e.view = {
          ...e.view,
          catalogue: Object.freeze({ kind: 'failed', ...known }),
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

/** Context descriptions read at once, and at most per catalogue. */
const LABEL_READS = 3;
const LABEL_LIMIT = 50;

/**
 * Reads the registry labels of the readable contexts after a ready catalogue
 * (SPS-CTX-032), in the background and bound to the connection lifetime. It
 * never blocks selection or startup; a failed read leaves that label out. The
 * result is published only while this exact catalogue is still current.
 */
async function loadLabels(
  e: Entry,
  owner: CatalogueOwner,
  contexts: readonly CatalogueContext[],
  generation: string,
): Promise<void> {
  const targets = contexts
    .filter((c) => c.readable)
    .slice(0, LABEL_LIMIT)
    .map((c) => c.iri);
  if (!targets.length) return;
  const found: Record<string, string> = {};
  // A newer catalogue load supersedes this one: stop issuing its reads.
  const current = () => {
    const fact = e.view.catalogue;
    return (
      owner.eligible(e, generation) &&
      fact.kind === 'ready' &&
      fact.contexts === contexts
    );
  };
  let next = 0;
  const read = async () => {
    while (next < targets.length && current()) {
      const iri = targets[next++]!;
      try {
        const result = await e.clientPod.contextDescription(iri, {
          signal: e.lifetime.signal,
        });
        const label = result.kind === 'ok' ? result.body.label?.trim() : '';
        if (label) found[iri] = label;
      } catch {
        // Display text only: an unreadable description keeps today's name.
      }
    }
  };
  await Promise.all(Array.from({ length: LABEL_READS }, read));
  const fact = e.view.catalogue;
  if (
    !current() ||
    fact.kind !== 'ready' ||
    sameLabels(fact.labels ?? {}, found)
  )
    return;
  e.view = {
    ...e.view,
    catalogue: Object.freeze({ ...fact, labels: Object.freeze(found) }),
  };
  owner.publish();
}

function sameLabels(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k])
  );
}
