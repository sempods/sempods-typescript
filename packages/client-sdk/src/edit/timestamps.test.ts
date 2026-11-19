/**
 * Opt-in creation and modification instants (#367): captured once per write
 * command by the standard writes, outside the draft, so they never cause a
 * conflict of their own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonLd, WriteResult } from '../index.js';
import {
  createResourceEditor,
  fields,
  flag,
  prepareCreation,
  snapshots,
  text,
  timestampsOf,
  updateFields,
  type EditDefinition,
  type ResourceSource,
} from './index.js';

const S = 'https://schema.org/';
const ITEM = `${S}Product`;
const NAME = `${S}name`;
const STATUS = 'https://example.org/bought';
const YES = 'https://example.org/Yes';
const NO = 'https://example.org/No';
const CREATED = `${S}dateCreated`;
const MODIFIED = `${S}dateModified`;
const LEGACY = 'http://purl.org/dc/terms/created';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DT = `${XSD}dateTime`;
const ID = 'https://pod.example/alice/items/1';

const item = fields(
  {
    name: text(NAME, { language: null, trim: true }),
    bought: flag(STATUS, { on: YES, off: NO }),
  },
  {
    type: ITEM,
    timestamps: { created: [CREATED, LEGACY], modified: MODIFIED },
  },
);

const T0 = '2026-11-01T08:00:00+01:00';
const T1 = '2026-11-17T09:00:00.000Z';
const T2 = '2026-11-17T09:05:00.000Z';
const instant = (value: string) => [{ '@value': value, '@type': DT }];
const stored = (extra: JsonLd = {}): JsonLd => ({
  '@id': ID,
  '@type': [ITEM],
  [NAME]: [{ '@value': 'Milk' }],
  [STATUS]: [{ '@id': NO }],
  [CREATED]: instant(T0),
  [MODIFIED]: instant(T0),
  ...extra,
});
const lost: WriteResult = {
  kind: 'uncertain',
  failure: { code: 'transport', problem: 'network' },
};

type Method = 'get' | 'put' | 'patch';
type Hook = (real: () => Promise<WriteResult>) => Promise<WriteResult>;

/** One context in memory: strong versions, RFC 7396 patch, 412. */
function memoryPod(resources: Record<string, JsonLd> = { [ID]: stored() }) {
  const store = new Map<string, { body: JsonLd; version: number }>();
  let version = 0;
  for (const [id, body] of Object.entries(resources))
    store.set(id, { body, version: ++version });
  const sent: { method: Method; body: JsonLd }[] = [];
  const hooks: Hook[] = [];
  const etag = (id: string) => `"v${store.get(id)!.version}"`;
  const write = (real: () => Promise<WriteResult>) =>
    hooks.length > 0 ? hooks.shift()!(real) : real();
  const source: ResourceSource = {
    subjects: {
      get: async (id) => {
        const entry = store.get(id);
        if (!entry) return { kind: 'not-found' } as const;
        return {
          kind: 'ok',
          body: structuredClone(entry.body),
          etag: etag(id),
        } as const;
      },
      put: (id, body) =>
        write(async () => {
          sent.push({ method: 'put', body: structuredClone(body) });
          if (store.has(id)) return { kind: 'precondition-failed' };
          store.set(id, { body: structuredClone(body), version: ++version });
          return { kind: 'applied', status: 201 };
        }),
      patch: (id, change, condition) =>
        write(async () => {
          sent.push({ method: 'patch', body: structuredClone(change) });
          if (!store.has(id)) return { kind: 'not-found' };
          if ((condition as { ifMatch?: string }).ifMatch !== etag(id))
            return { kind: 'precondition-failed' };
          const body: Record<string, unknown> = { ...store.get(id)!.body };
          for (const [key, value] of Object.entries(change))
            if (value === null) delete body[key];
            else body[key] = structuredClone(value);
          store.set(id, { body, version: ++version });
          return { kind: 'applied', status: 204 };
        }),
      delete: async () => ({ kind: 'not-found' }),
    },
  };
  return {
    source,
    sent,
    body: (id = ID) => store.get(id)?.body,
    /** Another writer, bypassing every editor. */
    other(change: JsonLd, id = ID) {
      const entry = store.get(id)!;
      store.set(id, { body: { ...entry.body, ...change }, version: ++version });
    },
    /** Runs `hook` around the next write instead of the plain write. */
    once(hook: Hook) {
      hooks.push(hook);
    },
  };
}

const listed = (pod: ReturnType<typeof memoryPod>, nodes = [pod.body()!]) =>
  snapshots(pod.source, nodes, item);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T1));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('declaring timestamps', () => {
  it('normalizes the predicates and rejects overlaps with fields or each other', () => {
    expect(item.timestamps).toEqual({
      created: [CREATED, LEGACY],
      modified: [MODIFIED],
    });
    expect(Object.isFrozen(item.timestamps)).toBe(true);
    expect(fields({ name: text(NAME, { language: null }) }).timestamps).toBe(
      undefined,
    );
    expect(
      fields({ name: text(NAME, { language: null }) }, { timestamps: {} })
        .timestamps,
    ).toBe(undefined);
    expect(() =>
      fields(
        { name: text(NAME, { language: null }) },
        { timestamps: { modified: NAME } },
      ),
    ).toThrow(TypeError);
    expect(() =>
      fields(
        { name: text(NAME, { language: null }) },
        { timestamps: { created: [CREATED, MODIFIED], modified: MODIFIED } },
      ),
    ).toThrow(TypeError);
    expect(() =>
      fields(
        { name: text(NAME, { language: null }) },
        { timestamps: { created: 'not an iri' } },
      ),
    ).toThrow(TypeError);
  });

  it('keeps the instants out of the draft and its validity', () => {
    const [row] = listed(memoryPod()).items;
    expect(row!.data).toEqual({ name: 'Milk', bought: false });
  });
});

describe('creation', () => {
  const NEW = 'https://pod.example/alice/items/2';

  it('writes both instants of the command, typed, beside the fields', async () => {
    const pod = memoryPod({});
    const creation = prepareCreation(pod.source, NEW, item, {
      name: 'Bread',
      bought: false,
    });
    vi.setSystemTime(new Date(T2)); // sending later keeps the captured instant
    expect(await creation.run()).toEqual({ kind: 'created' });
    expect(pod.body(NEW)).toEqual({
      '@id': NEW,
      '@type': [ITEM],
      [NAME]: [{ '@value': 'Bread' }],
      [STATUS]: [{ '@id': NO }],
      [CREATED]: instant(T1),
      [MODIFIED]: instant(T1),
    });
  });

  it('retries a lost creation with the same IRI, body and instants', async () => {
    const pod = memoryPod({});
    const creation = prepareCreation(pod.source, NEW, item, {
      name: 'Bread',
      bought: false,
    });
    pod.once(async (real) => {
      await real();
      return lost;
    });
    expect(await creation.run()).toEqual({ kind: 'unconfirmed' });
    vi.setSystemTime(new Date(T2));
    expect(await creation.run()).toEqual({
      kind: 'unconfirmed',
      desiredObserved: true,
    });
    expect(pod.sent.map((s) => s.body[CREATED])).toEqual([
      instant(T1),
      instant(T1),
    ]);
  });

  it('leaves a raw body and a definition without timestamps as they are', async () => {
    const pod = memoryPod({});
    const plain = fields({ name: text(NAME, { language: null }) });
    await prepareCreation(pod.source, NEW, plain, { name: 'Bread' }).run();
    expect(pod.body(NEW)).toEqual({
      '@id': NEW,
      [NAME]: [{ '@value': 'Bread' }],
    });
  });
});

describe('quick field updates', () => {
  it('check and uncheck replace only the modification instant', async () => {
    const pod = memoryPod();
    const [row] = listed(pod).items;
    // The outcome names the instant written, for display before a new read.
    expect(
      await updateFields(pod.source, row!, item, { bought: true }),
    ).toEqual({ kind: 'saved', modified: T1 });
    expect(pod.sent).toEqual([
      {
        method: 'patch',
        body: { [STATUS]: [{ '@id': YES }], [MODIFIED]: instant(T1) },
      },
    ]);
    vi.setSystemTime(new Date(T2));
    const [again] = listed(pod).items;
    await updateFields(pod.source, again!, item, { bought: false });
    expect(pod.body()).toEqual(stored({ [MODIFIED]: instant(T2) }));
    expect(timestampsOf(listed(pod).items[0]!)).toEqual({
      created: T0,
      modified: T2,
    });
  });

  it('sends nothing for a no-op, so nothing is stamped', async () => {
    const pod = memoryPod();
    const [row] = listed(pod).items;
    expect(
      await updateFields(pod.source, row!, item, {
        bought: false,
        name: 'Milk ',
      }),
    ).toEqual({ kind: 'saved' });
    expect(pod.sent).toEqual([]);
    expect(pod.body()).toEqual(stored());
  });

  it('keeps other values of the modified predicate and repairs ambiguous instants', async () => {
    const note = { '@value': 'yesterday' };
    const pod = memoryPod({
      [ID]: stored({ [MODIFIED]: [note, ...instant(T0), ...instant(T2)] }),
    });
    const [row] = listed(pod).items;
    expect(timestampsOf(row!).modified).toBe(null);
    await updateFields(pod.source, row!, item, { bought: true });
    expect(pod.body()![MODIFIED]).toEqual([note, ...instant(T1)]);
  });

  it('rebases over an independent edit with the command instant, not a later one', async () => {
    const pod = memoryPod();
    const [row] = listed(pod).items;
    // Between this command's read and its write, another device renames the
    // item and stamps its own instant: a 412, then one bounded rebase.
    pod.once(async (real) => {
      pod.other({
        [NAME]: [{ '@value': 'Oat milk' }],
        [MODIFIED]: instant(T2),
      });
      return real();
    });
    expect(
      await updateFields(pod.source, row!, item, { bought: true }),
    ).toEqual({ kind: 'saved', modified: T1 });
    expect(pod.sent).toHaveLength(2);
    expect(pod.body()).toEqual(
      stored({
        [NAME]: [{ '@value': 'Oat milk' }],
        [STATUS]: [{ '@id': YES }],
        [MODIFIED]: instant(T1),
      }),
    );
  });

  it('reviews a change of the same field and stamps nothing', async () => {
    const pod = memoryPod();
    const [row] = listed(pod).items;
    pod.other({ [STATUS]: [{ '@id': YES }], [MODIFIED]: instant(T2) });
    const outcome = await updateFields(pod.source, row!, item, {
      bought: true,
    });
    expect(outcome.kind).toBe('changed-on-pod');
    expect(pod.sent).toEqual([]);
    expect(pod.body()![MODIFIED]).toEqual(instant(T2));
  });

  it('never resends a lost update or a refused one, and stamps only what was sent', async () => {
    const pod = memoryPod();
    const [row] = listed(pod).items;
    pod.once(async () => ({ kind: 'refused', status: 403 }));
    expect(
      (await updateFields(pod.source, row!, item, { bought: true })).kind,
    ).toBe('not-saved');
    expect(pod.body()).toEqual(stored());
    pod.once(async (real) => {
      await real();
      return lost;
    });
    const outcome = await updateFields(pod.source, row!, item, {
      bought: true,
    });
    expect(outcome).toMatchObject({
      kind: 'unconfirmed',
      desiredObserved: true,
    });
    // The refusal never reached the store; the lost write is not resent.
    expect(pod.sent).toHaveLength(1);
    expect(pod.body()![MODIFIED]).toEqual(instant(T1));
  });
});

describe('resource editor saves', () => {
  it('stamps a real save, and a no-op save writes nothing', async () => {
    const pod = memoryPod();
    const editor = createResourceEditor(pod.source, ID, item);
    await editor.loaded;
    editor.change({ name: 'Milk ' }); // stored trimmed: the same value
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(pod.sent).toEqual([]);
    editor.change({ name: 'Oat milk' });
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(pod.sent).toEqual([
      {
        method: 'patch',
        body: { [NAME]: [{ '@value': 'Oat milk' }], [MODIFIED]: instant(T1) },
      },
    ]);
    // The confirmed save adopts the exact result: the editor stays ready.
    expect(editor.state.phase).toBe('ready');
    expect(pod.body()![CREATED]).toEqual(instant(T0));
    editor.dispose();
  });

  it('rebases over an independent stamped edit instead of reviewing', async () => {
    const pod = memoryPod();
    const editor = createResourceEditor(pod.source, ID, item);
    await editor.loaded;
    pod.other({ [STATUS]: [{ '@id': YES }], [MODIFIED]: instant(T2) });
    editor.change({ name: 'Oat milk' });
    expect(await editor.save()).toEqual({ kind: 'saved', alongside: true });
    expect(pod.body()).toEqual(
      stored({
        [NAME]: [{ '@value': 'Oat milk' }],
        [STATUS]: [{ '@id': YES }],
        [MODIFIED]: instant(T1),
      }),
    );
    editor.dispose();
  });

  it('moves a dirty draft over an independent stamped edit on refresh', async () => {
    const pod = memoryPod();
    const editor = createResourceEditor(pod.source, ID, item);
    await editor.loaded;
    editor.change({ name: 'Oat milk' });
    pod.other({ [STATUS]: [{ '@id': YES }], [MODIFIED]: instant(T2) });
    await editor.refresh();
    expect(editor.state.phase).toBe('ready');
    expect(editor.state.draft).toEqual({ name: 'Oat milk', bought: true });
    editor.dispose();
  });

  it('reviews the same field; the save after a decision is a new command', async () => {
    const pod = memoryPod();
    const editor = createResourceEditor(pod.source, ID, item);
    await editor.loaded;
    pod.other({ [NAME]: [{ '@value': 'Soy milk' }], [MODIFIED]: instant(T0) });
    editor.change({ name: 'Oat milk' });
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(editor.state.review).toMatchObject({
      mine: { name: 'Oat milk', bought: false },
      current: { name: 'Soy milk', bought: false },
    });
    editor.continueFromCurrent();
    vi.setSystemTime(new Date(T2));
    expect(await editor.save()).toEqual({ kind: 'saved' });
    expect(pod.body()![MODIFIED]).toEqual(instant(T2));
    editor.dispose();
  });

  it('never resends a lost save', async () => {
    const pod = memoryPod();
    const editor = createResourceEditor(pod.source, ID, item);
    await editor.loaded;
    editor.change({ bought: true });
    pod.once(async (real) => {
      await real();
      return lost;
    });
    expect(await editor.save()).toEqual({ kind: 'review' });
    expect(editor.state.review).toMatchObject({
      kind: 'unconfirmed',
      desiredObserved: true,
    });
    expect(pod.sent).toHaveLength(1);
    editor.dispose();
  });

  it('writes nothing when access is lost or the editor retired before dispatch', async () => {
    const pod = memoryPod();
    const editor = createResourceEditor(pod.source, ID, item);
    await editor.loaded;
    editor.change({ bought: true });
    const unsubscribe = editor.subscribe(() => {
      if (editor.state.phase === 'saving') editor.dispose();
    });
    expect(await editor.save()).toEqual({
      kind: 'not-saved',
      reason: 'not-ready',
    });
    unsubscribe();
    expect(pod.sent).toEqual([]);
    expect(pod.body()).toEqual(stored());
  });

  it('stamps nothing for the escape hatch', async () => {
    const pod = memoryPod();
    const custom: EditDefinition<string> = {
      read: (r) => (r[NAME] as { '@value': string }[])[0]!['@value'],
      patch: (_r, name) => ({ [NAME]: [{ '@value': name }] }),
    };
    const editor = createResourceEditor(pod.source, ID, custom);
    await editor.loaded;
    editor.change('Oat milk');
    await editor.save();
    expect(pod.sent[0]!.body).toEqual({ [NAME]: [{ '@value': 'Oat milk' }] });
    editor.dispose();
  });
});

describe('reading instants for sorting', () => {
  const at = (n: number) => `https://pod.example/alice/items/r${n}`;
  const node = (n: number, extra: JsonLd): JsonLd => ({
    '@id': at(n),
    '@type': [ITEM],
    [NAME]: [{ '@value': `Row ${n}` }],
    [STATUS]: [{ '@id': NO }],
    ...extra,
  });

  it('reads the first predicate with an instant, and lists rows without usable ones', () => {
    const pod = memoryPod({});
    const list = snapshots(
      pod.source,
      [
        node(1, { [CREATED]: instant(T0), [LEGACY]: instant(T2) }),
        // A legacy record: read, never backfilled or rewritten.
        node(2, { [LEGACY]: instant('2025-01-01T10:00:00+02:00') }),
        node(3, {}),
        node(4, { [CREATED]: [...instant(T0), ...instant(T1)] }),
        node(5, { [CREATED]: instant('2026-11-01T08:00:00') }),
        node(6, { [CREATED]: [{ '@value': T0 }], [LEGACY]: instant(T1) }),
        node(7, {
          [CREATED]: [{ '@value': '2026-11-01', '@type': `${XSD}date` }],
        }),
        node(8, { [MODIFIED]: { '@value': T0 } as unknown as [] }),
      ],
      item,
    );
    expect(list.skipped).toBe(0);
    expect(list.items.map((row) => timestampsOf(row))).toEqual([
      { created: T0, modified: null },
      { created: '2025-01-01T10:00:00+02:00', modified: null },
      { created: null, modified: null },
      { created: null, modified: null }, // ambiguous
      { created: null, modified: null }, // no time zone
      { created: T1, modified: null }, // a plain string is not an instant
      { created: null, modified: null }, // a day is not an instant
      { created: null, modified: null }, // malformed
    ]);
  });

  it('rejects objects that are not snapshots', () => {
    expect(() =>
      timestampsOf({ iri: ID, data: { name: 'Milk', bought: false } }),
    ).toThrow(TypeError);
  });
});
