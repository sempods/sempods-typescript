import type {
  BoundPod,
  BoundRead,
  AppSnapshot,
  BrowserRuntime,
} from '@sempods/app-sdk';
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

// The installed React-free app entry exposes the reader without a write surface.
export async function runtimeRead(
  runtime: BrowserRuntime,
  snapshot: AppSnapshot,
  id: string,
) {
  const pod: BoundPod = runtime.bindPod(id);
  const selected: BoundPod | null = snapshot.pod;
  void selected;
  const access: {
    readonly current: boolean;
    readonly read: boolean;
    readonly revision: number;
  } = pod.getSnapshot();
  void access;
  const result: BoundRead<QueryResult<SelectResult>> = await pod.sparql.select(
    'SELECT ?title WHERE { ?s ?p ?title }',
  );
  if (result.kind === 'ok') {
    // @ts-expect-error Runtime SELECT bindings are sparse as well.
    const bound: SparqlTerm = result.body.rows[0]!['title'];
    void bound;
  }
  // @ts-expect-error Runtime Pod handles cannot edit subjects.
  void pod.subjects;
  // @ts-expect-error Runtime Pod access has no context-write permission.
  void pod.getSnapshot().write;
}
