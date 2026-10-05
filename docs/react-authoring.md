# React and headless authoring

Create one browser runtime outside render and pass it to one `SempodsProvider`.
The provider consumes `runtime.initialize()`; it does not create a second session
coordinator. Equivalent inline locale/message props do not replace the runtime or
editor. Changing the runtime object is an explicit application lifetime change;
keep it stable. The caller owns `runtime.dispose()` at application shutdown.

```tsx
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  SempodsProvider,
  AppShell,
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
  <AppShell title="My tasks" mode="multiple">
    <TargetScreen>
      <TaskScreen />
    </TargetScreen>
  </AppShell>
</SempodsProvider>;
```

Serve the same application at the redirect path. Startup processes its callback
and restores other connections independently. After a completed callback, its
connection becomes active; context selection stays explicit. The startup report
exposes `connectionId` for headless hosts. Screens never handle callbacks,
credentials, ETags or authentication recovery. See [browser runtime](browser-runtime.md)
for deployment identity, persisted sessions and the one-active-tab contract.
AppShell displays startup loading, callback failure or cancellation (with its
cause), unavailable storage and a localized second-tab notice. A custom layout
without AppShell places `<CallbackNotice />` itself next to its connection
controls. The context picker lists readable contexts only and says so when the
Pod grants none. Unavailable session storage prevents startup; controls
remain blocked with a reload notice (there is no in-memory session fallback). `mode="single"` hides adding further Pods once one
is connected; it uses the same runtime and guarded selectors as multiple mode.

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

`useLoad(read)` accepts a read-only domain function `(view, signal) =>
Promise<QueryResult<T> | Invalidated>`. It can combine a query and cancellable
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
and requires explicit acknowledgement without replay. A failed or unmappable
comparison does not enable acknowledgement; list reload success is not required
because the exact-subject evidence is displayed in the notice itself.
The raw `create(iri, body)` remains available; its typed overload is
`create(iri, definition, draft)`. Ordinary forms use the creation hook instead.

`useCreation(definition, { initial, collection })` owns a typed draft, partial
`change`, `create`, `canCreate`, `canEdit` and `notice`. The initial draft should
be blank for the app's form; inline equivalent values are allowed. Changes are
frozen copies. A pending command or uncertain result locks the draft in both UI
and the change action. One subject IRI/command is captured until completion or
explicitly settled recovery; nothing is replayed automatically. Confirmed creation
or acknowledgement of present evidence resets only this creation's draft. If the
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
Pod URL input; after consent, the person chooses a context. The preset also hides
the standard new-Pod URL form in `mode="multiple"`; connecting a different Pod
requires custom controls or headless calls with an explicit URL. Existing foreign
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
feature scopes with required/optional and granted/missing/unknown status. Grants
come from the accepted session; context access comes from the catalogue. Missing
optional features do not invalidate the session. No support or consent decision
is inferred from an absent grant. Each server operation remains authoritative.

## Customize without replacing safety

`AppShell` accepts `title`, `style` and `components={{ Connections: MyPicker }}`.
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
These are synthetic fixtures, not live Pod or installed-PWA evidence. Enforced
Pod sets, per-widget scopes, independent targets and new public gate APIs require
separate contracts; this example does not implement them.

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
`createViewLoader(view, read)` and
`bindResourceEditor(view, iri, definition)` provide the same read/access behavior
as their hooks. A loader starts without a request; call `reload()` for its first
read. Dispose both when the target changes. A framework may instead
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

TODO and Node now consume the portable typed list/create/IRI helpers and partial
changes. Their shared definitions replace the earlier handwritten SPARQL mapper
and raw creation body. Live Pod evidence belongs to the quickstart validation;
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
