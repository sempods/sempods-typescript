# Browser runtime

The non-React entry `@sempods/app-sdk` exports `createBrowserRuntime`.
It coordinates browser login, durable connections and bound context views.
Portable OAuth steps belong to `@sempods/client-sdk/oauth`; only the client
executor sends and resends data operations. Importing either package starts
neither requests nor storage.

## Current integration boundary

The runtime uses `createPod` from `@sempods/client-sdk` by default. Applications
configure their identity and scope requirements; they do not assemble an HTTP
executor. `podFactory` remains an optional trusted composition seam for advanced
hosts. Both deterministic runtime tests and the packed browser consumer use the
production client; only transport/server behavior is simulated.

## Configure, initialize, connect

```ts
import { createBrowserRuntime } from '@sempods/app-sdk';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'My tasks',
    redirectUri: 'https://app.example/oauth/callback',
  },
  returnTo: '/',
  scopes: { required: ['tasks'], optional: ['ai'] },
});
const report = await runtime.initialize();

if (report.storage === 'durable') {
  // A connect button can invoke these guarded actions.
  const connection = await runtime.connect('https://pods.example/alice');
  await runtime.beginAuthorization(connection.id);
}
```

Scope names are illustrative: request only features supported by the chosen Pod.
With no configured features, omit `scopes`.

A deployed identity instead supplies
`{ kind: 'did-web', clientId: 'did:web:app.example', redirectUri: '…' }`.
The Pod checks the identifier locally against the callback's host, port and
path; it fetches no DID document and requires no registration (SPS-AUTH-003…007). The runtime never silently falls back to
dynamic registration. For explicit local HTTP fixtures use
`development: 'loopback-http'`; production configuration requires HTTPS.

Call `initialize()` once at startup, including on the callback route. Repeated
calls share one promise and one report. The runtime scrubs callback parameters
and restores the configured same-origin return location. The host router decides
what to render; the runtime does not render login or recovery UI.

The report separates interaction (`none`, `completed`, `cancelled`, `failed`)
from storage (`durable`, `unavailable`, `busy`). A rejected callback can coexist
with other restored active connections. `unreadable` identifies corrupt or
unsupported records without deleting them or hiding other valid records.
Startup never waits for the discovery of saved Pods, on the callback route or
otherwise. Saved connections report `session.kind: 'restoring'` until their own
validated discovery succeeds or fails; subscribe to snapshots for their
outcomes. They cannot dispatch data while restoring. A slow or offline Pod
therefore cannot delay the startup report, another Pod's restoration, or a
callback's code claim and exchange, nor keep callback parameters in the address
bar. Disconnect/dispose still prevent late restoration from publishing
credentials.

Configured callback URLs may retain application query parameters, but may not
contain OAuth response keys (`code`, `response`, `state`, `error`, `iss`).
Application query keys must be unique, including after percent decoding. Invalid
configuration is rejected before registration/navigation.

Runtime actions reject with `RuntimeError.problem` or portable `OAuthError`;
use structured facts for localized UI, not diagnostic error messages.

## One known Pod

Add a preset to the same runtime configuration as identity and scopes:

```ts
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
  preset: {
    podUrl: 'https://pods.example/alice',
    // Optional: omit this to let the person choose a readable context.
    contextIri: 'https://pods.example/alice/_system/contexts/tasks',
  },
  // Optional feature requirements; data access itself uses context grants.
  scopes: { required: [], optional: [] },
});
```

The runtime validates and copies the preset at construction. An invalid Pod URL
throws the client's `SdkError` with `reason.code: 'invalid-pod-url'`; an invalid
exact context throws `RuntimeError` with `problem: 'configuration'`. Noncanonical
Pod URLs (including a trailing slash) and wrong-Pod/noncanonical context IRIs are
rejected before any request. Configure it once for that runtime lifetime; changing
props does not change an existing runtime. A host that replaces a runtime must
first settle its drafts and unresolved operations, dispose it, and initialize its
replacement.

`runtime.connect()` uses the preset URL and reuses its first matching connection;
concurrent preset connects share discovery. If that connection is being
disconnected, connect waits for retirement and checks the current entries again.
A failed durable retirement keeps the connection locally blocked: disconnect
returns `blocked-locally` and waiting connects reject with `RuntimeError('storage')`.
Offer an explicit disconnect retry; do not claim the saved session was removed.
Disposing the runtime while a connect waits makes it reject with
`RuntimeError('disconnected')`, without starting new discovery. An explicit
`connect(preset.podUrl)` has the same reuse behavior. This action alone does not sign in. After startup is
durable and restoration of the connection has finished, use
`beginAuthorization(connection.id)` to sign in or update access. React and
headless authoring consumers use the guarded `app.connect()` action, which does
both and prefers an already active matching connection. With neither a preset nor
a sole allowed Pod, omitting the URL is a configuration error. Failed preparation leaves a reusable connection, so a
retry does not create duplicates.

An exact configured context takes precedence over a remembered choice for that
Pod. A fresh successful catalogue must list it as readable before a view can be
bound. An absent/unreadable configured context leaves selection empty, never
chooses another context, and exposes the ordinary catalogue/access facts.
Required feature scopes still gate the view separately. Read-only contexts need
no write permission. Once selected, access loss retains that same target and its
drafts through the existing view/operation guards. Choosing another context for
that preset Pod is rejected; omit `contextIri` when people should choose freely.
Automatic selection does not write the configured context into user preferences.

This is a UI default, **not an allowed-Pod policy**: `connect(otherUrl)` remains
possible, foreign stored connections restore normally, and a completed foreign
callback still selects its connection. On an ordinary reload, the app controller
prefers a restored preset connection; if none exists, it leaves the active Pod
empty instead of silently using a foreign one. People can explicitly select
another restored Pod. Identity alone continues to determine the storage/lease
namespace; changing the preset never deletes or migrates sessions. Required and
optional scopes remain runtime-wide, including for explicitly connected other
Pods. To restrict which Pods can be used, add the separate policy below. Per-Pod
scope policies remain outside this contract.

## Restrict the permitted Pods

Add `allowedPods` alongside identity and scopes when an app should use only
specific Pods:

```ts
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
  allowedPods: ['https://pods.example/alice', 'https://team.example/shared'],
  // Optional default; it must be in allowedPods.
  preset: { podUrl: 'https://pods.example/alice' },
});
```

One entry also supplies the default for `runtime.connect()` and guarded
`useApp().connect()` without a preset. It uses the same reuse/disconnect-waiting
behavior as a preset. With several entries and no preset, pass the chosen URL
explicitly. Omitting `allowedPods` keeps unrestricted behavior; an empty list,
duplicates or an outside-list preset throw `RuntimeError('configuration')` at
construction. URLs use the client's canonical validation, including the explicit
`development: 'loopback-http'` exception; matching is exact, not by origin or
prefix. The list is copied and frozen, and exposed through `runtime.allowedPods`
and `useAppState().allowedPods`. No new public export is needed.

An outside-list connection is rejected before discovery. Stored records from
other Pods stay untouched but are excluded from snapshots, restoration and all
connection-ID actions, so they cannot be selected or bound. Widening the policy
in a replacement runtime makes those records eligible again. Required scopes
and fresh context evidence still gate every permitted target; a Pod restriction
is app configuration, not server authorization.

A callback for an excluded Pod reports `interaction: 'failed'` with
`problem: 'configuration'`. It makes no discovery or token request for that Pod,
does not claim the code, and scrubs the URL to the stored safe return location.
Its attempt remains untouched and expires normally; do not retry the callback
automatically. Other permitted sessions restore independently. The identity-based
storage namespace and single-tab lease remain unchanged when the policy changes.

`AppAccess` presents one/set/free Pod configuration directly, including the
finite picker. See [login composition](react-authoring.md#login-without-an-app-frame).
Legacy `ConnectionControls` still uses `preset` for presentation; combine it with
`allowedPods` for that UI's single-Pod preset path. Custom controls can read
`useAppState().allowedPods` too.
Configure the policy once outside rendering and use the existing guarded actions
for Pod/context switches; replacing the runtime first requires settling drafts
and unresolved operations, as with presets.

## Subscribe and bind

```ts
const unsubscribe = runtime.subscribe(() => {
  renderConnections(runtime.getSnapshot()); // application-specific UI
});

const contexts = await runtime.loadContexts(connectionId);
if (contexts.kind === 'ok') {
  const writable = contexts.body.find((c) => c.readable && c.writable);
  if (writable) {
    runtime.selectContext(connectionId, writable.iri);
    const tasks = runtime.bind(connectionId);
    const read = await tasks.subjects.get(taskIri);
    if (read.kind === 'ok') {
      // Pass tasks and the resource evidence to domain/editor code.
      console.log(read.body, read.etag);
    }
  }
}
```

Subscription listeners run independently. A thrown listener error is rethrown in
a microtask for the host to report; it does not interrupt other listeners or turn
a session transition into a failure.

Snapshots contain session, feature-scope and catalogue facts, never credentials.
`requestedScopes`, `grantedScopes` and `missingRequiredScopes` remain distinct.
Missing required features block bound operations; a missing optional feature
does not. The catalogue supplies context rights separately from token scopes.
After a ready catalogue, the runtime reads the registry description of each
readable context in the background (at most 3 at once and 50 per catalogue) and
publishes `catalogue.labels`: exact context IRI → `rdfs:label` (SPS-CTX-032).
Labels are display text only, never identities or grants; they never block
selection, a failed read leaves that label out, and the known labels stay while
a later catalogue reloads.
There is no automatic consent redirect after a refusal.

Select one readable context explicitly. Empty selection does not mean all or
a default context. A writable target is an application requirement derived
from catalogue facts, not a second login implementation. A future context-free
Pod profile is outside this increment.

A `BoundView` exposes client subject/query operations without tokens. Its
`key` stays stable through refresh and same-target access changes. Switching
A → B → A creates a new lifetime; the old A view cannot become valid again.
Pending reads resolve promptly as `invalidated` after target/access changes;
caller cancellation is `cancelled`. The future React load helper owns the
bounded silent retry. Writes preserve their original client result, including
an already confirmed `refused 401` or `applied` result after a target change.

A bound 403 triggers one shared catalogue reload for concurrent refusals.
Successful revalidation publishes current rights. Loading or failed catalogues
retain last-known facts; a network failure is not proof of revocation. UI
consumers clear server data when read permission is lost, and retain readable
data while disabling actions when only write permission is lost. This runtime
does not own a screen's data cache or local drafts. Revalidation invalidates pending
reads only when the selected context's access facts change; unchanged rights,
unrelated-context changes and failed reloads retain eligible reads. A caller can
cancel its wait for a write-triggered revalidation; the already confirmed write
result still returns, and the shared catalogue operation may finish separately.

## Durable sessions and refresh

IndexedDB stores versioned validated records with compare-and-swap revisions.
Web Locks permit one active runtime per application configuration on an origin.
The storage/lock namespace is the identity kind plus the did:web `clientId`, or
for dynamic identities the `redirectUri`. Display name, object property order and
scope policy do not affect it. Restored grants are evaluated against the current
required scopes; the original requested scopes remain continuity evidence.
This replaces the unreleased prototype's configuration-derived namespace;
there is no automatic migration of that private prototype's stored records.

A did:web app may move its callback route within its identity (same host and
DID path prefix). Signed-in sessions, refresh claims and disconnected records
follow the move: they restore, and the next durable write records the new
route. An outstanding authorization attempt (or a code claim) keeps its exact
redirect, because its code can only be redeemed with it; after a move it is
reported in `unreadable` and left untouched, so that person signs in again. A
route outside the identity is never followed. Moving a dynamic client's callback
changes its namespace, so it starts without saved sessions.

A second tab reports `busy`; lack of durable storage or coordination (no Web
Locks, `locks: null`) does not silently fall back to memory and leaves stored
records untouched, so a later start with coordination restores them. The runtime
requests its lock only if available and never steals it from another tab: the
holder keeps working until it is closed or disposed. A store closed by a newer
database version (`versionchange`, e.g. after an upgrade in another tab) stays
closed for this runtime; renewals then end the session with `storage`. Call
`dispose()` on application shutdown to release the lease. See [React/headless authoring](react-authoring.md) for lifecycle integration.

The runtime persists an attempt before navigation, consumes it once before code
exchange, and publishes credentials only after validation and durable acceptance.
Identity, requested/granted scopes and continuity evidence survive redirect and
reload. Context rights are reloaded rather than persisted as grants. The last
explicitly chosen context of each connection is remembered as a preference
(`preferences`, localStorage by default; `null` disables it) and reselected when
the fresh catalogue lists it as readable. It is never replaced by another
context, it is forgotten on disconnect, and storage failures only disable it.
Connecting a second Pod preserves the first session.

Discovery retains `authorization_response_iss_parameter_supported`. When true,
every success or error callback must carry the exact issuer. An empty, duplicate
or foreign `iss` is rejected. When the server does not announce support, an absent
`iss` is accepted for compatibility; a present one is still checked. The owner
accepted the residual mix-up risk for that compatibility case. sempods-kotlin
announces support, so its callbacks use the strict path. The announcement is also
part of the saved discovery binding, preventing silent changes on resume.

Abandoned authorization and interrupted claimed records are retained with an
explicit `interrupted` session problem; an expired authorization reports `expired`.
Neither is dispatched or silently retried on startup. Call `beginAuthorization(id)`
for an explicit new attempt, or `disconnect(id)` to durably remove its secret
material and hide the connection. Until one of those actions, a retained
`authorizing` record still contains its verifier. There is no automatic expiry
cleanup in this increment. Corrupt/future-version records remain untouched and
are reported separately through `StartupReport.unreadable`.

Refresh is reactive: the client encounters a validated 401 and requests renewal.
The runtime shares one refresh across callers; cancelling one waiter does not
cancel another. Immutable credential objects retain their identity until an
accepted replacement. A delayed refusal of the old credential reuses that
replacement. The client alone decides whether one resend is still allowed.
Consumed refresh tokens are removed durably before dispatch. Subject/issuer/client
changes, widening scopes or reusing a refresh token are rejected. Scopes are
unordered sets; duplicates and mismatches are rejected.

A transient failure before a committed refresh claim (unreachable Pod, failing
discovery with a 5xx/408/429 answer, a write the open store could not complete)
spends nothing: the connection stays signed in with its unspent refresh token
and the durable `ready` record, the refused request keeps its `refused 401`, and
the next refused request tries the renewal again, without a reload. A permanent
one (a changed token endpoint, issuer, client or refresh support, unsupported or
invalid metadata, a store closed by a newer database version) ends the session
visibly with its problem and needs a new sign-in; the unspent record is kept but
restores to the same end. Once claimed, an unsuccessful exchange retires the
consumed session.

`beginAuthorization()` prepares first (discovery, client resolution, the stored
attempt) while the current session keeps working. Only after the attempt is
stored does it reset the connection and navigate; a failed preparation leaves
the connection exactly as it was. After the session ended (for example a failed
refresh), it prepares under a fresh lifetime in the same runtime, which a
disconnect or dispose during preparation still cancels without navigating. A
Pod that advertises no registration endpoint (optional, RFC 8414) still serves
`did:web` clients; dynamic clients
need one and are refused with `invalid-config`.
A lost token answer requires explicit login, never another use of the old token.
Startup/session failures preserve safe structured protocol `failure` facts for
presentation alongside `problem` (`network`, `discovery`, `state`, etc.). Neither
raw error causes nor credential-bearing responses enter snapshots.

JWT payload checks enforce issuer, client, subject, expiry and scope continuity.
They are not JWT signature verification: token receipt is bound to the validated
token endpoint and TLS. Reloaded data is structurally checked and rediscovered;
same-origin script access is not a separate trust boundary.

`disconnect()` blocks locally immediately and writes a durable tombstone.
It returns `blocked-locally` if that write fails; offer explicit retry instead of
claiming logout survived a reload. A late exchange cannot resurrect the disconnected
connection. `dispose()` releases memory/locks while retaining durable sessions.

## Protocol and session ownership

Client `./oauth` accepts an `OAuthBinding`: discovered Pod facts, a client identity
and requested scopes. It creates a portable `AuthorizationAttempt` with state and
PKCE verifier, validates callbacks and exchanges tokens. Preparation and exchanges
capture detached protocol inputs before awaiting; caller mutations cannot change
the binding used to validate an answer. Its `./oauth/host` entry provides
`validateOAuthBinding` (checks structure and returns an immutable copy; it does
not rediscover a Pod or establish freshness) and the portable token/claim
evidence validation `parseStoredCredentials` that this runtime builds on.

App-sdk owns `SessionBinding` and its storage envelope: configuration and connection
IDs, generation, record version, attempt timestamps, the ten-minute authorization
lifetime and the same-origin return location. Its session parser validates that
envelope before claiming an attempt. These types/parsers are internal; neither
client consumers nor ordinary browser apps need them. The split retains the current
version-1 record shape and needs no storage migration. It does not revive records
from the earlier namespace described above. The incidental `record` helper is not
public API.

A client context or runtime `BoundView` can be passed directly to
`createResourceEditor` from `@sempods/client-sdk/edit`. The consuming UI owns target
changes, access updates and bounded silent recovery; the editor does not select
another target automatically. The edit-source boundary preserves invalidated reads as unavailable;
integration tests exercise it with the runtime-bound editor.

## Evidence and limits

`pnpm test` covers persistence, callback, refresh and invalidation races with
deterministic transports and the production client. `pnpm test:runtime` installs packed SDKs outside
the workspace and runs Chromium with real redirects, PKCE exchanges, IndexedDB and
Web Locks against a loopback server. It checks sequential multi-Pod, reload,
did:web without DCR, reactive refresh, cookie omission, context-scoped queries,
and editor saves with strong `If-Match`, conflicts and unknown write outcomes.
The unknown-outcome scenario applies the request on the server and deliberately
withholds its answer at the test network boundary. The SDK does not resend it;
this is not a guarantee against retries inside a browser's HTTP stack.

Supported environments: current browsers with IndexedDB and Web Locks in a
normal browser tab; automated checks run in Chromium. Installed PWAs are
experimental: desktop Chromium and Android are expected to work, iOS/iPadOS
home-screen apps are unverified. Sign-in returns to the app in the same window,
so the callback must land in the storage that holds the attempt; the runtime never
transfers attempts or tokens between storage containers. See
[supported environments](../README.md#supported-environments).

Owner live validation remains follow-up work. React/AppShell and localized
recovery are covered by the [authoring guide](react-authoring.md) and packed TODO
checks. Multi-tab concurrent operation, proactive refresh, revocation, anonymous
reading and a context-free profile are not implemented here.
