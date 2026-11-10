import type {
  DispatchGuard,
  Pod,
  QueryResult,
  ReadOptions,
} from '@sempods/client-sdk';
import { sends, subjectOf, type Entry } from './connection.js';
import type { BoundPod, BoundRead, ViewAccess } from './view.js';
import { waitFor } from './wait.js';
import { combineSignals } from './signals.js';
import { observePod } from './binding.js';
import type { Admission } from './admission.js';
import { noticeAdmission } from './admission-notice.js';

type PodReadOptions = ReadOptions & { readonly priority?: 'current' };

/** The production client remains the only protocol/renewal executor. */
export function bindPod(
  e: Entry,
  current: () => boolean,
  client: (guard: DispatchGuard) => Pod,
  subscribe: (listener: () => void) => () => void,
  admission?: Admission,
): BoundPod {
  const generation = e.generation;
  // `null` while reading without a token; a sign-in or sign-out replaces it.
  const subject = subjectOf(e);
  const valid = () =>
    current() && e.generation === generation && subjectOf(e) === subject;
  // Suspended without a credential, as while a lost renewal answer waits.
  const readable = () =>
    valid() && sends(e) && e.view.missingRequiredScopes.length === 0;
  const pod = client(readable);
  const invalidated = { kind: 'invalidated' } as const;
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
    options?: PodReadOptions,
  ): Promise<BoundRead<QueryResult<T>>> {
    const caller = options?.signal;
    if (caller?.aborted) return { kind: 'cancelled' };
    if (!readable()) return { kind: 'invalidated' };
    const revision = e.podEpoch;
    const combined = combineSignals(
      e.podReads.signal,
      e.lifetime.signal,
      caller,
    );
    const { signal } = combined;
    const stopped = () =>
      caller?.aborted ? ({ kind: 'cancelled' } as const) : invalidated;
    try {
      // Waiting for a slot is not a request: a read that stops while it
      // waits leaves the queue and is never sent.
      const release = admission
        ? await admission.acquire(
            e.view.podUrl,
            options?.priority === 'current',
            signal,
            () => noticeAdmission(caller, 'queued'),
          )
        : undefined;
      if (admission && !release) return stopped();
      if (signal.aborted || !readable() || revision !== e.podEpoch) {
        release?.();
        return stopped();
      }
      noticeAdmission(caller, 'admitted');
      let request: Promise<QueryResult<T>>;
      try {
        request = action({ signal });
      } catch (error) {
        release?.();
        throw error;
      }
      // The slot belongs to the request until it settles, also when this
      // caller stops waiting first (an abort-ignoring transport).
      if (release) request.then(release, release);
      const result = await waitFor(request, signal);
      if (caller?.aborted) return { kind: 'cancelled' };
      if (!readable() || revision !== e.podEpoch || result.kind === 'stopped')
        return invalidated;
      // Unlike Context reads, a Pod 403 is just this operation's refusal.
      return result;
    } catch (error) {
      if (caller?.aborted) return { kind: 'cancelled' };
      if (!readable() || revision !== e.podEpoch) return invalidated;
      throw error;
    } finally {
      combined.dispose();
    }
  }
  const reader = Object.freeze({
    key: JSON.stringify([e.view.id, subject, e.view.podUrl, generation]),
    podUrl: e.view.podUrl,
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
  observePod(reader, e);
  return reader;
}
