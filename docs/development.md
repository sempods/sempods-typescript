# Development and package evidence

Node is pinned in `.node-version` (22.19.0) and pnpm in `package.json` (11.1.2).
Tool dependencies have exact versions; `pnpm-lock.yaml` is committed. Node's
current minimum is tested, not a claim to support every future environment.

## Commands

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm typecheck
pnpm check:docs
pnpm test
pnpm test:consumers
pnpm test:runtime
pnpm test:todo
pnpm build:examples
pnpm check
```

Linux CI uses `playwright install --with-deps chromium` and the same aggregate
check. CI reads `.node-version`; libraries emit ESM plus declarations with plain
`tsc -b` project references. Exports resolve built files, with no source aliases.
Tests are typechecked too. `skipLibCheck` is false throughout.

## What the checks establish

- `check:docs`: offline local Markdown file/heading validation, including agent and
  skill files, plus reachability from README and AGENTS. Regression fixtures prove
  failures for missing targets/anchors and isolated documents. See
  [documentation strategy](agents/documentation-strategy.md#automated-checks-and-their-limits)
  for deliberately separate checks and limits.
- `build`: strict library compilation, explicit `.js` ESM imports and a one-way
  app-sdk → client-sdk dependency. Test sources are not part of library output.
- `typecheck`: portable client source in Node-only and DOM-only environments,
  plus unit test sources and example sources. Browser policy options remain in the transport type
  even when Node's RequestInit declaration lacks them.
- `test`: retained catalogue/discovery validation cases (including real loopback
  HTTP), locale/date formatting and React draft preservation. These are fixture
  tests, not live Kotlin interoperability evidence. Runtime scenarios also cover
  durable storage, callbacks, scope/identity continuity, refresh and target races.
- `test:consumers`: packs both packages and installs their tarballs together in
  fresh directories outside the workspace. Checks packed file allowlists and
  rewritten workspace dependency, rejects linked workspace packages, and verifies
  that the plain installation contains neither React nor its types.
- Packed client root: a separate root-only browser bundle retains every export
  with tree-shaking disabled. Its import graph excludes oauth4webapi, React,
  app-sdk and client OAuth/session entry paths. Importing that bundle in Node
  with traps checks for calls to `fetch` and access to `window`, `document`,
  `navigator`, `localStorage`, `sessionStorage`, `indexedDB`, `location`,
  `history`, `XMLHttpRequest`, `WebSocket` and `EventSource`. Caught accesses
  also fail the probe. OAuth remains an installed dependency used by the
  separate `./oauth` entry.
- Packed Node: NodeNext, no DOM lib, strict declaration checking, actual execution;
  discovery and a bearer read plus conditional writes hit a loopback HTTP fixture.
  Portable did:web authorization preparation needs no browser session fields.
  Import starts no requests.
- Packed browser: DOM only, no Node globals, esbuild browser bundle and Chromium
  execution; real discovery, a bearer read and a conditional write; verifies
  ambient cookies are omitted and the bearer reaches only data requests.
- Packed React: separately installs React/ReactDOM and their types, compiles and
  renders a provider/hook consumer in Chromium; language change retains the draft.
  Both bundles resolve installed artifacts, not workspace aliases.

- `test:runtime`: a separate packed DOM-only consumer in Chromium, using native
  IndexedDB/Web Locks and real loopback Code + PKCE redirects/exchanges. Checks
  dynamic/did:web identity, durable reload, sequential multi-Pod, reactive refresh,
  second-tab exclusion and cookie omission. Uses the production client by default,
  including editor composition, conditional saves, conflicts and an applied write
  whose answer is withheld at the test network boundary (no SDK resend).

The consumer harness uses npm to install exact SDK tarballs and exact direct test
versions; normal workspace development uses pinned pnpm. Consumer directories are
removed after the run. Installing tools may use the registry; runtime fixtures
and page traffic stay on loopback. Chromium is the automated browser target; see the
[support matrix](../README.md#supported-environments) for the public support scope. Live Kotlin validation and independent human authoring remain follow-up work.
The runnable TODO/Node examples and React authoring layer are described in
[React/headless authoring](react-authoring.md).

`test:todo` installs packed SDKs, compiles the actual examples and verifies both
TODO layouts (EN/DE, CRUD, conflict/unknown outcomes, guards, keyboard/mobile and
second-tab feedback), plus the shared Node domain/edit path. See
[browser runtime](browser-runtime.md) for the implemented API and its limits.

No implementation/test command publishes packages. Both SDK packages are
publishable; the workspace root and examples stay private. Publishing is a
separate maintainer action: a version tag runs the publish workflow
(`scripts/publish-packages.mjs`, npm provenance). Code is licensed under
Apache-2.0 and documentation under CC BY 4.0 (see LICENSE and NOTICE); preserve
per-package PROVENANCE.md. See [contributing](contributing.md) for the change
workflow and [migration](migration.md) for app upgrade guidance.
