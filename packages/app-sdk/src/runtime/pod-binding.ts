import type {
  DispatchGuard,
  Pod,
  QueryResult,
  ReadOptions,
} from '@sempods/client-sdk';
import type { Entry } from './connection.js';
import type { BoundPod, BoundRead, ViewAccess } from './view.js';
import { waitFor } from './wait.js';

/** The production client remains the only protocol/renewal executor. */
export function bindPod(
  e: Entry,
  current: () => boolean,
  client: (guard: DispatchGuard) => Pod,
  subscribe: (listener: () => void) => () => void,
): BoundPod {
  const generation = e.generation;
  const subject = e.credentials!.subject;
  const valid = () =>
    current() &&
    e.generation === generation &&
    e.credentials?.subject === subject;
  const readable = () => valid() && e.view.missingRequiredScopes.length === 0;
  const pod = client(readable);
  let snapshot: Pick<ViewAccess, 'current' | 'read' | 'revision'> | undefined;
  function getSnapshot() {
    const next = { current: valid(), read: readable(), revision: e.podEpoch };
    if (
      !snapshot ||
      snapshot.current !== next.current ||
      snapshot.read !== next.read ||
      snapshot.revision !== next.revision
    )
      snapshot = Object.freeze(next);
    return snapshot;
  }
  async function read<T>(
    action: (options: ReadOptions) => Promise<QueryResult<T>>,
    options?: ReadOptions,
  ): Promise<BoundRead<QueryResult<T>>> {
    if (options?.signal?.aborted) return { kind: 'cancelled' };
    if (!readable()) return { kind: 'invalidated' };
    const revision = e.podEpoch;
    const signal = AbortSignal.any([
      e.podReads.signal,
      e.lifetime.signal,
      ...(options?.signal ? [options.signal] : []),
    ]);
    try {
      const result = await waitFor(action({ ...options, signal }), signal);
      if (options?.signal?.aborted) return { kind: 'cancelled' };
      if (!readable() || revision !== e.podEpoch || result.kind === 'stopped')
        return { kind: 'invalidated' };
      // Unlike Context reads, a Pod 403 is just this operation's refusal.
      return result;
    } catch (error) {
      if (options?.signal?.aborted) return { kind: 'cancelled' };
      if (!readable() || revision !== e.podEpoch)
        return { kind: 'invalidated' };
      throw error;
    }
  }
  return Object.freeze({
    key: JSON.stringify([e.view.id, subject, e.pod.podUrl, generation]),
    podUrl: e.pod.podUrl,
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
    sparql: Object.freeze({
      select: (query, options) =>
        read((o) => pod.sparql.select(query, o), options),
      construct: (query, options) =>
        read((o) => pod.sparql.construct(query, o), options),
    }),
  } satisfies BoundPod);
}
