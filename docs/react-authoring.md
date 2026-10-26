# React and headless authoring

Create one browser runtime outside render and pass it to one `SempodsProvider`.
The provider consumes `runtime.initialize()`; it does not create a second session
coordinator. Equivalent inline locale/message props do not replace the runtime or
editor. Changing the runtime object is an explicit application lifetime change;
keep it stable. Keep `contextSelection` fixed for the provider's lifetime too:
changing it replaces the controller and cancels a pending leave confirmation;
it is not a guarded mode switch. The caller owns `runtime.dispose()` at application shutdown.

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

<SempodsProvider runtime={runtime} language="de" locale="de-CH">
  <AppAccess appName="My tasks" />
  <TargetScreen>
    <TaskScreen />
  </TargetScreen>
</SempodsProvider>;
```

Serve the same application at the redirect path. Startup processes its callback
and restores other connections independently. After a completed callback, its
connection becomes active; context selection stays explicit. Context screens
appear only once startup settles; see
[selection and draft lifetime](#selection-and-draft-lifetime). The startup report
exposes `connectionId` for headless hosts. Screens never handle callbacks,
credentials, ETags or authentication recovery. See [browser runtime](browser-runtime.md)
for deployment identity, persisted sessions and the one-active-tab contract.
`AppAccess` is the default composition for new apps: a centered sign-in and
recovery surface beside your content, with no outer frame or persistent header.
It shows:

- startup loading, unavailable session storage (controls stay blocked with a
  reload notice; there is no in-memory session fallback) and a localized
  second-tab notice;
- the callback notice after a returning sign-in. Its connection becomes active
  even when the sign-in failed or was cancelled, so the notice names the cause
  next to its **Sign in** and **Sign out** buttons; provider answers such as
  `login_required` get their own EN/DE message. It stays until the person selects
  another connection, signs out of one or starts a sign-in
  (`AppSnapshot.callbackNotice`; `startup` is never rewritten);
- a loading status while the active connection restores, waits for its Pod
  reader or loads its first demanded Context catalogue (in `'required'` mode or
  under a mounted `TargetScreen`). Where they apply, the active-Pod selector and
  the sign-in for a configured Pod stay beside it, so a load that never settles
  cannot block switching Pods or signing in, and a preset or remembered Context
  that settles the target never flashes the connection view. Nothing there
  cancels such a load; the host's `open` still reaches every connection action.
  A custom `components.Connections` is replaced by the loading status alone;
- the connection view, with addresses and actions, when something needs a
  decision (an ended session, missing required scopes, a Context choice after
  the catalogue loaded, a failed catalogue) or when the host passes `open`. Once
  a catalogue has settled, a reload (**Check access**, revalidation) keeps it. A
  connection whose sign-in never returned, or whose session expired, asks to
  sign in without claiming access or a kept draft. A saved session whose Pod
  could not be reached at startup instead says so (`controls.unreachable`) and
  offers **Try again** (`useApp().retryRestore(id)`), not a sign-in; it also
  restores by itself once the browser is back online. The context picker lists
  readable contexts only and says so when the Pod grants none.

It hides once the selected target is readable, including read-only access;
catalogue failures stay visible even if the runtime retains previous access
facts. Fully custom layouts remain supported; those that omit `AppAccess` place
`CallbackNotice` themselves (see
[custom layouts](#custom-layouts-without-appaccess)).

## Login without an app frame

An optional `icon` is app-owned JSX, usually `<img src="/icon.png" alt="" />`.
No icon is required. An optional `description` (for example
`description="Shopping made easy"`) appears under the app name on the sign-in
screen, not in management. It is display text only: it is never sent to the Pod
and is not a consent purpose or a scope. `podNames` maps exact canonical Pod
URLs to display names; the destination remains visible, and duplicate names are
disambiguated.

When the runtime permits exactly one Pod (`allowedPods` with one entry),
`podAddress="hidden"` omits that Pod's address from signing in, including
signing in again after an ended session. A `podNames` name remains; without one,
no Pod line is shown, and the **Active pod** selector numbers saved duplicate
connections instead. The app's configuration then fixes the destination, the
person cannot choose another Pod, and the Pod's provider shows its own login
page and address. With several or
unrestricted Pods, including a preset without `allowedPods`, the address stays
visible, because there the person chooses or must recognize the destination.
Management (`open`) and, outside management, **Full addresses** always show it, and a custom
`components.Connections` does not receive the option. The default is
`'visible'`; SDK markup is not a stable hook for hiding the address with CSS.

`AppAccess` prefers the Context label from the runtime's
selected-Context description reads, falling back to a safe readable last path segment.
An `unknown` catalogue carries no labels, so narrow it before reading one:

```ts
const labels =
  connection.catalogue.kind !== 'unknown'
    ? connection.catalogue.labels
    : undefined;
const label = labels?.[iri];
```

Only the selected, validated Context is fetched automatically; other entries use
the fallback immediately, including on small Pods. An app reads more labels
explicitly with [`loadContextLabels`](#pod-overviews-with-contexts-on-demand).
Duplicate context names include the full IRI; outside management, **Full
addresses** exposes all readable context identities. Names never replace Pod/context identity, unless `podAddress`
hides the address of the one permitted Pod; displaying them
starts no additional requests. Late or refreshed labels do not change selection
or discard drafts.

One `allowedPods` entry or a preset needs no URL input. Several permitted Pods
get a finite picker; selecting an option does not start sign-in. When a connection
already exists, adding another Pod is a secondary action; signing into the current
connection remains prominent when needed. Unrestricted
apps show a **Pod address** field: the person's own Pod or one that shares a
context with them. `controls.podHint` and `controls.loginHint` are empty by
default, so no hint lines appear; an app may set them. The input may omit `https://`; presentation
adds it, trims surrounding whitespace and removes one trailing slash before
calling the runtime. Other noncanonical input remains rejected; configured Pod
URLs still require the strict canonical form.
For local HTTP development enter `http://127.0.0.1:…` explicitly. There is no silent
auth or automatic redirect. Login/consent on the Pod retains the Pod's own UI.

The initial login uses an `h1`; recovery with an existing target and explicitly
opened management use an `h2`, below the app’s own main heading.

The app may put a **Pods & sharing** button (`controls.dataAccess`) in its own menu or header. `open` shows
management. With `onClose` as well, management opens as a native modal dialog
titled **Pods & sharing**: the app behind it is inert, a leave confirmation still
opens above it, and Escape, the **Close** button (`controls.close`) and a click
beside it call `onClose`, which sets `open` back to false. Opening the dialog
checks the access again, so it shows no **Check access**. Sign-in and recovery
stay inline, as the main content. Without `onClose`, management renders in place.
In on-demand mode, opening it also demands Context discovery. Pod/context changes still run
through the same leave guards.

Management shows the connected Pod first: its name, then the Context and what
this app may do there (**Read only** or **Read and write**), set off below
the Pod: one readable, selected Context by name, several in the **Data
context** chooser with the chosen one's access beside it. Without a selection
(on-demand management) **Available to this app** lists each readable Context
with its access. Then come **Change sharing** and **Sign out** with the note that
signing out applies only to this device (`controls.disconnectHint`; an empty
string hides it). Signing in to another Pod comes last, as a collapsed
**Connect another Pod** (`mode="multiple"` only). The access facts are
the catalogue's rights for this app's session: they do not say whether a Context
was shared in this consent or is public, and changing them is the Pod's consent
step behind **Change sharing**, not an edit in the app. Management lists the
Contexts without asking for a selection: the **Data context** chooser appears only
in `'required'` mode or while a Context flow such as `TargetScreen` needs a
selected Context. It sends one catalogue request and reads no per-Context labels
beyond the selected one. Supply `focusTarget` to return focus once the focused
access surface hides and its guarded transition ends. Visible retry or error
feedback does not trigger this focus return. For example, inside the provider:

```tsx
function AppContent() {
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  const { connections } = useAppState();
  const { messages } = useSdkLocale();
  return (
    <>
      {connections.length > 0 && (
        <button
          ref={target}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
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

Import `useState`/`useRef` from React and the other names from
`@sempods/app-sdk/react`. The [TODO source](../examples/todo/src/app.tsx) is a complete
example. `AppAccess` takes no content children and does not gate/unmount your
screen: keep `TargetScreen` and mutation controllers mounted through same-target
access loss. Keep uncertain-write recovery outside hidden/inert widget regions.
Read-only content remains useful; use `AccessNotice` where a write limitation
needs explanation and operation eligibility to disable edits.

### Shared SDK appearance

`AppAccess`, `ResourceEditor`, `UpdateNotice`, `AccessNotice` and
`CallbackNotice` share a scoped baseline: light/dark appearance, 44px touch
targets, visible keyboard focus and wrapping comparisons. No stylesheet import or
UI framework is required. The SDK does not style the app's own header, list rows
or controls. ResourceEditor styles the fields rendered inside that editor as well
as its review/actions.

The host owns the color scheme; SDK surfaces inherit it. A page without a scheme
stays light even when the system prefers dark. Enable page-wide automatic dark
appearance in the app's CSS:

```css
:root {
  color-scheme: light dark;
}
```

Keep any explicit page backgrounds/text colors compatible with that choice
(for example with `light-dark()`). Embedded notices and editors have
transparent surfaces; their fields/buttons use the shared tokens. AppAccess
retains its themed background.

Set `--sempods-bg`, `--sempods-text`, `--sempods-muted`, `--sempods-line`,
`--sempods-accent` and `--sempods-on-accent` on an ancestor or on the component's
`style`/`className` where supported. They inherit across SDK components.
Without them the SDK uses a neutral grey palette (0.5.0 and earlier used a green
accent); set `--sempods-accent` to give controls your brand colour.
React 19 hoists and deduplicates the static scoped sheets using its
[`style` resource support](https://react.dev/reference/react-dom/components/style).
Inline scoped styles still require a compatible CSP. Hosts that prohibit them can
compose their own presentation using the public hooks.

`components={{ Connections: YourControls }}` replaces access controls while
retaining startup/callback presentation. All actions must still use `useApp()`.
`mode="single"` hides adding another Pod once selected; it is a presentation choice,
not a restriction. Use runtime `allowedPods` to enforce the permitted Pods.
When a host already provides its title, use `headingLevel={2}` for subordinate
access headings.

## A screen

See the runnable [TODO screen](../examples/todo/src/app.tsx) and its shared
[domain functions](../examples/todo/src/domain.ts). A field definition describes
RDF terms once; it works with form editing, list actions and the Node consumer.
`useResourceEditor(iri, definition)` manages subscription, access and disposal.
`ResourceEditor` supplies save/delete/discard and comparison controls; its child
renders only a draft and calls `change({ title })` for an original `fields()` definition.
**Delete** asks first in a modal dialog (`controls.confirmRemove`, role
`alertdialog`, like the leave confirmation); only its **Delete** sends one
conditional `DELETE` of the version shown. Cancel or Escape keeps the
draft and the target, and any newer editor state (an edit, a read that adopts a
newer version, lost write access, another subject) withdraws the question.
The headless `editor.remove()` stays direct. A checkbox or radio inside the
editor is a compact control; its wrapping `<label>` is the 44px target.
Copied or arbitrary definitions retain complete-draft replacement and typing, including unions. Feedback applies only to the
editor state on which the operation settled; a newer dirty draft is never labelled
saved. For an editor bound to its target (`useResourceEditor`), a success also
retires when another creation, row mutation or editor write starts on that target.
Pass `quiet` to `UpdateNotice` or `ResourceEditor` when the changed row is the
confirmation: a confirmed `saved`, `created` or `removed` then shows nothing,
while refusals, conflicts, a save beside another change and unconfirmed
outcomes still show with their controls. The SDK applies no optimistic changes;
an unconfirmed write stays visible and is never replayed. Comparisons in `ResourceEditor` and `UpdateNotice` show localized values
(yes/no for flags, a dash for empty text); pass `labels={{ title: 'Task' }}` to
name the fields instead of showing their keys.
An editor that opens in place, for example in a list row, takes `onClose`
(the guarded reset, `onClose={() => select(null)}`). It then shows **Cancel**
instead of **Discard changes**: Cancel or Escape discards and closes, as that
click is the decision (switching rows or Contexts still asks). A confirmed save
or delete closes it too, so the changed row is the confirmation; refusals,
conflicts and unconfirmed answers keep it open with their controls. In any
editor, Enter in a text field saves when Save is enabled, and Delete is the
last action.

A `fields()` definition may be written inline: hooks compare it by structure, so
an equal definition on every render changes nothing, while a real change (another
type, language or predicate) starts a new editor, list read or form. Equal
`fields()` definitions share one instance across the hooks, so list snapshots
work with `useFieldUpdate` even when the definition is written inline. A copied or
custom definition cannot be compared; it never restarts anything on its own (an
inline one would otherwise loop), its latest value is used when an editor or form
starts, and a changed identity is reported once in the console. Remount (for
example with a `key`) to apply a different custom mapping. When a real definition
change discards an unsaved draft or a pending or unconfirmed write, the console
says so.

`useLoad(read)` accepts `ViewRead<T>`, a read-only domain function `(view, signal) =>
Promise<BoundRead<QueryResult<T>>>`. It can combine a query and cancellable
read-only domain checks; it is not an OAuth hook. Pass the signal to each read.
States are `loading`, `ready`, `unavailable`, `cancelled` or `failed`; failed data
is not an empty result. `reload()` starts an explicit new cycle; `cancel()` stops
a cycle. Late results are ignored even when a custom reader ignores abort.
The latest `read` is used for every (re)load, so an inline function is fine; a
new target starts a new loader, and `reload()` applies a changed read at once.
Recovery can retry an invalidated read once within the same target lifetime.
Repeated invalidation settles unavailable; target switch/disconnect/cancellation
never restarts an old loader. Write-only access loss keeps displayed read data;
read loss removes it.

## Read arbitrary resources

An explorer or search view reads resources that have no `fields()` definition.
Inside `TargetScreen`, use `useLoad` with the view's raw reads. A `ViewRead` must
settle with a `QueryResult`, which has no `not-found`, so carry an absent
resource inside the `ok` body:

```tsx
import type { ViewRead } from '@sempods/app-sdk';
import { useLoad } from '@sempods/app-sdk/react';
import type { JsonLd } from '@sempods/client-sdk';

/** `null`: no description of `iri` is readable in this Context. */
const resource =
  (iri: string): ViewRead<JsonLd | null> =>
  async (view, signal) => {
    const read = await view.subjects.get(iri, { signal });
    if (read.kind === 'ok') return { kind: 'ok', body: read.body };
    if (read.kind === 'not-found') return { kind: 'ok', body: null };
    return read; // refused, cancelled or invalidated
  };

export function Resource({ iri }: { readonly iri: string }) {
  const { state, reload } = useLoad(resource(iri));
  if (state.kind === 'ready')
    return state.data ? (
      <pre>{JSON.stringify(state.data, null, 2)}</pre>
    ) : (
      <p>Not found in this Context.</p>
    );
  if (state.kind === 'failed')
    return <button onClick={() => void reload()}>Retry</button>;
  return <p>{state.kind}</p>;
}
```

Render it as `<Resource key={iri} iri={iri} />`, or call `reload()` after the
IRI changes. A CONSTRUCT needs no wrapping:
`useLoad((view, signal) => view.sparql.construct(query, { signal }))` is ready
with the node array. `not-found` means absent or hidden in this Context; the
two look the same.

The loader turns each settled read into one state:

| The read settles with                                                       | `LoadState`                                                                              |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ok`                                                                        | `ready`; `data` is the body                                                              |
| `cancelled`                                                                 | `cancelled` until `reload()`                                                             |
| `invalidated`, or the view lost read access or changed while the read ran   | `unavailable`; one retry while the same target stays readable, then it stays unavailable |
| `refused` (`401` or `403`)                                                  | `failed`; `error` is the result, such as `{ kind: 'refused', status: 403 }`              |
| another kind, such as an unwrapped `not-found` (a type error in `ViewRead`) | `failed`; `error` is the result                                                          |
| a thrown error, such as an `SdkError` for a network failure or bad answer   | `failed`; `error` is the thrown value                                                    |

A refusal is `failed`, not `unavailable`. Before a Context read reports a `403`,
the runtime [reloads the catalogue](browser-runtime.md#subscribe-and-bind). If
the Context is no longer readable there, the view loses read access and the
loader shows `unavailable` instead. If it is still listed, or the reload fails,
the refusal stays `failed`. A `401` the session could not renew is `failed`
too. Nothing repeats a refusal on its own; offer `reload()`. `sdkFailure(error)` from `@sempods/client-sdk` gives a
thrown `SdkError`'s reason. A guard stop never reaches the read as `stopped`:
the runtime reports it as `invalidated`. `usePodLoad` maps Pod results the same
way, without the catalogue check (see below).

The [client README](../packages/client-sdk/README.md#json-ld-read-bodies)
describes the bodies: a single node from `subjects.get`, CONSTRUCT node arrays,
blank nodes, types and literals with a language or datatype. Pod SELECT rows
use their own [term shapes](../packages/client-sdk/README.md#reading-across-the-pod).

## Apps that switch Contexts

Decide first which Contexts the app works with:

- **One Context:** chosen once in `AppAccess`, or fixed by `preset.contextIri`.
  `TargetScreen` and the list, creation and editor hooks work on it.
- **Several Contexts, acting in the selected one,** for example task lists or
  shopping lists switched in the app's header: use `useContexts()`.
- **Reading all Contexts, writing in one:** see
  [Pod overviews](#pod-overviews-with-contexts-on-demand); `useCreation` writes
  into the selected Context, or into a fixed one with `context`.
- **Writing into several Contexts,** for example a shared task with a private
  note: one `useCreation` per Context with `context`, created one after the
  other, as the
  [task-with-note recipe](../examples/todo/recipes/task-with-note.tsx) shows.
  There is no transaction across Contexts: each part reports its own outcome.

`useContexts()` gives an app-owned switch what it needs:

```tsx
const lists = useContexts();
// lists.contexts: [{ iri, name, writable }] of the readable Contexts
// lists.selected: the selected one or null
// lists.select(iri): guarded; resolves false when refused or not selectable
// lists.loading / lists.failed / lists.retry(): catalogue state
```

It loads the catalogue in both `contextSelection` modes, reads the labels of
up to 20 Contexts once, and keeps known Contexts during a reload. Names follow
the labels; equal labels add the short name ("Tasks · work"), and still equal
ones the IRI. Without a remembered or preset Context it selects one itself,
the first writable, else the first readable. An exact preset keeps only its
Context. `select` runs under the leave policy, so a dirty draft asks first.
Mount it outside `TargetScreen`, so it can select before a view exists.

While it is mounted, `AppAccess` offers no Context chooser of its own (it
shows its loading status until the hook selects) and management names only
the selected Context with its access. Sign-in, recovery, **Change sharing** and
**Sign out** stay in `AppAccess`. The
[TODO example](../examples/todo/src/app.tsx) puts the switch in its header:
the list name as the title and, with several lists, a menu with the lists, a
"read only" hint and **Share more lists** (`useApp().authorize`).

## Pod overviews with Contexts on-demand

Keep `contextSelection` omitted (or `'required'`) for the existing Context-based
app: the controller automatically loads catalogues for accepted connections and
`AppAccess` waits for a readable Context. For an overview, opt in on the provider:

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
or `construct`; `useAppState().pod` exposes the same active `BoundPod`. The hook
infers the callback's Pod handle and data type, with the same states, `reload`,
`cancel`, obsolete-result handling and bounded recovery as `useLoad`. Pass the
signal into every read. Ordinary renders, Context switches, catalogue/label
updates do not restart it. Pod/session changes retire the old loader; scope loss
clears displayed data and changed grants refresh it in a fresh bounded recovery
cycle. An absent reader reports unavailable once startup completes or fails. Inline reads
do not loop; call `reload()` when your query/domain inputs change.

Pod-only startup, restored sessions, first reads and recovery initiate **zero**
catalogue/description requests in this mode, including with remembered/preset
Contexts and several saved connections. `AppAccess` hides for usable Pod access,
reacts to session/required-scope loss, and leaves the overview mounted. Pod `403`
is an operation refusal; the hook reports failed without catalogue recovery.
Failed operations remain failed after a grant change until explicit `reload()`;
reauthorization creates a new handle and loader. A grant change refreshes an
already ready Pod result, without treating a refusal as evidence that repeating
that operation will succeed.

Mount `TargetScreen` as soon as the Context flow is wanted, **before** a view
exists. It demands the active eligible connection's catalogue even if it mounted
before login completed. Concurrent/StrictMode demand shares the runtime operation.
After the loading status of that first load, `AppAccess` exposes the chooser,
empty/error feedback and explicit **Check access** retry. Opening its `open` management also demands discovery, but no selection: without a Context flow it lists the Contexts and their access instead of a chooser. Ready,
empty and failed catalogues are reused, with no effect-driven retry loop.
Custom UI uses existing `useApp().refreshContexts(id)` and guarded `selectContext`;
it supplies its own chooser/retry presentation. No separate activation API is needed.

`useWorkflowAccess` stays Context-only: `read`/`write` remain false before a
validated view, even when the Pod overview is ready. Fresh catalogue evidence
validates preset/remembered targets only on demand; an unreadable exact preset
never falls back to another Context. Selection immediately uses fallback names;
only the selected Context's label loads automatically, and a pending/failed
label never gates reads, selection or drafts. The policy does not change the
complete-catalogue API.

A custom menu that names other Contexts asks for their labels explicitly with
`useApp().loadContextLabels(id, iris)`: at most 20 IRIs per call (more reject
with `RuntimeError` before any request), only readable
Contexts of the ready catalogue, display text only. Results arrive in
`catalogue.labels` and share the selected label's cache; a failed or absent
label keeps the fallback name without retry.

```tsx
// Fragment: useEffect from react, useApp from @sempods/app-sdk/react,
// type Connection from @sempods/app-sdk.
function ListMenu({ connection }: { readonly connection: Connection }) {
  const app = useApp();
  const fact = connection.catalogue;
  const shown =
    fact.kind === 'ready'
      ? fact.contexts.filter((c) => c.readable).slice(0, 20)
      : [];
  const key = shown.map((c) => c.iri).join(' ');
  useEffect(() => {
    // Display text only: a connection that ended meanwhile rejects; keep the fallback.
    if (key)
      app.loadContextLabels(connection.id, key.split(' ')).catch(() => {});
  }, [app, connection.id, key]);
  const labels = fact.kind !== 'unknown' ? fact.labels : undefined;
  return (
    <ul>
      {shown.map((c) => (
        <li key={c.iri}>{labels?.[c.iri] ?? c.iri.split('/').pop()}</li>
      ))}
    </ul>
  );
}
```

The [copyable overview recipe](../examples/todo/recipes/pod-overview.tsx) combines
a Pod SELECT with provenance, a later Context-bound creation form and editing of
an overview row. It keeps the demand boundary mounted while the form owns
drafts/outcomes. The packed browser test runs this recipe, including an edit
beside a creation draft in another Context, with installed archives. Evidence on
a deployed Pod and in a real browser is tracked in
[#52](https://github.com/sempods/sempods-typescript/issues/52).

### Editing an overview row

An overview row is not an editable snapshot, only a pointer: its subject and the
Context its `GRAPH` binding names. `useContextEditor(definition)` edits one such
target in exactly that Context, through an explicit binding
([`runtime.bindContext`](browser-runtime.md#bind-an-explicit-context)). It never
changes the selected Context or the remembered choice, so a creation form in
another Context keeps its target and its draft.

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

- **Opening.** `open` records the active connection and demands its catalogue;
  the editor needs no `TargetScreen`. Unlike a `TargetScreen` it asks for no
  selected Context: `AppAccess` offers no Context chooser for it and stays
  hidden while the catalogue loads. A failed catalogue still shows there with
  **Check access**. For an `unreadable` target, opening management (`open`)
  offers **Change sharing**, and **Check access** in place (the management
  dialog checks again when it opens). `open()` resolves
  `true` once the target is open. Whether it becomes `ready` is reported through
  `phase`. Opening another target and `close()` run under the leave policy.
- **Phases.**
  - `loading`: startup, sign-in or the catalogue is not settled yet. No editor
    starts before startup settles.
  - `unavailable`: the target could not be established; `problem` is
    `unreadable`, `discovery-failed` or `refused`. A refused binding, for example
    another Context than an exact preset's, sends no request and changes
    nothing. A later catalogue that lists the Context, for example after
    **Check access**, still opens it.
  - `ready`: the binding and its resource editor exist. That does not mean the
    resource exists or that saving is permitted. Loading, `404`, offline
    failures, blocked access and review are states of that editor, with its
    retry.
  - `retired`: another connection became active. The target is never revived;
    `close()` clears it at once.
- **Evidence.** The first activation needs a successful catalogue that lists
  the Context as readable, also when a row is reopened. Unlike the selected
  view, which keeps working on retained evidence, a row opened after a failed
  refresh reports `discovery-failed` until a listing succeeds. Afterwards, losing read access, a
  failed catalogue refresh or the session ending keep the editor with its draft
  and any unconfirmed-write review. They are never attached to another Context,
  connection, subject or generation.
- **Leave policy.** The editor is a `connection`-scoped guard. Selecting another
  Context neither asks about it nor discards it. Opening another row, `close()`
  and connection actions ask first, and its pending write blocks them.
- **Writes** through the editor refresh lists and retire success feedback on
  the selected view of the same Context, and the other way round.

One target is one Context. If a subject has data in several Contexts, the query
returns one row per Context, and each Context holds only its own part of the
subject. The overview offers one action per row, such as "Edit in Home" and
"Edit in Work". Each edits and conditionally saves only that Context's part.
Never merge the rows into one editable snapshot. Creating resources stays with
`useCreation`.

A one-click change on a row, such as ticking a task, uses the same hook without
showing the editor: `open` the row, wait for its `editor.loaded`, `change` the
field and `save` once; close it after `saved` and reload the overview. A
refusal, a conflict or an unconfirmed answer keeps the editor open with its
recovery controls, and nothing is resent or shown as changed before the Pod
confirms it. The
[copyable one-click recipe](../examples/todo/recipes/overview-toggle.tsx) does
this with `usePodLoad(read, { retain: true })`, so the rows stay visible while
the overview reloads. There is no separate one-click hook for overview rows.

## Lists and creation

`useList(definition, { type? })` is the ordinary typed-list path. It uses
`listSubjects` through the same loader, exposing the same states/cancel/reload.
It refreshes after a confirmed creation, row mutation or bound editor save/delete
on the same target: one Context of the same connection, signed-in subject and
authorization generation, through any of its handles (the selected view or an
explicit one from `runtime.bindContext`). Explicitly cancelled lists stay
cancelled until `reload()`.
It also reads again when the page becomes visible (`visibilitychange`: back in
the tab or the installed app), unless cancelled, so changes from other devices
appear without a reload button. It does not poll, subscribe to other clients'
writes or invalidate other Pods.
An equal inline definition or `type` does not restart it; a real change reads again.

A list keeps its last result on screen while it reloads (`retain`, on by
default for `useList`; pass `retain: true` to `useLoad` or `usePodLoad`, and
`retain: false` to a list that should show only `loading`). While the same
target reloads, `state` is `{ kind: 'loading', previous }`, and after a refresh
that failed it is `{ kind: 'failed', error, previous }`. That data is still
readable but was not confirmed by the failed read. Retained data is only what a
read returned; it is dropped for another connection, authorization, Context or
definition, after lost read access or changed Pod grants, and after `cancel()`.
A late answer never replaces it.

`useList` returns the rows to render as `data`: the current ones, or the kept
ones while loading or after a failed refresh. `LoadNotice` says what the read
does when the rows alone do not: loading before any data, a failed refresh with
its error (and a note when kept rows are shown), a cancelled or unavailable
read, each with a retry, and entries the definition cannot show
(`data.skipped`: unmapped terms, blank nodes or values it does not accept).

```tsx
const list = useList(taskFields);
return (
  <>
    <LoadNotice {...list} />
    <ul>
      {list.data?.items.map((item) => (
        <li key={item.iri}>{item.data.title}</li>
      ))}
    </ul>
  </>
);
```

`useFieldUpdate(definition)` exposes `canMutate` (write access, pending and both
unresolved outcomes together), `update`, `remove` and `notice`. Render
`<UpdateNotice {...mutation.notice} />`: comparison reads the captured subject,
shows the observed domain values (or explicit absence), refreshes local lists,
and requires explicit acknowledgement without replay. A failed comparison read
does not enable acknowledgement. A present resource the definition cannot read is
evidence too: the notice sets `unreadable` instead of `current`, shows no field
comparison and enables acknowledgement. List reload success is not required
because the exact-subject evidence is displayed in the notice itself.
Both mutation and creation notices expose `checked` as the authority for their
acknowledgement button; pass it through to a custom recovery UI. Losing read access
clears comparison values, absence/unreadable flags and `checked`, including
read-derived `outcome.current` and the `desiredObserved` observation. Access recovery
requires another successful check. Losing only write access keeps readable evidence.
The unresolved outcome, locked creation draft, captured IRI and leave guard remain.
`UpdateNotice` accepts an optional `checked` prop; without it, custom callers keep
the local acknowledgement state established by their `onCheck` callback.
The raw `create(iri, body)` remains available; its typed overload is
`create(iri, definition, draft)`. Ordinary forms use the creation hook instead.
Failed mutations retain `reason` and expose structured `problem` details.
For a refusal, inspect `problem.status`; for `problem.kind === 'failure'`,
pass a present `problem.failure` to `describeFailure`. Unconfirmed writes
remain unconfirmed and carry no failure that would imply they were not sent.

`useFieldUpdate` keeps one write lane per resource, held by the hook rather
than by a row. Rows of a list are separate resources, so use one hook for the
list and ask per row: `disabled={!mutate.canMutateFor(item)}` and
`<UpdateNotice {...mutate.noticeFor(item)} quiet />`, as the
[TODO example's `TaskRow`](../examples/todo/src/app.tsx) does. Ticking one task
then locks only that row, and a refusal or an unconfirmed answer shows at that
row. Because the lane lives in the hook, an unresolved write and its leave
guard stay while the row is not rendered, for example during lost read
access, and return with the row. `unresolved` lists the IRIs whose write still
needs a check; show `noticeFor(iri)` outside the list for those without a row,
for example a task deleted elsewhere, as the TODO example does. Do not give
each row a hook of its own: unmounting the row would drop its unresolved write.
After the hook unmounts, `update`, `remove` and `create` send nothing.
For a delete in the row, `RemoveButton` asks with the same dialog and texts as
`ResourceEditor`'s **Delete** and calls `onRemove` only from its confirmation:
`<RemoveButton label={...} disabled={!mutate.canMutateFor(item)} onRemove={() => mutate.remove(item)} />`.
Its children replace the **Delete** text, for example with an icon; `label`
then names it. The TODO example offers it for done tasks. `canMutate`, `outcome`,
`notice` and `acknowledge` keep their list-wide meaning (false while any
resource's write is pending or unresolved; the latest write's feedback).

`useCreation(definition, { initial, collection })` owns a typed draft, partial
`change`, `create`, `canCreate`, `canEdit` and `notice`. The initial draft should
be blank for the app's form; inline equivalent values are allowed. Changes are
frozen copies. A pending command or uncertain result locks the draft in both UI
and the change action. One subject IRI/command is captured until completion or
explicitly settled recovery; nothing is replayed automatically. Confirmed creation
or acknowledgement of present evidence resets only this creation's draft; an
`unreadable` resource counts as present. If the
comparison observes absence, acknowledgement keeps the draft and captured command:
Create becomes available for an explicit retry of the same IRI and body with
`If-None-Match: *`. The draft stays locked until recovery settles, including against
no-op form normalization, so a late original write cannot produce a duplicate under
a fresh IRI. A retry that finds the resource remains unconfirmed and requires a
new comparison; observing it never proves which request wrote it. Row updates
have separate feedback and cannot clear the creation draft. The registered target guard
protects unsubmitted drafts and recovery through row navigation, and asks before
a context/Pod/disconnect transition. A forced lifetime change retires old results.
Use `<UpdateNotice {...creation.notice} />` and bind input disabled state to
`!creation.canEdit`, submit to `!creation.canCreate`. Every sent `create()`
resolves with the captured `iri`, for example to link a second creation to it;
an unconfirmed creation keeps that IRI for its check and retry.

`context` creates in an explicit Context instead of the selected one:
`useCreation(definition, { initial, collection, context })`. The hook binds it
with `runtime.bindContext` once startup has settled and demands catalogue
discovery (no selection) so its write access is known. `refused` reports a
`context` that is not a Context of the active connection's Pod, or not an exact
preset's; nothing is created there. The draft, its target and a pending or
uncertain creation stay when another Context is selected or a row opens (guard
scope `explicit`); connection actions ask first. Lists of the same Context read
again after a confirmed creation, as for the selected one. Without React,
`bindCreation(runtime.bindContext(id, context), definition, draft, { collection })`
captures one creation; its `run()` counts as a write on that Context in the
same way.

Creation, row and editor feedback on one target follow one rule, so notices
rendered side by side describe the last write. A success (`created`, `saved`,
`removed`) retires as soon as another `useCreation`, `useFieldUpdate` or
`useResourceEditor` write starts on the same target, through any of its
handles, and is not shown if one started while it was pending. Writes through the client-sdk functions or an
unbound editor do not take part. A failure stays until its own source acts
again. An unresolved outcome (`unconfirmed`,
`changed-on-pod`) stays until it is checked and acknowledged; a later success
never hides or settles it.

These hooks accept definitions created by `fields()`. Keep the collection stable
for a form; a real definition change starts a fresh form lifetime.
Advanced clients may also retain a portable `prepareCreation` command and
explicitly retry the same IRI. Reading the desired state does not prove which
request wrote it.

### Several resources from one input

One input can name several resources, for example “Milk, 2 Bananas, Bread”.
Create them one at a time with the same `useCreation` hook, inside `TargetScreen`:

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
    if (outcome?.kind === 'created') continue;
    // Stop. This item is held in the draft or may already exist: it never
    // returns to the input. Only the unsent rest does.
    setInput(names.slice(index + 1).join(', '));
    return;
  }
  setInput('');
}
```

`change` applies at once, so the `create()` right after it submits exactly that
draft. Both actions use the hook's latest state, so the handler may keep using
the `creation` of the render that started it. Start only while `canEdit` is true
and the draft is blank: while a command is pending, unconfirmed or held for a
retry, `change` is ignored, and an editable stopped item would be overwritten.
Keep the input and button disabled until `addAll` returns; never run creations
in parallel.

The item that stops the loop never returns to the input. Render the draft like
the single-item form next to `<UpdateNotice {...creation.notice} />`: an input
bound to `change` and disabled by `!creation.canEdit`, and Create disabled by
`!creation.canCreate`. What each result leaves behind:

- `created`: confirmed. The draft resets, lists refresh and the next item
  captures a fresh subject IRI. `outcome` stays `created` until the next `change`
  or until another hook or bound-editor write on the same target starts.
- `unconfirmed`: the item may exist. Its draft and captured command stay locked
  (`canEdit` and `canCreate` are false). Settle it as described above: present
  evidence resets the draft; observed absence enables Create for the explicit
  retry of the same IRI and body.
- `not-created`: nothing was written. The item stays in the editable draft.
  Create sends it again under the captured IRI; editing or clearing it is the
  person's choice. A taken IRI (`412`) is never reported as definitive: it
  stays `unconfirmed`, because the resource there may be this creation's own.
- `undefined`: usually nothing was sent, for example after write access was
  lost; the item stays in the editable draft and `outcome` is empty. But
  `create` also returns `undefined` when the target lifetime ended while the
  request was in flight, for example through a direct runtime call. That write
  may have landed, and the handler cannot tell the two cases apart. The new
  lifetime starts with a blank draft and, inside `TargetScreen`, a blank input;
  the person checks the list before typing the item again.

Items confirmed earlier stay created; a later stop does not affect them.
Nothing is retried automatically, an uncertain item never gets a new IRI, and
items after the stop were never sent. Keep the input in the same `TargetScreen`
as the hook: a target change then drops it, instead of carrying unsent items to
another target. [React tests](../packages/app-sdk/src/react/safe-authoring.test.tsx)
run this handler against fixtures, including a target change during a creation.
Without React, prepare one `prepareCreation` per item with `newSubjectIri` and
`await` each `run()` the same way. Parts of one input that belong in different
Contexts are created the same way with one hook per Context (`context`); the
[task-with-note recipe](../examples/todo/recipes/task-with-note.tsx) keeps a
created task when its private note is refused and retries only the note.

## Standard UI for one known Pod

For an app with one known Pod, put the preset in the host-owned runtime and keep
the same `AppAccess` and screen code:

```tsx
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
  preset: { podUrl: 'https://pods.example/alice' },
});

function TasksApp() {
  const [open, setOpen] = useState(false);
  const focusTarget = useRef<HTMLButtonElement>(null);
  const { messages } = useSdkLocale();
  return (
    <>
      <header>
        <h1>My tasks</h1>
        <button
          ref={focusTarget}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {messages.controls.dataAccess}
        </button>
      </header>
      <AppAccess
        appName="My tasks"
        headingLevel={2}
        mode="single"
        podAddress="hidden"
        open={open}
        focusTarget={focusTarget}
      />
      <TargetScreen>
        <Tasks />
      </TargetScreen>
    </>
  );
}

<SempodsProvider runtime={runtime}>
  <TasksApp />
</SempodsProvider>;
```

`Tasks` is your existing app screen. Once access is usable `AppAccess` hides
unless `open` is set, so the header's **Pods & sharing** button keeps signing
out, changing sharing and choosing another context reachable. The first visit offers **Sign in** without a
**Pod address** field (`podAddress="hidden"` with exactly one permitted Pod,
see below); after consent, the person chooses a context. The preset supplies the initial sign-in destination. With `mode="multiple"`,
**Pods & sharing** also offers another Pod unless `allowedPods` restricts the choice. Existing foreign
connections remain available for selection. Add the optional
`contextIri` inside `preset` to declare an exact context instead. The SDK waits for
fresh readable catalogue evidence, displays that fixed context instead of a
picker, and never falls back to another. Missing feature scopes, failed catalogue
loads and an unreadable configured context retain distinct feedback. **Change
sharing** requests consent again through the same guarded action.

Custom controls read `useAppState().preset` and call `useApp().connect()` without
an argument to reuse/connect the preset and request authorization. Call it only
from a user action, disable controls until startup storage is durable and while
`changing`/`confirmingLeave` or restoration is pending, and present action errors
with `useSdkLocale().error`. A returned `false` means the leave policy declined.
The same action is available on the headless app controller. For a different Pod,
pass an explicit URL; the preset does not enforce an allowlist. Hosts reconcile
all feature requirements through the existing runtime-wide `scopes` option.

To enforce a restriction, add `allowedPods: ['https://pods.example/alice']` to
that configuration. Custom controls can read `useAppState().allowedPods`; one
allowed Pod also supports argument-free `useApp().connect()` without a preset.
With several allowed Pods and no preset, pass the chosen URL. The runtime enforces
the policy for restore and callbacks too; see
[permitted Pods](browser-runtime.md#restrict-the-permitted-pods). `AppAccess` presents allowed Pod sets directly.

The [runtime guide](browser-runtime.md#one-known-pod) explains validation, exact
context precedence, reload and foreign-session behavior.

## Selection and draft lifetime

`disconnect(id)` keeps its guarded `Promise<boolean>` contract: `true` means
the action ran, not that sign-out was saved. If persistence fails, the connection
in `useAppState().connections` retains an ended session with
`problem: 'disconnected', saved: false`. `AppAccess` shows
`controls.disconnectFailed` beside its **Sign out** button, also after a
provider remount over the same runtime. Custom controls should offer the same
explicit retry. `AccessNotice` keeps the general access-loss message, so a
custom layout's own sign-out control carries the retry advice.
The fact stays while retrying; success removes the connection and its message.
Do not suggest reloading: the saved session may still restore until a retry
succeeds.

`useApp()` returns the guarded actions only: `selectConnection`, `selectContext`,
`connect`, `authorize`, `disconnect` and `navigate(action)` for row/page changes
under the same policy, plus the unguarded reads `refreshContexts(id)` and
`loadContextLabels(id, iris)`. Read state with `useAppState`,
`useConnections` and `useView`; the runtime and leave-dialog internals are not
part of it. `useSelection<T>()` provides a guarded `select(value)` and
`selected` value for the common row case. Place app-local screen state inside
`TargetScreen` to reset it per target without a handwritten keyed wrapper. Pending writes block navigation. Dirty editors or uncertain
outcomes require explicit confirmation before leaving their scope. A rejected
navigation action does not discard registered drafts; the current target remains selected when its requested
replacement is no longer available. A prompt is about the connection that was
active when it asked. If that connection stops being active outside a guarded
action (a returning sign-in, or the connection removed), the controller cancels
the prompt: the action resolves `false`, nothing runs and no draft is discarded.
Until startup settles, the controller exposes no Context view, so `TargetScreen`
renders nothing and no resource editor or other view-bound screen inside it can
start. On a callback page, saved sessions restore while the returning sign-in is
still being redeemed, and that connection becomes active afterwards. Pod reads
(`useAppState().pod`, `usePodLoad`) stay available meanwhile. Hooks used outside
`TargetScreen`, such as `useCreation`, still accept input while there is no view
and reset that draft once one appears. Keep their inputs disabled while
`useWorkflowAccess().write` is false, as the recipes do. Local row navigation leaves editor guards
only: list mutations and app-owned creation drafts survive, and uncertain outcomes still require comparison and
acknowledgement. `useDraftGuard(dirty, discard)` is target-scoped by default;
pass a third argument `'local'` only for a draft that row navigation leaves, or
`'connection'` for a draft bound to an explicit Context
([`runtime.bindContext`](browser-runtime.md#bind-an-explicit-context)) rather
than to the selection.

| Change                                                   | Leaves (asks about, then discards)        |
| -------------------------------------------------------- | ----------------------------------------- |
| Row navigation (`navigate`, `useSelection().select`)     | `local`, `connection` and unscoped guards |
| Context selection (`selectContext`)                      | `local`, `target` and unscoped guards     |
| `selectConnection`, `connect`, `authorize`, `disconnect` | every guard                               |

A pending write blocks every change, except that a saving `connection`-scoped
editor does not block a Context selection, which leaves it alone. A confirmation explicitly names any
unconfirmed write among the guards the change leaves and warns that discarding local recovery does not undo it.
The provider makes its content inert during confirmation and guarded action
preparation, including discovery, registration and redirect preparation, so new
user input cannot be lost during the transition. This policy covers navigation
through these actions, not closing/reloading a browser or direct calls to the advanced
runtime API.

Confirmed target/identity changes discard old editor state and abort reads.
A → B → A starts a fresh lifetime. Same-target catalogue refresh, access changes,
UI-locale changes and identical revalidation preserve local drafts. Write loss
disables writes; read loss clears the server baseline while retaining the draft.
Failed catalogue checks remain unresolved, with explicit failure feedback;
last accepted access facts are retained rather than inferred to be denied. The editor stays mounted next to recovery feedback.

`useWorkflowAccess()` exposes current read/write/catalogue facts and requested
feature scopes with required/optional and granted/missing/unknown status. It remains
Context-only; use `usePodLoad` for independent Pod reads. Grants
come from the accepted session; context access comes from the catalogue. Missing
optional features do not invalidate the session. No support or consent decision
is inferred from an absent grant. Each server operation remains authoritative.

## Customize without replacing safety

Replace `AppAccess`'s connection view with
`components={{ Connections: MyPicker }}`; the replacement receives
`ConnectionsProps` (`mode`, `podNames`). Usable access hides administration; the
app's **Pods & sharing** button opens it, including a replacement. A replacement
uses `useConnections`, `useAppState` and guarded `useApp()` actions; it must not
call raw runtime selection directly. Later access loss or management toggles
retain mounted content and its drafts. For a layout without `AppAccess`, see
[custom layouts](#custom-layouts-without-appaccess).

Override text with `messages={{ controls: { save: translate('save') } }}` or supply
individual message functions. Changes retranslate in place. `language` selects
EN/DE messages, `locale`/`timeZone` control formatting, and `direction` controls
direction. RDF text language is selected explicitly in domain field definitions;
a UI-language change never changes the RDF slot being edited.

Without `language` and `locale`, the provider follows the browser: it reads
`navigator.languages` once when it mounts and passes the first German or English
preference (else the first valid one, else `en`) to `resolveLocale`, so messages
and formatting follow the person. An explicit option keeps its own precedence: a
`locale` alone also chooses the messages, and a `language` alone keeps English
formatting. Pin English with `language="en" locale="en"`. Outside a browser, and
for `createLocale`/`resolveLocale`, nothing reads browser globals; pass
preferences to `resolveLocale(undefined, languages)` there.

Failure text is overridden per code with `messages.errors`, independently of
`messages.controls`. For example, `messages={{ errors: { catalogue: () =>
'The context list could not be loaded.' } }}` replaces only that failure's text;
other codes keep the SDK defaults. Overrides are partial, so adding a failure
code to the SDK does not require changes to an app's overrides.

For headless presentation, `createLocale(options).error(cause)` converts a caught
cause to structured failure text using the same defaults and overrides.
`describeFailure(errors, reason)` accepts a complete `FailureMessages` catalog
and an already structured `SdkFailure`. Both helpers are exported from
`@sempods/app-sdk`; they present messages without showing diagnostic details.

The default confirmation has keyboard focus, Escape cancellation and focus
restoration. It is a native modal `<dialog>` (role `alertdialog`) in the
browser's top layer, so it stays visible and operable above an app's own dialog
opened with `showModal()`, while that dialog and the rest of the guarded content
are inert. `AppAccess` with `onClose` brings its own management dialog; editors
and an inline `AppAccess` can also live inside an app's own modal under the same
`SempodsProvider`. Keep such an app dialog mounted while a confirmation is
pending; it cannot be closed from behind the confirmation. TODO inputs/buttons use visible focus
and mobile touch targets. Applications retain responsibility for labels and
accessibility of custom fields.

## Custom layouts without AppAccess

An app that does not use `AppAccess` keeps the provider and composes
`CallbackNotice`, `AccessNotice` and its own controls from the guarded `useApp()`
actions (`connect`, `authorize`, `disconnect`, `selectConnection`,
`selectContext`, `refreshContexts`). No runtime policy, login coordinator or new
session-state union is involved. Call actions only from user input, disable
controls until startup storage is durable and while `changing`/`confirmingLeave`
or restoration is pending, and present action errors with
`useSdkLocale().error`. A returned `false` means the leave policy declined.

Startup/storage feedback and `CallbackNotice` remain outside the content gate.
A failed or cancelled callback activates the connection being signed in to,
like a completed one; another connection's target returns once the person
selects it again. Custom layouts that read `startup.interaction` directly
should use `callbackNotice` to decide whether the outcome is still current. A
restoring connection waits, and a `leaving` one (the page is navigating to the
Pod's sign-in) keeps its screen inert and offers no sign-in (`AppAccess` shows
`controls.leaving` meanwhile; `AccessNotice` shows nothing);
`active` and `renewing` are authenticated facts, not interchangeable with context
access. A cancelled re-authorization keeps the signed-in session
(`startup.resumed`), and a session whose Pod was unreachable at startup is
`ended` with `restorable: true`: offer `retryRestore(id)`, not a sign-in.

A provider's `access_denied` answer does not say whether the person cancelled
or declined, and its free-text `error_description` is never shown or
interpreted. After a first sign-in the callback notice therefore says that no
access was granted (`controls.signInCancelled`), next to the connection's one
**Sign in**. After a declined re-authorization that kept the session, it says
that sharing was not changed (`controls.sharingUnchanged`) and
`AppAccess` offers **Change sharing** as the one next step. Any other provider
answer names its cause and also leads to **Sign in**. Select a readable context
explicitly; after a reload or re-authorization the runtime reselects the last
chosen one while it is still readable. Refreshing the catalogue and requesting
authorization never retry a write. A busy/unavailable startup offers the SDK's
reload guidance, not a call to the memoized initializer pretending to restart
it. Saved-record warnings do not hide healthy connections. Sign-in cancellation
by the leave guard is not an error.

Keep a target's content mounted through same-target access loss: hide it
visually or make it inert, but do not unmount it, and keep mutation notices
(`UpdateNotice`) outside the hidden or inert part, so captured drafts and
unconfirmed outcomes survive. Move focus to the access feedback if focused
content becomes unreadable. Hiding or inert UI does not cancel code or authorize
requests; children still honor their own operation eligibility. An empty
catalogue, no selected context and read-only access remain distinct facts in
`AccessNotice`. The widgets example's `AccessPanel` implements this with hidden,
disabled and custom fallbacks.

The host owns one provider/runtime and one leave-guard registry. Dispose the
host runtime at shutdown; provider unmount alone does not dispose it. Direct
browser reload/close is outside the SDK navigation guard.

## Several widgets in one host

The [widget guide](widgets.md) composes a list and quick-add form under one
host runtime/provider, without `AppAccess` in every widget. It explains shared targets, package
peers and why access loss must not unmount a mutating widget.

## Without React

A `BoundView` has a stable immutable `getSnapshot()` and `subscribe(listener)`.
Its snapshot contains `current`, `read`, `write`, `catalogue` and `revision`;
no credentials. Subscribe receives changes, not an initial call. Read the snapshot
at subscription time and unsubscribe during cleanup. A permanently invalid view
never becomes valid again; obtain the next view from the runtime.

`createAppController(runtime)` supplies the same guarded selection policy to a
non-React UI; call `start()` and `stop()` around its lifetime. Register draft guards
with `register`. Guards default to local scope; use `scope: 'target'` for drafts
or mutation outcomes that survive row navigation, `scope: 'connection'` for
drafts bound to an explicit Context that survive a Context selection (see the
table above) and `unconfirmed()` for pending
write-outcome evidence. Headless hosts must prevent input while the controller's
`changing` or `confirmingLeave` snapshot field is true, as the React provider does.
The snapshot's `view` stays `null` until `startup` or `startupError` is set.
Close a custom leave prompt whenever `confirmingLeave` turns false, also without
`confirmLeave()` or `cancelLeave()`: the controller cancels a prompt whose
connection stopped being active.

The controller snapshot also exposes the active `BoundPod` as `pod`, independently
of the Context `view`. Use its `sparql.select`/`construct` methods and subscribe to
its access snapshot for direct headless Pod reads; see
[the runtime reader](browser-runtime.md#read-the-authorized-pod-dataset). Pass
`{ contextSelection: 'on-demand' }` as the second controller argument to defer
catalogues, and call `runtime.loadContexts(id)` explicitly for a Context flow.

`createViewLoader(view, read)` and
`bindResourceEditor(view, iri, definition)` provide the same read/access behavior
as their hooks; `createViewLoader(pod, read)` does the same for a `PodRead<T>`, with
correlated callback types and no fallback from a Context read to a Pod read. A
loader starts without a request; call `reload()` for its first read. Dispose both
when the target changes. A framework may instead
subscribe to a view directly and render its facts without either helper.
Subscriber exceptions are reported asynchronously to the host, isolated from
other subscribers and operation settlement; `editor.loaded` still settles.

## Evidence and remaining validation

`pnpm test:todo` installs packed SDKs outside the workspace, typechecks and bundles
both actual examples, and drives the standard screen through real loopback
PKCE redirects, CRUD, conflict/unknown outcomes, guarded selection, EN/DE, keyboard,
mobile width and a busy second tab. It also executes the Node CRUD loop. Unit and
React tests cover access/draft preservation, lifecycle and cancellation. These are
fixture results, not live Kotlin compatibility or independent usability evidence.

TODO and Node share portable field definitions, typed lists, captured creation
commands and partial changes. Live Pod evidence belongs to the quickstart validation;
the provisional Action profile does not settle the outstanding task-vocabulary
or mixed-Action collection decisions.

## Kotlin-to-TypeScript orientation

A `fields()` object is a stable mapping definition shared by Node and React,
not a service instance. Hooks belong at component top level; their subscriptions
and cleanup follow the selected view's lifetime. Keep the browser runtime outside
render, use readonly drafts plus `change`, and handle discriminated results by
`kind` rather than exceptions for expected conflicts. React render is declarative;
SDK actions own asynchronous mutations and guards.
