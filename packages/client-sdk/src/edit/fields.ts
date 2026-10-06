import type { JsonLd } from '../results.js';
import {
  hasLanguage,
  isDateTime,
  isText,
  MappingError,
  sameData,
  sameTerms,
  termsOf,
  XSD_DATE_TIME,
  type Term,
} from './terms.js';
import { EMBEDDABLE_IRI } from '../iri.js';

/**
 * The conservative definition: two pure, synchronous functions. Its read set
 * is unknown, so saving guards the whole resource version and never rebases.
 */
export interface EditDefinition<D> {
  /** Draft from the resource; throw `MappingError` instead of guessing. */
  read(resource: JsonLd): D;
  /** Merge-patch of the changed predicates only; other values are preserved. */
  patch(resource: JsonLd, draft: D): JsonLd;
  /** `false` disables saving (for example an empty required title). */
  valid?(draft: D): boolean;
}

/**
 * At most one string value: untagged (`language: null`) or with this tag.
 * `Optional` keeps the draft type sound when a field is annotated: plain
 * `TextField` (optionality unknown) drafts `string | null`; `text()` returns
 * `TextField<true>` or `TextField<false>`.
 */
export interface TextField<Optional extends boolean = boolean> {
  readonly kind: 'text';
  readonly predicate: string;
  readonly language: string | null;
  /**
   * `""` is a valid RDF string; `reject` (default) makes the draft invalid,
   * also for whitespace only, so forms need no own blank check. Values are
   * never trimmed: what the person typed is what is stored.
   * In a required field an absent value also reads as `""`, so writing `""`
   * there is a no-op: the field never materializes an empty literal by itself.
   */
  readonly empty: 'reject' | 'allow';
  /**
   * Optional fields read an absent value as `null`. Writing `null` removes
   * this field's value (an explicit intent); writing `""` stores an empty
   * literal when `empty: 'allow'`.
   */
  readonly optional: Optional;
}
/** An IRI-valued predicate mapped to a boolean; any other value is a mapping error. */
export interface FlagField {
  readonly kind: 'flag';
  readonly predicate: string;
  readonly on: string;
  readonly off: string;
  /** Value assumed when the predicate is absent; omitted: absence is a mapping error. */
  readonly absent?: boolean;
}
/** Exactly one IRI value. */
export interface IriField {
  readonly kind: 'iri';
  readonly predicate: string;
}
/**
 * At most one `xsd:dateTime` literal, as its lexical form (for example
 * `2026-10-05T09:30:00+02:00`). Other values of the predicate (untyped
 * strings, other datatypes such as `xsd:date`, IRIs) are preserved and not
 * read; two `xsd:dateTime` values are a mapping error.
 *
 * A written value must be a valid `xsd:dateTime` lexical form with an
 * explicit time zone (`Z` or `±hh:mm`); anything else makes the draft
 * invalid. It is stored unchanged, never normalized, so the offset survives a
 * round trip. A stored value without a time zone is read as it is, not
 * guessed: the draft stays invalid until a time zone is given.
 * `Optional` works as in {@link TextField}.
 */
export interface DateTimeField<Optional extends boolean = boolean> {
  readonly kind: 'dateTime';
  readonly predicate: string;
  /**
   * Optional fields read an absent value as `null`, and writing `null`
   * removes this field's value. A required field reads an absent value as
   * `""`, which is invalid, as in a required `text`.
   */
  readonly optional: Optional;
}
export type Field = TextField | FlagField | IriField | DateTimeField;

// Only a field known to be required drafts `string`; unknown optionality
// (`optional: boolean`) may read `null` and is typed so.
type ValueOf<F> = F extends FlagField
  ? boolean
  : F extends { readonly optional: false }
    ? string
    : F extends { readonly optional: boolean }
      ? string | null
      : string;
export type DraftOf<S extends { readonly [name: string]: Field }> = {
  readonly [K in keyof S]: ValueOf<S[K]>;
};

/**
 * The type-level mark of a definition created by `fields()`. It matches the
 * runtime identity check: a copy, spread or override loses it and is typed as
 * an ordinary `EditDefinition` (complete drafts), exactly as it is handled.
 */
export declare class FieldsMark {
  // A nominal brand only: the class is declared, never instantiated.
  // eslint-disable-next-line no-unused-private-class-members
  #generated: true;
}

/** A definition whose read and write terms are declared per field. */
export interface FieldDefinition<D> extends EditDefinition<D> {
  readonly fields: { readonly [K in keyof D]: Field };
  /** The subject type (`rdf:type`) for lists and creation, when declared. */
  readonly type?: string;
}

const TAG = /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/;

function predicateOf(predicate: string): string {
  if (!EMBEDDABLE_IRI.test(predicate))
    throw new TypeError(`Not an absolute predicate IRI: ${predicate}`);
  return predicate;
}

type TextOptions = {
  readonly language: string | null;
  readonly empty?: 'reject' | 'allow';
};
/** A string in one language, edited in place; other languages and values are preserved. */
export function text(
  predicate: string,
  options: TextOptions & { readonly optional: true },
): TextField<true>;
export function text(
  predicate: string,
  options: TextOptions & { readonly optional?: false },
): TextField<false>;
export function text(
  predicate: string,
  options: TextOptions & { readonly optional?: boolean },
): TextField {
  if (options.language !== null && !TAG.test(options.language))
    throw new TypeError(`Not a language tag: ${options.language}`);
  return Object.freeze({
    kind: 'text',
    predicate: predicateOf(predicate),
    language: options.language,
    empty: options.empty ?? 'reject',
    optional: options.optional ?? false,
  });
}

export function flag(
  predicate: string,
  values: {
    readonly on: string;
    readonly off: string;
    readonly absent?: boolean;
  },
): FlagField {
  if (
    !EMBEDDABLE_IRI.test(values.on) ||
    !EMBEDDABLE_IRI.test(values.off) ||
    values.on === values.off
  )
    throw new TypeError('A flag needs two distinct absolute IRIs.');
  return Object.freeze({
    kind: 'flag',
    predicate: predicateOf(predicate),
    on: values.on,
    off: values.off,
    ...(values.absent === undefined ? {} : { absent: values.absent }),
  });
}

export function iri(predicate: string): IriField {
  return Object.freeze({ kind: 'iri', predicate: predicateOf(predicate) });
}

/** A point in time as an `xsd:dateTime` literal; other values are preserved. */
export function dateTime(
  predicate: string,
  options: { readonly optional: true },
): DateTimeField<true>;
export function dateTime(
  predicate: string,
  options?: { readonly optional?: false },
): DateTimeField<false>;
export function dateTime(
  predicate: string,
  options: { readonly optional?: boolean } = {},
): DateTimeField {
  return Object.freeze({
    kind: 'dateTime',
    predicate: predicateOf(predicate),
    optional: options.optional ?? false,
  });
}

/**
 * XSD 1.1 `dateTime` lexical form with a mandatory time zone. The pattern
 * checks the ranges of each part; the day of the month is checked below.
 */
const DATE_TIME =
  /^-?(\d*(\d{4}))-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?|24:00:00(?:\.0+)?)(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isZonedDateTime(value: string): boolean {
  const match = DATE_TIME.exec(value);
  // A year of more than four digits has no leading zero.
  if (!match || (match[1]!.length > 4 && match[1]![0] === '0')) return false;
  const month = Number(match[3]);
  const day = Number(match[4]);
  if (day > DAYS[month - 1]!) return false;
  if (month !== 2 || day !== 29) return true;
  // 10000 is a multiple of 400: the last four digits decide a leap year.
  const year = Number(match[2]);
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Whether this field reads and replaces the term. */
function owns(field: Field, term: Term): boolean {
  switch (field.kind) {
    case 'text':
      return isText(term) && hasLanguage(term, field.language);
    case 'dateTime':
      return isDateTime(term);
    case 'flag':
    case 'iri':
      return true;
  }
}

/** The terms of the predicate that this field reads and replaces. */
export function owned(field: Field, terms: readonly Term[]): readonly Term[] {
  return terms.filter((t) => owns(field, t));
}

type Value = string | boolean | null;

function readField(field: Field, terms: readonly Term[]): Value {
  const mine = owned(field, terms);
  switch (field.kind) {
    case 'text':
    case 'dateTime': {
      if (mine.length > 1)
        throw new MappingError(
          field.predicate,
          `ambiguous ${field.kind} value`,
        );
      const value = mine[0]?.['@value'] as string | undefined;
      return value ?? (field.optional ? null : '');
    }
    case 'flag': {
      if (mine.length === 0 && field.absent !== undefined) return field.absent;
      const id = mine.length === 1 ? mine[0]!['@id'] : undefined;
      if (id === field.on) return true;
      if (id === field.off) return false;
      throw new MappingError(field.predicate, 'not one of the flag values');
    }
    case 'iri': {
      const id = mine.length === 1 ? mine[0]!['@id'] : undefined;
      if (typeof id !== 'string')
        throw new MappingError(field.predicate, 'expected exactly one IRI');
      return id;
    }
  }
}

function writeField(
  field: Field,
  terms: readonly Term[],
  value: Value,
): readonly Term[] {
  if (readField(field, terms) === value) return terms;
  switch (field.kind) {
    case 'text':
    case 'dateTime': {
      // Only an optional field reaches here with null: explicit removal.
      if (value === null) return terms.filter((t) => !owns(field, t));
      const index = terms.findIndex((t) => owns(field, t));
      if (index >= 0)
        return terms.map((t, i) =>
          i === index ? { ...t, '@value': value } : t,
        );
      return [...terms, ...freshTerms(field, value)];
    }
    case 'flag':
      return [{ '@id': value ? field.on : field.off }];
    case 'iri':
      return [{ '@id': value }];
  }
}

function validField(field: Field, value: unknown): boolean {
  switch (field.kind) {
    case 'text':
      return (
        (value === null && field.optional) ||
        (typeof value === 'string' &&
          (field.empty === 'allow' || value.trim() !== ''))
      );
    case 'flag':
      return typeof value === 'boolean';
    case 'iri':
      return typeof value === 'string' && EMBEDDABLE_IRI.test(value);
    case 'dateTime':
      return (
        (value === null && field.optional) ||
        (typeof value === 'string' && isZonedDateTime(value))
      );
  }
}

/**
 * Whether two fields can own the same term. `flag` and `iri` own every value
 * of their predicate; `text` and `dateTime` own disjoint kinds of literals.
 */
function overlaps(a: Field, b: Field): boolean {
  if (a.predicate !== b.predicate) return false;
  if (a.kind === 'flag' || a.kind === 'iri') return true;
  if (b.kind === 'flag' || b.kind === 'iri') return true;
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'text' || b.kind !== 'text') return true;
  return a.language === null || b.language === null
    ? a.language === b.language
    : a.language.toLowerCase() === b.language.toLowerCase();
}

/**
 * Declares the draft as named fields. Fields that would write the same terms
 * are rejected here, not at save time.
 */
export function fields<S extends { readonly [name: string]: Field }>(
  spec: S,
  options: { readonly type?: string } = {},
): FieldDefinition<DraftOf<S>> & FieldsMark {
  if (options.type !== undefined) predicateOf(options.type);
  const entries = Object.entries(spec) as [keyof S & string, Field][];
  entries.forEach(([name, field], i) => {
    const other = entries.slice(i + 1).find(([, f]) => overlaps(field, f));
    if (other)
      throw new TypeError(
        `Fields ${name} and ${other[0]} write the same terms.`,
      );
  });
  type D = DraftOf<S>;
  const definition: FieldDefinition<D> = Object.freeze({
    fields: Object.freeze({ ...spec }) as FieldDefinition<D>['fields'],
    ...(options.type === undefined ? {} : { type: options.type }),
    read(resource: JsonLd): D {
      return Object.freeze(
        Object.fromEntries(
          entries.map(([name, field]) => [
            name,
            readField(field, termsOf(resource, field.predicate)),
          ]),
        ),
      ) as D;
    },
    patch(resource: JsonLd, draft: D): JsonLd {
      const next = new Map<string, readonly Term[]>();
      for (const [name, field] of entries) {
        const terms =
          next.get(field.predicate) ?? termsOf(resource, field.predicate);
        next.set(
          field.predicate,
          writeField(field, terms, draft[name] as Value),
        );
      }
      // An emptied predicate is removed (RFC 7396 null), not set to [].
      return Object.fromEntries(
        [...next]
          .filter(
            ([predicate, terms]) =>
              !sameTerms(terms, termsOf(resource, predicate)),
          )
          .map(([predicate, terms]) => [
            predicate,
            terms.length === 0 ? null : terms,
          ]),
      );
    },
    valid(draft: D): boolean {
      return entries.every(([name, field]) => validField(field, draft[name]));
    },
  });
  generated.add(definition);
  return definition as FieldDefinition<D> & FieldsMark;
}

/** A definition that declares its fields, so edits can be rebased per field. */
/**
 * Only definitions created by `fields()` carry the per-field guarantees that
 * rebasing and list updates rely on. A look-alike, copied or overridden
 * definition stays a conservative escape hatch, whatever its `fields` says.
 */
const generated = new WeakSet<object>();
export function isFieldDefinition<D>(
  definition: EditDefinition<D>,
): definition is FieldDefinition<D> {
  return generated.has(definition);
}

/** Names of the fields whose values differ between two drafts. */
export function changedFields<D>(
  definition: FieldDefinition<D>,
  a: D,
  b: D,
): readonly string[] {
  return Object.keys(definition.fields).filter(
    (name) =>
      !sameData(
        (a as Record<string, unknown>)[name],
        (b as Record<string, unknown>)[name],
      ),
  );
}

/**
 * Whether the named fields own the same terms in both descriptions. Their
 * patch is computed from the newer description, so every other term there is
 * kept: this is exactly the evidence a bounded field rebase needs.
 */
export function sameOwnedTerms<D>(
  definition: FieldDefinition<D>,
  names: readonly string[],
  a: JsonLd,
  b: JsonLd,
): boolean {
  const fieldsByName = definition.fields as Record<string, Field>;
  try {
    return names.every((name) => {
      const field = fieldsByName[name]!;
      return sameTerms(
        owned(field, termsOf(a, field.predicate)),
        owned(field, termsOf(b, field.predicate)),
      );
    });
  } catch {
    return false;
  }
}

/** `base` with the named fields taken from `mine`. */
export function withFields<D>(names: readonly string[], mine: D, base: D): D {
  return Object.freeze({
    ...base,
    ...Object.fromEntries(
      names.map((name) => [name, (mine as Record<string, unknown>)[name]]),
    ),
  }) as D;
}

/**
 * The description of a new subject: the declared type plus every field's
 * value written as fresh terms. An optional field left `null` is omitted.
 */
export function describeNew<D>(
  definition: FieldDefinition<D>,
  iri: string,
  draft: D,
): JsonLd {
  if (!isFieldDefinition(definition))
    throw new TypeError('Creation needs a definition created by fields().');
  if (definition.valid && !definition.valid(draft))
    throw new TypeError('The new values are not valid.');
  const body: Record<string, unknown> = { '@id': iri };
  if (definition.type) body['@type'] = [definition.type];
  for (const [name, field] of Object.entries(
    definition.fields as Record<string, Field>,
  )) {
    const terms = freshTerms(
      field,
      (draft as Record<string, unknown>)[name] as Value,
    );
    if (terms.length > 0)
      body[field.predicate] = [
        ...((body[field.predicate] as readonly Term[] | undefined) ?? []),
        ...terms,
      ];
  }
  return body;
}

/** A field's value as terms of a subject that does not exist yet. */
function freshTerms(field: Field, value: Value): readonly Term[] {
  switch (field.kind) {
    case 'text':
      if (value === null) return [];
      return [
        field.language === null
          ? { '@value': value }
          : { '@value': value, '@language': field.language },
      ];
    case 'flag':
      return [{ '@id': value ? field.on : field.off }];
    case 'iri':
      return [{ '@id': value }];
    case 'dateTime':
      if (value === null) return [];
      return [{ '@value': value, '@type': XSD_DATE_TIME }];
  }
}
