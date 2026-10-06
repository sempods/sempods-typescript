# Source provenance

Source: the predecessor application workspace at `b1aa33411bd0802212739d2308e3d39687463162`.

- `packages/prototype-react/src/locale.tsx`
- `packages/prototype-react/src/locale.test.tsx`

Pure locale/message/formatting code separated from the React provider. Messages depending on unimplemented workflow/session contracts are deferred. Selected formatting tests ported; draft-preservation test adapted to the standalone provider. No runtime fixture is imported.

Additional source: the same predecessor workspace at
`872750e01397c58dd8967f8ab2b2855202015660`
(tag `archive/sdk-durable-runtime-872750e`).

- `packages/prototype-browser/src/sessionStore.ts` and `sessionStore.test.ts`
- `packages/prototype-browser/src/sessionRecords.ts`
- `packages/prototype-browser/src/sessionTransitions.ts` and `sessionTransitions.test.ts`
- `packages/prototype-browser/src/sessionLease.ts`
- `packages/prototype-browser/src/browserRuntime.ts` (behavioral reference)

Persistence/transition/lease code ported into `src/sessions/` with versioned
record validation, requested scopes, both identity kinds and ESM imports.
Public storage adapters use portable structural types; native browser resources
are opened only on initialization. The coordinator is adapted into `src/runtime/`
rather than copied unchanged: it consumes the reviewed Pod/PodAuth contract,
uses one refresh owner and delegates data requests/resends to the client.
Bound views keep independent read/write guards and pending-read invalidation.
Headless and packed Chromium tests are new and now use the production client
executor, replacing the earlier contract doubles. Only transports/server responses
are simulated. The default client composition and internal catalogue extraction
are adaptations for this SDK. App-specific OAuth envelopes, attempt lifetime and
return navigation were moved from the initial client port to `src/sessions/`;
the current version-1 stored shape is retained.

Source compatibility references were spec `10d91f307ad91c9bdca16e037b4088c27be49dbf`
and Kotlin `c6a5eab459249bcd04863a45ef87fbe5121034d4`. No new live Pod check is
claimed by this increment.

No source licence file was found at the source revisions above; they and this
port are by the same author. Since 0.1.0 this package, including the ported code,
is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).

The `src/authoring/` and React authoring bindings/components are new SDK code,
composing the existing reviewed runtime and portable editor. Their behavior uses
the documented package boundaries and authoring contracts; no additional
legacy implementation was copied. TODO and Node consumers are new code sharing
a provisional Focus-compatible Action mapping. No live Pod claim is added.

Independent `BoundPod` readers, their separate read revisions and selected-Context-only
label caching are new SDK code for #38, composed over the existing credential owner
and production client executor. The stored session shape is unchanged. Runtime and
packed-consumer checks use deterministic/loopback transports; no live scale claim
is added.

The #39 controller/provider Context-selection policy, shared Pod/Context loader
and React demand composition are new SDK code over those runtime facts and
existing catalogue/selection actions. The copyable Pod-overview recipe is new
app-owned example code using public exports. Its packed Chromium and React tests
use synthetic transports/loopback responses, including native browser storage and
real PKCE redirects. This establishes package composition and request behavior;
live scale evidence remains separate in #40, with no new device-support claim.
