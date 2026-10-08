# Architecture decisions

The decisions that shape the two SDK packages, each with the reason behind it.
Details live in the package READMEs and guides; this page explains why the
code is the way it is.

## Two packages, one direction

`@sempods/client-sdk` is the portable protocol client for browsers and Node:
Pod handle, context views, subject and query operations, portable OAuth and
editing. `@sempods/app-sdk` adds the browser runtime (login, durable sessions,
bound views and Pod readers), UI messages and an optional React layer. app-sdk depends on
client-sdk, never the other way round.

_Why:_ scripts, servers and agents need the protocol without browser storage or
React; apps need sessions and UI on top of the same client, not a second one.

## The protocol stays pure; convenience lives in the SDK

Pods speak RDF, JSON-LD and SPARQL with absolute IRIs. The SDK adds field
definitions, lists without SPARQL, safe editing and session handling, without
inventing protocol extensions.

_Why:_ every client of a Pod sees the same data model; conveniences can evolve
without changing servers.

## One owner renews credentials, one executor resends

`PodAuth` supplies and renews credentials; the client's request executor alone
decides whether to send a request again. It resends at most once, only after an
answered Bearer `401`, only with a different credential, and only while the
caller's signal and dispatch guards still allow it.

_Why:_ resend decisions in two places duplicate writes. A refused request that
cannot be renewed stays `refused 401` instead of becoming an unknown outcome.

## Results say what is known

Writes distinguish `applied`, `precondition-failed`, `not-found`, `refused`,
`not-sent` (nothing was dispatched, safe to retry) and `uncertain` (it may have
reached the Pod). Reads return refusals and cancellation as results and reject
real failures with a structured `SdkError` reason. UI text comes from app-sdk's
EN/DE messages, never from diagnostics.

_Why:_ an app can only recover correctly if it knows whether a write happened,
did not happen, or is unknown.

## Nothing is resent after an unknown outcome

An `uncertain` write, an unconfirmed creation or a lost delete is shown for
review and checked against the Pod; it is never repeated automatically.

_Why:_ repeating an unconfirmed write can apply it twice or overwrite someone
else's newer change.

## Conditional writes by default

Saving and deleting use the strong entity tag that was read (`If-Match`);
creation uses `If-None-Match: *`. Overwriting is an explicit, visible choice.

_Why:_ concurrent edits from several devices are normal for personal data.

## Editing: conservative, with a bounded field rebase

An editor bases a draft on the whole version it read. For definitions created by
`fields()`, a `412` is rebased once onto the current version when exactly the
changed fields' terms are unchanged there, so two devices changing different
fields both keep their change. The same field changed on both sides, any other
definition and any lost answer go to review. Drafts are private, frozen copies
and are never dropped silently. A creation captures one subject IRI. Deletion
targets only the version the person saw.

_Why:_ safety must not mean a conflict dialog for every unrelated change, and a
merge must never guess for definitions whose dependencies are unknown.

## Reads span the readable Pod; writes name one context

A portable Pod read is an explicit, read-only operation on the Pod handle. Without
query-level dataset selection it queries the caller's authorized Pod dataset;
the server enforces that boundary. It needs neither Context selection nor a
catalogue. Provenance is requested in the query, for example `GRAPH ?g` in SELECT.

Context views retain scoped reads and are the only write path. Every write names
one Context; an empty selection, 404 or empty catalogue never retargets a request.
Context queries send dataset parameters and never retry without them. A merged
Pod result is not an editable snapshot: editing requires a known target and a
fresh Context-bound resource read with its applicable ETag. The complete catalogue
is a validated, response-relative permission summary; the server authorizes each
later request.

_Why:_ overviews and cross-Context joins need one authorized query, while scoped
reads and writes need explicit targets. Readers do not need to enumerate Contexts.

The write target need not be the selected Context. `runtime.bindContext` binds
an explicit, catalogue-checked Context without changing or remembering the
selection. It always returns a handle of its own and keeps a read-invalidation
domain per Context that selection changes never touch. Access follows the same
retained catalogue evidence as the selected view. An exact preset `contextIri`
also restricts explicit targets on its Pod.

Client-sdk and the browser runtime implement independent Pod readers.
`BoundPod` invalidation depends on connection/session/grants, while Context
switches and catalogue/label changes affect only Context-bound flows. The
headless controller exposes the active reader in `AppSnapshot.pod`.
Automatic labels load only for the selected, validated Context for every catalogue
size, with fallback names and cache lifetime tied to access authority, so a Pod
with thousands of Contexts never costs one description request per entry.

Controller/provider `contextSelection: 'required' | 'on-demand'` defaults to
`required`, preserving automatic catalogues and Context-based access UI.
With `on-demand`, startup, restore and Pod read/recovery need no catalogue or
description request, even with preset/remembered Contexts and several saved Pods.
`usePodLoad` and `useLoad` share the cancellable, bounded loader while keeping
their handle/callback types correlated. Context failures never fall back to Pod reads.

Mounting `TargetScreen` or explicitly opening `AppAccess` management demands the
active connection's catalogue before a view exists, including when login becomes
eligible later. Concurrent demand shares the runtime operation; ready/empty/failed
catalogues are reused until explicit refresh, with chooser/retry reachable beside
the content. A headless/custom UI calls the existing `runtime.loadContexts` or
React `refreshContexts` action. The catalogue contract remains one complete
response; no paging, description sweep or per-Context query fallback is introduced.
`useWorkflowAccess` stays Context-only. Labels never gate selection or read access.

_Why:_ a Pod overview should not pay for Context discovery, while editing still
requires explicit, validated Context authority. One loader and the existing
coordinator keep these paths small and consistent. Scale evidence against a local
reference server is in [#40](https://github.com/sempods/sempods-typescript/issues/40);
evidence on a deployed Pod and in a real browser is tracked in
[#52](https://github.com/sempods/sempods-typescript/issues/52).

A reload may reselect the context the person chose last for that connection.
That is their own explicit choice, remembered as a browser preference rather
than a grant, applied only while the fresh catalogue lists it as readable and
never substituted by another context.

## Delegated login: dynamic locally, did:web when deployed

Login uses Authorization Code with PKCE. Local development registers a dynamic
client on a loopback callback; deployed apps identify themselves as `did:web` on
their own HTTPS origin, with no registration; a conforming Pod needs no DID
document, though [some Pods require one](deployment.md#pods-that-also-require-a-did-document).
The runtime never falls back from did:web to registration, and requires the
`iss` callback parameter whenever the Pod announces it (RFC 9207).

_Why:_ the app's identity follows from where its callback lives, and mix-up
attacks between Pods are ruled out wherever servers support it.

## Durable sessions, one active tab, renewal before expiry

Sessions are stored as validated, versioned IndexedDB records with
compare-and-swap. One tab per app is active; a second tab shows a clear notice.
Renewal happens on demand: before a request whose credential is about to expire,
or after a request refused with a Bearer challenge. There is no background timer.
A `401` without a challenge on an unexpired credential neither renews nor ends
the session.
A consumed refresh token is removed durably before it is sent, while a failure
before that point keeps the session signed in. Startup never waits for a Pod's discovery. The storage namespace
derives from the app identity, so renaming the app or changing scopes keeps
sessions.

_Why:_ a reload or a short network failure must not log people out, and a spent
refresh token must never be reused. The token's own lifetime justifies renewal
without trusting a response, so a Pod that omits its challenge cannot strand a
session past its token's expiry; idle apps send nothing. A challenge-less `401`
does not conform to the specification and its cause is unknown: acting on it
could spend refresh tokens in a loop or sign people out on a Pod that uses `401`
for other refusals.

## Bound views, guarded navigation, safe UI defaults

The runtime binds a view to one connection and context for one target lifetime;
a target or access change invalidates pending reads, and loaders retry once.
Losing read access clears server data but keeps drafts; losing write access
disables writes. React screens get a provider, a composable `AppAccess` login/recovery
surface and hooks over a framework-free controller. The app owns its frame and
an optional way to open access management; `AppShell` provides an optional title/management wrapper around the same access surface.
The access surface does not own children or unmount drafts when access is lost.
Navigation that would replace a dirty draft or an
unresolved outcome asks first, and the UI is inert while a transition prepares. The controller exposes no
Context view until startup settles, so a returning sign-in that activates its
connection never replaces a draft started during the callback; a pending prompt
whose connection stops being active is cancelled without discarding anything.

_Why:_ recovery should be the default behaviour of the building blocks, not
code every app writes again.

## A known-Pod preset is configuration, not authority

The browser runtime accepts one immutable `preset: { podUrl, contextIri? }` next
to its identity and runtime-wide feature scopes. Headless and React controls
consume that same declaration; it removes repeated URL/reuse logic from the
ordinary app. It does not restrict explicit connections to other Pods or erase
foreign saved sessions. The durable namespace remains identity-based.

An exact configured context is an explicit app target, validated with the same
canonical rules as the catalogue. It wins over a remembered choice, is selected
only after fresh readable catalogue evidence, and has no alternative-context
fallback. Without it, user selection/remembered choice remains unchanged.
Neither a configured target nor readable catalogue evidence overrides required
feature scopes or the server's authorization.

_Why:_ a convenient default and an enforced allowed-Pod policy are different
contracts. The separate `allowedPods` option restricts exact canonical Pod URLs
without turning existing presets into authorization or changing stored identity.
Foreign records stay durable but cannot restore, become targets or exchange a
callback code under the restriction. The list is immutable for the runtime's
lifetime; omission preserves unrestricted behavior. Runtime and
React export-name budgets remain unchanged; the client exposes the existing
canonical context predicate as `isContextIri` so configuration and catalogue
validation do not drift.

## PWA through guidance, not SDK tooling

Apps become installable through a guide and copyable recipes: a vetted
`vite-plugin-pwa` configuration and a dependency-free service worker. Workers
cache only the build-time app shell, answer only the app's own files and routes,
never touch callback, Pod or OAuth requests or session storage, and never take
over open pages; a new version starts after all windows close. The SDK ships no
service worker, manifest helper or build plugin.

_Why:_ caching, routing and hosting differ per build tool and site, while these
rules are what keeps sign-in and uncertain writes safe. A packaged helper can
follow once recipes show repeated boilerplate; an immediate “reload to update”
needs a page-level leave check first.

## Host-integrated widgets share one target and guard registry

Widget libraries consume the host's provider; the host owns identity, preset,
scopes, initialization, callback, disposal and worker registration. React and
both imported SDKs remain external peers of the widget library. A packed
list/quick-add consumer demonstrates this without new SDK exports.

The first composition shares one selected target. Multiple providers over a
runtime would split guard registries, not establish safe independent targets.
A mutating widget stays mounted through access changes, with recovery outside
hidden content. Arbitrary unmount/reload is not guarded by the local navigation
action. Independent targets, general removal guards and isolated iframe login
need separate contracts and evidence.

_Why:_ the small composition proves useful libraries with today's API while
keeping session authority and pending work in one place. See [widgets](widgets.md).

## Read-only is the app's choice, not a grant

An app cannot ask a Pod for read access only. The standard delegation flow
defines no way for an app to request per-context grants or a permission level;
the person selects contexts at consent time
([SPS-AUTH-024](https://github.com/sempods/sempods-spec/blob/5e2baab8a224e06a6759e39788b3e876e44293f5/spec/core/auth.md#SPS-AUTH-024)),
and the Pod enforces what was granted. app-sdk has no read-only mode. An app that
only reads leaves out the write APIs; a Pod overview through `BoundPod` has none
to call. That restricts the app's code, not its authority, and the person
consenting cannot see the difference.

_Why:_ an SDK switch that disables write hooks would look like a permission while
the granted access still allows writes. A read-only request that the consent
screen can show needs a protocol decision first. Until then,
[local testing](local-testing.md#test-an-app-that-only-reads) explains how to
keep an app read-only and check it.

## Not implemented yet

Preferred-language editing and multi-language maps, concurrently active tabs,
anonymous reading, DPoP, revocation, server-side rendering, and a browser-hosted
Pod. Each can be added behind the existing boundaries.
