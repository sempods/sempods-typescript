import type { CatalogueContext, ContextDescription } from './catalogue.js';
import type { SdkFailure } from './errors.js';

/**
 * Portable client result contract.
 *
 * One JSON-LD node object, raw as answered or sent; not a general JSON-LD
 * processing result. Complete resource representations (`subjects.get` and
 * `subjects.put`) use the canonical wire shape (SPS-CRUD-023): absolute IRIs
 * as keys, values as arrays of `@value`/`@id` objects. A `subjects.patch` body
 * is an RFC 7396 merge patch (SPS-CRUD-038), where `null` removes a predicate.
 * CONSTRUCT nodes are JSON-LD without that guarantee (SPS-SPARQL-016),
 * for example an `rdf:type` key instead of `@type`. The SDK checks only that a
 * read body is a JSON object (a CONSTRUCT body: an array of them).
 */
export type JsonLd = { readonly [key: string]: unknown };

/**
 * An answered refusal: the Pod did not act. A 401 stands when there was no
 * second dispatch: the auth owner could not renew, renewal failed, the caller
 * cancelled while waiting, or a guard stopped the resend.
 */
export type Refused = { readonly kind: 'refused'; readonly status: 401 | 403 };
/** The caller's signal ended the read; discard the result, never retry automatically. */
export type Cancelled = { readonly kind: 'cancelled' };
/** A dispatch guard stopped the read before any request was sent. */
export type Stopped = { readonly kind: 'stopped' };

export type GetResult<T> =
  | { readonly kind: 'ok'; readonly body: T; readonly etag: string }
  | { readonly kind: 'not-found' }
  | Refused
  | Cancelled
  | Stopped;

export type QueryResult<T> =
  { readonly kind: 'ok'; readonly body: T } | Refused | Cancelled | Stopped;

export type CatalogueResult = QueryResult<readonly CatalogueContext[]>;

export type ContextDescriptionResult = QueryResult<ContextDescription>;

/**
 * Outcome of one write. `not-sent` is decided before any dispatch and is safe
 * to retry. `uncertain` means a request may have reached the Pod and its
 * outcome is unknown (lost answer, cancellation after dispatch, 5xx, an
 * unexpected non-error status such as 202, or a seen but untrusted response):
 * re-read before deciding; never resend automatically.
 */
export type WriteResult =
  | {
      readonly kind: 'applied';
      /**
       * The answered success status: 201 created, 200/204 replaced, changed
       * or deleted. For `values.add`: 201 a new value, 200 one already present.
       */
      readonly status: 200 | 201 | 204;
      /**
       * A creation's `Location` (SPS-CRUD-043), resolved to an absolute URL;
       * kept only when it is an operations address of this pod: the created
       * subject's route, or for `values.add` the added IRI value's edge route.
       */
      readonly location?: string;
      /**
       * Value writes only (`values.*`): the slot's new strong entity tag in
       * this Context (SPS-CRUD-052), usable as the next `ifMatch` without a
       * read. Never on `subjects` writes (SPS-CRUD-030), and absent when the
       * Pod sends none or not a strong one.
       */
      readonly etag?: string;
      /**
       * `values.add`, `values.clear` and `values.remove` only: what the Pod
       * reports it did (SPS-CRUD-044). Absent when the Pod sends no readable
       * outcome within 5 seconds, one that does not belong to the operation,
       * or a `204`.
       */
      readonly outcome?: ValueOutcome;
    }
  | { readonly kind: 'precondition-failed' }
  | { readonly kind: 'not-found' }
  | Refused
  | { readonly kind: 'not-sent'; readonly reason: 'cancelled' | 'stopped' }
  | { readonly kind: 'uncertain'; readonly failure: SdkFailure };

/**
 * The Pod's account of an idempotent value write (SPS-CRUD-044), as answered:
 * `values.add` is `created` (`201`) or `already_present` (`200`),
 * `values.clear` is `cleared` or `already_empty`, `values.remove` is
 * `removed` or `already_absent`.
 */
export type ValueOutcome =
  | 'created'
  | 'already_present'
  | 'cleared'
  | 'already_empty'
  | 'removed'
  | 'already_absent';

/**
 * Create only if absent (`If-None-Match: *`). On a value write: only if the
 * predicate has no value in this Context (SPS-CRUD-053).
 */
export type CreateCondition = { readonly ifNoneMatch: '*' };
/** Change only the version that was read (`If-Match`). */
export type MatchCondition = { readonly ifMatch: string };
/** Explicit last-write-wins: a visible expert choice, never a default. */
export type Overwrite = { readonly overwrite: true };

export interface ReadOptions {
  readonly signal?: AbortSignal;
}

/** Options of `Pod.find`. */
export interface FindOptions extends ReadOptions {
  /**
   * The read downscope. Omitted: every Context the caller may read. A list:
   * exactly those Contexts of this Pod, unreadable ones dropped by the Pod.
   * `[]` asks for none: any group in the answer rejects it. Never widened,
   * also not on an authentication resend.
   */
  readonly contexts?: readonly string[];
  /** A positive integer; the Pod applies its own default and maximum. */
  readonly limit?: number;
}

/**
 * What one source Context contributed to a Find answer: its Context IRI and
 * the JSON-LD node objects as answered (raw, like CONSTRUCT nodes). The
 * answer has no rank and no marker separating a hit from its expansion.
 */
export interface FindGraph {
  readonly context: string;
  readonly nodes: readonly JsonLd[];
}

export interface WriteOptions {
  /** Before dispatch: `not-sent`. After dispatch: `uncertain`. */
  readonly signal?: AbortSignal;
}
