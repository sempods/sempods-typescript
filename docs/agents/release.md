# Release the TypeScript packages

Default to assessing readiness. Preparing a release updates a reviewable branch;
publishing requires the maintainer's explicit authorization for the selected
version and commit. Use the [contributor rules](../contributing.md).

## Assess and prepare

- Read the selected issues, current [support matrix](../../README.md#supported-environments),
  [migration guide](../migration.md) and package manifests. Do not infer release
  scope or a target version from open issues or passing tests.
- Keep the two SDK versions coordinated and verify the packed app-sdk dependency
  resolves to the selected client-sdk version. Preserve private workspace/examples,
  ESM entry points, optional React boundaries, licences and provenance.
- Review public export/contract changes and migration notes. Version 0.x may change
  APIs between minor versions; patches preserve compatibility. Check release-pinned
  URLs in package READMEs when preparing the next version; `pnpm check:docs`
  requires repository file/directory links there to name that package’s `v<version>`.
- Run `pnpm check` on the exact release candidate. Pack both packages with pnpm into
  a fresh directory and inspect contents and `npm publish --dry-run` output.
  Record artifact contents/integrity separately from archive byte identity.
- Prepare concise release notes and the release PR with tested environments and
  unverified live/device cases. An approved older commit is not current approval.

## Publish an authorized candidate

Read the actual [workflow](../../.github/workflows/publish.yml) and
[publisher](../../scripts/publish-packages.mjs) before acting. Verify the tag matches
both package versions, CI/review apply to the selected commit, and the maintainer's
npm environment/credentials are ready. Do not display or copy credentials.
Creating or pushing a version tag triggers publication and is part of this mode.
The GitHub `npm` environment requires reviewer approval before the job can publish.
The active `protect-release-tags` ruleset protects `v*` tags against updates and
deletion. Deleting an unused release tag requires a maintainer-controlled admin
bypass; it is not an automatic recovery step. Verify these GitHub-side settings
for the release, alongside the workflow stored in Git.

The workflow publishes client-sdk first. On a failed or partial run, inspect the
registry and workflow before retrying. The publisher skips an existing version
only after comparing its extracted contents; a mismatch or inconclusive registry
response stops the process. Never overwrite a published version or guess success.

After success, verify both registry versions, their dependency relationship and
provenance, then install exact versions in a fresh consumer without workspace links.
Follow the [quickstart](../quickstart.md). Record separately whether it built,
started, and passed a real-Pod test; publication alone proves none of those.
