import { describe, expect, expectTypeOf, it } from 'vitest';
import { fields, flag, text, type DraftOf } from './index.js';

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
  it('writes the value without outer whitespace when created', () => {
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
