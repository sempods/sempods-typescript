# TODO

In an SDK checkout, from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:todo
```

`@sempods/app-sdk` also ships these sources, under
`node_modules/@sempods/app-sdk/examples/todo/`, for reading and copying. There
they are not a runnable project: the development server and build setup are
part of the SDK repository. The screen is built from
[`@sempods/app-ui`](../../packages/app-ui/README.md) on Tailwind CSS 4, as apps
from the [apps template](https://github.com/sempods/sempods-apps-template)
are; `src/style.css` is the kit's documented stylesheet setup. To use the
screens in your own app, set up the kit as its README describes, copy
`src/domain.ts` and `src/app.tsx` into its `src/`, and render
`<TodoApp runtime={runtime} />` from your entry with the runtime configuration
shown in `src/main.tsx`. The shipped `package.json` names the exact SDK and kit
versions the sources belong to. Like the kit, the screen compiles without
`exactOptionalPropertyTypes`, which React Aria's declarations do not support
(`tsconfig.json` here, for the screen and the recipes on the kit); the other
examples keep it.
An app that already has a host (the template's starter, or any screen with its
own `SempodsProvider`) does not render `TodoApp`: it brings a second provider
and its own language state. Reuse `TaskScreen` and `TaskRow` inside the
existing provider instead.
`recipes/pod-overview.tsx` (a Pod overview with on-demand Contexts, plus
creating and editing in an explicit Context), `recipes/overview-toggle.tsx` (ticking tasks on overview rows in
their own Contexts with one click, through `usePodList` and `useContextUpdate`), `recipes/task-with-note.tsx` (one input
written into a shared and a personal Context) and `recipes/clear-done.tsx`
(deleting all done tasks after one confirmation, stopping safely at the first
conflict, uncertain answer or changed target) are further copyable screens,
built from the same kit; their row tick is still a native checkbox, as the
kit has none yet.

The default palette is the kit's sage in light and dark mode, shared by the app
and SDK surfaces. Set palette roles in `src/style.css` to adapt it, as the
kit's [theme contract](../../packages/app-ui/README.md#the-theme-contract)
describes; no theme provider is needed. The entry also imports `src/browser-theme.ts`
to synchronize marked page meta colours. See [PWA colours](../../docs/pwa.md#colours-and-system-ui)
for the HTML/manifest setup and the limits of native system bars.

Open `http://127.0.0.1:5173/`; `pnpm dev:todo` builds the stylesheet with
Tailwind CSS 4. The app uses only the SDK's standard UI and the kit:
`AppAccess` for the startup screen, sign-in, the list catalogue's loading and
failure states, prompts and **Pods & sharing**, `ContextSwitch` as the
header's list switch, which also picks the first list, `HeaderMenu`
for the header menu, `Input` and `ActionButton` for the new task, and
`ResourceEditor` and `UpdateNotice` for editing and outcomes. The sign-in
screen's settings (`AppAccess` `settings`) and the header menu pick the
language, each named in itself (Deutsch, English), and the appearance
(System, Light, Dark). `src/appearance.ts` keeps the appearance in this
browser and marks `<html>`; `src/style.css` maps it to `color-scheme` and the
kit's `dark:` utilities, and `src/browser-theme.ts` follows it. Enter the Pod address and
sign in on the Pod; the app then shows a list (a readable Context) and names
it in the header, where the switch lists every list of the connected Pod and
shares more. The UI follows the browser's language until one is picked; the
kit's controls (`I18nProvider`) and the page's `lang` follow it too. No
protocol or session logic lives in the app. The callback route is served by the development server. Configure
a production identity/HTTPS origin before deploying; see
[browser runtime](../../docs/browser-runtime.md).

On `pagehide`, the entry unmounts React and disposes the runtime. A native
back/forward-cache return mounts a fresh host, restoring its saved session and
Context. Browser navigation still ends in-memory drafts; this does not persist
unsaved work.

Create, list, rename, complete, reopen and delete tasks: the checkbox finishes
or reopens a task (`useFieldUpdate`'s `for(item)`: a tick locks
only its row), its title opens the editor in its place, done tasks move to
their own section below the open ones and offer a delete button that asks
first (`RemoveButton` with `row.remove` from `mutate.for(item)`), and the
input above the list adds one. Add stays enabled: with nothing to add it moves
the focus into the input; it is locked only while a creation is sent or
unresolved. The list reads again when the page becomes visible
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
