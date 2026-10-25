import { fields, flag, text } from '@sempods/client-sdk/edit';

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
