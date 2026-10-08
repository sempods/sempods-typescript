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
  type SessionRecord,
  type SessionSnapshot,
} from '../sessions/records.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
  Connection,
  StartupReport,
} from './types.js';
import {
  RuntimeError,
  runtimeProblem,
  runtimeFailure,
  transientBeforeClaim,
} from './errors.js';
import { waitFor } from './wait.js';
import { bindView } from './binding.js';
import { bindPod } from './pod-binding.js';
import { loadCatalogue, loadSelectedLabel, resetLabels } from './catalogue.js';
import { browserPreferences, createContextMemory } from './context-memory.js';

import { assertCredentialRecipient, type Entry } from './connection.js';

/** How long before its expiry a credential is renewed before dispatch. */
const RENEWAL_MARGIN = 60_000;
/** How often one dispatch checks a replacement credential before using it. */
const RENEWAL_ROUNDS = 3;

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
  const returnTo = safeReturnTo(options.returnTo ?? '/', identity.redirectUri);
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
    Promise<{ kind: 'disconnected' | 'blocked-locally' }>
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
      resetLabels(e);
      if (previousSubject !== result.subject) {
        delete e.boundPod;
        delete e.bound;
      }
    }
    publish();
    loadSelectedLabel(e, { eligible, publish });
  }
  function end(e: Entry, error: unknown, retireRecord = true) {
    delete e.credentials;
    delete e.credential;
    invalidate(e);
    invalidatePod(e);
    resetLabels(e);
    delete e.boundPod;
    e.lifetime.abort(new RuntimeError('disconnected'));
    e.view = {
      ...e.view,
      session: Object.freeze({
        kind: 'ended',
        problem: runtimeProblem(error),
        ...runtimeFailure(error),
      }),
      catalogue: Object.freeze({ kind: 'unknown' }),
      grantedScopes: Object.freeze([]),
      missingRequiredScopes: required,
    };
    publish();
    if (!retireRecord) return;
    void retire(e).catch(() => {
      if (entries.get(e.view.id) === e) {
        e.view = {
          ...e.view,
          session: Object.freeze({ kind: 'ended', problem: 'storage' }),
        };
        publish();
      }
    });
  }
  function retire(e: Entry) {
    return serial(e, async () => {
      if (sessions && e.revision)
        accepted(e, await sessions.disconnect(e.view.id, e.revision));
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
          const pod = await discoverPod(e.pod.podUrl, {
            ...protocol,
            signal: e.lifetime.signal,
          });
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
          // Erase a consumed refresh token from memory before the token request.
          const withoutRefresh = { ...before };
          delete withoutRefresh.refreshToken;
          e.credentials = withoutRefresh;
          const result = await refreshAuthorization(
            { pod, client: e.client, scopes: before.scopes },
            before.refreshToken!,
            before.subject,
            { ...protocol, signal: e.lifetime.signal },
          );
          await serial(e, async () => {
            current(e, generation);
            accepted(e, await claim.complete(result));
          });
          current(e, generation);
          e.pod = pod;
          install(e, result);
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

  /** Restores one saved signed-in Pod; publishes its own outcome (`active`/`ended`). */
  async function restore(
    e: Entry,
    saved: Extract<SessionRecord, { kind: 'ready' }>,
  ) {
    const generation = e.generation;
    try {
      const pod = await discoverPod(e.pod.podUrl, {
        ...protocol,
        signal: e.lifetime.signal,
      });
      current(e, generation);
      assertSessionBinding(saved.binding, binding(e, pod));
      e.pod = pod;
      install(e, saved.credentials);
    } catch (error) {
      if (eligible(e, generation)) {
        e.view = {
          ...e.view,
          session: Object.freeze({
            kind: 'ended',
            problem: runtimeProblem(error),
            ...runtimeFailure(error),
          }),
        };
        publish();
      }
    }
  }
  /** Redeems the callback's code once for its stored attempt; returns the connection. */
  async function redeem(
    id: string,
    revision: string,
    location: URL,
    destination: string,
  ): Promise<string> {
    const e = get(id);
    const generation = e.generation;
    const pod = await discoverPod(e.pod.podUrl, {
      ...protocol,
      signal: e.lifetime.signal,
    });
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
        end(e, error);
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
    let destination = returnTo;
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
      for (const saved of listing.records) {
        if (saved.value.kind === 'disconnected') continue;
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
        const e = createEntry(b.pod, b.client, saved.id, b.generation);
        e.revision = saved.revision;
        e.view = {
          ...e.view,
          requestedScopes: b.scopes,
          requiredScopes: required,
          optionalScopes: optional,
          session: Object.freeze(
            saved.value.kind === 'ready'
              ? { kind: 'restoring' }
              : {
                  kind: 'ended',
                  problem:
                    saved.value.kind === 'authorizing' &&
                    saved.value.attempt.expiresAt <= Date.now()
                      ? 'expired'
                      : 'interrupted',
                },
          ),
        };
        entries.set(saved.id, e);
      }
      publish();
      const restoring = Promise.all(
        listing.records.map((saved) => {
          const e = entries.get(saved.id);
          return e && saved.value.kind === 'ready'
            ? restore(e, saved.value)
            : undefined;
        }),
      );
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
      const connectionId = await redeem(
        pending.id,
        pending.revision,
        location,
        destination,
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
  return {
    ...(preset ? { preset } : {}),
    ...(allowedPods ? { allowedPods } : {}),
    initialize() {
      if (disposed)
        return Promise.resolve({
          interaction: 'failed',
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
          const result = await pending;
          if (disposed) throw new RuntimeError('disconnected');
          if (result.kind === 'blocked-locally')
            throw new RuntimeError('storage');
          // Re-read after retirement: another connect may already have replaced it.
        }
        if (connectingDefault) return connectingDefault;
      }
      const operation = (async () => {
        const pod = await discoverPod(url, protocol);
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
      // Prepare while the current session keeps working: if discovery,
      // registration or persisting the attempt fails, nothing was reset.
      const before = e.generation;
      const signal = e.lifetime.signal;
      const pod = await discoverPod(e.pod.podUrl, { ...protocol, signal });
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
          returnTo,
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
        // queued refresh of the old one can act on the replaced record.
        e.lifetime.abort();
        e.lifetime = new AbortController();
        e.generation = generation;
        e.pod = pod;
        e.client = client;
        delete e.credentials;
        delete e.credential;
        delete e.bound;
        delete e.boundPod;
        delete e.refresh;
        delete e.catalogue;
        delete e.revalidation;
        invalidate(e);
        invalidatePod(e);
        resetLabels(e);
        e.selectedVersion++;
        e.view = {
          ...e.view,
          session: Object.freeze({ kind: 'signed-out' }),
          catalogue: Object.freeze({ kind: 'unknown' }),
          selectedContext: null,
          grantedScopes: Object.freeze([]),
          missingRequiredScopes: required,
          requestedScopes: requested,
          requiredScopes: required,
          optionalScopes: optional,
        };
        publish();
      });
      current(e, generation);
      (options.navigate ?? ((url) => window.location.assign(url)))(url);
    },
    disconnect(id) {
      if (disposed || !sessions)
        return Promise.reject(new RuntimeError('configuration'));
      const pending = disconnects.get(id);
      if (pending) return pending;
      const e = get(id);
      // Register before abort/notifications so reentrant callers see the retirement.
      const operation = retire(e)
        .then(
          () => {
            if (entries.get(id) === e) entries.delete(id);
            contexts.forget(id);
            publish();
            return { kind: 'disconnected' as const };
          },
          () => ({ kind: 'blocked-locally' as const }),
        )
        .finally(() => disconnects.delete(id));
      disconnects.set(id, operation);
      delete e.credentials;
      delete e.credential;
      e.lifetime.abort();
      invalidate(e);
      invalidatePod(e);
      resetLabels(e);
      delete e.boundPod;
      e.view = {
        ...e.view,
        session: Object.freeze({ kind: 'ended', problem: 'disconnected' }),
        catalogue: Object.freeze({ kind: 'unknown' }),
        selectedContext: null,
        grantedScopes: Object.freeze([]),
        missingRequiredScopes: required,
      };
      publish();
      return operation;
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
        () => eligible(e),
        () => forbidden(e),
        (listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      );
      return e.bound;
    },
    dispose() {
      disposed = true;
      initialized = false;
      for (const e of entries.values()) {
        delete e.credentials;
        delete e.credential;
        e.lifetime.abort();
        invalidate(e);
        invalidatePod(e);
        resetLabels(e);
        delete e.boundPod;
      }
      entries.clear();
      lease?.close();
      publish();
      listeners.clear();
      snapshot = Object.freeze([]);
    },
  };
}
