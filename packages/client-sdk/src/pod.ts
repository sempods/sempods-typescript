import type { PodAuth } from './auth.js';
import type {
  CatalogueResult,
  CreateCondition,
  GetResult,
  JsonLd,
  MatchCondition,
  Overwrite,
  QueryResult,
  ReadOptions,
  WriteOptions,
  WriteResult,
} from './results.js';
import type { PodFetch } from './transport.js';

/** Configuration consumed by `createPod`. */
export interface PodOptions {
  readonly auth: PodAuth;
  /** Trusted transport override; the client still applies its safe request policy. */
  readonly fetch?: PodFetch;
  /** Explicit local development only. Remote pods always require HTTPS. */
  readonly development?: 'loopback-http';
  /** Checked before every dispatch of this pod, including an authentication resend. */
  readonly beforeDispatch?: DispatchGuard;
}

/**
 * Lets a runtime bind requests to a connection or target lifetime; standalone
 * scripts usually omit it. Checked immediately before every dispatch:
 * - before the initial dispatch, `false` means nothing is sent (reads:
 *   `stopped`, writes: `not-sent`);
 * - before an authentication resend, `false` keeps the first answer: the
 *   request was already refused, so the result is `refused 401`, never
 *   `not-sent` or `uncertain`.
 */
export type DispatchGuard = () => boolean;

export interface ContextOptions {
  /** Checked before every dispatch of this view, in addition to the pod's guard. */
  readonly beforeDispatch?: DispatchGuard;
}

/** One validated Pod and one credential owner. Requests go only to its constructed endpoints. */
export interface Pod {
  readonly podUrl: string;
  /** Operations bound to one explicitly selected context. Never "all contexts". */
  context(contextIri: string, options?: ContextOptions): ContextView;
  /** The caller-relative context catalogue: known access facts, not server authority. */
  catalogue(options?: ReadOptions): Promise<CatalogueResult>;
}

export interface ContextView {
  readonly podUrl: string;
  readonly contextIri: string;
  /** Any subject IRI through the Pod's system resource route (SPS-CRUD-040). */
  readonly subjects: SubjectOperations;
  readonly sparql: SparqlOperations;
}

export interface SubjectOperations {
  get(iri: string, options?: ReadOptions): Promise<GetResult<JsonLd>>;
  put(
    iri: string,
    body: JsonLd,
    condition: CreateCondition | MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  /** JSON Merge Patch of the named predicates only (SPS-CRUD-035). */
  patch(
    iri: string,
    change: JsonLd,
    condition: MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  delete(
    iri: string,
    condition: MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
}

export interface SparqlOperations {
  /** Scoped to the view's context; an empty result is a valid `ok`. */
  construct(
    query: string,
    options?: ReadOptions,
  ): Promise<QueryResult<readonly JsonLd[]>>;
}
