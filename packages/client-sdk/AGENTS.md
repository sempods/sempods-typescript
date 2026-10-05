# Portable client scope

Read the [package contract](README.md) and
[architecture decisions](../../docs/decisions.md).
Protocol and field-editing work belongs here; browser persistence, app coordination
and React belong to app-sdk. Preserve the separate root, OAuth, host and edit entries.

Check changes against the normative
[sempods specification](https://github.com/sempods/sempods-spec) at a recorded
revision. Kotlin is interoperability evidence, not a replacement specification.
Update defining TypeScript contracts and affected examples. Review the
[export budget](src/exports.test.ts) deliberately; adding a name needs a consumer.
Use the [packed consumer checks](../../docs/development.md) for changed public APIs.
