/** An absolute IRI: a scheme and a non-empty rest without whitespace (internal). */
export const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;
/** An absolute IRI that may be written as `<…>` in SPARQL or Turtle (internal). */
export const EMBEDDABLE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"{}|\\^`]+$/;
