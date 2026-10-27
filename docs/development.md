# Development and package evidence

Node is pinned in `.node-version` (the supported minimum) and pnpm in `package.json`.
Tool dependencies have exact versions; `pnpm-lock.yaml` is committed. CI tests
only that minimum Node version; newer versions are expected to work but are not
tested.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm format:check
pnpm lint
pnpm typecheck
pnpm check:docs
pnpm test
pnpm test:publish
pnpm test:consumers
pnpm test:runtime
pnpm test:todo
pnpm check
```

`pnpm check` runs format, lint, docs, typecheck, unit, publish, consumer, runtime
and TODO checks in that order. `pnpm build:examples` bundles the examples for
manual runs; it is not part of `pnpm check`, because `typecheck` already compiles
them.

Linux CI uses `playwright install --with-deps chromium` and the same aggregate
check. CI reads `.node-version`; libraries emit ESM plus declarations with plain
`tsc -b` project references. Exports resolve built files, with no source aliases.
Tests are typechecked too. `skipLibCheck` is false throughout.

## What the checks establish

- `format:check` and `lint`: Prettier and ESLint over packages, scripts, tests and
  examples.
- `test:publish`: runs `scripts/publish-packages.mjs` against a fake npm registry
  (fresh, resumed, conflicting and failing releases); nothing is sent to npm.
- `check:docs`: offline local Markdown file/heading validation, including agent and
  skill files, plus reachability from README and AGENTS. Regression fixtures prove
  failures for missing targets/anchors and isolated documents, valid unstaged moves,
  and package README links staying within the package or matching its release revision. See
  [documentation strategy](agents/documentation-strategy.md#automated-checks-and-their-limits)
  for deliberately separate checks and limits.
- `build`: strict library compilation, explicit `.js` ESM imports and a one-way
  app-sdk → client-sdk dependency. Test sources are not part of library output.
  It also writes app-sdk's app-author reference (`scripts/package-docs.mjs`): the
  AI entry and the guides and examples it links, without SDK contributor
  instructions, with links to anything not shipped pinned to the release tag.
  `check:docs` runs its fixtures, including a missing entry, a missing linked
  document, a broken anchor, a link leaving the package and shipped contributor
  instructions.
- `typecheck`: portable client source in Node-only and DOM-only environments,
  plus unit test sources and example sources. Browser policy options remain in the transport type
  even when Node's RequestInit declaration lacks them.
- `test`: retained catalogue/discovery validation cases (including real loopback
  HTTP), locale/date formatting and React draft preservation. These are fixture
  tests, not live Kotlin interoperability evidence. Runtime scenarios also cover
  durable storage, callbacks, scope/identity continuity, refresh (including
  renewal before expiry) and target races.
- `test:consumers`: packs both packages and installs their tarballs together in
  fresh directories outside the workspace. Checks packed file allowlists and
  rewritten workspace dependency, rejects linked workspace packages, and verifies
  that the plain installation contains neither React nor its types. The installed
  app-sdk reference is checked on its own: entry present, no contributor
  instructions, every local link and anchor inside the package.
- Packed client root: a separate root-only browser bundle retains every export
  with tree-shaking disabled. Its import graph excludes oauth4webapi, React,
  app-sdk and client OAuth/session entry paths. Importing that bundle in Node
  with traps checks for calls to `fetch` and access to `window`, `document`,
  `navigator`, `localStorage`, `sessionStorage`, `indexedDB`, `location`,
  `history`, `XMLHttpRequest`, `WebSocket` and `EventSource`. Caught accesses
  also fail the probe. OAuth remains an installed dependency used by the
  separate `./oauth` entry.
- Packed Node: NodeNext, no DOM lib, strict declaration checking, actual execution;
  discovery, Pod SELECT/CONSTRUCT and a bearer read plus conditional writes hit a loopback HTTP fixture. A separate packed type check disables `noUncheckedIndexedAccess` and still requires a guard for absent SELECT bindings; all portable client README examples are compiled verbatim.
  Portable did:web authorization preparation needs no browser session fields.
  Import starts no requests.
- Packed browser: DOM only, no Node globals, esbuild browser bundle and Chromium
  execution; real loopback discovery, Pod SELECT/CONSTRUCT, a bearer read and a conditional write; verifies
  ambient cookies are omitted and the bearer reaches only data requests.
- Packed React: separately installs React/ReactDOM and their types, compiles and
  renders a provider/hook consumer in Chromium; language change retains the draft.
  Both bundles resolve installed artifacts, not workspace aliases.
- Documented apps: compiles the quickstart and its PWA adaptation, read from the
  installed app-sdk reference, against packed SDKs. Chromium checks startup and, with a registration spy, verifies that
  importing the PWA `App` component registers no worker while the production
  entry registers exactly once. Native worker behavior is covered by `test:todo`.

- `test:runtime`: a separate packed DOM-only consumer in Chromium, using native
  IndexedDB/Web Locks and real loopback Code + PKCE redirects/exchanges. Checks
  dynamic/did:web identity, durable reload, sequential multi-Pod, reactive refresh,
  second-tab exclusion and cookie omission. Uses the production client by default,
  including one/set/free Pod restrictions, excluded saved sessions and callbacks,
  and restoring preserved sessions after widening the policy. Also covers
  editor composition, conditional saves, conflicts and an applied write
  whose answer is withheld at the test network boundary (no SDK resend).
  A Pod issuing four-second tokens refuses expired ones with and without a
  Bearer challenge; the overview recipe renews expired tokens before dispatch,
  so the Pod never receives one, and a refused renewal ends in a visible
  sign-in that recovers. Renewal within the margin before expiry is covered by
  unit tests.

The consumer harness uses npm to install exact SDK tarballs and exact direct test
versions; normal workspace development uses pinned pnpm. Consumer directories are
removed after the run. Installing tools may use the registry; runtime fixtures
and page traffic stay on loopback. Chromium is the automated browser target; see the
[support matrix](../README.md#supported-environments) for the public support scope. Live Kotlin validation and independent human authoring remain follow-up work.
The runnable TODO/Node examples and React authoring layer are described in
[React/headless authoring](react-authoring.md).

React editor-lifetime regressions combine `useSelection` with
`useResourceEditor`: after an actual screen unmount/remount, reopening the same
subject keeps its draft or unconfirmed outcome. Other row/Context changes and
unrelated guards still ask, pending writes block navigation, old commands cannot
follow a replacement target, and recovery never replays the write.
The packed customized consumer also unmounts a dirty editor screen, opens the
same row after remount and checks the retained draft without a prompt or write.

`test:todo` installs packed SDKs and compiles the actual examples. The TODO's
standard screen covers EN/DE sign-in, 320px light/dark presentation, explicit
context choice, creation and guarded management with a retained draft, and the
full CRUD, conflict/unknown-outcome, guard, keyboard/mobile and second-tab
checks, plus the shared Node domain/edit path.
It also enables native BFCache in full Chromium and checks repeated returns,
sign-in afterwards, saved session/Context restoration and exactly one creation
after return. The verbatim quickstart from the installed package is bundled and
checked for an explained network read failure, explicit retry and recovered data.
An empty result stays visible during a held background refresh, while initial
read and refresh failures show recovery instead of an empty-state message.
It also loses the answer to an applied row update, removes that row on the
fixture, refreshes the list and checks that comparison/acknowledgement remain
reachable without another write.
The remaining browser scenarios keep their isolated Headless Shell setup.
`test:todo` also checks the standard screen, editor and recovery controls without an app
stylesheet at 320/375px in EN/DE and light/dark, including host-controlled color schemes, transparent embedded surfaces, inherited token overrides,
44px targets, keyboard focus, and isolation from app-owned list styling.
`test:runtime` also covers packed `AppAccess` one/set/free Pod choices, keyboard
sign-in and focus recovery, a provider answering `login_required` (specific EN/DE
cause without the provider's text, cleared by selecting another Pod or
disconnecting), and the widget host with retained drafts/uncertain
writes. EN/DE retry cases check native `inert`: failed re-authorization preparation
keeps retry/error feedback visible without moving focus to the host control.
With one permitted Pod and Contexts on demand, slow discovery keeps `AppAccess`
in its loading state (after the callback and during restore) until it hides; an
ended session or missing required scopes show their recovery view at once. When
the Context catalogue is slow (in `'required'` mode, or on demand under a mounted
`TargetScreen`), only the loading state shows: it hides if a preset Context
settles the target, otherwise the Context chooser or the catalogue failure view
appears. These are Chromium fixture checks, not live-Pod or installed-PWA
evidence. See [browser runtime](browser-runtime.md) for the implemented API and
its limits.

No implementation or test command publishes packages; both SDK packages are
publishable, the workspace root and examples stay private, and a version tag runs
the [publish workflow](../.github/workflows/publish.yml). Preserve per-package
PROVENANCE.md.

Runtime Pod-reader regressions cover catalogue-free direct binding/SELECT/CONSTRUCT,
independent read revisions through Context changes, session/grant invalidation,
required scopes, policy, refusal and cancellation. Selected-label fixtures cover
catalogues of 1, 50, 51 and 10,000 entries, restoration, cache/coalescing and stale
responses, including manage-only grants/revocations for cached, failed and pending
label attempts while Pod reads remain valid. Packed React-free declarations include `BoundPod` and `AppSnapshot.pod`;
the Chromium runtime consumer verifies bound SELECT/CONSTRUCT with no dataset
parameters and no accompanying catalogue requests. These are client/runtime
fixture checks; scale evidence against a local reference server is recorded in
[#40](https://github.com/sempods/sempods-typescript/issues/40).

React/headless on-demand regressions cover catalogue/description-free startup,
restore, reads and recovery (including preset/remembered targets and saved Pods),
StrictMode/concurrent Context demand before/after login, explicit retry after
empty/failed discovery, label fallback and obsolete Pod results. Packed consumer
types preserve Context/Pod callback inference, including explicit result generics
and rejection of mismatched handles. `test:runtime` executes the copyable
Pod-overview recipe against installed archives in Chromium: native storage/PKCE,
catalogue-free overview restore and 401 recovery, later validated Context demand,
draft-preserving revalidation, and editing an overview row in its own Context
(fresh read, `If-Match` write). These fixtures do not establish server dataset
semantics or deployed scale.

Scale fixtures (`packages/app-sdk/src/runtime/pod-scale.test.ts`) assert request
counts for Pod reads at catalogues of 1, 101 and 20,001 Contexts. Each read is one
query, and no catalogue or description is requested without Context demand. This
holds through restore, `401` renewal, `403` refusal, Context switches and
on-demand startup with a preset Context, while required mode loads one catalogue
and one selected description. `SEMPODS_SCALE_TIMING=1` (with `--silent=false`)
reports the in-process load time of the complete broad catalogue. The fixtures
prove client request behaviour, not backend scale.

`scripts/measure-pod-reads.mjs` records live Pod-read evidence through the built
client:

- Run `pnpm build` first.
- `POD_READ_CREDENTIALS` names a local JSON file of sempods service-client
  credentials. Never commit that file.
- The script sends client secrets only to the Pod's own token endpoint, and
  rejects redirects.
- Options: `--clients`, `--runs`, `--warmup`, `--timeout`, `--catalogue`.
- Raw evidence goes to the git-ignored `test-results/pod-reads/`.

The script is not part of `pnpm check`. Follow [live validation](agents/live-validation.md)
for the Pod and data it runs against;
[#52](https://github.com/sempods/sempods-typescript/issues/52) tracks evidence on
a deployed Pod and in a browser.

Pod/label regressions and the packed Chromium runtime also run with
`AbortSignal.any` unavailable. Signal tests verify cancellation propagation and
listener cleanup, and controller regressions keep unexpected binding defects
visible. Removing an API in Chromium is compatibility regression evidence, not
a test on an older Safari/iOS device.

## Authoring and example evidence

These notes back the [React/headless authoring guide](react-authoring.md); they
are fixture evidence, not live Kotlin compatibility or independent usability
evidence.

- `pnpm test:todo` installs packed SDKs outside the workspace, typechecks and
  bundles both examples, and drives the standard screen through real loopback
  PKCE redirects, CRUD, conflict and unknown outcomes, guarded selection, EN/DE,
  keyboard, mobile width and a busy second tab. It also runs the Node CRUD loop.
  Unit and React tests cover access and draft preservation, lifecycle and
  cancellation.
- [React tests](../packages/app-sdk/src/react/safe-authoring.test.tsx) run the
  guide's several-resources-from-one-input handler against fixtures, including
  a target change during a creation; keep the test and the guide in step.
- The packed browser test runs the
  [overview recipe](../examples/todo/recipes/pod-overview.tsx) with installed
  archives, including an edit beside a creation draft in another Context.
  Evidence on a deployed Pod and in a real browser is tracked in
  [#52](https://github.com/sempods/sempods-typescript/issues/52).
- TODO and Node share portable field definitions, typed lists, captured
  creation commands and partial changes. Live Pod evidence belongs to the
  quickstart validation; the provisional Action profile does not settle the
  outstanding task-vocabulary or mixed-Action collection decisions.
