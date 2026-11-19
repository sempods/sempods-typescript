/** Public injection surface without DOM declarations; payloads are private to the coordinator. */
export interface StoredSession {
  readonly id: string;
  readonly revision: string;
  readonly value: unknown;
}
export type SessionCommit =
  | { readonly kind: 'committed'; readonly record: StoredSession }
  | { readonly kind: 'conflict' };
export interface SessionListing {
  readonly records: readonly StoredSession[];
  readonly unreadable: readonly {
    readonly id: string | null;
    readonly problem: 'corrupt' | 'unsupported';
  }[];
}
export type SessionRemoval =
  { readonly kind: 'removed' } | { readonly kind: 'conflict' };
export interface SessionStore {
  read(id: string): Promise<StoredSession | undefined>;
  list(): Promise<SessionListing>;
  commit(
    id: string,
    expectedRevision: string | null,
    value: unknown,
  ): Promise<SessionCommit>;
  /**
   * Deletes the record when its revision is still `expectedRevision`, in one
   * atomic step like `commit`; `conflict` otherwise, also for a missing
   * record. Added in 0.8.0 for `forget(id)` and `rememberPods: false`.
   */
  remove(id: string, expectedRevision: string): Promise<SessionRemoval>;
  /**
   * Calls `listener` with a record's id once another tab of this app has
   * committed or removed it; returns the function that stops listening.
   * Added in 0.9.0. A store with `watch` lets several tabs of the app share
   * their sessions; one without keeps one active tab, and another tab
   * reports `busy`.
   */
  watch?(listener: (id: string) => void): () => void;
  close(): void;
}
/**
 * The part of the Web Locks API the runtime uses. The session lease is
 * requested `ifAvailable`, `shared` for a store with `watch` and
 * `exclusive` otherwise; a connection's refresh lock is waited for, until
 * `signal` aborts (0.9.0).
 */
export interface SessionLocks {
  request(
    name: string,
    options: {
      readonly ifAvailable?: true;
      readonly mode?: 'exclusive' | 'shared';
      readonly signal?: AbortSignal;
    },
    callback: (lock: { readonly name: string } | null) => Promise<void>,
  ): Promise<void>;
}

/** Safe coordinator transition facts, independent of the browser storage implementation. */
export type SessionTransitionProblem =
  | 'corrupt'
  | 'unsupported'
  | 'state'
  | 'result'
  | 'consumed'
  | 'attempt'
  | 'callback'
  | 'configuration';
