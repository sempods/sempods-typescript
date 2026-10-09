# Ship your app as a PWA

A sempods app is a static frontend, so it can be installed like an app and open
its screen without a network. This guide makes the [quickstart](quickstart.md)
app an installable progressive web app (PWA) without weakening sign-in, Pod
access or recovery from uncertain writes.

What “PWA-ready” means here:

- **Installable:** a web app manifest, icons and a service worker on HTTPS.
- **Starts offline:** the app shell (HTML, JavaScript, CSS, icons) comes from a
  cache; the stored session survives, as in a normal tab.
- **Not offline editing:** Pod reads and writes still need the network. There is
  no queue of changes: a write that may have reached the Pod is never sent again
  automatically, so the SDK's “not confirmed” recovery stays the only path.

Installed apps are experimental in 0.5 (see
[supported environments](../README.md#supported-environments)): sign-in returns
to the app in the same window, and that return must land in the storage that
holds the sign-in attempt. Check your target devices with the list at the end.

## The rules for the service worker

The service worker sits in front of every request from your app's origin,
including those of the SDK. These rules keep it out of sign-in and data access:

1. **Cache only the public app shell, fixed at build time.** Never write the
   cache at runtime. Then callback URLs, Pod responses and tokens cannot end up
   in it, even if the Pod shares your origin.
2. **Answer only your own shell files and your own app routes.** Every other
   request passes to the network untouched: the OAuth callback, Pod, discovery,
   client registration, token and write requests. No `respondWith`, no retry,
   no replay, no synthesized response. Use an allowlist of your routes rather
   than a list of exceptions: a Pod or its login page on the same origin is also
   a navigation.
3. **Leave the callback alone.** `/callback?code=…&state=…` must reach your host
   with its exact query, which the static SPA rewrite already serves (see
   [deployment](deployment.md#3-serve-the-callback-and-client-routes)). Never
   cache, rewrite or log that URL; the runtime consumes and removes it.
4. **Never take over open pages.** No automatic `skipWaiting` or `clients.claim`.
   A new version waits until every window of the app is closed, so an update can
   never reload a page over an unsaved draft or an unconfirmed write.
5. **Never touch session storage.** The SDK keeps sessions in IndexedDB. Cache
   names carry the app's path, and cleanup deletes only that app's older
   versions, so several apps on one origin keep separate shells.
6. **Register from the app entry only**, never from a library import, and only
   in production builds.

## With Vite (the quickstart app)

Install the plugin in your app and add icons:

```sh
npm install --save-dev vite-plugin-pwa
```

Put a 192×192 and a 512×512 PNG icon into `public/` (for example
`public/icon-192.png` and `public/icon-512.png`). Then configure
`vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // The app registers the worker itself and never auto-updates a page.
      registerType: 'prompt',
      injectRegister: false,
      manifest: {
        id: '/',
        name: 'My tasks',
        short_name: 'Tasks',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f6faf9',
        theme_color: '#176354',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: {
        // Precache the built shell only; nothing is cached at runtime.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        runtimeCaching: [],
        // Serve the cached shell only for the app's own routes. Every other
        // navigation (the OAuth callback, a Pod or login page on this origin)
        // goes to the network.
        navigateFallback: '/index.html',
        navigateFallbackAllowlist: [/^\/$/],
        skipWaiting: false,
        clientsClaim: false,
        cleanupOutdatedCaches: true,
      },
    }),
  ],
});
```

The manifest `id` is the installed app's identity; `'/'` fits one app at the
site root (for apps under a path, see
[subdirectory apps](#identity-installation-and-hosting)). Add every client route
of your app to `navigateFallbackAllowlist` (for example `/^\/(settings)?$/` for
`/` and `/settings`), but never the callback route. Copy
[`register.tsx`](../examples/todo/pwa/register.tsx) to `src/pwa.tsx` and register
from the app entry, `src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { NewVersionNotice, registerAppWorker } from './pwa.tsx';

// Production builds only: the development server has no service worker.
const registration = import.meta.env.PROD
  ? registerAppWorker('/sw.js')
  : Promise.resolve(undefined);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App>
      <NewVersionNotice registration={registration} />
    </App>
  </StrictMode>,
);
```

Keep any existing CSS imports in `main.tsx` and use your HTML root element's ID.
In `src/App.tsx`, keep the quickstart's existing imports, runtime, `AppContent` and `Tasks`
component; add the type import and replace its `App` function with:

```tsx
import type { ReactNode } from 'react';

export default function App({ children }: { readonly children?: ReactNode }) {
  return (
    <SempodsProvider runtime={runtime}>
      {children}
      <AppContent />
    </SempodsProvider>
  );
}
```

Keep your existing language, locale and message props on `SempodsProvider`.
`NewVersionNotice` must be beneath the same locale provider as the app, including
any nested `SdkLocaleProvider` that owns the selected language. Placing it beside
`<App />` in `main.tsx` cannot read a provider inside App and falls back to English.
Keep the notice outside target/access gates so it also appears while signed out;
registration stays in the entry module, outside render. Importing `App.tsx`
alone must not register a worker. Language changes update the notice without
replacing the runtime, re-registering the worker or losing drafts.

`NewVersionNotice` tells the person that a downloaded version is used once all
windows of the app are closed. Do not call the plugin's `updateServiceWorker()`
or send it a `SKIP_WAITING` message: that reloads open pages (rule 4).

Check it locally with the production build:

```sh
npm run build
npx vite preview --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/`, reload once (the worker controls pages opened
after its installation), sign in and add a task. In the browser's developer
tools, the application panel should list the manifest and an active worker;
the cache should contain only built files. Switch the network off and reload:
the app opens, and your Pod connection is still listed; reads fail until the
network returns.

## Without Vite

[`examples/todo/pwa/`](../examples/todo/pwa/) contains a dependency-free
recipe: `sw.js`, `manifest.webmanifest`, two icons and `register.tsx`. Serve
`sw.js`, the manifest and the icons next to the app's index document (`/sw.js`
for an app at the site root), link the manifest in your HTML
(`<link rel="manifest" href="manifest.webmanifest">`), and edit the two lists
at the top of `sw.js`. The worker takes its base path from its scope; both lists
are relative to it:

- `SHELL`: your public shell files. If your build gives files hashed names,
  generate this list at build time instead of typing it.
- `ROUTES`: your client routes that may open offline. Never the callback.

Change `VERSION` with every deployment, so the browser installs the new shell.
The packed SDK checks run the TODO example with exactly this worker, with the
Pod on the same origin as the app.

## Identity, installation and hosting

The manifest's `id`, `start_url` and `scope`, the worker's scope and the
runtime's callback are separate settings. Keep all of them on the app's origin,
with the callback inside the manifest scope, and keep them stable: changing the
origin or a `did:web` identity starts without saved sessions. The manifest scope
is not an authorization boundary and does not route sign-in back to an
installed app by itself.

For a deployed app use the `did:web` identity from the
[deployment guide](deployment.md); its static SPA rewrite already serves the
callback.

For a subdirectory app such as `/tasks/`, every root-relative setting moves to
that path, and each app on the origin gets its own identity:

- Manifest: `id`, `start_url` and `scope` `'/tasks/'`. Several apps must never
  share an `id`.
- Vite: `base: '/tasks/'`, icons under `/tasks/`, the fallback
  `'/tasks/index.html'` and an allowlist such as `[/^\/tasks\/$/]`. The plugin
  then emits `/tasks/sw.js`; Workbox includes the registration scope in its cache
  names and cleans up only its own scope.
- Registration: `registerAppWorker('/tasks/sw.js')`, whose scope is `/tasks/`.
- Dependency-free recipe: put `sw.js`, the manifest and icons into `/tasks/` and
  set the manifest `id` to `/tasks/`. The worker derives its base path and cache
  names from its scope; the manifest's relative `start_url`, `scope` and icons
  follow its location.
- Runtime: callback and `returnTo` inside `/tasks/`, as in the
  [deployment guide](deployment.md#several-apps-under-one-site).

Service workers need HTTPS; loopback addresses such as `http://127.0.0.1` are
the only exception, for development.

Keep the browser's default referrer policy (or a stricter one) and avoid
third-party resources on the callback route, so the callback query is never
sent elsewhere. Host or CDN logs should not keep full callback URLs.

## What people see

| Situation                            | Behaviour                                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- |
| No network at start                  | The app opens from the cache; the stored connection remains; context lists and reads fail visibly |
| Network lost while saving            | The editor shows “not confirmed”; nothing is resent automatically                                 |
| New version downloaded               | A notice; the new version starts after all windows of the app are closed                          |
| Second window of the same app        | It reports that the app is open elsewhere, when both share the same browser storage               |
| Browser cleared site data or storage | The person signs in again; the SDK never falls back to a memory-only session                      |

A missing network is not a logout or a revoked permission, and the app should
not present it as one. Whether an installed app and a browser tab share storage
depends on the platform: they may report “open elsewhere”, or behave as two
separate installations with separate sessions.

## Check on your devices

Record the device, operating system, browser and version for each:

- [ ] Install the app, open it from the home screen or app list, sign in. Does
      the Pod's sign-in return into the installed app and complete there?
- [ ] Reload and reopen the installed app: still signed in, same context.
- [ ] Offline start: the app opens; going online again restores reads.
- [ ] Deploy a new version: the notice appears; after closing and reopening,
      the new version runs and the session remains.
- [ ] Open the installed app and a browser tab of it at the same time.

On iOS and iPadOS, home-screen apps keep their storage separate from Safari. If
the sign-in return opens in Safari instead of the installed app, the sign-in
cannot complete there; sign in from the browser tab instead and report the
finding. Do not work around it by moving tokens or sign-in state between apps.

## Not covered yet

An immediate “reload to update” button is deliberately missing. It needs a
page-level leave check: `useApp().navigate()` asks only about local drafts, while
a creation draft or an unconfirmed creation belongs to the target and would be
lost by a reload. Background
sync, push notifications and offline write queues are out of scope; the last
would conflict with “never resend an uncertain write”.
