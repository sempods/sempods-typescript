# Upgrade an app and recover a session

Use this guide when moving an older frontend onto app-sdk, changing a deployment
identity or updating a preview SDK. It describes a deliberate migration, not an
automatic conversion of legacy app data or stored credentials.

## From 0.2 to 0.3

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
component controls use the shared tokens. There is no stylesheet import. The CSP
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
