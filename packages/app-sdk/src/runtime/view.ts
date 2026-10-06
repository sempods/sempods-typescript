import type {
  ContextView,
  GetResult,
  JsonLd,
  QueryResult,
  ReadOptions,
  Stopped,
  SelectResult,
  SubjectOperations,
} from '@sempods/client-sdk';

/**
 * Read invalidation reported by the browser runtime.
 *
 * The target, access or connection changed while the read was pending, or a
 * guard stopped it for that reason: discard the result. A loader may retry once
 * while the same target stays current and readable.
 */
export type Invalidated = { readonly kind: 'invalidated' };

/** A client read result as seen through a runtime binding. */
export type BoundRead<R> = Exclude<R, Stopped> | Invalidated;

/**
 * Read-only caller-authorized Pod dataset, independent of Context selection and
 * catalogue state. Identity includes connection, subject, Pod and authorization
 * generation. Credential renewal with unchanged grants preserves identity.
 * Context/label changes do not invalidate reads; session end, replacement or
 * changed grants do. No credentials or writable operations reach the app.
 */
export interface BoundPod {
  readonly key: string;
  readonly podUrl: string;
  /** Read means eligible to attempt a request, not that readable data exists. */
  getSnapshot(): Pick<ViewAccess, 'current' | 'read' | 'revision'>;
  /** No initial callback; only changes to this reader's access notify it. */
  subscribe(listener: () => void): () => void;
  readonly sparql: {
    select(
      query: string,
      options?: ReadOptions,
    ): Promise<BoundRead<QueryResult<SelectResult>>>;
    construct(
      query: string,
      options?: ReadOptions,
    ): Promise<BoundRead<QueryResult<readonly JsonLd[]>>>;
  };
}

/**
 * A context view bound to a signed-in connection and one target. Same
 * operations as the client `ContextView`; reads widen with `invalidated`,
 * writes keep the client `WriteResult` (a stopped write is `not-sent`).
 * Apps receive it without tokens or a credential-bearing fetch.
 */
export interface BoundView extends Pick<ContextView, 'podUrl' | 'contextIri'> {
  /** Stable target identity; unchanged by refresh, revalidation or locale. */
  readonly key: string;
  getSnapshot(): ViewAccess;
  /** No initial callback; unsubscribe is idempotent. Listener errors are isolated by the runtime. */
  subscribe(listener: () => void): () => void;
  readonly subjects: Omit<SubjectOperations, 'get'> & {
    get(
      iri: string,
      options?: ReadOptions,
    ): Promise<BoundRead<GetResult<JsonLd>>>;
  };
  readonly sparql: {
    construct(
      query: string,
      options?: ReadOptions,
    ): Promise<BoundRead<QueryResult<readonly JsonLd[]>>>;
  };
}

/** Stable snapshot for one bound target lifetime; credential renewal does not change identity. */
export interface ViewAccess {
  readonly current: boolean;
  readonly read: boolean;
  readonly write: boolean;
  readonly catalogue: 'unknown' | 'loading' | 'ready' | 'failed';
  /** Increases only when in-flight reads become obsolete. */
  readonly revision: number;
}
