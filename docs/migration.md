# Upgrade an app and recover a session

Use this guide when moving an older frontend onto app-sdk, changing a deployment
identity or updating a preview SDK. It describes a deliberate migration, not an
automatic conversion of legacy app data or stored credentials.

## From 0.4 to the next release

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

The portable OAuth API has changed during the preview: `prepareAuthorization`
uses protocol input with optional development options; browser session envelopes,
attempt lifetime and return navigation belong to app-sdk. Use the
[client reference](../packages/client-sdk/README.md) for the current portable API,
and the runtime for browser applications. Avoid adapting an old auth flow by
casting its objects to new types.

## Know what persists

The runtime stores validated, versioned session records in IndexedDB and uses Web
Locks for one active runtime per configuration. The current namespace uses identity
kind plus the did:web client ID, or the dynamic redirect URI. Display-name changes
are not a new namespace. There is no automatic migration from the earlier
configuration-derived preview namespace. Unsupported or corrupt records are
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

Use guarded Disconnect to remove a readable connection and its stored secret
material; it does not revoke server grants or delete Pod data. If unreadable state
makes a full browser site-data reset necessary, first preserve unsaved work and
obtain the person's agreement: clearing site data can remove every app's local
state on that origin and requires fresh sign-in. Never upload a browser storage
dump, token or PKCE verifier in a bug report.

A static-host rollback restores app files, not the Pod's previous data or the
browser's previous storage schema. Recheck runtime compatibility and sign in afresh
when needed. Treat any vocabulary conversion as a separate, reviewed data migration
with explicit scope and a recovery plan.
