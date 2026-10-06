import type {
  BoundPod,
  BoundRead,
  AppSnapshot,
  BrowserRuntime,
  BoundView,
  LoadState,
  PodRead,
  ViewRead,
} from '@sempods/app-sdk';
import { createViewLoader } from '@sempods/app-sdk';
import type {
  Pod,
  QueryResult,
  SelectResult,
  SparqlTerm,
  JsonLd,
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

// Both inference and explicit result generics retain the supplied handle type.
export function loaders(view: BoundView, pod: BoundPod) {
  const scoped = createViewLoader(view, (target, signal) => {
    const context: BoundView = target;
    void context;
    // @ts-expect-error A Context callback does not acquire Pod SELECT operations.
    void target.sparql.select;
    return target.sparql.construct('CONSTRUCT {} WHERE {}', { signal });
  });
  const overview = createViewLoader(pod, (target, signal) => {
    const reader: BoundPod = target;
    void reader;
    // @ts-expect-error A Pod callback cannot edit Context subjects.
    void target.subjects;
    return target.sparql.select('SELECT ?x WHERE {}', { signal });
  });
  const state: LoadState<SelectResult> = overview.getSnapshot();
  void state;
  const podRead: PodRead<SelectResult> = (target, signal) =>
    target.sparql.select('SELECT ?x WHERE {}', { signal });
  const viewRead: ViewRead<readonly JsonLd[]> = (target, signal) =>
    target.sparql.construct('CONSTRUCT {} WHERE {}', { signal });
  createViewLoader<SelectResult>(pod, podRead);
  createViewLoader<readonly JsonLd[]>(view, viewRead);
  // @ts-expect-error A supplied Pod must not infer a Context callback.
  createViewLoader(pod, viewRead);
  // @ts-expect-error A supplied Context must not infer a Pod callback.
  createViewLoader(view, podRead);
  return { scoped, overview };
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
