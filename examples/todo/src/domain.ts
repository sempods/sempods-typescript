import {
  fields,
  flag,
  text,
  type SnapshotList,
} from '@sempods/client-sdk/edit';

const schema = 'https://schema.org/';

/** Provisional Focus-compatible Action profile; the vocabulary decision remains external. */
export const taskFields = fields(
  {
    title: text(schema + 'name', { language: null }),
    done: flag(schema + 'actionStatus', {
      on: schema + 'CompletedActionStatus',
      off: schema + 'PotentialActionStatus',
    }),
  },
  { type: schema + 'Action' },
);
export type Task = { readonly title: string; readonly done: boolean };

export const emptyTask: Task = { title: '', done: false };

/** The example excludes incomplete Actions as well as unmappable terms. */
export function supportedTasks(list: SnapshotList<Task>): SnapshotList<Task> {
  const items = list.items.filter((item) => taskFields.valid!(item.data));
  return { items, skipped: list.skipped + list.items.length - items.length };
}
