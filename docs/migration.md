# Upgrade an app and recover a session

Use this guide when moving an older frontend onto app-sdk, changing a deployment
identity or updating a preview SDK. It describes a deliberate migration, not an
automatic conversion of legacy app data or stored credentials.

## From 0.5.1 to 0.6.0

This minor release changes some defaults and result types and adds options;
upgrade both packages together.

**Needs action in most apps:** check mutation results for
`{ kind: 'not-sent', reason }` where code tested for `undefined`; replace `AppShell`/`ConnectionControls` with
`AppAccess`; pin `language="en" locale="en"` if the UI must stay English in
other browsers; add `problem` to hand-built failure outcomes; handle the
session kind `leaving` in exhaustive switches; drop app-side `valid` filters
over list items; compare creation outcomes with `toMatchObject` (they now
carry `iri`); find editor and dialog buttons by name, not position. The other
points add options or change the look.

All points:

- **Edit failure details.** Hand-built `UpdateOutcome`, `RemoveSnapshotOutcome`
  and `CreateOutcome` failures now need `problem`, for example
  `{ kind: 'not-saved', reason: 'refused', problem: { kind: 'refused', status: 403 } }`.
  Existing checks of `reason` keep working; it equals `problem.kind`.
- **UI language follows the browser.** `SempodsProvider` and `SdkLocaleProvider`
  without `language` and `locale` now use the browser's languages (read once per
  provider) instead of English: a German browser gets German messages and
  `de-DE` formatting. Pin the old result with `language="en" locale="en"`. A
  `locale` or `language` alone keeps its previous meaning; `createLocale` and
  `resolveLocale` are unchanged and read no browser globals.
- **Cancelling a re-authorization keeps the session.** When the provider
  answers a signed-in connection's re-authorization with `access_denied`, the
  earlier session resumes while it is still valid: the report says
  `interaction: 'cancelled'` and `resumed: true`, and the connection stays
  `active`. When the person comes back without a callback (back navigation, an
  abandoned attempt), it resumes the same way during startup, with
  `interaction: 'none'` and the connection going `restoring` → `active`. Every other failure
  still ends it; a successful narrower grant replaces the earlier one. Code
  that treated a cancelled callback as "signed out" checks the connection's
  session instead.
- **New session kind `leaving`.** After `beginAuthorization()` stored its
  attempt, the connection reports `{ kind: 'leaving', subject? }` instead of
  `signed-out` until the page unloads, and keeps its catalogue, selection and
  grants. Its handles no longer dispatch. Switches over `session.kind` add a
  `leaving` case: keep the current screen and offer no sign-in. The SDK
  components show `controls.leaving` (optional in `UiMessages`) instead of a
  sign-in action, and `AccessNotice` shows nothing: no access was lost.
- **Neutral denial wording.** A provider's `access_denied` does not say whether
  the person cancelled or declined, so `controls.signInCancelled` and
  `errors.oauth` for `denied` now say that no access was granted and suggest
  signing in again to choose what to share. A declined re-authorization that
  kept the session shows the new `controls.sharingUnchanged` (optional in
  `UiMessages`) as a status, with **Change sharing** as its one action. The
  provider's `error_description` is still never shown or interpreted. Tests
  that match the old texts need the new ones; pass `messages.controls` to keep
  your own.
- **Offline start keeps the session.** When restoring a saved session cannot
  reach its Pod (offline, `5xx`, `408`, `429`), the connection ends with
  `restorable: true` instead of looking signed out. `AppAccess` shows
  `controls.unreachable` (optional in `UiMessages`)
  with **Try again** instead of **Sign in**; coming back online restores the
  session by itself. Custom controls check `session.restorable` and call
  `runtime.retryRestore(id)` or `useApp().retryRestore(id)`. Test doubles that
  implement `BrowserRuntime` add the method.
- **Deep links through sign-in.** `returnTo` also accepts a function, called
  when each sign-in or re-authorization starts, so a person who navigated to
  `/items/add` inside the app returns there after the callback. A string keeps
  its meaning. The result is checked like a string; an unsafe address rejects
  the sign-in with a `configuration` error.
- **`AppShell` and `ConnectionControls` are removed.** Both predate `AppAccess`.
  Replace `AppShell` with your own header and a **Pods & sharing** button
  beside `AppAccess`:

  ```tsx
  const [open, setOpen] = useState(false);
  <header>
    <h1>My tasks</h1>
    <button aria-expanded={open} onClick={() => setOpen(!open)}>
      {useSdkLocale().messages.controls.dataAccess}
    </button>
  </header>
  <AppAccess appName="My tasks" headingLevel={2} open={open} />
  <TargetScreen>{/* your screen */}</TargetScreen>
  ```

  Replace standalone `ConnectionControls` with `AppAccess open`, or with your
  own controls over the guarded `useApp()` actions next to `CallbackNotice`
  and `AccessNotice`. The replacement slot stays: `AppAccess`
  `components={{ Connections }}` now types its props as `ConnectionsProps`
  (was `ConnectionControlsProps`). The CSS aliases `--sempods-access-bg`,
  `-text`, `-muted`, `-line` and `-accent` are removed; use the `--sempods-*`
  names. The TODO example no longer ships the known-Pod sign-in recipe: use
  `AppAccess` with a `preset` (and `podAddress="hidden"` for one permitted Pod).

- **Stored sessions.** 0.6 reads records of 0.5. A re-authorization written by
  0.6 holds the earlier session; downgrading to 0.5 is not supported.
- **Leave confirmation in the top layer.** The provider's "Discard unsaved
  changes?" prompt is now a native modal `<dialog>` (still role
  `alertdialog`, same texts and buttons) instead of a fixed `div` with
  `z-index: 1000`. It shows above app dialogs opened with `showModal()`.
  Remove any z-index workaround for it; tests that find it by role keep
  working. Without top-layer support (for example jsdom) it renders in place.
- **`AppAccess` description.** The new optional `description` prop shows a
  short line under the app name on the sign-in screen; it is display only.
- **Lists keep their rows while reloading.** `useList` now does this by
  default: its `loading` and failed `state` carry the last rows as `previous`,
  and its new `data` is what to render (current or kept rows). Pass
  `retain: false` for the 0.5 behaviour. `useLoad` and `usePodLoad` accept
  `{ retain: true }`; `createViewLoader` takes the same option as a third
  argument. Code that builds `LoadState` values itself still compiles;
  exhaustive checks over `kind` are unchanged.
- **Management as a dialog, with fewer details.** `AppAccess` takes
  `onClose`: with `open` it shows management as a native modal dialog (title,
  **Close**, Escape, a click beside it) that checks the access again when it
  opens, so it has no **Check access**. Replace an app-owned dialog around
  `AppAccess` with `open={open} onClose={() => setOpen(false)}`. Management in
  general no longer shows the app icon or **Full addresses**, names one
  readable, selected Context instead of offering a choice, and shows the chosen
  Context's access instead of the **Available to this app** list, which remains
  only where there is no selection (on-demand management). Tests that looked
  for those elements in management need updating.
- **Write lanes belong to the controller (#156).** A pending or unresolved
  write of `useFieldUpdate` or `useCreation` keeps its outcome and leave guard
  while its screen is unmounted, remounted or hidden by `<Activity>`; before,
  unmounting dropped it, and hiding let a guarded change pass a pending write.
  A guarded change now asks about such a write even when no screen shows it.
  `useCreation` forms of one collection now share one creation: while it is
  pending, unconfirmed or held for a same-IRI retry, every such form (also
  one remounted or shown again) shows it, locked, and none sends another; a
  hidden or unmounted form starts no new creation. Two forms of the same
  collection that should create independently need a new `id` option each.
  Changing `collection` or `id` resets the draft like a definition change.
  A field definition change no longer drops a pending write (and no longer
  warns about it).
- **Editors belong to the controller.** `useResourceEditor` and
  `useContextEditor` keep their editor's draft, pending save, review and leave
  guard while the screen is hidden by `<Activity>` or remounted, and return the
  same editor; before, hiding or unmounting disposed it, dropped the draft,
  ignored a pending save's outcome and let a guarded change pass it. A guarded
  change now asks about unsaved editor work even when no screen shows it. A
  definition change for the same subject still starts a fresh editor (and
  warns about discarded work).
- **Write lanes per resource in `useFieldUpdate`.** The hook keeps one lane
  per resource; new `mutate.for(item)` returns a row's `data` (with a
  confirmed update shown at once), `canMutate`, `notice`, `update(change)` and
  `remove()`, and an unresolved write survives its row being unmounted;
  `unresolved` lists the IRIs that still need a check, so an app can show
  `mutate.for(iri).notice` for a row that left the list. After a confirmed
  update, the snapshot it was made from stays locked until the list reads
  again.
  `canMutate`, `outcome`, `notice` and `acknowledge` keep their list-wide
  meaning. A write for another resource is no longer refused while one is
  pending or unresolved; apps that disable on `canMutate` behave as before.
- **Mutation results are never `undefined` (needs action).** `update`,
  `remove` and `create` of `useFieldUpdate`, and `useCreation`'s `create`,
  resolve `{ kind: 'not-sent', reason }` when they send nothing
  (`unavailable`, `busy`, `unresolved`, `stale`, `invalid`, `ended`) and
  otherwise the sent write's outcome, also when the target ended meanwhile (it
  was `undefined`). Replace checks for `undefined`. A batch stops at the first
  result that is not `created`; only an item not sent because the target
  `ended` returns to the input.
- **Stable commands, more types, `data` on loads.** Hook commands keep their
  identity for one target and definition. New exported types: `FieldUpdate`,
  `FieldUpdateRow`, `FieldUpdateState`, `FieldUpdateNotice`, `NotSent`,
  `ContextList`. `useLoad` and `usePodLoad` return `data` like `useList`.
  `locale` and `language` accept `undefined` (same as leaving them out).
- **Smaller conveniences.** `<UnresolvedNotices of={mutate} shown={items} />`
  renders the notices of unresolved writes whose row is gone; `useLoad` and
  `usePodLoad` take `key` (a changed value reads again, without kept data);
  `<AccessNotice only="write" />` says only that the target is read-only;
  `text(…, { trim: true })` stores values without outer whitespace in creation
  and update (remove app-side `.trim()` before `create()`); `DraftOf` also
  takes a definition (`type Task = DraftOf<typeof taskFields>`).
- **Problems are announced at once.** `UpdateNotice` and `ResourceEditor`
  render failures, conflicts and unconfirmed outcomes with `role="alert"`
  (confirmed successes keep `role="status"`); tests that found them by the
  `status` role look for `alert`.
- **App texts and sharing.** `useMessages({ en, de })` returns the app's own
  texts in the provider's language (German, when given, needs every key);
  replace `language === 'de' ? … : …` in components. `useContexts()` returns
  `canShare`, `share()` and a localized `shareProblem`; replace app code that
  called `useApp().authorize` with its own error state.
- **`usePodList`.** A new hook lists one type from every readable Context of
  the Pod as real snapshots, with a state, problem and retry per Context and a
  `complete` flag; `LoadNotice` names partially read overviews (new optional
  message `partialRead`). Nothing existing changes.
- **`useContextUpdate` (#158).** A new hook writes `usePodList` rows in one
  click, each in its own Context, with `useFieldUpdate`'s row semantics and a
  controller-owned lane per resource; `UnresolvedNotices` accepts it. Replace a
  hand-written `useContextEditor` toggle (open, wait, change, save, close) with
  `overview.for(item).update(change)`. New optional message `contextProblems`
  holds SDK texts for `ContextEditorProblem`; drop the app's own map. Nothing
  existing changes.
- **`RemoveButton`.** A new component asks with `ResourceEditor`'s delete
  question before it calls `onRemove`, for a delete in a list row with
  `useFieldUpdate`'s `remove`, shown as a quiet trash icon. Nothing existing
  changes.
- **Calmer SDK controls.** Fields in SDK surfaces have an 8px radius and their
  focus ring on the border; `ResourceEditor`'s **Delete** uses the muted
  colour; with `onClose` the editor is a card with a tinted background and
  padding. Apps that drew their own card around an inline editor can drop it;
  screenshot baselines need updating.
- **Creating in an explicit Context.** `useCreation` takes `context` to create
  in a Context other than the selected one, reports `refused`, and resolves every sent `create()` with the captured
  `iri` (tests comparing the outcome with `toEqual` need the `iri` or
  `toMatchObject`).
  `bindCreation` is the headless counterpart. `useDraftGuard` and leave guards
  accept the scope `explicit` (survives row navigation and Context selection).
  The [task-with-note recipe](../examples/todo/recipes/task-with-note.tsx)
  writes one input into two Contexts.
- **`useContexts()`.** A hook for apps that switch between Contexts in their
  own UI (a list switch): readable Contexts with names and access, the
  selected one, a guarded `select`, catalogue state with `retry`, and a default
  selection (first writable) when nothing is remembered or preset. While it is
  mounted, `AppAccess` shows no chooser and management names only the selected
  Context. Replace app-written catalogue, label and selection code with it.
- **`LoadNotice`.** `<LoadNotice {...list} />` renders a read's loading,
  failure, cancelled and unavailable states with a retry, a note for kept rows
  after a failed refresh, and the count of entries it cannot show, in the SDK's
  languages. It replaces app-written branches over `list.state.kind`.
- **Lists skip values the definition does not accept.** `listSubjects` and
  `snapshots` (client SDK) count a subject whose values fail the definition's
  `valid` (for example an empty required text) in `skipped` instead of
  returning it: no update could write such a row back. Remove app-side filters
  such as `items.filter((item) => definition.valid(item.data))`.
- **`ResourceEditor` `onClose`, Enter and the action order.** With `onClose`
  (pass the guarded `() => select(null)`) the editor works in place: Cancel or
  Escape discards and closes, and a confirmed save or delete closes it. In
  every editor Enter in a text field saves, actions read as text with Save
  filled, Delete moves to the end and asks in a modal dialog (role
  `alertdialog`, as the leave confirmation; it was an inline `group`), and both
  dialogs follow the `--sempods-*` tokens, including dark mode; tests that find buttons by position
  should find them by name.
- **Labels on explicit demand.** `runtime.loadContextLabels(id, iris)` and
  `useApp().loadContextLabels(id, iris)` read the labels of at most 20 named,
  readable Contexts into `catalogue.labels`, for example for a list menu.
  Nothing changes without the call: only the selected Context's label loads
  automatically. Test doubles that implement `BrowserRuntime` add the method.
- **Quiet success.** `UpdateNotice` and `ResourceEditor` accept `quiet` to show
  nothing for a confirmed save, creation or deletion; problems and unconfirmed
  outcomes still show.
- **Management shows the connected Pod first.** With `open`, `AppAccess`
  starts with the connected Pod and its access (see "Management as a dialog"
  above for what it no longer shows); signing in to another Pod moved to a
  collapsed **Connect another Pod** at the end.
  End-to-end tests that fill **Pod address** in management first expand that
  section. New message keys `controls.contextAccess`, `canRead`, `canChange`
  and `connectAnother` are optional in `UiMessages`.
- **On-demand management no longer asks for a selection.** In
  `contextSelection: 'on-demand'`, opening management still loads the
  catalogue but shows the **Data context** chooser only while a Context flow
  (`TargetScreen`) needs a selected Context. An app that let people pick its
  Context there mounts its Context flow, or offers its own guarded
  `selectContext` control.

## From 0.5.0 to 0.5.1

The patch keeps public APIs, existing message keys and result shapes. Check these points:

- **AppAccess wording.** The default EN/DE texts name one action once:
  **Pod address** / **Pod-Adresse** (`controls.yourPod`), **Pods & sharing** /
  **Pods & Freigaben** (`controls.dataAccess`), **Change sharing** /
  **Freigabe ändern** (`controls.updateAccess`) and **Sign out** /
  **Abmelden** (`controls.disconnect`). Signing out still only forgets the
  connection on this device; the new `controls.disconnectHint` says so beside
  the button. `controls.podHint` and `controls.loginHint` stay in the message
  shape but default to empty, which shows no hint line. App end-to-end tests
  that find controls by the old texts need the new ones; to keep a text, pass
  it through `messages.controls`.
- **Neutral default colours.** Without `--sempods-*` tokens the SDK surfaces
  use a neutral grey palette instead of the green accent: accent and text
  `#1f2933` / `#e5e7eb` (light/dark), muted `#6b7280` / `#9ca3af`, lines
  `#e5e7eb` / `#2d3138`, background `#fff` / `#111315`. An app that relied on
  the green default sets `--sempods-accent: light-dark(#226044, #8acda6)` and
  `--sempods-on-accent: light-dark(#fff, #14251b)` on an ancestor to keep it.
- **Complete catalogs still compile.** `controls.disconnectHint` and
  `controls.confirmRemove` are optional in `UiMessages`; `createLocale` fills
  them from the language defaults.
- **Delete asks first.** `ResourceEditor`'s **Delete** now shows an in-editor
  question (`controls.confirmRemove`) with **Delete** and **Cancel**; only the
  confirmation sends the `DELETE`. End-to-end tests press **Delete** twice, the
  second time inside the group named by that question. `editor.remove()`,
  `useFieldUpdate` and custom delete buttons are unchanged.
- **Compact checkboxes.** Checkboxes and radios inside SDK surfaces are 24px
  instead of 44px; a wrapping `<label>` keeps the 44px target. Wrap a bare
  checkbox in its label to keep a large target.
- **No chooser for an explicit target.** `useContextEditor` still loads the
  catalogue but no longer asks `AppAccess` for a selected Context. With
  `contextSelection: 'on-demand'`, `AppAccess` stays hidden while such an
  editor loads and offers no Context chooser for it; a failed catalogue still
  shows with **Check access**. An app that called `selectContext` before
  opening a row only to avoid the chooser can drop that call.

## From 0.4 to 0.5

Upgrade both packages together; Node 24.15 or newer stays the requirement:

```sh
npm install --save-exact @sempods/app-sdk@0.5.0 @sempods/client-sdk@0.5.0
```

Check these points:

- **A taken IRI is no longer `exists`.** `prepareCreation(...).run()` reports
  every failed create-only condition (`412`) as `unconfirmed`, because a
  browser can resend an applied creation and the resend then fails. Read
  `desiredObserved`: `true` means the IRI holds this body; `false` means another
  resource or none. Neither proves which request wrote it. `exists` remains in
  `CreateOutcome` but is deprecated and no longer reported. Code that chose a
  new address after `exists` must stop doing so: a differing resource may still
  be this creation's own, changed by another writer. Keep the item unconfirmed,
  show what the IRI holds and let the person settle it explicitly. `useCreation`
  already follows its unconfirmed recovery and needs no change.
- **Provider sign-in errors are classified.** A callback whose provider answers
  with an OAuth error other than `access_denied` was `callback` and left its
  attempt stored; it is now one of the new `OAuthProblem` values
  `login-required`, `interaction-required`, `consent-required`,
  `provider-unavailable` or `rejected`. The attempt is consumed and its
  connection ends with that cause and is retired, as after a denial: it stays
  listed until reload, then a new sign-in starts from the Pod address.
  `OAuthProblem` documents which error code maps to which value. Exhaustive
  switches over it need the new cases; `describeFailure` and the SDK catalogs
  already cover them. Override the texts through `messages.errors.oauth`.
- **No callback, no interaction outcome.** A startup without a callback now
  reports `interaction: 'none'` when storage or coordination fails or the
  runtime was already disposed (previously `failed`); read `storage` and
  `problem` for that failure.
- **Callback feedback clears.** `CallbackNotice` and `AppAccess` follow the new
  `AppSnapshot.callbackNotice`, which clears once the person selects another
  connection, disconnects one or starts a sign-in. After a failed callback the
  controller activates the connection that was being signed in to
  (`StartupReport.attemptConnectionId`), as it does after a completed one; a
  previously selected target returns when the person selects it again. An
  `interrupted` or `expired` session shows the new `controls.signInRequired`
  message instead of `readLost`.
- **No connection view while the first Context catalogue loads.** `AppAccess`
  now shows only its loading status during that load, instead of the disabled
  chooser, the pending-catalogue notice, **Update access** and **Check
  access**. App end-to-end tests that waited for those controls in that phase
  should wait for the chooser, the hidden surface or the failure view instead.
- **A success notice retires when another write starts.** `created`, `saved`
  and `removed` from `useCreation`, `useFieldUpdate` and `ResourceEditor` now
  clear once another of them starts a write on the same target, and are not
  shown if one started while they were pending, so notices rendered side by
  side no longer pile up. Failures and unresolved outcomes are
  unchanged. Code that read `creation.outcome?.kind === 'created'` later, after
  another write, now sees `null`; read the result `create()` returns instead.
- **A leave prompt ends with its connection.** When the leave policy asks
  before a guarded action (`selectContext`, `navigate`, `selectConnection` and
  the others) and the connection that was active then stops being active
  outside such an action (a returning sign-in, or that connection removed), the
  prompt is cancelled: the action resolves `false`, nothing runs and no draft is
  discarded. Previously confirming ran the stale action, for example changing
  the inactive connection's Context. A prompt asked while no connection was
  active is unaffected. Headless hosts close their own prompt when
  `confirmingLeave` turns false.
- **No Context view before startup settles.** `AppSnapshot.view` (and with
  it `useView()` and `TargetScreen`) stays `null` until `startup` or
  `startupError` is set. On a callback page, a saved session could otherwise
  expose an editable screen while the returning sign-in was still being
  redeemed, and a draft started there was lost when that connection became
  active. Without a callback nothing changes in practice. Tests that act on a
  view right after rendering should wait for startup to settle first. Pod
  reads through `pod` stay available.
- **Fewer re-renders.** `useView()` re-renders its component only when the
  view changes, no longer on every app state publish such as a token renewal
  or another connection's catalogue. A component hosting `useContextEditor`
  re-renders only for the editor's own facts. A component that read other app
  state outside `useAppState` and relied on those re-renders should read it
  through `useAppState`.
- **Custom runtimes.** `BrowserRuntime` gained the required member
  `bindContext`. A fake runtime or test double typed as `BrowserRuntime` must
  provide it.

New in 0.5:

- `useContextEditor(definition)` edits a Pod-overview row in the Context its
  `GRAPH` binding names, through `runtime.bindContext`, without changing the
  selection. An app that copied the 0.4 overview recipe's `EditInContext`
  component can replace it: call `edit.open({ subject, context })` from the row,
  render `edit.editor` with `ResourceEditor`, and present `edit.problem` when
  `phase` is `unavailable`. Unlike that component, the hook no longer selects
  the row's Context, so a creation form elsewhere keeps its target. See
  [editing an overview row](react-authoring.md#editing-an-overview-row).
- A third leave-guard scope, `connection`, for drafts bound to an explicit
  Context: a Context selection neither asks about nor discards them, and their
  pending writes do not block it; row navigation and connection actions still
  do. `useDraftGuard` accepts it as its third argument. Existing scopes and
  unscoped guards behave as before. Code that switches exhaustively over
  `LeaveGuard['scope']` needs the new case.
- `runtime.bindContext(id, contextIri)` binds a `BoundView` to an explicit
  Context without changing the selection, with its own read invalidation; see
  [bind an explicit Context](browser-runtime.md#bind-an-explicit-context).
  Writes through the SDK's editors and hooks on it refresh lists and retire
  success feedback on the selected view of the same Context, and the other way
  round.
- `AppAccess` accepts `podAddress="hidden"` to omit the Pod address from
  signing in when the runtime permits exactly one Pod. It defaults to
  `'visible'`, so existing apps are unchanged; see
  [login composition](react-authoring.md#sign-in-and-pod-addresses).

## From 0.3 to 0.4

Upgrade both packages together; Node 24.15 or newer stays the requirement:

```sh
npm install --save-exact @sempods/app-sdk@0.4.1 @sempods/client-sdk@0.4.1
```

Session storage, guards and write recovery are unchanged, and the defaults keep
0.3 behaviour except for labels. Check these points:

- **Context labels.** The runtime now loads the registry label only for the
  selected, validated Context, in both `contextSelection` modes, and no longer
  reads labels for other catalogue entries. Picker entries without a label show
  a derived name or the IRI. Tests or UI that expected names in
  `catalogue.labels` for unselected Contexts need updating.
- **Stricter IRIs in the edit helpers.** Field predicates, `fields({ type })`,
  `flag()` on/off values and the `listSubjects` type now throw `TypeError` for
  IRIs containing U+0000–U+0020, and an `iri()` value containing one makes the
  draft invalid. Such IRIs could not be embedded in SPARQL or Turtle.
- **Custom Pods, runtimes and snapshots.** These interfaces gained required
  members:
  - `Pod.sparql`: a custom `podFactory` result or a `Pod` test double must
    provide it, because `runtime.bindPod` builds readers through the factory.
  - `BrowserRuntime.bindPod`: a fake runtime must provide it, because the app
    controller calls it.
  - `AppSnapshot.pod` and `AppSnapshot.contextSelection`: hand-built snapshots
    must add them.
- **`createViewLoader`** has overloads for views and Pod readers. Existing
  `(view, read)` calls are unaffected.

New in 0.4:

- Pod-wide SPARQL reads without selecting a Context: `pod.sparql.select()` and
  `construct()` with the `SelectResult`/`SparqlTerm` types; see
  [reading across the Pod](../packages/client-sdk/README.md#reading-across-the-pod).
- `runtime.bindPod(id)` returns a `BoundPod` with its own read lifetime; see
  [read the authorized Pod dataset](browser-runtime.md#read-the-authorized-pod-dataset).
- `usePodLoad` / `PodRead` and the `contextSelection: 'on-demand'` option on
  `SempodsProvider` and `createAppController`. The default `'required'` keeps
  automatic catalogue loading; see
  [Pod overviews with Contexts on-demand](react-authoring.md#pod-overviews-with-contexts-on-demand).

## From 0.2 to 0.3

Upgrade both packages together; Node 24.15 or newer stays the requirement:

```sh
npm install --save-exact @sempods/app-sdk@0.3.0 @sempods/client-sdk@0.3.0
```

Session storage, guards and write recovery are unchanged. Three changes can
need attention:

- **Field types.** `TextField` (and the new `DateTimeField`) carry their optionality as a
  type parameter. A field annotated as plain `TextField` now reads
  `string | null` in drafts, because its optionality is unknown; annotate a
  required field as `TextField<false>` to keep `string`. Fields used without an
  annotation are unaffected.
- **AppShell presentation.** `AppShell` now shows the new access UI; see
  [access UI and AppShell](#access-ui-and-appshell). Tests that matched raw
  context IRIs or the previous labels need updating.
- **Dark appearance.** SDK components follow the page's color scheme instead of
  the operating system's. Add `:root { color-scheme: light dark; }` to the app
  CSS to keep automatic dark appearance.

New in 0.3:

- `dateTime(predicate, { optional })` in `@sempods/client-sdk/edit` reads and
  writes one `xsd:dateTime` literal. Store points in time with it rather than
  as text; values need an explicit time zone.
- `allowedPods` restricts a browser runtime to exact Pod URLs, separately from
  `preset`; see [restrict the permitted Pods](browser-runtime.md#restrict-the-permitted-pods).
- `@sempods/app-sdk` ships its app-author reference. Point your coding assistant
  to `node_modules/@sempods/app-sdk/docs/ai-app-builder.md`; it matches the
  installed version.
- Creating several resources from one input is a documented pattern; see
  [several resources from one input](react-authoring.md#several-resources-from-one-input).
- `AppAccess` is a composable sign-in and access-recovery surface for app-owned
  layouts, with optional `podNames` for readable Pod names.
- Context selectors show readable names: the runtime reads each context's
  registry label (`rdfs:label`) in the background, and client-sdk exposes
  `contextDescription()` for the same read.
- SDK access, notice and editor components share inherited `--sempods-*`
  theme tokens.

### Access UI and AppShell

Existing `AppShell` calls use the new access UI without changing app code. The
shell now has a title and **Data access** button; connection administration hides
when the target is usable, including read-only access, and opens explicitly.
`title`, `style` and `components={{ Connections: MyPicker }}` remain supported.
Replacement controls follow the same open/recovery visibility; they are no longer
always mounted. Keep app drafts/controllers in the shell content, not inside a
replacement picker. `mode="single"` remains presentation only; `allowedPods`
enforces a Pod restriction. Content still waits for durable startup, then remains
mounted during same-target access loss and management changes.

`ConnectionControls` remains available for custom layouts. Selectors now show
readable Pod/context names and disambiguate duplicates; **Full addresses** exposes
the identities. Context names prefer the runtime's description labels and fall
back to the final path segment. Late labels preserve selection and drafts.
Select option values stay exact. Tests or code that matched raw
IRI text should use the option value or accessible control name instead. The
AppShell free input is **Your Pod** / **Dein Pod** with **Sign in** / **Anmelden**;
access refresh is **Check access** / **Zugriff prüfen**. Existing direct
ConnectionControls keeps its form/action labels.

All SDK access, notice and editor components share the
[scoped styling baseline](react-authoring.md#shared-sdk-appearance). Set inherited
`--sempods-*` tokens to theme them together; previous `--sempods-access-*` variables
remain fallback aliases. Root `style` still styles the AppShell container;
component controls use the shared tokens. SDK surfaces now inherit the host color
scheme: use `:root { color-scheme: light dark; }` in the app CSS to enable automatic
dark appearance, and adapt any hard-coded page colors accordingly. Embedded notices,
editors and connection controls have transparent backgrounds. There is no stylesheet import. The CSP
must permit the inline styles, or the host supplies hook-based custom UI.
App-owned list rows and other content outside SDK controls/editors remain unstyled.
Target guards, conflict review and unconfirmed-write recovery are unchanged.

## From 0.1 to 0.2

0.2 requires **Node 24.15 or newer** (Node 24 LTS) for development, builds and
Node scripts; Node 22 is in maintenance and reaches end of life in April 2027.
Switch your local and CI Node version, then upgrade both packages together:

```sh
npm install --save-exact @sempods/app-sdk@0.2.0 @sempods/client-sdk@0.2.0
```

The public API is unchanged. client-sdk now uses `oauth4webapi` 3.8.8, which
fixes the parsing of `WWW-Authenticate` challenges and validates ID-token
subjects as strings; no app code needs to change. Browser support is unchanged.

## Move one app flow at a time

1. Record the old app's origin, client identity, SDK revision and data vocabulary.
   Inspect a synthetic representative resource: type, predicate IRIs, languages,
   status values and relationships. The task example is not a universal migration
   schema. Back up data through the Pod's supported tools before any data conversion.
2. Install matching client-sdk/app-sdk versions using the
   [package workflow](quickstart.md). Verify package identity and exports; a legacy
   package with a similar name is not necessarily this SDK. Commit the lockfile.
3. Replace the old browser auth/session integration with one app-sdk runtime and
   provider. Remove the previous coordinator when switching the flow. Use fresh
   login and consent; do not import localStorage tokens or session database records
   from the old implementation.
4. Map the existing vocabulary with `fields()` and use the
   [authoring hooks](react-authoring.md). Keep compatible RDF unchanged and surface
   incompatible entries. Adopt snapshot-based edits, explicit target selection and
   guarded navigation before adding more features.
5. Run [the testing checklist](local-testing.md) against a test context. Verify
   old and new app interoperability before using existing personal data. Test a
   clean install and a returning browser separately.

Use the [client reference](../packages/client-sdk/README.md) for the portable
OAuth API and the runtime for browser applications. Do not adapt an old auth flow
by casting its objects to new types.

## Know what persists

The runtime stores validated, versioned session records in IndexedDB and uses Web
Locks for one active runtime per configuration. The current namespace uses identity
kind plus the did:web client ID, or the dynamic redirect URI. Display-name changes
are not a new namespace. Unsupported or corrupt records are
reported as unreadable and retained; they are not silently converted or erased.
See [the runtime contract](browser-runtime.md) for details.

An app origin change also changes browser storage access. A new DID changes app
identity and can require new grants. Moving a did:web app's callback route
within the same identity (same host and DID path prefix) keeps signed-in
sessions: they restore and record the new route on their next write. A login
still in progress keeps its old callback and is reported as unreadable after the
move, so complete or abandon logins before such a deployment. A new DID or a
dynamic client's new callback starts without saved sessions. A callback outside
the DID's host, port or path is an invalid configuration, not a migration: saved
records are reported unreadable and a fresh sign-in fails too, until the DID and
callback are made consistent again. Keep old and new app configuration/version
notes so recovery can be deliberate.

## Recover through supported actions

| Observation                                       | Next step                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Another tab is active (`busy`)                    | Close/dispose that runtime, then reload this tab; do not steal the lock                                     |
| Durable storage unavailable                       | Restore browser storage/Web Locks support, then reload; no silent in-memory fallback                        |
| Expired, interrupted or rejected login            | Start a fresh sign-in through the app's connection controls                                                 |
| Session ended after refresh or continuity failure | Sign in again; never replay a consumed refresh token or edit stored evidence                                |
| Unreadable record                                 | Record only its safe reported status and SDK version; investigate compatibility before clearing anything    |
| Unconfirmed data write                            | Use the editor/update recovery on the original resource; session reconnection is not proof the write failed |

Use guarded **Sign out** (`disconnect`) to remove a readable connection and its stored secret
material; it does not revoke server grants or delete Pod data. If unreadable state
makes a full browser site-data reset necessary, first preserve unsaved work and
obtain the person's agreement: clearing site data can remove every app's local
state on that origin and requires fresh sign-in. Never upload a browser storage
dump, token or PKCE verifier in a bug report.

A static-host rollback restores app files, not the Pod's previous data or the
browser's previous storage schema. Recheck runtime compatibility and sign in afresh
when needed. Treat any vocabulary conversion as a separate, reviewed data migration
with explicit scope and a recovery plan.
