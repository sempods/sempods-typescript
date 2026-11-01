# Contribute to the SDK

App authors can start with the [quickstart](quickstart.md) without changing this
repository. This page is for changes to the reusable SDK, its examples or guides.
Before editing, open or pick a bounded issue and check open PRs for overlapping
work.

## Keep the boundaries useful

The [architecture decisions](decisions.md) explain the package boundaries.
`client-sdk` owns portable protocol and conditional editing; it must not depend
on app-sdk, React or browser sessions. `app-sdk` owns browser coordination and
headless authoring, with React isolated in `./react`. `app-ui` owns UI
components and the theme contract on top of app-sdk's React entry; nothing
else depends on it. Keep one HTTP implementation
and one browser session coordinator. Ordinary screens should consume views and
editing helpers, not credentials or request-retry mechanics.

Use strict TypeScript, explicit outcomes and stable public exports. Keep absent,
unavailable and unresolved data distinct. Preserve unknown RDF terms, language
variants, local drafts and uncertainty about dispatched writes. Update the
relevant guide and example when changing a public API; do not document a proposed
name as an implemented capability. Record protocol compatibility revisions and
retain provenance when adapting existing code.

## Verify a change

Use the Node version in `.node-version` and the package manager in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium webkit
pnpm check
```

On Linux, Playwright may need `--with-deps`, and the UI gate also runs
Firefox there (`pnpm exec playwright install --with-deps chromium webkit firefox`). See
[development evidence](development.md) for each command's scope. Add meaningful
regressions for changed behavior. Preserve package-boundary checks and packed
consumer tests: a successful workspace build does not prove that an installed
package works in a browser, Node or a React-free consumer.

Use the [documentation strategy](agents/documentation-strategy.md) and
[doc review](agents/doc-review.md). For documentation, verify links, public exports and commands. Compile
copyable examples against the packaged SDK. For deployment instructions, separate
configuration review, a successful static build, and actual live-domain/login
validation. Do not present a simulated server or a human-readable checklist as
completed live or independent-human evidence.

## Make the change reviewable

Explain the concrete problem, resulting behavior, tests actually run and remaining
limits. Keep unrelated refactoring separate. Have an independent reviewer check
the current commit, including any updates after earlier approval. Keep unresolved
findings and follow-up acceptance criteria in the repository's issue/review channel.
The maintainer decides merging and release. Security reports follow the
organisation’s [private reporting policy](https://github.com/sempods/.github/blob/main/SECURITY.md),
not public issues.

Code is licensed under Apache-2.0 and documentation under CC BY 4.0 (see
[NOTICE](../NOTICE)); contributions are accepted under the same terms.

## Sign off every commit

The [sempods contributing terms](https://github.com/sempods/.github/blob/main/CONTRIBUTING.md)
apply here as everywhere in the organisation: licensing, the Developer
Certificate of Origin and AI-assisted work. Every commit carries a
`Signed-off-by` line matching its author (`git commit -s`); the DCO check on
pull requests enforces it. You are the author of what you submit, including
AI-assisted changes, and the sign-off is yours to give. There is no CLA.
Questions and ideas are welcome in
[Discussions](https://github.com/sempods/sempods-typescript/discussions).

## Release decisions

Versioning, publication and supported-environment promises are maintainer
decisions, not consequences of a passing build; see the
[release procedure](agents/release.md).
