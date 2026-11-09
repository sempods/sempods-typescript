import {
  prepareSessionAuthorization,
  safeReturnTo,
  type SessionBinding,
} from '../sessions/authorization.js';
import {
  anonymous,
  createPod,
  isContextIri,
  type AuthCredential,
} from '@sempods/client-sdk';
import {
  createClientRegistry,
  discoverPod,
  exchangeAuthorization,
  refreshAuthorization,
  OAuthError,
  type ExchangeResult,
  type OAuthClient,
  type PodDiscovery,
} from '@sempods/client-sdk/oauth';
import { callbackUrl, scopeList } from '@sempods/client-sdk/oauth/host';
import { acquireSessionLease, type SessionLease } from '../sessions/lease.js';
import { openSessionStore } from '../sessions/store.js';
import {
  createSessionTransitions,
  assertSessionBinding,
  type SessionChange,
} from '../sessions/transitions.js';
import {
  sessionBinding,
  SessionTransitionError,
  type RefreshResend,
  type SessionRecord,
  type SessionSnapshot,
} from '../sessions/records.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
  Connection,
  DisconnectResult,
  StartupReport,
} from './types.js';
import {
  knownProblem,
  RuntimeError,
  runtimeProblem,
  type RuntimeProblem,
  runtimeFailure,
  transientBeforeClaim,
} from './errors.js';
import { waitFor } from './wait.js';
import { combineSignals } from './signals.js';
import {
  bindView,
  explicitTarget,
  invalidateContexts,
  selectedTarget,
} from './binding.js';
import { bindPod } from './pod-binding.js';
import {
  loadCatalogue,
  loadContextLabels,
  loadSelectedLabel,
  resetLabels,
} from './catalogue.js';
import { browserPreferences, createContextMemory } from './context-memory.js';

import { assertCredentialRecipient, type Entry } from './connection.js';

/** How long before its expiry a credential is renewed before dispatch. */
const RENEWAL_MARGIN = 60_000;
/** How often one dispatch checks a replacement credential before using it. */
const RENEWAL_ROUNDS = 3;
/** The sempods server's default rotation grace period (sempods-kotlin#447). */
const REFRESH_GRACE_PERIOD = 60_000;
/** How long a token request may take before its answer counts as lost. */
const TOKEN_TIMEOUT = 20_000;
/** How long a Pod's discovery (two metadata reads) may take before it counts as unreachable. */
const DISCOVERY_TIMEOUT = 15_000;

/** The token endpoint answered (`renewed`) or its answer was lost (`lost`). */
type Sent =
  | { readonly kind: 'renewed'; readonly result: ExchangeResult }
  | { readonly kind: 'lost' };
/**
 * Whether the token endpoint's answer is unknown: no complete answer (no
 * connection, a timeout, a cut-off body), or one that is neither a token
 * response (`2xx`) nor an OAuth error answer (`400`, `401`), such as a
 * gateway or proxy failure (`5xx`, `403`, `404`, `408`, `429`).
 */
function unanswered(status: number | undefined) {
  return (
    status === undefined ||
    !((status >= 200 && status < 300) || status === 400 || status === 401)
  );
}
/** The longest delay `setTimeout` keeps; longer ones fire at once. */
const MAX_DELAY = 2_147_483_647;
function offline() {
  return globalThis.navigator?.onLine === false;
}

/** Creates no storage, request or navigation until initialize/connect is called. */
export function createBrowserRuntime(
  options: BrowserRuntimeOptions,
): BrowserRuntime {
  const identity = Object.freeze({ ...options.identity });
  const required = scopeList(options.scopes?.required ?? []);
  const optional = scopeList(options.scopes?.optional ?? []);
  const requested = Object.freeze([...new Set([...required, ...optional])]);
  const redirect = callbackUrl(
    identity.redirectUri,
    options.development === 'loopback-http',
  );
  // A string is checked once; a function each time a sign-in starts, so the
  // address the person is on then (a deep link) survives the sign-in.
  const configuredReturnTo = options.returnTo ?? '/';
  const fixedReturnTo =
    typeof configuredReturnTo === 'string'
      ? safeReturnTo(configuredReturnTo, identity.redirectUri)
      : undefined;
  const returnTo = () =>
    fixedReturnTo ??
    safeReturnTo((configuredReturnTo as () => string)(), identity.redirectUri);
  const namespace = JSON.stringify([
    identity.kind,
    identity.kind === 'did-web' ? identity.clientId : identity.redirectUri,
  ]);
  const preset = options.preset
    ? Object.freeze({ ...options.preset })
    : undefined;
  const allowedPods =
    options.allowedPods === undefined
      ? undefined
      : Object.freeze([...options.allowedPods]);
  if (allowedPods) {
    if (!allowedPods.length || new Set(allowedPods).size !== allowedPods.length)
      throw new RuntimeError('configuration');
    for (const url of allowedPods)
      createPod(url, {
        auth: anonymous(),
        ...(options.development ? { development: options.development } : {}),
      });
  }
  function allows(url: string) {
    return allowedPods === undefined || allowedPods.includes(url);
  }
  if (preset) {
    // Reuse the portable client's canonical URL validation; construction sends nothing.
    createPod(preset.podUrl, {
      auth: anonymous(),
      ...(options.development ? { development: options.development } : {}),
    });
    if (
      preset.contextIri !== undefined &&
      !isContextIri(preset.contextIri, preset.podUrl)
    )
      throw new RuntimeError('configuration');
    if (!allows(preset.podUrl)) throw new RuntimeError('configuration');
  }
  const defaultPodUrl =
    preset?.podUrl ?? (allowedPods?.length === 1 ? allowedPods[0] : undefined);
  // Whether a Pod address outlives its session (sign-out, a session that ends).
  const rememberPods = options.rememberPods ?? true;
  const gracePeriod = options.refreshGracePeriod ?? REFRESH_GRACE_PERIOD;
  if (!Number.isFinite(gracePeriod) || gracePeriod < 0)
    throw new RuntimeError('configuration');
  /** Whether a refresh first sent at `sentAt` may still be sent once more. */
  const withinGrace = (sentAt: number) => Date.now() < sentAt + gracePeriod;
  /**
   * Discovers a Pod within a deadline. Discovery only reads metadata, so
   * giving up is safe: a Pod that has not answered after 15 seconds is
   * unreachable (`RuntimeError('network')`, transient like an offline Pod),
   * not loading. A late answer is dropped, also for a fetch that ignores its
   * signal. An aborted `signal` (a lifetime) rejects with `disconnected`.
   */
  async function discover(url: string, signal?: AbortSignal) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), DISCOVERY_TIMEOUT);
    const combined = combineSignals(signal, deadline.signal);
    try {
      return await waitFor(
        discoverPod(url, { ...protocol, signal: combined.signal }),
        combined.signal,
      );
    } catch (error) {
      // An ended lifetime (sign-out, a new sign-in, dispose) stops waiting at
      // once, whether or not the fetch honours its signal.
      if (signal?.aborted) throw new RuntimeError('disconnected');
      if (deadline.signal.aborted) throw new RuntimeError('network');
      throw error;
    } finally {
      clearTimeout(timer);
      combined.dispose();
    }
  }
  let connectingDefault: Promise<Connection> | undefined;
  const contexts = createContextMemory(
    namespace,
    options.preferences === undefined
      ? browserPreferences()
      : options.preferences,
  );
  const protocol = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.development ? { development: options.development } : {}),
  };
  const registry = createClientRegistry(protocol);
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const disconnects = new Map<
    string,
    {
      /** Deletes the record (`forget`), rather than keeping its address. */
      readonly erase: boolean;
      readonly operation: Promise<{ kind: 'disconnected' | 'blocked-locally' }>;
    }
  >();
  let snapshot: readonly Connection[] = Object.freeze([]);
  let lease: SessionLease | undefined;
  let sessions: ReturnType<typeof createSessionTransitions> | undefined;
  let startup: Promise<StartupReport> | undefined;
  let initialized = false;
  let disposed = false;

  function invalidate(e: Entry) {
    e.epoch++;
    e.reads.abort();
    e.reads = new AbortController();
  }
  /** Runtime change notifications for bound views. */
  function subscribe(listener: () => void) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
  function invalidatePod(e: Entry) {
    e.podEpoch++;
    e.podReads.abort();
    e.podReads = new AbortController();
  }
  function publish() {
    snapshot = Object.freeze(
      [...entries.values()].map((e) => Object.freeze({ ...e.view })),
    );
    listeners.forEach((listener) => {
      try {
        listener();
      } catch (error) {
        // Report consumer bugs outside the session transition that notified them.
        queueMicrotask(() => {
          throw error;
        });
      }
    });
  }
  function eligible(e: Entry, generation = e.generation) {
    return (
      !disposed &&
      entries.get(e.view.id) === e &&
      e.generation === generation &&
      !e.lifetime.signal.aborted
    );
  }
  function current(e: Entry, generation: string) {
    if (!eligible(e, generation)) throw new RuntimeError('disconnected');
  }
  function serial<T>(e: Entry, action: () => Promise<T>): Promise<T> {
    const operation = e.persistence.then(action);
    e.persistence = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  function accepted(e: Entry, change: SessionChange) {
    if (change.kind === 'conflict') throw new RuntimeError('disconnected');
    e.revision = change.record.revision;
  }
  function binding(e: Entry, pod = e.pod): SessionBinding {
    return {
      configKey: namespace,
      connectionId: e.view.id,
      generation: e.generation,
      pod,
      client: e.client,
      scopes: e.view.requestedScopes,
    };
  }
  function install(e: Entry, result: ExchangeResult) {
    const previous = e.view.grantedScopes;
    const previousSubject = e.credentials?.subject;
    e.credentials = result;
    e.credential = Object.freeze({
      authorization: `Bearer ${result.accessToken}`,
    });
    e.view = {
      ...e.view,
      session: Object.freeze({ kind: 'active', subject: result.subject }),
      grantedScopes: result.scopes,
      missingRequiredScopes: Object.freeze(
        required.filter((s) => !result.scopes.includes(s)),
      ),
    };
    if (
      previousSubject !== result.subject ||
      previous.length !== result.scopes.length ||
      previous.some((s) => !result.scopes.includes(s))
    ) {
      invalidate(e);
      invalidatePod(e);
      invalidateContexts(e);
      resetLabels(e);
      if (previousSubject !== result.subject) {
        delete e.boundPod;
        delete e.explicit;
        delete e.observations;
        delete e.bound;
      }
    }
    publish();
    loadSelectedLabel(e, { eligible, publish });
  }
  /**
   * Ends the session. A retired record keeps why it ended (`hadSession`); a
   * first sign-in that failed had no session to end, so its record keeps only
   * the address.
   */
  function end(
    e: Entry,
    error: unknown,
    retireRecord = true,
    hadSession = true,
  ) {
    delete e.credentials;
    delete e.credential;
    invalidate(e);
    invalidatePod(e);
    invalidateContexts(e);
    resetLabels(e);
    delete e.boundPod;
    delete e.explicit;
    delete e.observations;
    e.lifetime.abort(new RuntimeError('disconnected'));
    const problem = runtimeProblem(error);
    e.view = {
      ...e.view,
      session: Object.freeze({
        kind: 'ended',
        problem,
        ...runtimeFailure(error),
      }),
      catalogue: Object.freeze({ kind: 'unknown' }),
      grantedScopes: Object.freeze([]),
      missingRequiredScopes: required,
    };
    const ended = e.view.session;
    publish();
    if (!retireRecord) return;
    void retire(e, hadSession ? problem : undefined, !rememberPods).catch(
      () => {
        // A subscriber may already have started sign-out or another sign-in.
        // Cleanup of this ended session must not replace the newer fact.
        if (entries.get(e.view.id) === e && e.view.session === ended) {
          e.view = {
            ...e.view,
            session: Object.freeze({ kind: 'ended', problem: 'storage' }),
          };
          publish();
        }
      },
    );
  }
  /** Deletes a record and, once it is gone, the Context choice remembered with it. */
  async function erase(id: string, revision: string) {
    if (!sessions || (await sessions.forget(id, revision)) === 'conflict')
      throw new RuntimeError('disconnected');
    contexts.forget(id);
  }
  /**
   * Retires the saved session: keeps only the address and why it ended
   * (`reason`), or deletes the record (`deleting`). Resolves whether a record
   * stays; without one, nothing is remembered.
   */
  function retire(
    e: Entry,
    reason: RuntimeProblem | undefined,
    deleting: boolean,
  ) {
    return serial(e, async () => {
      if (!sessions || !e.revision) {
        contexts.forget(e.view.id);
        return false;
      }
      if (!deleting) {
        accepted(e, await sessions.disconnect(e.view.id, e.revision, reason));
        return true;
      }
      await erase(e.view.id, e.revision);
      e.revision = null;
      return false;
    });
  }
  function renew(
    e: Entry,
    refused: AuthCredential,
    signal?: AbortSignal,
    ahead = false,
  ): Promise<boolean> {
    const generation = e.generation;
    if (!eligible(e, generation) || !e.credentials)
      return Promise.resolve(false);
    // A replacement is already available. A renewal started ahead of its expiry
    // does not hold it back; one after its refusal does.
    if (e.credential !== refused && (!e.refresh || e.refresh === e.ahead))
      return Promise.resolve(true);
    if (!e.refresh) {
      const before = e.credentials;
      if (!before.refreshToken) {
        end(e, new RuntimeError('expired'));
        return Promise.resolve(false);
      }
      const operation = (async () => {
        let consumed = false;
        try {
          const pod = await discover(e.pod.podUrl, e.lifetime.signal);
          const claim = await serial(e, async () => {
            current(e, generation);
            if (!sessions || !e.revision) throw new RuntimeError('storage');
            const claimed = await sessions.claimRefresh(
              e.view.id,
              e.revision,
              binding(e, pod),
            );
            if (claimed.kind === 'conflict')
              throw new RuntimeError('disconnected');
            consumed = true;
            e.revision = claimed.revision;
            return claimed;
          });
          current(e, generation);
          // Erase a consumed refresh token from memory before the token
          // request; only the durable claim keeps it, for one resend.
          const withoutRefresh = { ...before };
          delete withoutRefresh.refreshToken;
          e.credentials = withoutRefresh;
          const sent = await sendRefresh(
            e,
            pod,
            before.refreshToken!,
            before.subject,
            before.scopes,
          );
          if (sent.kind === 'lost') {
            // Only for this generation: a newer sign-in or sign-out owns the
            // record now.
            current(e, generation);
            // The one resend publishes its own outcome, like at startup.
            await resumeLost(e, claim.sentAt);
            return eligible(e, generation) && e.view.session.kind === 'active';
          }
          await serial(e, async () => {
            current(e, generation);
            accepted(e, await claim.complete(sent.result));
          });
          current(e, generation);
          e.pod = pod;
          install(e, sent.result);
          return true;
        } catch (error) {
          if (eligible(e, generation)) {
            if (
              error instanceof OAuthError &&
              error.problem === 'invalid-client'
            )
              registry.clear(e.pod.podUrl);
            if (!consumed && transientBeforeClaim(error)) {
              // Nothing was spent and the cause may pass (offline or failing
              // discovery, storage that could not be written): stay signed in
              // with the unspent refresh token, so the next due or refused request can
              // try again without a reload. A changed binding or invalid
              // metadata ends the session below and needs a new sign-in.
              e.view = {
                ...e.view,
                session: Object.freeze({
                  kind: 'active',
                  subject: before.subject,
                }),
              };
              publish();
            } else end(e, error, consumed);
          }
          return false;
        } finally {
          if (e.generation === generation) delete e.refresh;
        }
      })();
      // Register the shared renewal before notifying subscribers: a read they
      // start in response joins it instead of starting another one.
      e.refresh = operation;
      if (ahead) e.ahead = operation;
      e.view = {
        ...e.view,
        session: Object.freeze({ kind: 'renewing', subject: before.subject }),
      };
      publish();
    } else if (!ahead && refused === e.credential) {
      // The Pod refused the current credential: later requests wait for the renewal.
      delete e.ahead;
    }
    return waitFor(e.refresh, e.lifetime.signal, signal).catch(() => false);
  }
  /**
   * Sends one refresh token request. A complete answer of the token endpoint
   * resolves `renewed` or rejects with its problem (a refusal, invalid claims).
   * Without one (no connection, a timeout, a cut-off body, a `5xx`, `408` or
   * `429`), the outcome is unknown: the Pod may have rotated the token, so
   * it resolves `lost`. A disconnect or dispose rejects.
   */
  async function sendRefresh(
    e: Entry,
    pod: PodDiscovery,
    refreshToken: string,
    subject: string,
    scopes: readonly string[],
    deadline?: number,
  ): Promise<Sent> {
    // The lifetime this request belongs to: a sign-in or sign-out replaces
    // `e.lifetime`, and its cancellation must not read as a lost answer.
    const lifetime = e.lifetime.signal;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new RuntimeError('interrupted')),
      TOKEN_TIMEOUT,
    );
    const signal = combineSignals(lifetime, timeout.signal);
    const send: NonNullable<typeof protocol.fetch> =
      protocol.fetch ?? ((url, init) => globalThis.fetch(url, init));
    let requested = false;
    let expired = false;
    let status: number | undefined;
    try {
      const result = await refreshAuthorization(
        { pod, client: e.client, scopes },
        refreshToken,
        subject,
        {
          ...protocol,
          fetch: async (url, init) => {
            // Checked at dispatch: the token stays unsent once the Pod would
            // treat it as reuse.
            if (deadline !== undefined && Date.now() >= deadline) {
              expired = true;
              throw new RuntimeError('interrupted');
            }
            requested = true;
            // Bounded also for a fetch that ignores its signal.
            const response = await waitFor(send(url, init), signal.signal);
            // Only a complete answer counts: a body cut off may have carried
            // the rotated token.
            await waitFor(response.clone().arrayBuffer(), signal.signal);
            status = response.status;
            return response;
          },
          signal: signal.signal,
        },
      );
      return { kind: 'renewed', result };
    } catch (error) {
      if (expired && !lifetime.aborted) throw new RuntimeError('interrupted');
      if (lifetime.aborted || !requested || !unanswered(status)) throw error;
      return { kind: 'lost' };
    } finally {
      clearTimeout(timer);
      signal.dispose();
    }
  }
  /**
   * Sends the one resend of a claimed refresh, recorded durably before it is
   * sent, and installs its result. A lost answer again rejects with
   * `interrupted`; a refusal with the server's problem.
   */
  async function resendRefresh(
    e: Entry,
    generation: string,
    pod: PodDiscovery,
    sentAt: number,
  ) {
    const claim = await serial(e, async () => {
      current(e, generation);
      // Checked again here and at dispatch: discovery, queued writes or the
      // durable resend record may take it past the grace period, when the
      // Pod would treat the resend as reuse.
      if (!withinGrace(sentAt)) throw new RuntimeError('interrupted');
      if (!sessions || !e.revision) throw new RuntimeError('storage');
      const claimed = await sessions.resendRefresh(
        e.view.id,
        e.revision,
        binding(e, pod),
      );
      if (claimed.kind === 'conflict') throw new RuntimeError('disconnected');
      e.revision = claimed.revision;
      return claimed;
    });
    current(e, generation);
    const sent = await sendRefresh(
      e,
      pod,
      claim.resend.refreshToken,
      claim.subject,
      claim.resend.scopes,
      sentAt + gracePeriod,
    );
    if (sent.kind === 'lost') throw new RuntimeError('interrupted');
    await serial(e, async () => {
      current(e, generation);
      accepted(e, await claim.complete(sent.result));
    });
    current(e, generation);
    e.pod = pod;
    install(e, sent.result);
  }
  /**
   * Offline after a lost answer, within the grace period: nothing is sent, the
   * connection is restorable and the resend waits for `online` or
   * `retryRestore(id)`. Once the grace period has passed it ends as
   * `interrupted`, keeping its address.
   */
  function suspend(
    e: Entry,
    generation: string,
    pod: PodDiscovery | undefined,
    sentAt: number,
  ) {
    // Bound handles stay current but lose access until the resend succeeds;
    // pending reads are invalidated. The durable claim and the catalogue stay.
    delete e.credential;
    invalidate(e);
    invalidatePod(e);
    invalidateContexts(e);
    const timer = setTimeout(
      () => {
        if (eligible(e, generation) && e.lost?.sentAt === sentAt) {
          delete e.lost;
          end(e, new RuntimeError('interrupted'));
        }
      },
      Math.min(MAX_DELAY, Math.max(0, sentAt + gracePeriod - Date.now())),
    );
    e.lifetime.signal.addEventListener('abort', () => clearTimeout(timer), {
      once: true,
    });
    e.lost = { generation, sentAt, timer, ...(pod ? { pod } : {}) };
    e.view = {
      ...e.view,
      session: Object.freeze({
        kind: 'ended',
        problem: 'network',
        restorable: true,
      }),
    };
    publish();
  }
  /**
   * Resends a refresh whose answer was lost, in this page or an earlier one;
   * publishes its own outcome. The Pod is rediscovered first (`pod` only when
   * a restorable connection already has it): that read probes the network, so
   * a connection that lost the answer does not lose the one resend too, and
   * an unreachable Pod waits within the grace period.
   */
  async function resumeLost(
    e: Entry,
    sentAt: number,
    pod?: PodDiscovery,
    resent = false,
  ): Promise<void> {
    const generation = e.generation;
    const events = onlineEvents;
    const wait = (pod?: PodDiscovery) => {
      suspend(e, generation, pod, sentAt);
      // The browser came back online meanwhile: try once more now.
      if (onlineEvents !== events) void retryRestore(e);
    };
    try {
      if (resent || !withinGrace(sentAt)) throw new RuntimeError('interrupted');
      if (!pod) {
        // The probe ends with the grace period, also for a fetch that ignores
        // its signal: beyond it, nothing can be resent.
        const grace = new AbortController();
        const timer = setTimeout(
          () => grace.abort(new RuntimeError('interrupted')),
          Math.min(MAX_DELAY, Math.max(0, sentAt + gracePeriod - Date.now())),
        );
        const signal = combineSignals(e.lifetime.signal, grace.signal);
        try {
          // Also within the discovery deadline: a shorter grace period wins.
          pod = await discover(e.pod.podUrl, signal.signal);
        } catch (error) {
          if (grace.signal.aborted && !e.lifetime.signal.aborted)
            throw new RuntimeError('interrupted');
          // An unreachable Pod spends nothing: wait within the grace period.
          if (eligible(e, generation) && transientBeforeClaim(error)) {
            wait();
            return;
          }
          throw error;
        } finally {
          clearTimeout(timer);
          signal.dispose();
        }
      }
      current(e, generation);
      if (offline()) {
        wait(pod);
        return;
      }
      await resendRefresh(e, generation, pod, sentAt);
    } catch (error) {
      if (!eligible(e, generation)) return;
      if (error instanceof OAuthError && error.problem === 'invalid-client')
        registry.clear(e.pod.podUrl);
      end(e, error);
    }
  }
  /**
   * Renews ahead of the credential's own expiry, so dispatch does not depend on
   * the Pod's 401 challenge. Due within a minute of `expiresAt` (half the
   * lifetime for short tokens). Until it expires, the current credential is
   * still sent while the renewal runs. Without a refresh token it is sent until
   * it expires; an expired one ends the session (`expired`).
   */
  function renewBeforeExpiry(e: Entry) {
    const credentials = e.credentials;
    if (e.refresh || !e.credential || !credentials) return;
    const now = Date.now();
    const lifetime = credentials.expiresAt - credentials.receivedAt;
    const margin = Math.min(RENEWAL_MARGIN, Math.max(lifetime, 0) / 2);
    if (now < credentials.expiresAt - margin) return;
    if (!credentials.refreshToken && now < credentials.expiresAt) return;
    void renew(e, e.credential, undefined, true);
  }
  function createEntry(
    pod: PodDiscovery,
    client: OAuthClient,
    id: string = crypto.randomUUID(),
    generation: string = crypto.randomUUID(),
  ): Entry {
    const data: Omit<Entry, 'clientPod' | 'auth'> = {
      pod,
      client,
      generation,
      lifetime: new AbortController(),
      reads: new AbortController(),
      podReads: new AbortController(),
      podEpoch: 0,
      revision: null,
      persistence: Promise.resolve(),
      epoch: 0,
      selectedVersion: 0,
      view: {
        id,
        podUrl: pod.podUrl,
        clientKind: client.kind,
        session: Object.freeze({ kind: 'signed-out' }),
        catalogue: Object.freeze({ kind: 'unknown' }),
        requestedScopes: requested,
        requiredScopes: required,
        optionalScopes: optional,
        grantedScopes: Object.freeze([]),
        missingRequiredScopes: required,
        selectedContext: null,
      },
    };
    const auth: Entry['auth'] = {
      async credential(request) {
        assertCredentialRecipient(e.pod.podUrl, request.url);
        // A replacement can itself be due once the wait ends (a slow commit, a
        // suspended tab): check each new credential again, a bounded number of times.
        let checked: AuthCredential | undefined;
        for (
          let round = 0;
          round < RENEWAL_ROUNDS && eligible(e) && e.credential !== checked;
          round++
        ) {
          checked = e.credential;
          renewBeforeExpiry(e);
          // Wait for a renewal after a refusal, or once the credential expired.
          if (
            e.refresh &&
            !(
              e.refresh === e.ahead &&
              e.credentials &&
              Date.now() < e.credentials.expiresAt
            )
          )
            await waitFor(e.refresh, e.lifetime.signal, request.signal);
        }
        if (!eligible(e) || !e.credential)
          throw new RuntimeError('disconnected');
        return e.credential;
      },
      renew: (refused, challenge) => renew(e, refused, challenge.signal),
    };
    const e: Entry = {
      ...data,
      auth,
      clientPod: (options.podFactory ?? createPod)(pod.podUrl, {
        ...protocol,
        beforeDispatch: () => eligible(e) && e.credential !== undefined,
        auth,
      }),
    };
    return e;
  }
  function get(id: string) {
    const entry = entries.get(id);
    if (!entry) throw new RuntimeError('disconnected');
    return entry;
  }
  function ready(e: Entry) {
    if (!eligible(e) || !e.credentials) throw new RuntimeError('disconnected');
  }
  function load(e: Entry) {
    return loadCatalogue(e, {
      eligible,
      invalidate,
      invalidateContext: invalidateContexts,
      publish,
      remembered: (entry) =>
        (entry.view.podUrl === preset?.podUrl
          ? preset.contextIri
          : undefined) ?? contexts.recall(entry.view.id),
    });
  }
  function forbidden(e: Entry) {
    if (!e.revalidation) {
      const operation = load(e)
        .then(
          () => {},
          () => {},
        )
        .finally(() => {
          if (e.revalidation === operation) delete e.revalidation;
        });
      e.revalidation = operation;
    }
    return e.revalidation;
  }

  /** Counts the browser's `online` events, so a restoration knows it missed one. */
  let onlineEvents = 0;
  /** Restores one saved signed-in Pod; publishes its own outcome (`active`/`ended`). */
  async function restore(
    e: Entry,
    saved: Extract<SessionRecord, { kind: 'ready' }>,
  ) {
    const generation = e.generation;
    const events = onlineEvents;
    try {
      const pod = await discover(e.pod.podUrl, e.lifetime.signal);
      current(e, generation);
      assertSessionBinding(saved.binding, binding(e, pod));
      e.pod = pod;
      install(e, saved.credentials);
    } catch (error) {
      if (eligible(e, generation)) {
        // An unreachable or failing Pod is not a logout: the saved session
        // stays and is restored again, also once the browser is back online.
        const restorable = transientBeforeClaim(error);
        if (restorable) e.restorable = saved;
        e.view = {
          ...e.view,
          session: Object.freeze({
            kind: 'ended',
            problem: runtimeProblem(error),
            ...runtimeFailure(error),
            ...(restorable ? { restorable: true as const } : {}),
          }),
        };
        publish();
        // The browser came back online while this attempt was under way: its
        // retry found the session still restoring, so try once more now.
        if (restorable && onlineEvents !== events) void retryRestore(e);
      }
    }
  }
  /** Restores a session whose restoration found its Pod unreachable; no-op otherwise. */
  async function retryRestore(e: Entry) {
    const saved = e.restorable;
    const lost = e.lost;
    const session = e.view.session;
    if (session.kind !== 'ended' || !session.restorable) return;
    if (lost && eligible(e, lost.generation)) {
      // Offline still: keep the one resend for later.
      if (offline() && withinGrace(lost.sentAt)) return;
      clearTimeout(lost.timer);
      delete e.lost;
      e.view = { ...e.view, session: Object.freeze({ kind: 'restoring' }) };
      publish();
      await resumeLost(e, lost.sentAt, lost.pod);
      return;
    }
    if (!saved) return;
    delete e.restorable;
    e.view = { ...e.view, session: Object.freeze({ kind: 'restoring' }) };
    publish();
    await restore(e, saved);
  }
  // Coming back online restores every session that could not reach its Pod.
  const page = globalThis as {
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  const online = () => {
    onlineEvents++;
    for (const e of entries.values()) void retryRestore(e);
  };
  page.addEventListener?.('online', online);
  /**
   * Resumes the session a denied (`callback`) or abandoned re-authorization
   * started from, and publishes it. Returns false, changing nothing, when the
   * stored attempt is not eligible (see the `resume` transition).
   */
  async function resume(e: Entry, callback?: URL): Promise<boolean> {
    const generation = e.generation;
    const pod = await discover(e.pod.podUrl, e.lifetime.signal);
    const change = await serial(e, async () => {
      current(e, generation);
      if (!sessions || !e.revision) throw new RuntimeError('storage');
      let result: SessionChange;
      try {
        result = await sessions.resume(e.view.id, e.revision, pod, callback);
      } catch (error) {
        if (
          error instanceof SessionTransitionError &&
          error.problem === 'state'
        )
          return undefined;
        throw error;
      }
      // Recorded first, so a disconnect queued during the commit retires
      // the resumed record rather than conflicting with it.
      accepted(e, result);
      current(e, generation);
      return result;
    });
    if (!change) return false;
    current(e, generation);
    if (change.kind !== 'committed' || change.record.value.kind !== 'ready')
      throw new RuntimeError('state');
    const { binding: resumed, credentials } = change.record.value;
    e.pod = pod;
    e.client = resumed.client;
    e.view = { ...e.view, requestedScopes: resumed.scopes };
    install(e, credentials);
    // A catalogue read the leaving page aborted starts again, keeping the
    // contexts it already confirmed.
    if (e.view.catalogue.kind === 'loading' && !e.catalogue)
      void load(e).catch(() => {});
    return true;
  }
  /**
   * A page restored from the back/forward cache comes back without a startup:
   * an abandoned re-authorization resumes its earlier session there too, and a
   * first sign-in shows its interruption.
   */
  function watchReturn(e: Entry, generation: string) {
    const page = globalThis as {
      addEventListener?: (
        type: string,
        listener: (event: Event) => void,
      ) => void;
      removeEventListener?: (
        type: string,
        listener: (event: Event) => void,
      ) => void;
    };
    if (!page.addEventListener || !page.removeEventListener) return;
    const stop = () => page.removeEventListener!('pageshow', shown);
    function shown(event: Event) {
      if (!(event as Event & { persisted?: boolean }).persisted) return;
      stop();
      if (eligible(e, generation) && e.view.session.kind === 'leaving') {
        e.view = { ...e.view, session: Object.freeze({ kind: 'restoring' }) };
        publish();
        void resumeAbandoned(e, 'interrupted');
      }
    }
    page.addEventListener('pageshow', shown);
    e.lifetime.signal.addEventListener('abort', stop, { once: true });
  }
  /** Resumes an abandoned re-authorization at startup; publishes its own outcome. */
  async function resumeAbandoned(e: Entry, ineligible: RuntimeProblem) {
    const generation = e.generation;
    let problem: RuntimeProblem = ineligible;
    let cause: unknown;
    try {
      if (await resume(e)) return;
    } catch (error) {
      problem = runtimeProblem(error);
      cause = error;
    }
    if (eligible(e, generation)) setEnded(e, problem, cause);
  }
  function setEnded(e: Entry, problem: RuntimeProblem, cause?: unknown) {
    e.view = {
      ...e.view,
      session: Object.freeze({
        kind: 'ended',
        problem,
        ...runtimeFailure(cause),
      }),
    };
    publish();
  }
  /** Redeems the callback's code once for its stored attempt; returns the connection. */
  async function redeem(
    id: string,
    revision: string,
    location: URL,
    destination: string,
    /** A re-authorization: its failure ends the session it started from. */
    hadSession: boolean,
  ): Promise<string> {
    const e = get(id);
    const generation = e.generation;
    const pod = await discover(e.pod.podUrl, e.lifetime.signal);
    const claim = await serial(e, async () => {
      current(e, generation);
      const c = await sessions!.claimCode(
        e.view.id,
        revision,
        binding(e, pod),
        location,
      );
      if (c.kind === 'conflict') throw new RuntimeError('attempt');
      e.revision = c.revision;
      return c;
    });
    current(e, generation);
    (
      options.replaceUrl ??
      ((url) => window.history.replaceState(null, '', url))
    )(destination);
    try {
      const result = await exchangeAuthorization(
        claim.attempt,
        location,
        protocol,
      );
      await serial(e, async () => {
        current(e, generation);
        accepted(e, await claim.complete(result));
      });
      current(e, generation);
      install(e, result);
      return e.view.id;
    } catch (error) {
      if (eligible(e, generation)) {
        if (error instanceof OAuthError && error.problem === 'invalid-client')
          registry.clear(e.pod.podUrl);
        end(e, error, true, hadSession);
        await e.persistence;
      }
      throw error;
    }
  }
  async function bootstrap(): Promise<StartupReport> {
    let report: StartupReport = {
      interaction: 'none',
      storage: 'unavailable',
      unreadable: [],
    };
    let callback = false;
    let attempted: string | undefined;
    // A callback without a matching attempt never calls a function form: on
    // the callback route it would name the callback itself.
    let destination = fixedReturnTo ?? '/';
    try {
      const location = new URL(
        (options.location ?? (() => window.location.href))(),
      );
      if (location.origin !== redirect.origin)
        throw new RuntimeError('configuration');
      callback = location.pathname === redirect.pathname;
      lease = await acquireSessionLease(
        namespace,
        options.locks === undefined
          ? globalThis.navigator?.locks
          : options.locks,
        () =>
          options.openStore
            ? options.openStore(namespace)
            : openSessionStore(namespace),
      );
      if (disposed) {
        lease.close();
        throw new RuntimeError('disconnected');
      }
      sessions = createSessionTransitions(lease.store, {
        configKey: namespace,
        redirectUri: identity.redirectUri,
        ...protocol,
      });
      const listing = await sessions.list();
      report = {
        ...report,
        storage: 'durable',
        unreadable: Object.freeze(listing.unreadable),
      };
      if (disposed) throw new RuntimeError('disconnected');
      let pending: SessionSnapshot | undefined;
      const abandoned: { e: Entry; problem: RuntimeProblem }[] = [];
      /** Refreshes an earlier page sent without an answer, resent once below. */
      const lost: { e: Entry; resend: RefreshResend }[] = [];
      /** Addresses an earlier start remembered, deleted under `rememberPods: false`. */
      const forgotten: SessionSnapshot[] = [];
      for (const saved of listing.records) {
        const b = sessionBinding(saved.value);
        // Find the callback even when its Pod is excluded. Reject it below without
        // discovery, code claim or mutation of the foreign durable record.
        if (
          callback &&
          saved.value.kind === 'authorizing' &&
          location.searchParams.getAll('state').length === 1 &&
          location.searchParams.get('state') === saved.value.attempt.state
        ) {
          if (pending) throw new RuntimeError('attempt');
          pending = saved;
        }
        if (!allows(b.pod.podUrl)) continue;
        if (saved.value.kind === 'disconnected' && !rememberPods) {
          forgotten.push(saved);
          continue;
        }
        const e = createEntry(b.pod, b.client, saved.id, b.generation);
        e.revision = saved.revision;
        if (saved.value.kind === 'disconnected') {
          // A retired record holds only the address (binding) and why its
          // session ended: a remembered Pod, signed out.
          const ended = knownProblem(saved.value.reason);
          if (ended)
            e.view = {
              ...e.view,
              session: Object.freeze({ kind: 'signed-out', problem: ended }),
            };
          entries.set(saved.id, e);
          continue;
        }
        const problem =
          saved.value.kind === 'authorizing' &&
          saved.value.attempt.expiresAt <= Date.now()
            ? 'expired'
            : 'interrupted';
        // A re-authorization the person left without a callback (back
        // navigation, an abandoned attempt) resumes the session it started
        // from; a denial on the callback route does so below. On the callback
        // route no other attempt is touched: a callback with a missing or
        // wrong state must not consume one whose real callback may follow.
        const resumes =
          saved.value.kind === 'authorizing' &&
          saved.value.previous !== undefined &&
          (!callback ||
            (pending === saved &&
              location.searchParams.has('error') &&
              !location.searchParams.has('code')));
        if (resumes && !callback) abandoned.push({ e, problem });
        // A refresh claim of SDK 0.8 keeps its token: resent once below
        // within the grace period, or ended as `interrupted` otherwise.
        const resend =
          saved.value.kind === 'claimed' ? saved.value.resend : undefined;
        if (resend) lost.push({ e, resend });
        e.view = {
          ...e.view,
          requestedScopes: b.scopes,
          requiredScopes: required,
          optionalScopes: optional,
          session: Object.freeze(
            saved.value.kind === 'ready' || resumes || resend
              ? { kind: 'restoring' }
              : { kind: 'ended', problem },
          ),
        };
        entries.set(saved.id, e);
      }
      publish();
      // Best effort: a record left by a failed deletion is deleted next time.
      for (const saved of forgotten)
        void erase(saved.id, saved.revision).catch(() => {});
      const restoring = Promise.all(
        listing.records.map((saved) => {
          const e = entries.get(saved.id);
          return e && saved.value.kind === 'ready'
            ? restore(e, saved.value)
            : undefined;
        }),
      );
      for (const { e, problem } of abandoned) void resumeAbandoned(e, problem);
      for (const { e, resend } of lost)
        void resumeLost(e, resend.sentAt, undefined, resend.resent);
      // Restoration publishes per connection (`restoring` → `active`/`ended`).
      // Neither the startup report nor a callback waits for another Pod, so
      // one Pod whose discovery never settles cannot hold the app open.
      void restoring;
      if (disposed) throw new RuntimeError('disconnected');
      initialized = true;
      if (!callback) return report;
      if (!pending || pending.value.kind !== 'authorizing')
        throw new RuntimeError('attempt');
      destination = pending.value.attempt.returnTo;
      if (!allows(sessionBinding(pending.value).pod.podUrl))
        throw new RuntimeError('configuration');
      attempted = pending.id;
      const returning = entries.get(pending.id);
      if (returning?.view.session.kind === 'restoring') {
        let resumed = false;
        try {
          resumed = await resume(returning, location);
        } finally {
          if (!resumed && eligible(returning))
            setEnded(returning, 'interrupted');
        }
        if (resumed) {
          const denial = new OAuthError('denied');
          return {
            ...report,
            interaction: 'cancelled',
            attemptConnectionId: pending.id,
            resumed: true,
            problem: runtimeProblem(denial),
            ...runtimeFailure(denial),
          };
        }
        // Not eligible (another answer, an expired earlier session, a changed
        // binding): the callback ends the connection as for a first sign-in.
      }
      const connectionId = await redeem(
        pending.id,
        pending.revision,
        location,
        destination,
        pending.value.previous !== undefined,
      );
      return { ...report, interaction: 'completed', connectionId };
    } catch (error) {
      const problem = runtimeProblem(error);
      if (!initialized) {
        lease?.close();
        lease = undefined;
        sessions = undefined;
      }
      return {
        ...report,
        // Without a callback there was no sign-in to fail; storage and
        // problem carry the startup failure.
        interaction: !callback
          ? 'none'
          : problem === 'denied'
            ? 'cancelled'
            : 'failed',
        storage: problem === 'busy' ? 'busy' : report.storage,
        ...(attempted && entries.has(attempted)
          ? { attemptConnectionId: attempted }
          : {}),
        problem,
        ...runtimeFailure(error),
      };
    } finally {
      if (callback && !disposed)
        (
          options.replaceUrl ??
          ((url) => window.history.replaceState(null, '', url))
        )(destination);
    }
  }
  /**
   * Signs out (`disconnect`) or forgets a connection (`forgetting`): blocks it
   * locally at once, then retires its record, keeping the address unless
   * `rememberPods` is false, or deletes it. A connection without a record
   * afterwards leaves the snapshot.
   */
  function leave(id: string, forgetting: boolean): Promise<DisconnectResult> {
    if (disposed || !sessions)
      return Promise.reject(new RuntimeError('configuration'));
    // A forget that could not be saved stays a forget, also when retried as a
    // sign-out, so the address is not kept against the person's choice.
    const forget = forgetting || entries.get(id)?.forgetting === true;
    const deleting = forget || !rememberPods;
    const marked = forget ? { forget: true as const } : {};
    const pending = disconnects.get(id);
    if (pending) {
      if (!deleting || pending.erase) return pending.operation;
      // A forget asked during a sign-out deletes the record once that
      // settled. It counts as pending meanwhile, so neither a connect nor a
      // sign-in reuses the connection in between.
      const chained: Promise<DisconnectResult> = pending.operation.then(() => {
        if (disconnects.get(id)?.operation === chained) disconnects.delete(id);
        return entries.has(id) ? leave(id, true) : { kind: 'disconnected' };
      });
      disconnects.set(id, { erase: true, operation: chained });
      return chained;
    }
    const e = get(id);
    if (forget) e.forgetting = true;
    // Register before abort/notifications so reentrant callers see the retirement.
    const operation = retire(e, 'disconnected', deleting)
      .then(
        (kept) => {
          if (entries.get(id) === e) {
            if (kept)
              e.view = {
                ...e.view,
                session: Object.freeze({
                  kind: 'signed-out',
                  problem: 'disconnected',
                }),
              };
            else entries.delete(id);
          }
          publish();
          return { kind: 'disconnected' as const };
        },
        () => {
          if (!disposed && entries.get(id) === e) {
            e.view = {
              ...e.view,
              session: Object.freeze({
                kind: 'ended',
                problem: 'disconnected',
                saved: false,
                ...marked,
              }),
            };
            publish();
          }
          return { kind: 'blocked-locally' as const };
        },
      )
      .finally(() => {
        // A forget chained to this sign-out may hold the entry already.
        if (disconnects.get(id)?.operation === operation)
          disconnects.delete(id);
      });
    disconnects.set(id, { erase: deleting, operation });
    delete e.credentials;
    delete e.credential;
    e.lifetime.abort();
    invalidate(e);
    invalidatePod(e);
    invalidateContexts(e);
    resetLabels(e);
    delete e.boundPod;
    delete e.explicit;
    delete e.observations;
    e.view = {
      ...e.view,
      session: Object.freeze({
        kind: 'ended',
        problem: 'disconnected',
        // A retry has not yet removed the saved session or its failure fact.
        ...(e.view.session.kind === 'ended' && e.view.session.saved === false
          ? { saved: false as const }
          : {}),
        ...marked,
      }),
      catalogue: Object.freeze({ kind: 'unknown' }),
      selectedContext: null,
      grantedScopes: Object.freeze([]),
      missingRequiredScopes: required,
    };
    publish();
    return operation;
  }
  return {
    ...(preset ? { preset } : {}),
    ...(allowedPods ? { allowedPods } : {}),
    initialize() {
      // A disposed runtime processes no callback, so there is no sign-in outcome.
      if (disposed)
        return Promise.resolve({
          interaction: 'none',
          storage: 'unavailable',
          problem: 'disconnected',
          unreadable: [],
        });
      startup ??= bootstrap();
      return startup;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async connect(url = defaultPodUrl) {
      if (!initialized || disposed || url === undefined || !allows(url))
        throw new RuntimeError('configuration');
      const matchesDefault = url === defaultPodUrl;
      if (matchesDefault) {
        for (;;) {
          const existing = [...entries.values()].find(
            (e) => e.view.podUrl === url,
          );
          const pending = existing && disconnects.get(existing.view.id);
          if (!pending) {
            if (existing) return existing.view;
            break;
          }
          const result = await pending.operation;
          if (disposed) throw new RuntimeError('disconnected');
          if (result.kind === 'blocked-locally')
            throw new RuntimeError('storage');
          // Re-read after retirement: another connect may already have replaced it.
        }
        if (connectingDefault) return connectingDefault;
      }
      const operation = (async () => {
        const pod = await discover(url);
        const client = await registry.resolve(pod, identity);
        if (disposed) throw new RuntimeError('disconnected');
        const e = createEntry(pod, client);
        entries.set(e.view.id, e);
        publish();
        return e.view;
      })();
      if (matchesDefault) connectingDefault = operation;
      try {
        return await operation;
      } finally {
        if (connectingDefault === operation) connectingDefault = undefined;
      }
    },
    async beginAuthorization(id) {
      if (!initialized || disposed) throw new RuntimeError('configuration');
      const e = get(id);
      // An ended session has no live lifetime left. Preparing needs a fresh
      // one (and generation, so no operation of the ended one revives), which
      // a later disconnect or dispose cancels like any other.
      if (e.lifetime.signal.aborted) {
        if (disconnects.has(id)) throw new RuntimeError('disconnected');
        e.lifetime = new AbortController();
        e.generation = crypto.randomUUID();
      }
      // An unsafe return address rejects before any request or change.
      const destination = returnTo();
      // Prepare while the current session keeps working: if discovery,
      // registration or persisting the attempt fails, nothing was reset.
      const before = e.generation;
      const signal = e.lifetime.signal;
      const pod = await discover(e.pod.podUrl, signal);
      current(e, before);
      const client = await registry.resolve(pod, identity, { signal });
      current(e, before);
      const generation = crypto.randomUUID();
      const { attempt, url } = await prepareSessionAuthorization(
        {
          configKey: namespace,
          connectionId: e.view.id,
          generation,
          pod,
          client,
          returnTo: destination,
          scopes: requested,
        },
        Date.now(),
        options.development,
      );
      await serial(e, async () => {
        current(e, before);
        accepted(e, await sessions!.prepare(attempt, e.revision));
        // The revision is recorded first, so a disconnect that ran during the
        // commit retires the new attempt; this lifetime must not continue.
        current(e, before);
        // Committed durably: switch to the new lifetime in the same step, so no
        // queued refresh of the old one can act on the replaced record. The
        // facts stay for display until the page leaves; only the session says
        // that nothing of the earlier one dispatches any more.
        const shown = e.view;
        const subject =
          shown.session.kind === 'active' ||
          shown.session.kind === 'renewing' ||
          shown.session.kind === 'leaving'
            ? shown.session.subject
            : undefined;
        e.lifetime.abort();
        e.lifetime = new AbortController();
        e.generation = generation;
        e.pod = pod;
        e.client = client;
        // Signing in again replaces a forget that could not be saved.
        delete e.forgetting;
        delete e.credentials;
        delete e.credential;
        delete e.bound;
        delete e.boundPod;
        delete e.explicit;
        delete e.observations;
        delete e.refresh;
        delete e.lost;
        delete e.catalogue;
        delete e.revalidation;
        invalidate(e);
        invalidatePod(e);
        invalidateContexts(e);
        resetLabels(e);
        e.selectedVersion++;
        e.view = {
          ...shown,
          session: Object.freeze(
            subject === undefined
              ? { kind: 'leaving' }
              : { kind: 'leaving', subject },
          ),
        };
        publish();
      });
      current(e, generation);
      watchReturn(e, generation);
      (options.navigate ?? ((url) => window.location.assign(url)))(url);
    },
    disconnect(id) {
      return leave(id, false);
    },
    forget(id) {
      return leave(id, true);
    },
    async loadContexts(id, { signal } = {}) {
      const e = get(id);
      ready(e);
      const generation = e.generation;
      try {
        const result = await waitFor(load(e), e.lifetime.signal, signal);
        if (signal?.aborted) return { kind: 'cancelled' };
        if (!eligible(e, generation)) return { kind: 'invalidated' };
        return result.kind === 'stopped' ? { kind: 'invalidated' } : result;
      } catch (error) {
        if (signal?.aborted) return { kind: 'cancelled' };
        if (!eligible(e, generation)) return { kind: 'invalidated' };
        throw error;
      }
    },
    async loadContextLabels(id, iris) {
      const e = get(id);
      ready(e);
      return loadContextLabels(e, { eligible, publish }, iris);
    },
    selectContext(id, iri) {
      const e = get(id);
      ready(e);
      if (
        e.view.podUrl === preset?.podUrl &&
        preset.contextIri !== undefined &&
        iri !== preset.contextIri
      )
        throw new RuntimeError('configuration');
      if (
        e.view.catalogue.kind !== 'ready' ||
        !e.view.catalogue.contexts.some((c) => c.iri === iri && c.readable)
      )
        throw new RuntimeError('configuration');
      contexts.remember(id, iri);
      if (e.view.selectedContext === iri) {
        loadSelectedLabel(e, { eligible, publish });
        return;
      }
      e.view = { ...e.view, selectedContext: iri };
      e.selectedVersion++;
      invalidate(e);
      delete e.bound;
      publish();
      loadSelectedLabel(e, { eligible, publish });
    },
    bindPod(id) {
      const e = get(id);
      ready(e);
      e.boundPod ??= bindPod(
        e,
        () => eligible(e),
        (guard) =>
          (options.podFactory ?? createPod)(e.pod.podUrl, {
            ...protocol,
            auth: e.auth,
            beforeDispatch: guard,
          }),
        (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      );
      return e.boundPod;
    },
    bind(id) {
      const e = get(id);
      ready(e);
      if (!e.view.selectedContext) throw new RuntimeError('configuration');
      e.bound ??= bindView(
        e,
        selectedTarget(e),
        () => eligible(e),
        () => forbidden(e),
        subscribe,
      );
      return e.bound;
    },
    bindContext(id, contextIri) {
      const e = get(id);
      ready(e);
      if (!isContextIri(contextIri, e.pod.podUrl))
        throw new RuntimeError('configuration');
      // An exact preset is the app's only write target on its Pod.
      if (
        e.view.podUrl === preset?.podUrl &&
        preset.contextIri !== undefined &&
        contextIri !== preset.contextIri
      )
        throw new RuntimeError('configuration');
      e.explicit ??= new Map();
      let view = e.explicit.get(contextIri);
      if (!view)
        e.explicit.set(
          contextIri,
          (view = bindView(
            e,
            explicitTarget(e, contextIri),
            () => eligible(e),
            () => forbidden(e),
            subscribe,
          )),
        );
      return view;
    },
    async retryRestore(id) {
      await retryRestore(get(id));
    },
    dispose() {
      disposed = true;
      initialized = false;
      page.removeEventListener?.('online', online);
      for (const e of entries.values()) {
        delete e.credentials;
        delete e.credential;
        e.lifetime.abort();
        invalidate(e);
        invalidatePod(e);
        invalidateContexts(e);
        resetLabels(e);
        delete e.boundPod;
        delete e.explicit;
        delete e.observations;
      }
      entries.clear();
      lease?.close();
      publish();
      listeners.clear();
      snapshot = Object.freeze([]);
    },
  };
}
