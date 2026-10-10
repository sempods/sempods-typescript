# Deploy a static sempods app

Your app's HTML, CSS and JavaScript can live on any HTTPS static host. People
connect their own Pods at runtime. Netlify is the example here; the same contract
applies elsewhere: a stable origin, a matching app identity, and a callback route
that loads the application.

## 1. Make the build reproducible

Start with the [quickstart](quickstart.md). It installs both SDK packages from
npm at one explicit shared version, saved exactly. Commit `package-lock.json`,
then verify from a clean app checkout:

```sh
npm ci
npm run build
```

Vite produces `dist/`. A dependency on `file:../some-checkout/...` works only on
your machine; a hosted build cannot find that sibling directory, so deploy with
released versions and the committed lockfile. Bundling the SDK into your app
distributes its code under its Apache-2.0 licence; keep its notices.

## 2. Choose a stable app URL and DID

Create/select your hosting project and choose its permanent URL before finalizing
auth configuration. These are three valid examples; choose one:

| Where the app lives               | App identity (`clientId`)        | Callback (`redirectUri`)                  |
| --------------------------------- | -------------------------------- | ----------------------------------------- |
| `https://my-tasks.netlify.app/`   | `did:web:my-tasks.netlify.app`   | `https://my-tasks.netlify.app/callback`   |
| `https://tasks.example.org/`      | `did:web:tasks.example.org`      | `https://tasks.example.org/callback`      |
| `https://apps.example.org/tasks/` | `did:web:apps.example.org:tasks` | `https://apps.example.org/tasks/callback` |

The host must be a domain name with at least one dot, as the
[did:web method](https://w3c-ccg.github.io/did-method-web/#method-specific-identifier)
requires. The SDK rejects an IP address, a single-label host and `*.localhost` or
`*.invalid` names with `invalid-config` on `clientId`; only local development
accepts a loopback identity.

Replace the local runtime configuration with this production configuration,
using **your** domain:

```ts
import { createBrowserRuntime } from '@sempods/app-sdk';

export const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:my-tasks.netlify.app',
    redirectUri: 'https://my-tasks.netlify.app/callback',
  },
  returnTo: '/',
});
```

There is no `development: 'loopback-http'` in the deployed configuration. The
app initializes this runtime on both the normal and callback routes; with React,
`SempodsProvider` does so. Configure the identity explicitly for each deployment,
rather than deriving a production identity from whichever hostname opened a preview.

### What domain verification means here

For a `netlify.app` subdomain, manage the named site through your hosting account.
For your own domain, add it in Netlify's domain management and configure the DNS
records it requests at your DNS provider; complete any ownership verification
Netlify requests. Wait for the domain to resolve to the site and HTTPS to work.
Use Netlify's [domain setup](https://docs.netlify.com/manage/domains/get-started-with-domains/)
and [HTTPS guide](https://docs.netlify.com/manage/domains/secure-domains-with-https/https-ssl/).

The sempods check is different. The Pod structurally parses `did:web`, binds it
to the callback host and port, and checks any DID path prefix on a segment boundary.
It sends the code to that matching callback. Under SPS-AUTH-003–007, it **does not
fetch a DID document or client metadata, and does not register a did:web client**.
This login flow needs no sempods DNS challenge or private signing key, and a
conforming Pod needs no DID document; some Pods nevertheless
[require one](#pods-that-also-require-a-did-document). DNS/TLS and control of
the hosting account establish who can serve the callback; user consent
establishes the app's context access.
See the [normative auth contract](https://github.com/sempods/sempods-spec/blob/10d91f307ad91c9bdca16e037b4088c27be49dbf/spec/core/auth.md)
at the revision checked for this guide.

### Pods that also require a DID document

Some Pod implementations check more than the protocol asks for. At least one
accepts a `did:web` client only if the app's host is on the Pod's allow-list
**and** the app's DID document resolves over HTTPS with an `id` equal to the
client ID. This is observed Pod behaviour, not a sempods protocol rule.

The symptom: the app loads, the identity and callback match, yet sign-in fails
or the Pod rejects the client before or at its consent screen. The runtime
cannot work around this, and falling back to another identity is not a fix.

Two things help, and neither affects a Pod that does not check them:

- Publish a minimal, static DID document at the location the
  [did:web method](https://w3c-ccg.github.io/did-method-web/#read-resolve) derives
  from your client ID. Its `id` is exactly your client ID; it contains no keys
  or secrets:

  ```json
  {
    "@context": "https://www.w3.org/ns/did/v1",
    "id": "did:web:my-tasks.netlify.app"
  }
  ```

  | App identity (`clientId`)        | DID document URL                                    |
  | -------------------------------- | --------------------------------------------------- |
  | `did:web:my-tasks.netlify.app`   | `https://my-tasks.netlify.app/.well-known/did.json` |
  | `did:web:tasks.example.org`      | `https://tasks.example.org/.well-known/did.json`    |
  | `did:web:apps.example.org:tasks` | `https://apps.example.org/tasks/did.json`           |

  A host-only identity uses `/.well-known/did.json`; a path identity uses the
  path followed by `/did.json`. With Vite, a file in `public/` is copied into
  `dist/` unchanged, for example `public/.well-known/did.json` for a root app or
  `public/did.json` for the `/tasks/` app [below](#several-apps-under-one-site).
  After deploying, request the URL and check that it returns this JSON, not the
  app's `index.html` from the SPA fallback.

- Ask the Pod's operator to add your app's host to its allow-list. That is Pod
  configuration; the app cannot change it.

Moving from a Netlify subdomain to a custom domain changes app identity, origin
storage and consent continuity. Plan fresh login/grants; it is not a token-store
copy. Pick the durable URL early. A `tasks` path DID includes `/tasks/callback`,
not `/tasks-other/callback`. Paths isolate redirect matching, but apps under one
origin still share a browser security boundary. Use separate origins for apps
that should not trust each other's JavaScript.

## 3. Serve the callback and client routes

For an app at the site root, put this in the **app repository's** `netlify.toml`:

```toml
[build]
  command = "npm run build"
  publish = "dist"

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

Use a Node version compatible with the app's pinned dependencies (this SDK is
checked with Node 24.15.0). Commit the app manifest and lockfile. Connect that app
repository as the Netlify project, review its build settings, and deploy when
authorized. For a manual deploy, build locally and upload `dist/`; include a
`public/_redirects` file containing `/* /index.html 200` before building so the
uploaded output carries its SPA routing too.

The rewrite is internal: `/callback?code=…&state=…` loads the app at that URL
so the runtime can consume and scrub the response. Do not redirect it to `/`
and lose the parameters, or strip the query in an app router before initialization.
Existing static files should remain served normally; keep the fallback after any
specific rules. See Netlify's [Vite guide](https://docs.netlify.com/build/frameworks/framework-setup-guides/vite/)
and [SPA rewrites](https://docs.netlify.com/manage/routing/redirects/rewrites-proxies/).

### Several apps under one site

The existing sempods apps use a useful static pattern: build each app with its
own asset base, copy its output into a matching subdirectory of one publish
folder, then give each app its own SPA fallback. For a `/tasks/` app:

- Set Vite's `base` to `/tasks/` and any client router's base to match.
- Copy the **contents** of that app's `dist/` to `netlify-dist/tasks/` and publish
  `netlify-dist`, so `/tasks/index.html` actually exists.
- Use the DID/callback in the third row above and `returnTo: '/tasks/'`.
- Put `/tasks/* /tasks/index.html 200` in `netlify-dist/_redirects` (and one
  corresponding rule per other app).

Changing Vite's base alone does not move output into a subdirectory.
An installable app needs the same paths in its manifest and service worker; see
[the PWA guide](pwa.md). Older apps
may also contain custom token handling, generated DID documents, edge functions
or provider proxies. Those are not requirements of an ordinary app-sdk frontend;
at most, a Pod may need the
[minimal static DID document](#pods-that-also-require-a-did-document).
Keep the current SDK/specification contract when adapting the hosting pattern.

## 4. Keep public configuration and credentials separate

| Value                                             | Where it belongs                                                             |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| App DID, callback URL, optional suggested Pod URL | Public source or build configuration                                         |
| Person's access/refresh tokens and PKCE state     | SDK-managed browser session storage; no extra app store or debug logging     |
| Netlify/GitHub deployment credentials             | Hosting/CI secret store with the needed permissions                          |
| Pod administrator or service-client secret        | Operator/backend environment, never the frontend                             |
| Optional paid AI/provider API key                 | Backend or edge function with its own access controls, never a static bundle |

A normal delegated sempods frontend has no client secret. A value kept in a
Netlify environment variable is still public if the build places it in
JavaScript. In Vite, `VITE_*` variables are exposed to the client; `.env.local`
being ignored by Git does not make a bundled value secret. See
[Vite's environment guide](https://vite.dev/guide/env-and-mode).

Browser session storage is not a vault against scripts running on the app origin.
Review dependencies and third-party scripts, and avoid logging callback URLs,
storage records or authorization headers. Log sanitized outcome codes instead.
A third-party AI proxy is an additional service and privacy decision; it is not
needed to store or edit data in a Pod.

## Verify the deployed app

Open the exact chosen HTTPS URL in a fresh browser profile and complete
[the app checklist](local-testing.md#walk-through-one-complete-app). Specifically
verify that `/callback` loads the app on a direct visit, that an actual sign-in
returns to that origin, and that create/edit/reload work in the test context;
for an app that only reads, complete the
[read-only checks](local-testing.md#test-an-app-that-only-reads) instead.
A direct callback visit alone does not prove the OAuth flow. If the Pod rejects
the client before or at consent, see
[Pods that also require a DID document](#pods-that-also-require-a-did-document).

Deploy previews get different origins. Use a separately configured test identity
and test Pod/context for an interactive preview, or keep it as a UI-only preview.
Do not reuse a production DID with a preview callback or bounce an authorization
response through a different domain. Neither an app-domain change nor a hosting
rollback migrates sessions automatically; see [migration](migration.md).
