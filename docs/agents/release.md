# Release the TypeScript packages

Default to assessing readiness. Preparing a release updates a reviewable branch;
publishing requires the maintainer's explicit authorization for the selected
version and commit. Use the [contributor rules](../contributing.md).

## Assess and prepare

- Read the selected issues, current [support matrix](../../README.md#supported-environments),
  [migration guide](../migration.md) and package manifests. Do not infer release
  scope or a target version from open issues or passing tests.
- Keep the three package versions coordinated and verify the packed app-sdk
  dependency resolves to the selected client-sdk version and app-ui's packed
  `@sempods/app-sdk` peer names the same minor. Preserve private workspace/examples,
  ESM entry points, optional React boundaries, licences and provenance.
- Review public export/contract changes and migration notes. Version 0.x may change
  APIs between minor versions; patches preserve compatibility. Check release-pinned
  URLs in package READMEs, the install commands in `docs/quickstart.md` and
  `docs/hackathon.md`, and the SDK pins in `examples/todo/widgets/package.json`
  when preparing the next version; `pnpm check:docs`
  requires repository file/directory links there to name that package’s `v<version>`.
- `pnpm build` writes app-sdk's app-author reference (`docs/` and `examples/` in
  the package) from the maintained sources with `scripts/package-docs.mjs`;
  `test:consumers` checks it in the packed artifact. Consumers point their
  assistants to `node_modules/@sempods/app-sdk/docs/ai-app-builder.md`, so that
  path is a contract: moving or renaming it needs a migration note.
- Run `pnpm check` on the exact release candidate. Pack the packages with pnpm into
  a fresh directory and inspect contents and `npm publish --dry-run` output.
  Compare packages by their extracted file contents, as the publisher does, not by
  tarball checksum; archive metadata can differ between packs.
- Prepare concise release notes and the release PR with tested environments and
  unverified live/device cases. An approved older commit is not current approval.
- Release notes and the migration guide ship to every app owner, whose assistant
  may act on them. Keep sempods-apps-template maintainer steps (starter pins,
  peer ranges, UI-kit changes) out of them; record those on the template's
  adoption issue or the release PR.

## Publish an authorized candidate

Read the actual [workflow](../../.github/workflows/publish.yml) and
[publisher](../../scripts/publish-packages.mjs) before acting. Verify the tag matches
all package versions, CI/review apply to the selected commit, and the maintainer's
npm environment is ready. Do not display or copy credentials.
The workflow uses npm trusted publishing and holds no npm token: on npmjs.com, each
package names `sempods/sempods-typescript`, `publish.yml` and the `npm` environment
as its trusted publisher, with the **Allow npm publish** action selected (newer
configurations allow only `npm stage publish` by default, and the publisher runs
`npm publish`). A new configuration expires unless its first publication succeeds
within two days, so create it, or recreate an expired one, shortly before the
authorized release. Renaming the workflow file or environment breaks publication
until the maintainer updates every package there. A package that has never been
published, such as `@sempods/app-ui` before its first release, needs its trusted
publisher set up the same way before the release; check npm's current
requirements for a first publication. This is a maintainer step.
Creating or pushing a version tag triggers publication and is part of this mode.
The GitHub `npm` environment requires reviewer approval before the job can publish.
The active `protect-release-tags` ruleset protects `v*` tags against updates and
deletion. Deleting an unused release tag requires a maintainer-controlled admin
bypass; it is not an automatic recovery step. Verify these GitHub-side settings
for the release, alongside the workflow stored in Git.

The workflow publishes client-sdk first, then app-sdk, then app-ui. On a failed or partial run, inspect the
registry and workflow before retrying. The publisher skips an existing version
only after comparing its extracted contents; a mismatch or inconclusive registry
response stops the process. Never overwrite a published version or guess success.

After success, verify every registry version, their dependency relationship and
provenance, then install exact versions in a fresh consumer without workspace links.
Follow the [quickstart](../quickstart.md). Record separately whether it built,
started, and passed a real-Pod test; publication alone proves none of those.
