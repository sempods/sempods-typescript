# Proposal: access and sessions across devices

**Status: accepted, partly implemented.** The open questions are settled
(see [Decisions](#decisions)). Remembered Pods (section 3) are implemented
([#237](https://github.com/sempods/sempods-typescript/issues/237)) and
described in the [browser runtime guide](../browser-runtime.md#remembered-pods);
the other sections are not implemented yet. It spans
[sempods-kotlin](https://github.com/sempods/sempods-kotlin), this SDK and the apps
built on it. Implemented parts move into [architecture decisions](../decisions.md),
the [browser runtime guide](../browser-runtime.md) and the issues listed at the end.

## Problem

People use one sempods app on several devices: a phone browser, an installed PWA
and a desktop browser. Today that combination signs them out, and the SDK's
access UI makes recovery cumbersome:

1. **Sessions are lost after about an hour.** A sign-in on one device ends the
   others at their next token refresh.
2. **The Pod is forgotten.** After a lost session or a sign-out and a reload, the
   app shows an empty Pod address field. People type the long address again.
3. **Recovery UI is fixed in the layout.** `AppAccess` renders sign-in, recovery
   and callback outcomes inline. An informational outcome, such as a cancelled
   sharing change, stays in the layout and cannot be dismissed
   ([#227](https://github.com/sempods/sempods-typescript/issues/227)).
4. **Apps without sign-in are not supported.** An app linked to one Pod that
   only shows public data still needs a session.

## Findings

The facts below refer to sempods-kotlin at
[`01e842d`](https://github.com/sempods/sempods-kotlin/tree/01e842db7cbfa5db0e062102b4d86b9fbefc3146)
and to this SDK at 0.7.0.

### Server: lifetimes

|                          | Shorter connection (box unticked)                     | Durable connection (box ticked) |
| ------------------------ | ----------------------------------------------------- | ------------------------------- |
| Access token             | 1 hour                                                | 1 hour                          |
| Refresh family, idle     | 96 hours                                              | 90 days                         |
| Refresh family, absolute | 7 days                                                | 180 days                        |
| Pod sign-in cookie       | 12 hours since the last `/authorize`, at most 30 days | same                            |

Both answers issue a refresh token. The consent box ("keep this app connected")
only chooses the refresh lifetime. The sign-in cookie is not renewed by data
requests or refreshes. It only lets a later authorization skip the identity
provider's login. See the server's
[connection guide](https://github.com/sempods/sempods-kotlin/blob/01e842db7cbfa5db0e062102b4d86b9fbefc3146/sempods-server/docs/auth/connections.md).

### Server: devices end each other's sessions

Refresh families are keyed by Pod, `client_id` and WebID. Nothing identifies a
device. A deployed app has one `did:web` client ID for every device.

- **A new sign-in revokes the other families.** Every authorization code
  exchange revokes the live refresh families of that Pod, client and person
  ([`PodTokenExchange.kt`](https://github.com/sempods/sempods-kotlin/blob/01e842db7cbfa5db0e062102b4d86b9fbefc3146/sempods-server/src/main/kotlin/org/sempods/pods/oauth/flows/PodTokenExchange.kt#L195-L276)).
  An automatic re-grant counts too. Another device keeps its access token for up
  to an hour. Its next refresh then fails with `invalid_grant "refresh token revoked"`.
- **An unticked box revokes all families.** Submitting the consent with the box
  unticked revokes every refresh family of that client and person, on all
  devices
  ([`PodConsentFlow.kt`](https://github.com/sempods/sempods-kotlin/blob/01e842db7cbfa5db0e062102b4d86b9fbefc3146/sempods-server/src/main/kotlin/org/sempods/pods/oauth/flows/PodConsentFlow.kt#L284-L300)).
- **Rotation has no grace period.** Presenting a rotated refresh token is
  treated as reuse and revokes the whole family. Losing a concurrent rotation
  race is treated the same way
  ([`PodTokenExchange.kt`](https://github.com/sempods/sempods-kotlin/blob/01e842db7cbfa5db0e062102b4d86b9fbefc3146/sempods-server/src/main/kotlin/org/sempods/pods/oauth/flows/PodTokenExchange.kt#L489-L500)).

The result: two devices that sign in alternately keep signing each other out.
Redeploying the app or the server does not matter. Client identity, keys,
grants and refresh families are persistent.

### SDK: a lost token answer ends the session

The runtime durably claims a refresh, which removes the refresh token, before
it sends the request
([runtime](../../packages/app-sdk/src/runtime/runtime.ts)). This applies to any
failure after the claim, including a network error on the token request or a
page suspended mid-refresh. Such a failure retires the session. This follows the
current decision that "a spent refresh token must never be reused". On mobile
networks it turns a lost answer into a sign-out.

### SDK: ended sessions are hidden

Ending a session (failed refresh, denial) and signing out both store a
`disconnected` record that still holds the Pod binding. Startup skips those
records, so the Pod disappears from the app after a reload. The address field
always starts empty.

### SDK: the UI owns the outcome

`AppAccess` decides placement itself. It renders sign-in, recovery and
re-authorization inline, and only management can become a dialog. It stays
visible while `callbackNotice` or a retry is pending. `callbackNotice` clears
only on the next sign-in, selection or disconnect. Apps cannot express "show
this as a toast" or "ask in a dialog".

### SDK: anonymous reading

The client SDK already has `anonymous()`. The server reads public resources
without a token. The browser runtime has no connection without a session.

## Goals

- A session stays usable on every device for its server lifetime, including
  when the same person signs in elsewhere.
- A short network failure never signs anyone out. A refresh whose outcome stays
  unknown beyond the server's grace period cannot be recovered without a new
  sign-in. That case is reported as such, and signing in again is one action.
- Signing in again is one action: the app remembers the Pod address.
- The app decides how access outcomes are presented. The SDK classifies them
  and supplies sensible defaults.
- Apps can work without sign-in, or with optional sign-in, on public data.
- Visual design of the access components is out of scope here.

## Proposal

### 1. Server: independent sessions per device (sempods-kotlin)

1. **An authorization code exchange revokes nothing else.** Each sign-in starts
   its own family. Families still end by their idle and absolute limits, by
   sign-out everywhere and by withdrawn grants.
2. **Bound the number of families.** Cap live families per Pod, client and
   person, at 10 by default (a server setting). Exceeding it retires the least
   recently refreshed family. This replaces the current concern that repeated
   reconnects leave families behind, each renewing its own window.
3. **The lifetime answer applies only to the family it creates.** An unticked
   box gives the new family the shorter terms. It neither revokes nor shortens
   any other family, and a later answer does not change the terms of existing
   families either. Shortening every connection of an app is a separate,
   explicit action on the consent page, next to sign-out everywhere. Otherwise
   a device signed in for ten days would end at its next refresh as soon as
   another device chose the shorter connection.
4. **A rotation grace period of 60 seconds by default** (a server setting).
   Within it, presenting the predecessor once more is answered with a fresh
   successor in the same family, instead of revoking the family. After it, the reuse rule stays as it is.
   Several widely used authorization servers offer such a period against lost
   answers and concurrent refreshes. It weakens reuse detection only within
   that window.
5. **Diagnostics.** Log revocation causes per family (reconnect, cap, sign-out,
   reuse) with client ID and family ID, so a lost session can be explained from
   the logs.

Items 1–3 alone remove the cross-device sign-outs. Item 4 makes item 2 of the SDK
part safe to implement.

### 2. SDK: resilient renewal (app-sdk)

- **The claim keeps the refresh token.** A refresh claim records the refresh
  token and when it was sent. After a failure whose outcome is unknown (network
  error, timeout, an interrupted claim found at startup), the runtime retries
  **once** with the same token while the claim is younger than the grace period.
  Then it either succeeds or ends the session with the server's answer.
- **Waiting is bounded by the grace period.** While the device is offline and the
  claim is still younger than the grace period, the connection stays
  `ended { restorable: true }`, and the retry runs when the browser comes back
  online. It is restorable only for as long as that retry can succeed.
- **An unknown outcome beyond the grace period needs a new sign-in.** This covers
  two cases: the device stays offline past the grace period, or the single retry
  loses its answer as well. The client then holds no token the server would
  accept. Another attempt would only trigger reuse detection. The connection
  ends as `ended { problem: 'interrupted' }` and keeps its Pod address (section 3).
  Signing in again is one action, without interaction while the Pod sign-in
  cookie is valid. Closing this gap would need a server mechanism beyond the
  grace period, which this proposal does not include.
- **Only these cases end the session:**
  - an explicit refusal from the token endpoint (`invalid_grant`,
    `invalid_client`);
  - an expired access token without a refresh token;
  - an outcome that stayed unknown beyond the grace period, as above.
- **Why the old rule can be relaxed.** A Pod without a grace period answers the
  retry with reuse detection, so the session ends as it does today. A Pod with
  one keeps it. The decision "a spent refresh token must never be reused" in
  [architecture decisions](../decisions.md) is replaced by "reused at most once,
  within the grace period, only after an unknown outcome".

### 3. SDK: remembered Pods (app-sdk)

Implemented in [#237](https://github.com/sempods/sempods-typescript/issues/237);
the [browser runtime guide](../browser-runtime.md#remembered-pods) describes the
result. What follows is the proposal as accepted.

- **A connection outlives its session.** Startup lists retired records as
  connections with `session: { kind: 'signed-out' }` and their Pod address. A
  retired record keeps only the address and binding: no tokens and no verifier.
  The reason for the end, such as `expired` or `revoked`, is kept for display.
- **Signing out and forgetting are separate.** `disconnect(id)` signs out and
  keeps the address. A new `forget(id)` deletes the record.
- **Signing in again is one action.** `authorize(id)` for a signed-out
  connection uses the remembered address. With a valid Pod sign-in cookie and a
  remembered consent, the Pod answers without any interaction, so the round trip
  is a quick redirect.
- **An app can opt out.** A runtime option (`rememberPods: false`) makes sign-out
  and session end forget the address immediately. This is for shared devices or
  privacy-sensitive apps. The default remembers addresses: the address is on the
  person's own device and is not a credential.
- **Several Pods.** Each connection keeps its own session. One ended session never
  affects another. The prompts below name the connection they belong to.

### 4. SDK: access prompts instead of inline UI (app-sdk)

The headless controller derives a list of **access prompts** from runtime facts.
It does not add session states. The runtime stays the authority. Each prompt
describes one thing that needs attention:

```ts
type AccessPrompt = {
  readonly id: string; // stable while the cause lasts
  readonly connectionId: string | null;
  readonly severity: 'blocking' | 'action' | 'info';
  readonly reason:
    | 'no-connection' // nothing to work with: sign in or choose a Pod
    | 'session-ended' // remembered Pod, signed out or expired
    | 'unreachable' // restorable, retried automatically
    | 'missing-scopes'
    | 'sign-in-failed'
    | 'sign-in-cancelled'
    | 'sharing-unchanged'
    | 'other-tab'
    | 'storage';
  readonly actions: readonly (
    'sign-in' | 'retry' | 'choose-context' | 'forget' | 'dismiss'
  )[];
  readonly failure?: SdkFailure;
};
```

- **Severity follows what the app can still do.**
  - **Blocking:** the app has no usable connection for its current need, for
    example at first start or when the only remembered Pod is signed out and the
    app requires sign-in. The app shows a sign-in screen.
  - **Action:** something is wrong, but the app stays usable or at least
    readable, for example a non-active Pod that ended or missing optional
    scopes. The app shows a dialog or a banner.
  - **Info:** nothing changed or nothing needs doing, for example a cancelled
    sharing change. The app shows a toast that disappears.
- **`dismiss(promptId)` retires `info` and `action` prompts.** It replaces the
  sticky `callbackNotice`. A blocking prompt cannot be dismissed. It ends when its
  cause ends.
- **React gets `useAccessPrompts()` and three default components:**
  `AccessGate` for the blocking sign-in screen with remembered Pods and an
  address field, `AccessPrompt` for one action or info prompt, unstyled for an
  app's own toast or dialog, and the existing management view as a dialog.
- **`AppAccess` stays.** It is rebuilt from these parts with today's props, so
  existing apps keep working. It becomes the "everything inline" composition
  rather than the only one.
- **No sign-in screen while restoring.** Startup renders the app's content area
  while a saved session restores and shows the gate only once there is a blocking
  prompt. That removes the tall loading panel that shifts content on every start.

### 5. SDK: access modes (app-sdk)

A runtime option declares what the app needs:

- **`access: 'required'`** (default): today's behaviour. Without a usable
  connection, the gate blocks.
- **`access: 'optional'`:** with a `preset` Pod, the app starts with an anonymous
  connection to it. It reads public data with `anonymous()` and offers
  "sign in" as an action prompt to see more or to write.
- **`access: 'none'`:** only anonymous connections to preset or allowed Pods,
  with no sign-in UI.

Anonymous connections need a specification check first: which catalogue and
query endpoints answer without a token, and what an anonymous catalogue contains.
Until then this part stays a design.

## Out of scope

- **Visual design of the access components**, after the flow is settled.
- **Several tabs of one app at once.** The second tab still reports `other-tab`.
  On Android an installed PWA and a browser tab of the same app share storage, so
  the second one opened sees this prompt. Cross-tab coordination is separate work.
- **Automatic re-authorization at startup.** Redirecting without a click risks
  loops and lost drafts. Signing in again stays one explicit action. An opt-in can
  follow once the server changes have shown how often it is needed.

## Order

0. **Confirm the cause from server logs:** `reconnect retired what it supersedes`
   and `refresh token revoked` for the app's client ID, at the times of sign-ins
   on another device.
1. **Server:** independent families, the family cap and the unticked-box rule
   (section 1, items 1–3, plus item 5):
   [sempods-kotlin#446](https://github.com/sempods/sempods-kotlin/issues/446).
   This fixes the main problem without any app change.
2. **SDK, in parallel:** remembered Pods (section 3,
   [#237](https://github.com/sempods/sempods-typescript/issues/237)) and access
   prompts (section 4,
   [#238](https://github.com/sempods/sempods-typescript/issues/238), superseding
   [#227](https://github.com/sempods/sempods-typescript/issues/227)).
3. **Server grace period** (section 1, item 4,
   [sempods-kotlin#447](https://github.com/sempods/sempods-kotlin/issues/447)),
   **then SDK resilient renewal** (section 2,
   [#239](https://github.com/sempods/sempods-typescript/issues/239)).
4. **Apps:** adopt prompts and the gate, then validate live with a phone browser,
   an installed PWA and a desktop browser used alternately for a day. The apps
   track this in their own repository.
5. **Access modes** (section 5,
   [#240](https://github.com/sempods/sempods-typescript/issues/240)), after the
   specification check.

## Decisions

Settled on 2026-11-05, before implementation:

1. **Pod addresses are remembered by default.** Apps opt out with
   `rememberPods: false`. The address is not a credential and stays on the
   person's device.
2. **Family cap and grace period.** The cap is 10 families per Pod, client and
   person, and the grace period is 60 seconds. Both are server settings, so a
   deployment can change them.
3. **`AppAccess` may change behaviour in 0.8 while keeping its props.** This
   covers dismissible notices and dropping the tall loading panel. The
   migration notes describe the change; the old behaviour is not kept.
4. **The specification describes both server rules** as recommended behaviour
   (SHOULD): the grace period, as an amendment to `SPS-AUTH-033`, and families of
   one client that coexist across devices. Tracked in
   [sempods-spec#142](https://github.com/sempods/sempods-spec/issues/142).
