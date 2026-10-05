# Review documentation with a change

Start from the actual diff or requested paths and the applicable AGENTS.md scopes.
Use the [documentation strategy](documentation-strategy.md) as the shared rules.

1. Find affected exports, types, outcomes and configuration in source, package
   READMEs, guides and examples. Search beyond the files already changed.
2. Check each affected claim against current code and tests. Keep intended features
   in issues/proposals. Preserve non-obvious rationale and supported recovery limits.
3. Update the defining TSDoc/JSDoc contract and its users. Check public-entry export
   budgets, compatibility and migration needs; an internal import in an example
   does not prove a public API works.
4. Remove stale or duplicated explanations. Check links from README/AGENTS and the
   documentation index. Review package README links as an npm reader too.
5. Run `pnpm check:docs` and relevant executable-example/packed-consumer checks from
   [development](../development.md). Validate deployment examples against their
   actual config; report unexercised live/device steps using
   [live validation](live-validation.md).
6. Record changed contracts, documentation updates, checks and remaining limits in
   the PR. For a review request, report findings; edit only when fixing is in scope.

When moving a document, search incoming prose, code comments and instruction paths
as well as Markdown links. A checker cannot decide whether a surviving link still
points to the right explanation. A new agent session should be able to find the
relevant contract and checks using the entry maps, without conversation history.
