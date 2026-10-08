# Test your app with a Pod

The app and the Pod are separate services. Run the app on your machine while
choosing either a hosted HTTPS Pod or a local Pod as the data service. Use a
context made for testing, with synthetic data and a user who can grant access.

## Choose a setup

| Setup                    | App URL                  | Pod URL                                  | What you need                                                                            |
| ------------------------ | ------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| Local app, hosted Pod    | `http://127.0.0.1:5173/` | Your full HTTPS Pod URL                  | A working account and a test context; Pod support for loopback callbacks/dynamic clients |
| Local app, local Pod     | `http://127.0.0.1:5173/` | For example `http://localhost:8090/demo` | Running Pod, configured identity provider, provisioned owner and test context            |
| Deployed app, hosted Pod | Your HTTPS app origin    | Your full HTTPS Pod URL                  | [Deployment identity and routing](deployment.md), then the same checks below             |

Use the full Pod address, including a path such as `/alice` or `/demo`, rather
than just its hosting server. Keep the local app hostname and port fixed between
login and callback; `localhost` and `127.0.0.1` have different browser storage.
Loopback HTTP is an explicit development exception, not an option for a remote
HTTP server. Use HTTPS for phone/remote testing; the phone's loopback is the phone.

## Local frontend, hosted Pod

Follow the [quickstart](quickstart.md), then run:

```sh
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

The dynamic runtime configuration includes `development: 'loopback-http'`. That
permits the local HTTP callback and, if used, local HTTP Pod endpoints. It does
not relax validation of a remote Pod or make the hosted Pod accept an unsupported
client policy. Enter its full HTTPS URL in the app's sign-in form, sign in on the Pod's page,
grant only the test context, return to the app and explicitly select it.

A successful sign-in without a writable context is not setup completion for an
app that writes; an [app that only reads](#test-an-app-that-only-reads) needs a
readable one. The owner must create or grant it through their Pod's supported
administration tools.
Context administration is outside this SDK's current operation set. Do not fix
missing access by inventing a scope or choosing a different context silently.

## Running a local Pod

The Kotlin implementation's [quick start](https://github.com/sempods/sempods-kotlin#quick-start)
is the operator reference. At the revision checked for this guide it needs Java
25 and Docker Compose. In that checkout, for a fresh local setup:

```sh
docker compose -f deployments/local/compose.yaml up -d
cp deployments/local/env/local.example.env deployments/local/env/local.env
./gradlew :deployments:sempods:image:run
```

Do not overwrite an existing `local.env`; inspect and adapt it instead. Follow the
same upstream quick start to provision a development Pod, and its
[identity guide](https://github.com/sempods/sempods-kotlin/blob/main/sempods-server/docs/auth/identity.md)
to configure person login. The
[identity service setup](https://github.com/sempods/sempods-kotlin/blob/main/sempods-auth/docs/identity-service.md)
requires a configured upstream provider; starting MongoDB and the Pod alone does
not create a working sign-in account. If you do not want to operate this stack,
use a hosted test Pod.

The example server listens on port 8090. After provisioning `demo`, this is a
credential-free discovery check:

```sh
curl http://localhost:8090/demo/.well-known/oauth-protected-resource
```

Open the app and connect to `http://localhost:8090/demo`. The Pod's configured
public base URL must match its actual canonical address: it determines identities
and token issuer values. Changing a port or hostname is not a harmless alias.
Keep the development server and its published development admin configuration
local. Provisioning credentials belong in the operator setup, never the frontend.

This setup description was checked against Kotlin revision
`6b92806982528479347bf35336460516dd3fdefb`. Use the instructions matching your
checkout and record your revision; it is not a claim of a completed live login.

## Walk through one complete app

Run these checks against the installed SDK revision and record the result, Pod
version, app origin and browser. Keep credentials and private data out of reports.

| Check                                          | Expected observation                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Connect and consent                            | Sign-in occurs on the Pod/provider; the callback returns to the app; context choice is explicit                             |
| Cancel sign-in                                 | Visible cancellation/failure; existing connections and drafts remain usable where eligible                                  |
| Create, list, complete, reopen, rename, delete | Correct resource in the selected context; list updates after confirmed writes; deletion checks the version the person saw   |
| Reload                                         | Accepted connection restores; the last readable context is selected again; no app-owned token handling                      |
| Change target with a draft                     | Leaving requires confirmation; cancelled navigation preserves the draft                                                     |
| Concurrent change to the same title            | Save offers comparison with the Pod version and preserves the local draft                                                   |
| Concurrent change to a different mapped field  | The bounded rebase preserves both changes when its evidence permits; otherwise review is explicit                           |
| Lose a write's response                        | The UI says unconfirmed and offers inspection of the captured resource; no blind resend or duplicate creation               |
| Remove write access on the Pod                 | Readable data/draft remains; writes become disabled after access revalidation                                               |
| Remove read access on the Pod                  | Ineligible server data is cleared after revalidation; no fallback to another context                                        |
| Second tab                                     | One tab holds the runtime; the other shows busy rather than taking it over                                                  |
| Another Pod                                    | Sequential connection leaves the first connection available; switching remains guarded                                      |
| Pod overview with on-demand Contexts           | The overview loads without a context choice or catalogue request; a refused read shows as failed; editing selects a context |
| Language, phone layout, keyboard               | Labels and feedback are understandable; locale changes preserve drafts; controls remain reachable                           |

For concurrent edits, use another browser profile, a private window or another
device. Two tabs in the same profile intentionally exercise the busy state.
Access changes require a Pod operator or owner and become visible on revalidation,
not through an assumed server push. To test a lost answer deterministically use a
controlled test fixture/proxy that applies the write and withholds its response;
simply going offline before clicking Save tests a different condition. The SDK's
[automated browser fixtures](development.md) exercise uncertainty without real data.
Report a manual uncertainty check as untested if you cannot reproduce it safely.

## Test an app that only reads

An app that only reads, such as a data explorer or a Pod overview, skips the
create, edit and conflict checks above. It needs two other things: consent that
grants no more than it reads, and evidence that it never writes.

**Consent.** An app cannot ask a Pod for read access only. The person chooses the
contexts on the Pod's consent screen; whether they can grant read access alone
depends on the Pod. Grant only the contexts the app reads, read-only where the
consent screen offers it. Leaving out write calls restricts the app's code, not
the access it holds, and the consent screen cannot show the difference. The
[architecture decisions](decisions.md#read-only-is-the-apps-choice-not-a-grant)
explain why the SDK has no read-only mode.

**No write path.** For an overview, `usePodLoad` with
`contextSelection="on-demand"` receives a `BoundPod`, which offers only
`sparql.select` and `sparql.construct`: no write operation exists on it. Context
reads through `useLoad` or `useList` are reads too, but every `BoundView`, for
example from `useView`, `useAppState().view` or `useLoad`'s read function, also
carries `subjects.put`, `patch` and `delete`. Do not call those, and do not use
`useCreation`, `useFieldUpdate`, `useResourceEditor`, `ResourceEditor`,
`bindResourceEditor` or the `@sempods/client-sdk/edit` write helpers
(`createResourceEditor`, `prepareCreation`, `updateFields`, `removeSnapshot`).
A test that fails when the app's source uses one of these keeps it that way; the
SDK does not ship one.

**Lost access in an overview.** A `usePodLoad` result does not react to a lost
Context grant: the Pod reader stays usable and the shown rows are not cleared.
The Pod enforces the change on the next query, so give the overview an explicit
reload.

**Real data.** Run the checks below against a test context with synthetic data
first. An explorer is often meant for a Pod with real data: connect it only after
the network check passed, with the person's explicit agreement, and record which
contexts it reads in the app's notes.

| Check                             | Expected observation                                                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Connect and consent               | Only the contexts the app reads are granted; an on-demand overview loads without a context choice                                       |
| Loading, empty and failed         | Loading, an empty result and a failed read look different; a refused or failed read never shows as empty                                |
| Read access only                  | Where the Pod lets you grant read access alone, the app works fully; `AppShell` may show its read-only notice, which is expected        |
| Remove read access, Context reads | For `useLoad`/`useList`, displayed data is cleared after revalidation; no fallback to another context                                   |
| Remove read access, Pod overview  | A `usePodLoad` result stays on screen; after `reload()` it no longer contains that Context's data                                       |
| No writes                         | The browser's network panel over a full session shows no `PUT`, `PATCH` or `DELETE`; `POST` only for queries, sign-in and token renewal |
| Reload, second tab, language      | As in the [complete walkthrough](#walk-through-one-complete-app)                                                                        |

Queries are sent as `POST` to the Pod's `/_system/sparql/query`; sign-in (client
registration, token exchange) and token renewal also use `POST`. Treat any other
`POST` to the Pod as a possible write and find its caller.

## When a step fails

| Symptom                                    | Check first                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Callback is a 404 or shows a hosting error | Serve the same app at `/callback`; for a subpath, use its matching callback and rewrite                         |
| Callback rejected or login appears lost    | Exact app origin/path, app DID, stable port, stored attempt, fresh sign-in; use [recovery](migration.md)        |
| Pod rejects the deployed app at sign-in    | Pod's host allow-list and [DID document](deployment.md#pods-that-also-require-a-did-document)                   |
| Discovery fails                            | Full Pod URL, advertised endpoints, HTTPS/loopback policy, network and server version                           |
| Browser reports CORS                       | Pod/proxy OPTIONS handling and exposed headers; keep SDK requests cookie-free                                   |
| No contexts or no write controls           | Actual context grants and current catalogue; feature scopes are separate                                        |
| Busy/unavailable storage                   | Close the other active tab, or use a browser/profile with IndexedDB and Web Locks; do not add a memory fallback |

The inspected Kotlin CORS filter supports cookie-free bearer requests from other
origins; a new Netlify domain does not inherently require its credentialed-origin
allowlist. A proxy can still break preflight or hide ETag/auth headers. Diagnose
that server configuration instead of disabling browser protections or proxying
credentials through an arbitrary service.

Finish with [the deployed-origin smoke test](deployment.md#verify-the-deployed-app).
