# Browser runtime

The non-React entry `@sempods/app-sdk` exports `createBrowserRuntime`.
It coordinates browser login, durable connections, bound Context views and independent Pod readers.
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
});

const report = await runtime.initialize();

// Call from the host's sign-in button after startup.
async function signIn(podUrl: string) {
  if (report.storage === 'busy') {
    throw new Error('Close the other active tab, then reload this page.');
  }
  if (report.storage === 'unavailable') {
    throw new Error('Restore browser storage access, then reload this page.');
  }

  const connection = await runtime.connect(podUrl);
  await runtime.beginAuthorization(connection.id);
}
```

Ordinary data access uses context grants; no feature scopes are needed for this
example. Add `scopes: { required, optional }` only for documented capabilities
supported by your Pod. The host renders startup feedback and action failures;
React apps can use `AppAccess` for that presentation.

A deployed identity instead supplies
`{ kind: 'did-web', clientId: 'did:web:app.example', redirectUri: '…' }`.
The Pod checks the identifier locally against the callback's host, port and
path; a conforming Pod fetches no DID document and requires no registration
(SPS-AUTH-003…007). Some Pods
[require a DID document anyway](deployment.md#pods-that-also-require-a-did-document).
The runtime never silently falls back to dynamic registration. For explicit
local HTTP fixtures use `development: 'loopback-http'`; production configuration
requires HTTPS.

Call `initialize()` once at startup, including on the callback route. Repeated
calls share one promise and one report. The runtime scrubs callback parameters
and restores the return location stored with the sign-in. The host router decides
what to render; the runtime does not render login or recovery UI.

`returnTo` names that location: a same-origin path with optional query and hash,
never the callback path, `//` or OAuth response parameters. A string is checked
when the runtime is created and used for every sign-in. To keep deep links, pass
a function instead: it is called each time a sign-in or re-authorization starts,
and its result is checked the same way.

```ts
// A person on /items/add?list=groceries signs in and returns there.
returnTo: () => location.pathname + location.search + location.hash,
```

An unsafe result rejects that sign-in with a `configuration` error before any
request. A callback without a matching attempt returns to the string, or to `/`
for a function. The app's router then shows the page, for example opening an
add dialog for `/items/add`; Context selection and drafts follow the usual rules.

The report separates interaction (`none`, `completed`, `cancelled`, `failed`)
from storage (`durable`, `unavailable`, `busy`). Interaction describes the
returning sign-in only: without a callback it stays `none`, also when storage
or coordination fails or the runtime was already disposed. A rejected callback
can coexist with other restored active connections.

When the provider answers the stored attempt with an OAuth error, the runtime
consumes that attempt, ends its connection with the classified
[`OAuthProblem`](../packages/client-sdk/src/oauth/errors.ts) (`denied` reports
interaction `cancelled`) and retires its record. The connection stays listed
until the next reload, also after a transient `provider-unavailable`. A forged
or malformed callback leaves the attempt untouched. After any failed or
cancelled callback that matched a stored attempt, `attemptConnectionId` names
that connection, also when discovery failed before the attempt was claimed.

A re-authorization of a signed-in connection keeps the earlier session beside
its stored attempt. Two outcomes resume it, if its credential is still usable
(unexpired, or renewable with its refresh token) and fresh discovery confirms
its binding:

| Outcome of the re-authorization                                            | Result                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| The provider answers `access_denied` for this attempt                      | Earlier session resumes; report `cancelled` with `resumed: true`          |
| The person returns without a callback (back navigation, abandoned attempt) | Earlier session resumes (`restoring` → `active`); interaction `none`      |
| Any other provider error, a lost code answer, a binding or client mismatch | Connection ends as above; the earlier session is dropped                  |
| An expired earlier credential without a refresh token, or a disconnect     | Connection ends; nothing resumes                                          |
| A successful answer                                                        | The new grant replaces the earlier one, also when narrower; never a merge |

Resuming sends no token request and consumes the attempt: a replayed callback
then fails with `attempt` while the session stays. A denied first sign-in ends
its connection with `denied`, as above. A resume that cannot be stored keeps the attempt, and the next
start resumes it. A refresh claimed before the re-authorization began is not
kept, so its refresh token is not sent again. Records written by SDK 0.5 have
no earlier session and end as before; records written by 0.6 are not supported
by older SDKs.

`unreadable` identifies corrupt or unsupported records without deleting them
or hiding other valid records.
Startup never waits for the discovery of saved Pods, on the callback route or
otherwise. Saved connections report `session.kind: 'restoring'` until their own
validated discovery succeeds or fails; subscribe to snapshots for their
outcomes. They cannot dispatch data while restoring. A slow or offline Pod
therefore cannot delay the startup report, another Pod's restoration, or a
callback's code claim and exchange, nor keep callback parameters in the address
bar. Disconnect/dispose still prevent late restoration from publishing
credentials.

Discovery only reads the Pod's metadata, so the runtime bounds it: a Pod whose
discovery has not answered after 15 seconds counts as unreachable
(`problem: 'network'`), also when its `fetch` ignores the abort signal. This
applies to every discovery: restoration, resuming an abandoned
re-authorization, the discovery before a refresh claim (which then spends
nothing and stays signed in), rediscovery for a
[lost renewal answer](#lost-renewal-answers), `connect(url)` (rejects),
`beginAuthorization(id)` (rejects, nothing reset) and a callback's code claim
(fails before the attempt is claimed). A late answer is dropped: it publishes
nothing and installs no credentials, also after a disconnect or dispose, which
stop the wait at once (`disconnected`); a pending `connect(url)` belongs to no
connection yet, so dispose stops it. A timeout reports no `failure` detail.
Token requests and client registration are not covered by this deadline, and no
refresh or code exchange is replayed.

A restoration that cannot reach its Pod (offline, `5xx`, `408`, `429` or no
answer within the deadline during discovery) is not a sign-out: the connection ends with that problem and
`restorable: true`, and the saved session is kept. The runtime restores it again
when the browser fires `online`, and `retryRestore(id)` tries at once; both go
through `restoring` to `active` without a token request or a new sign-in. Any
other restoration failure, such as a changed binding, ends the session. A
renewal whose answer was lost while the browser is offline is restorable the
same way, but only within the grace period (see
[lost renewal answers](#lost-renewal-answers)).

One connection's restoration never holds another back. While a connection is
`restoring`, the runtime accepts `connect(url)`, and for every other
connection `beginAuthorization`, `disconnect`, `forget`, `selectContext`,
`loadContexts` and reads through its views. On the restoring connection itself,
`disconnect(id)` and `forget(id)` sign out at once and `beginAuthorization(id)`
prepares a new sign-in; each wins over the pending restoration, which then
publishes nothing. Which controls an app offers meanwhile is the app's and the
SDK components' policy
([custom layouts](react-authoring.md#custom-layouts-without-appaccess)), not a
runtime restriction.

Configured callback URLs may retain application query parameters, but may not
contain authorization-response keys (`code`, `state`, `iss`, `error`,
`error_description`, `error_uri`, `response`).
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

`runtime.preset` and `useAppState().preset` expose this frozen configuration
as `PodPreset | undefined`. `PodPreset` is exported by `@sempods/app-sdk`.

The runtime validates and copies the preset at construction. An invalid Pod URL
throws the client's `SdkError` with `reason.code: 'invalid-pod-url'`; an invalid
exact context throws `RuntimeError` with `problem: 'configuration'`. Noncanonical
Pod URLs (including a trailing slash) and wrong-Pod/noncanonical context IRIs are
rejected before any request. Configure it once for that runtime lifetime; changing
props does not change an existing runtime. A host that replaces a runtime must
first settle its drafts and unresolved operations, dispose it, and initialize its
replacement.

`runtime.connect()` uses the preset URL. Both it and `connect(url)` reuse an
existing connection at that exact URL, preferring a session over an address-only
record. Concurrent connects to the same URL share discovery. If that connection is being
disconnected, connect waits for retirement and checks the current entries again.
A failed durable retirement keeps the connection locally blocked: disconnect
returns `blocked-locally` and waiting connects reject with `RuntimeError('storage')`.
Offer an explicit disconnect retry; do not claim the saved session was removed.
Disposing the runtime while a connect waits makes it reject with
`RuntimeError('disconnected')`, without starting new discovery.
Connecting alone does not sign in:
once startup storage is durable and the connection has finished restoring, call
`beginAuthorization(connection.id)` to sign in or change sharing. React and
headless authoring use the guarded `app.connect()`, which does both and prefers
an already active matching connection. Without a preset or a sole allowed Pod,
`connect()` needs a URL; omitting it is a configuration error. A failed
preparation leaves the connection reusable, so a retry creates no duplicate.

Startup removes redundant disconnected records left by older SDKs, within the
app identity's namespace and only after their revision-checked deletion succeeds.
One remembered address remains unless a session or authorization attempt already
represents it. Live sessions and attempts are never merged. Failed cleanup keeps
the address visible and forgettable; the next startup can try again. Pod URLs are
compared exactly, never by their display label or by normalizing identities.

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
finite picker. See [sign-in composition](react-authoring.md#sign-in-and-pod-addresses).
Custom controls can read `useAppState().allowedPods` too.
Configure the policy once outside rendering and use the existing guarded actions
for Pod/context switches; replacing the runtime first requires settling drafts
and unresolved operations, as with presets.

## Apps without sign-in

Some apps show a Pod's public data: a recipe collection linked to one Pod, or
a catalogue that people read first and sign in to only to see more or to
change something. The `signIn` option declares what the app needs:

```ts
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:recipes.example.org',
    redirectUri: 'https://recipes.example.org/callback',
  },
  signIn: 'optional',
  preset: { podUrl: 'https://pods.example/alice' },
});

await runtime.initialize();

// The preset's Pod, read without a token until the person signs in.
const pod = runtime.getSnapshot().find((c) => c.reading === 'anonymous');
if (pod) await runtime.loadContexts(pod.id);
```

- **`required`** (the default) is the behaviour described above: a connection
  reads only with a session.
- **`optional`**: a connection without a session reads the Pod's public
  Contexts without a token. Startup connects the default Pod (the `preset`, or
  the sole allowed Pod), and `connect(url)` adds another Pod without discovery
  or sign-in. `beginAuthorization(id)` signs in when the person asks for it;
  only then is the Pod discovered and the client resolved. A session that
  ends, or signing out, returns to reading without a token.
- **`none`**: only an anonymous connection to the default Pod, which is
  required. No session store and no Web Lock are used, so several tabs and an
  installed PWA beside a browser tab work. `identity` may be omitted;
  `beginAuthorization`, `disconnect` and `forget` reject with
  `RuntimeError('configuration')`. `initialize()` reports
  `storage: 'unavailable'`, which here is no failure.

`Connection.reading` says how a connection sends requests:

| `reading`   | Requests             | When                                                                                      |
| ----------- | -------------------- | ----------------------------------------------------------------------------------------- |
| `session`   | with its token       | `active` or `renewing`                                                                    |
| `anonymous` | without a credential | `signed-out`, or `ended` without `restorable`, under `optional` or `none`                 |
| `null`      | none                 | restoring, leaving for a sign-in, restorable, signing out, or no session under `required` |

There is no session state of its own: a connection that reads without a token
is `signed-out` (or, in the page where its session ended, `ended` with that
cause), and the runtime publishes `reading` so the UI derives nothing.

A Pod answers a request without a token with its public Contexts only
([SPS-GRANT-031](https://github.com/sempods/sempods-spec/blob/c6308c157d8c78be0ba6e9d91dba39a11a9ce883/spec/core/grants.md#SPS-GRANT-031)).
Its catalogue lists them as readable, never as writable
([SPS-CTX-034](https://github.com/sempods/sempods-spec/blob/c6308c157d8c78be0ba6e9d91dba39a11a9ce883/spec/core/contexts.md#SPS-CTX-034)),
so a bound view reports `write: false` and every write returns `not-sent`
before dispatch. `bind`, `bindContext`, `bindPod`, `loadContexts` and
`loadContextLabels` work as for a session. Their handles are keyed with the
subject `null`; signing in, a session that ends and signing out replace them
and invalidate pending reads, and the catalogue is loaded again with the new
access. A Pod that has no public Context answers with an empty catalogue.

A token the Pod rejects is never followed by the same request without it: the
Pod does not fall back to anonymous access
([SPS-CORE-015](https://github.com/sempods/sempods-spec/blob/c6308c157d8c78be0ba6e9d91dba39a11a9ce883/spec/core/index.md#SPS-CORE-015)),
and neither does the runtime. A refused renewal ends the session as before;
only after that does the connection read without a token, with new handles.

Under `optional`, signing in requests `public-read` as an optional scope
(added if the app does not list it), so a session that receives it still reads
the public Contexts the app showed before. `scopes.required` is a
configuration error there, as an app that works without a session cannot
require what only a session grants. Under `none`, any `scopes` are one.

A signed-out connection keeps reading without a token under `optional`, also
with `rememberPods: false`, which then only keeps the address from the next
start. `forget(id)` removes the connection; a forgotten default Pod is listed
again as a new connection that was never signed in. The other-tab lease still
applies under `optional`: a second tab reports `storage: 'busy'`.

The SDK reads public data with plain requests without a token. It does not use
the anonymous `scope=public-read&prompt=none` token some Pods offer
([SPS-AUTH-042](https://github.com/sempods/sempods-spec/blob/c6308c157d8c78be0ba6e9d91dba39a11a9ce883/spec/core/auth.md#SPS-AUTH-042)):
it reads nothing more, needs a redirect and a client identity, and expires
without a refresh token. In React, see
[apps without sign-in](react-authoring.md#apps-without-sign-in).

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
There is no automatic consent redirect after a refusal.

The runtime reads a registry description automatically only for the selected,
validated Context (explicit, preset or remembered) and publishes its `rdfs:label`
in `catalogue.labels`, keyed by exact IRI (SPS-CTX-032). Other picker entries
show the IRI or a derived name at once; no catalogue size triggers more reads. To
name other Contexts, for example in a list menu, call
`loadContextLabels(id, iris)`: up to 20 IRIs per call (more reject with
`RuntimeError('configuration')` before any request). Only Contexts the ready
catalogue lists as readable are read, four at a time. The call resolves once its
reads settle or are dropped; labels arrive through the snapshot. Labels are
display text only, never identities or grants, and never block selection or data
reads. Concurrent requests for one Context share one read. Every result (label,
absence, failure) is cached for the connection's access lifetime: unchanged
catalogue reloads and reselection reuse it, and failures keep the fallback
without automatic retry. A selection change drops only the previous selection's
own pending read, not reads that `loadContextLabels` started or joined. Changed
rights for a Context drop its label; changed grants, session end or a new
authorization clear the cache. An unchanged credential renewal does not refresh
labels.

Select one readable context explicitly. Empty selection does not mean all or
a default context. A writable target is an application requirement derived
from catalogue facts, not a second login implementation. Read-only Pod queries use the separate reader below.

A `BoundView` exposes client subject/query operations without tokens. Its
`key` stays stable through refresh and same-target access changes. Switching
A → B → A creates a new lifetime; the old A view cannot become valid again.
Write observation is per Context, not per handle, so the old and the new A
handles share it: a save that was already under way through an editor on the
old handle still refreshes lists on the new one when it is confirmed.
Pending reads resolve promptly as `invalidated` after target/access changes;
caller cancellation is `cancelled`. The shared loader (`createViewLoader`,
used by `useLoad`, `useList` and `usePodLoad`) owns the bounded silent retry. Writes preserve their original client result, including
an already confirmed `refused 401` or `applied` result after a target change.

A bound 403 triggers one shared catalogue reload for concurrent refusals.
Successful revalidation publishes current rights. Loading or failed catalogues
retain last-known facts; a network failure is not proof of revocation. UI
consumers clear server data when read permission is lost, and retain readable
data while disabling actions when only write permission is lost. This runtime
does not own a screen's data cache or local drafts. Revalidation invalidates a view's pending
reads only when its own Context's access facts change; unchanged rights,
unrelated-context changes and failed reloads retain eligible reads. A caller can
cancel its wait for a write-triggered revalidation; the already confirmed write
result still returns, and the shared catalogue operation may finish separately.

## Bind an explicit Context

```ts
// The Context a Pod-overview row's GRAPH binding names.
const notes = runtime.bindContext(connectionId, rowContextIri);
if (notes.getSnapshot().read) {
  const read = await notes.subjects.get(rowSubject);
  // Edit with the read's ETag, as with the selected Context's view.
}
```

`bindContext` returns a `BoundView` for one explicit Context without changing
or remembering the connection's selection, and loads no label. It is always its
own handle, also when the IRI is the selected Context, and repeated calls return
the same handle for one authorization lifetime (connection, generation and
subject). Selection changes, including A → B → A, neither invalidate its
pending reads nor change its target.

- **Preconditions.** It needs an eligible signed-in connection, or one that
  reads without a token, and throws `RuntimeError('disconnected')` otherwise. It throws
  `RuntimeError('configuration')` for an IRI that is not a Context of that
  connection's Pod (`isContextIri`), or for another Context than an exact
  preset `contextIri` on the preset's Pod; connections to other Pods are
  unaffected. Creating the handle sends no request and needs no catalogue.
- **Access.** Like the selected view, it follows the last confirmed catalogue
  evidence for its Context. Without that evidence, or once a successful
  catalogue removes the permission, requests are not dispatched. A failed
  refresh keeps the retained evidence. A Context `403` uses the shared
  catalogue revalidation.
- **Invalidation.** Each explicit Context has its own read domain. A
  permission change for that Context cancels its pending reads, including a
  late answer after access was lost and regained, and leaves explicit views of
  other Contexts and the selected view unaffected. Connection-wide events
  (changed grants, session end, a new authorization, disconnect or disposal)
  invalidate all of the connection's bindings, explicit and selected alike.
  Writes keep their actual result, as for every `BoundView`. Within one runtime
  a renewal never changes the subject: a token for another person fails
  refresh continuity and ends the session. A new sign-in completes on the
  callback page, so the new identity's handles belong to a new runtime and
  never meet the old ones.
- **Write observation.** Handles for the same Context of one authorization
  lifetime share their write events and write-start counts. A confirmed write
  made through the SDK's editors and hooks (`bindResourceEditor` or
  `useResourceEditor`, `useCreation`, `useFieldUpdate`) on an explicit view
  refreshes a `useList` on the selected view of that Context, and its start
  retires success feedback across those handles. Direct `subjects`
  writes on a view emit no write event. Nothing is shared across Contexts,
  connections, subjects or generations, and this is no server subscription.

## Read the authorized Pod dataset

```ts
const reader = runtime.bindPod(connectionId);
if (reader.getSnapshot().read) {
  const result = await reader.sparql.select(
    'SELECT ?subject WHERE { ?subject ?predicate ?object }',
  );
  if (result.kind === 'ok') {
    for (const row of result.body.rows) {
      if (row.subject?.type === 'iri') console.log(row.subject.value);
    }
  }
}
```

Binding and dispatch require no selected Context or catalogue and initiate no
discovery. `bindPod` requires an eligible signed-in connection, or one that
reads without a token; it throws `RuntimeError('disconnected')` during
restoration or after session end under `signIn: 'required'`. A handle may be current with `read: false`
when required scopes are missing; dispatch rechecks eligibility and returns
`invalidated` without sending. Readability means permission to attempt the read,
not that readable data exists. The server authorizes its dataset.

The cached `BoundPod.key` identifies connection, subject, Pod and authorization
generation. It exposes only `select`, `construct` and `find`, and a stable immutable snapshot
with `current`, `read` and `revision`. Subscriptions have no initial callback and
notify only changes to those reader facts. Context selection (including A → B → A),
catalogue loading/failure/permission updates and labels neither cancel pending
Pod reads nor change their snapshot. Session end, disconnect, disposal, changed
subject/generation and changed granted scopes invalidate pending results. A new
generation gets a new handle; an old handle never revives. Changed scopes within
a renewal advance the read revision, while unchanged grants preserve it.
Caller cancellation returns `cancelled`; invalidation returns `invalidated`,
including when a late transport answer would otherwise succeed.
Cancellation does not require the newer `AbortSignal.any` browser API.

Pod reads share the runtime credential owner and the production client's executor
implementation. A bound client guard and the captured lifetime signal apply on
initial dispatch and authentication resend. The existing bounded `401` renewal
remains shared across readers. A Pod `403` returns `refused` without catalogue
revalidation, automatic renewal or inferred global session/access changes.
Context-view `403` recovery retains its existing behavior.

`createAppController(runtime).getSnapshot().pod` exposes the active connection's
Pod reader whenever its session is signed in, also while startup still settles.
It is `null` without an active connection, or unless that connection's session is
`active` or `renewing` (so also while it restores, is leaving, is signed out or
has ended). The snapshot's Context `view`, by contrast, stays `null`
until `startup` or `startupError` is set: on a callback page, saved sessions
restore while the returning sign-in is still being redeemed, and no Context
screen may start on a connection that sign-in is about to replace. Changing the
active Pod exposes its handle; another connection's reader retains its own
lifetime.
Controller startup defaults to automatic catalogues (`contextSelection: 'required'`).
Use `createAppController(runtime, { contextSelection: 'on-demand' })` for a
catalogue-free Pod overview. Neither startup/restore, preset/remembered Contexts
nor Pod read/recovery initiates catalogue or description requests in this mode.
The controller still restores all eligible sessions independently. A headless UI
explicitly calls `runtime.loadContexts(id)` before selecting/binding a Context;
fresh readable catalogue evidence validates the configured/remembered selection.
The full catalogue remains one response, without per-Context reads or fetches.
`createViewLoader(reader, read)` works with `BoundPod` and `PodRead<T>` as well as
Context handles, retaining cancellation, obsolete-result retirement and at most
one recovery retry per cycle. See [React Pod overviews](react-authoring.md#pod-overviews-with-contexts-on-demand).

`reader.find(text, options)` is the client's
[Find](../packages/client-sdk/README.md#finding-resources) through the same
handle. It has the same lifetime, `invalidated` and `cancelled` results as
`select`, waits for a `podReadLimit` slot, and takes `priority: 'current'`. A
connection that reads without a token searches only the Pod's public Contexts.
Each Pod answers on its own; to search several, use one loader per Pod as in
[reads per connection](react-authoring.md#reads-per-connection).

### Bounded Pod reads

An app that mounts many Pod loaders at once, such as a graph explorer with
hundreds of nodes across Pods, bounds them on the runtime instead of queueing
reads itself:

```ts
const runtime = createBrowserRuntime({
  // identity and other options as usual
  podReadLimit: { perPod: 4, total: 8 },
});

// For what the person looks at now, such as the selected graph node. A
// changed value reprioritizes the loader's waiting reads; it restarts nothing.
usePodLoad(reader, read, {
  key: iri,
  priority: selected ? 'current' : undefined,
});

// A single read that is always current:
await reader.sparql.select(query, { signal, priority: 'current' });
```

Without `podReadLimit`, every read starts at once, as before. With it, an
explicit Pod read (`BoundPod.sparql.select`/`construct` or `find`, also through
`usePodLoad` and `createViewLoader`) beyond a limit waits for a slot:

- `perPod` counts the requests in flight to one Pod URL, across its
  connections and authorization generations; `total` counts them across all
  Pods. Each value is a positive integer.
- Pods with waiting reads take turns, so 200 reads for one Pod never hold
  back another. Within a Pod, normal reads start in order, and a
  `priority: 'current'` read goes before them. After three priority reads in
  a row on a Pod, its waiting normal read is next on that Pod; after three in
  a row across all Pods, a waiting normal read of any Pod is next. Priority
  never exceeds a limit or stops a running read.
- When the current resource changes, change the priority, not the read:
  `usePodLoad`'s `priority` option, or `setPriority` of a
  `createViewLoader(pod, …)` loader. A waiting read of that loader then goes
  first or back to normal in place: it keeps its arrival order, is not
  restarted and is sent once. A read already admitted keeps its request and
  signal; the loader's later reads (a second query in the same callback, a
  `reload()`, a recovery) start with the priority set then. A disposed loader
  ignores it, and it never reaches another loader's reads. Only reads that
  receive the loader's `signal` unchanged follow it; a read's own
  `priority: 'current'` stays. Do not restart a read to change its priority:
  `loading` covers both waiting and running reads, and a restart aborts a
  running request, whose slot an abort-ignoring transport keeps.
- A waiting read that is cancelled (`signal`, `cancel()`, unmount, a `reload()`
  that supersedes it) or invalidated (changed grants, sign-out, disconnect)
  leaves the queue at once and is never sent.
- A slot is held until the request settles, also when the caller stopped
  waiting earlier. A cancelled or invalidated read returns at once, but a
  transport that ignores the abort keeps its slot until it answers or fails.
  Old requests therefore still count after changed grants, and the reads of
  the new grants wait for them. There is no timeout: a request that never
  settles keeps its slot; the browser's `fetch` settles when it is aborted.
- Waiting spends no recovery retry: a loader whose read only waits restarts
  on the current grants when they change, however often. Once its request
  was sent, the loader's one recovery per cycle applies as before. Pass the
  loader's `signal` to the read unchanged; a read that passes another signal
  counts as sent.
- The one resend after a Bearer `401` stays in the read's slot, so the limit
  holds for every request to the Pod. The credential renewal it may wait for
  goes to the authorization server and is not counted.
- Context reads (`BoundView`), discovery, catalogue, labels and writes are not
  counted and never wait for Pod reads.

## Durable sessions and refresh

IndexedDB stores versioned validated records with compare-and-swap revisions.
Web Locks permit one active runtime per application configuration on an origin.
The storage/lock namespace is the identity kind plus the did:web `clientId`, or
for dynamic identities the `redirectUri`. Display name, object property order and
scope policy do not affect it. Restored grants are evaluated against the current
required scopes; the original requested scopes remain continuity evidence.

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
holder keeps working until it is closed or disposed. The
runtime never retries a busy startup: after closing the holder, reload the busy
page to create a fresh runtime and acquire the lease. A store closed by a newer
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
context, it is kept for a [remembered Pod](#remembered-pods) and forgotten
with it, and storage failures only disable it.
Connecting a second Pod preserves the first session.

Discovery retains `authorization_response_iss_parameter_supported`. When true,
every success or error callback must carry the exact issuer. An empty, duplicate
or foreign `iss` is rejected. When the server does not announce support, an absent
`iss` is accepted for compatibility; a present one is still checked. This
compatibility case keeps a residual mix-up risk (RFC 9207). sempods-kotlin
announces support, so its callbacks use the strict path. The announcement is also
part of the saved discovery binding, preventing silent changes on resume.

A first sign-in left without a callback, an abandoned re-authorization whose
earlier session cannot resume, and interrupted code claims (and refresh claims
of SDK 0.7) are retained with an explicit `interrupted` session problem; an
expired authorization reports `expired`.
Neither is dispatched or silently retried on startup. A refresh the earlier
page left is resent once instead (see
[lost renewal answers](#lost-renewal-answers)). Call `beginAuthorization(id)`
for an explicit new attempt, or `disconnect(id)` to durably remove its secret
material; the Pod then stays a [remembered Pod](#remembered-pods) until
`forget(id)`. Until one of those actions, a retained
`authorizing` record still contains its verifier. There is no automatic expiry
cleanup. Corrupt/future-version records remain untouched and
are reported separately through `StartupReport.unreadable`.

The runtime renews a credential before dispatch once it is within a minute of
its own expiry (half its lifetime for shorter tokens), so a session survives
token expiry without relying on the Pod's `401`. While the credential is still
valid, requests keep using it until the renewal completes; once it has expired,
they wait for the renewal. A credential without a refresh
token is sent until it expires by this device's clock; the next request then ends the session as
`expired`. Renewal remains reactive as well: after a validated `401` with a
Bearer challenge, the client requests renewal and may resend once. A `401`
without a challenge does not trigger renewal or a resend, because
[SPS-CORE-015](https://github.com/sempods/sempods-spec/blob/5e2baab8a224e06a6759e39788b3e876e44293f5/spec/core/index.md#SPS-CORE-015)
requires a Bearer challenge for a rejected token; such a Pod still works as long
as it honours the advertised token lifetime. If it refuses an unexpired token
without a challenge, for example after revocation or a restart that lost its
tokens, the session stays active and requests return `refused 401` until the
renewal near the credential's own expiry, or until the session ends as
`expired` without a refresh token. `beginAuthorization(id)` (**Change sharing**
in the SDK components) recovers sooner. Pods should answer an expired token
with `401` and `WWW-Authenticate: Bearer error="invalid_token"`, and expose that
header to cross-origin apps.
The runtime shares one refresh across callers; cancelling one waiter does not
cancel another. Immutable credential objects retain their identity until an
accepted replacement. A delayed refusal of the old credential reuses that
replacement. The client alone decides whether one resend is still allowed.
A refresh token is claimed durably before dispatch, and removed from memory;
only the claim keeps it, for one resend after a lost answer. Subject/issuer/client
changes, widening scopes or a result that returns the sent refresh token are rejected. Scopes are
unordered sets; duplicates and mismatches are rejected.

A transient failure before a committed refresh claim (unreachable Pod, failing
discovery with a 5xx/408/429 answer, a write the open store could not complete)
spends nothing: the connection stays signed in with its unspent refresh token
and the durable `ready` record, the request keeps its answer (for example a
`refused 401`), and the next due or refused request tries the renewal again,
without a reload. A permanent
one (a changed token endpoint, issuer, client or refresh support, unsupported or
invalid metadata, a store closed by a newer database version) ends the session
visibly with its problem and needs a new sign-in; the unspent record is kept but
restores to the same end. Once claimed, a refused or invalid answer retires the
consumed session; a lost one is resent once, as below.

### Lost renewal answers

A token request whose answer is lost no longer signs people out. The refresh
claim keeps the sent refresh token, the granted scopes and when it was first
sent. The outcome is unknown when the token endpoint gives no complete answer
(no connection, no answer within 20 seconds, a body cut off), or one that is
neither a token response (`2xx`) nor an OAuth error answer (`400`, `401`), such
as a gateway or proxy failure (`5xx`, `403`, `404`, `408`, `429`). The Pod may
have rotated the token, so the runtime sends the same token once more while it
was first sent less than `refreshGracePeriod` ago (60 seconds by default, the
sempods server's default rotation grace period). It first rediscovers the Pod:
that read probes the network, so a connection that lost the answer does not
lose the one resend too. The probe ends with the grace period (a probe still
unanswered then ends as `interrupted`), and the grace period is checked again
right before the resend is recorded and when it is sent:

| After a lost answer                                      | Result                                                                                     |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Online, within the grace period                          | Rediscovered, then resent; `renewing` until it settles, then `active`                      |
| Offline or Pod unreachable, within the grace period      | `ended { problem: 'network', restorable: true }`; resent on `online` or `retryRestore(id)` |
| Offline beyond the grace period                          | `ended { problem: 'interrupted' }`; nothing is sent                                        |
| The resend loses its answer too                          | `ended { problem: 'interrupted' }`                                                         |
| The resend is refused (reuse detection, `invalid_grant`) | `ended` with the server's problem (`exchange`), as before                                  |
| A page left during the request (reload, suspended tab)   | The next start resends once within the grace period (`restoring` → `active`)               |

The resend is recorded durably before it is sent, so a reload never sends it a
third time. A session that ends this way keeps its Pod address: it is listed as
a [remembered Pod](#remembered-pods) with `signed-out { problem: 'interrupted' }`
from the next start on, and signing in again is one action. While restorable,
nothing is dispatched: bound handles stay `current` but report `read` and
`write` as `false`, and pending reads resolve `invalidated`. The resend restores
their access. Of the token endpoint's outcomes, only an OAuth error
answer (for example `invalid_grant` or `invalid_client`) or an outcome still
unknown beyond the grace period ends the session, besides an expired access token without a
refresh token; an answer that does not continue the session (`claims`) and
local failures (`storage`) end it as before.

A Pod without a grace period treats the resend as reuse and refuses it, so the
session ends as before; with one (sempods-kotlin#447) it survives.
`refreshGracePeriod: 0` never resends. The grace period is measured on this
device's clock from the first send; a clock set back extends it on the client
only, and the Pod still refuses a late resend. Should a page close before an ended
session's claim is retired, the next start within the grace period may send
that claim's token once more; its result passes the same continuity checks.
These are fixture tests; evidence against a deployed Pod with the grace period
is still open ([#239](https://github.com/sempods/sempods-typescript/issues/239)).
A code exchange is never resent.

`beginAuthorization()` prepares first (discovery, client resolution, the stored
attempt) while the current session keeps working; the app controller reports
`changing` meanwhile. Only after the attempt is stored does it retire the
connection's handles and navigate; a failed preparation leaves the connection
exactly as it was. Between the stored attempt and the page unloading, the
connection reports `session.kind: 'leaving'` (with the earlier `subject` for a
re-authorization) and keeps its catalogue, selection and grants for display:
no request of the earlier session is dispatched, `bind`, `bindContext` and
`bindPod` throw `disconnected`, and the SDK components show a status instead of a sign-in. A
page restored from the back/forward cache with its runtime still alive resumes
the earlier session as above; a host that disposes the runtime on `pagehide`
recreates it, and its startup resumes it. After the session ended (for example a failed
refresh), it prepares under a fresh lifetime in the same runtime, which a
disconnect or dispose during preparation still cancels without navigating. A
Pod that advertises no registration endpoint (optional, RFC 8414) still serves
`did:web` clients; dynamic clients
need one and are refused with `invalid-config`.
A lost answer to a code exchange requires explicit login; its code is never
redeemed again.
Startup/session failures preserve safe structured protocol `failure` facts for
presentation alongside `problem` (`network`, `discovery`, `state`, etc.). Neither
raw error causes nor credential-bearing responses enter snapshots.

JWT payload checks enforce issuer, client, subject, expiry and scope continuity.
They are not JWT signature verification: token receipt is bound to the validated
token endpoint and TLS. Reloaded data is structurally checked and rediscovered;
same-origin script access is not a separate trust boundary.

`disconnect()` blocks locally immediately and retires the saved session: the
record keeps only the Pod address and why the session ended, without token or
verifier (see [remembered Pods](#remembered-pods)).
If that write fails, it returns `blocked-locally` and retains
`session: { kind: 'ended', problem: 'disconnected', saved: false }` on the
connection. The fact survives UI remounts and remains during explicit retries;
a successful retry signs out. It is not persisted across reloads:
the saved session may still restore. Offer **Sign out** again, not a reload.
A late exchange cannot resurrect the locally blocked connection. `forget(id)`
reports a failed deletion the same way.
`AppAccess` shows this failure with **Try again** in
EN/DE (`controls.disconnectFailed`): in its gate for the active connection, as a
prompt for another one (`access`, reason `sign-out-failed`). The ordinary hint notes that sign-out applies
only to this device: it neither revokes sharing on the Pod, deletes Pod data nor
signs out at the Pod's provider. `dispose()` releases memory/locks while
retaining durable sessions.

## Remembered Pods

A Pod address outlives its session, so people do not type it again on their
own device. Signing out (`disconnect(id)`) and a session that ends (a refused
renewal, an expired token without a refresh token, a failed sign-in) keep the
connection's record with only its address (the Pod binding) and why the
session ended: no token and no verifier. The connection stays in the snapshot,
and the next start lists it again, as

```ts
{ kind: 'signed-out', problem?: RuntimeProblem }
```

with its `podUrl` and its remembered Context choice. `problem` is
`disconnected` after a sign-out, otherwise how the session ended, for example
`expired`. A connection that was never signed in has none, nor has a Pod
whose first sign-in failed, as no session ended. Records written by SDK 0.7,
which did not keep the reason, have none either: after an upgrade, those Pods
are listed as signed out too. A reason this SDK cannot read (from a newer
SDK) is left out; the address stays. Within the page where it happened, an
ended session keeps reporting `ended` with its cause; it reads as `signed-out`
from the next start on.

- **Signing in again is one action.** `beginAuthorization(id)` (the guarded
  `useApp().authorize(id)`) uses the remembered address and reselects the
  remembered Context once the fresh catalogue confirms it. With a valid sign-in
  cookie at the Pod and a remembered consent, the Pod answers without
  interaction. `connect(url)` reuses a matching connection; without a URL it
  uses the preset or sole allowed Pod.
- **Forgetting is separate.** `forget(id)` signs out if needed, deletes the
  record and the remembered Context choice, and removes the connection from the
  snapshot. It works for any connection. While it runs, and after a failed
  deletion (`blocked-locally`, as for `disconnect`), the connection reports
  `ended { problem: 'disconnected', forget: true }`, with `saved: false` after
  the failure; a retry with `forget(id)`, or with `disconnect(id)`, forgets it,
  so the address is never kept against the person's choice.
- **Opt out with `rememberPods: false`,** for shared devices or
  privacy-sensitive apps. Sign-out then forgets the address and the remembered
  Context at once and removes the connection; an ended session stays listed
  only until the page unloads; startup deletes records an earlier start (or SDK
  0.7) remembered for the permitted Pods. Records of Pods outside `allowedPods`
  stay untouched.
- **Each Pod keeps its own state.** One ended session or sign-out never
  changes another connection.

The app controller does not make a remembered Pod active while another
connection has a session (signed in, restoring or ended), and when the active
connection signs out it gives way to such a connection, as a removed one did.
A remembered Pod the person selects stays active, ready to sign in.
`AppAccess` offers remembered Pods as a choice with one main action; another
address opens on request. **Manage saved Pods** separates removal from sign-in,
and `controls.sessionEnded` notes an ended session. Connected management also
lists other Pods under **Connect another Pod**. Failed retirement offers its
failure and retry, never sign-in to that connection, even when it is not the
active Pod. The [React guide](react-authoring.md#sign-in-and-pod-addresses)
describes the default presentation and its customization.

A custom `SessionStore` (`openStore`) implements `remove(id, expectedRevision)`
for this: an atomic delete at the expected revision, `conflict` otherwise.

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
client consumers nor ordinary browser apps need them.

A client context or runtime `BoundView` can be passed directly to
`createResourceEditor` from `@sempods/client-sdk/edit`. The consuming UI owns target
changes, access updates and bounded silent recovery; the editor does not select
another target automatically. The edit-source boundary preserves invalidated reads as unavailable;
integration tests exercise it with the runtime-bound editor.

## Evidence and limits

In the SDK repository, `pnpm test` covers persistence, callback, refresh and
invalidation races with deterministic transports and the production client.
`pnpm test:runtime` installs packed SDKs outside
the workspace and runs Chromium with real redirects, PKCE exchanges, IndexedDB and
Web Locks against a loopback server. It checks sequential multi-Pod, reload,
did:web without DCR, reactive refresh, renewal of expired short-lived tokens
before dispatch (for Pods refusing them with or without a challenge), cookie omission, Context-scoped and bound Pod queries,
and editor saves with strong `If-Match`, conflicts and unknown write outcomes.
The unknown-outcome scenario applies the request on the server and deliberately
withholds its answer at the test network boundary. The SDK does not resend it;
this is not a guarantee against retries inside a browser's HTTP stack.
Chromium 153 resends a request on its own when a reused keep-alive connection
closes without an answer, also after the Pod applied it; on a fresh connection
it reports a network error instead. The write conditions turn such a resend into
a `412`, so nothing is applied twice, but the SDK sees the `412` instead of a lost
answer. A creation therefore reports every failed create-only condition as
`unconfirmed` and keeps its IRI; `desiredObserved` tells whether the IRI holds
its body. An update reports a conflict. Its comparison usually shows that the
Pod already holds the change, but it cannot prove it: the read may fail, or
another writer may have changed the fields since. A resent deletion finds the resource gone: a Pod answering `412`
yields a conflict, one answering `404` yields `not-removed` with reason
`not-found`. Neither tells whether this deletion or another writer removed it.

Supported environments: current browsers with IndexedDB and Web Locks in a
normal browser tab; automated checks run in Chromium. Installed PWAs are
experimental: desktop Chromium and Android are expected to work, iOS/iPadOS
home-screen apps are unverified. Sign-in returns to the app in the same window,
so the callback must land in the storage that holds the attempt; the runtime never
transfers attempts or tokens between storage containers. See
[supported environments](../README.md#supported-environments).

Sign-in against a deployed Pod in a real browser is not yet recorded as evidence.
React `AppAccess` and localized
recovery are covered by the [authoring guide](react-authoring.md) and packed TODO
checks. Multi-tab concurrent operation and revocation are not implemented
here. [Apps without sign-in](#apps-without-sign-in) are covered by fixture
tests only; reading a deployed Pod's public data from another origin is not yet
recorded as live evidence.
