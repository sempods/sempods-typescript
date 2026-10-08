# @sempods/client-sdk

Portable browser/Node protocol primitives. Current supported exports:

- `.`: `createPod`, Pod SELECT/CONSTRUCT, context reads/writes, `bearer`/`anonymous`, `PodAuth`,
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

## Reading across the Pod

`pod.sparql.select()` and `pod.sparql.construct()` query the caller's readable
Pod dataset without fetching a catalogue or selecting a Context. The server
enforces access. The SDK sends the query unchanged, without adding dataset
parameters or making per-Context requests. Query-level dataset clauses remain
subject to server authorization.

```ts
import type { Pod } from '@sempods/client-sdk';

export async function overview(pod: Pod, signal: AbortSignal) {
  const result = await pod.sparql.select(
    `
    PREFIX schema: <https://schema.org/>
    SELECT ?task ?title ?context WHERE {
      GRAPH ?context { ?task a schema:Action ; schema:name ?title }
    }
  `,
    { signal },
  );
  if (result.kind !== 'ok') return result;
  for (const row of result.body.rows) {
    if (row['title']?.type === 'literal' && row['context']?.type === 'iri') {
      console.log(row['title'].value, row['context'].value);
    }
  }
  return result;
}
```

The exported `SelectResult` and `SparqlTerm` types preserve projected names,
solution order, repeated rows and RDF lexical values. Unbound variables are
absent, so every binding needs a guard. Known terms decode to `iri`, `blank` or
`literal`; literals retain optional `language` or `datatype`. A missing
`datatype` means `xsd:string`, or `rdf:langString` with `language` (RDF 1.1); the
SDK reports the term as received and does not fill one in. Blank-node labels
are local to one result document. Unsupported term types retain their opaque
JSON in `term` with `type: 'unsupported'`. This also applies to extensions
on known term types, such as a literal's `its:dir`: known fields are validated
first, then the entire term is retained opaquely. Only the outer `term` object is
frozen; nested extension values remain opaque JSON. Known terms receive lexical checks, not full BCP47/RFC 3987 validation.
Language tags follow the [xsd:language lexical form](https://www.w3.org/TR/xmlschema11-2/#language):
an ASCII-letter primary subtag and alphanumeric following subtags, each 1–8
characters. Singleton/extension grammar, registry membership and normalization
are outside the decoder; a bare `x` therefore passes this lexical check.
IRI terms and literal datatypes require a scheme, a nonempty remainder and no
U+0000–U+0020 characters, other whitespace or forbidden IRIREF delimiters (angle brackets, quotes, braces, pipe,
backslash, caret or backtick). Component grammar and percent escapes are not
validated, so `https://[invalid]/` and `urn:x%GG` pass the lexical boundary.
Unicode, URNs and received lexical values are preserved. Header variable names
must be nonempty and unique; an empty variable list is still accepted. Invalid structure or known
terms that fail these checks reject with `response/body`. SELECT requires `application/sparql-results+json`.

Headers are preserved even when no rows match. The SDK does not parse queries
to validate projected names: an empty header with empty bindings is accepted
structurally, without proving it is correct for that query. See the
[SPARQL Results JSON format](https://www.w3.org/TR/sparql11-results-json/#select-results).

`GRAPH ?context` requests named-graph provenance explicitly; ordinary patterns
use the Pod's default graph. CONSTRUCT returns expanded JSON-LD nodes without
automatic provenance. Editing a query result requires an explicit Context and
a fresh Context-bound resource read with its applicable ETag.

This surface is portable client-sdk functionality. app-sdk supplies independent
`BoundPod` readers and `usePodLoad`; provider/controller `contextSelection: 'on-demand'`
defers catalogue discovery until a Context flow is requested. The compatibility
default is `'required'`. See
[React Pod overviews](https://github.com/sempods/sempods-typescript/blob/v0.4.0/docs/react-authoring.md#pod-overviews-with-contexts-on-demand).

## Reading and writing one context

A host supplies the context view and authentication; the
[Node example](https://github.com/sempods/sempods-typescript/blob/v0.4.0/examples/node-script/README.md)
shows that setup. This helper changes only the title at the version it reads:

```ts
import type { ContextView } from '@sempods/client-sdk';

export async function renameTask(
  tasks: ContextView,
  taskIri: string,
  title: string,
) {
  const read = await tasks.subjects.get(taskIri);
  if (read.kind !== 'ok') return read;

  return tasks.subjects.patch(
    taskIri,
    {
      'https://schema.org/name': [
        {
          '@value': title,
          '@type': 'http://www.w3.org/2001/XMLSchema#string',
        },
      ],
    },
    { ifMatch: read.etag },
  );
}
```

Handle the returned outcome: `precondition-failed` means the resource changed
between read and write; reread and decide. `uncertain` means the answer does not
establish whether the write happened. For form editing, use the helpers below.

Supported operations in 0.4 (Pod-wide `select` and `construct` are new in 0.4.0):

| Operation                                     | Request                                                                                             | Results                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `pod.catalogue()`                             | `GET {pod}/_system/contexts`                                                                        | `ok` (decoded catalogue) · `refused` · `cancelled` · `stopped`                                                                   |
| `pod.contextDescription(contextIri)`          | `GET {contextIri}` (a context IRI of this Pod, SPS-CTX-031/032)                                     | `ok` (`public`, optional `label`, `description`, `created`) · `refused` · `cancelled` · `stopped`                                |
| `view.subjects.get(iri)`                      | `GET {pod}/_system/resources/{b64url(iri)}?context=`                                                | `ok` (body + strong ETag) · `not-found` · `refused` · `cancelled` · `stopped`                                                    |
| `view.subjects.put(iri, body, condition)`     | `PUT` with `If-None-Match: *`, `If-Match` or explicit `{ overwrite: true }`                         | `applied` (`status` 200/201/204, `location` on 201) · `precondition-failed` · `not-found` · `refused` · `not-sent` · `uncertain` |
| `view.subjects.patch(iri, change, condition)` | `PATCH` JSON Merge Patch                                                                            | `applied` (200/204) · same as above                                                                                              |
| `view.subjects.delete(iri, condition)`        | `DELETE`                                                                                            | `applied` (204/200) · same as above                                                                                              |
| `pod.sparql.select(query)`                    | `POST {pod}/_system/sparql/query`, accepts SPARQL Results JSON; no SDK-added dataset parameters     | `ok` (`SelectResult`) · `refused` · `cancelled` · `stopped`                                                                      |
| `pod.sparql.construct(query)`                 | Same route, accepts JSON-LD; no SDK-added dataset parameters                                        | `ok` (expanded JSON-LD nodes) · `refused` · `cancelled` · `stopped`                                                              |
| `view.sparql.construct(query)`                | `POST {pod}/_system/sparql/query` with `default-graph-uri` and `named-graph-uri` = the view context | `ok` (expanded JSON-LD nodes) · `refused` · `cancelled` · `stopped`                                                              |

### JSON-LD read bodies

The SDK returns JSON-LD bodies as the Pod answered them. It does not compact,
frame, reorder or otherwise normalize them; it only checks the outer structure.
Values are typed `unknown`, so check each one before using it.

`subjects.get` accepts only a JSON object; an array or other JSON rejects with
`response/body`. The SDK never requests `include_contexts`, so a conforming Pod
answers one merged node for the resource (SPS-CRUD-021/023), not `@graph`: its
`@id` is the resource IRI, `@type` carries its `rdf:type` values, predicate keys
are absolute IRIs and every value is an array of `{"@id"}` or `{"@value"}`
objects. The SDK does not check `@id` or the value objects.

```json
{
  "@id": "https://pods.example/alice/tasks/1",
  "@type": ["https://schema.org/Action"],
  "https://schema.org/actionStatus": [
    { "@id": "https://schema.org/ActiveActionStatus" }
  ]
}
```

The body holds only statements whose subject is the resource (SPS-CRUD-020).
A blank node it points to is not described in the same body, and SPS-CRUD-023
does not define how that value is written; the SDK passes it through. A blank
node cannot be read on its own, because `subjects.get` takes absolute IRIs only
and rejects `_:b0` with `invalid-argument`. Reach blank nodes through a CONSTRUCT
that follows the reference.

A CONSTRUCT `ok` body is always a top-level array of node objects; a single
object or `{"@graph": [...]}` rejects with `response/body`. SPS-SPARQL-016
requires JSON-LD but not the canonical resource shape, so the representation
of each node depends on the Pod. The standard RDF-to-JSON-LD serialization
writes `rdf:type` as `@type` by default, but an `rdf:type` predicate key is
valid JSON-LD too and the SDK does not convert it. A generic reader checks both:

```json
[
  {
    "@id": "https://pods.example/alice/tasks/1",
    "@type": ["https://schema.org/Action"]
  },
  {
    "@id": "https://pods.example/alice/tasks/2",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#type": [
      { "@id": "https://schema.org/Action" }
    ]
  }
]
```

JSON-LD blank-node identifiers start with `_:`, and their labels are local to
one response. The [editing helpers](#editing-safely-edit) skip such nodes.

A literal is a `@value` object with an optional `@language` or a datatype IRI
in `@type`. A string `@value` without either is an `xsd:string` (RDF 1.1); a
Pod may also send that datatype explicitly. Language tags and lexical values
stay as answered, without case normalization or conversion to numbers or dates:

```json
{
  "https://schema.org/name": [
    { "@value": "Buy milk" },
    { "@value": "Milch kaufen", "@language": "de-CH" }
  ],
  "https://schema.org/startTime": [
    {
      "@value": "2026-10-05T09:30:00Z",
      "@type": "http://www.w3.org/2001/XMLSchema#dateTime"
    }
  ]
}
```

### Deliberately not covered yet

Checked against the sempods specification revision recorded in
[PROVENANCE.md](PROVENANCE.md#specification-compatibility).

The client is a supported subset, not the whole protocol. Not implemented, and
not silently emulated:

| Capability                                                         | Spec                           | Use instead / status                                                                  |
| ------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------- |
| LOD addresses (`{pod}/{path}`)                                     | SPS-CRUD-001–004, §4           | The system route serves the same resource (SPS-CRUD-002)                              |
| Union or multi-context CRUD reads (no or repeated `?context=`)     | SPS-CRUD-014–017               | Use Pod SPARQL for cross-Context queries; CRUD stays Context-bound                    |
| `include_contexts`, N-Quads, `HEAD`, `OPTIONS`, `Link: rel="edit"` | SPS-CRUD-022, -026, -040, -058 | JSON-LD only; no provenance per value                                                 |
| Slots, single edges and the `outcome` representation               | SPS-CRUD-041–057               | Merge-patch replaces a predicate wholesale (SPS-CRUD-038)                             |
| SPARQL ASK and the find primitive                                  | `sparql.md`, `find.md`         | Pod SELECT/CONSTRUCT or Context CONSTRUCT                                             |
| Context management, grants, media, MCP, OIDC modules               | `modules/*`, `grants.md`       | Out of scope for the client                                                           |
| Conditional catalogue reads (`If-None-Match`)                      | SPS-CTX-035                    | Every catalogue read is fresh (`cache: 'no-store'`); nothing is reused across callers |

Protocol facts the client preserves: JSON-LD read bodies are returned as
answered; SELECT decodes wire terms without changing their lexical values, language
tags or datatype IRIs; writes return the answered
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

These helpers show creation, a snapshot-based row action and a one-shot edit.
`addTask` returns the captured creation command with its outcome; retain it for
recovery instead of calling `addTask` again after an unconfirmed answer.
`completeTask` returns `null` when there is no matching supported task.
A browser form normally keeps its editor alive for the screen's lifetime;
`renameWithEditor` returns the outcome and editor state for inspection, then
disposes the editor. Keep it alive if the caller needs to continue recovery
through the editor's review actions.

```ts
import type { ContextView } from '@sempods/client-sdk';
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

export async function addTask(tasks: ContextView, title: string) {
  const iri = newSubjectIri(tasks, 'tasks');
  const creation = prepareCreation(tasks, iri, task, {
    title,
    note: null,
    done: false,
  });

  // Keep this command if recovery requires checking or retrying the same IRI.
  return { iri, creation, outcome: await creation.run() };
}

export async function completeTask(tasks: ContextView, taskIri: string) {
  const list = await listSubjects(tasks, task);
  if (list.kind !== 'ok') return list;

  const item = list.body.items.find((item) => item.iri === taskIri);
  if (!item) return null; // No matching, supported task in this context.

  // Pass the original snapshot, including evidence of the fields that were read.
  return updateFields(tasks, item, task, { done: true });
}

export async function renameWithEditor(
  tasks: ContextView,
  taskIri: string,
  title: string,
) {
  const editor = createResourceEditor(tasks, taskIri, task);
  try {
    const opened = await editor.loaded;
    if (opened.phase !== 'ready') return opened;

    editor.change({ title });
    const outcome = await editor.save(); // saved, review or not-saved
    return { outcome, state: editor.state }; // Retain draft and review evidence.
  } finally {
    editor.dispose();
  }
}
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
  Predicates, `fields({ type })`, `flag` IRIs and `iri` values must be absolute
  IRIs without whitespace, U+0000–U+0020, angle brackets, quotes, braces, pipe,
  caret, backslash or backtick, because they are embedded in SPARQL and Turtle:
  definitions throw `TypeError`, and such an `iri` value makes the draft invalid.
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
- Not implemented yet: preferred-language editing, `texts`, and merging two changes to
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
[supported environments](https://github.com/sempods/sempods-typescript/blob/v0.4.0/README.md#supported-environments).

[Provenance](PROVENANCE.md) records the source revision and adaptations.
