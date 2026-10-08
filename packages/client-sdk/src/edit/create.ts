import type { JsonLd, WriteOptions, WriteResult } from '../results.js';
import {
  fetchResource,
  problemOf,
  writeProblem,
  type EditProblem,
  type ResourceSource,
} from './source.js';
import {
  describeNew,
  isFieldDefinition,
  type EditDefinition,
  type FieldDefinition,
} from './fields.js';
import { frozenCopy, sameNode } from './terms.js';

export type CreateOutcome =
  /** Confirmed by the Pod's answer to this creation. */
  | { readonly kind: 'created' }
  /** A different resource holds the IRI; this creation wrote nothing. */
  | { readonly kind: 'exists' }
  /**
   * An answer was lost, so this creation may or may not have happened. This
   * includes a failed create-only condition while the IRI holds this body or
   * cannot be read: a browser may resend a creation whose connection closed
   * after the Pod applied it, and the resend then finds its own resource.
   * Running it again is safe and cannot create a second resource. After a
   * lost answer, a found resource stays unconfirmed: `desiredObserved` (it
   * holds this body) is not proof that this creation wrote it.
   */
  | { readonly kind: 'unconfirmed'; readonly desiredObserved?: boolean }
  /** The Pod refused it before acting, or it was not sent; nothing was written. */
  | { readonly kind: 'not-created'; readonly reason: EditProblem['kind'] };

/** One captured creation: a fixed IRI and body; running it again is always safe. */
export interface Creation {
  readonly iri: string;
  run(options?: WriteOptions): Promise<CreateOutcome>;
}

/**
 * Captures one IRI and body for create-only (`If-None-Match: *`). Generate the
 * IRI once per intended resource, outside the retry path. Only the Pod's answer
 * confirms `created`. Once an answer was lost, the creation stays `unconfirmed`
 * until actual evidence settles it: a failed or refused retry cannot disprove
 * it, and a found resource holding the body (`desiredObserved`) is no proof.
 *
 * For several resources, prepare one creation per item and run them one at a
 * time. Stop at the first result that is not `created` and leave the remaining
 * items unsent. Retry an `unconfirmed` item only by running its creation again,
 * never under a new IRI.
 */
export function prepareCreation<D>(
  source: ResourceSource,
  iri: string,
  definition: FieldDefinition<D>,
  draft: D,
): Creation;
export function prepareCreation(
  source: ResourceSource,
  iri: string,
  body: JsonLd,
): Creation;
export function prepareCreation<D>(
  source: ResourceSource,
  iri: string,
  bodyOrDefinition: JsonLd | FieldDefinition<D>,
  draft?: D,
): Creation {
  // From a fields() definition the body (type included) follows from the draft.
  const fromDraft = arguments.length > 3;
  if (fromDraft && !isFieldDefinition(bodyOrDefinition as EditDefinition<D>))
    throw new TypeError('Creation needs a definition created by fields().');
  const body = fromDraft
    ? describeNew(bodyOrDefinition as FieldDefinition<D>, iri, draft as D)
    : (bodyOrDefinition as JsonLd);
  if (body['@id'] !== undefined && body['@id'] !== iri)
    throw new TypeError('The body describes another subject.');
  // A private copy: later changes to the caller's body cannot alter the command.
  const resource: JsonLd = frozenCopy({ ...body, '@id': iri });
  let pending: Promise<CreateOutcome> | undefined;
  let lost = false;
  // An applied answer settles this captured command for good.
  let confirmed = false;

  async function attempt(options: WriteOptions): Promise<CreateOutcome> {
    let result: WriteResult;
    try {
      result = await source.subjects.put(
        iri,
        resource,
        { ifNoneMatch: '*' },
        options,
      );
    } catch (error) {
      // A failed retry cannot disprove an earlier dispatched creation.
      if (lost) return { kind: 'unconfirmed' };
      return { kind: 'not-created', reason: problemOf(error).kind };
    }
    switch (result.kind) {
      case 'applied':
        confirmed = true;
        return { kind: 'created' };
      case 'uncertain':
        lost = true;
        return { kind: 'unconfirmed' };
      case 'precondition-failed': {
        // A taken IRI and a creation resent below Fetch look alike: only a
        // different resource there shows that this creation wrote nothing.
        const current = await fetchResource(source, iri, options.signal);
        const desiredObserved =
          current.kind === 'ok' && sameNode(resource, current.body);
        if (!lost && current.kind === 'ok' && !desiredObserved)
          return { kind: 'exists' };
        lost = true;
        if (current.kind === 'problem') return { kind: 'unconfirmed' };
        return { kind: 'unconfirmed', desiredObserved };
      }
      default:
        if (lost) return { kind: 'unconfirmed' };
        return { kind: 'not-created', reason: writeProblem(result).kind };
    }
  }

  return Object.freeze({
    iri,
    run(options: WriteOptions = {}) {
      if (confirmed) return Promise.resolve<CreateOutcome>({ kind: 'created' });
      pending ??= attempt(options).finally(() => {
        pending = undefined;
      });
      return pending;
    },
  });
}

// One plain path segment; reserved `_system` and `.well-known` cannot match.
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A fresh subject IRI under the Pod, for example `{pod}/tasks/{uuid}`.
 * Generate it once per intended resource and keep it with the creation, so
 * running the creation again can never produce a second resource.
 */
export function newSubjectIri(
  target: { readonly podUrl: string },
  collection: string,
): string {
  if (!SEGMENT.test(collection))
    throw new TypeError(`Not a plain collection name: ${collection}`);
  return `${target.podUrl}/${collection}/${crypto.randomUUID()}`;
}
