import { fields, flag, text, type DraftOf } from '@sempods/client-sdk/edit';

const schema = 'https://schema.org/';

/** Provisional Focus-compatible Action profile; the vocabulary decision remains external. */
export const taskFields = fields(
  {
    title: text(schema + 'name', { language: null, trim: true }),
    done: flag(schema + 'actionStatus', {
      on: schema + 'CompletedActionStatus',
      off: schema + 'PotentialActionStatus',
    }),
  },
  { type: schema + 'Action' },
);
export type Task = DraftOf<typeof taskFields>;

export const emptyTask: Task = { title: '', done: false };
