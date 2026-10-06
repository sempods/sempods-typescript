# Quickstart: from an empty folder to a task in your Pod

This is the shortest path to a working sempods app in the browser: login,
context choice, a task list, one-click completion and safe editing. It uses the
published SDK packages, Vite and React.
For the idea behind the example, start with [build your own app](build-your-app.md);
for AI assistance, supply [the app-builder instructions](ai-app-builder.md).

You need Node 24.15 or newer (Node 24 LTS), and a sempods Pod with a context you may grant
to an app. No feature scopes are needed for data: the person grants context
access when consenting (SPS-AUTH-024).

## 1. Create the app and install the SDK

```sh
npm create vite@latest my-tasks -- --template react-ts --no-immediate
cd my-tasks
npm install
npm install --save-exact @sempods/app-sdk@0.3.0 @sempods/client-sdk@0.3.0
```

`--no-immediate` keeps Vite from installing and starting its demo server right
away, so you can install the SDK first.

Both packages are released together with one version, and app-sdk depends on
exactly that client-sdk version. Name the same explicit version for both, saved
exactly, and commit the lockfile: two unversioned installs can pick different
versions while a release is in progress and add a second, nested client-sdk.
To upgrade, change both to the next shared version at once.

### Trying unreleased SDK changes

From a checkout of the SDK repository (using the pnpm version in its
`package.json`), pack both packages and install the archives in your app instead:

```sh
pnpm install --frozen-lockfile && pnpm build
pnpm --filter @sempods/client-sdk pack --pack-destination ../sempods-packages
pnpm --filter @sempods/app-sdk pack --pack-destination ../sempods-packages
```

Then, in the app, `npm install` both `.tgz` files from that directory.

## 2. Describe your data once: `src/tasks.ts`

```ts
import { fields, flag, text } from '@sempods/client-sdk/edit';
const S = 'https://schema.org/';
export const task = fields(
  {
    title: text(`${S}name`, { language: null }),
    done: flag(`${S}actionStatus`, {
      on: `${S}CompletedActionStatus`,
      off: `${S}PotentialActionStatus`,
    }),
  },
  { type: `${S}Action` },
);
```

## 3. The app: `src/App.tsx`

The `AppAccess` composition below needs 0.3.0 or newer. For an older installed
version, use the reference shipped with that exact version.

```tsx
import { useRef, useState } from 'react';
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useCreation,
  useFieldUpdate,
  useList,
  useResourceEditor,
  useSelection,
  useAppState,
  useSdkLocale,
} from '@sempods/app-sdk/react';
import { task } from './tasks';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'dynamic',
    name: 'My tasks',
    redirectUri: `${location.origin}/callback`,
  },
  development: 'loopback-http', // local HTTP only; remove when deployed
});

// Vite hot replacement ends this module's runtime lifetime.
if (import.meta.hot) import.meta.hot.dispose(() => runtime.dispose());

export default function App() {
  return (
    <SempodsProvider runtime={runtime}>
      <AppContent />
    </SempodsProvider>
  );
}

function AppContent() {
  const [open, setOpen] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  const { connections } = useAppState();
  const { messages } = useSdkLocale();
  return (
    <main>
      {connections.length > 0 && (
        <button
          ref={target}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {messages.controls.dataAccess}
        </button>
      )}
      <AppAccess appName="My tasks" open={open} focusTarget={target} />
      <TargetScreen>
        <Tasks />
      </TargetScreen>
    </main>
  );
}

function Tasks() {
  const list = useList(task);
  const creation = useCreation(task, {
    initial: { title: '', done: false },
    collection: 'tasks',
  });
  const update = useFieldUpdate(task);
  const { selected, select } = useSelection();
  const editor = useResourceEditor(selected, task);
  return (
    <section>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          creation.change({ title: creation.draft.title.trim() });
          void creation.create();
        }}
      >
        <input
          aria-label="New task"
          value={creation.draft.title}
          disabled={!creation.canEdit}
          onChange={(e) => creation.change({ title: e.target.value })}
        />
        <button disabled={!creation.canCreate}>Add</button>
      </form>
      <UpdateNotice {...creation.notice} />
      <UpdateNotice {...update.notice} />
      {list.state.kind !== 'ready' && (
        <p role="status">List: {list.state.kind}</p>
      )}
      {list.state.kind === 'ready' && list.state.data.skipped > 0 && (
        <p>Unsupported entries: {list.state.data.skipped}</p>
      )}
      {list.state.kind === 'ready' &&
        list.state.data.items.map((t) => (
          <p key={t.iri}>
            <input
              type="checkbox"
              aria-label={`Complete ${t.data.title}`}
              checked={t.data.done}
              disabled={!update.canMutate}
              onChange={() => void update.update(t, { done: !t.data.done })}
            />
            <button onClick={() => void select(t.iri)}>{t.data.title}</button>
          </p>
        ))}
      {selected && (
        <ResourceEditor editor={editor}>
          {(draft, change) => (
            <input
              aria-label="Task title"
              value={draft.title}
              onChange={(e) => change({ title: e.target.value })}
            />
          )}
        </ResourceEditor>
      )}
    </section>
  );
}
```

`useCreation` owns the draft, its leave guard and one captured creation command.
`useSelection` asks before replacing a dirty editor. `canCreate`/`canMutate`
reflect access and pending recovery, and `canCreate` also a valid draft: a blank
title keeps Add disabled without app code. The input also locks while creation is
pending or uncertain. `UpdateNotice` checks the captured subject without replay
before acknowledgement. `useList` refreshes after this target's own confirmed
writes; `TargetScreen` resets app-local state on a target change. The
[TODO example](../examples/todo/src/app.tsx) adds EN/DE and a custom layout.

Replace Vite's demo styles in `src/index.css` with a simple baseline for your
app content. AppAccess supplies its own scoped login/recovery styles:

```css
:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  color: light-dark(#173740, #e8eee9);
  background: light-dark(#f6faf9, #191b1a);
}
body {
  margin: 0;
}
main {
  max-width: 760px;
  margin: auto;
  padding: 16px;
}
button,
input,
select {
  font: inherit;
  margin: 0.25rem;
  padding: 0.4rem;
}
input[type='checkbox'] {
  accent-color: #176354;
}
```

## 4. Run it

```sh
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/`, enter your Pod URL and sign in on the Pod. Grant
a context, choose it, then add, complete and rename tasks. Open the app on a
second device or in a private window: when both rename the same task, the editor
shows both versions; when one renames and the other completes, both changes stay.
During such a conflict the browser console logs the Pod's `412` answer; that is
expected, and the editor shows the comparison.

After a reload the session stays signed in and the app returns to the context
you chose last, as long as the Pod still lets you read it; otherwise you choose
again. To grant the app another context later, use **Update access** and choose
the new context after returning. A second ordinary tab of the same app shows that
the app is open in another tab; one tab holds the session at a time. Use a private
window or another browser profile to act as a second person.

The development server also serves the callback path (`/callback`), so no extra
route is needed.

Need a Pod, or seeing an unexpected result? [Local and hosted testing](local-testing.md)
explains both setups and what should happen at each step. After editing the
example, run `npm run build` to check types and the production bundle.

## 5. Deploy with a `did:web` identity

A deployed app identifies itself by its own HTTPS origin; it does not register
and needs no DID document (SPS-AUTH-003/007). The callback must be on the same
host and port, and inside the identifier's path when the identifier has one
(SPS-AUTH-004/005):

```ts
const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
});
```

For domain ownership, a copyable Netlify configuration, subpath hosting,
preview identities and credentials, follow [the deployment guide](deployment.md).
To make the app installable and open offline, follow [the PWA guide](pwa.md).

Remove `development: 'loopback-http'`, build (`npm run build`), and serve
`dist/` over HTTPS so that `/callback` also returns `index.html`. A loopback
`did:web` identifier is refused outside development (SPS-AUTH-006).

## What the SDK does for you

There are no tokens, ETags or retries in this code. The runtime keeps the
session across reloads and renews it. The editor saves conditionally and keeps
your draft during conflicts. List updates check that what you clicked is still
current. An answer lost on the network is shown as "not confirmed" and never sent
again silently. See [React authoring](react-authoring.md) and the full
[TODO example](../examples/todo/src/app.tsx) for custom layouts, messages and
recovery details.
