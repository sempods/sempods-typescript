# Documentation map

## Use the modules

- [client-sdk](../packages/client-sdk/README.md): portable Pod requests, OAuth and editing.
- [app-sdk](../packages/app-sdk/README.md): browser sessions, headless authoring and optional React.
- [React/headless authoring](react-authoring.md), [widgets](widgets.md) and
  [browser runtime](browser-runtime.md).
- [Pod overviews with Contexts on-demand](react-authoring.md#pod-overviews-with-contexts-on-demand)
  and the [copyable overview recipe](../examples/todo/recipes/pod-overview.tsx).
- [TODO example](../examples/todo/README.md) and
  [Node example](../examples/node-script/README.md).

## Build an app

For a new app with a coding assistant, start from
[sempods-apps-template](https://github.com/sempods/sempods-apps-template).
The guides here also explain using the modules in an existing or empty app:

- [Start with the idea](build-your-app.md), [AI app-builder entry](ai-app-builder.md),
  [quickstart](quickstart.md) and [hackathon reference](hackathon.md).
- [Local testing](local-testing.md), [deployment](deployment.md),
  [PWA](pwa.md) and [migration/recovery](migration.md).

## Understand and maintain the SDK

- [Vision](vision.md), [architecture decisions](decisions.md),
  [contributing](contributing.md) and [development checks](development.md).
- [client-sdk](../packages/client-sdk/README.md) and its
  [provenance](../packages/client-sdk/PROVENANCE.md).
- [app-sdk](../packages/app-sdk/README.md) and its
  [provenance](../packages/app-sdk/PROVENANCE.md).
- [Agent instruction map](agents/ai-instructions.md),
  [documentation strategy](agents/documentation-strategy.md),
  [issue work](agents/issue-work.md), [doc review](agents/doc-review.md),
  [release](agents/release.md) and [live validation](agents/live-validation.md).

The [root agent map](../AGENTS.md) and [documentation scope](AGENTS.md) explain
which instructions govern a change. Public plans live in
[GitHub issues](https://github.com/sempods/sempods-typescript/issues).
