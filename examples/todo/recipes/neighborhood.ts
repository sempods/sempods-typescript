/**
 * The RDF neighborhood of one resource: ordinary pages plus, when the first
 * page is cut, a bounded sample of the relationship kinds it does not show.
 * App-local recipe code on public types, without React: copy and adapt it.
 * The page size, the caps and the presentation belong to the app.
 */
import type { PodRead } from '@sempods/app-sdk';
import type { SelectResult, SparqlTerm } from '@sempods/client-sdk';
import { exactTerm } from './rdf-values.js';

/** `out`: the resource is the subject. `in`: the resource is the object. */
export type Direction = 'out' | 'in';

/** Statements per ordinary page; one more row marks the page as truncated. */
export const PAGE_SIZE = 50;
/** Relationship kinds one sample discovers at most beyond the first page. */
export const MAX_KINDS = 16;
/** Example statements per discovered kind. */
export const MAX_EXAMPLES = 3;

/** A Context of one Pod that the app hides. */
export interface Area {
  readonly pod: string;
  /** The Context IRI (the SPARQL graph). */
  readonly context: string;
}

/** One statement between the resource and another term, in one Context. */
export interface Statement {
  readonly pod: string;
  readonly context: string;
  readonly direction: Direction;
  readonly predicate: string;
  /**
   * The other end, exact as received: the object of an outgoing statement,
   * the subject of an incoming one.
   */
  readonly other: SparqlTerm;
  /**
   * Equal for the same statement in the same Pod and Context. A blank node is
   * local to its read: its statements are equal only within that read.
   */
  readonly key: string;
}

/** One ordinary page of one direction in one Pod. */
export interface Page {
  readonly statements: readonly Statement[];
  /** The Pod has more: the next page starts at the next offset. */
  readonly truncated: boolean;
}

/** What a sample reads: everything its two queries depend on. */
export interface SampleInput {
  readonly root: string;
  readonly direction: Direction;
  /** Predicates the first page shows in visible Contexts, sorted. */
  readonly shown: readonly string[];
  /** Contexts of this Pod the app hides, sorted. */
  readonly hidden: readonly string[];
}

/** Example statements of relationship kinds the first page does not show. */
export interface Sample {
  /** The discovered kinds, at most `MAX_KINDS`, sorted. */
  readonly kinds: readonly string[];
  /** The Pod has more kinds than `MAX_KINDS` beyond the first page. */
  readonly moreKinds: boolean;
  /** At most `MAX_EXAMPLES` per kind: examples, never all of a kind. */
  readonly statements: readonly Statement[];
}

/** Whether `value` can stand verbatim in `<…>` of a query. */
export function isIri(value: string): boolean {
  return (
    /^[a-z][a-z\d+.-]*:/i.test(value) && !/[\p{Cc}\s<>"{}|^`\\]/u.test(value)
  );
}

const iri = (value: string) => {
  // Values come from decoded terms; this is a second check, not a sanitizer.
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

/**
 * One ordinary page: the statements of every Context, sorted, so that the
 * next offset continues where this page stopped. The app may keep its own
 * page query; the sample needs only `?g ?p ?other` of its first page.
 */
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
 * The first query of a sample: kinds in visible Contexts that the first page
 * does not show. Hidden Contexts are excluded before the limit, so they never
 * use it up. One more row says that more kinds exist.
 */
export function kindsQuery(input: SampleInput): string {
  return `SELECT DISTINCT ?p WHERE {
  GRAPH ?g { ${edge(input.root, input.direction)} }
  ${notIn('?g', input.hidden)}
  ${notIn('?p', input.shown)}
} ORDER BY ?p LIMIT ${MAX_KINDS + 1}`;
}

/**
 * The second query: up to `MAX_EXAMPLES` statements of each kind, one limited
 * subquery per kind, so that a dense kind cannot crowd out the others.
 */
export function examplesQuery(
  input: SampleInput,
  kinds: readonly string[],
): string {
  const branches = sorted(kinds)
    .slice(0, MAX_KINDS)
    .map(
      (kind) => `{
    SELECT DISTINCT ?g ?p ?other WHERE {
      VALUES ?p { ${iri(kind)} }
      GRAPH ?g { ${edge(input.root, input.direction)} }
      ${notIn('?g', input.hidden)}
    } ORDER BY ?g ?other LIMIT ${MAX_EXAMPLES}
  }`,
    );
  return `SELECT ?g ?p ?other WHERE {
  ${branches.join(' UNION ')}
} ORDER BY ?p ?g ?other LIMIT ${MAX_KINDS * MAX_EXAMPLES}`;
}

/** A number per read result, so blank nodes of two reads never meet. */
const reads = new WeakMap<SelectResult, number>();
let lastRead = 0;
const readId = (result: SelectResult) => {
  if (!reads.has(result)) reads.set(result, ++lastRead);
  return reads.get(result)!;
};

/** The statements of one read, at most `limit`; incomplete rows are ignored. */
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

/** One ordinary page from the answer to `pageQuery`. */
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

/** The hidden Contexts of one Pod, sorted. */
export function hiddenIn(hidden: readonly Area[], pod: string): string[] {
  return sorted(
    hidden.filter((area) => area.pod === pod).map((area) => area.context),
  );
}

/**
 * What a sample of this direction reads, or undefined: a first page that is
 * complete shows every kind already. Depends on the first page only, so later
 * pages never start another sample.
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

/** The kinds from the answer to `kindsQuery`. */
export function kindsOf(
  result: SelectResult,
  input: SampleInput,
): Pick<Sample, 'kinds' | 'moreKinds'> {
  const kinds = result.rows.flatMap(({ p }) =>
    p?.type === 'iri' && !input.shown.includes(p.value) ? [p.value] : [],
  );
  return {
    kinds: sorted(kinds).slice(0, MAX_KINDS),
    moreKinds: result.rows.length > MAX_KINDS,
  };
}

/** The sample from the answer to `examplesQuery`, within its caps. */
export function sampleOf(
  result: SelectResult,
  pod: string,
  input: SampleInput,
  found: Pick<Sample, 'kinds' | 'moreKinds'>,
): Sample {
  const per = new Map<string, number>();
  const statements = statementsOf(
    result,
    pod,
    input.direction,
    MAX_KINDS * MAX_EXAMPLES,
  ).filter((statement) => {
    // A Pod is not trusted to have applied the filters and limits.
    if (!found.kinds.includes(statement.predicate)) return false;
    if (input.hidden.includes(statement.context)) return false;
    const count = per.get(statement.predicate) ?? 0;
    per.set(statement.predicate, count + 1);
    return count < MAX_EXAMPLES;
  });
  return { ...found, statements };
}

/** A read of one ordinary page through an explicit handle. */
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
 * The two sample queries through an explicit handle: at most two requests,
 * and none after the first when no kind is missing. Both go through the
 * handle's read admission and stop with the same signal.
 */
export function sampleRead(
  input: SampleInput,
  priority?: 'current',
): PodRead<Sample> {
  const query = kindsQuery(input);
  return async (pod, signal) => {
    const options = { signal, ...(priority ? { priority } : {}) };
    const first = await pod.sparql.select(query, options);
    if (first.kind !== 'ok') return first;
    const found = kindsOf(first.body, input);
    if (found.kinds.length === 0)
      return { kind: 'ok', body: { ...found, statements: [] } };
    const second = await pod.sparql.select(
      examplesQuery(input, found.kinds),
      options,
    );
    if (second.kind !== 'ok') return second;
    return {
      kind: 'ok',
      body: sampleOf(second.body, pod.podUrl, input, found),
    };
  };
}

/** What one direction of one source has read so far. */
export interface SourceRead {
  /** The ordinary pages in order; undefined for a page without data. */
  readonly pages: readonly (Page | undefined)[];
  readonly sample?: Sample | undefined;
}

export interface Neighborhood {
  /** Statements of the ordinary pages, in source and page order, each once. */
  readonly statements: readonly Statement[];
  /**
   * Sample statements that no loaded page holds: examples of other kinds,
   * not a complete list. Empty once the pages of their source are complete.
   */
  readonly examples: readonly Statement[];
}

/**
 * The statements to show, without hidden Contexts. Recomputed from the
 * current reads every time: a withdrawn source takes its statements along,
 * and a later page that holds an example replaces it.
 */
export function neighborhood(
  sources: readonly SourceRead[],
  hidden: readonly Area[],
): Neighborhood {
  const hides = new Set(hidden.map((area) => JSON.stringify(area)));
  const visible = (statement: Statement) =>
    !hides.has(
      JSON.stringify({ pod: statement.pod, context: statement.context }),
    );
  const seen = new Set<string>();
  const statements: Statement[] = [];
  for (const { pages } of sources)
    for (const page of pages)
      for (const statement of page?.statements ?? [])
        if (visible(statement) && !seen.has(statement.key)) {
          seen.add(statement.key);
          statements.push(statement);
        }
  const examples: Statement[] = [];
  for (const { pages, sample } of sources) {
    // All pages read and the last one not cut: the pages hold everything.
    const last = pages.at(-1);
    const complete = pages.every(Boolean) && last && !last.truncated;
    if (complete || !sample) continue;
    for (const statement of sample.statements)
      if (visible(statement) && !seen.has(statement.key)) {
        seen.add(statement.key);
        examples.push(statement);
      }
  }
  return { statements, examples };
}
