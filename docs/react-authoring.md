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
  returnTo: '/',
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
connection becomes active; context selection stays explicit. The startup report
exposes `connectionId` for headless hosts. Screens never handle callbacks,
credentials, ETags or authentication recovery. See [browser runtime](browser-runtime.md)
for deployment identity, persisted sessions and the one-active-tab contract.
`AppAccess` is the default composition for new apps: a centered login/recovery
surface beside your content, with no mandatory outer frame or persistent header.
It displays startup loading, callback failure/cancellation, unavailable storage
and a localized second-tab notice. It hides once the selected target is readable,
including read-only access; catalogue failures remain visible even if the runtime
retains previous access facts. While the active connection restores, or is signed
in but its Pod reader is not yet readable, it shows the loading status and, when
they apply, the active-Pod selector for several saved connections and the sign-in
for a configured Pod other than the active one, so a restore that does not settle
never blocks switching Pods or signing in. A custom `components.Connections` is replaced
by the loading status alone. The connection view (with its addresses and actions)
appears when something needs a decision, such as an ended session or missing
required scopes; while a demanded catalogue loads, in `'required'` mode or under a
mounted `TargetScreen`, with its pending-catalogue notice before the Context
choice; or when the host opens it with `open`. The context picker lists readable contexts only and says so when the
Pod grants none. Unavailable session storage prevents startup; controls
remain blocked with a reload notice (there is no in-memory session fallback).
`AppShell`, `ConnectionControls` and fully custom layouts remain supported;
custom layouts that omit `AppAccess` place `CallbackNotice` themselves.

## Login without an app frame

An optional `icon` is app-owned JSX, usually `<img src="/icon.png" alt="" />`.
No icon is required. `podNames` maps exact canonical Pod URLs to display names;
the destination remains visible, and duplicate names are disambiguated. Both controls prefer the label from the runtime's
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
the fallback immediately, including on small Pods.
Duplicate context names include the full IRI; **Full addresses** exposes all readable
context identities. Names never replace Pod/context identity, and displaying them
starts no additional requests. Late or refreshed labels do not change selection
or discard drafts.

One `allowedPods` entry or a preset needs no URL input. Several permitted Pods
get a finite picker; selecting an option does not start sign-in. When a connection
already exists, adding another Pod is a secondary action; signing into the current
connection remains prominent when needed. Unrestricted
apps show **Your Pod** with a short hint. The input may omit `https://`; presentation
adds it, trims surrounding whitespace and removes one trailing slash before
calling the runtime. Other noncanonical input remains rejected; configured Pod
URLs still require the strict canonical form.
For local HTTP development enter `http://127.0.0.1:…` explicitly. There is no silent
auth or automatic redirect. Login/consent on the Pod retains the Pod's own UI.

The initial login uses an `h1`; recovery with an existing target and explicitly
opened management use an `h2`, below the app’s own main heading.

The app may put a **Data access** button in its own menu or header. `open` shows
management. In on-demand mode, opening it also demands Context discovery. Pod/context changes still run
through the same leave guards. Supply `focusTarget` for focus recovery when a
focused access control disappears. For example, inside the provider:

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
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {messages.controls.dataAccess}
        </button>
      )}
      <AppAccess
        appName="My tasks"
        open={open}
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

`AppAccess`, `AppShell`, `ConnectionControls`, `ResourceEditor`, `UpdateNotice`,
`AccessNotice` and `CallbackNotice` share a scoped baseline: light/dark appearance,
44px touch targets, visible keyboard focus and wrapping comparisons. No stylesheet
import or UI framework is required. AppShell styles its own header; it does not
style app list rows or controls elsewhere in its children. ResourceEditor styles
the fields rendered inside that editor as well as its review/actions.

The host owns the color scheme; SDK surfaces inherit it. A page without a scheme
stays light even when the system prefers dark. Enable page-wide automatic dark
appearance in the app's CSS:

```css
:root {
  color-scheme: light dark;
}
```

Keep any explicit page backgrounds/text colors compatible with that choice
(for example with `light-dark()`). Embedded notices, editors and connection controls
have transparent surfaces; their fields/buttons use the shared tokens. AppShell
and AppAccess retain their themed background.

Set `--sempods-bg`, `--sempods-text`, `--sempods-muted`, `--sempods-line`,
`--sempods-accent` and `--sempods-on-accent` on an ancestor or on the component's
`style`/`className` where supported. They inherit across SDK components. Existing
`--sempods-access-*` names remain fallback aliases; the shared names take priority.
React 19 hoists and deduplicates the static scoped sheets using its
[`style` resource support](https://react.dev/reference/react-dom/components/style).
Inline scoped styles still require a compatible CSP. Hosts that prohibit them can
compose their own presentation using the public hooks.

`components={{ Connections: YourControls }}` replaces access controls while
retaining startup/callback presentation. All actions must still use `useApp()`.
`mode="single"` hides adding another Pod once selected; it is a presentation choice,
not a restriction. Use runtime `allowedPods` to enforce the permitted Pods.
When a host already provides its title, use `headingLevel={2}` for subordinate
access headings; AppShell does this automatically.

## A screen

See the runnable [TODO screen](../examples/todo/src/app.tsx) and its shared
[domain functions](../examples/todo/src/domain.ts). A field definition describes
RDF terms once; it works with form editing, list actions and the Node consumer.
`useResourceEditor(iri, definition)` manages subscription, access and disposal.
`ResourceEditor` supplies save/delete/discard and comparison controls; its child
renders only a draft and calls `change({ title })` for an original `fields()` definition.
Copied or arbitrary definitions retain complete-draft replacement and typing, including unions. Feedback applies only to the
editor state on which the operation settled; a newer dirty draft is never labelled
saved. Comparisons in `ResourceEditor` and `UpdateNotice` show localized values
(yes/no for flags, a dash for empty text); pass `labels={{ title: 'Task' }}` to
name the fields instead of showing their keys.

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
`AppAccess` then exposes the chooser, empty/error feedback and explicit **Check
access** retry. Opening its `open` management also demands discovery. Ready,
empty and failed catalogues are reused, with no effect-driven retry loop.
Custom UI uses existing `useApp().refreshContexts(id)` and guarded `selectContext`;
it supplies its own chooser/retry presentation. No separate activation API is needed.

`useWorkflowAccess` stays Context-only: `read`/`write` remain false before a
validated view, even when the Pod overview is ready. Fresh catalogue evidence
validates preset/remembered targets only on demand; an unreadable exact preset
never falls back to another Context. Selection immediately uses fallback names;
only the selected Context's label loads, and a pending/failed label never gates
reads, selection or drafts. The policy does not change the complete-catalogue API.

The [copyable overview recipe](../examples/todo/recipes/pod-overview.tsx) combines
a Pod SELECT with provenance, a later Context-bound creation form and editing of
an overview row. It keeps the demand boundary mounted while the form owns
drafts/outcomes. The packed browser test runs this recipe, including an edit,
with installed archives. Evidence on a deployed Pod and in a real browser is
tracked in [#52](https://github.com/sempods/sempods-typescript/issues/52).

### Editing an overview row

An overview row is not an editable snapshot, only a pointer: its subject and the
Context its `GRAPH` binding names. `useContextEditor(definition)` edits one such
target in exactly that Context:

```tsx
function Notes() {
  const edit = useContextEditor(note);
  return (
    <>
      <Overview onEdit={(row) => void edit.open(row)} />
      {edit.target && edit.phase !== 'retired' && (
        <section aria-label="Edit note">
          {edit.phase === 'unavailable' ? (
            <p role="alert">This note's Context is not available.</p>
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

`open` records the active connection and demands its catalogue, as
`TargetScreen` does; the editor needs no `TargetScreen` of its own. Once the
controller is settled and the catalogue lists the Context as readable, the hook
calls the guarded `selectContext` once, also under StrictMode. `editor` exists
only for a view of exactly that Context. It reads the subject fresh and saves
with its ETag (`If-Match`), like `useResourceEditor`. Opening another target and
`close()` run under the leave policy, so an unsaved draft, an open review or a
pending write asks first.

`phase` is `idle`, `activating`, `unavailable` (the catalogue does not list the
Context as readable; a later catalogue that lists it, for example after **Check
access**, still activates it), `ready` or `retired`. A retired target has no
editor, and the hook never selects its old Context again; `reason` says why:

- `declined`: the guarded selection was declined (the person kept a draft
  elsewhere), blocked by a pending write or refused by the runtime.
- `context-changed`: another Context was selected elsewhere after activation,
  for example in `AppAccess`.
- `connection-changed`: another connection became active, at any point. The
  retired target never demands discovery from the new connection.

Open the row again to start over. Losing read access after activation does not
retire the editor: it keeps its draft through access loss and recovery, and
saving follows the view's write access.

One target is one Context. If a subject has data in several Contexts, the
query returns one row per Context, and each Context holds only its own part of
the subject. The overview offers one action per row, such as "Edit in Home" and
"Edit in Work". Each edits and conditionally saves only that Context's part.
Never merge the rows into one editable snapshot. Creating resources stays with
`useCreation`.

## Lists and creation

`useList(definition, { type? })` is the ordinary typed-list path. It uses
`listSubjects` through the same loader, exposing the same states/cancel/reload.
It refreshes after a confirmed creation, row mutation or bound editor save/delete
on that exact view. Explicitly cancelled lists stay cancelled until `reload()`.
It does not poll, subscribe to other clients' writes or invalidate other Pods.
An equal inline definition or `type` does not restart it; a real change reads again.

`useFieldUpdate(definition)` exposes `canMutate` (write access, pending and both
unresolved outcomes together), `update`, `remove` and `notice`. Render
`<UpdateNotice {...mutation.notice} />`: comparison reads the captured subject,
shows the observed domain values (or explicit absence), refreshes local lists,
and requires explicit acknowledgement without replay. A failed comparison read
does not enable acknowledgement. A present resource the definition cannot read is
evidence too: the notice sets `unreadable` instead of `current`, shows no field
comparison and enables acknowledgement. List reload success is not required
because the exact-subject evidence is displayed in the notice itself.
The raw `create(iri, body)` remains available; its typed overload is
`create(iri, definition, draft)`. Ordinary forms use the creation hook instead.

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
`!creation.canEdit`, submit to `!creation.canCreate`.

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
  captures a fresh subject IRI. `outcome` stays `created` until the next `change`.
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
`await` each `run()` the same way.

## Standard UI for one known Pod

For an app with one known Pod, put the preset in the host-owned runtime and keep
the same AppShell and screen code:

```tsx
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
  preset: { podUrl: 'https://pods.example/alice' },
});

<SempodsProvider runtime={runtime}>
  <AppShell mode="single" title="My tasks">
    <TargetScreen>
      <Tasks />
    </TargetScreen>
  </AppShell>
</SempodsProvider>;
```

`Tasks` is your existing app screen. The first visit offers **Sign in** without a
Pod URL input; after consent, the person chooses a context. The preset supplies the initial sign-in destination. With `mode="multiple"`,
**Data access** also offers another Pod unless `allowedPods` restricts the choice. Existing foreign
connections remain available for selection. Add the optional
`contextIri` inside `preset` to declare an exact context instead. The SDK waits for
fresh readable catalogue evidence, displays that fixed context instead of a
picker, and never falls back to another. Missing feature scopes, failed catalogue
loads and an unreadable configured context retain distinct feedback. **Update
access** requests consent again through the same guarded action.

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
[permitted Pods](browser-runtime.md#restrict-the-permitted-pods). `AppAccess` and AppShell present allowed Pod sets directly; standalone
ConnectionControls continues to use `preset` for its form presentation.

The [runtime guide](browser-runtime.md#one-known-pod) explains validation, exact
context precedence, reload and foreign-session behavior. The recipe below
remains useful when your app owns the selection/presentation policy instead of
using this standard preset. Both paths share the same runtime and leave guards.

## Selection and draft lifetime

`useApp()` returns the guarded actions only: `selectConnection`, `selectContext`,
`connect`, `authorize`, `disconnect`, `refreshContexts(id)` and `navigate(action)`
for row/page changes under the same policy. Read state with `useAppState`,
`useConnections` and `useView`; the runtime and leave-dialog internals are not
part of it. `useSelection<T>()` provides a guarded `select(value)` and
`selected` value for the common row case. Place app-local screen state inside
`TargetScreen` to reset it per target without a handwritten keyed wrapper. Pending writes block navigation. Dirty editors or uncertain
outcomes require explicit confirmation before leaving their scope. A rejected
navigation action does not discard registered drafts; the current target remains selected when its requested
replacement is no longer available. Local row navigation leaves editor guards
only: list mutations and app-owned creation drafts survive, and uncertain outcomes still require comparison and
acknowledgement. `useDraftGuard(dirty, discard)` is target-scoped by default;
pass a third argument `'local'` only for a draft that row navigation leaves.
A target change leaves both scopes; its confirmation explicitly names any
unconfirmed write and warns that discarding local recovery does not undo it.
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

`AppShell` accepts `title`, `style` and `components={{ Connections: MyPicker }}`.
It composes a title/management header, `AppAccess`, and the content. Usable access
hides administration; **Data access** opens it, including replacement controls.
Startup still gates content until durable storage is ready; later access loss or
management toggles retain mounted content and its drafts. Read-only feedback stays
visible. See [0.3 migration](migration.md#from-02-to-03) for the changed presentation.
A replacement uses `useConnections`, `useAppState` and guarded `useApp()` actions;
it must not call raw runtime selection directly. For a different layout, omit
AppShell, keep the provider, and place `ConnectionControls`/`AccessNotice` and
your screen anywhere. The TODO's `/custom` route demonstrates this using the
same screen and domain functions as `/`.

Override text with `messages={{ controls: { save: translate('save') } }}` or supply
individual message functions. Changes retranslate in place. `language` selects
EN/DE messages, `locale`/`timeZone` control formatting, and `direction` controls
direction. RDF text language is selected explicitly in domain field definitions;
a UI-language change never changes the RDF slot being edited.

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
restoration. TODO inputs/buttons use visible focus and mobile touch targets.
Applications retain responsibility for labels and accessibility of custom fields.

## A known Pod and replaceable access UI

The [sign-in recipe](../examples/todo/recipes/sign-in.tsx) is a copyable app-owned
example using existing public exports. It supplies `KnownPodControls`, an
`AccessPanel` and a small note form. These names are example components, not SDK
exports. No runtime policy, login coordinator or new session-state union is added.

```tsx
import { createBrowserRuntime } from '@sempods/app-sdk';
import { KnownPodExample } from './sign-in.js'; // Copy the recipe into your app.

// Create once outside render; the host disposes it at application shutdown.
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:notes.example',
    redirectUri: 'https://notes.example/callback',
  },
  returnTo: '/',
  scopes: { required: [], optional: [] }, // Declare your actual feature needs.
});

<KnownPodExample
  runtime={runtime}
  podUrl="https://pod.example/alice"
  fallback={{ content: <p>Ask the host for access, then check again.</p> }}
/>;
```

Configure static callback routing as in [deployment](deployment.md). For local
loopback testing use the quickstart's dynamic identity/development setting.
`podUrl` is stable, canonical configuration: exactly the runtime-reported base
URL, with no trailing slash, query or fragment. The client already rejects
noncanonical input before discovery; the recipe does not implement another URL
normalizer. It matches saved connections by that exact URL and calls
`authorize(id)` when one exists, including after failed login preparation.
Otherwise it calls `connect(podUrl)`. If older code created duplicates, it prefers
the active matching connection, otherwise the first match; it does not delete
records. All actions use the shared leave policy, and rapid concurrent clicks
cannot bypass it. No login occurs on mount. This is a known-Pod UI, not an
allowlist: other connections can still exist in the runtime.

Startup/storage feedback and `CallbackNotice` remain outside the content gate.
A callback failure does not hide a usable target. A restoring connection waits;
`active` and `renewing` are authenticated facts, not interchangeable with context
access. Select a readable context explicitly; after a reload or re-authorization
the runtime reselects the last chosen one while it is still readable. `Check
again` refreshes that connection's catalogue, while the sign-in button requests
authorization (labelled `Update access` while signed in); neither retries a
write. A busy/unavailable startup offers the SDK's reload guidance, not a call to
the memoized initializer pretending to restart it. Saved-record warnings do not
hide healthy connections. Sign-in cancellation by the leave guard is not an error.

The example's view facts decide whether note content is readable; write access
and `useCreation` decide whether its controls can edit/save. Catalogue errors
retain known access with visible failure feedback. Missing required feature
scopes block the relevant bound view, optional missing scopes do not. An empty
catalogue, no selected context and read-only access remain distinct facts in
`AccessNotice`. The Pod still authorizes every operation.

Choose `fallback="hidden"`, `fallback="disabled"` or a custom `content` node.
Before a target exists, the disabled variant is an empty inert preview. After
selection, the content stays mounted through same-target access loss; hidden
means visually hidden, not unmounted. The disabled variant is inert, with actual
inputs disabled by their SDK eligibility. Focus moves to the access feedback if
the focused content becomes unreadable. Custom children must honor their own
operation eligibility: hiding/inert UI does not cancel code or authorize requests.

Place mutation notices **outside** the hidden/inert region: the recipe's
`recovery` slot keeps `UpdateNotice` visible. Its creation hook owns the captured
IRI, draft and pending/unconfirmed result. Read loss hides the note input without
losing that evidence; reauthorization or context changes still ask before
leaving it. A real target change uses `TargetScreen` to start a fresh lifetime;
renewal, locale and access changes do not. This pattern also works with
`ResourceEditor` when its controller and recovery remain mounted.

The host owns one provider/runtime and one leave-guard registry. For an existing
provider, compose `KnownPodControls` and the recipe's content there instead of
nesting `KnownPodExample`, which creates a provider. Dispose the host runtime at
shutdown; provider unmount alone does not dispose it. Direct browser reload/close
is outside the SDK navigation guard. The recipe has no logout control: the current
facade does not expose the runtime's `blocked-locally` disconnect outcome, so it
cannot promise durable logout from its returned boolean.

The packed browser check runs this exact recipe against installed SDK archives:
PKCE callback, explicit context, reauthorization back to the remembered context,
draft guards, EN/DE, each access
fallback and the second-tab notice. Focused React tests also exercise callback
failure alongside an active session and unconfirmed creation through read loss.
These are synthetic fixtures, not live Pod or installed-PWA evidence. Enforce
Pod sets with the runtime's existing `allowedPods` option; this recipe alone is
a known-Pod UI. Per-widget scopes, independent targets and additional gate APIs
remain separate design work.

## Several widgets in one host

The [widget guide](widgets.md) composes a list and quick-add form under one
host runtime/provider, without AppShell. It explains shared targets, package
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
or mutation outcomes that survive row navigation and `unconfirmed()` for pending
write-outcome evidence. Headless hosts must prevent input while the controller's
`changing` or `confirmingLeave` snapshot field is true, as the React provider does.

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
both actual examples, and drives the standard/custom screens through real loopback
PKCE redirects, CRUD, conflict/unknown outcomes, guarded selection, EN/DE, keyboard,
mobile width and a busy second tab. It also executes the Node CRUD loop. Unit and
React tests cover access/draft preservation, lifecycle and cancellation. These are
fixture results, not live Kotlin compatibility or independent usability evidence.

TODO and Node share portable field definitions, typed lists, captured creation
commands and partial changes. Live Pod evidence belongs to the quickstart validation;
the provisional Action profile does not settle the outstanding task-vocabulary
or mixed-Action collection decisions.

## Kotlin-to-TypeScript orientation and independent exercise

A `fields()` object is a stable mapping definition shared by Node and React,
not a service instance. Hooks belong at component top level; their subscriptions
and cleanup follow the selected view's lifetime. Keep the browser runtime outside
render, use readonly drafts plus `change`, and handle discriminated results by
`kind` rather than exceptions for expected conflicts. React render is declarative;
SDK actions own asynchronous mutations and guards.

For the independent participant exercise, start from the quickstart and use only
public API/docs to add a field, override a message/language, and relocate/replace
the picker using guarded actions. Record steps, confusion, assistance and any
need to inspect internals. This exercise remains pending until someone
unfamiliar with the SDK performs it; automated examples are separate evidence.
