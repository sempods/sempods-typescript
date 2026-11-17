/**
 * Creation and modification times the SDK's standard writes maintain, and
 * two orders built on them (see docs/timestamps.md). A shopping list as the
 * example: items still to buy oldest first, bought items most recently
 * changed first. The vocabulary and both orders are the app's choice.
 */
import {
  classifyDate,
  fields,
  flag,
  text,
  timestampsOf,
  type DraftOf,
  type Snapshot,
  type Timestamps,
} from '@sempods/client-sdk/edit';

const SCHEMA = 'https://schema.org/';

export const itemFields = fields(
  {
    name: text(`${SCHEMA}name`, { language: null, trim: true }),
    bought: flag('https://example.org/shopping#bought', {
      on: 'https://example.org/shopping#Yes',
      off: 'https://example.org/shopping#No',
      absent: false,
    }),
  },
  {
    type: `${SCHEMA}Product`,
    timestamps: {
      // Written when an item is created. Older items are read from
      // dcterms:created as well; that value is never rewritten or backfilled.
      created: [`${SCHEMA}dateCreated`, 'http://purl.org/dc/terms/created'],
      // Written with every change that the standard writes send.
      modified: `${SCHEMA}dateModified`,
    },
  },
);
export type Item = DraftOf<typeof itemFields>;

/** Milliseconds since 1970 (UTC), so offsets compare exactly; else `null`. */
function epoch(value: string | null): number | null {
  if (value === null) return null;
  const stored = classifyDate(value);
  return stored.kind === 'instant' ? stored.epochMilliseconds : null;
}

/**
 * Rows ordered by one instant. Rows without a usable one stay listed and
 * come last; ties and those rows are ordered by IRI, so the order is the
 * same after every read.
 */
function byInstant<D>(
  rows: readonly Snapshot<D>[],
  instant: (timestamps: Timestamps) => string | null,
  direction: 1 | -1,
): Snapshot<D>[] {
  return rows
    .map((row) => ({ row, at: epoch(instant(timestampsOf(row))) }))
    .sort((a, b) => {
      if (a.at !== b.at) {
        if (a.at === null) return 1;
        if (b.at === null) return -1;
        return direction * (a.at - b.at);
      }
      return a.row.iri < b.row.iri ? -1 : a.row.iri > b.row.iri ? 1 : 0;
    })
    .map(({ row }) => row);
}

/** Items still to buy, the oldest first. */
export function toBuy(rows: readonly Snapshot<Item>[]): Snapshot<Item>[] {
  return byInstant(
    rows.filter((row) => !row.data.bought),
    (t) => t.created,
    1,
  );
}

/** Bought items, the most recently changed first (renaming counts too). */
export function bought(rows: readonly Snapshot<Item>[]): Snapshot<Item>[] {
  return byInstant(
    rows.filter((row) => row.data.bought),
    (t) => t.modified,
    -1,
  );
}
