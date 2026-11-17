import type { PodAuth } from './auth.js';
import type {
  CatalogueResult,
  ContextDescriptionResult,
  CreateCondition,
  FindGraph,
  FindOptions,
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
  /**
   * The Pod's Find primitive (sempods-spec `find.md`): text in, the matching
   * resources (usually with their type and label), grouped by source Context.
   * Always sent as `POST` with `include_contexts`. Nothing readable or nothing
   * found is `ok` with an empty body, not `refused`. A group that names no
   * Context of this Pod, or one outside `contexts`, rejects the whole answer.
   */
  find(
    text: string,
    options?: FindOptions,
  ): Promise<QueryResult<readonly FindGraph[]>>;
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
  /** The values of one predicate of a subject in this Context: its slot (SPS-CRUD-041). */
  readonly values: ValueOperations;
  readonly sparql: SparqlOperations;
}

/**
 * Value-level reads and writes through the Pod's slot and single-edge routes
 * (SPS-CRUD-041–054, -059). Unlike a merge patch of `subjects`, adding or
 * removing one value neither needs a read first nor sends the other values.
 * A condition names the slot's tag in this Context, also on `remove`: a
 * value has no tag of its own. `ifNoneMatch: '*'` means the predicate has no
 * value here (SPS-CRUD-053), whatever else the subject holds.
 */
export interface ValueOperations {
  /**
   * `GET` the slot: its values as an unordered array of `{"@id"}` and
   * `{"@value"}` objects (SPS-CRUD-046) with the slot's strong ETag. No
   * value in this Context is `not-found`, like an unreadable Context
   * (SPS-CRUD-017); so is an empty array answered without a tag.
   */
  get(
    iri: string,
    predicate: string,
    options?: ReadOptions,
  ): Promise<GetResult<readonly JsonLd[]>>;
  /**
   * `POST` one value object: `{"@id": iri}`, or `{"@value": …}` with an
   * optional `@language` or `@type` (SPS-CRUD-049). A value already present
   * is `applied` with `already_present` (SPS-CRUD-045).
   */
  add(
    iri: string,
    predicate: string,
    value: JsonLd,
    condition: CreateCondition | MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  /** `PUT` the slot: these values replace all of the predicate's values; `[]` clears it. */
  replace(
    iri: string,
    predicate: string,
    values: readonly JsonLd[],
    condition: CreateCondition | MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  /** `DELETE` the slot: removes every value of the predicate. */
  clear(
    iri: string,
    predicate: string,
    condition: MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
  /**
   * `DELETE` one IRI value through its edge (SPS-CRUD-042); the other values
   * stay. A literal has no edge (SPS-CRUD-048): `get`, then `replace` with
   * the remaining values and `ifMatch`.
   */
  remove(
    iri: string,
    predicate: string,
    target: string,
    condition: CreateCondition | MatchCondition | Overwrite,
    options?: WriteOptions,
  ): Promise<WriteResult>;
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
