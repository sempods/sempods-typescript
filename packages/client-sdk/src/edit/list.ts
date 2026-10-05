import type { JsonLd, QueryResult, ReadOptions } from '../results.js';
import { isFieldDefinition, type FieldDefinition } from './fields.js';
import { snapshots, type SnapshotList } from './snapshots.js';
import type { InvalidatedRead, ResourceSource } from './source.js';
import { EMBEDDABLE_IRI } from '../iri.js';

type QueryOutcome = QueryResult<readonly JsonLd[]> | InvalidatedRead;

/**
 * A target that can also query: a client `ContextView` or a runtime
 * `BoundView`. `R` is that target's own query outcome, so a list result names
 * exactly the outcomes the target can produce (a bound view never `stopped`).
 */
export interface ListSource<
  R extends QueryOutcome = QueryOutcome,
> extends ResourceSource {
  readonly sparql: {
    construct(query: string, options?: ReadOptions): Promise<R>;
  };
}

/** The query's own outcomes pass through unchanged; only `ok` carries a list. */
export type ListResult<D, R extends QueryOutcome = QueryOutcome> =
  | { readonly kind: 'ok'; readonly body: SnapshotList<D> }
  | Exclude<R, { readonly kind: 'ok' }>;

/**
 * All subjects of a type in the target's context, as editable snapshots.
 * The query returns each subject's whole description there, so a snapshot
 * also supports `removeSnapshot`. Subjects that do not fit the definition are
 * counted in `skipped`. Network failures reject like other client reads.
 */
export async function listSubjects<D, R extends QueryOutcome = QueryOutcome>(
  source: ListSource<R>,
  definition: FieldDefinition<D>,
  options: ReadOptions & { readonly type?: string } = {},
): Promise<ListResult<D, R>> {
  if (!isFieldDefinition(definition))
    throw new TypeError('Lists need a definition created by fields().');
  const type = options.type ?? definition.type;
  if (!type || !EMBEDDABLE_IRI.test(type))
    throw new TypeError(
      'Name the subject type: fields(spec, { type }) or { type }.',
    );
  const result = await source.sparql.construct(
    `CONSTRUCT { ?s ?p ?o } WHERE { ?s a <${type}> . ?s ?p ?o }`,
    options.signal ? { signal: options.signal } : {},
  );
  if (result.kind !== 'ok')
    return result as Exclude<R, { readonly kind: 'ok' }>;
  return { kind: 'ok', body: snapshots(source, result.body, definition) };
}
