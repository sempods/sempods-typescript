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
specification changes.

Value-level operations (`ContextView.values`, #370) were checked on
2026-11-17 against `sempods/sempods-spec` at
`c6308c157d8c78be0ba6e9d91dba39a11a9ce883`: SPS-CRUD-041–054 and -059–061,
with the response shapes cross-read in `sempods/sempods-kotlin` at
`4e6414ff4c77627be319eb6dc83a4d616ff6db2d` (`PodSystemResourcesEndpoint`,
`SempodsPodSlots`): `404` for an empty slot read, `{"outcome": …}` bodies as
`application/json`, an echoed slot `ETag` on every write and a `Location`
without a query on an added IRI's edge. sempods-spec#68 may replace the
outcome bodies with `204`; the client keeps such a write `applied`. Fixture
tests only, no live Pod.

Pod SELECT/CONSTRUCT (#37) was checked against that same spec revision on
2026-10-06: SPS-SPARQL-001–018, including server dataset authorization and result
media types. SELECT decoding follows the
[SPARQL 1.1 Results JSON format](https://www.w3.org/TR/sparql11-results-json/).
Evidence is source review and deterministic/packed-consumer fixtures, not live
Pod or 10,000-Context backend scalability. Dataset downscope clarification remains
owned by [sempods-spec#129](https://github.com/sempods/sempods-spec/issues/129);
Context failure has no unscoped fallback.

Find (#233) was checked against `sempods/sempods-spec` at
`c6308c157d8c78be0ba6e9d91dba39a11a9ce883` (`spec/core/find.md`, 2026-11-02): SPS-FIND-004, -005, -009–015 and
-018–020. The named-graph JSON-LD form was cross-read in `sempods/sempods-kotlin`
at `d72098f85a50df421e75a02a5cb13a8d7f2f0307` (`FindEndpoint`, `FindPostRequest`,
`RdfWriterUtil.toJsonLdNamedGraphs`). This is source reading and deterministic
fixtures, not live wire evidence. Kotlin treats `contexts: []` as an empty scope; the spec
leaves an empty downscope to SPS-CRUD-014
([sempods-spec#129](https://github.com/sempods/sempods-spec/issues/129)), so
the SDK rejects any group in the answer to `[]`.

The consent prompt of `prepareAuthorization` (#362) was checked against
`sempods/sempods-spec` at `c6308c157d8c78be0ba6e9d91dba39a11a9ce883`
(`spec/core/auth.md` §7): SPS-AUTH-039 lets a Pod reuse standing grants without
`prompt` and forbids it with `prompt=consent`. The Pod's prompt table was
cross-read in `sempods/sempods-kotlin` at
`4e6414ff4c77627be319eb6dc83a4d616ff6db2d`
(`sempods-server/docs/auth/connections.md`). The SDK sends only `consent`, never
`none`, `login` or another value. This is source reading and deterministic
fixtures; the live check against a deployed `did:web` app remains open in #362.

`prompt: 'none'` and `providerLink` (#373) were checked against the same
specification revision: SPS-AUTH-039 and -040 (`spec/core/auth.md` §7) let
`prompt=none` succeed only for a remembered person, a client that is not
dynamically registered and a standing grant, and answer `login_required` or
`consent_required` otherwise; SPS-AUTH-025 (§4) allows `error_uri` on an error
answer. The SDK still never sends `login` or another value. This is source
reading and deterministic fixtures, not live wire evidence.

No source licence file was found at the source revisions above; they and this
port are by the same author. Since 0.1.0 this package, including the ported code,
is licensed under the Apache License, Version 2.0 (see LICENSE and NOTICE).
