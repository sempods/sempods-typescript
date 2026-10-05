# Record live evidence

Use the [local testing checklist](../local-testing.md) for app flows and
[PWA guide](../pwa.md) for installed-device cases. Agree on an authorized Pod,
dedicated context and synthetic resources. GitHub access is not Pod access.
Have the person complete login/consent in their browser; do not request credentials.

Record package versions and installation method, app origin/callback and identity
mode, browser/platform, and actual deployed Pod/spec revisions where available.
An inspected source checkout does not prove the server's deployed revision.
Use public package exports and a fresh consumer; retain no real tokens, PKCE
material, callback parameters or browser storage in evidence.

For each exercised flow, record the action, observed outcome and cleanup or retained
synthetic resource. Distinguish failures, untested cases and successful evidence.
Cover reload, selection, conditional conflict and uncertain-write recovery as
applicable; do not manufacture real-token expiry by editing credentials. MCP can
independently inspect an authorized synthetic resource, but cannot prove browser
callback, storage, CORS or service-worker behavior.

Installed PWA tests name the device and storage container, including where OAuth
returns. Do not bridge session material between containers. A normal browser tab
or fixture run does not establish installed-app support. Likewise, an agent
walkthrough does not replace an unfamiliar person's authoring exercise.

Keep private evidence local; publish only a scrubbed summary that stands on its own.
Do not delete unrelated resources or claim cleanup that was not performed.
