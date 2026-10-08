# @sempods/app-sdk

Connect a browser app to sempods without putting login, tokens or write recovery
in every screen. The runtime owns durable sessions and target access; authoring
helpers keep drafts, conditional edits and recovery attached to that target.

Choose the entry that fits your UI:

| Entry                    | What it supplies                                                                     | React required? |
| ------------------------ | ------------------------------------------------------------------------------------ | --------------- |
| `@sempods/app-sdk`       | Browser runtime, bound readers/views, headless authoring, locale and EN/DE messages  | No              |
| `@sempods/app-sdk/react` | Provider, access controls, loaders, typed lists/forms and editor/recovery components | Yes, React 19   |

The package depends on `@sempods/client-sdk` and uses its production client.
For portable Node scripts or protocol operations without browser sessions, use
[client-sdk](https://github.com/sempods/sempods-typescript/blob/v0.4.1/packages/client-sdk/README.md).
Both entries provide ESM and TypeScript declarations. Importing the package or
constructing a runtime starts no requests, navigation or storage.

## A browser host

Create one stable runtime outside rendering. This composition uses the app's
HTTPS identity and lets the person choose a Pod and context:

```tsx
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
} from '@sempods/app-sdk/react';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:tasks.example.org',
    redirectUri: 'https://tasks.example.org/callback',
  },
});

export function App() {
  return (
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="My tasks" />
      <TargetScreen>
        <p>Your selected context is ready.</p>
      </TargetScreen>
    </SempodsProvider>
  );
}
```

Replace the identity with your own deployment and serve this app on the callback
route too. The provider initializes the runtime; the host disposes it when the
application lifetime ends. For local development, field definitions, a task
screen and access-management controls, follow the complete
[quickstart](https://github.com/sempods/sempods-typescript/blob/v0.4.1/docs/quickstart.md).

`AppAccess` provides login, context choice and recovery without a mandatory app
frame. It hides when access is usable, including read-only access. The app owns
its layout and a way to reopen data-access management. Optional `AppShell` adds a
title and management control. Use `useList`, `useCreation`, `useFieldUpdate` and
`useResourceEditor` for data screens, with `ResourceEditor` and `UpdateNotice`
for editing feedback. See
[React/headless authoring](https://github.com/sempods/sempods-typescript/blob/v0.4.1/docs/react-authoring.md)
and the runnable [TODO example](https://github.com/sempods/sempods-typescript/blob/v0.4.1/examples/todo/README.md).

## Connection and target choices

- Omit `preset` to let the person choose a Pod. A
  `preset: { podUrl, contextIri? }` supplies a default; it preserves other saved
  Pods and allows explicit connections elsewhere.
- Add `allowedPods: [url]` or several canonical URLs to restrict the permitted
  Pods. Excluded sessions stay saved but cannot restore or yield readers/views.
  A sole allowed Pod also supplies the default for argument-free connect.
- An exact preset context needs fresh readable catalogue evidence. There is no
  fallback to another context. Context grants and feature scopes remain separate;
  the Pod authorizes every operation.

`runtime.preset` and `useAppState().preset` expose the frozen default as
`PodPreset | undefined`; `PodPreset` is exported by the root entry.

The runtime supports dynamic/did:web Code + PKCE login, IndexedDB sessions,
sequential multi-Pod connections and shared renewal before expiry or after a
refused request. Screens receive bound views/readers without credentials.
See [browser runtime](https://github.com/sempods/sempods-typescript/blob/v0.4.1/docs/browser-runtime.md)
for startup outcomes, restrictions and recovery limits.

## Pod reads without a context choice

`runtime.bindPod(connectionId)` supplies read-only `select`/`construct` methods
for the signed-in connection's authorized dataset. It needs no catalogue or
selected context. Required feature scopes gate dispatch; Context/label changes
do not invalidate these independent reads. Writes remain on a validated
`BoundView`. After 0.4.1, `runtime.bindContext(connectionId, contextIri)` binds
such a view to an explicit Context, for example a row's `GRAPH` Context, without
changing the selection.

For a React overview, use `contextSelection="on-demand"` on `SempodsProvider`
and `usePodLoad`. Startup and read recovery then request no catalogue. Mount
`TargetScreen` when a Context flow is wanted, or open `AppAccess` management;
**Check access** retries failed discovery explicitly. Preset/remembered targets
still need fresh readable evidence. `useWorkflowAccess` remains Context-only.

Context pickers use immediate derived-name/IRI fallbacks. Only the selected,
validated Context's label is fetched; cached labels never gate selection or
reads. After 0.4.1, `useContextEditor` edits an overview row in the Context its
`GRAPH` binding names, without changing the selection. The [copyable 0.4.1 Pod overview](https://github.com/sempods/sempods-typescript/blob/v0.4.1/examples/todo/recipes/pod-overview.tsx)
rereads and conditionally saves the row in its Context in app code, but selects
that Context to do so, which can prompt about or retarget other Context-bound
drafts; editing without changing the selection is new with the hook.

## Presentation and documentation

UI language, regional formatting, time zone and RDF text language are separate
choices. `SempodsProvider` accepts locale/message options; SDK controls share
inherited `--sempods-*` styling tokens. Translating or theming the screen preserves
its drafts. The [authoring guide](https://github.com/sempods/sempods-typescript/blob/v0.4.1/docs/react-authoring.md)
shows message overrides, custom controls and non-React composition.

Override individual failure texts with `messages.errors[code]` as well as UI
text with `messages.controls`. Overrides are partial: new SDK failure codes
keep their defaults without requiring app changes. For headless presentation,
`createLocale(options).error(cause)` formats a caught cause;
`describeFailure(errors, reason)` formats an already structured failure using
a complete message catalog. Both helpers omit diagnostic details.

This package ships its app-author reference at the same version as the code.
Point your coding assistant to
`node_modules/@sempods/app-sdk/docs/ai-app-builder.md`; it links the guides and
examples installed with the SDK. The same entry is
[online](https://github.com/sempods/sempods-typescript/blob/v0.4.1/docs/ai-app-builder.md).

Use Node 24.15 or newer for tooling. The runtime needs browser IndexedDB and Web
Locks; plain consumers need neither React nor its types. React consumers install
React 19 themselves. Automated browser checks run in Chromium. Installed PWAs
are experimental; iOS/iPadOS home-screen login is unverified. See
[supported environments](https://github.com/sempods/sempods-typescript/blob/v0.4.1/README.md#supported-environments)
and [development evidence](https://github.com/sempods/sempods-typescript/blob/v0.4.1/docs/development.md).

Code is Apache-2.0; documentation is CC BY 4.0, as stated in `NOTICE`.
[Provenance](PROVENANCE.md) records the adaptations and their evidence.
