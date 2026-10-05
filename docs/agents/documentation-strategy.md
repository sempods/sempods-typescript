# Documentation strategy

Adapted from the [sempods-kotlin strategy](https://github.com/sempods/sempods-kotlin/blob/6b92806982528479347bf35336460516dd3fdefb/docs/agents/documentation-strategy.md)
for this SDK's packages, TypeScript contracts and app-author audience.

## Ownership and navigation

- [Vision](../vision.md) describes purpose and direction. Maintained guides describe
  implemented behavior. Issues own scope, decisions, dependencies and progress.
  A substantial proposal may need a separate document, clearly marked proposed
  and linked to its issue; accepting a proposal does not implement it.
- Place details with the narrowest code owner. Define API contracts once, in
  TSDoc/JSDoc on the defining declaration, including outcomes and lifetime rules.
  Guides explain usage and link those definitions; do not reproduce entire types.
- AGENTS.md files are maps of scopes and rules. Keep runbooks and API explanations
  in their maintained documents. Add scoped maps only where they change decisions.
- Every Markdown document must be reachable through links from both the root
  README and root AGENTS.md, via indexes where useful. Keep the
  [documentation index](../README.md) current; use real links for instruction
  references rather than bare paths that a link checker cannot validate.
- Package README links must also work outside the checkout. Link repository-only
  guides through public URLs at a matching release revision; keep package-local
  links relative. App authors use documentation matching installed versions.

## Writing and completion

Write canonical documentation in English, with concrete examples and plain words.
Keep sempods lowercase in prose. Explain sempods-specific behavior and surprising
constraints; link standards rather than copying their tutorials. Preserve useful
rationale, but remove superseded wording instead of accumulating correction logs.
Keep migration instructions when users still need them.

A behavior or public API change updates its defining comments, guides and affected
examples in the same PR, or explains why none need changing. Distinguish fixture,
packed-consumer, real-Pod, device and independent-human evidence. A TypeScript
build does not establish deployed OAuth or PWA support. Protocol discrepancies
need an explicit specification discussion, not an undocumented client workaround.

Use [doc review](doc-review.md) before handoff. Public documents and issues must
stand alone without private work logs, credentials or personal test data.

## Automated checks and their limits

`pnpm check:docs` checks local Markdown links, fragments and navigation, including
agent and skill files. It uses [remark-validate-links](https://github.com/remarkjs/remark-validate-links)
through remark's CLI: the plugin's standalone API does not validate headings in
other files. A small runner supplies the repository inventory and checks reachability
using the same Markdown syntax tree. It inventories the current working tree,
including unstaged additions, deletions and renames. Remaining links to deleted
files still fail, as do missing README/AGENTS entry points. Local links and images
in package READMEs must stay within their package directory. Repository URLs
for files/directories must name the package manifest's version.
This local assertion does not verify that the release tag exists remotely.
The runner does not implement a Markdown parser.

[Lychee](https://lychee.cli.rs/recipes/anchors/) is another reusable option, with
Markdown/HTML and external URL support. The Node-based remark integration fits
this repository's pinned toolchain without another binary prerequisite.
[Cross-repository adoption](https://github.com/sempods/sempods-typescript/issues/11)
will assess that tradeoff for Kotlin and apps. sempods-spec and its stricter rules
are excluded; Kotlin's requirement-ID and executable-example checks are separate.

The local gate makes no network requests. External availability, raw HTML links,
prose/backtick paths, TSDoc links and the truth of documentation still need review.
Undefined Markdown reference labels render as text and are not checked as links.
Retain packed example tests; extend those tests when adding executable recipes.
External URL checking can be a separate explicit or scheduled task; a network
outage should not block ordinary local documentation validation.
