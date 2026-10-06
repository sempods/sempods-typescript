import type {
  Pod,
  QueryResult,
  SelectResult,
  SparqlTerm,
} from '@sempods/client-sdk';

// Compiled against installed declarations with noUncheckedIndexedAccess: false.
export async function read(pod: Pod) {
  const result: QueryResult<SelectResult> = await pod.sparql.select(
    'SELECT ?title WHERE { ?s ?p ?title }',
  );
  if (result.kind !== 'ok') return;
  for (const row of result.body.rows) {
    const term: SparqlTerm | undefined = row['title'];
    // @ts-expect-error Unbound variables require a guard even with unchecked indexing enabled.
    const bound: SparqlTerm = row['title'];
    void bound;
    if (term?.type === 'literal') {
      const title: string = term.value;
      const language: string | undefined = term.language;
      void title;
      void language;
    }
    if (term?.type === 'unsupported') {
      const raw: Readonly<Record<string, unknown>> = term.term;
      void raw;
    }
  }
  // @ts-expect-error Pod reads expose no write operations.
  void pod.subjects;
}
