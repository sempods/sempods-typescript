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

## Limits

- The time is the device's, maintained by this app: not the Pod's commit time,
  and other writers may not maintain it.
- `modified` changes with every change, so it is no completion time. Give one
  its own field when the app needs it.
- Only a `fields()` definition with `timestamps` stamps; a raw-body creation,
  an `EditDefinition` escape hatch or a copied definition does not.
- A timestamp predicate cannot also be a field.
