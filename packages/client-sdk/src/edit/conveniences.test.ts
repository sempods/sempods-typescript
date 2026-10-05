/**
 * Conveniences for ordinary apps (lists without SPARQL, creation from a
 * definition, subject IRIs, partial edits), and the app code they shorten.
 */
import { describe, expect, it } from 'vitest';
import type { JsonLd, WriteResult } from '../index.js';
import {
  createResourceEditor,
  fields,
  flag,
  listSubjects,
  newSubjectIri,
  prepareCreation,
  removeSnapshot,
  text,
  updateFields,
  type EditDefinition,
  type ListSource,
} from './index.js';

const S = 'https://schema.org/';
const TASK = `${S}Action`;
const DONE = `${S}CompletedActionStatus`;
const OPEN = `${S}PotentialActionStatus`;
const POD = 'https://pod.example/alice';
const task = fields(
  {
    title: text(`${S}name`, { language: null }),
    done: flag(`${S}actionStatus`, { on: DONE, off: OPEN }),
  },
  { type: TASK },
);

/** One context in memory, with a CONSTRUCT that understands `?s a <type>`. */
function memoryContext() {
  const store = new Map<string, { body: JsonLd; version: number }>();
  let version = 0;
  const queries: string[] = [];
  let nextQuery: (() => Promise<{ readonly kind: string }>) | undefined;
  const etag = (id: string) => `"v${store.get(id)!.version}"`;
  const source: ListSource & { readonly podUrl: string } = {
    podUrl: POD,
    subjects: {
      async get(id) {
        const entry = store.get(id);
        if (!entry) return { kind: 'not-found' };
        return {
          kind: 'ok',
          body: structuredClone(entry.body),
          etag: etag(id),
        };
      },
      async put(id, body): Promise<WriteResult> {
        if (store.has(id)) return { kind: 'precondition-failed' };
        store.set(id, { body: structuredClone(body), version: ++version });
        return { kind: 'applied', status: 201 };
      },
      async patch(id, change, condition): Promise<WriteResult> {
        if (!store.has(id)) return { kind: 'not-found' };
        if (condition.ifMatch !== etag(id))
          return { kind: 'precondition-failed' };
        const body: Record<string, unknown> = { ...store.get(id)!.body };
        for (const [k, v] of Object.entries(change))
          if (v === null) delete body[k];
          else body[k] = v;
        store.set(id, { body, version: ++version });
        return { kind: 'applied', status: 204 };
      },
      async delete(id, condition): Promise<WriteResult> {
        if (!store.has(id)) return { kind: 'not-found' };
        if (condition.ifMatch !== etag(id))
          return { kind: 'precondition-failed' };
        store.delete(id);
        return { kind: 'applied', status: 204 };
      },
    },
    sparql: {
      async construct(query) {
        queries.push(query);
        if (nextQuery) {
          const answer = nextQuery;
          nextQuery = undefined;
          return (await answer()) as never;
        }
        const type = /\?s a <([^>]+)>/.exec(query)?.[1];
        return {
          kind: 'ok',
          body: [...store.values()]
            .map((entry) => structuredClone(entry.body))
            .filter((b) =>
              (b['@type'] as string[] | undefined)?.includes(type!),
            ),
        };
      },
    },
  };
  return {
    source,
    queries,
    body: (id: string) => store.get(id)?.body,
    put: (body: JsonLd) =>
      store.set(body['@id'] as string, { body, version: ++version }),
    answerNextQuery(answer: () => Promise<{ readonly kind: string }>) {
      nextQuery = answer;
    },
  };
}

describe('lists without SPARQL (F3)', () => {
  it('lists the subjects of the definition type as editable snapshots', async () => {
    const pod = memoryContext();
    pod.put({
      '@id': `${POD}/tasks/1`,
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Buy milk' }],
      [`${S}actionStatus`]: [{ '@id': OPEN }],
    });
    pod.put({
      '@id': `${POD}/tasks/2`,
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Broken' }],
      [`${S}actionStatus`]: [{ '@id': 'urn:unknown' }],
    });
    pod.put({ '@id': `${POD}/notes/1`, '@type': [`${S}Note`] });
    const list = await listSubjects(pod.source, task);
    expect(list).toMatchObject({
      kind: 'ok',
      body: {
        items: [
          { iri: `${POD}/tasks/1`, data: { title: 'Buy milk', done: false } },
        ],
        skipped: 1,
      },
    });
    expect(pod.queries).toEqual([
      `CONSTRUCT { ?s ?p ?o } WHERE { ?s a <${TASK}> . ?s ?p ?o }`,
    ]);
  });

  it('keeps blank-node subjects out of editable items (they cannot be addressed)', async () => {
    const pod = memoryContext();
    pod.put({
      '@id': `${POD}/tasks/1`,
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Buy milk' }],
      [`${S}actionStatus`]: [{ '@id': OPEN }],
    });
    // A typed blank node in the same context, fully mappable otherwise.
    pod.put({
      '@id': '_:task',
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Blank task' }],
      [`${S}actionStatus`]: [{ '@id': OPEN }],
    });
    const list = await listSubjects(pod.source, task);
    if (list.kind !== 'ok') throw new Error(list.kind);
    expect(list.body.items.map((t) => t.iri)).toEqual([`${POD}/tasks/1`]);
    expect(list.body.skipped).toBe(1);
    // The valid item still updates and deletes normally.
    expect(
      await updateFields(pod.source, list.body.items[0]!, task, { done: true }),
    ).toEqual({ kind: 'saved' });
    const again = await listSubjects(pod.source, task);
    if (again.kind !== 'ok') throw new Error(again.kind);
    expect(
      await removeSnapshot(pod.source, again.body.items[0]!, task),
    ).toEqual({ kind: 'removed' });
    expect(pod.body('_:task')).toBeDefined();
  });

  it('passes the query outcomes through unchanged', async () => {
    const pod = memoryContext();
    for (const answer of [
      { kind: 'refused', status: 403 },
      { kind: 'cancelled' },
      { kind: 'invalidated' },
    ]) {
      pod.answerNextQuery(async () => answer);
      expect(await listSubjects(pod.source, task)).toEqual(answer);
    }
  });

  it('needs a fields() definition with a type, or an explicit type', async () => {
    const pod = memoryContext();
    const untyped = fields({ title: text(`${S}name`, { language: null }) });
    await expect(listSubjects(pod.source, untyped)).rejects.toThrow(TypeError);
    await expect(
      listSubjects(pod.source, untyped, { type: TASK }),
    ).resolves.toMatchObject({ kind: 'ok' });
    await expect(
      listSubjects(pod.source, task, { type: 'not an iri>' }),
    ).rejects.toThrow(TypeError);
    await expect(
      listSubjects(pod.source, { ...task } as typeof task),
    ).rejects.toThrow(TypeError);
  });
});

describe('creation from a definition (F4) with a subject IRI (F5)', () => {
  it('derives the body from the draft, type included', async () => {
    const pod = memoryContext();
    const iri = newSubjectIri(pod.source, 'tasks');
    expect(iri).toMatch(
      /^https:\/\/pod\.example\/alice\/tasks\/[0-9a-f-]{36}$/,
    );
    expect(newSubjectIri(pod.source, 'tasks')).not.toBe(iri);
    const creation = prepareCreation(pod.source, iri, task, {
      title: 'Buy milk',
      done: false,
    });
    expect(await creation.run()).toEqual({ kind: 'created' });
    expect(pod.body(iri)).toEqual({
      '@id': iri,
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Buy milk' }],
      [`${S}actionStatus`]: [{ '@id': OPEN }],
    });
    // Running the same captured creation again never creates a second one.
    expect(await creation.run()).toEqual({ kind: 'created' });
  });

  it('writes optional text only when present and rejects invalid drafts', () => {
    const pod = memoryContext();
    const noted = fields(
      {
        title: text(`${S}name`, { language: 'en' }),
        note: text(`${S}description`, { language: 'en', optional: true }),
      },
      { type: TASK },
    );
    expect(() =>
      prepareCreation(pod.source, `${POD}/x`, noted, { title: '', note: null }),
    ).toThrow(TypeError);
    expect(() =>
      prepareCreation(pod.source, `${POD}/x`, { ...noted } as typeof noted, {
        title: 'x',
        note: null,
      }),
    ).toThrow(TypeError);
    expect(() => newSubjectIri(pod.source, '_system')).toThrow(TypeError);
    expect(() => newSubjectIri(pod.source, 'a/b')).toThrow(TypeError);
    expect(() => fields({}, { type: 'no iri' })).toThrow(TypeError);
  });
});

describe('partial edits (F7)', () => {
  it('merges only the changed fields into the draft', async () => {
    const pod = memoryContext();
    const iri = `${POD}/tasks/1`;
    pod.put({
      '@id': iri,
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Buy milk' }],
      [`${S}actionStatus`]: [{ '@id': OPEN }],
    });
    const editor = createResourceEditor(pod.source, iri, task);
    await editor.loaded;
    editor.change({ title: 'Buy oat milk' });
    expect(editor.state.draft).toEqual({ title: 'Buy oat milk', done: false });
    expect(Object.isFrozen(editor.state.draft)).toBe(true);
    editor.change({ title: 'Buy almond milk', done: true }); // a full draft still works
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(task.read(pod.body(iri)!)).toEqual({
      title: 'Buy almond milk',
      done: true,
    });
  });
  it('R3: types a copied fields() definition like any other definition, as it runs', async () => {
    const pod = memoryContext();
    const iri = `${POD}/tasks/1`;
    pod.put({
      '@id': iri,
      '@type': [TASK],
      [`${S}name`]: [{ '@value': 'Existing' }],
      [`${S}actionStatus`]: [{ '@id': DONE }],
    });
    const copy = { ...task };
    const editor = createResourceEditor(pod.source, iri, copy);
    await editor.loaded;
    // @ts-expect-error A copy is not recognized as fields(): complete drafts only.
    editor.change({ title: 'Changed' });
    editor.change({ title: 'Changed', done: true });
    expect(editor.state).toMatchObject({
      draft: { title: 'Changed', done: true },
      valid: true,
      canSave: true,
    });
    // The original definition keeps partial changes.
    const original = createResourceEditor(pod.source, iri, task);
    await original.loaded;
    original.change({ title: 'Partial' });
    expect(original.state.draft).toEqual({ title: 'Partial', done: true });
  });

  it('R2: keeps complete-draft replacement for other definitions, such as unions', async () => {
    const pod = memoryContext();
    const iri = `${POD}/items/1`;
    pod.put({ '@id': iri, 'urn:value': [{ '@value': 'Existing' }] });
    type Draft =
      | { readonly kind: 'a'; readonly a: string }
      | { readonly kind: 'b'; readonly b: string };
    const variant: EditDefinition<Draft> = {
      read: (body) => ({
        kind: 'a',
        a: (body['urn:value'] as { '@value': string }[])[0]!['@value'],
      }),
      patch: (_body, draft) => ({
        'urn:value': [{ '@value': draft.kind === 'a' ? draft.a : draft.b }],
      }),
    };
    const editor = createResourceEditor(pod.source, iri, variant);
    await editor.loaded;
    // @ts-expect-error An incomplete variant is not a valid change here.
    editor.change({ kind: 'b' });
    // A complete A-to-B change replaces the draft: no stale `a` remains.
    editor.change({ kind: 'b', b: 'New' });
    expect(editor.state.draft).toEqual({ kind: 'b', b: 'New' });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(pod.body(iri)?.['urn:value']).toEqual([{ '@value': 'New' }]);
  });
});

it('keeps the ordinary TODO flow free of SPARQL, raw JSON-LD and spread drafts', async () => {
  const tasks = memoryContext().source;
  // Create.
  const iri = newSubjectIri(tasks, 'tasks');
  await prepareCreation(tasks, iri, task, {
    title: 'Buy milk',
    done: false,
  }).run();
  // List and complete with one click.
  const listed = await listSubjects(tasks, task);
  if (listed.kind !== 'ok') throw new Error(listed.kind);
  const [first] = listed.body.items;
  expect(await updateFields(tasks, first!, task, { done: true })).toEqual({
    kind: 'saved',
  });
  // Rename.
  const editor = createResourceEditor(tasks, iri, task);
  await editor.loaded;
  editor.change({ title: 'Buy oat milk' });
  expect(await editor.save()).toEqual({ kind: 'saved' });
  editor.dispose();
  // Delete what was listed.
  const again = await listSubjects(tasks, task);
  if (again.kind !== 'ok') throw new Error(again.kind);
  expect(await removeSnapshot(tasks, again.body.items[0]!, task)).toEqual({
    kind: 'removed',
  });
  const empty = await listSubjects(tasks, task);
  expect(empty).toMatchObject({ kind: 'ok', body: { items: [] } });
});
