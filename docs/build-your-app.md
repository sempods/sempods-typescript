# An app of your own

Imagine a shared task board, a recipe collection or a reading notebook. You choose
the interface. People choose where their data lives and which part your app may
use. Another app can work with the same data when it understands the vocabulary
and receives permission. A new interface need not become a new data silo.

That is the useful starting point for sempods. Read the
[vision](https://www.sempods.org/) and [how it works](https://www.sempods.org/how-it-works/),
then make one small idea real with the [quickstart](quickstart.md).

## What you build, what you reuse

```text
Your static app: screens + data vocabulary + app identity
       ↓ app-sdk: connection, consent flow, selection, editing feedback
       ↓ client-sdk: protocol requests and conditional writes
The person's Pod: stored data + authoritative permission checks
```

A **Pod** is a person's data service. A **context** is a named part of that Pod
with its own access rights. A **subject IRI** identifies a thing, such as one task.
**RDF predicates** name its properties with globally meaningful identifiers.
The **app DID** identifies the deployed app; it is different from the person's
identity and from the Pod URL.

The person signs in through their Pod and grants the app selected contexts. The
app-sdk connects that flow to your screen without handing the screen tokens.
Ordinary data access needs context grants, not a made-up OAuth scope such as
`tasks:write`. A Pod still decides every request, even if your UI thinks a button
is enabled. A static app needs neither its own user database nor a secret client
credential for this flow.

This makes sempods a useful fit for AI-assisted app building: concentrate on the
idea, vocabulary and interaction while reusing the protocol and permission model.
The boundary is concrete: generated frontend code cannot award itself Pod rights,
but it can use or disclose data within the access it was given. Use a dedicated
test context, review what the app does, and request only what the feature needs.

## Start with one complete interaction

For a first task app, write this brief:

> Show tasks in a context I choose. Let me add a title, complete or reopen a task,
> rename it and delete the version I saw. Keep my draft if another app changes
> the same task. Make the screen readable on a phone and usable with a keyboard.

Choose the vocabulary before drawing the screen. The quickstart uses
`https://schema.org/Action`, `schema:name` as untagged text, and explicit
Potential/Completed action statuses. This is a small example mapping, not a claim
that every Action on the Web is a task. Existing apps must agree on type,
predicates, languages and status values to interoperate. Show unsupported entries
instead of silently converting unfamiliar data.

Build login → select context → read → create → edit → recover as one small slice.
After that works, change the layout, add filters or choose a different domain.
With an AI assistant, begin with [the AI entry document](ai-app-builder.md). It
contains the reading order, a starting prompt and implementation rules.

## The API through the task example

The [quickstart](quickstart.md) contains complete `tasks.ts` and `App.tsx` files.
These are the moving parts you will reuse:

| App need                                  | API                                                     | What you supply                                                            |
| ----------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Start the app                             | `createBrowserRuntime` → `SempodsProvider` → `AppShell` | One stable runtime, identity and title                                     |
| Keep state attached to the chosen context | `TargetScreen`                                          | Your screen inside it                                                      |
| Describe a task                           | `fields`, `text`, `flag`, `iri` from `client-sdk/edit`  | Type and predicate IRIs; explicit text language                            |
| Display tasks                             | `useList(task)`                                         | The same field definition; render ready, loading and failure states        |
| Add a task                                | `useCreation(task, options)`                            | Initial draft, collection path, inputs calling `change`                    |
| Complete a task                           | `useFieldUpdate(task)`                                  | The original list snapshot and the changed field                           |
| Open another task                         | `useSelection()`                                        | Selected IRI; use its guarded `select` action                              |
| Edit or delete                            | `useResourceEditor(selected, task)` + `ResourceEditor`  | Inputs for the draft; the component supplies save/delete/recovery controls |
| Explain an outcome                        | `UpdateNotice`                                          | The creation/update hook's `notice`                                        |

For example, the quickstart's completion action is
`update.update(t, { done: !t.data.done })`. Here `t` is the snapshot supplied by
`useList`, including evidence of the data the person saw. Rebuilding it from a
plain `{ title, done }` object loses that evidence. For a form, call
`change({ title: value })` and let the editor preserve untouched properties and
other language variants.

A confirmed write refreshes that target's list. Different-field edits can survive
a concurrent update through the SDK's bounded rebase. A same-field conflict asks
for comparison. If the network loses a write's answer, the result is unconfirmed:
show recovery and inspect the captured resource, rather than repeating the action
with a new IRI. These states are part of the user experience, not error messages
to hide behind a generic retry button.

## Make it your app

Use your own CSS and screen components. The [authoring guide](react-authoring.md)
shows replacing shell components, composing without AppShell, translating SDK
messages, adding custom reads and using the headless controllers without React.
UI language, RDF content language and display time zone are independent choices.
Keep the runtime instance stable as you change presentation; `fields()` definitions
may be written inline.

The first supported path is deliberately small: one explicitly selected context
per view, durable browser storage, and one active tab per runtime configuration.
For the exact supported operations and deferred features, read the
[client reference](../packages/client-sdk/README.md) and
[runtime limits](browser-runtime.md). Protocol features mentioned on the website
are not automatically SDK exports.

Next, follow [local and hosted testing](local-testing.md), then
[deployment](deployment.md). Save the SDK version, your field mapping and the
manual test results alongside the app so both people and future AI sessions can
continue from evidence.
