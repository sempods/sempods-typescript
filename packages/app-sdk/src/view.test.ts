import { expectTypeOf, it } from 'vitest';
import type {
  ContextView,
  CreateCondition,
  GetResult,
  JsonLd,
  MatchCondition,
  QueryResult,
  ReadOptions,
  WriteResult,
} from '@sempods/client-sdk';
import {
  fields,
  listSubjects,
  text,
  type ListSource,
  type ResourceSource,
  type SnapshotList,
} from '@sempods/client-sdk/edit';
import type { BoundRead, BoundView, Invalidated } from './index.js';

/** App-owned: exactly what a repository needs, accepted from both layers. */
interface TaskData {
  readonly subjects: {
    get(
      iri: string,
      options?: ReadOptions,
    ): Promise<GetResult<JsonLd> | Invalidated>;
    patch(
      iri: string,
      change: JsonLd,
      condition: MatchCondition,
    ): Promise<WriteResult>;
    put(
      iri: string,
      body: JsonLd,
      condition: CreateCondition,
    ): Promise<WriteResult>;
  };
  readonly sparql: {
    construct(
      query: string,
      options?: ReadOptions,
    ): Promise<QueryResult<readonly JsonLd[]> | Invalidated>;
  };
}

it('lets one app-owned contract accept a client view and a runtime view', () => {
  expectTypeOf<ContextView>().toExtend<TaskData>();
  expectTypeOf<BoundView>().toExtend<TaskData>();
});

it('lets the edit controller accept a client view and a runtime view', () => {
  expectTypeOf<ContextView>().toExtend<ResourceSource>();
  expectTypeOf<BoundView>().toExtend<ResourceSource>();
  // Both can also list subjects without SPARQL in app code.
  expectTypeOf<ContextView>().toExtend<ListSource>();
  expectTypeOf<BoundView>().toExtend<ListSource>();
});

it('widens runtime reads with invalidated and keeps client writes', () => {
  type Read = Awaited<ReturnType<BoundView['subjects']['get']>>;
  expectTypeOf<Invalidated>().toExtend<Read>();
  expectTypeOf<{ kind: 'stopped' }>().not.toExtend<Read>();
  expectTypeOf<
    Awaited<ReturnType<BoundView['subjects']['patch']>>
  >().toEqualTypeOf<WriteResult>();
});

it('does not pass a runtime view off as a plain client view', () => {
  function asClient(view: BoundView): ContextView {
    // @ts-expect-error Runtime reads may be `invalidated`; the client contract has no such outcome.
    return view;
  }
  void asClient;
});

it('lists through a runtime view without a stopped outcome, as useLoad expects', () => {
  const task = fields(
    { title: text('https://schema.org/name', { language: null }) },
    { type: 'https://schema.org/Action' },
  );
  type Task = { readonly title: string };
  const fromBound = (view: BoundView, signal: AbortSignal) =>
    listSubjects(view, task, { signal });
  expectTypeOf(fromBound).toExtend<
    (
      view: BoundView,
      signal: AbortSignal,
    ) => Promise<BoundRead<QueryResult<SnapshotList<Task>>>>
  >();
  type FromClient = Awaited<
    ReturnType<typeof listSubjects<Task, QueryResult<readonly JsonLd[]>>>
  >;
  expectTypeOf<{ readonly kind: 'stopped' }>().toExtend<FromClient>();
});
