import { SdkError } from './errors.js';
import { ABSOLUTE_IRI } from './iri.js';

/** One SELECT result document; no inferred variables or client-side deduplication. */
export interface SelectResult {
  /** Projected names from head.vars, in received order, even for an empty result. */
  readonly variables: readonly string[];
  /** Unbound variables are absent, not null. Blank-node labels are local to this result. */
  readonly rows: readonly Readonly<Partial<Record<string, SparqlTerm>>>[];
}

/** Known RDF terms are decoded strictly; unsupported extensions retain their JSON. */
export type SparqlTerm =
  | { readonly type: 'iri'; readonly value: string }
  | { readonly type: 'blank'; readonly value: string }
  | {
      readonly type: 'literal';
      readonly value: string;
      readonly datatype?: string;
      readonly language?: string;
    }
  | {
      readonly type: 'unsupported';
      readonly term: Readonly<Record<string, unknown>>;
    };

/**
 * SPARQL Results JSON §3. Validates the response, not the originating query:
 * empty vars/bindings are accepted as received, without proving query conformance.
 */
export function decodeSelect(value: unknown): SelectResult {
  if (
    !object(value) ||
    !object(value['head']) ||
    !Array.isArray(value['head']['vars']) ||
    !value['head']['vars'].every((v: unknown) => typeof v === 'string') ||
    !object(value['results']) ||
    !Array.isArray(value['results']['bindings']) ||
    'boolean' in value
  )
    throw malformed();
  const variables: readonly string[] = Object.freeze([
    ...value['head']['vars'],
  ]);
  const declared = new Set(variables);
  const rows = value['results']['bindings'].map((binding: unknown) => {
    if (!object(binding)) throw malformed();
    // Variable names such as __proto__ or constructor are data, not prototypes.
    const row = Object.create(null) as Partial<Record<string, SparqlTerm>>;
    for (const [name, term] of Object.entries(binding)) {
      if (!declared.has(name)) throw malformed();
      row[name] = decodeTerm(term);
    }
    return Object.freeze(row);
  });
  return Object.freeze({ variables, rows: Object.freeze(rows) });
}

function decodeTerm(term: unknown): SparqlTerm {
  if (!object(term) || typeof term['type'] !== 'string' || !term['type'])
    throw malformed();
  const type = term['type'];
  if (type !== 'uri' && type !== 'bnode' && type !== 'literal')
    return Object.freeze({ type: 'unsupported', term: Object.freeze(term) });
  const value = term['value'];
  if (typeof value !== 'string') throw malformed();
  if (type === 'uri' || type === 'bnode') {
    if (
      (type === 'uri' ? !ABSOLUTE_IRI.test(value) : !value) ||
      'xml:lang' in term ||
      'datatype' in term
    )
      throw malformed();
    return Object.freeze({ type: type === 'uri' ? 'iri' : 'blank', value });
  }
  const language = term['xml:lang'];
  const datatype = term['datatype'];
  if (
    ('xml:lang' in term && (typeof language !== 'string' || !language)) ||
    ('datatype' in term &&
      (typeof datatype !== 'string' || !ABSOLUTE_IRI.test(datatype))) ||
    ('xml:lang' in term && 'datatype' in term)
  )
    throw malformed();
  return Object.freeze({
    type: 'literal',
    value,
    ...(typeof language === 'string' ? { language } : {}),
    ...(typeof datatype === 'string' ? { datatype } : {}),
  });
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function malformed(): SdkError {
  return new SdkError(
    { code: 'response', problem: 'body' },
    'Malformed SELECT result.',
  );
}
