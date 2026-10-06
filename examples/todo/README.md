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

Open `http://127.0.0.1:5173/` for the centered `AppAccess` login and app-owned
layout. Use **Data access** to open management after connecting. `/legacy` retains
AppShell and `/custom` shows a fully custom layout. Enter your Pod link, sign in
on the Pod, then explicitly select a context.
The screens share `src/domain.ts` and `TaskScreen`; no protocol or session logic
is duplicated. The callback route is served by the development server. Configure
a production identity/HTTPS origin before deploying; see
[browser runtime](../../docs/browser-runtime.md).

Create, list, rename, complete, reopen and delete tasks. EN/DE switches retranslate
controls without changing an open draft. Row/context/Pod switches confirm dirty
drafts. Conflict and lost-answer feedback requires comparison before continuing;
no write is automatically replayed. The new-task input is cleared only after
confirmed creation, acknowledgement of a resource observed on the Pod, or confirmed
leave. If comparison finds no resource, acknowledgement keeps the input locked
and enables an explicit Add retry with the same captured IRI and body. This does
not replay automatically or create a second task if the original arrives late.

The provisional Focus subset uses `schema:Action`, untagged `schema:name`, explicit
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
