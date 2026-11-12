/**
 * The statements around one resource, page by page. When the first page is
 * full, a small sample adds examples of the predicates it does not show.
 * React-free recipe code on public types: copy and adapt it.
 */
import type { PodRead } from '@sempods/app-sdk';
import type { SelectResult, SparqlTerm } from '@sempods/client-sdk';
import { exactTerm } from './rdf-values.js';

/** `out`: the resource is the subject. `in`: it is the object. */
export type Direction = 'out' | 'in';

/** Statements per page. */
export const PAGE_SIZE = 50;
/** Predicates a sample finds at most. */
export const MAX_PREDICATES = 16;
/** Examples per predicate. */
export const MAX_EXAMPLES = 3;

/** A Context of one Pod that the app hides. */
export interface Area {
  readonly pod: string;
  readonly context: string;
}

/** One statement about the resource, in one Context of one Pod. */
export interface Statement {
  readonly pod: string;
  readonly context: string;
  readonly direction: Direction;
  readonly predicate: string;
  /** The other end, exactly as received. */
  readonly other: SparqlTerm;
  /** Equal for the same statement. A blank node counts only within its read. */
  readonly key: string;
}

export interface Page {
  readonly statements: readonly Statement[];
  /** The Pod has more: there is a next page. */
  readonly truncated: boolean;
}

/** Everything a sample depends on. */
export interface SampleInput {
  readonly root: string;
  readonly direction: Direction;
  /** Predicates the first page shows, sorted. */
  readonly shown: readonly string[];
  /** Hidden Contexts of this Pod, sorted. */
  readonly hidden: readonly string[];
}

/** A few examples of predicates the first page does not show. */
export interface Sample {
  readonly predicates: readonly string[];
  /** The Pod has more predicates than `MAX_PREDICATES`. */
  readonly morePredicates: boolean;
  /** At most `MAX_EXAMPLES` per predicate: examples, not all. */
  readonly statements: readonly Statement[];
}

/** Whether `value` can stand in `<…>` of a query. */
export function isIri(value: string): boolean {
  return (
    /^[a-z][a-z\d+.-]*:/i.test(value) && !/[\p{Cc}\s<>"{}|^`\\]/u.test(value)
  );
}

const iri = (value: string) => {
  if (!isIri(value)) throw new Error(`Not an IRI for a query: ${value}`);
  return `<${value}>`;
};
const notIn = (variable: string, values: readonly string[]) =>
  values.length > 0
    ? `FILTER(${variable} NOT IN (${values.map(iri).join(', ')}))`
    : '';
const edge = (root: string, direction: Direction) =>
  direction === 'out' ? `${iri(root)} ?p ?other` : `?other ?p ${iri(root)}`;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

/** One page. One extra row tells that there is a next page. */
export function pageQuery(
  root: string,
  direction: Direction,
  offset: number,
): string {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error(`Not a page offset: ${offset}`);
  return `SELECT DISTINCT ?g ?p ?other WHERE {
  GRAPH ?g { ${edge(root, direction)} }
} ORDER BY ?g ?p ?other LIMIT ${PAGE_SIZE + 1} OFFSET ${offset}`;
}

/**
 * Sample, step 1: predicates the first page does not show. Hidden Contexts
 * are filtered before the limit. One extra row tells that there are more.
 */
export function predicatesQuery(input: SampleInput): string {
  return `SELECT DISTINCT ?p WHERE {
  GRAPH ?g { ${edge(input.root, input.direction)} }
  ${notIn('?g', input.hidden)}
  ${notIn('?p', input.shown)}
} ORDER BY ?p LIMIT ${MAX_PREDICATES + 1}`;
}

/**
 * Sample, step 2: a few statements per predicate. Each predicate has its own
 * limit, so one frequent predicate cannot crowd out the others.
 */
export function examplesQuery(
  input: SampleInput,
  predicates: readonly string[],
): string {
  const branches = sorted(predicates)
    .slice(0, MAX_PREDICATES)
    .map(
      (predicate) => `{
    SELECT DISTINCT ?g ?p ?other WHERE {
      VALUES ?p { ${iri(predicate)} }
      GRAPH ?g { ${edge(input.root, input.direction)} }
      ${notIn('?g', input.hidden)}
    } ORDER BY ?g ?other LIMIT ${MAX_EXAMPLES}
  }`,
    );
  return `SELECT ?g ?p ?other WHERE {
  ${branches.join(' UNION ')}
} ORDER BY ?p ?g ?other LIMIT ${MAX_PREDICATES * MAX_EXAMPLES}`;
}

// A number per read, so blank nodes of two reads never match.
const reads = new WeakMap<SelectResult, number>();
let lastRead = 0;
const readId = (result: SelectResult) => {
  if (!reads.has(result)) reads.set(result, ++lastRead);
  return reads.get(result)!;
};

function statementsOf(
  result: SelectResult,
  pod: string,
  direction: Direction,
  limit: number,
): Statement[] {
  const read = readId(result);
  return result.rows.slice(0, limit).flatMap(({ g, p, other }) => {
    if (g?.type !== 'iri' || p?.type !== 'iri' || !other) return [];
    const term =
      other.type === 'blank' ? [read, exactTerm(other)] : exactTerm(other);
    const key = JSON.stringify([pod, g.value, direction, p.value, term]);
    return [
      { pod, context: g.value, direction, predicate: p.value, other, key },
    ];
  });
}

export function pageOf(
  result: SelectResult,
  pod: string,
  direction: Direction,
): Page {
  return {
    statements: statementsOf(result, pod, direction, PAGE_SIZE),
    truncated: result.rows.length > PAGE_SIZE,
  };
}

/** The hidden Contexts of one Pod. */
export function hiddenIn(hidden: readonly Area[], pod: string): string[] {
  return sorted(
    hidden.filter((area) => area.pod === pod).map((area) => area.context),
  );
}

/**
 * The sample for a full first page, or undefined. Only the first page
 * counts, so loading more pages never starts another sample.
 */
export function sampleInput(
  root: string,
  direction: Direction,
  first: Page,
  hidden: readonly string[],
): SampleInput | undefined {
  if (!first.truncated) return undefined;
  const hiddenSet = new Set(hidden);
  return {
    root,
    direction,
    shown: sorted(
      first.statements
        .filter((statement) => !hiddenSet.has(statement.context))
        .map((statement) => statement.predicate),
    ),
    hidden: sorted(hidden),
  };
}

export function predicatesOf(
  result: SelectResult,
  input: SampleInput,
): Pick<Sample, 'predicates' | 'morePredicates'> {
  const predicates = result.rows.flatMap(({ p }) =>
    p?.type === 'iri' && !input.shown.includes(p.value) ? [p.value] : [],
  );
  return {
    predicates: sorted(predicates).slice(0, MAX_PREDICATES),
    morePredicates: result.rows.length > MAX_PREDICATES,
  };
}

export function sampleOf(
  result: SelectResult,
  pod: string,
  input: SampleInput,
  found: Pick<Sample, 'predicates' | 'morePredicates'>,
): Sample {
  const count = new Map<string, number>();
  // Check the limits again: a Pod may ignore them.
  const statements = statementsOf(
    result,
    pod,
    input.direction,
    MAX_PREDICATES * MAX_EXAMPLES,
  ).filter(({ predicate, context }) => {
    if (!found.predicates.includes(predicate)) return false;
    if (input.hidden.includes(context)) return false;
    const n = count.get(predicate) ?? 0;
    count.set(predicate, n + 1);
    return n < MAX_EXAMPLES;
  });
  return { ...found, statements };
}

/** Reads one page through a `BoundPod`. */
export function pageRead(
  root: string,
  direction: Direction,
  offset: number,
  priority?: 'current',
): PodRead<Page> {
  const query = pageQuery(root, direction, offset);
  return async (pod, signal) => {
    const result = await pod.sparql.select(query, {
      signal,
      ...(priority ? { priority } : {}),
    });
    if (result.kind !== 'ok') return result;
    return { kind: 'ok', body: pageOf(result.body, pod.podUrl, direction) };
  };
}

/**
 * Reads a sample through a `BoundPod`: two requests at most, one when no
 * predicate is missing.
 */
export function sampleRead(
  input: SampleInput,
  priority?: 'current',
): PodRead<Sample> {
  const query = predicatesQuery(input);
  return async (pod, signal) => {
    const options = { signal, ...(priority ? { priority } : {}) };
    const first = await pod.sparql.select(query, options);
    if (first.kind !== 'ok') return first;
    const found = predicatesOf(first.body, input);
    if (found.predicates.length === 0)
      return { kind: 'ok', body: { ...found, statements: [] } };
    const second = await pod.sparql.select(
      examplesQuery(input, found.predicates),
      options,
    );
    if (second.kind !== 'ok') return second;
    return {
      kind: 'ok',
      body: sampleOf(second.body, pod.podUrl, input, found),
    };
  };
}

/** What one direction of one Pod has read so far. */
export interface SourceRead {
  /** The pages in order; undefined for a page without data. */
  readonly pages: readonly (Page | undefined)[];
  readonly sample?: Sample | undefined;
}

export interface Neighborhood {
  /** The statements of the pages, each once. */
  readonly statements: readonly Statement[];
  /** Sample statements that no page holds yet. Empty once all pages are read. */
  readonly examples: readonly Statement[];
}

/** What to show, without hidden Contexts. Recompute it on every change. */
export function neighborhood(
  sources: readonly SourceRead[],
  hidden: readonly Area[],
): Neighborhood {
  const area = ({ pod, context }: Area) => JSON.stringify([pod, context]);
  const hides = new Set(hidden.map(area));
  const visible = (statement: Statement) => !hides.has(area(statement));
  const seen = new Set<string>();
  const add = (list: Statement[], statement: Statement) => {
    if (!visible(statement) || seen.has(statement.key)) return;
    seen.add(statement.key);
    list.push(statement);
  };
  const statements: Statement[] = [];
  for (const { pages } of sources)
    for (const page of pages)
      for (const statement of page?.statements ?? [])
        add(statements, statement);
  const examples: Statement[] = [];
  for (const { pages, sample } of sources) {
    // All pages read, the last one not full: the pages hold everything.
    const last = pages.at(-1);
    if (pages.every(Boolean) && last && !last.truncated) continue;
    for (const statement of sample?.statements ?? []) add(examples, statement);
  }
  return { statements, examples };
}
