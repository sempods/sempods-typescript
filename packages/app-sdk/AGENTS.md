# App SDK scope

Read the [package overview](README.md),
[browser runtime](../../docs/browser-runtime.md) and
[architecture decisions](../../docs/decisions.md). For UI work, also read
[React/headless authoring](../../docs/react-authoring.md).

Runtime and headless changes must preserve the React-free root entry. UI changes
consume existing facts and guarded actions rather than adding another coordinator
or inferred session taxonomy. For shared widgets, follow the
[host ownership and duplicate-module rules](../../docs/widgets.md).
For worker or callback changes, read the [PWA invariants](../../docs/pwa.md).

Update defining TypeScript contracts and relevant guides. Review the
[export budget](src/exports.test.ts) deliberately; prove changed public composition
with the [packed consumers](../../docs/development.md).
