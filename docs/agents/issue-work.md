# Work on an issue

Read the owning issue, its acceptance, dependencies and current discussion. Before
editing, check open PRs and issue comments for work already in progress, say on the
issue which part you are taking, and use a separate worktree when another writer
is active. User authorization determines
scope; an issue or a skill does not authorize a release or changes to another repo.

Keep public implementation and maintenance work linked to an issue. Small work
needs only a small issue. Routine dependency-bot PRs can own their bounded scope;
security work follows the organisation's
[private reporting policy](https://github.com/sempods/.github/blob/main/SECURITY.md).
Do not publish vulnerability details in a planning issue.

Use [contributor rules](../contributing.md), applicable scoped AGENTS.md files and
[development checks](../development.md). Update acceptance with evidence from each
increment; use `Refs` for partial delivery. Close only after the required work and
acceptance are verified. A parent also needs its own acceptance and required
children settled. Assign a release milestone only when the maintainer chooses it.

Before handoff, run [doc review](doc-review.md) and report the exact commit, meaningful
checks, remaining findings and limits. Have an independent reviewer assess that
commit; later changes need renewed review. Keep follow-up requirements in issue
bodies, not only in chat. Do not automatically merge or publish.

Sign off every commit (`git commit -s`) and attribute AI assistance as the
[sempods contributing terms](https://github.com/sempods/.github/blob/main/CONTRIBUTING.md)
require. Use the contributor's configured identity; never invent their identity or
consent.
