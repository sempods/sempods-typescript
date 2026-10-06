/** An absolute IRI: a scheme and a non-empty rest without whitespace (internal). */
export const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
/** Lexical IRIREF checks, including C0 controls/space; not full IRI validation. */
export const EMBEDDABLE_IRI =
  // eslint-disable-next-line no-control-regex -- IRIREF explicitly excludes U+0000–U+0020.
  /^[A-Za-z][A-Za-z0-9+.-]*:[^\x00-\x20\s<>"{}|\\^`]+$/;
