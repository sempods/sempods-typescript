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
export interface SessionStore {
  read(id: string): Promise<StoredSession | undefined>;
  list(): Promise<SessionListing>;
  commit(
    id: string,
    expectedRevision: string | null,
    value: unknown,
  ): Promise<SessionCommit>;
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
