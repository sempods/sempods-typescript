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
  close(): void;
}
export interface SessionLocks {
  request(
    name: string,
    options: { ifAvailable: true },
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
