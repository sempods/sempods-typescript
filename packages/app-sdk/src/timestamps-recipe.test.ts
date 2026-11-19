/** The timestamps recipe (#367): two orders over the maintained instants. */
import { describe, expect, it } from 'vitest';
import {
  snapshots,
  timestampsOf,
  type ResourceSource,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  bought,
  itemFields,
  toBuy,
} from '../../../examples/todo/recipes/timestamps.js';

const SCHEMA = 'https://schema.org/';
const DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const YES = 'https://example.org/shopping#Yes';
const at = (value: string) => [{ '@value': value, '@type': DT }];
const source = {} as ResourceSource; // listing only: never read or written

function item(
  id: string,
  isBought: boolean,
  times: { created?: string; legacy?: string; modified?: string },
): JsonLd {
  return {
    '@id': `https://pod.example/alice/items/${id}`,
    '@type': [`${SCHEMA}Product`],
    [`${SCHEMA}name`]: [{ '@value': id }],
    ...(isBought
      ? { 'https://example.org/shopping#bought': [{ '@id': YES }] }
      : {}),
    ...(times.created ? { [`${SCHEMA}dateCreated`]: at(times.created) } : {}),
    ...(times.legacy
      ? { 'http://purl.org/dc/terms/created': at(times.legacy) }
      : {}),
    ...(times.modified
      ? { [`${SCHEMA}dateModified`]: at(times.modified) }
      : {}),
  };
}
const names = (rows: readonly { readonly data: { name: string } }[]) =>
  rows.map((row) => row.data.name);

describe('timestamps recipe', () => {
  const rows = snapshots(
    source,
    [
      item('c', false, { created: '2026-11-17T10:00:00+01:00' }),
      // 08:30Z is earlier than 10:00+01:00 (09:00Z): exact instants, not text.
      item('b', false, { created: '2026-11-17T08:30:00Z' }),
      item('z', false, {}),
      item('a', false, {}),
      item('legacy', false, { legacy: '2025-03-01T12:00:00+02:00' }),
      item('x', true, { modified: '2026-11-17T09:00:00Z' }),
      item('y', true, { modified: '2026-11-17T11:00:00+01:00' }),
      item('w', true, { modified: '2026-11-17T09:30:00-01:00' }),
      item('v', true, {}),
    ],
    itemFields,
  ).items;

  it('lists items to buy oldest created first, legacy dates included', () => {
    expect(names(toBuy(rows))).toEqual(['legacy', 'b', 'c', 'a', 'z']);
  });

  it('lists bought items most recently modified first', () => {
    // 09:30-01:00 is 10:30Z, 11:00+01:00 is 10:00Z.
    expect(names(bought(rows))).toEqual(['w', 'y', 'x', 'v']);
  });

  it('orders an item just ticked by its confirmed instant before the list reads it again', () => {
    // Rows as `{ iri: item.iri, ...mutate.for(item) }` shows them: `c` was
    // ticked at 12:00Z; its snapshot still reads it open and without an
    // instant. The others are shown as read.
    const shown = rows.map((row) =>
      row.data.name === 'c'
        ? {
            iri: row.iri,
            data: { ...row.data, bought: true },
            timestamps: {
              ...timestampsOf(row),
              modified: '2026-11-17T12:00:00Z',
            },
          }
        : { iri: row.iri, data: row.data, timestamps: timestampsOf(row) },
    );
    expect(names(bought(shown))).toEqual(['c', 'w', 'y', 'x', 'v']);
    expect(names(toBuy(shown))).toEqual(['legacy', 'b', 'a', 'z']);
    // The snapshots alone still order as read.
    expect(names(bought(rows))).toEqual(['w', 'y', 'x', 'v']);
  });

  it('keeps the same order whatever order the query returned', () => {
    expect(names(toBuy([...rows].reverse()))).toEqual(names(toBuy(rows)));
    expect(names(bought([...rows].reverse()))).toEqual(names(bought(rows)));
  });
});
