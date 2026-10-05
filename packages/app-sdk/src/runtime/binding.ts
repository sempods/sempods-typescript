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

/** One target lifetime; independent read/write guards let read-only views keep working. */
export function bindView(
  e: Entry,
  current: () => boolean,
  forbidden: () => Promise<void>,
  subscribe: (listener: () => void) => () => void,
): BoundView {
  const contextIri = e.view.selectedContext!;
  const generation = e.generation;
  const selectedVersion = e.selectedVersion;
  const subject = e.credentials!.subject;
  const valid = () =>
    current() &&
    e.generation === generation &&
    e.selectedVersion === selectedVersion &&
    e.credentials?.subject === subject &&
    e.view.selectedContext === contextIri;
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
      revision: e.epoch,
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
    const epoch = e.epoch;
    const readSignal = e.reads.signal;
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
      if (!permission(false) || e.epoch !== epoch || result.kind === 'stopped')
        return { kind: 'invalidated' };
      return result as Exclude<R, Stopped>;
    } catch (error) {
      if (options?.signal?.aborted) return { kind: 'cancelled' };
      if (!permission(false) || e.epoch !== epoch)
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
      selectedVersion,
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
