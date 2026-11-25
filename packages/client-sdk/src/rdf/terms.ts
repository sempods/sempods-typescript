import type { JsonLd } from '../results.js';

/*
 * RDF terms and quads as the SDK's JSON-LD reader produces them (internal).
 * A dataset keeps JSON-LD lists as list terms, so canonical node objects can
 * write them as `{"@list"}` again; `lowerLists` turns them into the
 * rdf:first/rdf:rest statements that RDF itself has.
 */

export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const RDF_FIRST = `${RDF}first`;
export const RDF_REST = `${RDF}rest`;
export const RDF_NIL = `${RDF}nil`;
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_STRING = `${XSD}string`;

/** xsd:language lexical form; deliberately not full BCP 47 validation. */
export const LANGUAGE_TAG = /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/;

/** A blank node's `id` is scoped to the dataset that produced it. */
export type Subject =
  | { readonly kind: 'iri'; readonly value: string }
  | { readonly kind: 'blank'; readonly id: string };
export type Term =
  | Subject
  /** A JSON-LD value object without `@index` or `@context`. */
  | { readonly kind: 'literal'; readonly value: JsonLd }
  /** A non-empty list is its own collection; `id` keeps two apart. */
  | {
      readonly kind: 'list';
      readonly items: readonly Term[];
      readonly id: number;
    };
export type List = Extract<Term, { kind: 'list' }>;
/**
 * A graph name: an IRI, `_:` and a blank node's `id`, or `undefined` for the
 * default graph. An IRI never starts with `_:`.
 */
export type Graph = string | undefined;
export interface Quad {
  readonly s: Subject;
  readonly p: string;
  readonly o: Term;
  readonly g: Graph;
}

/** The graph name of a subject that names a graph. */
export function graphOf(subject: Subject): string {
  return subject.kind === 'iri' ? subject.value : `_:${subject.id}`;
}

/** The subject a graph name stands for. */
export function subjectOf(name: string): Subject {
  return name.startsWith('_:')
    ? { kind: 'blank', id: name.slice(2) }
    : { kind: 'iri', value: name };
}

/** Equal keys denote the same RDF term. */
export function termKey(term: Term): string {
  switch (term.kind) {
    case 'iri':
      return `<${term.value}>`;
    case 'blank':
      return `_:${term.id}`;
    case 'literal':
      // A JSON literal's payload is data: compared as JSON, keys sorted,
      // without the language-tag rules of RDF literals.
      return term.value['@type'] === '@json'
        ? `json:${jsonKey(term.value['@value'])}`
        : canonical(lexical(term.value));
    case 'list':
      // The empty list is rdf:nil; every other one has its own head node.
      return term.id === 0 ? `<${RDF_NIL}>` : `(#${term.id})`;
  }
}

/** Equal keys denote the same quad. */
export function quadKey({ s, p, o, g }: Quad): string {
  // NUL occurs in no term, so the parts cannot run into each other.
  return [termKey(s), p, termKey(o), g ?? ''].join('\u0000');
}

/**
 * A native number or boolean in its RDF form (JSON-LD 1.1 toRdf), so
 * `{"@value": 2}` and `"2"^^xsd:integer` are one literal.
 */
export function lexical(value: JsonLd): JsonLd {
  const native = value['@value'];
  const type = value['@type'];
  if (typeof native === 'boolean')
    return {
      ...value,
      '@value': String(native),
      '@type': type ?? `${XSD}boolean`,
    };
  if (typeof native !== 'number') return value;
  // An explicit datatype stays; only the lexical form and a default change.
  if (
    !Number.isInteger(native) ||
    Math.abs(native) >= 1e21 ||
    type === `${XSD}double`
  ) {
    const [mantissa, exponent] = native.toExponential().split('e');
    const decimal = mantissa!.includes('.') ? mantissa : `${mantissa}.0`;
    return {
      ...value,
      '@value': `${decimal}E${Number(exponent)}`,
      '@type': type ?? `${XSD}double`,
    };
  }
  return {
    ...value,
    '@value': native.toFixed(0),
    '@type': type ?? `${XSD}integer`,
  };
}

/**
 * JSON with object keys sorted, so equal payloads give equal keys; for JSON
 * data this is the JSON Canonicalization Scheme (RFC 8785) that JSON-LD 1.1
 * uses for `rdf:JSON` literals.
 */
export function jsonKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(jsonKey).join(',')}]`;
  if (isNode(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${jsonKey(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** A canonical key for RDF value data; equal keys denote the same terms. */
export function canonical(value: unknown): string {
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

/**
 * One list as rdf:first/rdf:rest statements in `graph`, with fresh blank
 * nodes from `blank`; its items stay as they are. The empty list is rdf:nil.
 */
export function listChain(
  list: List,
  graph: Graph,
  blank: () => Subject,
): { readonly head: Subject; readonly quads: readonly Quad[] } {
  const heads = list.items.map(blank);
  const quads = list.items.flatMap((item, i): Quad[] => [
    { s: heads[i]!, p: RDF_FIRST, o: item, g: graph },
    {
      s: heads[i]!,
      p: RDF_REST,
      o: heads[i + 1] ?? { kind: 'iri', value: RDF_NIL },
      g: graph,
    },
  ]);
  return { head: heads[0] ?? { kind: 'iri', value: RDF_NIL }, quads };
}

/** The quads with every list, also a nested one, as RDF collections. */
export function lowerLists(
  quads: readonly Quad[],
  blank: () => Subject,
): readonly Quad[] {
  const out: Quad[] = [];
  const lower = (term: Term, graph: Graph): Term => {
    if (term.kind !== 'list') return term;
    const chain = listChain(term, graph, blank);
    for (const quad of chain.quads)
      out.push({ ...quad, o: lower(quad.o, graph) });
    return chain.head;
  };
  for (const quad of quads) out.push({ ...quad, o: lower(quad.o, quad.g) });
  return out;
}

/** A JSON object, not an array. */
export function isNode(value: unknown): value is JsonLd {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
