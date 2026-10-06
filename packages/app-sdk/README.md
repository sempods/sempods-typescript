# @sempods/app-sdk

Browser coordination and presentation primitives, with optional React.

- `.`: `createBrowserRuntime`, connection/startup/access facts, `BoundView`, `BoundPod`,
  runtime errors, headless authoring/selection helpers, locale/formatting and EN/DE messages.
- `./react`: `SempodsProvider`, composable `AppAccess`, optional `AppShell`, view/load/workflow/edit hooks,
  `useList`, guarded `useCreation`/`useSelection`, `TargetScreen`, standard
  editor/feedback and locale providers. React is an
  optional peer; consumers of this entry install it themselves.

The runtime handles dynamic/did:web Code + PKCE login, durable sessions,
sequential multi-Pod connections, shared reactive refresh and lifetime-bound
views and independent Pod readers. Configure `preset: { podUrl, contextIri? }` for a known Pod: the default
controls offer sign-in without a URL input, and guarded `useApp().connect()` can
omit the URL. `runtime.preset` / `useAppState().preset` expose the frozen
configuration (`PodPreset`). The optional exact context requires fresh catalogue
evidence; other stored Pods are preserved. This is a preset, not an allowlist.
Add `allowedPods: [url]` (or several canonical URLs) to enforce an immutable Pod
restriction; omission stays unrestricted. Foreign stored sessions remain saved
but cannot restore or yield views under that policy. `runtime.allowedPods` and
`useAppState().allowedPods` expose it; a sole allowed Pod is also the default for
argument-free connect. `AppAccess` supplies a centered login/recovery surface,
optional app icon and friendly Pod selection, hiding when usable. It sits beside
app content; the app owns its layout and may open management explicitly. Legacy
AppShell composes a title, management control and AppAccess; its existing props and replaceable controls remain supported. Access, editor and notice components share inherited `--sempods-*` styling tokens.
Screens receive views and read-only Pod handles without credentials. It creates no request,
navigation or storage on import or construction.

The runtime uses the production `createPod` client by default; `podFactory` is
an optional advanced composition seam. Both the runtime's transport fixtures and
the packed Chromium consumer exercise that client, including direct composition
with the edit controller. See [browser runtime](https://github.com/sempods/sempods-typescript/blob/v0.3.0/docs/browser-runtime.md)
for configuration, startup reports, subscriptions, scope/access behavior and
remaining limits. Live Kotlin validation remains separate work. See [React/headless authoring](https://github.com/sempods/sempods-typescript/blob/v0.3.0/docs/react-authoring.md)
and the runnable [TODO](https://github.com/sempods/sempods-typescript/blob/v0.3.0/examples/todo/README.md).

```tsx
import { SdkLocaleProvider, useSdkLocale } from '@sempods/app-sdk/react';

function ConnectLabel() {
  return <span>{useSdkLocale().messages.reviewAccess}</span>;
}

<SdkLocaleProvider locale="de-CH" timeZone="Europe/Zurich">
  <ConnectLabel />
</SdkLocaleProvider>;
```

Translation language, regional formatting, direction and time zone are independent
options. Message overrides are ordinary functions/text; failure texts are overridden
per code (`messages.errors.catalogue`, etc.), so a new client failure code never
breaks an app's overrides. `describeFailure` and `createLocale().error(cause)`
present structured failures without exposing diagnostics. Locale updates preserve
child state. Runtime failures expose structured facts; AppShell and editing components provide
localized workflow feedback. Neither entry starts login,
discovery or storage on import.

Supported: Node 24.15 or newer (ESM only); current browsers with IndexedDB and
Web Locks in a normal browser tab; React 19 for `./react`. Installed PWAs are
experimental: desktop Chromium and Android are expected to work, iOS/iPadOS
home-screen apps are unverified. See [supported environments](https://github.com/sempods/sempods-typescript/blob/v0.3.0/README.md#supported-environments).

The package installs client-sdk. Plain consumers need neither React nor its types;
packed-consumer checks prove this with actual installations. Licensed under
Apache-2.0 (see LICENSE and NOTICE). See [provenance](PROVENANCE.md) and
[development evidence](https://github.com/sempods/sempods-typescript/blob/v0.3.0/docs/development.md).

## Pod reads without a Context

Use `runtime.bindPod(connectionId)` after the connection is signed in. Its
`select`/`construct` methods query the authorized Pod dataset without a catalogue
or selected Context. The cached `BoundPod` exposes a stable access snapshot and
subscription; missing required scopes set `read: false` and block dispatch.
Context changes, catalogue outcomes and labels do not invalidate its reads.
Session replacement/end and changed grants do. A Pod `403` is an operation refusal,
without a catalogue reload or inferred session change. Writes remain on `BoundView`.
The headless controller exposes the active reader as `AppSnapshot.pod`.

Automatic Context descriptions now load only for the selected, validated Context,
including preset/remembered restoration. Other picker entries immediately use
IRI/derived names, for small and large Pods alike. Completed label attempts are
cached within the access lifetime; failed attempts keep the fallback without an
automatic retry loop. Selection changes cancel pending labels and ignore stale
answers. Session/grant changes clear label authority.

Controller startup still requests catalogues under its existing policy. React Pod
loaders and on-demand discovery are the next increment (#39).

## Documentation for app authors and AI assistants

This package ships its app-author reference at the same version as the code:
the AI entry `docs/ai-app-builder.md`, the guides it links and the TODO example.
After installation, point your coding assistant to
`node_modules/@sempods/app-sdk/docs/ai-app-builder.md`; assistants do not look
inside `node_modules` by themselves. The same entry is
[online](https://github.com/sempods/sempods-typescript/blob/v0.3.0/docs/ai-app-builder.md).
Documentation is CC BY 4.0 and code examples Apache-2.0, as stated in `NOTICE`.
