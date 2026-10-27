# Hackathon: a checklist after setup

Build one useful interaction: a reading list, a shared task board, your own
research notebook. Your frontend owns the screen; app-sdk supplies login,
connections and safe editing. People keep their data in their Pod.

## Start here

Start a new app in
[sempods-apps-template](https://github.com/sempods/sempods-apps-template),
or integrate the SDK into an existing React app with the
[quickstart](quickstart.md). Their setup instructions own the dependencies;
keep the matching exact SDK versions and lockfile.

The template reads the installed
`node_modules/@sempods/app-sdk/docs/ai-app-builder.md`; give your assistant the
same entry in a custom project. Describe the first useful interaction in your
own words. You do not need to prescribe a layout or component library: the
[AI guide](ai-app-builder.md#make-the-first-draft-feel-like-a-product) asks the
assistant to make and inspect a coherent first design.

To try unreleased SDK changes, use the quickstart's
[packed SDK archives](quickstart.md#trying-unreleased-sdk-changes). To make it
installable, add the [PWA setup](pwa.md).
Use a dedicated test context and synthetic data; follow
[local or hosted Pod testing](local-testing.md) for setup.

## APIs to keep nearby

The [API table](react-authoring.md#api-at-a-glance) maps every job to its hook
or component and entry; the [working task screen](../examples/todo/src/app.tsx)
uses them together. For the first hour you need:

- `createBrowserRuntime`, `SempodsProvider`, `AppAccess` and `TargetScreen`;
- `fields` and `text` (with `trim: true`) for your data;
- `useList` with `<LoadNotice {...list} />`, `useCreation`, and one
  `useFieldUpdate` per list with `mutate.for(item)` per row;
- `UpdateNotice` for every write's outcome, and `UnresolvedNotices` for recovery
  when the corresponding row disappears.

## Avoid the common traps

- **Connected is not selected.** Grant access, then explicitly choose a context.
  Empty selection never means “all”; the Pod authorizes each operation.
- **One tab per app.** A second tab of the same app shows that it is open
  elsewhere; use a private window for a second person. A reload keeps the session
  and the last chosen context while it is readable. **Change sharing** grants
  another context.
- **Unconfirmed is not failed.** A lost answer may hide a completed write.
  Use the SDK's comparison and acknowledgement UI; do not auto-retry or invent
  a fresh IRI for uncertain creation. [Recovery details](react-authoring.md#notices-updatenotice).
- **Local and deployed identities differ.** Local HTTP uses the quickstart's
  dynamic identity and `loopback-http` option. Deployment uses an explicit
  `did:web` identity, matching HTTPS callback host/port/path, and a route that
  serves the app. No client secret is needed, and a conforming Pod needs no DID
  document. If the Pod rejects the app before or at consent, it may require
  [a DID document and an allow-listed host](deployment.md#pods-that-also-require-a-did-document).
  [Domain setup and Netlify example](deployment.md).
- **A frontend cannot hide secrets.** `VITE_*` values enter the public bundle.
  Leave session tokens to the SDK; keep hosting/provider keys out of source,
  logs and AI prompts. UI language does not change RDF text language.

## Before your demo

Run the app build and the
[end-to-end walkthrough](local-testing.md#walk-through-one-complete-app).
Inspect the actual screen at phone and desktop widths, including empty,
populated and recovery states. Keep the app's purpose, visual choices and data
mapping in its notes; distinguish browser-fixture checks from live Pod and
installed-device evidence.
