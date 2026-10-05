// Service worker for a sempods app: copy it next to your app's index.html (for
// example /sw.js, or /tasks/sw.js for an app under /tasks/) and list your own
// public shell files below. It is an app-owned recipe, not an SDK API.
//
// Invariants (see docs/pwa.md):
// - The cache is written only at install, from the fixed SHELL list below.
//   Nothing fetched later is stored, so callback URLs, Pod data and tokens can
//   never end up in it.
// - Only GET requests for those exact same-origin paths without a query, and
//   navigations to the listed app ROUTES, get a response from the worker.
//   Everything else (the OAuth callback, Pod, discovery, registration, token
//   and write requests, also when the Pod shares this origin) passes through
//   untouched: no respondWith, no retry, no replay.
// - A new version waits until every window of the app is closed. The worker
//   never calls skipWaiting or clients.claim, so an update cannot reload a page
//   over unsaved drafts or unconfirmed writes.
// - Session storage (IndexedDB) is never touched. Cache names carry this app's
//   path, so several apps on one origin never share or delete each other's
//   shell; cleanup removes only this app's older versions.
const VERSION = 'v1';
// The app's base path, from the registration scope: '/' or for example '/tasks/'.
const BASE = new URL(self.registration.scope).pathname;
const PREFIX = `sempods-shell:${BASE}:`;
const CACHE = PREFIX + VERSION;
// Paths relative to BASE ('' is the app's index document).
const SHELL = [
  '',
  'app.js',
  'app.css',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
].map((path) => BASE + path);
// App routes that may open offline from the cached index document. Never list
// the callback route: it must reach the network with its exact query.
const ROUTES = ['', 'custom'].map((path) => BASE + path);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(PREFIX) && name !== CACHE)
            .map((name) => caches.delete(name)),
        ),
      ),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.search) return;
  if (request.mode === 'navigate') {
    if (!ROUTES.includes(url.pathname)) return;
    // Network first, so a deployed fix arrives; the cached shell only offline.
    event.respondWith(
      fetch(request).catch(() =>
        caches
          .open(CACHE)
          .then((cache) => cache.match(BASE))
          .then((cached) => cached ?? Response.error()),
      ),
    );
    return;
  }
  if (!SHELL.includes(url.pathname)) return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(url.pathname))
      .then((cached) => cached ?? fetch(request)),
  );
});
