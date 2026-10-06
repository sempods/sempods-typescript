# Build your own sempods app

A task board for your family. A reading list that several apps can use. A small
research notebook shaped around how you think. With sempods, your app can be a
frontend: people connect their Pod, choose what to share, and keep their data
independently of your interface.

**`@sempods/app-sdk` is the starting point for building that interface**, by hand
or with an AI coding assistant. You describe the data and the screen; the SDK
supplies login, connections, context selection and editing with conflict recovery.
The Pod enforces access on every request. You can host the app as static files.

Both packages are published on npm under the Apache-2.0 licence (documentation:
CC BY 4.0; see [NOTICE](NOTICE)). Version 0.x may still change the API between
minor versions. Live-Pod validation and an independent app-author exercise remain
separate from the automated checks.

## Your first app

Want your own small apps quickly, set up and kept up to date by your coding
assistant? Start from the
[sempods apps template](https://github.com/sempods/sempods-apps-template): one
repository for your personal apps, built on this SDK. The steps below build an
app from an empty folder instead.

At a hackathon? Keep the [one-page quick reference](docs/hackathon.md) nearby.

1. [Understand the idea and choose a small app](docs/build-your-app.md).
2. [Give your AI assistant the app-builder instructions](docs/ai-app-builder.md),
   or follow the same steps yourself.
3. [Build a task app from an empty folder](docs/quickstart.md).
4. [Test against a local or hosted Pod](docs/local-testing.md).
5. [Deploy the static app with an app DID](docs/deployment.md), using Netlify
   as a concrete example, and [make it an installable PWA](docs/pwa.md).

Already have this checkout? Run `pnpm install --frozen-lockfile` and
`pnpm dev:todo`, then open `http://127.0.0.1:5173/`. The
[TODO example](examples/todo/README.md) has centered login without an SDK frame, a legacy AppShell, and the same screen
in a custom layout at `/custom`; both need a Pod for real data.

## Find the right API

| You want to…                                            | Start here                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Build a browser app with React                          | [Quickstart](docs/quickstart.md) and [authoring API](docs/react-authoring.md)                  |
| Build widgets without AppShell                          | [Widget authoring](docs/widgets.md)                                                            |
| Use another UI framework                                | [Headless authoring](docs/react-authoring.md#without-react), using the same browser runtime    |
| Configure connections or understand session recovery    | [Browser runtime](docs/browser-runtime.md)                                                     |
| Build a Node script or use portable protocol operations | [client-sdk](packages/client-sdk/README.md) and [Node example](examples/node-script/README.md) |
| Upgrade an existing app                                 | [Migration and recovery](docs/migration.md)                                                    |
| Change the SDK itself                                   | [Contributing](docs/contributing.md) and [development checks](docs/development.md)             |

`@sempods/app-sdk` depends on `@sempods/client-sdk`; React is an optional peer
through `@sempods/app-sdk/react`. Both packages emit ESM and TypeScript declarations.
The portable client also provides Pod-wide SELECT/CONSTRUCT queries without
Context enumeration, and the field definitions used by browser apps. See
[Pod reads](packages/client-sdk/README.md#reading-across-the-pod); runtime/React
integration remains separate follow-up work.
[Architecture decisions](docs/decisions.md) explain these boundaries.

For all guides and contributor workflows, use the [documentation map](docs/README.md).
Agents changing this SDK start with [AGENTS.md](AGENTS.md).

## Supported environments

| Environment                  | Status in 0.3                                                                                                                                                                      |
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
