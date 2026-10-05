import type { JsonLd } from '../results.js';

/** One value object of the canonical shape (SPS-CRUD-023): `{"@id"}` or `{"@value"}`. */
export type Term = { readonly [key: string]: unknown };

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
export const XSD_DATE_TIME = 'http://www.w3.org/2001/XMLSchema#dateTime';

/** The resource or snapshot cannot be mapped to the definition; nothing is guessed. */
export class MappingError extends Error {
  constructor(
    readonly predicate: string,
    message: string,
  ) {
    super(`${predicate}: ${message}`);
    this.name = 'MappingError';
  }
}

/** All values of one predicate; absent means none. */
export function termsOf(resource: JsonLd, predicate: string): readonly Term[] {
  const value = resource[predicate];
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    !value.every(
      (term) =>
        typeof term === 'object' && term !== null && !Array.isArray(term),
    )
  )
    throw new MappingError(predicate, 'expected an array of value objects');
  return value as readonly Term[];
}

/** A plain string literal (untagged or language-tagged), not an IRI or typed value. */
export function isText(term: Term): boolean {
  return (
    typeof term['@value'] === 'string' &&
    (term['@type'] === undefined || term['@type'] === XSD_STRING) &&
    (term['@language'] === undefined || typeof term['@language'] === 'string')
  );
}

/** An `xsd:dateTime` literal with a string lexical form (valid or not). */
export function isDateTime(term: Term): boolean {
  return (
    typeof term['@value'] === 'string' &&
    term['@type'] === XSD_DATE_TIME &&
    term['@language'] === undefined
  );
}

/** Language tags compare case-insensitively (BCP 47); `null` is untagged. */
export function hasLanguage(term: Term, language: string | null): boolean {
  const tag = term['@language'];
  return language === null
    ? tag === undefined
    : typeof tag === 'string' && tag.toLowerCase() === language.toLowerCase();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const literal = '@value' in value;
    const entries = Object.entries(value)
      // RDF 1.1: a simple literal is an xsd:string.
      .filter(
        ([k, v]) =>
          v !== undefined && !(literal && k === '@type' && v === XSD_STRING),
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) =>
        k === '@language' && typeof v === 'string'
          ? `${JSON.stringify(k)}:${JSON.stringify(v.toLowerCase())}`
          : `${JSON.stringify(k)}:${canonical(v)}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** RDF value sets: order-insensitive, language tags case-insensitive. */
export function sameTerms(a: readonly Term[], b: readonly Term[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(canonical).sort();
  const right = b.map(canonical).sort();
  return left.every((term, i) => term === right[i]);
}

/** Structural equality for plain draft data (strings, booleans, arrays, objects). */
export function sameData(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** A deep, frozen copy: captured evidence and commands cannot change later. */
export function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** The same RDF description: every predicate's values and the types, as sets. */
export function sameNode(a: JsonLd, b: JsonLd): boolean {
  try {
    const keys = new Set(
      [...Object.keys(a), ...Object.keys(b)].filter((key) => key !== '@id'),
    );
    return [...keys].every((key) =>
      key === '@type'
        ? sameTypes(a[key], b[key])
        : sameTerms(termsOf(a, key), termsOf(b, key)),
    );
  } catch {
    return false;
  }
}
export function sameTypes(a: unknown, b: unknown): boolean {
  const list = (v: unknown) =>
    (Array.isArray(v) ? v : v === undefined ? [] : [v]).map(String).sort();
  const [x, y] = [list(a), list(b)];
  return x.length === y.length && x.every((t, i) => t === y[i]);
}

/** The description a merge-patch produces (RFC 7396 as SPS-CRUD-035/038 apply it). */
export function merged(body: JsonLd, patch: JsonLd): JsonLd {
  const result: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete result[key];
    else result[key] = value;
  return result;
}
