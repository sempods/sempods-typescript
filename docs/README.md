# Documentation map

## Start an app

- **New app, including with a coding assistant:** start in
  [sempods-apps-template](https://github.com/sempods/sempods-apps-template).
  Its workflow reads the SDK's [AI app-builder guide](ai-app-builder.md).
  A short description of the app is enough to start a useful first draft.
- **SDK in an existing React app:** follow the
  [complete quickstart](quickstart.md).
- **Understand the data model:** [Build your app](build-your-app.md) explains
  Pods, Contexts and field mapping. Read it when those concepts become relevant.

The [hackathon checklist](hackathon.md) helps after setup. The guides below are
references for the task at hand, not prerequisites to read in order.

## Find a reference

- [client-sdk](../packages/client-sdk/README.md): portable Pod requests, OAuth and editing.
- [app-sdk](../packages/app-sdk/README.md): browser sessions, headless authoring and optional React.
- [React/headless authoring](react-authoring.md), [widgets](widgets.md) and
  [browser runtime](browser-runtime.md).
- [Pod overviews with Contexts on-demand](react-authoring.md#pod-overviews-with-contexts-on-demand)
  and the copyable [overview](../examples/todo/recipes/pod-overview.tsx),
  [one-click](../examples/todo/recipes/overview-toggle.tsx) and
  [task-with-note](../examples/todo/recipes/task-with-note.tsx) recipes.
- [TODO example](../examples/todo/README.md) and
  [Node example](../examples/node-script/README.md).

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
