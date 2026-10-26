# Hackathon: your sempods app at a glance

Build one useful interaction: a reading list, a shared task board, your own
research notebook. Your frontend owns the screen; app-sdk supplies login,
connections and safe editing. People keep their data in their Pod.

## Start here

Follow the [quickstart](quickstart.md) to create a Vite React/TypeScript app
(Node 24.15 or newer). Install the matching pair:

```sh
npm install --save-exact @sempods/app-sdk@0.5.0 @sempods/client-sdk@0.5.0
```

Commit the lockfile. Point your coding assistant to
`node_modules/@sempods/app-sdk/docs/ai-app-builder.md`: the package ships its
guides and examples at the installed version. To try unreleased SDK changes, use the quickstart's
[packed SDK archives](quickstart.md#trying-unreleased-sdk-changes). To ship it
as an installable app, add the [PWA setup](pwa.md).
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
- `UpdateNotice` for every write's outcome.

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

## Give this to your AI assistant

After installing the SDK, paste:

> Build a sempods frontend for [idea + first useful interaction]. First read
> node_modules/@sempods/app-sdk/docs/ai-app-builder.md and its linked guides.
> Use app-sdk and the quickstart's matching, exact package versions. My test Pod
> is [URL / not ready]; use synthetic data in a dedicated context. Propose a small
> screen/data plan, then implement one working slice with standard SDK guards and
> recovery UI. Verify installed APIs rather than guessing. Report build/test
> results and untested live flows. Prepare deployment for [domain / undecided];
> leave publication and changes to real data under my control.

Before your demo, run the app build and the
[end-to-end walkthrough](local-testing.md#walk-through-one-complete-app).
The [AI entry guide](ai-app-builder.md) is the full instruction set; keep it
and its references available for the next session.
