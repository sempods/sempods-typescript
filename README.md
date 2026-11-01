# sempods TypeScript SDK

Reusable modules for apps and scripts that work with sempods data. Connect to a
Pod, read Linked Data and edit it without losing someone else's changes. People
keep their data in their Pod; your code supplies the interaction.

This repository develops and publishes three packages:

| Package                                              | Use it for                                                                   | Runs in                      |
| ---------------------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------- |
| [@sempods/client-sdk](packages/client-sdk/README.md) | Protocol requests, portable OAuth, field definitions and conditional editing | Browser or Node              |
| [@sempods/app-sdk](packages/app-sdk/README.md)       | Login, durable browser sessions, target selection and authoring helpers      | Browser, with optional React |
| [@sempods/app-ui](packages/app-ui/README.md)         | UI components on React Aria and a theme contract, for Tailwind CSS 4 apps    | Browser, React 19            |

`app-sdk` builds on `client-sdk`. Its root entry works without React;
`@sempods/app-sdk/react` adds components and hooks. `app-ui` adds shadcn/ui
components and adapters for SDK editors on top of app-sdk's React entry; app-sdk
itself stays free of a UI framework. The packages provide ESM and TypeScript
declarations. The examples demonstrate their public APIs and serve as
executable integration checks.

Starting a new app with a coding assistant? Use
[sempods-apps-template](https://github.com/sempods/sempods-apps-template), the
app-focused starting point built on these modules. Work in this repository when
changing the SDK, its examples or documentation.

## Find your starting point

| I want to…                                           | Start here                                                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose a module                                      | [client-sdk](packages/client-sdk/README.md) or [app-sdk](packages/app-sdk/README.md)                                                                  |
| Create a new app with a coding assistant             | [Apps template](https://github.com/sempods/sempods-apps-template); it reads the SDK's installed [AI guide](docs/ai-app-builder.md)                    |
| Add the SDK to an existing React app                 | [Complete quickstart](docs/quickstart.md), then the relevant [authoring reference](docs/react-authoring.md)                                           |
| Give a coding assistant the SDK's app-building rules | [AI app-builder entry](docs/ai-app-builder.md), also shipped in app-sdk                                                                               |
| Use another UI framework                             | [Headless authoring](docs/react-authoring.md#without-react)                                                                                           |
| Embed widgets in an existing host                    | [Widget authoring](docs/widgets.md)                                                                                                                   |
| Read across a Pod without choosing a context         | [Pod reads](packages/client-sdk/README.md#reading-across-the-pod) and [React overview](docs/react-authoring.md#pod-overviews-with-contexts-on-demand) |
| Write a Node script                                  | [Node example](examples/node-script/README.md)                                                                                                        |
| Configure login or understand session recovery       | [Browser runtime](docs/browser-runtime.md)                                                                                                            |
| Upgrade an existing app                              | [Migration and recovery](docs/migration.md)                                                                                                           |
| Contribute to the modules                            | [Contributing](docs/contributing.md), [development checks](docs/development.md) and [AGENTS.md](AGENTS.md)                                            |

The [documentation map](docs/README.md) routes to optional guides by task.
[Build your own app](docs/build-your-app.md) explains the model;
the [hackathon reference](docs/hackathon.md) is a checklist after setup.
The [vision](docs/vision.md) and
[architecture decisions](docs/decisions.md) explain the package boundaries.

## Try the examples locally

Use Node 24.15 or newer and pnpm 11.1.2. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:todo
```

Open `http://127.0.0.1:5173/` and connect a Pod with a test context. The
[TODO example](examples/todo/README.md) uses only the SDK's standard UI beside an
app-owned header and task screen.
The [Node example](examples/node-script/README.md) uses the same field definitions.

The packages are published on npm under Apache-2.0 (documentation: CC BY 4.0;
see [NOTICE](NOTICE)). Version 0.x may change APIs between minor versions.
Automated checks cover installed packages and browser fixtures. Live-Pod,
installed-device and independent app-author validation are separate evidence;
see [development checks](docs/development.md).

For 0.6.0, see the [release notes](docs/releases/0.6.0.md) and
[upgrade instructions](docs/migration.md#from-050-to-060).

## Supported environments

| Environment                  | Status in 0.6                                                                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node                         | 24.15 or newer (Node 24 LTS), ESM only (`engines` in every package).                                                                                                               |
| Browser tab                  | Current browsers with IndexedDB and Web Locks. Automated browser checks run in Chromium.                                                                                           |
| React                        | 19, for `@sempods/app-sdk/react` (optional peer).                                                                                                                                  |
| UI kit                       | Not in 0.6; from the next release, `@sempods/app-ui` with React 19 and Tailwind CSS 4.1 or newer. Its browser gate runs in Chromium and WebKit, and in Firefox on Linux CI.        |
| Installed PWA (experimental) | Desktop Chromium and Android are expected to work; iOS/iPadOS home-screen apps are unverified. Login returns to the app in the same window and must land in the app's own storage. |

Support for installed apps is extended after device evidence. Until then, use a
normal browser tab where an installed app cannot complete sign-in.

Explore [sempods](https://www.sempods.org/), its
[use cases](https://www.sempods.org/use-cases/) and the
[protocol specification](https://github.com/sempods/sempods-spec).
