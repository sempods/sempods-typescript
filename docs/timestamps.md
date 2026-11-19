# Creation and modification times

Use this recipe when an app orders or shows records by when they were created
or last changed. Declare the predicates once in the `fields()` definition;
every standard write then maintains them, and the app never writes them
itself. The vocabulary is the app's. Copy and adapt
[`timestamps.ts`](../examples/todo/recipes/timestamps.ts): a definition and
two orders over list rows.

## The small path

The recipe's definition, shortened; `SCHEMA`, `name` and `bought` stand for
its own:

```ts
const itemFields = fields(
  { name, bought },
  {
    type: `${SCHEMA}Product`,
    timestamps: {
      created: [`${SCHEMA}dateCreated`, 'http://purl.org/dc/terms/created'],
      modified: `${SCHEMA}dateModified`,
    },
  },
);
```

Use the definition with the hooks as usual. To order rows, read each row's
instants with `timestampsOf(row)` and compare them as instants, not as text,
as the recipe's `toBuy` and `bought` do:

```tsx
const list = useList(itemFields);
const rows = toBuy(list.data?.items ?? []);
```

## What is written when

| Write                                                           | Instants                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A creation                                                      | `created` and `modified`, the same instant                                                     |
| A row update or editor save that changes a field                | `modified`, in the same conditional request; `created` stays                                   |
| A no-op, read, Cancel or Discard; a refused or stopped write    | Nothing                                                                                        |
| A lost answer                                                   | Never resent, so never stamped again                                                           |
| Running a held creation again                                   | The instants captured with it                                                                  |
| A bounded rebase after another writer changed only other fields | The instant captured with this command, even if the other writer stamped a later one meanwhile |

Each instant is taken from the device clock once, when `create()`,
`update(…)` or **Save** starts, as a UTC `xsd:dateTime`.

The instants are not fields: forms never show them, `valid` and the review
ignore them, and two people changing different fields do not conflict over
`modified`.

## Reading them

`timestampsOf(row)` returns `{ created, modified }` for a row of `useList` or
`listSubjects` (a `usePodList` item's `snapshot`). A list of predicates is read
in order and only the first is written, so an older `dcterms:created` stays
readable and is never rewritten. An absent or unusable value (several values,
no time zone) reads `null`; the row stays listed, and nothing is backfilled.
Show a value with `format.dateTime(value) ?? value`.

## Before the list reads again

A confirmed row update shows its values at once in `row.data`, while the list
reads the row again. `row.timestamps` of `useFieldUpdate` and
`useContextUpdate` does the same for the instants: `timestampsOf(snapshot)`
with the modification instant that this update wrote laid over. So a slow
list read cannot put an item just ticked behind one bought earlier, and the
app needs no clock reading of its own. Order the rows as shown:

```tsx
const mutate = useFieldUpdate(itemFields);
const rows = (list.data?.items ?? []).map((item) => ({
  iri: item.iri,
  ...mutate.for(item),
}));
const shown = bought(rows); // the recipe's order, by `row.timestamps`
```

- The snapshot stays the evidence of what was read: `timestampsOf(snapshot)`
  still returns the read instants.
- A pending, refused, conflicting or unconfirmed write changes nothing: the
  row keeps the instants it showed, as `row.data` keeps its values. A
  confirmed update that wrote nothing (a no-op) keeps them too.
- The next read brings a fresh snapshot, and with it the instants on the Pod
  again, also those another writer stamped since.
- Without the hooks, `updateFields` returns the instant it wrote as
  `{ kind: 'saved', modified }`; `modified` is absent when it wrote none.

## Limits

- The time is the device's, maintained by this app: not the Pod's commit time,
  and other writers may not maintain it.
- `modified` changes with every change, so it is no completion time. Give one
  its own field when the app needs it.
- Only a `fields()` definition with `timestamps` stamps; a raw-body creation,
  an `EditDefinition` escape hatch or a copied definition does not.
- A timestamp predicate cannot also be a field.
- Only the row hooks show a confirmed instant before the next read; after an
  editor save or a creation, the list's next read brings it.
