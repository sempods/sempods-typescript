# Working on the sempods TypeScript SDK

This file governs the whole repository. Start with
[contributor rules](docs/contributing.md) and the
[instruction map](docs/agents/ai-instructions.md). Before changing documentation,
read the [documentation strategy](docs/agents/documentation-strategy.md).

The [vision](docs/vision.md) explains the product direction;
[architecture decisions](docs/decisions.md) own the package and runtime boundaries.
The [documentation index](docs/README.md) routes to maintained guides and examples.
If you are building an app that consumes the SDK, start with the separate
[AI app-builder guide](docs/ai-app-builder.md).

Read scoped instructions on the path to each changed file:
[client-sdk](packages/client-sdk/AGENTS.md), [app-sdk](packages/app-sdk/AGENTS.md),
and [documentation](docs/AGENTS.md). Sibling scopes do not govern each other.

Use [issue work](docs/agents/issue-work.md) for implementation and
[doc review](docs/agents/doc-review.md) when behavior, contracts or guides change.
[Release](docs/agents/release.md) and [live validation](docs/agents/live-validation.md)
have separate evidence and authorization requirements.

## Review focus

Review the current commit, not an earlier approval. Check package boundaries,
credential recipients, retained write uncertainty, target/draft lifetime and
public API compatibility where affected. Report concrete regressions with a
reproduction or code path. Distinguish fixture results from live/device evidence.
