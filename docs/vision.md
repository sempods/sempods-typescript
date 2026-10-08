# Purpose and direction

People should be able to build a small, useful app around their own data without
building another backend or moving that data into an app vendor's database.
sempods apps can be static frontends: the Pod stores semantic data and enforces
access; the app supplies a vocabulary, interactions and presentation.

This repository supplies reusable modules and working examples. New app projects,
especially those created with a coding assistant, start in
[sempods-apps-template](https://github.com/sempods/sempods-apps-template).

The TypeScript SDK makes this practical for people and coding assistants.
`@sempods/app-sdk` is the ordinary app author's entry. Its default UI should make a
first working slice easy; replacing that UI should preserve the same safe editing,
connection and recovery behavior. Apps should be deployable as PWAs, while support
claims follow actual browser and installed-device evidence. Small shared-host
widgets should use the same facilities without requiring AppShell.

`@sempods/client-sdk` is also an independent product: portable protocol and editing
for browser or Node consumers, without requiring React or browser sessions.
A small, understandable public API and executable examples matter more than
wrapping every protocol feature immediately.

Success means that an unfamiliar developer or assistant can build and adapt an app
using public exports and linked documentation, without reading SDK internals to
recreate auth or write recovery. Test this with real authoring exercises as well
as automated consumers. Simple frontend deployment does not remove responsibility
for handling granted data carefully.

This is direction, not a feature checklist. The [README](../README.md) owns current
support, the [guides](README.md) describe shipped behavior, and
[issues](https://github.com/sempods/sempods-typescript/issues) own future scope.
[Architecture decisions](decisions.md) explain the boundaries that keep this useful.
