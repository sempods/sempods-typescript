# Hackathon: your sempods app at a glance

Build one useful interaction: a reading list, a shared task board, your own
research notebook. Your frontend owns the screen; app-sdk supplies login,
connections and safe editing. People keep their data in their Pod.

## Start here

Follow the [quickstart](quickstart.md) to create a Vite React/TypeScript app
(Node 24.15 or newer). Install the matching pair:

```sh
npm install --save-exact @sempods/app-sdk@0.3.0 @sempods/client-sdk@0.3.0
```

Commit the lockfile. Point your coding assistant to
`node_modules/@sempods/app-sdk/docs/ai-app-builder.md`: the package ships its
guides and examples at the installed version. To try unreleased SDK changes, use the quickstart's
[packed SDK archives](quickstart.md#trying-unreleased-sdk-changes). To ship it
as an installable app, add the [PWA setup](pwa.md).
`AppAccess` below is new in this checkout; use packed archives until a release
contains it, or the reference bundled with your installed version.
Use a dedicated test context and synthetic data; follow
[local or hosted Pod testing](local-testing.md) for setup.

## Ten API groups to keep nearby

Import the named APIs from the table's entry: **app** = `@sempods/app-sdk`,
**React** = `@sempods/app-sdk/react`, **edit** = `@sempods/client-sdk/edit`.
Full signatures and examples:
[authoring guide](react-authoring.md), [working task screen](../examples/todo/src/app.tsx).

| Job                             | API (entry)                                        | Remember                                                                     |
| ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Start the browser session       | `createBrowserRuntime` (app)                       | One stable runtime outside render; dispose at app shutdown.                  |
| Bind the UI to it               | `SempodsProvider`, `TargetScreen` (React)          | Provider initializes; TargetScreen resets app-local state per target.        |
| Get connection/context controls | `AppAccess` (React)                                | Place login/recovery beside your screen; the app owns its frame.             |
| Describe your data              | `fields`, `text`, `flag`, `iri`, `dateTime` (edit) | Choose exact predicate/type IRIs and an explicit text language.              |
| Read a typed list               | `useList` (React)                                  | Render rows only for `state.kind === 'ready'`; inspect `data.skipped`.       |
| Add an item                     | `useCreation` (React)                              | Bind inputs to `canEdit`, submit to `canCreate`; use its draft and `change`. |
| Update or remove a row          | `useFieldUpdate` (React)                           | Pass the original list snapshot; respect `canMutate`.                        |
| Edit a form safely              | `useResourceEditor`, `ResourceEditor` (React)      | Hook owns the editor; component supplies save/delete/recovery UI.            |
| Change selection                | `useSelection`, `useApp` (React)                   | Use guarded row selection and connection/context/navigation actions.         |
| Show mutation recovery          | `UpdateNotice` (React)                             | Render it with `{...creation.notice}` and `{...update.notice}`.              |

## Avoid the common traps

- **Connected is not selected.** Grant access, then explicitly choose a context.
  Empty selection never means “all”; the Pod authorizes each operation.
- **One tab per app.** A second tab of the same app shows that it is open
  elsewhere; use a private window for a second person. A reload keeps the session
  and the last chosen context while it is readable. **Update access** grants
  another context.
- **Unconfirmed is not failed.** A lost answer may hide a completed write.
  Use the SDK's comparison and acknowledgement UI; do not auto-retry or invent
  a fresh IRI for uncertain creation. [Recovery details](react-authoring.md#a-screen).
- **Local and deployed identities differ.** Local HTTP uses the quickstart's
  dynamic identity and `loopback-http` option. Deployment uses an explicit
  `did:web` identity, matching HTTPS callback host/port/path, and a route that
  serves the app. No DID document or client secret is needed for this sempods
  flow. [Domain setup and Netlify example](deployment.md).
- **A frontend cannot hide secrets.** `VITE_*` values enter the public bundle.
  Leave session tokens to the SDK; keep hosting/provider keys out of source,
  logs and AI prompts. UI language does not change RDF text language.

## Give this to your AI assistant

Supply the matching SDK checkout or documentation snapshot, then paste:

> Build a sempods frontend for [idea + first useful interaction]. First read
> docs/ai-app-builder.md and its required references from the supplied SDK docs.
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
