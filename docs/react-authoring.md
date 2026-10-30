# React and headless authoring

Build a sempods screen with `@sempods/app-sdk/react`, or the same behaviour
without React. Start with the [complete minimal screen](quickstart.md) when
integrating the SDK; new apps start in
[sempods-apps-template](https://github.com/sempods/sempods-apps-template).
This guide is a task reference. The [TODO screen](../examples/todo/src/app.tsx)
adds a list switch and app-owned presentation; its
[domain functions](../examples/todo/src/domain.ts) hold the field definition.

1. [Model and setup](#part-1-model-and-setup)
2. [The core screen](#part-2-the-core-screen)
3. [Contexts](#part-3-contexts)
4. [Customizing](#part-4-customizing)
5. [Reference](#part-5-reference)

## Part 1: Model and setup

### How the pieces fit

```text
runtime ─ SempodsProvider ─ AppAccess        sign-in, choice, sharing, recovery
                         └ TargetScreen      renders once a target is usable
                             └ your screen   useList, useCreation, useFieldUpdate,
                                             useResourceEditor, notices
```

- **Pod**: a person's data service. **Connection**: a signed-in session with
  one Pod; several can exist, one is active.
- **Context**: a named area of data in a Pod (for example a task list), with
  its own read and write access per app. The **catalogue** lists the Contexts
  this app may use.
- **Selection**: the Context the app currently works in; `AppAccess` or
  `useContexts()` choose it. With `contextSelection: 'on-demand'` an app works
  across Contexts and selects one only where a screen needs it.
- **Target**: the current connection and Context for a screen. Its access can
  change without replacing the screen or discarding its draft.
- **Preset**: a Pod (and optionally a Context) the app suggests or fixes.
- **Write outcomes**: `saved`/`created`/`removed`; `not-saved` and its
  siblings (refused or failed; nothing changed); `changed-on-pod` (someone
  changed it first: compare, then decide); `unconfirmed` (the answer was lost:
  check the Pod, never resend blindly). `UpdateNotice` renders all of them.

### State ownership and lifetime

An ordinary app creates the runtime and provider once, then composes the
screen. The provider creates the controller; the screen does not need another
store for SDK drafts or write recovery.

| Owner                                    | What it keeps                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Browser runtime                          | Connections, session persistence, access evidence and bound read/write handles                                         |
| App controller (created by the provider) | Resource-editor drafts, pending/unresolved resource writes, captured creations and their recovery, guarded transitions |
| React screen                             | Row selection, filters, other app-local state and a creation form's own unsent draft                                   |

| Change                                                               | What happens                                                                                                                                                                                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rerender, language or visual change                                  | Keep the runtime/provider and target stable; drafts and recovery stay                                                                                                                                                          |
| Same-target read/write access loss                                   | Keep the screen mounted. Server data/comparison evidence follows read access; drafts and unresolved outcomes stay. Writes follow current eligibility                                                                           |
| Temporarily hide a screen with Suspense or Activity                  | React state is retained. Controller-owned editors and writes remain; show their recovery when the screen is visible again                                                                                                      |
| Unmount a screen, then mount it under the same controller and target | Resource-editor drafts and guards remain; opening the same subject again with the same definition reclaims them. Captured pending/unresolved writes return. App-local state, row selection and an unsent creation draft do not |
| Guarded row, Context or connection change                            | Ask about the work being left; pending writes block relevant changes. `TargetScreen` resets local state for a new target. Explicit-Context flows have their own [scope](#selection-and-draft-lifetime)                         |
| Dispose/replace the host, reload or leave the page                   | In-memory drafts and recovery end. Saved sessions can restore; browser navigation is not the SDK's guarded navigation                                                                                                          |

Hidden Activity retains local state but disconnects effects, including an
unsent creation form's draft guard. Keep that form outside the hidden boundary
when navigation elsewhere must still ask about its draft. Controller-owned
editors and pending/unresolved writes keep their guards while hidden.

Render row notices with the row and `UnresolvedNotices` below the list.
An editor for a selected resource must remain reachable even if its list row
disappears. The [quickstart](quickstart.md#3-the-app-srcapptsx) shows both.
For precise scopes and custom navigation, see
[selection and draft lifetime](#selection-and-draft-lifetime).

Unmounting is not guarded navigation. After a remount, `useSelection` starts
with no row selected. Selecting the retained editor's subject opens its draft
or review without discarding it; other local/connection guards still ask, and
pending writes still block navigation until they settle. This does not restore
selection automatically or carry an editor across a target change.

### Runtime and provider

```tsx
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  SempodsProvider,
  AppAccess,
  TargetScreen,
} from '@sempods/app-sdk/react';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'My tasks',
    redirectUri: location.origin + '/callback',
  },
  // Return to the page the person was on when signing in (deep links).
  returnTo: () => location.pathname + location.search + location.hash,
  development: 'loopback-http', // only for local HTTP development
});

<SempodsProvider runtime={runtime}>
  <AppAccess appName="My tasks" />
  <TargetScreen>
    <TaskScreen />
  </TargetScreen>
</SempodsProvider>;
```

- Create one runtime outside render for one `SempodsProvider`, which consumes
  `runtime.initialize()` (no second session coordinator). Keep it stable:
  changing it is an application lifetime change; equal inline locale or message
  props never replace the runtime or an editor.
- Keep `contextSelection` fixed for the provider's lifetime: changing it
  replaces the controller and cancels a pending leave confirmation.
- The host calls `runtime.dispose()` at shutdown; unmounting the provider does
  not dispose it.
- Serve the same app at the redirect path. Startup processes the callback and
  restores other connections independently; a returning connection becomes
  active, Context selection stays explicit, and Context screens appear only once
  startup settles. The startup report exposes `connectionId` for headless hosts.
- Screens never handle callbacks, credentials, ETags or authentication
  recovery; see [browser runtime](browser-runtime.md) for identity, sessions and
  the one-active-tab contract.

`AppAccess` is a centered sign-in and recovery surface beside your content, not
a frame; it hides once the target is readable, including read-only access. It
takes no children and never unmounts your screen: keep `TargetScreen` and
mutation controllers mounted through same-target access loss, and keep
uncertain-write recovery outside hidden or inert regions. Disable edits by
operation eligibility; `<AccessNotice only="write" />` beside `AppAccess` says
only that the list is read-only. Options: [customizing](#part-4-customizing).

## Part 2: The core screen

### API at a glance

The one API map of these guides. Entries: **app** = `@sempods/app-sdk`,
**React** = `@sempods/app-sdk/react`, **edit** = `@sempods/client-sdk/edit`.

| Task                                                                 | Hook or component (entry)                                     | What to pass                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [Start the browser session](#runtime-and-provider)                   | `createBrowserRuntime` (app)                                  | Identity, optional `preset`/`allowedPods`; one stable runtime outside render |
| [Bind the UI](#runtime-and-provider)                                 | `SempodsProvider`, `TargetScreen` (React)                     | The runtime; your screen inside `TargetScreen`                               |
| [Sign-in, Context choice, recovery](#appaccess-props)                | `AppAccess` (React)                                           | `appName`; a host button sets `open`                                         |
| [Describe your data](#field-definitions)                             | `fields`, `text`, `flag`, `iri`, `dateTime` (edit)            | Type and predicate IRIs, explicit text language, `trim: true` for text       |
| [Show a list](#lists-uselist-and-loadnotice)                         | `useList`, `LoadNotice` (React)                               | The definition; render `list.data?.items` and `<LoadNotice {...list} />`     |
| [Add an item](#creating-usecreation)                                 | `useCreation` (React)                                         | `{ initial, collection }`; inputs to `canEdit`, submit to `canCreate`        |
| [Update or delete a row](#updating-and-deleting-rows-usefieldupdate) | `useFieldUpdate`, `RemoveButton`, `UnresolvedNotices` (React) | One hook per list; `const row = mutate.for(item)` per row                    |
| [Edit one item in a form](#editing-a-form-useresourceeditor)         | `useResourceEditor`, `ResourceEditor` (React)                 | Selected IRI and definition; inputs calling `change`; `onClose` in place     |
| [Explain an outcome](#notices-updatenotice)                          | `UpdateNotice` (React)                                        | `{...creation.notice}` or `{...row.notice}`; `quiet` when the row confirms   |
| [Open another item](#selection-useselection)                         | `useSelection` (React)                                        | Guarded `select(iri)`; `select(null)` closes                                 |
| [Translate the app's texts](#app-texts-usemessages)                  | `useMessages` (React)                                         | One `{ en, de }` catalogue outside components                                |
| [Switch between Contexts](#apps-that-switch-contexts)                | `useContexts` (React)                                         | Mount outside `TargetScreen`                                                 |
| [Create in another Context](#creating-in-an-explicit-context)        | `useCreation` with `context` (React), `bindCreation` (app)    | The Context IRI; one hook per Context                                        |
| [Read across the Pod](#pod-overviews-with-contexts-on-demand)        | `usePodLoad` (React)                                          | `pod.sparql.select`/`construct`; provider `contextSelection="on-demand"`     |
| [One type across Contexts](#pod-overviews-with-contexts-on-demand)   | `usePodList` + `LoadNotice` (React)                           | A `fields()` definition with a `type`                                        |
| [One-click overview rows](#one-click-overview-rows)                  | `useContextUpdate` (React)                                    | The same definition as `usePodList`                                          |
| [Edit a Pod-overview row](#editing-an-overview-row)                  | `useContextEditor`, `ResourceEditor` (React)                  | The row's subject and `GRAPH` Context                                        |
| [Read arbitrary resources](#read-arbitrary-resources)                | `useLoad` (React)                                             | A `ViewRead`; `key` for its inputs                                           |
| [Custom connection controls](#custom-layouts-without-appaccess)      | `useApp`, `useAppState`, `useConnections` (React)             | Guarded actions only                                                         |

### Field definitions

A `fields()` definition describes RDF terms once for the hooks,
`ResourceEditor` and Node code. Declare text fields with `trim: true` instead
of trimming before `create()`.

- Inline definitions are fine: hooks compare `fields()` definitions by
  structure and share one instance per structure, so `useList` snapshots work
  with `useFieldUpdate`. A real change (type, language, predicate) starts a new
  editor, list read or form; the console says when that discards a draft or a
  pending or unconfirmed write.
- A copied or custom definition cannot be compared: it never restarts anything
  by itself, its latest value is used when an editor or form starts, and a
  changed identity is reported once in the console. Remount (for example with a
  `key`) to apply another custom mapping.

### Lists: useList and LoadNotice

`useList(definition, { type?, retain?, key? })` lists subjects with the loader
of [`useLoad`](#load-states): `state`, `data`, `reload`, `cancel`.

- Render `list.data?.items`: the current rows, or the kept ones while
  reloading or after a failed refresh (`retain` is on by default;
  `retain: false` shows only `loading`).
- `<LoadNotice {...list} />` covers what the rows do not: loading before any
  data, a failed refresh (noting kept rows), a cancelled or unavailable read,
  each with a retry, and entries the definition cannot show (`data.skipped`).
- It reads again after a confirmed creation, row mutation or bound editor save
  or delete on the same target (same Context, connection, subject and
  authorization, through the selected view or a `runtime.bindContext` handle),
  and when the page becomes visible again, so other devices' changes appear.
  It does not poll or subscribe. A cancelled list stays cancelled until
  `reload()`; an equal inline definition or `type` does not restart it.

### Creating: useCreation

`useCreation(definition, { initial, collection, context? })` returns `draft`,
a partial `change`, `create`, `canEdit`, `canCreate`, `outcome`, `notice` and
`refused` (for an unusable [`context`](#creating-in-an-explicit-context)).

- Make `initial` blank; equal inline values are fine. Keep `collection` stable;
  a change of definition or creation address starts a fresh form. Bind inputs to
  `!creation.canEdit` and submit to `!creation.canCreate`, and render
  `<UpdateNotice {...creation.notice} />`.
- A pending or uncertain creation locks the draft (in `change` too). Its
  subject IRI and command stay captured until it settles; nothing is replayed.
  Every sent `create()` resolves with that `iri`, for example to link a second
  creation.
- A confirmed creation, or acknowledging present evidence (`unreadable` counts
  as present), resets only this draft. Observed absence keeps draft and command:
  Create becomes an explicit retry of the same IRI and body with
  `If-None-Match: *`, so a late original write cannot duplicate under a new
  IRI. A retry that finds the resource stays unconfirmed; observing it never
  proves which request wrote it.
- Row updates never clear the creation draft. Its guard survives row
  navigation and asks before a Context, Pod or disconnect change.
- Advanced clients may keep a portable `prepareCreation` command and retry the
  same IRI explicitly.

#### Create at a known IRI

Use exactly one of `collection` or `iri`. For a singleton or an externally
assigned identifier, replace `collection` with the full subject IRI:

```tsx
const creation = useCreation(settings, {
  initial: { title: '' },
  iri: 'urn:example:my-settings',
});
```

This is create-only, with the same draft, notice and retry flow. It never
updates an existing resource; a taken IRI is `unconfirmed` and needs a check.
Use a row update or editor to change an existing resource. A confirmed creation
resets the form, but its next submission still uses that fixed IRI.

Keep the address stable while the person is working. Changing it starts a new
form; retained commands cannot target the new IRI. An unresolved command stays
with its old address and is shown again on returning to it. Forms of the same
address and definition share pending work by default; use `id` for independent
forms. `bindCreation(view, definition, draft, { iri })` offers the same address
choice without React, while the host owns draft and recovery presentation.

#### Several resources from one input

One input can name several resources, for example “Milk, 2 Bananas, Bread”.
Create them one at a time with the same hook, inside `TargetScreen`:

```tsx
const creation = useCreation(item, {
  initial: { title: '' },
  collection: 'items',
});
const [input, setInput] = useState('');

async function addAll() {
  // Settle a pending, uncertain or stopped item in the draft first.
  if (!creation.canEdit || creation.draft.title !== '') return;
  const names = input
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  for (const [index, name] of names.entries()) {
    creation.change({ title: name });
    const outcome = await creation.create();
    if (outcome.kind === 'created') continue;
    // Stop. The item stays in the draft (or may already exist) and never
    // returns to the input; only the unsent rest does. An item not sent
    // because the target ended returns too: its draft ended with it.
    const ended = outcome.kind === 'not-sent' && outcome.reason === 'ended';
    setInput(names.slice(ended ? index : index + 1).join(', '));
    return;
  }
  setInput('');
}
```

`change` applies at once and both actions use the hook's latest state, so the
`create()` after it submits exactly that draft. Start only while `canEdit` is
true and the draft is blank (otherwise `change` is ignored, or a stopped item
is overwritten); keep the input disabled until `addAll` returns; never create
in parallel. Render the draft and its notice like the single-item form.

| Stopping result | What it leaves                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `unconfirmed`   | The item may exist; the draft stays locked until checked (absence enables the retry of the same IRI)                        |
| `not-created`   | Nothing written; the item stays editable and Create resends it under the captured IRI. A taken IRI (`412`) is `unconfirmed` |
| `not-sent`      | Nothing sent; the item stays editable. With reason `ended` the new lifetime starts blank and the item returns to the input  |

Earlier items stay created; later ones were never sent; nothing is retried and
an uncertain item never gets a new IRI. A creation in flight when the target
changed resolves its own outcome but is not shown in the new lifetime. Keep the
input in the same `TargetScreen`, so a target change drops it. Without React,
`await` one `prepareCreation` (with `newSubjectIri`) per item the same way.
Parts for different Contexts use one hook per Context, as the
[task-with-note recipe](../examples/todo/recipes/task-with-note.tsx) does.

### Updating and deleting rows: useFieldUpdate

`useFieldUpdate(definition)` exposes the controller's write state per resource.
Use one hook for the list and give each row `mutate.for(item)`, as the
[TODO example's `TaskRow`](../examples/todo/src/app.tsx) does:

```tsx
const mutate = useFieldUpdate(taskFields); // once, for the list

function TaskRow({ row }: { row: FieldUpdateRow<Task> }) {
  const task = row.data; // what to show
  return (
    <li>
      <input
        type="checkbox"
        checked={task.done}
        disabled={!row.canMutate}
        onChange={() => void row.update({ done: !task.done })}
      />
      {task.title}
      {task.done && (
        <RemoveButton
          label={`Delete: ${task.title}`}
          disabled={!row.canMutate}
          onRemove={row.remove}
        />
      )}
      <UpdateNotice {...row.notice} quiet />
    </li>
  );
}
// <TaskRow key={item.iri} row={mutate.for(item)} />
// below the list: <UnresolvedNotices of={mutate} shown={list.data?.items} />
```

- Pass the original `useList` snapshot, never one rebuilt from plain values: it
  carries what the person saw. A write locks only its row and reports there.
- After a confirmed update `row.data` shows the new values while the list
  reads again; until then the row stays locked (`update` would resolve
  `not-sent`, `stale`).
- One hook for the list, not one per row. The app controller owns the write
  lanes of a target, not the component: a pending or unresolved write keeps
  its outcome and leave guard while its row or whole screen is not rendered,
  hidden (React `<Activity mode="hidden">`) or mounted again, until it is
  resolved or the target changes. `unresolved` lists only unconfirmed or
  conflicting writes, not pending ones; it is not an availability check;
  `<UnresolvedNotices>` shows the notices of those without a row
  (`mutate.for(iri).notice` for one). New commands start only from a mounted,
  shown screen (`not-sent`, `ended` otherwise). All `useCreation` forms of a
  collection or fixed IRI share one creation: while it is pending, unconfirmed or held for
  a same-IRI retry after observed absence, each of them (also one shown again
  or mounted again) shows it, locked, and none sends another. Give forms that
  should create independently side by side an `id` each
  (`useCreation(fields, { initial, collection, id: 'quick-add' })`).
- `RemoveButton` asks with `ResourceEditor`'s delete dialog and calls
  `onRemove`, as it was when asked, only after confirmation (a row read again
  meanwhile shows as a conflict). A quiet trash icon with a 44px target, named
  **Delete** or `label`; children replace the icon, `className` its look.
- The hook returns only `{ for, unresolved }`, like `useContextUpdate`.
  Use `row.canMutate` for each row's availability and `row.notice` for its
  feedback. An IRI-only handle (`mutate.for(iri)`) exposes recovery and always
  has `canMutate: false`, because there is no snapshot to write from.
- Create with `useCreation`; pass `iri` instead of `collection` when its
  identity is already known. Portable raw JSON-LD creation stays in
  `client-sdk/edit.prepareCreation`; its caller owns the UI recovery lifecycle.
- Failures keep `reason` and a structured `problem`: check `problem.status` for
  a refusal, and pass a present `problem.failure` to `describeFailure`.
  Unconfirmed writes carry no failure.

A command that sends nothing resolves `{ kind: 'not-sent', reason }`; nothing
changed, so the draft or row is as before. Never resend on any other result.

| `reason`      | Why nothing was sent                          |
| ------------- | --------------------------------------------- |
| `unavailable` | No write access now, or a guarded change runs |
| `busy`        | This resource's write is pending              |
| `unresolved`  | Its last write needs a check                  |
| `stale`       | The snapshot no longer shows the resource     |
| `invalid`     | A creation draft the definition rejects       |
| `ended`       | The hook unmounted or its target changed      |

A sent command always resolves its outcome, also after a target change.
Neither `useFieldUpdate` nor `useContextUpdate` guarantees stable identities
for row wrappers or commands returned by `for(...)`; do not treat them as stable
effect dependencies. A retained row command keeps its original target and
snapshot and sends nothing once that target or hook lifetime has ended.
`useCreation`'s `change` and `create`, `useList`'s `reload` and `cancel`, and
`useSelection().select` retain their identities for their target and definition
(and creation address/form ID, where applicable).

### Editing a form: useResourceEditor

`useResourceEditor(iri, definition)` manages subscription, access and disposal;
`<ResourceEditor editor={editor}>{(draft, change) => …}</ResourceEditor>`
supplies save, delete, discard and comparison controls around your inputs.

- `change` takes a partial draft for an original `fields()` definition; copied
  or arbitrary definitions keep complete-draft replacement and typing,
  including unions.
- **Delete** asks in a modal dialog (`controls.confirmRemove`, role
  `alertdialog`); only its **Delete** sends one conditional `DELETE` of the
  version shown. Cancel or Escape keeps draft and target; any newer editor state
  withdraws the question. Headless `editor.remove()` stays direct.
- In place (for example in a row) pass `onClose={() => select(null)}`: it shows
  **Cancel** instead of **Discard changes**, Cancel discards and closes, and a
  confirmed save or delete closes it; refusals, conflicts and unconfirmed
  answers keep it open. Escape closes too, but with unsaved changes it first
  asks "Discard unsaved changes?", as closing the row, switching rows or
  Contexts, or an enclosing app dialog's × does. The editor keeps that Escape
  from reaching an enclosing dialog; Escape and Enter inside a nested dialog,
  popover or portal in the fields (a date chooser) belong to it alone and
  neither discard nor save the parent draft.
- `presentation` sets only the frame, never these semantics. `'card'` (the
  default with `onClose`) is the quiet tinted card for a row. `'plain'` has no
  frame, for a routed screen or an app dialog that frames the form already:
  the fieldset's direct children stack 12px apart, SDK-styled inputs keep their
  6px gap below a label text but no trailing margin, and the actions start 24px
  below the last field, also after an app-owned control. Lay out a richer form
  in one app grid as the fieldset's child; no SDK margin reaches into it.
- The app controller owns the editor, not the component: hiding the screen
  (`<Activity mode="hidden">`) or mounting it again keeps its draft, a pending
  save with its outcome, an open review and its leave guard, and the same
  editor comes back. A guarded change asks about unsaved work also while no
  screen shows it. This holds for `useContextEditor`'s editor too.
- Enter in a text field saves when Save is enabled; Delete is the last action.
  A checkbox's or radio's wrapping `<label>` is the 44px target. Labels and
  accessibility of custom fields stay the app's job.
- Feedback applies only to the state it settled on: a newer dirty draft is
  never labelled saved.

### Notices: UpdateNotice

`<UpdateNotice {...notice} />` shows every write outcome with its controls. No
change is optimistic; an unconfirmed write stays visible and is never replayed.

- `quiet` (also on `ResourceEditor`) hides confirmed `saved`, `created` and
  `removed` when the changed row is the confirmation; refusals, conflicts, a
  save beside another change and unconfirmed outcomes still show.
- Its comparison reads the captured subject and shows the observed values or
  absence; acknowledgement is explicit and enabled only by a successful check.
  A present resource the definition cannot read sets `unreadable`. Pass
  `labels={{ title: 'Task' }}` to name fields; values are localized.
- `checked` decides the acknowledgement button; pass it through to a custom
  recovery UI (without it, a caller keeps the state set by its `onCheck`).
- Lost read access clears comparison values, `checked`, `outcome.current` and
  `desiredObserved`; a new check is needed. Lost write access keeps evidence.
  Outcome, locked draft, captured IRI and leave guard always remain.

Creation, row and bound-editor feedback on one target follow one rule: a
success retires when another such write starts (through any handle of the
target) and is not shown if one started while it was pending; a failure stays
until its source acts again; `unconfirmed` and `changed-on-pod` stay until
checked and acknowledged. Client-sdk writes and unbound editors take no part.

### Selection: useSelection

`useSelection<T>()` gives `selected` and a guarded `select(value)`;
`select(null)` closes. Row navigation leaves only editor guards: list writes,
creation drafts and uncertain outcomes stay. Put app-local screen state inside
`TargetScreen` to reset it per target.

### App texts: useMessages

The app's texts follow the provider's language with one catalogue defined
outside components. German is optional; when given it needs every key:

```tsx
const text = {
  en: { add: 'Add', left: (n: number) => `${n} left` },
  de: { add: 'Hinzufügen', left: (n: number) => `${n} offen` },
};

function Composer() {
  const m = useMessages(text);
  return <button>{m.add}</button>;
}
```

Reuse SDK texts where they fit (`useSdkLocale().messages.controls`, for
example `remove`). SDK texts and formats: [messages and language](#messages-and-language).

## Part 3: Contexts

### Choose the app shape

- **One Context:** chosen once in `AppAccess`, or fixed by `preset.contextIri`.
- **Switch Contexts, act in the selected one** (task lists in the header):
  [`useContexts()`](#apps-that-switch-contexts).
- **Read all Contexts, write in one:**
  [Pod overview](#pod-overviews-with-contexts-on-demand) plus `useCreation`
  (selected Context, or a fixed one with `context`).
- **Write into several Contexts** (a shared task with a private note): one
  `useCreation` per Context with `context`, one after the other, as in the
  [task-with-note recipe](../examples/todo/recipes/task-with-note.tsx). There is
  no transaction across Contexts; each part reports its own outcome.
- **Pod overview with edits:** [editing an overview row](#editing-an-overview-row).

### Apps that switch Contexts

```tsx
const lists = useContexts();
// lists.contexts: [{ iri, name, writable }] of the readable Contexts
// lists.selected: the selected one or null
// lists.select(iri): guarded; resolves false when refused or not selectable
// lists.loading / lists.failed / lists.retry(): catalogue state
// lists.canShare / lists.share(): ask the Pod to share more Contexts
// lists.shareProblem: why the last share failed before the Pod, or null
```

- Mount it outside `TargetScreen`, so it can select before a view exists. It
  loads the catalogue in both modes, reads up to 20 labels once and keeps known
  Contexts during a reload. Equal names add the short name ("Tasks · work"),
  then the IRI.
- Without a remembered or preset Context it selects the first writable, else
  the first readable; an exact preset keeps only its Context.
- `select` and `share()` (the Pod's consent page) run under the leave policy.
- While mounted, `AppAccess` shows no chooser (only its loading status until
  the hook selects) and management names only the selected Context. Sign-in,
  recovery, **Change sharing** and **Sign out** stay in `AppAccess`.

The [TODO example](../examples/todo/src/app.tsx) puts the switch in its header,
with a "read only" hint and **Share more lists**.

### Creating in an explicit Context

`useCreation(definition, { initial, collection, context })` binds `context`
with `runtime.bindContext` once startup has settled and demands catalogue
discovery (no selection) to learn its write access. `refused` means the Context
is not on the active connection's Pod, or not an exact preset's; nothing is
created. Draft and pending or uncertain creation survive Context selection and
row navigation (guard scope `explicit`); connection actions ask first. Without
React, `bindCreation(runtime.bindContext(id, context), definition, draft, {
collection })` captures one creation whose `run()` counts as a write on that
Context.

### Pod overviews with Contexts on-demand

Omit `contextSelection` (or use `'required'`) for a Context-based app. For an
overview, opt in on the provider and mount `TargetScreen` only for a Context
flow:

```tsx
<SempodsProvider runtime={runtime} contextSelection="on-demand">
  <AppAccess appName="My overview" />
  <Overview />
  {editing && (
    <TargetScreen>
      <Editor />
    </TargetScreen>
  )}
</SempodsProvider>
```

`Overview` calls `usePodLoad((pod, signal) => pod.sparql.select(query, { signal }))`
or `construct`; `useAppState().pod` is the same active `BoundPod`.

- `usePodLoad` infers the handle and data type and behaves like
  [`useLoad`](#load-states); pass the signal to every read and `key` (or call
  `reload()`) when the query's inputs change. Renders, Context switches and
  label updates do not restart it; Pod or session changes retire the loader.
- Startup, restore, reads and recovery send **zero** catalogue or description
  requests in this mode, also with remembered or preset Contexts. `AppAccess`
  hides for usable Pod access and leaves the overview mounted.
- A Pod `403` is `failed`, without catalogue recovery, until an explicit
  `reload()`; a grant change refreshes only ready results. Reauthorization
  creates a new handle and loader.
- `TargetScreen` demands the active connection's catalogue as soon as it
  mounts, also before login completes. Then `AppAccess` offers the chooser and
  **Check access**; settled catalogues are reused without retry loops. Opening
  management (`open`) demands discovery but no selection. Custom UI uses
  `useApp().refreshContexts(id)` and the guarded `selectContext`.
- `useWorkflowAccess` stays Context-only (false before a validated view).
  Preset or remembered targets are validated on demand; an unreadable exact
  preset never falls back.
- Context names fall back at once to a readable last path segment; only the
  selected Context's label loads automatically. A custom menu asks for others
  with `useApp().loadContextLabels(id, iris)`: up to 20 readable IRIs of a
  ready catalogue (more reject with `RuntimeError` before any request), results
  in `catalogue.labels`, no retry. Narrow an `unknown` catalogue before reading
  labels. Labels never gate reads, selection or drafts.

The [overview recipe](../examples/todo/recipes/pod-overview.tsx) combines a Pod
SELECT, a later Context-bound creation form and editing a row.

For items of one type, `usePodList(definition)` does the reading across
Contexts. The definition needs a `type`:

```tsx
const overview = usePodList(taskFields);
// overview.data?.items: [{ context, snapshot }] from every readable Context
// overview.contexts: [{ context, name, state, problem, retry }] per Context
// overview.complete: false until every Context that holds the type was read
<LoadNotice {...overview} />; // also "1 of 3 lists could not be read" + retry
```

- It asks the Pod once which Contexts hold the type
  (`SELECT DISTINCT ?graph`). It then lists each one the catalogue marks
  readable with `listSubjects`, at most four at a time, so the items are real
  snapshots of their own Context.
- Unlike `usePodLoad`, it demands the catalogue, because readability decides
  which Contexts it reads. The load costs 1 catalogue request, 1 discovery
  query and 1 read per Context.
- A Context that fails, is not readable here (`problem: 'unreadable'`,
  `'discovery-failed'` or `'refused'`) or lost read access does not hide the
  others. Its items leave the list, `complete` turns false, and `LoadNotice`
  names how many are missing, with a retry of just those.
- A confirmed write of this app re-reads its Context. A write anywhere on the
  Pod, such as the first item created in another Context, also runs the
  discovery again. Back in the tab or app, everything reads again. Items other
  apps add to a new Context appear then, or after `reload()`.
- Its rows are changed in one click with
  [`useContextUpdate`](#one-click-overview-rows), or edited in full through
  [editing an overview row](#editing-an-overview-row).

### One-click overview rows

`useContextUpdate(definition)` is to `usePodList` what `useFieldUpdate` is to
`useList`: each row is written in its own Context, from the snapshot the list
read.

```tsx
const list = usePodList(taskFields);
const overview = useContextUpdate(taskFields);
list.data?.items.map((item) => {
  const row = overview.for(item); // { data, context, canMutate, notice, problem, update, remove }
  return (
    <li key={`${item.context} ${item.snapshot.iri}`}>
      <input
        type="checkbox"
        checked={row.data.done}
        disabled={!row.canMutate}
        onChange={(e) => void row.update({ done: e.target.checked })}
      />
      {row.data.title}
      <UpdateNotice {...row.notice} />
    </li>
  );
});
<UnresolvedNotices of={overview} shown={list.data?.items} />;
```

- Row semantics match `useFieldUpdate`: `changed-on-pod`, `unconfirmed` with
  check and acknowledgement, a confirmed update shown at once on a locked
  (spent) snapshot until the list reads again. Nothing is resent.
- Each resource has its own write lane, owned by the app controller per
  Context: rows in several Contexts can be written at once, and an
  unresolved write keeps its notice and leave guard while its row is not
  rendered or the screen is hidden. `unresolved` lists `{ context, iri }`;
  `for({ context, iri })` gives the notice of one whose row is gone.
- The SDK binds each Context, demands the catalogue and knows the write rights;
  the selected Context and its drafts stay as they are. `row.problem` says why
  a Context is not available here, with SDK texts in
  `messages.contextProblems`.
- The guards survive row navigation and Context selection; connection actions
  ask first. Another active connection retires them.

See the [one-click recipe](../examples/todo/recipes/overview-toggle.tsx).

### Editing an overview row

A row is a pointer, not an editable snapshot: its subject and its `GRAPH`
Context. `useContextEditor(definition)` edits it in exactly that Context
through an [explicit binding](browser-runtime.md#bind-an-explicit-context),
without changing the selection, so a creation form elsewhere keeps its draft.

```tsx
function Notes() {
  const edit = useContextEditor(note);
  return (
    <>
      <Overview onEdit={(row) => void edit.open(row)} />
      {edit.target && edit.phase !== 'retired' && (
        <section aria-label="Edit note">
          {edit.problem ? (
            <p role="alert">This note cannot be edited here.</p>
          ) : (
            <ResourceEditor editor={edit.editor}>
              {(draft, change) => (
                <input
                  value={draft.title}
                  onChange={(e) => change({ title: e.target.value })}
                />
              )}
            </ResourceEditor>
          )}
          <button onClick={() => void edit.close()}>Close</button>
        </section>
      )}
    </>
  );
}
```

`Overview` passes `{ subject, context }` from a row's IRI bindings, with the
`GRAPH` binding as `context`.

| `phase`       | Meaning                                                                                                                          |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `idle`        | Nothing opened, or `close()` cleared it                                                                                          |
| `loading`     | Startup, sign-in or the catalogue is not settled; no editor starts before startup settles                                        |
| `unavailable` | `problem` is `unreadable`, `discovery-failed` or `refused` (sends nothing); a later catalogue listing the Context still opens it |
| `ready`       | The editor exists; loading, `404`, offline, blocked access and review are its own states, with its retry                         |
| `retired`     | Another connection became active; never revived, `close()` clears it                                                             |

- `open` needs no `TargetScreen` or selection; it resolves `true` once the
  target is open. `AppAccess` stays hidden while the catalogue loads but shows
  a failure with **Check access**; for `unreadable`, management offers
  **Change sharing**.
- Activation needs a successful catalogue listing the Context as readable,
  also on reopening (after a failed refresh: `discovery-failed`). Afterwards,
  lost access or an ended session keep the draft and any unconfirmed review,
  never attached to another Context, connection or subject.
- It is a `connection`-scoped guard: a Context selection leaves it alone;
  opening another row, `close()` and connection actions ask first, and its
  pending write blocks them.
- Its writes refresh lists and retire success feedback of the same Context's
  selected view, and the other way round.
- A subject in several Contexts gives one row per Context, each with only its
  part: offer "Edit in Home", "Edit in Work"; never merge them.

For a one-click change (ticking a task) use
[`useContextUpdate`](#one-click-overview-rows) instead; `problem` has SDK
texts in `messages.contextProblems`.

### Read arbitrary resources

For resources without a `fields()` definition, use `useLoad(read)` inside
`TargetScreen` with a `ViewRead<T>`: a read-only function
`(view, signal) => Promise<BoundRead<QueryResult<T>>>`, not an OAuth hook. A
`QueryResult` has no `not-found`, so carry absence in the `ok` body:

```tsx
// Fragment: ViewRead from @sempods/app-sdk, JsonLd from @sempods/client-sdk.
/** `null`: no description of `iri` is readable in this Context. */
const resource =
  (iri: string): ViewRead<JsonLd | null> =>
  async (view, signal) => {
    const read = await view.subjects.get(iri, { signal });
    if (read.kind === 'ok') return { kind: 'ok', body: read.body };
    if (read.kind === 'not-found') return { kind: 'ok', body: null };
    return read; // refused, cancelled or invalidated
  };

function Resource({ iri }: { readonly iri: string }) {
  const { state, reload } = useLoad(resource(iri), { key: iri });
  if (state.kind === 'failed')
    return <button onClick={() => void reload()}>Retry</button>;
  if (state.kind !== 'ready') return <p>{state.kind}</p>;
  return state.data ? <pre>{JSON.stringify(state.data)}</pre> : <p>Absent</p>;
}
```

- `key` (a string or number) names the read's inputs: a new value reads again
  without the old data. The latest committed inline `read` is used on every
  (re)load; suspended or abandoned renders never replace the active inputs.
  Reloads from a child layout effect also use that commit's inputs and options.
- A CONSTRUCT needs no wrapping:
  `useLoad((view, signal) => view.sparql.construct(query, { signal }))`.
- `not-found` means absent or hidden in this Context; the two look the same.
- Bodies: [JSON-LD reads](../packages/client-sdk/README.md#json-ld-read-bodies)
  and [Pod SELECT terms](../packages/client-sdk/README.md#reading-across-the-pod).

## Part 4: Customizing

### AppAccess props

| Prop                     | Type                              | Effect                                                                                                                              |
| ------------------------ | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `appName`                | `string` (required)               | The app's name on sign-in and recovery                                                                                              |
| `icon`                   | `ReactNode`                       | Decorative app icon, usually `<img src="/icon.png" alt="" />`                                                                       |
| `description`            | `ReactNode`                       | One line under the name on sign-in only; never sent to the Pod, not a consent purpose or scope                                      |
| `podNames`               | `Record<string, string>`          | Exact canonical Pod URL → display name; the address stays visible, duplicates are disambiguated                                     |
| `podAddress`             | `'visible'` \| `'hidden'`         | `'hidden'` omits the address at sign-in while exactly one Pod is permitted; see [sign-in](#sign-in-and-pod-addresses)               |
| `open`                   | `boolean`                         | Host-owned **Pods & sharing** management; never starts a login, demands discovery in on-demand mode                                 |
| `onClose`                | `() => void`                      | Management as a modal dialog; Escape, **Close** and a click beside it call this to reset `open`. Without it, management is in place |
| `focusTarget`            | `RefObject<HTMLElement \| null>`  | Focus returns here when the focused surface hides after its guarded transition (not for visible retry or error feedback)            |
| `mode`                   | `'single'` \| `'multiple'`        | `'single'` hides adding another Pod once one is selected; presentation only, enforce with runtime `allowedPods`                     |
| `headingLevel`           | `1` \| `2`                        | Default: `h1` for first sign-in, `h2` for recovery and management. Use `2` under a host title                                       |
| `components.Connections` | `ComponentType<ConnectionsProps>` | Replaces the connection view; see [replacing it](#replacing-the-connection-view)                                                    |
| `className`, `style`     | `string`, `CSSProperties`         | Root styling, for example `--sempods-*` tokens                                                                                      |

### What AppAccess shows

- **Startup:** loading; unavailable session storage blocks controls with a
  reload notice (no in-memory fallback); a second-tab notice.
- **After a returning sign-in:** the callback notice, also after a failed or
  cancelled sign-in (its connection becomes active), naming the cause beside
  **Sign in** and **Sign out**; `login_required` has its own message. It stays
  until a connection is selected or signed out or a sign-in starts
  (`AppSnapshot.callbackNotice`).
- **Restoring or loading the first demanded catalogue:** a loading status, with
  the Pod selector and a configured Pod's sign-in beside it, so a load that
  never settles cannot block switching or signing in; a preset or remembered
  Context never flashes the connection view. A custom `components.Connections`
  is replaced by the status alone.
- **A decision or `open`:** the connection view, for an ended session, missing
  required scopes, a Context choice, a failed catalogue. It lists readable
  Contexts only and says so when there are none. A sign-in that never returned
  or expired asks to sign in, without claiming access.
- **Pod unreachable at startup:** `controls.unreachable` with **Try again**
  (`useApp().retryRestore(id)`); it also restores when back online.
- **Sign-out not saved:** `controls.disconnectFailed` beside **Sign out** (see
  [draft lifetime](#selection-and-draft-lifetime)).

Catalogue failures stay visible even when earlier access facts are kept.

### Pods & sharing management

The app puts a **Pods & sharing** button (`controls.dataAccess`) in its own
menu or header:

```tsx
function AppContent() {
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  const { connections } = useAppState();
  const { messages } = useSdkLocale();
  return (
    <>
      {connections.length > 0 && (
        <button ref={target} onClick={() => setOpen(true)}>
          {messages.controls.dataAccess}
        </button>
      )}
      <AppAccess
        appName="My tasks"
        open={open}
        onClose={() => setOpen(false)}
        focusTarget={target}
        icon={<img src="/icon.png" alt="" />}
        podNames={{ 'https://pods.example/alice': 'Personal' }}
      />
      <TargetScreen>
        <TaskScreen />
      </TargetScreen>
    </>
  );
}
```

- As a dialog (`onClose`) the app behind it is inert, a leave confirmation
  opens above it, and opening re-checks access (no **Check access**). Sign-in
  and recovery stay inline. Up to 30rem wide it is a bottom sheet across the
  screen's width, as small-screen app dialogs usually are; wider, it is centred.
- It shows the Pod, then the Context and this app's access (**Read only** or
  **Read and write**); several Contexts appear in the **Data context** chooser
  (only in `'required'` mode or while a Context flow needs a selection),
  otherwise **Available to this app** lists them. Then **Change sharing**,
  **Sign out** with its this-device note (`controls.disconnectHint`; empty
  hides it), and last a collapsed **Connect another Pod** (`mode="multiple"`).
- These are the catalogue's rights for this session, not whether a Context is
  shared or public; changing them is the Pod's consent behind **Change
  sharing**. It sends one catalogue request and no extra label reads.

### Sign-in and Pod addresses

- One `allowedPods` entry or a preset needs no URL input; several get a finite
  picker (choosing does not sign in); unrestricted apps show a **Pod address**
  field. With a connection, adding another Pod is secondary.
- Input may omit `https://`; surrounding whitespace and one trailing slash are
  removed, other noncanonical input is rejected. Configured URLs must be
  canonical. Enter `http://127.0.0.1:…` explicitly for local HTTP.
- `controls.podHint` and `controls.loginHint` are empty by default.
- No silent auth or automatic redirect; login and consent use the Pod's UI.
- `podAddress="hidden"` works only while exactly one Pod is permitted, also
  when signing in again. A `podNames` name remains; without one no Pod line
  shows and duplicate saved connections are numbered. With several or
  unrestricted Pods (including a preset without `allowedPods`) the address
  stays, as does management's and **Full addresses**. A custom
  `components.Connections` does not receive it; CSS on SDK markup is no stable
  way to hide it.

### One known Pod

Put the preset in the runtime and keep the same screen code:

```tsx
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
  preset: { podUrl: 'https://pods.example/alice' },
  allowedPods: ['https://pods.example/alice'], // enforces it; lets podAddress hide
});
// <AppAccess appName="My tasks" headingLevel={2} mode="single"
//   podAddress="hidden" open={open} focusTarget={focusTarget} />
```

- The first visit offers **Sign in** without an address field; after consent
  the person chooses a Context. A header **Pods & sharing** button keeps sign
  out, sharing and Context choice reachable once `AppAccess` hides.
- The preset is a default, not an allowlist: with `mode="multiple"` other Pods
  stay possible unless `allowedPods` restricts them, which the runtime also
  enforces on restore and callbacks ([permitted Pods](browser-runtime.md#restrict-the-permitted-pods)).
- `preset.contextIri` fixes an exact Context: the SDK waits for fresh readable
  catalogue evidence, shows it instead of a picker and never falls back.
  Missing scopes, failed loads and an unreadable Context keep distinct feedback.
- Custom controls read `useAppState().preset`/`allowedPods` and call
  `useApp().connect()` without an argument for the preset or sole allowed Pod
  (pass a URL otherwise), following the
  [custom-control rules](#custom-layouts-without-appaccess). Feature
  requirements go through the runtime-wide `scopes` option.

[One known Pod](browser-runtime.md#one-known-pod) in the runtime guide covers
validation, precedence, reload and foreign sessions.

### Shared SDK appearance

`AppAccess`, `ResourceEditor`, `UpdateNotice`, `AccessNotice` and
`CallbackNotice` share a scoped baseline: light and dark, 44px targets, visible
focus, wrapping comparisons; no stylesheet import or UI framework. The app's
own header, rows and controls stay unstyled. `ResourceEditor` styles its fields
and actions; in place it is a quiet tinted card, or unframed with
`presentation="plain"`. `RemoveButton` brings its own
icon look. Notices and editors are transparent; `AppAccess` keeps its themed
background.

The host owns the colour scheme. A page without one stays light, so enable dark
appearance in the app's CSS and keep page colours compatible (`light-dark()`):

```css
:root {
  color-scheme: light dark;
}
```

Theme with `--sempods-bg`, `--sempods-text`, `--sempods-muted`, `--sempods-line`,
`--sempods-accent` (controls; the default is neutral grey) and
`--sempods-on-accent`, on an ancestor or a component's `style`/`className`.
`--sempods-font` sets the font family (default `system-ui, sans-serif`) and
`--sempods-radius` the corner radius of controls (default `8px`); cards and
dialogs use 1.5 times it, `0` makes every SDK surface square.
React 19 [hoists the scoped sheets](https://react.dev/reference/react-dom/components/style);
they need a CSP that allows inline styles, otherwise build presentation from
the public hooks.

### Replacing the connection view

`components={{ Connections: MyPicker }}` replaces the connection view and keeps
startup and callback presentation. It receives `ConnectionsProps` (`mode`,
`podNames`) and uses `useConnections`, `useAppState` and guarded `useApp()`
actions, never raw runtime selection. The **Pods & sharing** button opens it;
access loss and toggling keep mounted content and drafts.

### Messages and language

| Provider prop | Controls                                       |
| ------------- | ---------------------------------------------- |
| `language`    | EN/DE messages; alone keeps English formatting |
| `locale`      | Formatting; alone it also picks the messages   |
| `timeZone`    | Displayed times                                |
| `direction`   | Text direction                                 |
| `messages`    | Partial overrides of `controls` and `errors`   |

- Without `language` and `locale` the provider reads `navigator.languages` once
  and uses the first German or English preference (else the first valid, else
  `en`). Pin English with `language="en" locale="en"`. Outside a browser pass
  preferences to `resolveLocale(undefined, languages)`.
- `messages={{ controls: { save: translate('save') } }}` or
  `messages={{ errors: { catalogue: () => '…' } }}` override single texts and
  retranslate in place; other codes keep defaults, so new SDK codes need no
  change.
- RDF text language comes from the field definitions; the UI language never
  changes the RDF slot being edited.
- Headless: `createLocale(options).error(cause)` and
  `describeFailure(errors, reason)` (a complete `FailureMessages`, a structured
  `SdkFailure`) from `@sempods/app-sdk` give failure text without diagnostics.

### Dialogs and accessibility

The leave confirmation is a native modal `<dialog>` (role `alertdialog`) with
focus, Escape and focus restoration, in the top layer above an app's own
`showModal()` dialog, which becomes inert. Editors and an inline `AppAccess`
may live in an app modal under the same provider; keep it mounted while a
confirmation is pending.

### Custom layouts without AppAccess

Keep the provider and compose `CallbackNotice`, `AccessNotice` and own controls
from the guarded `useApp()` actions.

- Call actions only from user input. Disable controls until startup storage is
  durable and while `changing`, `confirmingLeave` or a restore is pending; show
  errors with `useSdkLocale().error`. `false` means the leave policy declined
  (a sign-in it cancelled is not an error).
- Keep startup feedback and `CallbackNotice` outside the content gate. A failed
  or cancelled callback activates its connection; use `callbackNotice` to tell
  whether a `startup.interaction` outcome is current.
- A restoring connection waits; a `leaving` one (navigating to the Pod)
  stays inert without a sign-in. `active` and `renewing` are authentication,
  not Context access. A cancelled re-authorization keeps the session
  (`startup.resumed`); an unreachable Pod at startup is `ended` with
  `restorable: true`: offer `retryRestore(id)`.
- `access_denied` cannot tell cancel from decline and its
  `error_description` is never shown: the notice says no access was granted
  (`controls.signInCancelled`) with **Sign in**, or after a declined
  re-authorization that sharing is unchanged (`controls.sharingUnchanged`) with
  **Change sharing**.
- Select a readable Context explicitly; reloads reselect the last one while
  readable. Catalogue refresh and authorization never retry a write. A busy
  startup offers reload guidance, not a fake restart. Saved-record warnings do
  not hide healthy connections.
- Keep content mounted through same-target access loss (hide or make inert),
  keep notices outside the hidden part and move focus to the access feedback.
  Hiding neither cancels code nor authorizes requests. `AccessNotice` keeps an
  empty catalogue, no selection and read-only distinct. The widgets example's
  `AccessPanel` shows this.

### Several widgets in one host

The [widget guide](widgets.md) composes a list and a quick-add form under one
host runtime and provider, without `AppAccess` in every widget.

## Part 5: Reference

### Load states

`useLoad`, `usePodLoad` and `useList` return `state`: `loading`, `ready`,
`unavailable`, `cancelled` or `failed`. Failed is not empty.

| The read settles with                                          | `LoadState`                                                              |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ok`                                                           | `ready`; `data` is the body                                              |
| `cancelled`                                                    | `cancelled` until `reload()`                                             |
| `invalidated`, or read access lost or target changed meanwhile | `unavailable`, after one retry while the target stays readable           |
| `refused` (`401` or `403`)                                     | `failed`; `error` is the result, e.g. `{ kind: 'refused', status: 403 }` |
| another kind (an unwrapped `not-found` is a type error)        | `failed`; `error` is the result                                          |
| a thrown error, such as an `SdkError`                          | `failed`; `error` is the thrown value                                    |

- `reload()` starts a new cycle, `cancel()` stops one; late results are
  ignored even if a reader ignores abort. A new target starts a new loader;
  old ones never restart. Write-only loss keeps data; read loss removes it.
- Before a Context read reports `403` the runtime
  [reloads the catalogue](browser-runtime.md#subscribe-and-bind): no longer
  readable gives `unavailable`, otherwise `failed`. An unrenewable `401` is
  `failed`. Nothing repeats a refusal; offer `reload()`. `sdkFailure(error)`
  from `@sempods/client-sdk` gives an `SdkError`'s reason. A guard stop arrives
  as `invalidated`.
- With `retain` a reload shows `{ kind: 'loading', previous }` and a failed
  refresh `{ kind: 'failed', error, previous }` (unconfirmed by that read).
  Retained data is only what a read returned; another connection,
  authorization, Context, definition or `key`, lost read access, changed grants
  and `cancel()` drop it.

### Selection and draft lifetime

`useApp()` has the guarded `selectConnection`, `selectContext`, `connect`,
`authorize`, `disconnect` and `navigate(action)`, plus unguarded
`refreshContexts(id)`, `loadContextLabels(id, iris)` and `retryRestore(id)`.
Read state with `useAppState`, `useConnections` and `useView`.
`useDraftGuard(dirty, discard, scope?)` registers your own draft:

| Scope                | Use for                                                    |
| -------------------- | ---------------------------------------------------------- |
| `'target'` (default) | A draft that survives row navigation                       |
| `'local'`            | A draft that row navigation leaves                         |
| `'connection'`       | A draft at an explicit Context (`bindContext`)             |
| `'explicit'`         | A creation at an explicit Context; only connection changes |

| Change                                                   | Leaves (asks, then discards)                  |
| -------------------------------------------------------- | --------------------------------------------- |
| Row navigation (`navigate`, `useSelection().select`)     | `local` (or unscoped) and `connection` guards |
| Context selection (`selectContext`)                      | `local` (or unscoped) and `target` guards     |
| `selectConnection`, `connect`, `authorize`, `disconnect` | every guard                                   |

- A pending write blocks every change, except that a saving `connection` or
  `explicit` draft does not block a Context selection. A confirmation names
  unconfirmed writes it leaves and warns that discarding does not undo them.
- A declined change discards nothing; the target stays when its replacement is
  gone. A prompt whose connection stops being active (a returning sign-in, a
  removal) is cancelled: the action resolves `false`, nothing runs.
- Content is inert during confirmation and action preparation. The policy
  does not cover browser close or reload, or direct runtime calls.
- Until startup settles there is no Context view: `TargetScreen` renders
  nothing, while Pod reads work. Hooks outside it, such as `useCreation`, reset
  their draft when a view appears; disable their inputs while
  `useWorkflowAccess().write` is false.
- A confirmed target change discards editor state and aborts reads (A → B → A
  is fresh). Same-target refresh, access or locale changes keep drafts. Read
  loss clears the server baseline, not the draft; a failed catalogue check
  keeps the last accepted facts and the editor beside its feedback.
- `disconnect(id)` resolves `true` when it ran, not when sign-out was saved. If
  saving failed the connection keeps an ended session with
  `problem: 'disconnected', saved: false`; offer a retry (custom sign-out
  controls carry the advice, `AccessNotice` does not), and do not suggest
  reloading, which may restore it.

`useWorkflowAccess()` gives read, write and catalogue facts and each requested
feature scope's required/optional and granted/missing/unknown status, for the
Context only. Missing optional features keep the session; nothing is inferred
from an absent grant, and the server decides each operation.

### Without React

- A `BoundView` has an immutable `getSnapshot()` (`current`, `read`, `write`,
  `catalogue`, `revision`; no credentials) and `subscribe(listener)`, which
  sends changes, not an initial call. An invalid view never revives; get the
  next one from the runtime.
- `createAppController(runtime, options?)` gives the same guarded policy;
  `start()` and `stop()` it. `register` guards (default `scope: 'local'`; the other
  scopes as in the tables above) and `unconfirmed()` for pending write-outcome
  evidence.
  Block input while `changing` or `confirmingLeave`; close a custom prompt
  whenever `confirmingLeave` turns false. `view` is `null` until `startup` or
  `startupError` is set.
- The snapshot's `pod` is the active `BoundPod` for
  [direct Pod reads](browser-runtime.md#read-the-authorized-pod-dataset). With
  `{ contextSelection: 'on-demand' }` call `runtime.loadContexts(id)` for a
  Context flow.
- `createViewLoader(view | pod, read)` and
  `bindResourceEditor(view, iri, definition)` behave like their hooks (no
  fallback from Context to Pod reads). A loader starts on `reload()`; dispose
  both on a target change. `bindCreation` and `prepareCreation` capture
  creations.
- Subscriber exceptions are reported asynchronously, isolated from other
  subscribers and settlement; `editor.loaded` still settles.
