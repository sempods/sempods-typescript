import type { PodAuth } from './auth.js';
import type {
  CatalogueResult,
  ContextDescriptionResult,
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
import type { SelectResult } from './sparql.js';

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
  /**
   * Read-only queries over the caller's authorized Pod dataset (SPS-SPARQL-007).
   * Requires neither Context selection nor a catalogue. Sends no SDK-added
   * dataset parameters; query text is unchanged and server authorization applies.
   */
  readonly sparql: {
    /** SELECT bindings; preserves order, duplicates and unbound variables. */
    select(
      query: string,
      options?: ReadOptions,
    ): Promise<QueryResult<SelectResult>>;
    /** Expanded JSON-LD nodes, without automatic source-Context provenance. */
    construct(
      query: string,
      options?: ReadOptions,
    ): Promise<QueryResult<readonly JsonLd[]>>;
  };
  /** Operations bound to one explicitly selected context. Never "all contexts". */
  context(contextIri: string, options?: ContextOptions): ContextView;
  /** The caller-relative context catalogue: known access facts, not server authority. */
  catalogue(options?: ReadOptions): Promise<CatalogueResult>;
  /**
   * One Context's registry description (SPS-CTX-032), read from the Context IRI:
   * label, description, public flag and creation time. Descriptive facts only,
   * never authorization; `contextIri` must be a context IRI of this Pod.
   */
  contextDescription(
    contextIri: string,
    options?: ReadOptions,
  ): Promise<ContextDescriptionResult>;
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
  /**
   * Sends both dataset parameters for this Context; never retries unscoped.
   * An unsupported downscope is a failure, and an empty result is a valid `ok`.
   */
  construct(
    query: string,
    options?: ReadOptions,
  ): Promise<QueryResult<readonly JsonLd[]>>;
}
