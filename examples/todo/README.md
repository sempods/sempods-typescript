# TODO

In an SDK checkout, from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:todo
```

`@sempods/app-sdk` also ships these sources, under
`node_modules/@sempods/app-sdk/examples/todo/`, for reading and copying. There
they are not a runnable project: the development server and build setup are
part of the SDK repository. To use the screens in your own app, start it with
the [quickstart](../../docs/quickstart.md), copy `src/domain.ts`, `src/app.tsx`
and `src/style.css` into its `src/`, and render `<TodoApp runtime={runtime} />`
from your entry with the runtime configuration shown in `src/main.tsx`. The
shipped `package.json` names the exact SDK version the sources belong to.
`recipes/pod-overview.tsx` (a Pod overview with on-demand Contexts, plus
creating and editing in an explicit Context), `recipes/overview-toggle.tsx` (ticking tasks on overview rows in
their own Contexts with one click, through `usePodList` and `useContextUpdate`) and `recipes/task-with-note.tsx` (one input
written into a shared and a personal Context) are further copyable screens.

Open `http://127.0.0.1:5173/`. The app uses only the SDK's standard UI:
`AppAccess` for sign-in and recovery beside the app's own header and task
screen, `ResourceEditor` and `UpdateNotice` for editing and outcomes. The ⋮ menu
in the header (a native popover) opens **Pods & sharing** after connecting and
picks the language. Enter the Pod address and sign in on the Pod; the app
then shows a list (a readable Context) and names it in the header. With several
lists the title switches between them (`useContexts()`). The UI follows the
browser's language until EN/DE is picked. No protocol or session logic lives in
the app. The callback route is served by the development server. Configure
a production identity/HTTPS origin before deploying; see
[browser runtime](../../docs/browser-runtime.md).

On `pagehide`, the entry unmounts React and disposes the runtime. A native
back/forward-cache return mounts a fresh host, restoring its saved session and
Context. Browser navigation still ends in-memory drafts; this does not persist
unsaved work.

Create, list, rename, complete, reopen and delete tasks: the checkbox finishes
or reopens a task (`useFieldUpdate`'s `for(item)`: a tick locks
only its row), its title opens the editor below the list, a done task
offers a delete button that asks first (`RemoveButton` with
`mutate.remove(item)`), and the input at the bottom adds one. The list reads again when the page becomes visible
(no reload button) and keeps its rows while it reloads and after a failed
refresh; `LoadNotice` says what the read does, with a retry. A new or changed row is its own
confirmation (`UpdateNotice quiet`); refusals, conflicts and unconfirmed
outcomes still show. The UI starts in the browser's language (German or
English, else English); picking one in the menu retranslates
controls without changing an open draft. Row/context/Pod switches confirm dirty
drafts. Conflict and lost-answer feedback requires comparison before continuing;
no write is automatically replayed. The new-task input is cleared only after
confirmed creation, acknowledgement of a resource observed on the Pod, or confirmed
leave. If comparison finds no resource, acknowledgement keeps the input locked
and enables an explicit Add retry with the same captured IRI and body. This does
not replay automatically or create a second task if the original arrives late.

The example's task mapping uses `schema:Action`, untagged `schema:name` and explicit
Potential/Completed action status. Creation writes these declared fields; edits
preserve other RDF terms already present. Unsupported list entries are
reported, not converted into plausible tasks. Broader task-vocabulary interoperability and mixed Action collections remain
separate application-design work.

[Authoring guide](../../docs/react-authoring.md) explains the public hooks, picker
replacement, message overrides, read recovery and lifecycle. `pnpm test:todo`
checks this actual example against packed SDKs and an isolated loopback fixture.
The screen uses `useList`, `useCreation`, `useSelection` and `TargetScreen`;
lists refresh after its own confirmed writes, and creation recovery owns its draft.
Independent human authoring and live-Pod validation remain pending.
