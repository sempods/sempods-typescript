import type { JsonLd } from '../results.js';
import { EMBEDDABLE_IRI } from '../iri.js';
import { LANGUAGE_TAG } from './fields.js';
import { hasLanguage, isText, sameData, termsOf, type Term } from './terms.js';

/**
 * Which language variant of a text predicate to show and edit, in order.
 * `null` is the untagged value, `'de'` that tag exactly (tags compare
 * case-insensitively, so `DE` is the same variant), `'de-*'` any regional
 * variant of it (`de-DE`, `de-AT`; not `de` itself) and `'*'` any other tag.
 * A range or `'*'` matching several tags picks the lexically first one, so the
 * statement order of the response never decides. Tags no entry matches are
 * never selected; they are preserved like every other term.
 */
export type LanguageOrder = readonly (string | null)[];

/**
 * One selected language variant of a text predicate, as read. The app keeps
 * it in its draft and replaces it through {@link editTextVariant}.
 */
export interface TextVariant {
  /**
   * The selected language in lower case, `null` for untagged. With no value
   * yet, the language a write creates: the first `null` or plain tag of the
   * order.
   */
  readonly language: string | null;
  /** Its value, or `null` when there is none or `ambiguous` is set. */
  readonly value: string | null;
  /**
   * Every value in this language, in response order. More than one (also
   * under case-equivalent tags such as `de` and `DE`) is a conflict to show:
   * only an explicit edit replaces them.
   */
  readonly values: readonly string[];
  readonly ambiguous: boolean;
}

function checkOrder(order: LanguageOrder): string | null {
  let create: string | null | undefined;
  for (const entry of order) {
    const plain = entry === null || LANGUAGE_TAG.test(entry);
    if (
      entry !== null &&
      !plain &&
      entry !== '*' &&
      !(entry.endsWith('-*') && LANGUAGE_TAG.test(entry.slice(0, -2)))
    )
      throw new TypeError(`Not a language order entry: ${entry}`);
    if (plain && create === undefined) create = entry?.toLowerCase() ?? null;
  }
  if (create === undefined)
    throw new TypeError(
      'A language order needs null or a plain tag to write new values in.',
    );
  return create;
}

function rank(order: LanguageOrder, tag: string | null): number {
  const lower = tag?.toLowerCase() ?? null;
  return order.findIndex((entry) =>
    entry === null || lower === null
      ? entry === lower
      : entry === '*'
        ? true
        : entry.endsWith('-*')
          ? lower.startsWith(entry.slice(0, -1).toLowerCase())
          : lower === entry.toLowerCase(),
  );
}

function textTerms(resource: JsonLd, predicate: string): readonly Term[] {
  if (!EMBEDDABLE_IRI.test(predicate))
    throw new TypeError(`Not an absolute predicate IRI: ${predicate}`);
  return termsOf(resource, predicate);
}

function variantOf(language: string | null, values: readonly string[]) {
  return Object.freeze({
    language,
    value: values.length === 1 ? values[0]! : null,
    values: Object.freeze([...values]),
    ambiguous: values.length > 1,
  });
}

/**
 * The variant of `predicate` to show under the app's order of languages.
 * Throws `MappingError` when the predicate's values are not value objects and
 * `TypeError` for an invalid order or predicate.
 */
export function selectTextVariant(
  resource: JsonLd,
  predicate: string,
  order: LanguageOrder,
): TextVariant {
  const create = checkOrder(order);
  const candidates = textTerms(resource, predicate)
    .filter(isText)
    .map((term) => {
      const tag = term['@language'] as string | undefined;
      return {
        tag: tag?.toLowerCase() ?? null,
        rank: rank(order, tag ?? null),
      };
    })
    .filter((c) => c.rank >= 0)
    .sort((a, b) =>
      a.rank !== b.rank
        ? a.rank - b.rank
        : (a.tag ?? '') < (b.tag ?? '')
          ? -1
          : (a.tag ?? '') > (b.tag ?? '')
            ? 1
            : 0,
    );
  const language = candidates.length > 0 ? candidates[0]!.tag : create;
  const values = textTerms(resource, predicate)
    .filter((term) => isText(term) && hasLanguage(term, language))
    .map((term) => term['@value'] as string);
  return variantOf(language, values);
}

/** The variant with one value (`null`: none), for the app's draft. */
export function editTextVariant(
  variant: TextVariant,
  value: string | null,
): TextVariant {
  return variantOf(variant.language, value === null ? [] : [value]);
}

/**
 * The merge-patch entry that writes `variant` back: `{}` while its values are
 * those on the resource (an untouched draft, also an unresolved conflict),
 * otherwise `predicate` with every value of the variant's language
 * (case-insensitively) replaced and all other terms unchanged, or `null` when
 * none remain. A written value carries the lower-case tag.
 */
export function patchTextVariant(
  resource: JsonLd,
  predicate: string,
  variant: TextVariant,
): JsonLd {
  const terms = textTerms(resource, predicate);
  const mine = (term: Term) =>
    isText(term) && hasLanguage(term, variant.language);
  if (
    sameData(
      terms.filter(mine).map((term) => term['@value']),
      variant.values,
    )
  )
    return {};
  const kept = terms.filter((term) => !mine(term));
  const next = [
    ...kept,
    ...variant.values.map((value) =>
      variant.language === null
        ? { '@value': value }
        : { '@value': value, '@language': variant.language },
    ),
  ];
  return { [predicate]: next.length > 0 ? next : null };
}
