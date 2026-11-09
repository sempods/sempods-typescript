/**
 * Readable text for generic SPARQL terms, kept beside the exact RDF term.
 * App-local recipe code on public types, without React: copy and adapt it.
 * The vocabulary, address predicates and texts belong to the app.
 */
import type { Formatters, Language } from '@sempods/app-sdk';
import type { SparqlTerm } from '@sempods/client-sdk';

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SCHEMA = 'https://schema.org/';

/** Labels by IRI, then by UI language; `en` is the fallback. */
export type Vocabulary = Readonly<
  Record<string, Readonly<Partial<Record<Language, string>> & { en: string }>>
>;

/** A few common terms. Spread the app's own vocabulary after it to override. */
export const commonVocabulary: Vocabulary = {
  [`${RDF}type`]: { en: 'type', de: 'Typ' },
  [`${RDFS}label`]: { en: 'label', de: 'Bezeichnung' },
  [`${RDFS}comment`]: { en: 'comment', de: 'Kommentar' },
  [`${SCHEMA}name`]: { en: 'name', de: 'Name' },
  [`${SCHEMA}url`]: { en: 'web address', de: 'Webadresse' },
  [`${XSD}string`]: { en: 'text', de: 'Text' },
  [`${XSD}date`]: { en: 'date', de: 'Datum' },
  [`${XSD}dateTime`]: { en: 'date and time', de: 'Datum und Uhrzeit' },
  [`${XSD}integer`]: { en: 'integer', de: 'Ganzzahl' },
  [`${XSD}decimal`]: { en: 'decimal', de: 'Dezimalzahl' },
  [`${XSD}boolean`]: { en: 'yes/no', de: 'Ja/Nein' },
  [`${XSD}anyURI`]: { en: 'address', de: 'Adresse' },
};

/** Predicates whose IRI values are web addresses to open, not resources. */
export const commonAddressPredicates: ReadonlySet<string> = new Set([
  `${SCHEMA}url`,
  `${SCHEMA}contentUrl`,
  `${SCHEMA}thumbnailUrl`,
  'http://xmlns.com/foaf/0.1/homepage',
]);

/**
 * Characters that are invisible or reorder text: controls, format characters
 * such as bidi overrides and tags, surrogates, private use, line separators
 * and blank fillers.
 */
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800]/u;

/**
 * The app's label for `iri`, else a readable name from the IRI itself. A
 * lookup in a fixed table: an unknown term never causes a request.
 */
export function labelFor(
  iri: string,
  vocabulary: Vocabulary,
  language: Language,
): string {
  const entry = Object.hasOwn(vocabulary, iri) ? vocabulary[iri] : undefined;
  return entry?.[language] ?? entry?.en ?? readableName(iri);
}

/**
 * The IRI's last `#`, `/` or `:` segment. It is decoded unless the result
 * would be blank, start with a combining mark or contain whitespace or
 * invisible characters; those already in the IRI are escaped.
 */
export function readableName(iri: string): string {
  const local = /[^#/:]+$/.exec(iri.replace(/[#/]+$/, ''))?.[0];
  if (!local) return visible(iri);
  let decoded = local;
  try {
    decoded = decodeURIComponent(local);
  } catch {
    // A malformed escape stays encoded.
  }
  const readable =
    /[\p{L}\p{N}]/u.test(decoded) &&
    !/^\p{M}|\s/u.test(decoded) &&
    !INVISIBLE.test(decoded);
  return visible(readable ? decoded : local);
}

export interface WebAddress {
  /** What the open action navigates to: the parsed `http(s)` URL. */
  readonly href: string;
  /** Host (IDNs as `xn--…`) and port, for display. */
  readonly host: string;
  /** The path without a lone `/`, as encoded; query and fragment are left out. */
  readonly path: string;
}

/**
 * An `http:` or `https:` address without credentials or whitespace, else
 * undefined. Parsing a value never fetches it.
 */
export function webAddress(value: string): WebAddress | undefined {
  if (/\s/.test(value) || INVISIBLE.test(value)) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username || url.password) return undefined;
  return {
    href: url.href,
    host: url.host,
    path: url.pathname === '/' ? '' : url.pathname,
  };
}

/** The term in N-Triples style, as received; invisible characters escaped. */
export function exactTerm(term: SparqlTerm): string {
  switch (term.type) {
    case 'iri':
      return `<${visible(term.value)}>`;
    case 'blank':
      return `_:${visible(term.value)}`;
    case 'literal': {
      const quoted = `"${visible(
        term.value.replace(/["\\]/g, (char) => `\\${char}`),
      )}"`;
      if (term.language) return `${quoted}@${term.language}`;
      return term.datatype ? `${quoted}^^<${visible(term.datatype)}>` : quoted;
    }
    case 'unsupported':
      return visibleJson(JSON.stringify(term.term));
  }
}

const INVISIBLES = new RegExp(INVISIBLE.source, 'gu');

/** Escapes invisible characters as N-Triples `\\uXXXX` or `\\UXXXXXXXX`. */
function visible(value: string): string {
  return value.replace(INVISIBLES, (char) => {
    const code = char.codePointAt(0)!;
    return code > 0xffff
      ? `\\U${code.toString(16).padStart(8, '0')}`
      : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

/** The same in JSON, which has only `\\uXXXX`: one per UTF-16 unit, so it parses. */
function visibleJson(json: string): string {
  return json.replace(INVISIBLES, (char) =>
    char
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}

/**
 * Years 1000–9999 without a time zone. `format.dateOnly` also reads earlier
 * years, but shows 0050 as "50", which reads like 1950.
 */
const DAY = /^[1-9]\d{3}-\d{2}-\d{2}$/;
/** An `xsd:dateTime` with a time zone, so it names one instant. */
const INSTANT =
  /^([1-9]\d{3}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;

/**
 * A formatted date, or undefined to show the lexical form. Only `xsd:date`
 * and `xsd:dateTime`: a date-like `xsd:string` stays as it is.
 */
export function readableDate(
  value: string,
  datatype: string | undefined,
  format: Formatters,
): string | undefined {
  try {
    if (datatype === `${XSD}date` && DAY.test(value))
      return format.dateOnly(value);
    const instant = datatype === `${XSD}dateTime` && INSTANT.exec(value);
    if (instant) {
      format.dateOnly(instant[1]!); // Throws for a day such as 2026-02-30.
      // Its offset can move an instant out of the range, such as into 0999.
      const year = new Date(value).getUTCFullYear();
      if (year >= 1000 && year <= 9999) return format.dateTime(value);
    }
  } catch {
    // An unsupported or invalid lexical form stays exact.
  }
  return undefined;
}

export interface ValueOptions {
  /** From `useSdkLocale()` or `createLocale(…)`: formatters and UI language. */
  readonly format: Formatters;
  readonly language: Language;
  readonly vocabulary: Vocabulary;
  /** The predicate the term is the value of, if any. */
  readonly predicate?: string | undefined;
  readonly addressPredicates?: ReadonlySet<string>;
  readonly texts: { readonly blank: string; readonly unsupported: string };
}

export interface ValuePresentation {
  /** Compact readable text, for example of a graph node or a table cell. */
  readonly text: string;
  /** The RDF language of `text`, for its `lang` attribute. */
  readonly language?: string;
  /** The literal's language or datatype, readable. */
  readonly note?: string;
  /** The original term, for details or copying. */
  readonly exact: string;
  /** Offered as a separate open action; the term itself is unchanged. */
  readonly address?: WebAddress;
}

/** One presentation of a term, shared by compact text and details. */
export function describeValue(
  term: SparqlTerm,
  options: ValueOptions,
): ValuePresentation {
  const exact = exactTerm(term);
  switch (term.type) {
    case 'iri': {
      // Only declared address predicates turn an IRI into a web address.
      const address = options.addressPredicates?.has(options.predicate ?? '')
        ? webAddress(term.value)
        : undefined;
      if (address) return { text: address.host + address.path, exact, address };
      return {
        text: labelFor(term.value, options.vocabulary, options.language),
        exact,
      };
    }
    case 'blank':
      return { text: options.texts.blank, exact };
    case 'unsupported':
      return { text: options.texts.unsupported, exact };
    case 'literal':
      return describeLiteral(term, exact, options);
  }
}

function describeLiteral(
  term: Extract<SparqlTerm, { type: 'literal' }>,
  exact: string,
  options: ValueOptions,
): ValuePresentation {
  if (term.language)
    return {
      text: term.value,
      language: term.language,
      note: languageName(term.language, options.language),
      exact,
    };
  const { datatype } = term;
  const note =
    datatype && datatype !== `${XSD}string`
      ? labelFor(datatype, options.vocabulary, options.language)
      : undefined;
  const plain = !datatype || datatype === `${XSD}string`;
  // A literal stays a literal: an address in it is only offered to open.
  const address =
    plain || datatype === `${XSD}anyURI` ? webAddress(term.value) : undefined;
  const text = address
    ? address.host + address.path
    : (readableDate(term.value, datatype, options.format) ?? term.value);
  return {
    text,
    ...(note ? { note } : {}),
    exact,
    ...(address ? { address } : {}),
  };
}

/** In the UI language, like the other notes. */
function languageName(tag: string, language: Language): string {
  try {
    return new Intl.DisplayNames(language, { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
