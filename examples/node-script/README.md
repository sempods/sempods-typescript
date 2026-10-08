# Node task consumer

From the workspace root, build the script:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm build:examples
```

Provide your own delegated access token through `SEMPODS_TOKEN` in the environment;
then run (replace the example Pod/context/IRI):

```sh
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work list
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work create 'Read a book'
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work create-at urn:uuid:example 'Read a book'
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work rename urn:uuid:example 'Read two books'
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work complete urn:uuid:example
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work reopen urn:uuid:example
node examples/node-script/dist/main.js https://pod.example/alice https://pod.example/alice/_system/contexts/work delete urn:uuid:example
```

The script imports only client-sdk and the TODO's shared field/domain definitions.
It owns authentication explicitly; there is no browser runtime or React. It prints
JSON outcomes and editor state; conflict or uncertainty is not retried automatically.
After an `unconfirmed` creation, keep its printed IRI and original title. Use
`list` to inspect the context, or explicitly retry with `create-at IRI TITLE`
using exactly those values. This is create-only (`If-None-Match: *`), so it cannot
overwrite an existing resource or create a second task under a new IRI. A missing
row does not rule out a delayed write. Do not retry with `create`, which generates
another IRI. Each invocation has fresh local state: `exists` means the IRI is
already in use, not that the earlier uncertain attempt was confirmed.
The script is a small interaction example, not a daemon or unattended retry tool.
`pnpm test:todo` runs every command against a loopback fixture using packed SDKs.
