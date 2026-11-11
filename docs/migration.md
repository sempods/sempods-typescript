# Upgrade an app and recover a session

Use this guide when moving an older frontend onto app-sdk, changing a deployment
identity or updating a preview SDK. It describes a deliberate migration, not an
automatic conversion of legacy app data or stored credentials.

## From 0.7.0 to 0.8.0

0.8.0 is not released yet; this section collects its upgrade steps. The
prerelease `0.8.0-dev.1` carries them, and the
[0.8.0 release notes](releases/0.8.0.md) list the changes.

### Remembered Pods

**A Pod address now outlives its session**
([remembered Pods](browser-runtime.md#remembered-pods)). Sign-out and a session
that ends keep the connection with its address, as
`session: { kind: 'signed-out', problem?: RuntimeProblem }`, also after a
reload, so people sign in again with one action.

- **`disconnect(id)` keeps the connection.** It used to remove it from the
  snapshot; now it stays listed as `signed-out` with
  `problem: 'disconnected'` and its remembered Context choice. Code that waited
  for the connection to disappear, or counted connections after a sign-out,
  uses the new `forget(id)` (`useApp().forget(id)`), which deletes the record
  and the choice, or checks `session.kind`.
- **Records written by 0.7 keep working.** Pods that were signed out or whose
  session ended under 0.7 were hidden at startup; after the upgrade they are
  listed as `signed-out` without a `problem`, because 0.7 did not record why.
- **Opt out with `rememberPods: false`** in `createBrowserRuntime` for shared
  devices or privacy-sensitive apps. Sign-out then removes the connection as
  before, and the record is deleted instead of kept as a tombstone; startup
  also deletes records an earlier start remembered.
- **Choosing the active connection.** Without an earlier choice, the app
  controller prefers a connection with a session over a remembered one, and
  when the active connection signs out it gives way to one with a session.
  A leave prompt about a connection that signs out is cancelled.
- **`AppAccess`** lists remembered Pods on the sign-in view, above the address
  field, with **Sign in** and **Forget**, and under **Connect another Pod** in
  management. Its Pod selector no longer lists remembered Pods.
- **Connection lists include remembered Pods.** `useAppState().connections`,
  `useConnections()` and the groups of `usePodContexts()` now also contain
  remembered Pods (`signed-out`) and Pods being forgotten
  (`ended { forget: true }`). An app's own Pod menu or a custom
  `components.Connections` built on them shows these too; filter by
  `session.kind`, or offer **Sign in** (`authorize`) and **Forget** (`forget`)
  for them as `AppAccess` does. Check end-to-end
  tests that expected an empty address field after a sign-out or that look up
  **Sign in** by name alone: each remembered Pod has its own. `AccessNotice`
  asks to sign in (`controls.signInRequired`) for a signed-out connection.

### Access prompts

**`AppAccess` keeps its props but changes how it presents access**
([access prompts](react-authoring.md#access-prompts-and-your-own-placement)).
It is now `AccessGate` + `ContextAccess` + `AccessPrompts` + management:

- **The sign-in screen is a gate above the content.** While the app cannot
  work (no connection, the active connection signed out, its session ended,
  its sign-out not saved or its required scopes missing, a startup problem) a
  full-viewport modal layer shows; the content stays mounted and inert behind
  it. Tests that looked for sign-in controls inside the `Pods & sharing` region
  find them in the gate (`[data-sempods-ui="gate"]`). After a failed sign-out
  or forget the gate offers **Try again**, not **Sign out** or **Forget**.
- **No initial loading panel.** Before startup settles and while a saved
  session restores, `AppAccess` shows nothing: no tall loading panel, no
  sign-in flash. A restore that has not settled no longer shows the Pod selector
  or other sign-ins inline; open management for them.
- **Outcomes are dismissible prompts.** A failed or cancelled callback, a Pod
  whose session ended beside the active one and an unreachable Pod appear at
  the bottom of the viewport. Information (a cancelled sign-in, unchanged
  sharing) hides after about 6 seconds; **OK** or Escape dismisses a prompt.
  The callback notice no longer stays until the next sign-in or selection. A
  declined re-authorization no longer offers **Change sharing** again; it is in
  management.
- **Management in place** (`open` without `onClose`) does not show while the
  gate blocks. As a dialog it opens above the gate.
- **Your own placement:** render `AccessGate`, `ContextAccess` and
  `AccessPrompts` (or your own `AccessPrompt` host) and
  `<AppAccess only="management" open={open} onClose={onClose} />`, which
  renders management alone.
- **Accepted limitation for drafts:** after the session is lost, the person can
  neither view nor copy a retained draft while the gate shows. Signing in again
  navigates to the Pod, so the leave confirmation may ask to discard it.
  Declining keeps the draft in memory behind the gate for as long as the page
  stays open. Apps that must keep drafts across a sign-in store them
  themselves.

### Lost renewal answers

**A lost answer to a renewal no longer signs people out**
([lost renewal answers](browser-runtime.md#lost-renewal-answers), #239). The
refresh claim now keeps the sent refresh token, and the runtime sends it once
more while it was first sent less than `refreshGracePeriod` ago (default 60
seconds, the sempods server's default).

- **The stored refresh claim holds the refresh token** until it settles. It
  still holds no access token. Retiring or replacing the claim removes it.
- **Offline during a renewal** reports
  `ended { problem: 'network', restorable: true }`, as for an unreachable Pod at
  startup, and resends when the browser comes back online or on
  `retryRestore(id)`. Offer a retry there, not a sign-in.
- **The session ends as `interrupted`**, keeping the Pod address, when the
  outcome stays unknown beyond the grace period or the resend loses its answer
  too. Under 0.7 such a session ended with `exchange`; a refusal of the token
  endpoint still ends with `exchange`.
- **A token request is given up after 20 seconds** and counts as lost; there
  was no limit before. An answer that is neither a token response nor an OAuth
  error (`400`, `401`), such as a `5xx`, `403`, `404`, `408` or `429` from a
  proxy, counts as lost too.
- **Downgrading to 0.7** reads such a claim as `interrupted` and leaves it
  stored, with its refresh token, until the person signs in again or signs
  out.
- **A refresh the earlier page left** (reload or a suspended tab during the
  request) is resent once at the next start within the grace period
  (`restoring` → `active`) instead of ending as `interrupted`. Refresh claims
  written by 0.7 hold no token and still end as `interrupted`.
- **A Pod without a grace period** refuses the resend as reuse, so the session
  ends as under 0.7. Set `refreshGracePeriod` to your Pod's period; `0` never
  resends.

### Bounded discovery

**A Pod whose discovery never answers no longer stays `restoring`**
([browser runtime](browser-runtime.md#configure-initialize-connect), #253). After 15
seconds, discovery counts as unreachable:

- a restoring connection ends as `ended { problem: 'network', restorable: true }`
  and keeps its saved session; `retryRestore(id)` and coming back online try
  again, as for an offline Pod. A late answer is ignored.
- `connect(url)` and `beginAuthorization(id)` reject with
  `RuntimeError('network')` when discovery does not answer, instead of
  waiting indefinitely (client registration is not bounded), and a renewal
  whose discovery stalls stays signed in with its unspent refresh token.
- A timeout carries no `failure` detail, unlike an offline discovery
  (`failure.code: 'discovery'`); branch on `problem` and `restorable`.
- Other connections never waited for a restoring one. A custom layout that
  disabled all its controls while any restore was pending, as the guide used
  to say, now disables only the restoring connection's sign-in: adding a Pod,
  choosing another one and the other connections' actions stay enabled
  ([custom layouts](react-authoring.md#custom-layouts-without-appaccess)).
  `AppAccess` keeps them enabled too.

### Captured work after a session ends

**Drafts and unresolved writes now outlive an ended session also in explicit
Contexts and while their screen is away**
([captured work](decisions.md#captured-work-outlives-access-not-authorization),
#274). Resource editors (`useContextEditor`), creations (`useCreation` with
`context`) and row updates (`useContextUpdate`) keep their work when the
session ends or the connection reads without a token, also when the screen
was hidden or unmounted, and find it again; before, it could be lost.

- **Opening the same row again returns to its work.** After a session ended,
  `useContextEditor().open()` for the row it shows no longer asks to leave
  its draft and starts no fresh editor: it keeps the draft or review. Close
  it (`close()`) and discard to start fresh. End-to-end tests that expected a
  leave prompt there expect none now.
- **A new sign-in starts fresh.** Work captured before is never handed to a
  new authorization, as before, and a draft discarded through a leave
  confirmation is gone: a mounted `useContextEditor` without work follows
  the current view with a fresh editor, instead of keeping the discarded
  text and asking about it again.
- No public types change.

### Apps without sign-in

**Apps can read public data without a session**
([apps without sign-in](browser-runtime.md#apps-without-sign-in), #240). Existing
apps keep `signIn: 'required'`, the default, and behave as before. To adopt it:

- Set `signIn: 'optional'` for an app that reads public data first and offers
  signing in, or `signIn: 'none'` with a `preset` (or one `allowedPods` entry)
  for an app that never signs in; `none` needs no `identity`.
- Move `scopes.required` to `scopes.optional` under `optional`; under `none`
  remove `scopes`. Both are configuration errors otherwise.
- Code that checks `session.kind === 'active'` to decide whether a connection
  can be read, or bound, checks `connection.reading !== null` instead: a
  connection reading without a token is `signed-out`.
- `useApp().connect(url)` opens a Pod without signing in under `optional` and
  `none`; call `authorize(id)` to sign in.
- End-to-end tests of an `optional` app expect no sign-in screen, an
  `anonymous` prompt with **Sign in**, and **Open** instead of **Sign in** on
  the address field.

### Bounded Pod reads

**An app can bound its explicit Pod reads**
([bounded Pod reads](browser-runtime.md#bounded-pod-reads), #244). The new
option `podReadLimit: { perPod?, total? }` admits at most that many requests
in flight per Pod URL and across all Pods; further reads wait, with Pods
taking turns. Without the option nothing changes.

- **Remove an app-side queue in front of `BoundPod.sparql.select`** and set
  `podReadLimit` instead. An app queue releases its slot when a cancelled read
  returns, before the request settles, and a loader whose read waits there
  spends its one recovery retry on grant changes: two changes while it waits
  end it `unavailable` without a request. The SDK holds the slot until the
  request settles, and waiting spends no retry.
- Pass `priority: 'current'` with the `signal` for the read of what the person
  looks at now.

### Find

**Pods can be searched through the SDK** (#233).
[`pod.find(text, options)`](../packages/client-sdk/README.md#finding-resources)
and `BoundPod.find` call the Pod's Find primitive. The answer is grouped by
source Context, and a refusal stays distinct from an empty answer.

- **Replace a hand-built `/_system/find` request** with `find`. The SDK sends
  the request and keeps credentials and the downscope on every attempt. The
  answer is JSON-LD grouped by Context (`FindGraph`), not N-Quads. Derive hits
  from `nodes` and the source from `context`.
- **Search several Pods with one loader per Pod**
  ([search across Pods](react-authoring.md#search-across-pods)), not with
  `Promise.allSettled`: a result kept from a settled promise outlives its
  grants.

### UI kit

- **The compact `Dialog` speaks the SDK's language.** Its corner close button
  and `DialogFooter`'s `showCloseButton` were always named "Close"; they now
  take the SDK's text in the provider's language (German: "Schließen"), and
  `closeLabel` sets another. Without a provider they stay "Close". End-to-end
  tests of a German app that find these buttons by "Close" look for
  "Schließen".
- **A press in an SDK confirmation no longer closes a compact `Dialog`.** As
  in `ScreenDialog`, cancelling a question above it keeps the dialog and the
  draft. An app's own `shouldCloseOnInteractOutside` still applies; a filter
  that only ignored `dialog:modal` can go.
- **`DateChooser` shows a value that names no real day as stored** (#262).
  `2026-02-30` used to read as 2 March and `2026-04-31` as 1 May; a date-time
  without a time zone (`2026-10-30T09:30:00`) was read in the device's zone.
  The button now shows these values unchanged, as it does a date-time that the
  `date` field rejects (`2026-10-30T09:30+02:00`, without seconds) and a year
  with more than four digits or a minus sign. Other days and zoned date-times
  are shown as before.

- **New: `WorkspacePanel`** for filters or details over a canvas or a map
  that stays usable behind them (the UI kit's README, "Adapters"). An
  app-owned panel composed from `ActionButton` and theme roles can move
  to it: it is a region named by its heading, takes the focus when it opens
  and returns it on Close or Escape, traps nothing, keeps the workspace's
  size and element, and keeps clear of safe-area insets. Remove the app's own
  Escape handling and focus return for it.

- **`ScreenDialog` keeps clear of device insets on phones.** Full screen
  (below 640px), its heading and scrolling content add
  `env(safe-area-inset-*)` to their padding, so in an app with
  `viewport-fit=cover` Close and the last action no longer sit under a notch
  or the home indicator. Without insets, and in the centred dialog, the layout
  is unchanged. Remove app CSS that added these insets around or inside a
  `ScreenDialog`, or they count twice.

### Dates

- **`format.dateOnly` and `format.dateTime` show years below 1000 with four
  digits** in the Gregorian calendar: `0050-03-01` is `01.03.0050` in German
  and no longer `01.03.50`, which read like 1950. `DateChooser`'s button shows
  them the same way; its calendar's heading comes from React Aria and still
  shows the short year. Later years and other calendars are unchanged.
- **Both return `undefined` instead of throwing a `RangeError`** (#268), for
  every value they cannot show; nothing they format throws any more. This is
  a breaking change of the return type, `string` to `string | undefined`.
  TypeScript reports `const text: string = format.dateOnly(value)`, but
  `{format.dateOnly(value)}` in JSX still compiles and now renders nothing
  where a `catch` showed the stored value. Replace each `try`/`catch` around
  them with `format.dateOnly(value) ?? value` and
  `format.dateTime(value) ?? value`.
- **Both show years 0001 to 9999 only.** `0000-01-01` (1 BCE), which
  `dateOnly` showed as `01.01.1` without its era, now gives `undefined`. For
  `dateTime` the year in its time zone counts: `0001-01-01T00:00:00Z` gives
  `undefined` in New York, where it is 31 December of year 0, and
  `9999-12-31T23:30:00-01:00` gives `undefined` in UTC, where it used to show
  as `Jan 1, 10000`.
- **`format.dateTime` reads a string only as an `xsd:dateTime` with a time
  zone on a real day**, the form the `dateTime` field accepts. It used to
  format anything `new Date()` parses: `2026-10-29` and
  `2026-10-29T10:00:00` (read in the device's zone) now give `undefined`, and
  `2026-02-30T10:00:00Z` no longer shows as 2 March. `T24:00:00` is the next
  midnight in every engine. A `Date` argument is formatted as before, within
  the year range.
- **New: `classifyDate` in `@sempods/client-sdk/edit`** tells whether a stored
  lexical form is a calendar day (`kind: 'day'`, with a reported time zone),
  an instant with a time zone (`kind: 'instant'`, with
  `epochMilliseconds`) or neither (`kind: 'unsupported'`). The `date` and
  `dateTime` fields, both formatters, `DateChooser` and the
  [RDF value recipe](rdf-values.md) use it, so they agree on every value; what
  the fields accept is unchanged. Code that checked XSD forms with its own
  pattern can use it.
- **`@sempods/app-ui` has `@sempods/client-sdk` as a peer dependency** of the
  same minor version, as its install line already listed. `DateChooser` shows
  a stored `0000-01-01` as stored and opens without a chosen day; it used to
  treat it as `0001-01-01`. It also opens without a chosen day on a value the
  `date` field rejects, such as `2026-10-29+99:99` (formerly 29 October) or a
  date-time without a time zone, and shows those values as stored.
- **The RDF value recipe** shows `xsd:date` and `xsd:dateTime` values from
  0001 instead of 1000 (`01.03.0050`) and `T24:00:00` instants formatted. A
  copied `readableDate` keeps working; the new one only picks the formatter.

### Type additions

- `SessionFact`'s `signed-out` variant gains the optional `problem`, and its
  `ended` variant the optional `forget: true` for a connection being forgotten
  or whose forgetting failed. Code that compares sessions by deep equality
  accepts these properties.
- `BrowserRuntime` gains `forget(id)` and `BrowserRuntimeOptions` gains
  `rememberPods`, `refreshGracePeriod` and `podReadLimit`. Typed test doubles of the runtime need `forget`.
- `BrowserRuntimeOptions` gains `signIn`, and its `identity` becomes optional
  in the type: it is still required unless `signIn: 'none'`, and construction
  throws `RuntimeError('configuration')` without it. `BrowserRuntime` gains the
  required `signIn`, and `AppSnapshot` the required `signIn`; typed test
  doubles need them.
- `Connection` gains the required `reading` (`'session' | 'anonymous' | null`),
  and `clientKind` may be `null` (only under `signIn: 'none'` without an
  identity). Test doubles that build `Connection` objects add `reading`.
- `AccessPrompt['reason']` gains `'anonymous'`. An exhaustive `switch` over it
  needs a case.
- `BoundPod.sparql.select` and `construct` accept `priority: 'current'` beside
  `signal`. A typed test double of `BoundPod` accepts the wider options.
- `Pod` (client-sdk) gains `find`, and `BoundPod` gains `find`. A custom
  `podFactory` result or a typed test double of `Pod` or `BoundPod` needs it.
  New client-sdk types: `FindOptions` and `FindGraph`. The `invalid-argument`
  failure's `argument` gains `'text'` and `'limit'`.
- `AppActions` (from `useApp()`) gains the required method `forget`. Typed test
  doubles of `useApp()` need it too.
- **Breaking for custom stores:** `SessionStore` (the `openStore` option) gains
  the required method `remove(id, expectedRevision)`, an atomic deletion at the
  expected revision that answers `{ kind: 'removed' }` or `{ kind: 'conflict' }`.
  The default IndexedDB store implements it.
- `UiMessages` gains `rememberedPods`, `forget`, `sessionEnded`,
  `forgetFailed`, `dismiss`, `reload`, `anonymous`, `open` and `noPublicData`,
  optional in the type; `createLocale` fills them from the language defaults.
- `AppSnapshot` gains the required `access` (`AccessState`), and
  `AppController` the method `dismiss(promptId)`. Typed test doubles of the
  snapshot need `access`. `AppSnapshot.callbackNotice` is deprecated and stays
  until 1.0.
- `AppAccessProps` gains `only?: 'management'`. New exports: `AccessPrompt` and
  `AccessState` (types, `@sempods/app-sdk`); `AccessGate`, `ContextAccess`,
  `AccessPrompt`, `AccessPrompts`, `useAccessPrompts` and the types
  `AccessGateProps`, `ContextAccessProps`, `AccessPromptProps` and
  `AccessPromptsProps` (`@sempods/app-sdk/react`).
- app-ui's `Dialog` and `DialogFooter` gain the optional `closeLabel`.
- `@sempods/app-ui`: `HeaderMenuProps` gains the optional `ref` to the menu's
  button. An app whose menu item opens `AppAccess` (Pods & sharing) passes
  that ref as `focusTarget`, so closing management returns the focus to the
  button; without it, the focus still falls to the page, as in 0.7
  ([UI kit guide](../packages/app-ui/README.md#adapters)).
- `@sempods/app-ui`: a `HeaderMenu` action (the new exported type
  `HeaderMenuAction`) gains the optional decorative `icon`. The label stays its
  accessible name and leads typeahead; text-only menus render as before. Apps
  that composed `DropdownMenu` directly only to place an icon can return to
  `HeaderMenu`.

- `usePodLoad` gains the form `usePodLoad(pod, read, options?)` for an explicit
  `BoundPod` from `runtime.bindPod(id)`
  ([reads per connection](react-authoring.md#reads-per-connection)). An app
  that wrapped `createViewLoader` in its own hook to read through several
  connections, as an explorer does, can use it instead; the existing form
  still follows the active connection.

## From 0.6.0 to 0.7.0

Upgrade client-sdk and app-sdk together, and the UI kit `@sempods/app-ui` to
the same version where the app uses it. See the
[release notes](releases/0.7.0.md). Most apps need no code change. Check the
cascade layers below first, then the behaviour changes.

### SDK styles in a cascade layer

**Breaking for apps with unlayered global CSS.** The SDK's sheets now sit in
the cascade layer `sempods` (see
[Shared SDK appearance](react-authoring.md#shared-sdk-appearance)), so app CSS
in a later layer, such as Tailwind 4's `components` and `utilities`, applies
on and inside SDK surfaces. In exchange, **every unlayered app rule now wins
over every SDK rule.** Before 0.7.0, AppAccess's own rules
(`[data-sempods-access] button`, `input`, `p`, `label`, `.sp-access-*`) beat an
app's global element rules; now a reset such as an unlayered Tailwind 3
preflight, normalize.css, Bootstrap's reboot or `* { margin: 0; padding: 0;
border-width: 0 }` reaches the sign-in screen: its main button loses its fill,
field borders disappear and spacing collapses. The other SDK surfaces already
gave way to such rules.

1. Declare the layer order at the top of the app's first stylesheet:
   `@layer theme, base, sempods, components, utilities;` (drop the names the
   app does not use).
2. Put resets and global element rules (`button { … }`, `input { … }`, `*`)
   into `base`, or scope them to the app's own elements (`.app button`).
   Element rules in a layer after `sempods` override the SDK just as well.
3. Check the sign-in screen, the Pods & sharing dialog, an editor and a
   confirmation with the app's real stylesheet.

Eight optional tokens map a UI kit's field border, the surface, text and border
of the main and the other actions, and the focus ring onto SDK surfaces; without
them nothing changes. A hovered main action now mixes its text into its surface.

### Behaviour changes

- **Leave prompt.** While a draft, a pending write or an unconfirmed write is
  left, reloading, closing the tab, typing an address or going Back past the
  app shows the browser's leave prompt
  ([selection and draft lifetime](react-authoring.md#selection-and-draft-lifetime)).
  End-to-end tests that leave the page with unsaved work must accept or
  dismiss the `beforeunload` dialog. Browsers show it only after the person
  has interacted with the page, so a test that waits for it without a prior
  click or key press can time out. Playwright runs the handler on closing a
  tab only with `page.close({ runBeforeUnload: true })`. An app that keeps drafts across reloads
  itself can pass `unloadPrompt={false}` to `SempodsProvider` (or
  `{ unloadPrompt: false }` to `createAppController`); keep it fixed.
- **Escape in `ResourceEditor` with `onClose`.** With unsaved changes, Escape
  now asks before discarding, like closing the surrounding dialog; without
  changes it closes at once. Escape in the editor, in its fields and on its
  own buttons, no longer reaches enclosing React handlers, so an app dialog
  around it does not close on the same key. Remove app workarounds that
  caught Escape around the editor.
- **Management on phones.** Up to 30rem wide, `AppAccess`'s Pods & sharing
  dialog is a full-width bottom sheet; wider screens keep it centred. Recheck
  app styles that positioned it.

### Type additions

- `Field` from `@sempods/client-sdk/edit` gains the `date` kind. An exhaustive
  `switch` over `field.kind` needs a `'date'` case.
- `SnapshotList` (and `useList`'s and `usePodList`'s data) gains
  `skippedRecords`. Test fixtures that build these objects by hand need the
  property, usually `[]`.
- `AppActions` (from `useApp()`) gains the required method `selectTarget`
  ([one chooser across Pods](react-authoring.md#one-chooser-across-pods)).
  Typed test doubles of `useApp()` need it too.

## From 0.5.0 to 0.6.0

Upgrade both packages together. The last published version before 0.6.0 is
0.5.0; there is no intermediate 0.5.1 release. See the
[release notes](releases/0.6.0.md).

```sh
npm install --save-exact @sempods/app-sdk@0.6.0 @sempods/client-sdk@0.6.0
```

Keep the lockfile and use the app-builder guide shipped with the installed SDK.
For a template-managed repository, update the tooling's SDK pins and peers too;
changing only an individual app's dependencies leaves its shared SDK inconsistent.

Start with these checks:

1. Replace `AppShell`/`ConnectionControls` with an app-owned layout and `AppAccess`.
2. Move row commands and feedback to `mutate.for(item)`. Move direct creation to
   `useCreation` with exactly one of `collection` and `iri`.
3. Handle `{ kind: 'not-sent', reason }` instead of `undefined`. Update exhaustive
   session switches for `leaving` and hand-built failure outcomes for `problem`.
4. Keep editor recovery reachable after a remount; selecting the same subject
   reopens its retained draft. Give independent creation forms in one collection
   different `id` values.
5. Check browser-language defaults, renamed controls and dialog roles in UI tests.
   Confirm deletion inside the new `alertdialog`. Pin `language="en" locale="en"`
   only if the app must remain English.
6. Check `did:web` hosts against the stricter domain rules below. In custom
   connection controls, offer a retry when signing out leaves `saved: false`.
7. Run the app's typecheck, tests and build. Exercise login, list reload, editing,
   guarded navigation and recovery in its deployment environment.

### API and behavior changes

- **One row mutation API (needs action).** `useFieldUpdate` now returns only
  `{ for, unresolved }`, matching `useContextUpdate`. Replace
  `mutate.update(item, change)` with `mutate.for(item).update(change)` and
  `mutate.remove(item)` with `mutate.for(item).remove()`. Read `row.canMutate`
  and `row.notice`; hook-level `canMutate`, `busy`, `outcome`, `operation`,
  `notice` and `acknowledge` are removed. For recovery, check and acknowledge
  `row.notice` or render `UpdateNotice`; use `UnresolvedNotices` for missing
  rows. `for(iri)` is recovery-only and always has `canMutate: false`.
  `unresolved` excludes pending writes and cannot replace availability checks.
  Neither row hook guarantees stable wrapper/command identities.
- **Creation has one form API (needs action for direct `mutate.create`).**
  Replace typed `mutate.create(iri, definition, draft)` with
  `useCreation(definition, { initial, iri })`, edit through `change`, then
  call `create()`. Supply exactly one of `iri` and `collection`; `bindCreation`
  accepts the same choice. Fixed-IRI creation remains create-only, retains its
  captured IRI/body on retry and uses the standard checked recovery flow.
  The raw `mutate.create(iri, body)` overload is removed deliberately. Raw
  JSON-LD remains available via portable `client-sdk/edit.prepareCreation`,
  whose caller must own draft/leave guards and recovery UI; it is not an
  equivalent controller-managed replacement.

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
- **`did:web` requires a domain host.** IP literals, single-label hosts and
  `*.localhost`/`*.invalid` names now fail with `invalid-config` on `clientId`;
  DNS label and total-name length limits are enforced too. Use a domain name
  with a dot and a matching callback as described in the
  [deployment guide](deployment.md). Only the exact hosts `localhost`,
  `127.0.0.1` and `[::1]` remain exempt with `development: 'loopback-http'`.
  Changing the app identity requires fresh sign-in; see
  [what persists](#know-what-persists).
- **Failed durable sign-out stays visible.** If `disconnect()` cannot persist
  the sign-out, it still returns `{ kind: 'blocked-locally' }` and now keeps
  `session: { kind: 'ended', problem: 'disconnected', saved: false }` on the
  connection. Custom connection controls should show the failure and offer an
  explicit retry through `useApp().disconnect(id)`; `AppAccess` does this by
  default. The fact survives UI remounts and pending retries, but not a page
  reload: the saved session may still restore. Do not claim that it was removed
  or use reload as recovery. See the [runtime contract](browser-runtime.md).
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
  warns about discarded work). After a remount, `useSelection` still starts
  empty; selecting the same subject reopens its retained draft or review without
  asking to discard that editor. Other guards and pending-write restrictions
  still apply. See [selection and draft lifetime](react-authoring.md#selection-and-draft-lifetime).
- **Write lanes per resource in `useFieldUpdate`.** The hook keeps one lane
  per resource; new `mutate.for(item)` returns a row's `data` (with a
  confirmed update shown at once), `canMutate`, `notice`, `update(change)` and
  `remove()`, and an unresolved write survives its row being unmounted;
  `unresolved` lists the IRIs that still need a check, so an app can show
  `mutate.for(iri).notice` for a row that left the list. After a confirmed
  update, the snapshot it was made from stays locked until the list reads
  again.
  A write for another resource is no longer refused while one is pending or
  unresolved. Availability and feedback belong to each row (see migration above).
- **Mutation results are never `undefined` (needs action).** row `update` and
  `remove`, and `useCreation`'s `create`,
  resolve `{ kind: 'not-sent', reason }` when they send nothing
  (`unavailable`, `busy`, `unresolved`, `stale`, `invalid`, `ended`) and
  otherwise the sent write's outcome, also when the target ended meanwhile (it
  was `undefined`). Replace checks for `undefined`. A batch stops at the first
  result that is not `created`; only an item not sent because the target
  `ended` returns to the input.
- **Stable commands, more types, `data` on loads.** Creation, list and selection commands keep
  their identity for one target and definition; row wrappers do not promise it. New exported types: `FieldUpdate`,
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
  filled and Delete moves to the end; tests that find buttons by position
  should find them by name.
- **Delete asks first.** In 0.5.0, `ResourceEditor`'s **Delete** sent the delete
  immediately. It now opens a modal `alertdialog` with the
  `controls.confirmRemove` question; only that dialog's **Delete** sends the
  conditional `DELETE`. UI tests must press the editor's **Delete**, then
  confirm inside the dialog. Cancelling sends nothing. The delete and leave
  dialogs follow the `--sempods-*` tokens, including dark mode. Direct
  `editor.remove()`, row mutation commands and custom delete buttons do not
  gain a confirmation automatically; use `RemoveButton` or an app-owned prompt.
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

Use guarded **Sign out** (`disconnect`) to remove a readable connection's stored secret
material; its address stays remembered until **Forget** (`forget`). Neither
revokes server grants nor deletes Pod data. If unreadable state
makes a full browser site-data reset necessary, first preserve unsaved work and
obtain the person's agreement: clearing site data can remove every app's local
state on that origin and requires fresh sign-in. Never upload a browser storage
dump, token or PKCE verifier in a bug report.

A static-host rollback restores app files, not the Pod's previous data or the
browser's previous storage schema. Recheck runtime compatibility and sign in afresh
when needed. Treat any vocabulary conversion as a separate, reviewed data migration
with explicit scope and a recovery plan.
