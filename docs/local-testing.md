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
client policy. Enter its full HTTPS URL in AppShell, sign in on the Pod's page,
grant only the test context, return to the app and explicitly select it.

A successful sign-in without a writable context is not setup completion: the
owner must create or grant one through their Pod's supported administration tools.
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

## When a step fails

| Symptom                                    | Check first                                                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Callback is a 404 or shows a hosting error | Serve the same app at `/callback`; for a subpath, use its matching callback and rewrite                         |
| Callback rejected or login appears lost    | Exact app origin/path, app DID, stable port, stored attempt, fresh sign-in; use [recovery](migration.md)        |
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
