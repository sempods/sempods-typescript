# Quickstart: from an empty folder to a task in your Pod

This is the shortest path to a working sempods app in the browser: login,
context choice, a task list, one-click completion and safe editing. It uses the
published SDK packages, Vite and React.
For the idea behind the example, start with [build your own app](build-your-app.md);
for AI assistance, supply [the app-builder instructions](ai-app-builder.md).
For several personal apps in one repository, with setup and updates handled by
your assistant, start from the
[sempods apps template](https://github.com/sempods/sempods-apps-template)
instead.

You need Node 24.15 or newer (Node 24 LTS), and a sempods Pod with a context you may grant
to an app. No feature scopes are needed for data: the person grants context
access when consenting (SPS-AUTH-024).

## 1. Create the app and install the SDK

```sh
npm create vite@latest my-tasks -- --template react-ts --no-immediate
cd my-tasks
npm install
npm install --save-exact @sempods/app-sdk@0.5.0 @sempods/client-sdk@0.5.0
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

const schema = 'https://schema.org/';

export const task = fields(
  {
    title: text(`${schema}name`, { language: null }),
    done: flag(`${schema}actionStatus`, {
      on: `${schema}CompletedActionStatus`,
      off: `${schema}PotentialActionStatus`,
    }),
  },
  { type: `${schema}Action` },
);
```

## 3. The app: `src/App.tsx`

```tsx
import { useRef, useState } from 'react';
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  LoadNotice,
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
if (import.meta.hot) {
  import.meta.hot.dispose(() => runtime.dispose());
}

export default function App() {
  return (
    <SempodsProvider runtime={runtime}>
      <AppContent />
    </SempodsProvider>
  );
}

function AppContent() {
  const [open, setOpen] = useState(false);
  const focusTarget = useRef<HTMLButtonElement>(null);
  const { connections } = useAppState();
  const { messages } = useSdkLocale();

  return (
    <main>
      {connections.length > 0 && (
        <button
          ref={focusTarget}
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          {messages.controls.dataAccess}
        </button>
      )}
      <AppAccess
        appName="My tasks"
        open={open}
        onClose={() => setOpen(false)}
        focusTarget={focusTarget}
      />
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
  // One hook for the list; each row gets its part with `mutate.for(item)`.
  const mutate = useFieldUpdate(task);
  const { selected, select } = useSelection();
  const editor = useResourceEditor(selected, task);

  return (
    <section>
      <LoadNotice {...list} />
      {list.data?.items.map((item) => {
        const row = mutate.for(item);
        return (
          <div key={item.iri}>
            <input
              type="checkbox"
              aria-label={`Complete ${row.data.title}`}
              checked={row.data.done}
              disabled={!row.canMutate}
              onChange={() => void row.update({ done: !row.data.done })}
            />
            <button onClick={() => void select(item.iri)}>
              {row.data.title}
            </button>
            {/* The changed row is the confirmation; problems show here. */}
            <UpdateNotice {...row.notice} quiet />
          </div>
        );
      })}
      {selected && (
        <ResourceEditor editor={editor} onClose={() => select(null)}>
          {(draft, change) => (
            <input
              aria-label="Task title"
              value={draft.title}
              onChange={(event) => change({ title: event.target.value })}
            />
          )}
        </ResourceEditor>
      )}
      <UpdateNotice {...creation.notice} quiet />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          creation.change({ title: creation.draft.title.trim() });
          void creation.create();
        }}
      >
        <input
          aria-label="New task"
          value={creation.draft.title}
          disabled={!creation.canEdit}
          onChange={(event) => creation.change({ title: event.target.value })}
        />
        <button disabled={!creation.canCreate}>Add</button>
      </form>
    </section>
  );
}
```

`useCreation` owns the draft, its leave guard and one captured creation command.
`useSelection` asks before replacing a dirty editor. `mutate.for(item)` gives
each row what to show (`data`, with a confirmed tick at once), its lock
(`canMutate`, so a tick locks only its row), its notice and its commands.
`canCreate` and `row.canMutate` reflect access and pending recovery, and `canCreate` also a valid draft: a blank
title keeps Add disabled without app code. The input also locks while creation is
pending or uncertain. When an outcome is unclear, `UpdateNotice` lets the person
check the Pod's current version before acknowledging; nothing is resent. A success notice retires once another of these writes on
the target starts, so the notices show the last action; unresolved outcomes stay until
acknowledged. `useList` refreshes after this target's own confirmed
writes; `TargetScreen` resets app-local state on a target change. The
[TODO example](../examples/todo/src/app.tsx) adds an icon and a header menu
with the language switch.

Replace Vite's demo styles in `src/index.css`. AppAccess, the editor and the
notices style themselves from the `--sempods-*` tokens; set them once so your
own elements match (the [TODO example's styles](../examples/todo/src/style.css)
add a checkbox list, text buttons and the input row):

```css
:root {
  color-scheme: light dark;
  --sempods-bg: light-dark(#fff, #111315);
  --sempods-text: light-dark(#1f2933, #e5e7eb);
  --sempods-muted: light-dark(#6b7280, #9ca3af);
  --sempods-line: light-dark(#e5e7eb, #2d3138);
  --sempods-accent: light-dark(#1f2933, #e5e7eb);
  --sempods-on-accent: light-dark(#fff, #111315);
  font:
    400 1rem/1.5 system-ui,
    sans-serif;
  color: var(--sempods-text);
  background: var(--sempods-bg);
}
body {
  margin: 0;
}
main {
  max-width: 640px;
  margin: auto;
  padding: 16px;
}
button,
input {
  font: inherit;
  min-height: 44px;
}
```

## 4. Run it

```sh
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
```

Open `http://127.0.0.1:5173/`, enter the Pod address and sign in on the Pod. Grant
a context, choose it, then add, complete and rename tasks. Open the app on a
second device or in a private window: when both rename the same task, the editor
shows both versions; when one renames and the other completes, both changes stay.
During such a conflict the browser console logs the Pod's `412` answer; that is
expected, and the editor shows the comparison.

After a reload the session stays signed in and the app returns to the context
you chose last, as long as the Pod still lets you read it; otherwise you choose
again. To grant the app another context later, use **Change sharing** and choose
the new context after returning. A second ordinary tab of the same app shows that
the app is open in another tab; one tab holds the session at a time. Use a private
window or another browser profile to act as a second person.

The development server also serves the callback path (`/callback`), so no extra
route is needed.

Need a Pod, or seeing an unexpected result? [Local and hosted testing](local-testing.md)
explains both setups and what should happen at each step. After editing the
example, run `npm run build` to check types and the production bundle.

## 5. Deploy with a `did:web` identity

A deployed app identifies itself by its own HTTPS origin; it does not register,
and a conforming Pod needs no DID document (SPS-AUTH-003/007), though
[some Pods require one](deployment.md#pods-that-also-require-a-did-document).
The callback must be on the same host and port, and inside the identifier's
path when the identifier has one (SPS-AUTH-004/005):

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
[TODO example](../examples/todo/src/app.tsx) for messages and recovery details.
