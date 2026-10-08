import type {
  GetResult,
  JsonLd,
  QueryResult,
  ReadOptions,
  WriteResult,
  Cancelled,
  Stopped,
} from '@sempods/client-sdk';
import type { Entry } from './connection.js';
import type { BoundView, Invalidated, ViewAccess } from './view.js';
import { waitFor } from './wait.js';

/**
 * What a view is bound to beyond its connection, generation and subject: the
 * selected Context (valid while that selection holds) or an explicit Context.
 */
export interface ViewTarget {
  readonly contextIri: string;
  /** Whether the target still holds; connection, generation and subject are checked too. */
  readonly holds: () => boolean;
  /** The read-invalidation domain: its revision and the signal aborting its reads. */
  readonly reads: () => {
    readonly epoch: number;
    readonly signal: AbortSignal;
  };
  /** Appended to the view key; distinguishes handle lifetimes. */
  readonly key: readonly unknown[];
}
/** The selected Context's target: one selection version, the entry's read domain. */
export function selectedTarget(e: Entry): ViewTarget {
  const contextIri = e.view.selectedContext!;
  const selectedVersion = e.selectedVersion;
  return {
    contextIri,
    holds: () =>
      e.selectedVersion === selectedVersion &&
      e.view.selectedContext === contextIri,
    reads: () => ({ epoch: e.epoch, signal: e.reads.signal }),
    key: [selectedVersion],
  };
}
/**
 * An explicit Context's target: independent of the selection, with a read
 * domain of its own that selection changes never touch.
 */
export function explicitTarget(e: Entry, contextIri: string): ViewTarget {
  return {
    contextIri,
    holds: () => true,
    reads: () => {
      e.contextReads ??= new Map();
      let domain = e.contextReads.get(contextIri);
      if (!domain)
        e.contextReads.set(
          contextIri,
          (domain = { epoch: 0, reads: new AbortController() }),
        );
      return { epoch: domain.epoch, signal: domain.reads.signal };
    },
    key: ['explicit'],
  };
}
/** Invalidates pending reads of explicit Context views: one Context, or all of them. */
export function invalidateContexts(e: Entry, only?: string) {
  for (const [iri, domain] of e.contextReads ?? [])
    if (only === undefined || iri === only) {
      domain.epoch++;
      domain.reads.abort();
      domain.reads = new AbortController();
    }
}
/** One target lifetime; independent read/write guards let read-only views keep working. */
export function bindView(
  e: Entry,
  target: ViewTarget,
  current: () => boolean,
  forbidden: () => Promise<void>,
  subscribe: (listener: () => void) => () => void,
): BoundView {
  const { contextIri } = target;
  const generation = e.generation;
  const subject = e.credentials!.subject;
  const valid = () =>
    current() &&
    e.generation === generation &&
    e.credentials?.subject === subject &&
    target.holds();
  const permission = (write: boolean) =>
    valid() &&
    e.view.missingRequiredScopes.length === 0 &&
    'contexts' in e.view.catalogue &&
    (e.view.catalogue.contexts?.some(
      (c) => c.iri === contextIri && (write ? c.writable : c.readable),
    ) ??
      false);
  let snapshot: ViewAccess | undefined;
  const getSnapshot = (): ViewAccess => {
    const next = {
      current: valid(),
      read: Boolean(permission(false)),
      write: Boolean(permission(true)),
      catalogue: e.view.catalogue.kind,
      revision: target.reads().epoch,
    };
    if (
      !snapshot ||
      Object.keys(next).some(
        (k) => next[k as keyof ViewAccess] !== snapshot![k as keyof ViewAccess],
      )
    )
      snapshot = Object.freeze(next);
    return snapshot;
  };
  // Use the same Pod/Auth instance and executor, with operation-specific context guards.
  const reads = e.clientPod.context(contextIri, {
    beforeDispatch: () => permission(false),
  });
  const writes = e.clientPod.context(contextIri, {
    beforeDispatch: () => permission(true),
  });
  async function read<
    R extends GetResult<JsonLd> | QueryResult<readonly JsonLd[]>,
  >(
    action: () => Promise<R>,
    options?: ReadOptions,
  ): Promise<Exclude<R, Stopped> | Cancelled | Invalidated> {
    if (options?.signal?.aborted) return { kind: 'cancelled' };
    if (!permission(false)) return { kind: 'invalidated' };
    const { epoch, signal: readSignal } = target.reads();
    try {
      const result = await waitFor(
        action(),
        readSignal,
        e.lifetime.signal,
        options?.signal,
      );
      if (options?.signal?.aborted) return { kind: 'cancelled' };
      if (result.kind === 'refused' && result.status === 403 && valid()) {
        await waitFor(forbidden(), e.lifetime.signal, options?.signal);
        return valid()
          ? (result as Exclude<R, Stopped>)
          : { kind: 'invalidated' };
      }
      if (
        !permission(false) ||
        target.reads().epoch !== epoch ||
        result.kind === 'stopped'
      )
        return { kind: 'invalidated' };
      return result as Exclude<R, Stopped>;
    } catch (error) {
      if (options?.signal?.aborted) return { kind: 'cancelled' };
      if (!permission(false) || target.reads().epoch !== epoch)
        return { kind: 'invalidated' };
      throw error;
    }
  }
  async function write(
    action: () => Promise<WriteResult>,
    options?: ReadOptions,
  ): Promise<WriteResult> {
    const result = await action();
    if (result.kind === 'refused' && result.status === 403 && valid())
      await waitFor(forbidden(), e.lifetime.signal, options?.signal).catch(
        () => {},
      );
    // Even if the target changed, a validated applied response remains applied to this original view.
    return result;
  }
  return Object.freeze({
    key: JSON.stringify([
      e.view.id,
      subject,
      e.pod.podUrl,
      contextIri,
      generation,
      ...target.key,
    ]),
    getSnapshot,
    subscribe(listener) {
      let last = getSnapshot();
      return subscribe(() => {
        const next = getSnapshot();
        if (last !== next) {
          last = next;
          listener();
        }
      });
    },
    podUrl: e.pod.podUrl,
    contextIri,
    subjects: Object.freeze({
      get: (iri, options) =>
        read(() => reads.subjects.get(iri, options), options),
      put: (iri, body, condition, options) =>
        write(
          () => writes.subjects.put(iri, body, condition, options),
          options,
        ),
      patch: (iri, change, condition, options) =>
        write(
          () => writes.subjects.patch(iri, change, condition, options),
          options,
        ),
      delete: (iri, condition, options) =>
        write(() => writes.subjects.delete(iri, condition, options), options),
    }),
    sparql: Object.freeze({
      construct: (query, options) =>
        read(() => reads.sparql.construct(query, options), options),
    }),
  } satisfies BoundView);
}
