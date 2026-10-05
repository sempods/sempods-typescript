# Source provenance

Source: the predecessor application workspace at `b1aa33411bd0802212739d2308e3d39687463162`.

- `packages/prototype-client/src/catalogue.ts`
- `packages/prototype-client/src/catalogue.test.ts`
- `packages/prototype-client/src/errors.ts`
- `packages/prototype-client/src/index.ts (PodFetch type)`
- `packages/prototype-browser/src/discovery.ts`
- `packages/prototype-browser/src/discovery.test.ts`
- `packages/prototype-client/src/index.ts` (system-route IRI encoding, context-scoped URLs; rewritten around the portable client contract)

ESM import paths adapted. Initial failure union narrowed to portable discovery facts; browser session ownership stays outside the client. `PodRequestInit` explicitly retains standard Fetch no-store/no-referrer policy fields that Node 22 RequestInit declarations omit. The catalogue and discovery validation policies and existing tests are preserved.

Additional source: the same predecessor workspace at
`872750e01397c58dd8967f8ab2b2855202015660`
(tag `archive/sdk-durable-runtime-872750e`).

- `packages/prototype-browser/src/authorization.ts`
- `packages/prototype-browser/src/clientIdentity.ts`
- `packages/prototype-browser/src/clientRegistry.ts`
- `packages/prototype-browser/src/clientRegistry.test.ts`

Portable OAuth code adapted to `src/oauth/` with explicit ESM imports and
`OAuthError`/`OAuthFailure`. Dynamic and did:web identities, requested scope lists
and potentially nonempty grants replace the prototype's dynamic/empty-scope assumptions.
Authorization and exchange inputs are captured before asynchronous work. Portable
binding and token-evidence parsers validate identity, scopes and claim/receipt
lifetimes. Browser record IDs, attempt lifetime/envelope parsers and return
navigation were subsequently moved into app-sdk; the portable binding is detached
and immutable. Pod URL validation is shared with the root client. These are
adaptations for this SDK, not unchanged copies from the prototype.
Token payload checks remain continuity checks, not JWT signature verification.
The protocol uses oauth4webapi; browser storage/navigation are not imported.

The source recorded spec revision `10d91f307ad91c9bdca16e037b4088c27be49dbf`
and Kotlin revision `c6a5eab459249bcd04863a45ef87fbe5121034d4` as compatibility
evidence. This port uses synthetic fixtures; it does not claim a new live check
against either repository's latest revision.

## Specification compatibility

Protocol behavior of the client root (routes, conditions, write results,
catalogue validation, selected-context queries) was checked against
`sempods/sempods-spec` at `10d91f307ad91c9bdca16e037b4088c27be49dbf`
(2026-09-30), in particular SPS-CRUD-001–004, -014–017, -023–043 and -058,
SPS-CTX-004, -010, -013 and -031–036, SPS-GRANT-009, and SPS-SPARQL-001 and
-011–014. The catalogue permission and context-name behavior was cross-read
in `sempods/sempods-kotlin` at `c6a5eab459249bcd04863a45ef87fbe5121034d4`
(`PodContextRegistryRdf`, `PodContextPermissionResolver`, `SempodsPodContexts`).
This is source reading and deterministic fixtures, not live wire evidence;
pinned live validation remains pending. Re-check these revisions when the
specification changes before 0.1.

No source licence file was found at the source revisions above; they and this
port are by the same author. Since 0.1.0 this package, including the ported code,
is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).
