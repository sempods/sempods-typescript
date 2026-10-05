# @sempods/app-sdk

Browser coordination and presentation primitives, with optional React.

- `.`: `createBrowserRuntime`, connection/startup/access facts, `BoundView`,
  runtime errors, headless authoring/selection helpers, locale/formatting and EN/DE messages.
- `./react`: `SempodsProvider`, optional `AppShell`, view/load/workflow/edit hooks,
  `useList`, guarded `useCreation`/`useSelection`, `TargetScreen`, standard
  editor/feedback and locale providers. React is an
  optional peer; consumers of this entry install it themselves.

The runtime handles dynamic/did:web Code + PKCE login, durable sessions,
sequential multi-Pod connections, shared reactive refresh and lifetime-bound
views. Configure `preset: { podUrl, contextIri? }` for a known Pod: the default
controls offer sign-in without a URL input, and guarded `useApp().connect()` can
omit the URL. `runtime.preset` / `useAppState().preset` expose the frozen
configuration (`PodPreset`). The optional exact context requires fresh catalogue
evidence; other stored Pods are preserved. This is a preset, not an allowlist.
Screens receive views without credentials. It creates no request,
navigation or storage on import or construction.

The runtime uses the production `createPod` client by default; `podFactory` is
an optional advanced composition seam. Both the runtime's transport fixtures and
the packed Chromium consumer exercise that client, including direct composition
with the edit controller. See [browser runtime](../../docs/browser-runtime.md)
for configuration, startup reports, subscriptions, scope/access behavior and
remaining limits. Live Kotlin validation remains separate work. See [React/headless authoring](../../docs/react-authoring.md)
and the runnable [TODO](../../examples/todo/README.md).

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

Supported: Node 22.19 or newer (ESM only); current browsers with IndexedDB and
Web Locks in a normal browser tab; React 19 for `./react`. Installed PWAs are
experimental: desktop Chromium and Android are expected to work, iOS/iPadOS
home-screen apps are unverified. See [supported environments](../../README.md#supported-environments).

The package installs client-sdk. Plain consumers need neither React nor its types;
packed-consumer checks prove this with actual installations. Licensed under
Apache-2.0 (see LICENSE and NOTICE). See [provenance](PROVENANCE.md) and
[development evidence](../../docs/development.md).
