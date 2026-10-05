import { SdkError, type SdkFailure } from '../errors.js';
import type {
  CreateCondition,
  GetResult,
  JsonLd,
  MatchCondition,
  ReadOptions,
  WriteOptions,
  WriteResult,
} from '../results.js';
import { MappingError } from './terms.js';

/**
 * The one read outcome a runtime binding adds to the client's (app-sdk
 * `Invalidated`): the target or its access changed while reading. It is
 * declared here structurally, so the portable client imports nothing from
 * app-sdk; any other extension is a type error, not a silent case.
 */
export type InvalidatedRead = { readonly kind: 'invalidated' };

/** What editing needs from one target: a client `ContextView` or a runtime `BoundView`. */
export interface ResourceSource {
  readonly subjects: {
    get(
      iri: string,
      options?: ReadOptions,
    ): Promise<GetResult<JsonLd> | InvalidatedRead>;
    put(
      iri: string,
      body: JsonLd,
      condition: CreateCondition,
      options?: WriteOptions,
    ): Promise<WriteResult>;
    patch(
      iri: string,
      change: JsonLd,
      condition: MatchCondition,
      options?: WriteOptions,
    ): Promise<WriteResult>;
    delete(
      iri: string,
      condition: MatchCondition,
      options?: WriteOptions,
    ): Promise<WriteResult>;
  };
}

/** Why there is no usable server state, or why a write did not happen. */
export type EditProblem =
  | { readonly kind: 'not-found' }
  | { readonly kind: 'refused'; readonly status: 401 | 403 }
  /** The resource does not fit the definition; nothing was guessed. */
  | { readonly kind: 'not-mappable'; readonly predicate: string }
  /**
   * Nothing usable was read or nothing was sent: the caller cancelled, a
   * guard stopped it, or the runtime invalidated the target. Try again while
   * the target is current; never treated as absence or refusal.
   */
  | {
      readonly kind: 'unavailable';
      readonly reason: 'cancelled' | 'stopped' | 'invalidated';
    }
  | { readonly kind: 'failure'; readonly failure?: SdkFailure };

export type Fetched =
  | { readonly kind: 'ok'; readonly body: JsonLd; readonly etag: string }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'problem'; readonly problem: EditProblem };

/** One read, with every outcome (including a thrown client failure) as data. */
export async function fetchResource(
  source: ResourceSource,
  iri: string,
  signal?: AbortSignal,
): Promise<Fetched> {
  try {
    const read = await source.subjects.get(iri, signal ? { signal } : {});
    switch (read.kind) {
      case 'ok':
        return { kind: 'ok', body: read.body, etag: read.etag };
      case 'not-found':
        return { kind: 'not-found' };
      case 'refused':
        return {
          kind: 'problem',
          problem: { kind: 'refused', status: read.status },
        };
      case 'cancelled':
      case 'stopped':
      case 'invalidated':
        return {
          kind: 'problem',
          problem: { kind: 'unavailable', reason: read.kind },
        };
    }
  } catch (error) {
    return { kind: 'problem', problem: problemOf(error) };
  }
}

export function problemOf(error: unknown): EditProblem {
  if (error instanceof MappingError)
    return { kind: 'not-mappable', predicate: error.predicate };
  if (error instanceof SdkError)
    return { kind: 'failure', failure: error.reason };
  return { kind: 'failure' };
}

/** A write that did not happen, or was refused, as a problem. */
export function writeProblem(
  result: Exclude<
    WriteResult,
    { kind: 'applied' | 'precondition-failed' | 'uncertain' }
  >,
): EditProblem {
  switch (result.kind) {
    case 'not-found':
      return { kind: 'not-found' };
    case 'refused':
      return { kind: 'refused', status: result.status };
    case 'not-sent':
      return { kind: 'unavailable', reason: result.reason };
  }
}
