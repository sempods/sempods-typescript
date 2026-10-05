import { describe, expect, it, vi } from 'vitest';
import { createPod, type JsonLd, type WriteResult } from '../index.js';
import {
  createResourceEditor,
  fields,
  flag,
  iri,
  MappingError,
  prepareCreation,
  removeSnapshot,
  snapshots,
  text,
  updateFields,
  type ResourceEditor,
  type ResourceSource,
} from './index.js';

const NAME = 'https://schema.org/name';
const STATUS = 'https://example.org/status';
const LIST = 'https://example.org/list';
const DONE = 'https://example.org/Done';
const OPEN = 'https://example.org/Open';
const TASK = 'https://pod.example/alice/tasks/1';
const lost: WriteResult = {
  kind: 'uncertain',
  failure: { code: 'transport', problem: 'network' },
};

const task = fields({
  title: text(NAME, { language: 'en' }),
  done: flag(STATUS, { on: DONE, off: OPEN }),
});
type Task = { readonly title: string; readonly done: boolean };

const initial = (): JsonLd => ({
  '@id': TASK,
  '@type': ['https://example.org/Task'],
  [NAME]: [
    { '@value': 'Buy milk', '@language': 'en' },
    { '@value': 'Milch kaufen', '@language': 'de' },
  ],
  [STATUS]: [{ '@id': OPEN }],
});

type Method = 'get' | 'put' | 'patch' | 'delete';
type Hook = (real: () => Promise<unknown>) => Promise<unknown>;

/** A Pod with one context in memory: strong versions, RFC 7396 patch, 412/404. */
function memoryPod(resources: Record<string, JsonLd> = { [TASK]: initial() }) {
  const store = new Map<string, { body: JsonLd; version: number }>();
  let version = 0;
  for (const [id, body] of Object.entries(resources))
    store.set(id, { body, version: ++version });
  const calls: { method: Method; iri: string; condition?: unknown }[] = [];
  const hooks: Partial<Record<Method, Hook[]>> = {};
  let readable = true;
  const etag = (id: string) => `"v${store.get(id)!.version}"`;
  const matches = (id: string, condition: { ifMatch?: string }) =>
    store.has(id) && condition.ifMatch === etag(id);

  function run<T>(method: Method, real: () => Promise<T>): Promise<T> {
    const hook = hooks[method]?.shift();
    return (hook ? hook(real) : real()) as Promise<T>;
  }

  const source: ResourceSource = {
    subjects: {
      get: (id) =>
        run('get', async () => {
          calls.push({ method: 'get', iri: id });
          if (!readable) return { kind: 'refused', status: 403 } as const;
          const entry = store.get(id);
          if (!entry) return { kind: 'not-found' } as const;
          return {
            kind: 'ok',
            body: structuredClone(entry.body),
            etag: etag(id),
          } as const;
        }),
      put: (id, body, condition) =>
        run('put', async (): Promise<WriteResult> => {
          calls.push({ method: 'put', iri: id, condition });
          if (store.has(id)) return { kind: 'precondition-failed' };
          store.set(id, { body: structuredClone(body), version: ++version });
          return { kind: 'applied', status: 201 };
        }),
      patch: (id, change, condition) =>
        run('patch', async (): Promise<WriteResult> => {
          calls.push({ method: 'patch', iri: id, condition });
          if (!store.has(id)) return { kind: 'not-found' };
          if (!matches(id, condition)) return { kind: 'precondition-failed' };
          const body: Record<string, unknown> = { ...store.get(id)!.body };
          for (const [key, value] of Object.entries(change))
            if (value === null) delete body[key];
            else body[key] = structuredClone(value);
          store.set(id, { body, version: ++version });
          return { kind: 'applied', status: 204 };
        }),
      delete: (id, condition) =>
        run('delete', async (): Promise<WriteResult> => {
          calls.push({ method: 'delete', iri: id, condition });
          if (!store.has(id)) return { kind: 'not-found' };
          if (!matches(id, condition)) return { kind: 'precondition-failed' };
          store.delete(id);
          return { kind: 'applied', status: 204 };
        }),
    },
  };
  return {
    source,
    calls,
    count: (method: Method) => calls.filter((c) => c.method === method).length,
    body: (id = TASK) => store.get(id)?.body,
    /** Another writer, bypassing every editor. */
    write(change: JsonLd, id = TASK) {
      const entry = store.get(id)!;
      store.set(id, {
        body: { ...entry.body, ...change },
        version: ++version,
      });
    },
    once(method: Method, hook: Hook) {
      (hooks[method] ??= []).push(hook);
    },
    setReadable(value: boolean) {
      readable = value;
    },
  };
}

async function opened<E extends Pick<ResourceEditor<unknown>, 'loaded'>>(
  editor: E,
): Promise<E> {
  await editor.loaded;
  return editor;
}
const titleOf = (body: JsonLd | undefined) =>
  (body?.[NAME] as { '@value': string; '@language'?: string }[]) ?? [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('field definitions', () => {
  it('edits one language and preserves other terms and predicates', () => {
    const body = {
      ...initial(),
      [NAME]: [
        { '@value': 'Buy milk', '@language': 'EN' },
        { '@value': 'Milch kaufen', '@language': 'de' },
        { '@value': '42', '@type': 'http://www.w3.org/2001/XMLSchema#int' },
        { '@id': 'https://example.org/label' },
      ],
    };
    const draft = task.read(body);
    expect(draft).toEqual({ title: 'Buy milk', done: false });
    const patch = task.patch(body, { ...draft, title: 'Buy oat milk' });
    expect(patch).toEqual({
      [NAME]: [
        { '@value': 'Buy oat milk', '@language': 'EN' },
        { '@value': 'Milch kaufen', '@language': 'de' },
        { '@value': '42', '@type': 'http://www.w3.org/2001/XMLSchema#int' },
        { '@id': 'https://example.org/label' },
      ],
    });
    expect(task.patch(body, draft)).toEqual({});
  });

  it('treats a blank required text as empty but stores values as typed', () => {
    const required = fields({ title: text(NAME, { language: null }) });
    expect(required.valid!({ title: '   ' })).toBe(false);
    expect(required.valid!({ title: '\t\n' })).toBe(false);
    expect(required.valid!({ title: ' Milk ' })).toBe(true);
    expect(required.patch({ '@id': TASK }, { title: ' Milk ' })).toEqual({
      [NAME]: [{ '@value': ' Milk ' }],
    });
    const allowed = fields({
      title: text(NAME, { language: null, empty: 'allow' }),
    });
    expect(allowed.valid!({ title: '   ' })).toBe(true);
  });

  it('adds a missing translation with the chosen tag and keeps untagged values', () => {
    const de = fields({ title: text(NAME, { language: 'de-CH' }) });
    const body = { '@id': TASK, [NAME]: [{ '@value': 'Untagged' }] };
    expect(de.read(body)).toEqual({ title: '' });
    expect(de.valid!({ title: '' })).toBe(false);
    expect(de.patch(body, { title: 'Milch' })).toEqual({
      [NAME]: [
        { '@value': 'Untagged' },
        { '@value': 'Milch', '@language': 'de-CH' },
      ],
    });
    const untagged = fields({ title: text(NAME, { language: null }) });
    expect(untagged.read(body)).toEqual({ title: 'Untagged' });
  });

  it('reports mapping errors instead of guessing', () => {
    const two = {
      [NAME]: [
        { '@value': 'a', '@language': 'en' },
        { '@value': 'b', '@language': 'en-GB' },
        { '@value': 'c', '@language': 'EN' },
      ],
      [STATUS]: [{ '@id': OPEN }],
    };
    expect(() => task.read(two)).toThrow(MappingError);
    expect(() =>
      task.read({ ...initial(), [STATUS]: [{ '@id': 'urn:x' }] }),
    ).toThrow(MappingError);
    expect(() => task.read({ ...initial(), [STATUS]: [] })).toThrow(
      MappingError,
    );
    const lenient = fields({
      done: flag(STATUS, { on: DONE, off: OPEN, absent: false }),
      list: iri(LIST),
    });
    expect(() => lenient.read({})).toThrow(MappingError);
    expect(lenient.read({ [LIST]: [{ '@id': 'urn:l' }] })).toEqual({
      done: false,
      list: 'urn:l',
    });
  });

  it('R13: optional text distinguishes an absent value (null) from an empty literal', () => {
    const note = fields({
      note: text(NAME, { language: 'en', optional: true, empty: 'allow' }),
    });
    const absent = {
      '@id': TASK,
      [NAME]: [{ '@value': 'Notiz', '@language': 'de' }],
    };
    const draft: { readonly note: string | null } = note.read(absent);
    expect(draft).toEqual({ note: null });
    expect(note.valid!({ note: null })).toBe(true);
    // Writing an empty literal is explicit; other languages stay.
    expect(note.patch(absent, { note: '' })).toEqual({
      [NAME]: [
        { '@value': 'Notiz', '@language': 'de' },
        { '@value': '', '@language': 'en' },
      ],
    });
    // Removing is explicit too, and only this field's term goes.
    const present = {
      '@id': TASK,
      [NAME]: [
        { '@value': 'Note', '@language': 'en' },
        { '@value': 'Notiz', '@language': 'de' },
      ],
    };
    expect(note.patch(present, { note: null })).toEqual({
      [NAME]: [{ '@value': 'Notiz', '@language': 'de' }],
    });
    // The last value removed: the predicate is removed, not set to [].
    expect(
      note.patch(
        { '@id': TASK, [NAME]: [{ '@value': 'x', '@language': 'en' }] },
        { note: null },
      ),
    ).toEqual({ [NAME]: null });
    // Required text keeps its documented behaviour.
    expect(task.valid!({ title: null as unknown as string, done: false })).toBe(
      false,
    );
  });

  it('rejects fields that write the same terms', () => {
    expect(() =>
      fields({
        a: text(NAME, { language: 'en' }),
        b: text(NAME, { language: 'EN' }),
      }),
    ).toThrow(TypeError);
    expect(() =>
      fields({ a: text(NAME, { language: 'en' }), b: iri(NAME) }),
    ).toThrow(TypeError);
    expect(() =>
      fields({
        a: text(NAME, { language: 'en' }),
        b: text(NAME, { language: 'de' }),
      }),
    ).not.toThrow();
    expect(() => text(NAME, { language: 'preferred-language' })).toThrow();
  });
});

describe('resource editor scenarios', () => {
  it('saves conditionally and clears dirty only for the submitted draft', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    expect(editor.state).toMatchObject({
      phase: 'ready',
      draft: { title: 'Buy milk', done: false },
      dirty: false,
      canSave: false,
    });
    editor.change({ title: 'Buy oat milk', done: false });
    expect(editor.state.canSave).toBe(true);
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(pod.calls.find((c) => c.method === 'patch')?.condition).toEqual({
      ifMatch: '"v1"',
    });
    expect(titleOf(pod.body())).toEqual([
      { '@value': 'Buy oat milk', '@language': 'en' },
      { '@value': 'Milch kaufen', '@language': 'de' },
    ]);
    expect(editor.state).toMatchObject({ phase: 'ready', dirty: false });
  });

  it('keeps newer typing during a save and bases the next save on the new version', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const gate = deferred<void>();
    pod.once('patch', async (real) => {
      await gate.promise;
      return real();
    });
    editor.change({ title: 'Buy oat', done: false });
    const saving = editor.save();
    expect(editor.state.phase).toBe('saving');
    editor.change({ title: 'Buy oat milk', done: false });
    expect(await editor.save()).toEqual({
      kind: 'not-saved',
      reason: 'not-ready',
    });
    gate.resolve();
    expect(await saving).toEqual({ kind: 'saved' });
    expect(editor.state).toMatchObject({
      phase: 'ready',
      draft: { title: 'Buy oat milk' },
      dirty: true,
      canSave: true,
    });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(
      pod.calls.filter((c) => c.method === 'patch').at(-1)?.condition,
    ).toEqual({ ifMatch: '"v2"' });
    expect(titleOf(pod.body())[0]?.['@value']).toBe('Buy oat milk');
  });

  it('keeps the draft through read loss and continues after regaining access', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Mine', done: false });
    editor.setAccess({ read: false, write: false });
    expect(editor.state).toMatchObject({
      phase: 'blocked',
      draft: { title: 'Mine' },
      canSave: false,
      canRemove: false,
      problem: { kind: 'refused', status: 403 },
    });
    editor.setAccess({ read: true, write: true });
    await editor.refresh();
    // No base survived the loss, so even an unchanged version needs a decision.
    expect(editor.state.phase).toBe('review');
    expect(editor.state.review).toMatchObject({
      kind: 'changed-on-pod',
      mine: { title: 'Mine' },
      current: { title: 'Buy milk' },
    });
    editor.continueFromCurrent();
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(titleOf(pod.body())[0]?.['@value']).toBe('Mine');
  });

  it('ignores a read that completes after read access was lost', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const gate = deferred<void>();
    pod.once('get', async (real) => {
      await gate.promise;
      return real();
    });
    const refreshing = editor.refresh();
    editor.setAccess({ read: false, write: true });
    gate.resolve();
    await refreshing;
    expect(editor.state).toMatchObject({ phase: 'blocked', canSave: false });
  });

  it('rebases a dirty draft onto a newer version when its own fields are untouched', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Mine', done: false });
    // Unchanged version: refreshing keeps the draft on it.
    await editor.refresh();
    expect(editor.state).toMatchObject({ phase: 'ready', dirty: true });
    // Another device changes something else: the draft moves along.
    pod.write({ [LIST]: [{ '@id': 'urn:list' }], [STATUS]: [{ '@id': DONE }] });
    await editor.refresh();
    expect(editor.state).toMatchObject({
      phase: 'ready',
      draft: { title: 'Mine', done: true },
      review: null,
    });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(
      pod.calls.filter((c) => c.method === 'patch').at(-1)?.condition,
    ).toEqual({ ifMatch: '"v2"' });
    expect(task.read(pod.body()!)).toEqual({ title: 'Mine', done: true });
    expect(pod.body()?.[LIST]).toEqual([{ '@id': 'urn:list' }]);
  });

  it('R8: a change to the same field still needs a decision', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Mine', done: false });
    // A sibling language of the same predicate is not this field's term.
    pod.write({
      [NAME]: [
        { '@value': 'Theirs', '@language': 'en' },
        { '@value': 'Milch kaufen', '@language': 'de' },
      ],
    });
    await editor.refresh();
    expect(editor.state).toMatchObject({
      phase: 'review',
      draft: { title: 'Mine' },
      canSave: false,
      review: { kind: 'changed-on-pod', current: { title: 'Theirs' } },
    });
  });

  it('R8: an escape-hatch patch never runs against an unseen version', async () => {
    const pod = memoryPod();
    // `read` projects the title only; `patch` also depends on the status.
    const titled = {
      read: (body: JsonLd) => ({ title: task.read(body).title }),
      patch: (body: JsonLd, draft: { title: string }) =>
        task.patch(body, { ...task.read(body), title: draft.title }),
    };
    const editor = await opened(createResourceEditor(pod.source, TASK, titled));
    editor.change({ title: 'Mine' });
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    await editor.refresh();
    expect(editor.state.phase).toBe('review');
    expect(await editor.save()).toEqual({
      kind: 'not-saved',
      reason: 'not-ready',
    });
    expect(pod.count('patch')).toBe(0);
  });

  it('R8: bases newer typing after a save only on the exact resulting description', async () => {
    const pod = memoryPod();
    const titled = {
      read: (body: JsonLd) => ({ title: task.read(body).title }),
      patch: (body: JsonLd, draft: { title: string }) =>
        task.patch(body, { ...task.read(body), title: draft.title }),
    };
    const editor = await opened(createResourceEditor(pod.source, TASK, titled));
    const gate = deferred<void>();
    pod.once('get', async (real) => {
      await gate.promise;
      return real();
    });
    editor.change({ title: 'First' });
    const saving = editor.save();
    await vi.waitFor(() => expect(pod.count('patch')).toBe(1));
    editor.change({ title: 'Second' });
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    gate.resolve();
    expect(await saving).toEqual({ kind: 'saved' });
    expect(editor.state).toMatchObject({
      phase: 'review',
      draft: { title: 'Second' },
      canSave: false,
      review: { kind: 'changed-on-pod', current: { title: 'First' } },
    });
    expect(pod.count('patch')).toBe(1);
  });

  it('R11: keeps a private copy of the read body even if the source reuses it', async () => {
    const pod = memoryPod();
    let cached: Record<string, unknown> | undefined;
    const source: ResourceSource = {
      subjects: {
        ...pod.source.subjects,
        async get(id, options) {
          const read = await pod.source.subjects.get(id, options);
          if (read.kind !== 'ok' || !('body' in read)) return read;
          cached ??= read.body as Record<string, unknown>;
          return { ...read, body: cached };
        },
      },
    };
    const editor = await opened(createResourceEditor(source, TASK, task));
    // The source's cache changes an unseen sibling term; the Pod does not.
    (cached![NAME] as { '@value': string }[])[1]!['@value'] = 'Cache only';
    editor.change({ title: 'Buy oat milk', done: false });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(titleOf(pod.body())[1]?.['@value']).toBe('Milch kaufen');
  });

  it('R9: keeps a private copy of every draft passed to change()', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const mine = { title: 'Valid', done: false };
    editor.change(mine);
    mine.title = '';
    expect(editor.state).toMatchObject({
      draft: { title: 'Valid' },
      valid: true,
    });
    expect(Object.isFrozen(editor.state.draft)).toBe(true);
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(titleOf(pod.body())[0]?.['@value']).toBe('Valid');
  });

  it('R1: ignores a comparison read that completes after read loss, and recovers', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.write({ [NAME]: [{ '@value': 'Theirs', '@language': 'en' }] });
    const gate = deferred<void>();
    pod.once('get', async (real) => {
      await gate.promise;
      return real();
    });
    editor.change({ title: 'Mine', done: false });
    const saving = editor.save();
    await vi.waitFor(() => expect(pod.count('patch')).toBe(1));
    editor.setAccess({ read: false, write: false });
    gate.resolve();
    expect(await saving).toEqual({ kind: 'review' });
    expect(editor.state).toMatchObject({
      phase: 'review',
      draft: { title: 'Mine' },
      review: { kind: 'changed-on-pod', current: undefined },
    });
    editor.setAccess({ read: true, write: true });
    await editor.refresh();
    expect(editor.state.review).toMatchObject({ current: { title: 'Theirs' } });
    editor.continueFromCurrent();
    expect(await editor.save()).toEqual({ kind: 'saved' });
  });

  it('R1: keeps an unknown write outcome through read loss while the write is pending', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const gate = deferred<void>();
    pod.once('patch', async (real) => {
      await gate.promise;
      await real();
      return lost;
    });
    editor.change({ title: 'Mine', done: false });
    const saving = editor.save();
    editor.setAccess({ read: false, write: false });
    gate.resolve();
    expect(await saving).toEqual({ kind: 'review' });
    expect(editor.state).toMatchObject({
      phase: 'review',
      review: {
        kind: 'unconfirmed',
        current: undefined,
        desiredObserved: false,
      },
    });
    editor.setAccess({ read: true, write: true });
    await editor.refresh();
    expect(editor.state.review).toMatchObject({
      kind: 'unconfirmed',
      current: { title: 'Mine' },
      desiredObserved: true,
    });
    expect(pod.count('patch')).toBe(1);
  });

  it('turns a 412 into review and requires a fresh decision after a later change', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.write({ [NAME]: [{ '@value': 'Theirs 1', '@language': 'en' }] });
    editor.change({ title: 'Mine', done: false });
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(editor.state).toMatchObject({
      phase: 'review',
      draft: { title: 'Mine' },
      canSave: false,
      review: {
        kind: 'changed-on-pod',
        intent: 'save',
        mine: { title: 'Mine' },
        current: { title: 'Theirs 1' },
      },
    });
    // Changed again after the comparison: continuing from it still conflicts.
    pod.write({ [NAME]: [{ '@value': 'Theirs 2', '@language': 'en' }] });
    editor.continueFromCurrent();
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(editor.state.review?.current).toMatchObject({ title: 'Theirs 2' });
    editor.continueFromCurrent();
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(titleOf(pod.body())).toEqual([
      { '@value': 'Mine', '@language': 'en' },
    ]);
  });

  it('discards to the compared version in review', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.write({ [NAME]: [{ '@value': 'Theirs', '@language': 'en' }] });
    editor.change({ title: 'Mine', done: false });
    expect(await editor.save()).toEqual({ kind: 'review' });
    editor.discard();
    expect(editor.state).toMatchObject({
      phase: 'ready',
      draft: { title: 'Theirs', done: false },
      dirty: false,
      review: null,
    });
  });

  it('never resends after a lost answer, even when another writer restored the base', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.once('patch', async (real) => {
      await real();
      pod.write({ [NAME]: initial()[NAME] as JsonLd[] });
      return lost;
    });
    editor.change({ title: 'Mine', done: false });
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(editor.state.review).toEqual({
      kind: 'unconfirmed',
      intent: 'save',
      mine: { title: 'Mine', done: false },
      current: { title: 'Buy milk', done: false },
      desiredObserved: false,
    });
    await editor.refresh();
    expect(editor.state.review).toMatchObject({ desiredObserved: false });
    expect(pod.count('patch')).toBe(1);
    // An explicit decision is required for another write.
    editor.continueFromCurrent();
    expect(editor.state).toMatchObject({ dirty: true, canSave: true });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(pod.count('patch')).toBe(2);
  });

  it('reports desiredObserved without treating it as proof', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.once('patch', async (real) => {
      await real();
      return lost;
    });
    editor.change({ title: 'Mine', done: false });
    await editor.save();
    expect(editor.state).toMatchObject({
      phase: 'review',
      review: { kind: 'unconfirmed', desiredObserved: true },
    });
    editor.continueFromCurrent();
    expect(editor.state).toMatchObject({ phase: 'ready', dirty: false });
  });

  it('deletes only the version that was read', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    expect(await editor.remove()).toEqual({ kind: 'review' });
    expect(editor.state.review).toMatchObject({
      kind: 'changed-on-pod',
      intent: 'remove',
      mine: null,
      current: { done: true },
    });
    expect(pod.body()).toBeDefined();
    editor.continueFromCurrent();
    expect(await editor.remove()).toEqual({ kind: 'removed' });
    expect(editor.state.phase).toBe('deleted');
    expect(pod.body()).toBeUndefined();
  });

  it('reviews a lost delete answer by observing absence', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    pod.once('delete', async (real) => {
      await real();
      return lost;
    });
    expect(await editor.remove()).toEqual({ kind: 'review' });
    expect(editor.state.review).toMatchObject({
      kind: 'unconfirmed',
      current: null,
      desiredObserved: true,
    });
    editor.continueFromCurrent();
    expect(editor.state.phase).toBe('deleted');
    expect(pod.count('delete')).toBe(1);
  });

  it('keeps two independent editors safe: different fields both survive, the same field reviews', async () => {
    const pod = memoryPod();
    const a = await opened(createResourceEditor(pod.source, TASK, task));
    const b = await opened(createResourceEditor(pod.source, TASK, task));
    a.change({ title: 'Buy oat milk', done: false });
    b.change({ title: 'Buy milk', done: true });
    expect(await a.save()).toEqual({ kind: 'saved' });
    // B changed only `done`: rebased once onto A's version, both changes kept.
    expect(await b.save()).toEqual({ kind: 'saved', alongside: true });
    expect(task.read(pod.body()!)).toEqual({
      title: 'Buy oat milk',
      done: true,
    });
    expect(b.state).toMatchObject({
      phase: 'ready',
      dirty: false,
      draft: { title: 'Buy oat milk', done: true },
    });
    expect(pod.count('patch')).toBe(3);
    // Both change the title: a real conflict is never merged.
    const c = await opened(createResourceEditor(pod.source, TASK, task));
    b.change({ title: 'From B', done: true });
    c.change({ title: 'From C', done: true });
    expect(await c.save()).toEqual({ kind: 'saved' });
    expect(await b.save()).toEqual({ kind: 'review' });
    expect(b.state.review).toMatchObject({
      kind: 'changed-on-pod',
      current: { title: 'From C' },
    });
    expect(task.read(pod.body()!).title).toBe('From C');
  });

  it('rebases at most once and never after an unknown outcome', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Buy milk', done: true });
    // Two concurrent unrelated changes: the rebased retry also meets a 412.
    pod.write({ [LIST]: [{ '@id': 'urn:one' }] });
    pod.once('patch', (real) => {
      pod.write({ [LIST]: [{ '@id': 'urn:two' }] });
      return real();
    });
    pod.once('patch', (real) => {
      pod.write({ [LIST]: [{ '@id': 'urn:three' }] });
      return real();
    });
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(pod.count('patch')).toBe(2);
    // A lost answer is reviewed, not rebased.
    const lostPod = memoryPod();
    const other = await opened(
      createResourceEditor(lostPod.source, TASK, task),
    );
    other.change({ title: 'Buy milk', done: true });
    lostPod.once('patch', async (real) => {
      await real();
      return lost;
    });
    expect(await other.save()).toEqual({ kind: 'review' });
    expect(other.state.review?.kind).toBe('unconfirmed');
    expect(lostPod.count('patch')).toBe(1);
  });

  it('R4: after a rebase, no recovery path writes the untouched field back', async () => {
    const variants = {
      // The rebased PATCH applies, but its answer is lost.
      'applied-lost': async (real: () => Promise<unknown>) => {
        await real();
        return lost;
      },
      // The rebased PATCH is not applied and its outcome is unknown.
      'not-applied-lost': async () => lost,
      // Yet another writer gets in between: a second 412.
      'second-412': async (real: () => Promise<unknown>) => {
        pod.write({ [LIST]: [{ '@id': 'urn:again' }] });
        return real();
      },
    };
    let pod = memoryPod();
    for (const [name, retry] of Object.entries(variants)) {
      pod = memoryPod();
      const editor = await opened(createResourceEditor(pod.source, TASK, task));
      editor.change({ title: 'Mine', done: false });
      pod.write({ [STATUS]: [{ '@id': DONE }] });
      pod.once('patch', (real) => real()); // the first PATCH meets the 412
      pod.once('patch', retry);
      expect(await editor.save(), name).toEqual({ kind: 'review' });
      // The other writer's value is already in the live draft.
      expect(editor.state.draft, name).toEqual({ title: 'Mine', done: true });
      editor.continueFromCurrent();
      if (editor.state.canSave) await editor.save();
      expect(task.read(pod.body()!).done, name).toBe(true);
    }
  });

  it('R4: continueFromCurrent takes the compared values for untouched fields', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Mine', done: false });
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    pod.once('patch', (real) => real());
    // Before the rebased PATCH, the other writer flips the untouched field again.
    pod.once('patch', (real) => {
      pod.write({ [STATUS]: [{ '@id': OPEN }] });
      return real();
    });
    expect(await editor.save()).toEqual({ kind: 'review' });
    editor.continueFromCurrent();
    expect(editor.state.draft).toEqual({ title: 'Mine', done: false });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(task.read(pod.body()!)).toEqual({ title: 'Mine', done: false });
    expect(pod.count('patch')).toBe(3);
  });

  it('R3: a subscriber reacting to the rebase can still stop the retry', async () => {
    const actions = {
      'write-loss': (e: ResourceEditor<unknown>) =>
        e.setAccess({ read: true, write: false }),
      'read-loss': (e: ResourceEditor<unknown>) =>
        e.setAccess({ read: false, write: false }),
      dispose: (e: ResourceEditor<unknown>) => e.dispose(),
    };
    for (const [name, act] of Object.entries(actions)) {
      const pod = memoryPod();
      const editor = await opened(createResourceEditor(pod.source, TASK, task));
      editor.change({ title: 'Mine', done: false });
      pod.write({ [STATUS]: [{ '@id': DONE }] });
      let acted = false;
      editor.subscribe(() => {
        // The rebase publishes the reconciled draft while still saving.
        if (!acted && editor.state.draft?.done === true) {
          acted = true;
          act(editor as ResourceEditor<unknown>);
        }
      });
      expect(await editor.save(), name).toEqual({ kind: 'review' });
      expect(acted, name).toBe(true);
      expect(pod.count('patch'), name).toBe(1);
      expect(task.read(pod.body()!), name).toEqual({
        title: 'Buy milk',
        done: true,
      });
    }
  });

  it('R5: keeps input made after the rebase, even when it equals the original submission', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Mine', done: false });
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    const gate = deferred<void>();
    pod.once('patch', (real) => real());
    pod.once('patch', async (real) => {
      await gate.promise;
      return real();
    });
    const saving = editor.save();
    await vi.waitFor(() =>
      expect(editor.state.draft).toEqual({ title: 'Mine', done: true }),
    );
    // The person deliberately sets done back to false during the retry.
    editor.change({ title: 'Mine', done: false });
    gate.resolve();
    expect(await saving).toEqual({ kind: 'saved', alongside: true });
    expect(editor.state).toMatchObject({
      phase: 'ready',
      dirty: true,
      draft: { title: 'Mine', done: false },
    });
    expect(task.read(pod.body()!)).toEqual({ title: 'Mine', done: true });
  });

  it('R4: keeps newer typing while the rebase reconciles untouched fields', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    editor.change({ title: 'Mine', done: false });
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    const gate = deferred<void>();
    pod.once('patch', (real) => real());
    pod.once('patch', async () => {
      await gate.promise;
      return lost;
    });
    const saving = editor.save();
    await vi.waitFor(() => expect(pod.count('patch')).toBe(1));
    await vi.waitFor(() =>
      expect(editor.state.draft).toEqual({ title: 'Mine', done: true }),
    );
    editor.change({ title: 'Mine, newer', done: true });
    gate.resolve();
    expect(await saving).toEqual({ kind: 'review' });
    expect(editor.state.draft).toEqual({ title: 'Mine, newer', done: true });
  });

  it('R2: only definitions created by fields() rebase; look-alikes stay conservative', async () => {
    for (const lookAlike of [
      { read: task.read, patch: task.patch, fields: {} },
      { ...task },
      { ...task, patch: task.patch },
    ]) {
      const pod = memoryPod();
      const editor = await opened(
        createResourceEditor(pod.source, TASK, lookAlike),
      );
      editor.change({ title: 'Mine', done: false });
      pod.write({ [STATUS]: [{ '@id': DONE }] });
      expect(await editor.save()).toEqual({ kind: 'review' });
      expect(editor.state.draft).toEqual({ title: 'Mine', done: false });
      expect(pod.count('patch')).toBe(1);
      // A refresh never replaces the draft silently either.
      const other = await opened(
        createResourceEditor(pod.source, TASK, lookAlike),
      );
      other.change({ title: 'Also mine', done: true });
      pod.write({ [LIST]: [{ '@id': 'urn:list' }] });
      await other.refresh();
      expect(other.state).toMatchObject({
        phase: 'review',
        draft: { title: 'Also mine' },
      });
    }
    const pod = memoryPod();
    expect(() =>
      snapshots(pod.source, [initial()], { ...task } as typeof task),
    ).toThrow(TypeError);
  });

  it('R3: never sends the rebased request after write access was lost', async () => {
    for (const lossDuring of ['first-patch', 'reconciliation-read'] as const) {
      const pod = memoryPod();
      const editor = await opened(createResourceEditor(pod.source, TASK, task));
      editor.change({ title: 'Mine', done: false });
      pod.write({ [STATUS]: [{ '@id': DONE }] });
      if (lossDuring === 'first-patch')
        pod.once('patch', async (real) => {
          editor.setAccess({ read: true, write: false });
          return real();
        });
      else
        pod.once('get', async (real) => {
          editor.setAccess({ read: true, write: false });
          return real();
        });
      expect(await editor.save()).toEqual({ kind: 'review' });
      expect(pod.count('patch')).toBe(1);
      expect(editor.state.draft).toEqual({ title: 'Mine', done: false });
    }
  });

  it('keeps the escape hatch conservative: no rebase without declared fields', async () => {
    const pod = memoryPod();
    const plain = { read: task.read, patch: task.patch };
    const editor = await opened(createResourceEditor(pod.source, TASK, plain));
    pod.write({ [LIST]: [{ '@id': 'urn:list' }] });
    editor.change({ title: 'Mine', done: false });
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(pod.count('patch')).toBe(1);
  });

  it('settles `loaded` with the first read, whatever its outcome', async () => {
    const pod = memoryPod();
    const ready = createResourceEditor(pod.source, TASK, task);
    expect(ready.state.phase).toBe('loading');
    expect(await ready.loaded).toMatchObject({ phase: 'ready' });
    const missing = createResourceEditor(pod.source, TASK + '-x', task);
    expect(await missing.loaded).toMatchObject({
      phase: 'blocked',
      problem: { kind: 'not-found' },
    });
  });

  it('blocks on unmappable or missing resources and keeps refusals as problems', async () => {
    const pod = memoryPod({ [TASK]: { ...initial(), [STATUS]: [] } });
    const broken = await opened(createResourceEditor(pod.source, TASK, task));
    expect(broken.state).toMatchObject({
      phase: 'blocked',
      draft: null,
      problem: { kind: 'not-mappable', predicate: STATUS },
    });
    const missing = await opened(
      createResourceEditor(pod.source, TASK + '-x', task),
    );
    expect(missing.state).toMatchObject({
      phase: 'blocked',
      problem: { kind: 'not-found' },
    });
    const ok = memoryPod();
    const editor = await opened(createResourceEditor(ok.source, TASK, task));
    ok.once('patch', async () => ({ kind: 'refused', status: 403 }));
    editor.change({ title: 'Mine', done: false });
    expect(await editor.save()).toEqual({
      kind: 'not-saved',
      reason: 'refused',
    });
    expect(editor.state).toMatchObject({
      phase: 'ready',
      draft: { title: 'Mine' },
      problem: { kind: 'refused', status: 403 },
    });
  });

  it('ignores late results after dispose', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const listener = vi.fn();
    editor.subscribe(listener);
    const gate = deferred<void>();
    pod.once('patch', async (real) => {
      await gate.promise;
      return real();
    });
    editor.change({ title: 'Mine', done: false });
    listener.mockClear();
    const saving = editor.save();
    editor.dispose();
    gate.resolve();
    expect(await saving).toEqual({ kind: 'saved' });
    expect(listener).toHaveBeenCalledTimes(1); // only the saving transition
  });
});

describe('snapshots and one-click updates', () => {
  it('updates one field from a list while keeping a concurrent change to another', async () => {
    const pod = memoryPod();
    const list = snapshots(
      pod.source,
      [structuredClone(initial()), { '@id': 'urn:other' }, { nope: 1 }],
      task,
    );
    expect(list.items.map((s) => s.data)).toEqual([
      { title: 'Buy milk', done: false },
    ]);
    expect(list.skipped).toBe(2);
    pod.write({
      [NAME]: [
        { '@value': 'Buy oat milk', '@language': 'en' },
        { '@value': 'Hafermilch', '@language': 'de' },
      ],
    });
    expect(
      await updateFields(pod.source, list.items[0]!, task, { done: true }),
    ).toEqual({ kind: 'saved' });
    expect(task.read(pod.body()!)).toEqual({
      title: 'Buy oat milk',
      done: true,
    });
    expect(titleOf(pod.body())[1]?.['@value']).toBe('Hafermilch');
  });

  it('rebases a one-click update once when another field changed in between', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    // Another device renames the task between this update's read and patch.
    pod.once('patch', (real) => {
      pod.write({ [NAME]: [{ '@value': 'Renamed', '@language': 'en' }] });
      return real();
    });
    expect(await updateFields(pod.source, seen!, task, { done: true })).toEqual(
      { kind: 'saved' },
    );
    expect(task.read(pod.body()!)).toEqual({ title: 'Renamed', done: true });
    expect(pod.count('patch')).toBe(2);
    // The same field changed in between: no rebase, a decision instead.
    const [again] = snapshots(pod.source, [pod.body()!], task).items;
    pod.once('patch', (real) => {
      pod.write({ [STATUS]: [{ '@id': OPEN }] });
      return real();
    });
    expect(
      await updateFields(pod.source, again!, task, { done: false }),
    ).toMatchObject({ kind: 'changed-on-pod' });
    expect(pod.count('patch')).toBe(3);
  });

  it('refuses a one-click update when the seen value changed', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    const outcome = await updateFields(pod.source, seen!, task, { done: true });
    expect(outcome).toMatchObject({
      kind: 'changed-on-pod',
      current: { iri: TASK, data: { done: true } },
    });
    expect(pod.count('patch')).toBe(0);
  });

  it('never resends a lost one-click update', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    pod.once('patch', async (real) => {
      await real();
      return lost;
    });
    expect(
      await updateFields(pod.source, seen!, task, { done: true }),
    ).toMatchObject({ kind: 'unconfirmed', desiredObserved: true });
    expect(pod.count('patch')).toBe(1);
  });

  it('rejects snapshots from another source or definition', async () => {
    const pod = memoryPod();
    const other = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    await expect(
      updateFields(other.source, seen!, task, { done: true }),
    ).rejects.toThrow(TypeError);
    const copy = fields({ ...task.fields });
    await expect(
      updateFields(pod.source, seen!, copy, { done: true }),
    ).rejects.toThrow(TypeError);
    await expect(
      updateFields(pod.source, { iri: TASK, data: seen!.data }, task, {
        done: true,
      }),
    ).rejects.toThrow(TypeError);
  });

  it('removes the seen version from a list, or reports the change', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    pod.write({ [STATUS]: [{ '@id': DONE }] });
    const changed = await removeSnapshot(pod.source, seen!, task);
    expect(changed).toMatchObject({ kind: 'changed-on-pod' });
    expect(pod.body()).toBeDefined();
    if (changed.kind !== 'changed-on-pod' || !changed.current)
      throw new Error('expected a current snapshot');
    expect(await removeSnapshot(pod.source, changed.current, task)).toEqual({
      kind: 'removed',
    });
    expect(pod.body()).toBeUndefined();
  });
});

describe('snapshot regressions', () => {
  it('R2: reports an unreadable comparison as unknown, not as absence', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    pod.once('patch', async () => ({ kind: 'precondition-failed' }));
    pod.once('get', (real) => real());
    pod.once('get', async () => ({ kind: 'refused', status: 403 }));
    expect(await updateFields(pod.source, seen!, task, { done: true })).toEqual(
      { kind: 'changed-on-pod', current: undefined },
    );
    expect(pod.body()).toBeDefined();
  });

  it('R5: keeps the seen evidence when the query data is mutated later', async () => {
    const pod = memoryPod();
    const node = structuredClone(initial());
    const [seen] = snapshots(pod.source, [node], task).items;
    pod.write({ [NAME]: [{ '@value': 'Someone else', '@language': 'en' }] });
    // A query cache updates the original node in place.
    (node[NAME] as { '@value': string }[])[0]!['@value'] = 'Someone else';
    expect(seen!.data.title).toBe('Buy milk');
    expect(Object.isFrozen(seen!.data)).toBe(true);
    expect(
      await updateFields(pod.source, seen!, task, { title: 'Mine' }),
    ).toMatchObject({ kind: 'changed-on-pod' });
    expect(pod.count('patch')).toBe(0);
  });

  it('R6: captures the field command before the read', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    pod.write({ [NAME]: [{ '@value': 'Theirs', '@language': 'en' }] });
    const gate = deferred<void>();
    pod.once('get', async (real) => {
      await gate.promise;
      return real();
    });
    const change: { done?: boolean; title?: string } = { done: true };
    const updating = updateFields(pod.source, seen!, task, change);
    change.title = 'Mine';
    gate.resolve();
    expect(await updating).toEqual({ kind: 'saved' });
    expect(task.read(pod.body()!)).toEqual({ title: 'Theirs', done: true });
  });

  it('R10: keeps reconciliation reads cancellable after a dispatched write', async () => {
    for (const answer of [lost, { kind: 'precondition-failed' } as const]) {
      const pod = memoryPod();
      const signals: (AbortSignal | undefined)[] = [];
      const source: ResourceSource = {
        subjects: {
          ...pod.source.subjects,
          get(id, options) {
            signals.push(options?.signal);
            return options?.signal?.aborted
              ? Promise.resolve({ kind: 'cancelled' } as const)
              : pod.source.subjects.get(id, options);
          },
        },
      };
      const [seen] = snapshots(source, [initial()], task).items;
      const controller = new AbortController();
      pod.once('patch', async (real) => {
        await real();
        controller.abort();
        return answer;
      });
      const outcome = await updateFields(
        source,
        seen!,
        task,
        { done: true },
        { signal: controller.signal },
      );
      expect(outcome).toMatchObject({ current: undefined });
      expect(signals).toEqual([controller.signal, controller.signal]);
    }
  });

  it('R1: never retries a list deletion against a version the person did not see', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    // The version advances with an identical body right before the DELETE.
    pod.once('delete', (real) => {
      pod.write({});
      return real();
    });
    const outcome = await removeSnapshot(pod.source, seen!, task);
    expect(outcome).toMatchObject({
      kind: 'changed-on-pod',
      current: { iri: TASK },
    });
    expect(pod.count('delete')).toBe(1);
    expect(pod.body()).toBeDefined();
  });

  it('R7: deletes from a list only when the whole seen description still holds', async () => {
    const pod = memoryPod();
    const [seen] = snapshots(pod.source, [initial()], task).items;
    // An unmapped translation changed: not the version the person saw.
    pod.write({
      [NAME]: [
        { '@value': 'Buy milk', '@language': 'en' },
        { '@value': 'Hafermilch kaufen', '@language': 'de' },
      ],
    });
    expect(await removeSnapshot(pod.source, seen!, task)).toMatchObject({
      kind: 'changed-on-pod',
      current: { data: { title: 'Buy milk' } },
    });
    expect(pod.count('delete')).toBe(0);
    // A projection is display data, not evidence of the whole version.
    const { [STATUS]: _status, ...withoutStatus } = initial();
    void _status;
    const projected = fields({ title: text(NAME, { language: 'en' }) });
    const [partial] = snapshots(pod.source, [withoutStatus], projected).items;
    expect(await removeSnapshot(pod.source, partial!, projected)).toMatchObject(
      { kind: 'changed-on-pod' },
    );
    expect(pod.body()).toBeDefined();
  });
});

describe('creation', () => {
  const NEW = 'https://pod.example/alice/tasks/2';
  const body = {
    '@type': ['https://example.org/Task'],
    [NAME]: [{ '@value': 'New', '@language': 'en' }],
    [STATUS]: [{ '@id': OPEN }],
  };

  it('creates once; after a lost answer a found resource stays unconfirmed (R4)', async () => {
    const pod = memoryPod({});
    const creation = prepareCreation(pod.source, NEW, body);
    pod.once('put', async (real) => {
      await real();
      return lost;
    });
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    expect(await creation.run()).toEqual({
      kind: 'unconfirmed',
      desiredObserved: true,
    });
    expect(pod.calls.filter((c) => c.method === 'put')).toEqual([
      { method: 'put', iri: NEW, condition: { ifNoneMatch: '*' } },
      { method: 'put', iri: NEW, condition: { ifNoneMatch: '*' } },
    ]);
    expect(pod.body(NEW)).toMatchObject({ '@id': NEW });
  });

  it('R4: keeps a lost creation unconfirmed when a retry fails or is refused', async () => {
    const pod = memoryPod({});
    const creation = prepareCreation(pod.source, NEW, body);
    pod.once('put', async (real) => {
      await real();
      return lost;
    });
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    pod.once('put', async () => ({ kind: 'refused', status: 403 }));
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    pod.once('put', async () => ({ kind: 'not-sent', reason: 'cancelled' }));
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    pod.once('put', async () => {
      throw new Error('authentication');
    });
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    // Without an earlier lost answer, a refusal is a plain refusal.
    const fresh = memoryPod({});
    fresh.once('put', async () => ({ kind: 'refused', status: 403 }));
    expect(await prepareCreation(fresh.source, NEW, body).run()).toEqual({
      kind: 'not-created',
      reason: 'refused',
    });
  });

  it('R12: keeps a confirmed creation confirmed on later runs', async () => {
    const pod = memoryPod({});
    const creation = prepareCreation(pod.source, NEW, body);
    pod.once('put', async () => lost);
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    expect(await creation.run()).toEqual({ kind: 'created' });
    expect(await creation.run()).toEqual({ kind: 'created' });
    // The intercepted first attempt never reached the store; the third run sends nothing.
    expect(pod.count('put')).toBe(1);
  });

  it('R13: writing an empty text where no value exists is a documented no-op', async () => {
    const pod = memoryPod({
      [TASK]: {
        ...initial(),
        [NAME]: [{ '@value': 'Milch', '@language': 'de' }],
      },
    });
    const optional = fields({
      title: text(NAME, { language: 'en', empty: 'allow' }),
    });
    const [seen] = snapshots(pod.source, [pod.body()!], optional).items;
    expect(seen!.data).toEqual({ title: '' });
    expect(
      await updateFields(pod.source, seen!, optional, { title: '' }),
    ).toEqual({ kind: 'saved' });
    expect(pod.count('patch')).toBe(0);
  });

  it('R4: an equal resource that existed before the first run is not created by it', async () => {
    const pod = memoryPod({ [NEW]: { ...body, '@id': NEW } });
    expect(await prepareCreation(pod.source, NEW, body).run()).toEqual({
      kind: 'exists',
    });
  });

  it('R3: runs the captured body even when the caller mutates its own', async () => {
    const pod = memoryPod({});
    const mine = structuredClone(body);
    const creation = prepareCreation(pod.source, NEW, mine);
    (mine[NAME] as { '@value': string }[])[0]!['@value'] = 'Mutated';
    expect(await creation.run()).toEqual({ kind: 'created' });
    expect(titleOf(pod.body(NEW))[0]?.['@value']).toBe('New');
  });

  it('reports an existing different resource without writing', async () => {
    const pod = memoryPod({
      [NEW]: { '@id': NEW, [NAME]: [{ '@value': 'x' }] },
    });
    expect(await prepareCreation(pod.source, NEW, body).run()).toEqual({
      kind: 'exists',
    });
    expect(pod.body(NEW)).toEqual({ '@id': NEW, [NAME]: [{ '@value': 'x' }] });
    expect(() =>
      prepareCreation(pod.source, NEW, { ...body, '@id': 'urn:other' }),
    ).toThrow(TypeError);
  });
});

describe('client view as a source', () => {
  it('drives the editor through createPod with conditional merge-patch requests', async () => {
    const requests: { method: string; headers: Headers; body?: string }[] = [];
    let stored = initial();
    const fetch = async (url: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      requests.push({
        method: init.method ?? 'GET',
        headers,
        ...(typeof init.body === 'string' ? { body: init.body } : {}),
      });
      if ((init.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify(stored), {
          headers: { 'content-type': 'application/ld+json', etag: '"a"' },
        });
      stored = { ...stored, ...(JSON.parse(String(init.body)) as JsonLd) };
      return new Response(null, { status: 204 });
    };
    const view = createPod('https://pod.example/alice', {
      auth: { credential: async () => null, renew: async () => false },
      fetch,
    }).context('https://pod.example/alice/_system/contexts/tasks');
    const editor = await opened(createResourceEditor(view, TASK, task));
    editor.change({ title: 'Wire', done: true });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    const patch = requests.find((r) => r.method === 'PATCH')!;
    expect(patch.headers.get('if-match')).toBe('"a"');
    expect(patch.headers.get('content-type')).toBe(
      'application/merge-patch+json',
    );
    expect(Object.keys(JSON.parse(patch.body!) as JsonLd).sort()).toEqual(
      [NAME, STATUS].sort(),
    );
    const draft: Task | null = editor.state.draft;
    expect(draft).toEqual({ title: 'Wire', done: true });
  });
});

describe('refresh requested while the editor is busy', () => {
  it('recovers when read access returns while a read is still in flight', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const held = deferred<void>();
    pod.once('get', async (real) => {
      await held.promise;
      return real();
    });
    void editor.refresh();
    // Access is lost and regained while that read is still pending.
    editor.setAccess({ read: false, write: false });
    expect(editor.state.problem).toEqual({ kind: 'refused', status: 403 });
    editor.setAccess({ read: true, write: true });
    const deferredRefresh = editor.refresh();
    held.resolve();
    // The returned promise settles only after the deferred read.
    await deferredRefresh;
    expect(editor.state.phase).toBe('ready');
    expect(editor.state.problem).toBeNull();
    expect(editor.state.canSave).toBe(false);
    expect(pod.count('get')).toBe(3);
  });

  it('runs one refresh after a save when it was requested during the write', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const save = async (title: string, request: boolean) => {
      editor.change({ ...editor.state.draft!, title });
      const held = deferred<void>();
      pod.once('patch', async (real) => {
        await held.promise;
        return real();
      });
      const before = pod.count('get');
      const saving = editor.save();
      expect(editor.state.phase).toBe('saving');
      // Several requests during the write coalesce into one refresh afterwards,
      // and both promises settle only after that read.
      const requested = request ? [editor.refresh(), editor.refresh()] : [];
      expect(requested[0]).toBe(requested[1]);
      expect(pod.count('get')).toBe(before);
      held.resolve();
      expect(await saving).toMatchObject({ kind: 'saved' });
      await Promise.all(requested);
      expect(editor.state.phase).toBe('ready');
      return pod.count('get') - before;
    };
    const plain = await save('Buy oat milk', false);
    expect(await save('Buy soy milk', true)).toBe(plain + 1);
    expect(editor.state.dirty).toBe(false);
  });

  it('drops a deferred refresh when read access is gone by then', async () => {
    const pod = memoryPod();
    const editor = await opened(createResourceEditor(pod.source, TASK, task));
    const held = deferred<void>();
    pod.once('get', async (real) => {
      await held.promise;
      return real();
    });
    void editor.refresh();
    void editor.refresh();
    editor.setAccess({ read: false, write: false });
    held.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(pod.count('get')).toBe(2);
    expect(editor.state.phase).toBe('blocked');
  });
});
it('adopts the current version silently after read access returns to an unchanged draft', async () => {
  const pod = memoryPod();
  const editor = await opened(createResourceEditor(pod.source, TASK, task));
  editor.setAccess({ read: false, write: false });
  editor.setAccess({ read: true, write: true });
  await editor.refresh();
  expect(editor.state).toMatchObject({
    phase: 'ready',
    dirty: false,
    review: null,
    canRemove: true,
  });
  // A changed draft is still never overwritten: a newer version opens a review.
  editor.change({ ...editor.state.draft!, title: 'Mine' });
  editor.setAccess({ read: false, write: false });
  pod.write({ [NAME]: [{ '@value': 'Theirs', '@language': 'en' }] });
  editor.setAccess({ read: true, write: true });
  await editor.refresh();
  expect(editor.state.phase).toBe('review');
  expect(editor.state.draft?.title).toBe('Mine');
});
