# @sempods/client-sdk

Portable browser/Node protocol primitives. Current supported exports:

- `.`: `createPod`, context reads/writes, `bearer`/`anonymous`, `PodAuth`,
  `decodeCatalogue`, `isContextIri`, result/failure and transport types. Membership never implies
  context access.
- `./oauth`: `discoverPod`, `createClientRegistry`, `prepareAuthorization`,
  `exchangeAuthorization`, `refreshAuthorization` and `OAuthError`. Supports
  dynamic and did:web app identities, requested/granted scopes and token-claim
  continuity. Discovery sends no credentials; exchanges use the bound token endpoint.
- `./oauth/host`: helpers for session coordinators that persist and resume OAuth
  state (stored-credential parsing, refresh continuity, callback and binding
  validation, scope lists, callback-URL and did:web checks). app-sdk uses them;
  ordinary apps and scripts do not need them.
- `./edit`: conservative editing on top of a context view (see below).

`isContextIri(iri, podUrl)` checks whether a context IRI has the canonical registry
path of the given canonical Pod URL. It reuses the catalogue decoder's lexical
rules (including raw Unicode); it neither checks existence nor proves access.
`createPod` validates the Pod URL without sending a request.

Each entry's runtime exports are an explicit budget, checked by a test: adding
or removing one is a deliberate API change.

```ts
import { discoverPod } from '@sempods/client-sdk/oauth';

const facts = await discoverPod('https://pods.example/alice');
console.log(facts.endpoints.authorization);
```

## Portable OAuth steps

```ts
import {
  createClientRegistry,
  discoverPod,
  prepareAuthorization,
} from '@sempods/client-sdk/oauth';

const pod = await discoverPod('https://pods.example/alice');
const client = await createClientRegistry().resolve(pod, {
  kind: 'did-web',
  clientId: 'did:web:app.example',
  redirectUri: 'https://app.example/oauth/callback',
});
const { attempt, url } = await prepareAuthorization({
  pod,
  client,
  scopes: [],
});
// The host owns retaining attempt, opening url and handling the callback.
```

`OAuthBinding` contains only Pod, client and scope facts. Preparation returns
state and PKCE verifier; code/refresh exchanges capture a detached binding before
awaiting, so caller mutations cannot change validation of the reply.
In `./oauth/host`, `validateOAuthBinding` performs structural validation, not
rediscovery or freshness checks, and `parseStoredCredentials` validates portable
token/claim/receipt evidence;
it imposes no browser record format. Browser connection IDs, durable acceptance,
attempt expiry and return navigation belong to app-sdk. Node hosts supply their
own interaction and attempt-lifetime policy; the client does not start either.

Token answers are accepted only from the bound token endpoint (no redirect, no
other URL), as a Bearer token without an ID token, with issuer, client, subject
and scopes matching the binding. Their `iat` is never compared with the local
clock, because Pods and devices drift: a token must be internally plausible
(`exp > iat`, `expires_in` within `exp - iat`) and not yet expired. An
`invalid_client` answer, also behind a Bearer challenge, is reported as
`invalid-client` so hosts can drop the registration; other refusals are
`exchange`. A `claims` failure names `field: 'sub'` for a missing or malformed
subject and `field: 'continuity'` for a valid token that does not continue the
session (changed subject, reused refresh token, widened scopes). Callback URLs may not carry authorization-response parameters
(`code`, `state`, `iss`, `error`, `error_description`, `error_uri`, `response`).

Alpha API change: `prepareAuthorization` now takes protocol input and optional
`{ development }` options; the previous timestamp argument and app envelope
fields are removed. `SessionBinding`, session/attempt parsers, `assertAttemptFresh`
and `safeReturnTo` are no longer client exports. Browser hosts use the app runtime;
standalone hosts enforce their own attempt lifetime before exchanging a code.

## Reading and writing one context

```ts
import { bearer, createPod } from '@sempods/client-sdk';

const pod = createPod('https://pods.example/alice', { auth: bearer(token) });
const tasks = pod.context('https://pods.example/alice/_system/contexts/tasks');

const read = await tasks.subjects.get(taskIri);
if (read.kind === 'ok') {
  const write = await tasks.subjects.patch(taskIri, change, {
    ifMatch: read.etag,
  });
  if (write.kind === 'precondition-failed') {
    /* changed on the pod: read again and decide */
  }
}
```

Supported operations (as of 0.2):

| Operation                                     | Request                                                                                             | Results                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pod.catalogue()`                             | `GET {pod}/_system/contexts`                                                                        | `ok` (decoded catalogue) · `refused` · `cancelled` · `stopped`                                                                   |
| `view.subjects.get(iri)`                      | `GET {pod}/_system/resources/{b64url(iri)}?context=`                                                | `ok` (body + strong ETag) · `not-found` · `refused` · `cancelled` · `stopped`                                                    |
| `view.subjects.put(iri, body, condition)`     | `PUT` with `If-None-Match: *`, `If-Match` or explicit `{ overwrite: true }`                         | `applied` (`status` 200/201/204, `location` on 201) · `precondition-failed` · `not-found` · `refused` · `not-sent` · `uncertain` |
| `view.subjects.patch(iri, change, condition)` | `PATCH` JSON Merge Patch                                                                            | `applied` (200/204) · same as above                                                                                              |
| `view.subjects.delete(iri, condition)`        | `DELETE`                                                                                            | `applied` (204/200) · same as above                                                                                              |
| `view.sparql.construct(query)`                | `POST {pod}/_system/sparql/query` with `default-graph-uri` and `named-graph-uri` = the view context | `ok` (expanded JSON-LD nodes) · `refused` · `cancelled` · `stopped`                                                              |

### Deliberately not covered yet

Checked against the sempods specification revision recorded in
[PROVENANCE.md](PROVENANCE.md#specification-compatibility).

The client is a supported subset, not the whole protocol. Not implemented, and
not silently emulated:

| Capability                                                         | Spec                           | Use instead / status                                                                  |
| ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| LOD addresses (`{pod}/{path}`)                                     | SPS-CRUD-001–004, §4           | The system route serves the same resource (SPS-CRUD-002)                              |
| Union or multi-context reads (no or repeated `?context=`)          | SPS-CRUD-014–017               | One explicitly selected context per view                                              |
| `include_contexts`, N-Quads, `HEAD`, `OPTIONS`, `Link: rel="edit"` | SPS-CRUD-022, -026, -040, -058 | JSON-LD only; no provenance per value                                                 |
| Slots, single edges and the `outcome` representation               | SPS-CRUD-041–057               | Merge-patch replaces a predicate wholesale (SPS-CRUD-038)                             |
| SPARQL SELECT/ASK and the find primitive                           | `sparql.md`, `find.md`         | CONSTRUCT in the view context                                                         |
| Context descriptions (`GET {pod}/_system/contexts/{path}`)         | SPS-CTX-024, -032              | The catalogue lists IRIs and caller rights only                                       |
| Context management, grants, media, MCP, OIDC modules               | `modules/*`, `grants.md`       | Out of scope for the client                                                           |
| Conditional catalogue reads (`If-None-Match`)                      | SPS-CTX-035                    | Every catalogue read is fresh (`cache: 'no-store'`); nothing is reused across callers |

Protocol facts the client preserves: read bodies are returned exactly as
answered (terms, language tags, datatypes, IRIs); writes return the answered
status and a pod-local `Location` for a creation, but no entity tag
(SPS-CRUD-030); conflicts are explicit results. A 404 or a missing catalogue
entry never redirects a request to another context. Creation locations must match
that subject's system route, with no query or the request's context query and no
nonempty fragment. Relative locations resolve against the request URL; bare `?`,
`#` and `?#` delimiters are removed from accepted locations. An invalid location
is omitted without changing the confirmed write outcome.

The catalogue is validated against the grant model: context IRIs are canonical
paths in the pod's registry (SPS-CTX-004/010/013, never normalized), every listed context is readable, and write or
manage without read is rejected (SPS-GRANT-009). Its rights describe this
response only (SPS-CTX-034); the Pod authorizes every request. Hidden and absent
contexts look the same: missing from the catalogue, `not-found` on access.

Rules the client enforces:

- Every write names exactly one context and carries a condition or an explicit
  overwrite. A write is `not-sent` when nothing was dispatched (safe to retry)
  and `uncertain` when it may have reached the Pod (lost answer, cancellation
  after dispatch, 5xx, an unexpected non-error status such as 202, untrusted
  answer): read again, never resend automatically. Other answered 4xx reject
  with `SdkError` (not applied). Only strong entity tags count as versions;
  `If-Match: *` is refused (use the explicit overwrite instead).
- Reads: refusals and cancellation are results; network failures, unexpected
  statuses and invalid answers reject with `SdkError`.
- At most one resend, only after an answered Bearer 401 and only with a
  different credential from the `PodAuth` owner; a stopped or failed renewal
  keeps `refused 401`. `bearer(token)` never renews; `anonymous()` sends no
  credential. Custom owners keep one stable `AuthCredential` object per
  accepted credential.
- Requests go only to constructed endpoints of the canonical pod, with
  `credentials: 'omit'`, `redirect: 'error'`, no referrer and no cache; an
  answer from another URL is not trusted.
- Failures are structured (`SdkError.reason`, `sdkFailure(cause)`); messages
  and causes are diagnostics, not UI text.

## Editing safely (`./edit`)

The app describes its fields once; the editor owns the version, the draft and
conflict recovery. It works with a client `ContextView` and with an app-sdk
`BoundView` (`ResourceSource` is the shared boundary).

```ts
import {
  createResourceEditor,
  fields,
  flag,
  listSubjects,
  newSubjectIri,
  prepareCreation,
  text,
  updateFields,
} from '@sempods/client-sdk/edit';

const task = fields(
  {
    title: text('https://schema.org/name', { language: 'en' }),
    note: text('https://schema.org/description', {
      language: 'en',
      optional: true, // absent reads as null; null removes it again
    }),
    done: flag('https://example.org/status', {
      on: 'https://example.org/Done',
      off: 'https://example.org/Open',
    }),
  },
  { type: 'https://schema.org/Action' }, // lists and creation use it
);

// Create: the IRI is captured once, so running it again never duplicates.
const iri = newSubjectIri(tasks, 'tasks');
await prepareCreation(tasks, iri, task, {
  title: 'Buy milk',
  note: null,
  done: false,
}).run();

// List without SPARQL, then complete one with a click.
const list = await listSubjects(tasks, task);
if (list.kind === 'ok')
  await updateFields(tasks, list.body.items[0]!, task, { done: true });

// Edit: only the changed fields.
const editor = createResourceEditor(tasks, iri, task); // starts reading
editor.subscribe(() => render(editor.state)); // a UI acts on state.phase
const opened = await editor.loaded; // a script waits for the first read
if (opened.phase === 'ready') {
  editor.change({ title: 'Buy oat milk' });
  const outcome = await editor.save(); // 'saved' | 'review' | 'not-saved'
} // otherwise `state.problem` says why (not-found, refused, not-mappable, …)
```

- Fields: `text` (one value in a fixed language or untagged; other languages,
  typed literals and IRIs are preserved; `optional: true` distinguishes absent
  `null` from an empty literal; by default an empty or whitespace-only value
  makes the draft invalid, and values are stored as typed), `flag` (two IRIs,
  anything else is a mapping error), `iri` and `dateTime` (one `xsd:dateTime`
  literal as its lexical string, such as `2026-10-05T09:30:00+02:00`; a value
  without an explicit time zone, `Z` or `±hh:mm`, makes the draft invalid; it is
  stored unchanged, so the offset survives; untyped strings, other datatypes and
  IRIs are preserved; `optional: true` as for `text`). Fields writing the same
  terms are rejected; a `text` and a `dateTime` may share a predicate.
  `EditDefinition` (`read`/`patch`/`valid`) is the escape hatch for other
  mappings. `isFieldDefinition(definition)` tells whether a definition was
  created by `fields()` (copies and look-alikes are not).
- **Different fields both survive.** Saving is conditional on the version that
  was read. If someone else changed only _other_ fields meanwhile (a 412 whose
  current version still holds exactly the terms of the fields you changed), a
  `fields()` editor rebases once onto that version and reports
  `{ kind: 'saved', alongside: true }`; `refresh()` moves a dirty draft along
  the same way, and `updateFields` retries once. The same field changed by both
  sides, the escape hatch and any lost answer always go to review.
- A real conflict becomes review `changed-on-pod`; a lost answer becomes review
  `unconfirmed` (`desiredObserved` is not proof). Nothing is ever resent:
  `continueFromCurrent()` keeps the draft on the compared version, `discard()`
  takes it.
- Typing continues while saving; only the submitted draft counts as saved.
  Losing read access (`setAccess`) clears server data but keeps the draft and
  any open review of a write; after it returns, `refresh()` adopts the current
  version silently when the draft is unchanged. A `refresh()` requested while a
  read or write is in flight runs once afterwards, so it is never lost. Reads
  that are cancelled, stopped or invalidated by
  the runtime are `problem: { kind: 'unavailable', reason }`, never absence.
- `remove()` and `removeSnapshot()` delete only the version the person saw;
  from a list that needs the subject's whole description (for example
  `CONSTRUCT { ?s ?p ?o }`), otherwise the result is `changed-on-pod` with a
  fresh snapshot to confirm. Snapshots and commands are private copies.
- `listSubjects(view, definition)` lists all subjects of the definition's type
  in the view's context as snapshots (the query's own outcomes pass through;
  unfitting subjects and blank nodes, which cannot be addressed later, are
  counted in `skipped`). `newSubjectIri(view, 'tasks')`
  makes a fresh IRI under the Pod.
- `prepareCreation(source, iri, definition, draft)` derives the body (type
  included) from a `fields()` definition; `prepareCreation(source, iri, body)`
  takes a raw body. Either captures one IRI and body. Only the
  Pod's answer confirms `created`; after a lost answer, running it again is
  safe, and a found resource stays `unconfirmed` (`desiredObserved` is not
  proof). For several resources from one input, prepare one creation per item
  and `await` each `run()` before the next. Stop at the first result that is
  not `created` and leave the rest unsent; an `unconfirmed` item is retried
  only through its own creation, never under a new IRI.
- Not in 0.1: preferred-language editing, `texts`, and merging two changes to
  the same field.

Discovered support is not a granted scope or context right. HTTPS is required;
`development: 'loopback-http'` permits explicit local fixture/development use only.
Imports do not start requests. Protocol errors expose structured reasons; messages
and causes are diagnostics, not user interface text.

The package has no React, app-sdk or browser-session dependency. oauth4webapi is an
installed dependency but is imported only by `./oauth`. ESM/declaration artifacts
are checked from Node-only and DOM-only consumers.
Browser acceptance, persistence and navigation live in app-sdk; OAuth primitives
here remain browser/Node portable. Licensed under Apache-2.0 (see LICENSE and
NOTICE).

Supported: Node 24.15 or newer (ESM only) and current browsers. See
[supported environments](https://github.com/sempods/sempods-typescript/blob/v0.2.0/README.md#supported-environments).

[Provenance](PROVENANCE.md) records the source revision and adaptations.
