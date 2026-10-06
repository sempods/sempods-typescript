# Build a widget, let the host own the session

A dashboard can show a task list beside a quick-add form without using AppShell.
The list reads the selected context; the form creates a task there. A confirmed
creation refreshes the list. Both use one host session and one leave policy.

Start with the [widget source](../examples/todo/widgets/index.tsx). It is an
app-owned example library, not another SDK package or a published npm product.
It exposes `TaskListWidget` and `QuickAddWidget`, uses public SDK imports only,
and reuses the [access-panel recipe](../examples/todo/recipes/sign-in.tsx).
Its Action vocabulary matches the TODO subset; it does not treat every RDF
Action as a task. Copy the widget directory and its referenced recipe with their
relative layout, then adapt the private field mapping to your domain.

## The host configures, widgets consume

The host creates a stable runtime outside rendering. Its preset supplies the
Pod and optionally an exact context; its identity supplies the callback. The
host reconciles feature scopes across its widgets. Ordinary task CRUD needs
context grants, not an invented `tasks:write` feature scope.

```tsx
import { createBrowserRuntime } from '@sempods/app-sdk';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
} from '@sempods/app-sdk/react';
import { QuickAddWidget, TaskListWidget } from './widgets/index.js';

const runtime = createBrowserRuntime({
  identity: {
    kind: 'did-web',
    clientId: 'did:web:dashboard.example.org',
    redirectUri: 'https://dashboard.example.org/callback',
  },
  preset: { podUrl: 'https://pods.example/alice' },
});

export function Dashboard() {
  return (
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="My dashboard" />
      <TargetScreen>
        <TaskListWidget />
        <QuickAddWidget fallback="disabled" />
      </TargetScreen>
    </SempodsProvider>
  );
}
```

This is the composition core. `AppAccess` keeps startup, storage and callback
feedback outside widget content gates. Add an app-owned management toggle with
its `open` prop as in the [complete browser host](../tests/runtime-browser/widgets.tsx).
Its loopback identity, synthetic Pod URL and exposed lifecycle
controls are test configuration; use the [quickstart](quickstart.md) for local
identity and [deployment](deployment.md) for production callback routing.
The host must render on the callback route too.

`AppAccess` uses the preset/allowed Pods and the existing guarded `useApp().connect()`
path. It reuses a matching connection, and sign-in occurs only after a click.
You can replace those controls through the [authoring API](react-authoring.md#standard-ui-for-one-known-pod).
Widgets neither create a runtime/provider nor repeat connection matching,
login, callback, refresh, storage or service-worker code.

The two widgets deliberately share the same target. The preset is a default,
not an allowed-Pod policy: if the host explicitly selects another saved Pod,
both widgets follow that guarded selection together. They do not own separate
fixed targets. `TargetScreen` resets their
local state on a real target change and hides the entire pair before selection.
For disabled previews or custom content before selection, the test host instead
keys a Fragment with `useAppState().view?.key ?? 'no-target'`; the widgets can
mount without a view, and their SDK operations stay ineligible. It retains the
same key through same-target access recovery. Do not key by session status,
permission revision or locale.

## Hidden, disabled, custom — with recovery still reachable

Both example widgets accept the same app-owned `fallback` prop:

| Value                           | When the target is not readable                                |
| ------------------------------- | -------------------------------------------------------------- |
| `"hidden"` (default)            | Hide the content while retaining its controller and draft.     |
| `"disabled"`                    | Keep an inert preview; inputs also obey operation eligibility. |
| `{ content: <YourFallback /> }` | Hide content and show your replacement UI.                     |

The recipe projects `useWorkflowAccess()` facts and uses `AccessNotice`; it
does not add a session-state enum. The read-only list stays useful when write
permission is lost. The quick-add form uses `useCreation().canCreate/canEdit`
and write access. Hidden UI grants no authority and does not suspend arbitrary
custom effects: every request still uses a bound view and the Pod checks access.

Keep `UpdateNotice` outside the hidden/inert region. When a creation's answer is
lost, its captured IRI, draft and explicit check/acknowledge controls remain
available. Never remount the form to clear an error or retry with a new IRI.
The host's catalogue refresh checks access; it does not replay writes.
Callback errors and startup failures also belong outside content gates.

The recipe includes EN/DE SDK feedback and focus recovery when focused content
becomes hidden. It is a small app-owned starting point, not a complete generic
accessibility gate; custom fallback content needs its own labels and focus policy.

## Runtime and widget lifetime

Use one host runtime, one provider and one guard registry for this composition.
This is an ownership rule, not a global JavaScript singleton: constructing a
runtime does not acquire a lease. Initializing another runtime with the same
identity/storage partition can report `busy`. Changing its identity to get
around that creates another session rather than sharing the first one.

- Removing and remounting the read-only list leaves the sibling's draft and host
  session intact. The list subscribes again and reads through the same view.
- Keep a mutating widget mounted while it has a draft, pending operation or
  unconfirmed outcome, even when hidden. Arbitrary React unmount is not an SDK
  navigation action. In particular, `useApp().navigate()` guards local changes;
  it does not ask about every target-scoped creation draft. Do not use it as a
  generic “safe remove widget” or “safe reload” operation.
- A clean provider remount may consume the same runtime again. Unmounting the
  provider stops its controller subscription; it does not dispose the runtime.
  Unmounting a dirty provider still destroys React drafts. Only perform the
  demonstrated clean remount after work has settled.
- At complete host shutdown, dispose the runtime. Individual widgets must never
  dispose it. The browser host tests explicit disposal while the page is still
  open and verifies that another page can acquire the native lease. A pagehide
  hook ends the runtime lifetime on navigation; a host that restores a document
  from the back/forward cache must recreate a disposed runtime before reuse.
- Apply the same ownership to HMR: the host owns teardown/recreation, as in the
  quickstart. Widget imports and ordinary rerenders must not start login or
  register a worker.

## Package a library without copying the SDK

The [example manifest](../examples/todo/widgets/package.json) uses peer
dependencies for app-sdk, client-sdk and React. Its exact SDK peers describe the
tested pair; widen compatibility only after testing other revisions. If a widget
does not import client-sdk directly, it need not declare that peer. If it imports
React DOM, declare/externalize that peer too.

Externalize root imports **and subpaths**: `@sempods/app-sdk/react`,
`@sempods/client-sdk/edit`, `react/jsx-runtime`, and their package roots. The
test uses esbuild's `packages: 'external'`, retaining these imports and bundling
only the widget/recipe code. Keep field definitions private, or annotate exported
definitions with public SDK types when emitting library declarations; do not
expose inferred implementation-only brands in your library API.

Install the widget tarball in a separate host together with the matched SDK
versions. Inspect `npm ls @sempods/app-sdk @sempods/client-sdk react` and the host
bundle graph. A peer declaration alone does not prevent accidental bundling.
For a linked development library, check bundler resolution as well: symlinks can
produce two module instances even with the same version. React requires provider
and consumer to use the very same [context object](https://react.dev/reference/react/useContext#caveats).

The test deliberately builds a widget against a second app-sdk copy. Its hooks
fail with `SempodsProvider is required` despite the host provider. The correct
fix is shared package resolution, not a nested provider or a second runtime.
Duplicate modules do not bypass the browser's lease.

## Embedding profiles and limits

| Profile                                    | Status of this increment                                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Components imported into the host document | Demonstrated: two widgets, shared target, one runtime/provider.                                                   |
| Standalone mini app                        | Use a host around one widget; deployment/installed-PWA evidence is separate.                                      |
| Two simultaneous independent Pods/contexts | Future scoped-view/selection/guard contract. A multi-Pod runtime alone does not supply independent React targets. |
| Same-origin iframe                         | A separate document and React tree; this example does not share a provider/runtime across it.                     |
| Cross-origin isolated iframe               | Not supported by this recipe; requires a separate authentication/lifecycle design and browser evidence.           |

A script downloaded from another origin executes in the host document, which
owns the identity, privileges and callback. An iframe executes in its own
document. Cross-site storage partitioning can separate an iframe's stored attempt
from a top-level OAuth callback; opening a login tab is not proof of session
continuity. Pod/IdP framing policy can also reject embedded login, and sandbox
settings can forbid navigation or produce an opaque origin. See
[Chromium storage partitioning](https://developer.chrome.com/docs/privacy-sandbox/storage-partitioning/)
and [CSP frame-ancestors](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-ancestors).
This is not a claim that all iframe flows are impossible. Do not improvise token,
PKCE or attempt transfer through URLs/messages to make this recipe work there.

## Evidence and next design questions

Run `pnpm test:runtime`. It builds the example into its own archive, installs it
beside SDK tarballs outside the workspace, typechecks declarations/host imports
and drives Chromium. It checks pure imports, shared SDK/React modules, sign-in,
cross-widget list refresh, draft/access/unconfirmed-write recovery, clean remount,
host disposal, and the deliberately broken duplicate-SDK bundle. Existing SDK
tests cover the individual helpers; this consumer tests their composition.

The host uses `AppAccess` for startup/callback/login presentation plus a stable
runtime/provider, target lifetime and layout. The widget content gate (`AccessPanel`
in the recipe) remains app-owned and distinct from the SDK's `AppAccess` surface.
A general removal/reload guard,
independent targets, per-widget scope composition and isolated iframe login need
explicit contracts before more public names. This automated evidence does not
replace a new author's exercise, a real Pod run, an installed-device test or an
iframe test.
