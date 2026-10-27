# An app of your own

Imagine a shared task board, a recipe collection or a reading notebook. You choose
the interface. People choose where their data lives and which part your app may
use. Another app can work with the same data when it understands the vocabulary
and receives permission. A new interface need not become a new data silo.

For a new app, start in
[sempods-apps-template](https://github.com/sempods/sempods-apps-template) with
your coding assistant. A short request such as “a Todo app” is enough: the
assistant proposes a focused interaction and design, then shows a working
first draft. You can respond in everyday terms; you do not need to choose SDK
APIs, colors or layout components first.

Already have a React project? Follow the [SDK quickstart](quickstart.md).
This page explains the model when you need it. The
[vision](https://www.sempods.org/) and [how it works](https://www.sempods.org/how-it-works/)
give more background.

## What you build, what you reuse

```text
Your static app: screens + data vocabulary + app identity
       ↓ app-sdk: connection, consent flow, selection, editing feedback
       ↓ client-sdk: protocol requests and conditional writes
The Pod: stored data + authoritative permission checks
```

A **Pod** is a data service where people keep data. A **context** is a named
part of a Pod with its own access rights; a Pod's owner can share a context
with other people. A **subject IRI** identifies a thing, such as one task.
**RDF predicates** name its properties with globally meaningful identifiers.
The **app DID** identifies the deployed app; it is different from the person's
identity and from the Pod URL.

The person signs in at the Pod they want to use: their own, or one whose owner
shares a context with them, such as a family's shared list. They grant the app
selected contexts there; that Pod decides which of its contexts the person and
the app may use. The app-sdk
connects that flow to your screen without handing the screen tokens.
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

For a first task app, an assistant can turn “a Todo app” into this working brief:

> Show tasks in a context I choose. Let me add a title, complete or reopen a task,
> rename it and delete the version I saw. Keep my draft if another app changes
> the same task. Make the screen readable on a phone and usable with a keyboard.

The assistant chooses the technical vocabulary from the interaction before
writing data. The quickstart uses
`https://schema.org/Action`, `schema:name` as untagged text, and explicit
Potential/Completed action statuses. This is a small example mapping, not a claim
that every Action on the Web is a task. Existing apps must agree on type,
predicates, languages and status values to interoperate. Show unsupported entries
instead of silently converting unfamiliar data.

Build login → select context → read → create → edit → recover as one small slice.
After that works, change the layout, add filters or choose a different domain.
With an AI assistant, begin with [the AI entry document](ai-app-builder.md). It
contains design defaults, task-specific references and implementation rules.

## The API through the task example

The [quickstart](quickstart.md) contains complete `tasks.ts` and `App.tsx` files.
The [API table](react-authoring.md#api-at-a-glance) maps each app need, from
starting the runtime to explaining an outcome, to the hook or component and
what you supply.

For example, the quickstart's completion action is
`row.update({ done: !row.data.done })`, with `row = mutate.for(item)`.
Here `item` is the snapshot supplied by
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

Use the template's available UI pieces and your own screen design. Keep one
clear main action, intentional typography and spacing, and useful empty and
error states. The reference app's behavior is reusable; a journal or recipe
collection need not look like a task list. The assistant
[inspects the rendered result](ai-app-builder.md#check-the-result-then-show-it)
before showing it to you.

The [authoring guide](react-authoring.md)
shows replacing the connection view, composing without `AppAccess`, translating SDK
messages, adding custom reads and using the headless controllers without React.
UI language, RDF content language and display time zone are independent choices.
Keep the runtime instance stable as you change presentation; `fields()` definitions
may be written inline.

The first supported path is deliberately small: one explicitly selected context
per view (Pod-wide reads use `usePodLoad` without one), durable browser storage,
and one active tab per runtime configuration.
For the exact supported operations and deferred features, read the
[client reference](../packages/client-sdk/README.md) and
[runtime limits](browser-runtime.md). Protocol features mentioned on the website
are not automatically SDK exports.

Next, follow [local and hosted testing](local-testing.md), then
[deployment](deployment.md). Save the SDK version, your field mapping and the
manual test results alongside the app so both people and future AI sessions can
continue from evidence.
