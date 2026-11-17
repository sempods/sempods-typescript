# Creation and modification times

Use this recipe when an app orders or shows its records by when they were
created or last changed, for example a shopping list with the oldest items
first and bought items by their latest change. Declare the two predicates
once in the `fields()` definition. The SDK's standard writes then maintain
them: `useCreation`, `useFieldUpdate`, `useContextUpdate`, `ResourceEditor`
(also through `useContextEditor`) and their portable counterparts
`prepareCreation`, `updateFields` and `createResourceEditor`. The app does not
write them itself.

The vocabulary is the app's: the SDK writes nothing until a definition asks
for it. Copy and adapt
[`timestamps.ts`](../examples/todo/recipes/timestamps.ts): its definition and
two orders over list rows.

## The small path

```ts
import { fields, flag, text } from '@sempods/client-sdk/edit';

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
      created: [`${SCHEMA}dateCreated`, 'http://purl.org/dc/terms/created'],
      modified: `${SCHEMA}dateModified`,
    },
  },
);
```

Use the definition with the hooks as usual. To order rows, read each list
row's instants with `timestampsOf(row)` and compare them as instants, not as
text; the recipe's `toBuy` and `bought` do that with `classifyDate`:

```tsx
const list = useList(itemFields);
const mutate = useFieldUpdate(itemFields);
const rows = list.data?.items ?? [];

<ul>
  {toBuy(rows).map((item) => (
    <ItemRow key={item.iri} row={mutate.for(item)} />
  ))}
</ul>;
```

## What is written when

| Write                                                           | Instants                                                                                       |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A creation                                                      | `created` and `modified`, the same instant, in the one creation                                |
| A row update or editor save that changes a field                | `modified`, in the same conditional request as the change; `created` stays untouched           |
| A no-op (nothing differs), reading, opening, Cancel, Discard    | Nothing; no request is sent                                                                    |
| A refused or stopped write                                      | Nothing                                                                                        |
| A lost answer                                                   | Never resent, so never stamped again; its review compares only the fields                      |
| Running a held creation again                                   | The same IRI and body, so the instants captured with it                                        |
| A bounded rebase after another writer changed only other fields | The instant captured with this command, even if the other writer stamped a later one meanwhile |

Each instant is captured once, when the write command starts: `create()`,
`update(…)` or **Save**, not while rendering or typing. It is an
`xsd:dateTime` in UTC, such as `2026-11-17T09:00:00.000Z`. A change writes
`modified` as one value: it replaces that predicate's `xsd:dateTime` values
and keeps its other values.

The instants are not fields. They are not in the draft, so forms never show
them as inputs, `valid` never depends on them, and two people who change
different fields do not conflict over `modified`. The editor's review and
`UpdateNotice` compare the person's fields as before; the instant written
with a lost save stays visible on the Pod.

## Reading them

`timestampsOf(row)` returns `{ created, modified }` as stored lexical forms,
for a row of `useList` or `listSubjects` (a `usePodList` item's `snapshot`). A
list of predicates reads them in order; the first predicate with an
`xsd:dateTime` value decides. Only the first one is ever written, so an older
`dcterms:created` stays readable and is never rewritten. A record without a
usable value reads `null`: absent, several values, no time zone, or not an
`xsd:dateTime`. Such records stay in the list; the app decides where they go
(the recipe puts them last, by IRI). Nothing is backfilled with the current
time, and reading never migrates data.

Show one with the provider's `format.dateTime(value) ?? value`.

## Limits

- The time comes from the device's clock. It is what this app maintains, not
  the Pod's commit time, and a wrong device clock writes a wrong time. Other
  apps and writers may not maintain these predicates.
- `modified` changes with every change, so it is not a completion time:
  renaming a bought item also moves it up in the recipe's bought list. Give a
  completion time its own field when the app needs one.
- Only a `fields()` definition with `timestamps` stamps. A raw-body
  `prepareCreation`, an `EditDefinition` escape hatch, a copied definition and
  a direct `definition.patch()` write no instants.
- A timestamp predicate cannot also be a field. To let people edit a date,
  declare a `dateTime` field on another predicate.
- `classifyDate` compares instants to the millisecond; digits after the
  milliseconds are dropped.
