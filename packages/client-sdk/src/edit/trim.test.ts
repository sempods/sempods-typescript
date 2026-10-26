import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  fields,
  flag,
  snapshots,
  text,
  updateFields,
  type DraftOf,
} from './index.js';
import type { JsonLd, WriteResult } from '../index.js';
import { describeNew } from './fields.js';

const task = fields(
  {
    title: text('urn:title', { language: null, trim: true }),
    note: text('urn:note', { language: null, optional: true }),
    done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
  },
  { type: 'urn:Task' },
);

// A new subject as creation starts it: its flag has a value.
const fresh = { 'urn:status': [{ '@id': 'urn:open' }] };

describe('text(…, { trim: true })', () => {
  it('creates the subject with the value without outer whitespace', () => {
    expect(
      describeNew(task, 'urn:one', {
        title: '  Milk ',
        note: null,
        done: false,
      }),
    ).toEqual({
      '@id': 'urn:one',
      '@type': ['urn:Task'],
      'urn:title': [{ '@value': 'Milk' }],
      'urn:status': [{ '@id': 'urn:open' }],
    });
  });

  it('writes the value without outer whitespace into an empty subject', () => {
    expect(
      task.patch(fresh, { title: '  Milk ', note: null, done: false }),
    ).toEqual(expect.objectContaining({ 'urn:title': [{ '@value': 'Milk' }] }));
  });

  it('writes nothing when only outer whitespace differs, and trims a change', () => {
    const resource = {
      'urn:title': [{ '@value': 'Milk' }],
      'urn:status': [{ '@id': 'urn:open' }],
    };
    expect(
      task.patch(resource, { title: 'Milk  ', note: null, done: false }),
    ).toEqual({});
    expect(
      task.patch(resource, { title: ' Oat milk ', note: null, done: false }),
    ).toEqual({
      'urn:title': [{ '@value': 'Oat milk' }],
    });
  });

  it('leaves an untouched value as stored, whitespace included', () => {
    const resource = {
      'urn:title': [{ '@value': ' Milk ' }],
      'urn:status': [{ '@id': 'urn:open' }],
    };
    expect(
      task.patch(resource, { title: ' Milk ', note: null, done: true }),
    ).toEqual({ 'urn:status': [{ '@id': 'urn:done' }] });
  });

  it('rejects a blank value and leaves fields without trim as typed', () => {
    expect(task.valid!({ title: '   ', note: null, done: false })).toBe(false);
    expect(
      task.patch(fresh, { title: 'Milk', note: ' as typed ', done: false }),
    ).toEqual(
      expect.objectContaining({ 'urn:note': [{ '@value': ' as typed ' }] }),
    );
  });
});

it('DraftOf takes a definition as well as a field spec', () => {
  expectTypeOf<DraftOf<typeof task>>().toEqualTypeOf<{
    readonly title: string;
    readonly note: string | null;
    readonly done: boolean;
  }>();
});

it('a lost answer observes the trimmed value as the desired one', async () => {
  let body: JsonLd = {
    '@id': 'urn:one',
    'urn:title': [{ '@value': 'Milk' }],
    'urn:status': [{ '@id': 'urn:open' }],
  };
  let version = 1;
  const source = {
    podUrl: 'https://pod.example/alice',
    subjects: {
      get: async () => ({ kind: 'ok' as const, body, etag: `"v${version}"` }),
      put: async (): Promise<WriteResult> => ({ kind: 'precondition-failed' }),
      delete: async (): Promise<WriteResult> => ({
        kind: 'precondition-failed',
      }),
      // Applied, but the answer is lost.
      patch: async (_: string, change: JsonLd): Promise<WriteResult> => {
        body = { ...body, ...change };
        version++;
        return {
          kind: 'uncertain',
          failure: { code: 'network', retryable: false },
        } as unknown as WriteResult;
      },
    },
  };
  const [row] = snapshots(source as never, [body], task).items;
  expect(
    await updateFields(source as never, row!, task, { title: ' Oat milk ' }),
  ).toMatchObject({ kind: 'unconfirmed', desiredObserved: true });
  expect(body['urn:title']).toEqual([{ '@value': 'Oat milk' }]);
});
