/** An absolute IRI: a scheme and a non-empty rest without whitespace (internal). */
export const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
/** Lexical IRIREF checks, including C0 controls/space; not full IRI validation. */
export const EMBEDDABLE_IRI =
  // eslint-disable-next-line no-control-regex -- IRIREF explicitly excludes U+0000–U+0020.
  /^[A-Za-z][A-Za-z0-9+.-]*:[^\x00-\x20\s<>"{}|\\^`]+$/;
/** A `%` that does not start a two-digit escape. */
export const MALFORMED_ESCAPE = /%(?![0-9A-Fa-f]{2})/;
/** An embeddable IRIREF whose percent signs each start a two-digit escape. */
export function isIriRef(iri: string): boolean {
  return EMBEDDABLE_IRI.test(iri) && !MALFORMED_ESCAPE.test(iri);
}
export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
