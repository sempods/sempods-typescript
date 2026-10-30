/**
 * Inspectable reasons for the subjects a list leaves out (#187): strict
 * mapping and the count stay as they were, and nothing is repaired.
 */
import { describe, expect, it, vi } from 'vitest';
import type { JsonLd, QueryResult } from '../results.js';
import {
  fields,
  flag,
  listSubjects,
  snapshots,
  text,
  type ListSource,
  type ResourceSource,
} from './index.js';

const NAME = 'https://schema.org/name';
const STATUS = 'https://schema.org/actionStatus';
const DONE = 'https://schema.org/CompletedActionStatus';
const OPEN = 'https://schema.org/PotentialActionStatus';
const TYPE = 'https://schema.org/Action';
const task = fields(
  {
    title: text(NAME, { language: null }),
    done: flag(STATUS, { on: DONE, off: OPEN }),
  },
  { type: TYPE },
);
const iri = (n: number | string) => `https://pod.example/alice/tasks/${n}`;
const node = (id: unknown, title: unknown, status: unknown = OPEN): JsonLd => ({
  '@id': id as string,
  '@type': [TYPE],
  [NAME]: title as JsonLd[string],
  [STATUS]: [{ '@id': status }],
});

// No reads or writes happen while mapping: every call would be a repair.
const fail = () => {
  throw new Error('no request expected');
};
const source: ResourceSource = {
  subjects: { get: fail, put: fail, patch: fail, delete: fail },
};

describe('skippedRecords', () => {
  const mixed = [
    node(iri(1), [{ '@value': 'Valid' }]),
    node('_:b0', [{ '@value': 'Blank node' }]),
    node('tasks/relative', [{ '@value': 'Relative' }]),
    node(undefined, [{ '@value': 'No id' }]),
    node(iri(2), [{ '@value': 'One' }, { '@value': 'Two' }]),
    node(iri(3), [{ '@value': 'Unknown status' }], 'https://example.org/Later'),
    node(iri(4), [{ '@value': '   ' }]),
    node(iri(5), 'not an array'),
    node(iri(1), [{ '@value': 'Again' }]),
    node(iri(6), [{ '@value': 'Also valid' }], DONE),
  ];

  it('keeps valid rows and the count, and says why each node was left out', () => {
    const before = structuredClone(mixed);
    const list = snapshots(source, mixed, task);
    expect(list.items.map((item) => item.iri)).toEqual([iri(1), iri(6)]);
    expect(list.skipped).toBe(8);
    expect(list.skippedRecords).toEqual([
      { iri: null, reason: 'not-addressable', fields: [] },
      { iri: null, reason: 'not-addressable', fields: [] },
      { iri: null, reason: 'not-addressable', fields: [] },
      { iri: iri(2), reason: 'unreadable', fields: ['title'] },
      { iri: iri(3), reason: 'unreadable', fields: ['done'] },
      { iri: iri(4), reason: 'invalid', fields: ['title'] },
      { iri: iri(5), reason: 'unreadable', fields: ['title'] },
      { iri: iri(1), reason: 'duplicate', fields: [] },
    ]);
    // Diagnostics carry no record contents, and the input is unchanged.
    expect(JSON.stringify(list.skippedRecords)).not.toMatch(/One|Two|Later/);
    expect(mixed).toEqual(before);
    expect(Object.isFrozen(list.skippedRecords)).toBe(true);
    expect(Object.isFrozen(list.skippedRecords[3]!.fields)).toBe(true);
  });

  it('names every failing field of one node', () => {
    const list = snapshots(
      source,
      [node(iri(7), [{ '@value': 'a' }, { '@value': 'b' }], 'urn:other')],
      task,
    );
    expect(list.skippedRecords).toEqual([
      { iri: iri(7), reason: 'unreadable', fields: ['title', 'done'] },
    ]);
  });

  it('reports a wholly unmappable list as no items, not as a failure', () => {
    const list = snapshots(source, mixed.slice(1, 8), task);
    expect(list.items).toEqual([]);
    expect(list.skipped).toBe(7);
    expect(list.skippedRecords).toHaveLength(7);
  });

  it('keeps the first 100 records and the full count', () => {
    const many = Array.from({ length: 150 }, (_, n) =>
      node(iri(`bad-${n}`), []),
    );
    const list = snapshots(source, many, task);
    expect(list.skipped).toBe(150);
    expect(list.skippedRecords).toHaveLength(100);
    expect(list.skippedRecords[99]).toEqual({
      iri: iri('bad-99'),
      reason: 'invalid',
      fields: ['title'],
    });
  });

  it('an empty list has no records', () => {
    expect(snapshots(source, [], task)).toEqual({
      items: [],
      skipped: 0,
      skippedRecords: [],
    });
  });
});

describe('listSubjects', () => {
  const view = (answer: QueryResult<readonly JsonLd[]>): ListSource => ({
    ...source,
    sparql: { construct: vi.fn(async () => answer) },
  });

  it('passes the records through with the list', async () => {
    const result = await listSubjects(
      view({
        kind: 'ok',
        body: [node(iri(1), [{ '@value': 'Ok' }]), node('_:x', [])],
      }),
      task,
    );
    expect(result).toMatchObject({
      kind: 'ok',
      body: {
        skipped: 1,
        skippedRecords: [{ iri: null, reason: 'not-addressable', fields: [] }],
      },
    });
  });

  it('keeps a failed query a failure, not an empty or partial list', async () => {
    const refused = { kind: 'refused', status: 403 } as const;
    expect(
      await listSubjects(view(refused as QueryResult<readonly JsonLd[]>), task),
    ).toBe(refused);
  });
});
