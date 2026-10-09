# sempods TypeScript SDK

Reusable modules for apps and scripts that work with sempods data. Connect to a
Pod, read Linked Data and edit it without losing someone else's changes. People
keep their data in their Pod; your code supplies the interaction.

This repository develops and publishes two packages:

| Package                                              | Use it for                                                                   | Runs in                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| [@sempods/client-sdk](packages/client-sdk/README.md) | Protocol requests, portable OAuth, field definitions and conditional editing | Browser or Node              |
| [@sempods/app-sdk](packages/app-sdk/README.md)       | Login, durable browser sessions, target selection and authoring helpers      | Browser, with optional React |

`app-sdk` builds on `client-sdk`. Its root entry works without React;
`@sempods/app-sdk/react` adds components and hooks. Both packages provide ESM and
TypeScript declarations. The examples demonstrate their public APIs and serve as
executable integration checks.

Starting a new app with a coding assistant? Use
[sempods-apps-template](https://github.com/sempods/sempods-apps-template), the
app-focused starting point built on these modules. Work in this repository when
changing the SDK, its examples or documentation.

## Find your starting point

| I want to…                                           | Start here                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose a module                                      | [client-sdk](packages/client-sdk/README.md) or [app-sdk](packages/app-sdk/README.md)                                                                  |
| Build a browser app with React                       | [Quickstart](docs/quickstart.md) and [authoring guide](docs/react-authoring.md)                                                                       |
| Give a coding assistant the SDK's app-building rules | [AI app-builder entry](docs/ai-app-builder.md), also shipped in app-sdk                                                                               |
| Use another UI framework                             | [Headless authoring](docs/react-authoring.md#without-react)                                                                                           |
| Embed widgets in an existing host                    | [Widget authoring](docs/widgets.md)                                                                                                                   |
| Read across a Pod without choosing a context         | [Pod reads](packages/client-sdk/README.md#reading-across-the-pod) and [React overview](docs/react-authoring.md#pod-overviews-with-contexts-on-demand) |
| Write a Node script                                  | [Node example](examples/node-script/README.md)                                                                                                        |
| Configure login or understand session recovery       | [Browser runtime](docs/browser-runtime.md)                                                                                                            |
| Upgrade an existing app                              | [Migration and recovery](docs/migration.md)                                                                                                           |
| Contribute to the modules                            | [Contributing](docs/contributing.md), [development checks](docs/development.md) and [AGENTS.md](AGENTS.md)                                            |

The [documentation map](docs/README.md) includes all guides. For ideas and a
first app, see [build your own app](docs/build-your-app.md) or the
[hackathon reference](docs/hackathon.md). The [vision](docs/vision.md) and
[architecture decisions](docs/decisions.md) explain the package boundaries.

## Try the examples locally

Use Node 24.15 or newer and pnpm 11.1.2. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:todo
```

Open `http://127.0.0.1:5173/` and connect a Pod with a test context. The
[TODO example](examples/todo/README.md) shares one task screen across an app-owned
layout, an optional AppShell at `/legacy`, and a custom layout at `/custom`.
The [Node example](examples/node-script/README.md) uses the same field definitions.

Both packages are published on npm under Apache-2.0 (documentation: CC BY 4.0;
see [NOTICE](NOTICE)). Version 0.x may change APIs between minor versions.
Automated checks cover installed packages and browser fixtures. Live-Pod,
installed-device and independent app-author validation are separate evidence;
see [development checks](docs/development.md).

## Supported environments

| Environment                  | Status in 0.5                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                         | 24.15 or newer (Node 24 LTS), ESM only (`engines` in both packages).                                                                                                               |
| Browser tab                  | Current browsers with IndexedDB and Web Locks. Automated browser checks run in Chromium.                                                                                           |
| React                        | 19, for `@sempods/app-sdk/react` (optional peer).                                                                                                                                  |
| Installed PWA (experimental) | Desktop Chromium and Android are expected to work; iOS/iPadOS home-screen apps are unverified. Login returns to the app in the same window and must land in the app's own storage. |

Support for installed apps is extended after device evidence. Until then, use a
normal browser tab where an installed app cannot complete sign-in.

Explore [sempods](https://www.sempods.org/), its
[use cases](https://www.sempods.org/use-cases/) and the
[protocol specification](https://github.com/sempods/sempods-spec).
