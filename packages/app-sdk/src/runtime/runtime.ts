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
  type ClientIdentity,
  type ExchangeResult,
  type OAuthClient,
  type PodDiscovery,
} from '@sempods/client-sdk/oauth';
import { callbackUrl, scopeList } from '@sempods/client-sdk/oauth/host';
import {
  acquireSessionLease,
  type SessionLease,
  type SessionLocks,
} from '../sessions/lease.js';
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
  AuthorizationIntent,
  BrowserRuntime,
  BrowserRuntimeOptions,
  Connection,
  DisconnectResult,
  PreferenceStorage,
  SessionFact,
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
import { createAdmission } from './admission.js';
import {
  loadCatalogue,
  loadContextLabels,
  loadSelectedLabel,
  resetLabels,
} from './catalogue.js';
import {
  activeMemories,
  browserPreferences,
  createContextMemory,
} from './context-memory.js';

import { assertCredentialRecipient, sends, type Entry } from './connection.js';

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

/** Conflicts: another tab changed the record this one expected. */
const conflicts = new WeakSet<object>();
function conflict() {
  const error = new RuntimeError('disconnected');
  conflicts.add(error);
  return error;
}
function superseded(error: unknown) {
  return typeof error === 'object' && error !== null && conflicts.has(error);
}
/** A credential whose refresh token a claim spent; only the claim keeps it. */
function withoutRefresh(credentials: ExchangeResult): ExchangeResult {
  const spent = { ...credentials };
  delete spent.refreshToken;
  return spent;
}
/** A retired record's connection, as a start lists it: signed out, and why. */
function signedOut(reason: string | undefined): SessionFact {
  const problem = knownProblem(reason);
  return Object.freeze(
    problem ? { kind: 'signed-out', problem } : { kind: 'signed-out' },
  );
}

/** Creates no storage, request or navigation until initialize/connect is called. */
export function createBrowserRuntime(
  options: BrowserRuntimeOptions,
): BrowserRuntime {
  const signIn = options.signIn ?? 'required';
  if (signIn !== 'required' && signIn !== 'optional' && signIn !== 'none')
    throw new RuntimeError('configuration');
  /** Whether a connection without a session reads without a token. */
  const readsAnonymously = signIn !== 'required';
  if (signIn !== 'none' && !options.identity)
    throw new RuntimeError('configuration');
  const configuredRequired = options.scopes?.required ?? [];
  const configuredOptional = options.scopes?.optional ?? [];
  // An app that works without a session cannot require what only a session
  // grants; one that never signs in requests nothing.
  if (
    (readsAnonymously && configuredRequired.length > 0) ||
    (signIn === 'none' && configuredOptional.length > 0)
  )
    throw new RuntimeError('configuration');
  const identity: ClientIdentity | undefined = options.identity
    ? Object.freeze({ ...options.identity })
    : undefined;
  const required = scopeList(configuredRequired);
  const optional = scopeList(
    // Signing in must not hide the public Contexts the app showed without a
    // token: a session reads them only with this scope (SPS-GRANT-020).
    signIn === 'optional' && !configuredOptional.includes('public-read')
      ? [...configuredOptional, 'public-read']
      : configuredOptional,
  );
  const requested = Object.freeze([...new Set([...required, ...optional])]);
  const redirect = identity
    ? callbackUrl(identity.redirectUri, options.development === 'loopback-http')
    : undefined;
  // A string is checked once; a function each time a sign-in starts, so the
  // address the person is on then (a deep link) survives the sign-in.
  const configuredReturnTo = options.returnTo ?? '/';
  const fixedReturnTo =
    identity && typeof configuredReturnTo === 'string'
      ? safeReturnTo(configuredReturnTo, identity.redirectUri)
      : undefined;
  const returnTo = () =>
    fixedReturnTo ??
    safeReturnTo((configuredReturnTo as () => string)(), identity!.redirectUri);
  const namespace = identity
    ? JSON.stringify([
        identity.kind,
        identity.kind === 'did-web' ? identity.clientId : identity.redirectUri,
      ])
    : JSON.stringify(['anonymous']);
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
  // Without sign-in, there is nothing to choose a Pod with.
  if (signIn === 'none' && defaultPodUrl === undefined)
    throw new RuntimeError('configuration');
  // Whether a Pod address outlives its session (sign-out, a session that ends).
  const rememberPods = options.rememberPods ?? true;
  const firstSignIn = options.firstSignIn ?? 'click';
  // Silently only with one default Pod to ask, and a client it can answer:
  // a Pod never grants a dynamically registered client without its consent
  // screen (SPS-AUTH-040), so prompt=none could never succeed for one.
  if (
    (firstSignIn !== 'click' && firstSignIn !== 'silent') ||
    (firstSignIn === 'silent' &&
      (identity?.kind !== 'did-web' || defaultPodUrl === undefined))
  )
    throw new RuntimeError('configuration');
  /**
   * This tab's note on the silent first sign-in: `tried`, or `attempt:` and
   * the state of the attempt that is out. Read lazily: construction touches
   * no storage.
   */
  const silentKey = `sempods.first-sign-in:${namespace}`;
  function tabMemory(): PreferenceStorage | null {
    if (options.tabStorage !== undefined) return options.tabStorage;
    try {
      return globalThis.sessionStorage ?? null;
    } catch {
      return null;
    }
  }
  /** `null` while not tried in this tab; a note that cannot be read counts as tried. */
  function readSilentNote(): string | null {
    try {
      const memory = tabMemory();
      return memory ? memory.getItem(silentKey) : 'tried';
    } catch {
      return 'tried';
    }
  }
  /** Whether the note was kept: without it, nothing is tried silently. */
  function noteSilent(value: string): boolean {
    try {
      const memory = tabMemory();
      if (!memory) return false;
      memory.setItem(silentKey, value);
      return memory.getItem(silentKey) === value;
    } catch {
      return false;
    }
  }
  const gracePeriod = options.refreshGracePeriod ?? REFRESH_GRACE_PERIOD;
  if (!Number.isFinite(gracePeriod) || gracePeriod < 0)
    throw new RuntimeError('configuration');
  const admission = createAdmission(options.podReadLimit);
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
  const connecting = new Map<string, Promise<Connection>>();
  /** Connections whose sign-in is being prepared here. */
  const preparing = new Set<string>();
  const contexts = createContextMemory(
    namespace,
    options.preferences === undefined
      ? browserPreferences()
      : options.preferences,
    // A tab's own choice survives its reload beside another tab's; without
    // remembering (`preferences: null`) nothing is kept in the tab either.
    () => (options.preferences === null ? null : tabMemory()),
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
  /** The Web Locks of the lease, also for each connection's refresh lock. */
  let locks: SessionLocks | null | undefined;
  let sessions: ReturnType<typeof createSessionTransitions> | undefined;
  let startup: Promise<StartupReport> | undefined;
  let initialized = false;
  let disposed = false;
  /** Ends with `dispose()`: stops waits that belong to no connection yet. */
  const runtimeLifetime = new AbortController();

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
  /** How an entry sends requests now (`Connection.reading`). */
  function readingOf(e: Entry): Connection['reading'] {
    if (e.anonymous) return 'anonymous';
    const kind = e.view.session.kind;
    return kind === 'active' || kind === 'renewing' ? 'session' : null;
  }
  function publish() {
    snapshot = Object.freeze(
      [...entries.values()].map((e) => {
        // `connect()` returns `e.view`, so it carries `reading` as well.
        const reading = readingOf(e);
        if (e.view.reading !== reading) e.view = { ...e.view, reading };
        return Object.freeze({ ...e.view });
      }),
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
  /** Another tab changed the record first: this tab reads it next. */
  function changedElsewhere(e: Entry) {
    void sync(e);
    return conflict();
  }
  function accepted(e: Entry, change: SessionChange) {
    if (change.kind === 'conflict') throw changedElsewhere(e);
    e.revision = change.record.revision;
  }
  /** Records a revision another tab stored, which this tab now follows. */
  function follow(e: Entry, revision: string | null) {
    e.revision = revision;
    e.adopted++;
  }
  /**
   * Runs `work` while this tab holds the connection's refresh lock, which
   * every tab of the app takes to claim, send or resend a refresh: another
   * tab's refresh is waited for, and `latest` then reads its result. Writes
   * `work` queued (a retirement) land before the lock passes on, so no other
   * tab takes a refresh this one still finishes for its own. Waiting ends
   * with the connection's lifetime.
   */
  function exclusive<T>(e: Entry, work: () => Promise<T>): Promise<T> {
    return locked(`sempods:refresh:${namespace}:${e.view.id}`, e, work);
  }
  /**
   * Runs `work` while this tab holds the Web Lock `name`, waited for until
   * the connection's lifetime ends; `e`'s queued writes land before it passes
   * on.
   */
  function locked<T>(
    name: string,
    e: Entry,
    work: () => Promise<T>,
  ): Promise<T> {
    const signal = e.lifetime.signal;
    return new Promise<T>((resolve, reject) => {
      if (!locks) {
        reject(new RuntimeError('coordination'));
        return;
      }
      let granted = false;
      const failed = () =>
        reject(
          new RuntimeError(signal.aborted ? 'disconnected' : 'coordination'),
        );
      try {
        locks
          .request(name, { signal }, async (lock) => {
            granted = true;
            // Only a granted lock excludes the other tabs.
            if (!lock) {
              reject(new RuntimeError('coordination'));
              return;
            }
            try {
              const result = await work();
              await e.persistence;
              resolve(result);
            } catch (error) {
              await e.persistence;
              reject(error);
            }
          })
          .catch(() => {
            if (!granted) failed();
          });
      } catch {
        failed();
      }
    });
  }
  /** Whether the connection has, or is getting, a session another tab may end. */
  function inSession(e: Entry) {
    const s = e.view.session;
    return s.kind !== 'signed-out' && !(s.kind === 'ended' && !s.restorable);
  }
  /**
   * Shows what another tab stored for this connection as a start would list
   * it, without starting anything: a renewed credential or a new sign-in is
   * used here too, a sign-out ends this tab's session and a deletion removes
   * the connection, and a sign-in under way elsewhere stops this tab's
   * session until its result is stored. A refresh another tab claimed stays
   * that tab's (see `latest`). Runs inside `serial`; returns whether it
   * changed this tab's connection.
   */
  function adopt(e: Entry, stored: SessionSnapshot | undefined): boolean {
    if ((stored?.revision ?? null) === e.revision) return false;
    if (entries.get(e.view.id) !== e || disposed) return false;
    // This tab's own sign-out or forget continues on the newer record.
    if (disconnects.has(e.view.id)) {
      follow(e, stored?.revision ?? null);
      return false;
    }
    if (!stored) {
      // Forgotten in another tab, or signed out there without remembering
      // it: so is the Context this tab chose for it.
      stop(e, { kind: 'signed-out' });
      entries.delete(e.view.id);
      contexts.forget(e.view.id);
      ensureDefault();
      publish();
      return true;
    }
    const value = stored.value;
    const b = sessionBinding(value);
    // A refresh of this session that another tab claimed stays that tab's
    // (see `latest`); one of a newer sign-in ends this tab's earlier session
    // below, until its result is stored.
    if (
      value.kind === 'claimed' &&
      value.operation === 'refresh' &&
      b.generation === e.generation
    )
      return false;
    follow(e, stored.revision);
    // A sign-out or forget here that could not be saved keeps this session
    // blocked, and a retry applies to the newer record; only a new sign-in
    // elsewhere, or a sign-out there that saves a sign-out, replaces it.
    const blocked = e.view.session;
    if (
      blocked.kind === 'ended' &&
      blocked.problem === 'disconnected' &&
      blocked.saved === false &&
      b.generation === e.generation &&
      (value.kind !== 'disconnected' || e.forgetting)
    )
      return false;
    if (value.kind === 'ready') {
      if (e.lost) clearTimeout(e.lost.timer);
      delete e.lost;
      delete e.restorable;
      if (b.generation !== e.generation || e.lifetime.signal.aborted) {
        // A new sign-in in another tab: nothing of this tab's earlier
        // session continues.
        renewLifetime(e, b.generation, new RuntimeError('disconnected'));
        delete e.forgetting;
        // As a start shows it: Context access is checked again before any
        // view of the new session uses it, and the choice reselected then.
        e.view = {
          ...e.view,
          requestedScopes: b.scopes,
          catalogue: Object.freeze({ kind: 'unknown' }),
          selectedContext: null,
        };
      }
      e.pod = b.pod;
      e.client = b.client;
      install(e, value.credentials);
      return true;
    }
    if (value.kind === 'disconnected') {
      const fact = signedOut(value.reason);
      // A connection reading without a token keeps doing so: it had no
      // session here to end.
      if (e.anonymous) e.view = { ...e.view, session: fact };
      else {
        stop(e, fact);
        // As this tab's own sign-out leaves it.
        e.view = { ...e.view, selectedContext: null };
      }
      publish();
      return true;
    }
    // Another tab signs in to this connection (an attempt or its code claim),
    // or renews a session it signed in to since.
    if (inSession(e)) {
      stop(e, { kind: 'ended', problem: 'interrupted' });
      publish();
    }
    return true;
  }
  /**
   * Lists a connection another tab saved, which this tab does not list yet
   * (a sign-in there, or a Pod remembered there), so one Pod address keeps
   * one saved connection. A connection of this tab to the same Pod without a
   * record of its own and without a session gives way to it. Returns whether
   * the record is listed now.
   */
  function admit(stored: SessionSnapshot): boolean {
    if (disposed || !initialized || entries.has(stored.id)) return false;
    const b = sessionBinding(stored.value);
    if (!allows(b.pod.podUrl)) return false;
    const same = [...entries.values()].filter(
      (x) => x.view.podUrl === b.pod.podUrl,
    );
    if (
      same.some(
        (x) =>
          x.revision !== null ||
          inSession(x) ||
          disconnects.has(x.view.id) ||
          preparing.has(x.view.id),
      )
    )
      return false;
    for (const x of same) {
      // Removed first, so it does not settle to read without a token.
      entries.delete(x.view.id);
      stop(x, { kind: 'signed-out' });
    }
    const e = createEntry(
      b.pod.podUrl,
      b.pod,
      b.client,
      stored.id,
      b.generation,
    );
    e.view = { ...e.view, requestedScopes: b.scopes };
    entries.set(stored.id, e);
    // A refresh another tab claimed: its result follows.
    if (!adopt(e, stored)) follow(e, stored.revision);
    settle(e);
    publish();
    return true;
  }
  /**
   * The record another tab saved for `podUrl`, with a shared store: a
   * session first, then a remembered address, then a sign-in under way.
   */
  async function savedFor(podUrl: string) {
    if (!sessions || !lease?.store.watch) return undefined;
    try {
      const saved = (await sessions.list()).records.filter(
        (r) => sessionBinding(r.value).pod.podUrl === podUrl,
      );
      return (
        saved.find((r) => r.value.kind === 'ready') ??
        saved.find((r) => r.value.kind === 'disconnected') ??
        saved[0]
      );
    } catch {
      // Unreadable: none, as before.
      return undefined;
    }
  }
  /** Lists a record another tab announced. */
  function announced(id: string) {
    void sessions
      ?.read(id)
      .then((stored) => {
        if (stored) admit(stored);
      })
      .catch(() => {
        // Listed by the next start.
      });
  }
  /** Reads the record again and adopts what another tab stored; best effort. */
  function sync(e: Entry): Promise<void> {
    return serial(e, async () => {
      if (!sessions || disposed || entries.get(e.view.id) !== e) return;
      adopt(e, await sessions.read(e.view.id));
    }).catch(() => {
      // An unreadable record is listed by the next start.
    });
  }
  /**
   * Under the refresh lock: reads the record and adopts what another tab
   * stored meanwhile (`changed`). A refresh claimed for this session that no
   * tab finished (its tab closed or lost the answer) is this tab's to resend
   * now (`resend`).
   */
  function latest(
    e: Entry,
  ): Promise<{ readonly changed: boolean; readonly resend?: RefreshResend }> {
    return serial(e, async () => {
      if (!sessions) throw new RuntimeError('storage');
      const stored = await sessions.read(e.view.id);
      const value = stored?.value;
      if (
        stored &&
        value?.kind === 'claimed' &&
        value.operation === 'refresh' &&
        value.resend &&
        !disconnects.has(e.view.id) &&
        (stored.revision === e.revision ||
          value.binding.generation === e.generation)
      ) {
        if (stored.revision !== e.revision) {
          follow(e, stored.revision);
          // The claim spent the refresh token this tab still holds.
          if (e.credentials) e.credentials = withoutRefresh(e.credentials);
        }
        return { changed: false, resend: value.resend };
      }
      // Also another session's claim, which `adopt` stops this tab for.
      return { changed: adopt(e, stored) };
    });
  }
  /** Only for an entry with a session or a saved record, which has a client. */
  function binding(e: Entry, pod: PodDiscovery): SessionBinding {
    return {
      configKey: namespace,
      connectionId: e.view.id,
      generation: e.generation,
      pod,
      client: e.client!,
      scopes: e.view.requestedScopes,
    };
  }
  function install(e: Entry, result: ExchangeResult) {
    const previous = e.view.grantedScopes;
    const previousSubject = e.credentials?.subject;
    delete e.anonymous;
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
    const problem = runtimeProblem(error);
    stop(e, { kind: 'ended', problem, ...runtimeFailure(error) });
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
  /**
   * Stops everything of the session and shows `session` without access;
   * under `signIn: 'optional'` the connection then reads without a token.
   * Publishes nothing itself.
   */
  function stop(e: Entry, session: SessionFact) {
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
    e.view = {
      ...e.view,
      session: Object.freeze(session),
      catalogue: Object.freeze({ kind: 'unknown' }),
      grantedScopes: Object.freeze([]),
      missingRequiredScopes: required,
    };
    settle(e);
  }
  /**
   * Under `signIn: 'optional'` or `'none'`, a connection whose session is
   * gone reads without a token from now on: a `signed-out` one, or an `ended`
   * one that is neither restorable nor signing out. It gets a lifetime and
   * generation of its own, so nothing of its session (reads, handles, the
   * catalogue, a pending renewal) continues, and no request refused with a
   * token is sent again without it. Publishes nothing itself.
   */
  function settle(e: Entry): boolean {
    if (!readsAnonymously || !initialized || disposed) return false;
    if (e.anonymous || entries.get(e.view.id) !== e) return false;
    if (!sessionGone(e)) return false;
    if (e.lost) clearTimeout(e.lost.timer);
    delete e.restorable;
    renewLifetime(e, crypto.randomUUID(), new RuntimeError('disconnected'));
    e.anonymous = true;
    e.view = {
      ...e.view,
      catalogue: Object.freeze({ kind: 'unknown' }),
      grantedScopes: Object.freeze([]),
      missingRequiredScopes: required,
    };
    return true;
  }
  /**
   * The session is gone for good: signed out, or ended neither restorably nor
   * by a sign-out or forget in progress or one that could not be saved, which
   * keep the connection blocked. A session that ended by a record conflict
   * is gone too.
   */
  function sessionGone(e: Entry) {
    const s = e.view.session;
    if (s.kind === 'signed-out') return true;
    if (s.kind !== 'ended' || s.restorable) return false;
    if (s.problem !== 'disconnected') return true;
    return !disconnects.has(e.view.id) && s.saved !== false && !s.forget;
  }
  /**
   * Starts a new lifetime and generation: nothing of the earlier one (its
   * credential, renewal, reads, handles, catalogue read) continues. The view
   * is the caller's.
   */
  function renewLifetime(e: Entry, generation: string, reason?: unknown) {
    e.lifetime.abort(reason);
    e.lifetime = new AbortController();
    e.generation = generation;
    delete e.anonymous;
    delete e.credentials;
    delete e.credential;
    delete e.bound;
    delete e.boundPod;
    delete e.explicit;
    delete e.observations;
    delete e.refresh;
    delete e.ahead;
    delete e.lost;
    delete e.catalogue;
    delete e.revalidation;
    invalidate(e);
    invalidatePod(e);
    invalidateContexts(e);
    resetLabels(e);
    e.selectedVersion++;
  }
  /** A connection without discovery or client that reads without a token. */
  function addAnonymous(podUrl: string, id?: string) {
    const e = createEntry(podUrl, undefined, undefined, id);
    e.anonymous = true;
    entries.set(e.view.id, e);
    return e;
  }
  /**
   * Under `signIn: 'optional'` or `'none'`, the default Pod is always listed:
   * without a connection to it, one that reads without a token is added.
   */
  function ensureDefault(): boolean {
    if (!readsAnonymously || !initialized || disposed || !defaultPodUrl)
      return false;
    for (const e of entries.values())
      if (e.view.podUrl === defaultPodUrl) return false;
    // A stable id keeps the remembered Context of a Pod never signed in to.
    addAnonymous(defaultPodUrl, defaultPodUrl);
    return true;
  }
  /**
   * Deletes a record still at `revision` and, once it is gone, the Context
   * choice remembered with it; whether it was deleted.
   */
  async function remove(id: string, revision: string) {
    if (!sessions || (await sessions.forget(id, revision)) === 'conflict')
      return false;
    contexts.forget(id);
    return true;
  }
  async function erase(id: string, revision: string) {
    if (!(await remove(id, revision))) throw new RuntimeError('disconnected');
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
    /**
     * A sign-out or forget: it applies to the record another tab changed
     * meanwhile too. Otherwise (a session that ended here) this tab adopts
     * that record instead.
     */
    insist = false,
  ) {
    // A record this tab adopted from another tab while the retirement
    // waited is not the ended session's to retire.
    const adopted = e.adopted;
    return serial(e, async () => {
      if (!insist && e.adopted !== adopted) return e.revision !== null;
      for (let round = 0; ; round++) {
        if (!sessions || !e.revision) {
          contexts.forget(e.view.id);
          return false;
        }
        if (!deleting) {
          const change = await sessions.disconnect(
            e.view.id,
            e.revision,
            reason,
          );
          if (change.kind === 'committed') {
            e.revision = change.record.revision;
            return true;
          }
        } else if (await remove(e.view.id, e.revision)) {
          e.revision = null;
          return false;
        }
        const stored = await sessions.read(e.view.id);
        if (!insist) {
          adopt(e, stored);
          return stored !== undefined;
        }
        if (round >= 2) throw new RuntimeError('disconnected');
        e.revision = stored?.revision ?? null;
      }
    });
  }
  /**
   * Under the refresh lock, after discovery: resends a refresh another tab
   * claimed for this session and left (`resent`); stops when another tab
   * changed the record or `fresh` says this renewal is stale (`skipped`);
   * otherwise claims, sends and stores a refresh of `before` (`installed`, or
   * `resent` after a lost answer). The one resend publishes its own outcome.
   */
  async function refreshLocked(
    e: Entry,
    generation: string,
    pod: PodDiscovery,
    before: ExchangeResult,
    progress: { consumed: boolean },
    fresh: () => boolean,
  ): Promise<'resent' | 'skipped' | 'installed'> {
    const found = await latest(e);
    if (found.resend && eligible(e, generation)) {
      // Another tab claimed this refresh and left without its answer.
      await resendLost(e, found.resend, pod);
      return 'resent';
    }
    // Another tab renewed, signed out or signed in meanwhile.
    if (found.changed || !eligible(e, generation) || !fresh()) return 'skipped';
    const claim = await serial(e, async () => {
      current(e, generation);
      if (!sessions || !e.revision) throw new RuntimeError('storage');
      const claimed = await sessions.claimRefresh(
        e.view.id,
        e.revision,
        binding(e, pod),
      );
      if (claimed.kind === 'conflict') throw changedElsewhere(e);
      progress.consumed = true;
      e.revision = claimed.revision;
      return claimed;
    });
    current(e, generation);
    // Erase a consumed refresh token from memory before the token request;
    // only the durable claim keeps it, for one resend.
    if (e.credentials) e.credentials = withoutRefresh(e.credentials);
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
      await resendLost(e, { sentAt: claim.sentAt });
      return 'resent';
    }
    await serial(e, async () => {
      current(e, generation);
      accepted(e, await claim.complete(sent.result));
    });
    current(e, generation);
    e.pod = pod;
    install(e, sent.result);
    return 'installed';
  }
  /**
   * A renewal that failed in this generation: `keep` when nothing was spent
   * and the cause may pass, otherwise the session ends. A conflict leaves it
   * to the record another tab stored, which `changedElsewhere` reads.
   */
  function refreshFailed(
    e: Entry,
    generation: string,
    error: unknown,
    consumed: boolean,
    keep: () => void,
  ) {
    if (superseded(error) || !eligible(e, generation)) return;
    if (error instanceof OAuthError && error.problem === 'invalid-client')
      registry.clear(e.view.podUrl);
    if (!consumed && transientBeforeClaim(error)) keep();
    else end(e, error, consumed);
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
        const progress = { consumed: false };
        const failed = (error: unknown) =>
          refreshFailed(e, generation, error, progress.consumed, () => {
            // Nothing was spent and the cause may pass (offline or failing
            // discovery, storage that could not be written): stay signed in
            // with the unspent refresh token, so the next due or refused request can
            // try again without a reload. A changed binding or invalid
            // metadata ends the session and needs a new sign-in.
            e.view = {
              ...e.view,
              session: Object.freeze({
                kind: 'active',
                subject: before.subject,
              }),
            };
            publish();
          });
        /** Whether this connection has a session to send with now. */
        const usable = () =>
          eligible(e) &&
          e.credential !== undefined &&
          e.view.session.kind === 'active';
        try {
          const pod = await discover(e.view.podUrl, e.lifetime.signal);
          current(e, generation);
          return await exclusive(e, async () => {
            try {
              const outcome = await refreshLocked(
                e,
                generation,
                pod,
                before,
                progress,
                () => e.credentials === before,
              );
              if (outcome === 'installed') return true;
              return outcome === 'resent'
                ? eligible(e, generation) && usable()
                : usable();
            } catch (error) {
              // Inside the lock: a retirement lands before another tab could
              // take this claim for one it should resend.
              failed(error);
              return false;
            }
          });
        } catch (error) {
          failed(error);
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
        { pod, client: e.client!, scopes },
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
      if (claimed.kind === 'conflict') throw changedElsewhere(e);
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
  async function resumeLost(e: Entry, pod?: PodDiscovery): Promise<void> {
    const generation = e.generation;
    // Another tab may resend it, or have done so: decided under the lock,
    // from the record as it is now.
    try {
      await exclusive(e, async () => {
        const found = await latest(e);
        if (!found.changed && found.resend && eligible(e, generation))
          await resendLost(e, found.resend, pod);
      });
    } catch (error) {
      if (!superseded(error) && eligible(e, generation)) end(e, error);
    }
  }
  /** `resumeLost` under the refresh lock, for the claim's `resend`. */
  async function resendLost(
    e: Entry,
    resend: { readonly sentAt: number; readonly resent?: true },
    pod?: PodDiscovery,
  ): Promise<void> {
    const generation = e.generation;
    const { sentAt } = resend;
    const events = onlineEvents;
    const wait = (pod?: PodDiscovery) => {
      suspend(e, generation, pod, sentAt);
      // The browser came back online meanwhile: try once more now.
      if (onlineEvents !== events) void retryRestore(e);
    };
    try {
      if (resend.resent || !withinGrace(sentAt))
        throw new RuntimeError('interrupted');
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
          pod = await discover(e.view.podUrl, signal.signal);
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
      refreshFailed(e, generation, error, true, () => {});
    }
  }
  /**
   * Whether a credential is due for renewal: within a minute of `expiresAt`,
   * half the lifetime for short tokens, or past it.
   */
  function due(credentials: ExchangeResult) {
    const lifetime = credentials.expiresAt - credentials.receivedAt;
    const margin = Math.min(RENEWAL_MARGIN, Math.max(lifetime, 0) / 2);
    return Date.now() >= credentials.expiresAt - margin;
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
    if (!due(credentials)) return;
    if (!credentials.refreshToken && Date.now() < credentials.expiresAt) return;
    void renew(e, e.credential, undefined, true);
  }
  /** `pod` and `client` are absent for a connection added without sign-in. */
  function createEntry(
    podUrl: string,
    pod: PodDiscovery | undefined,
    client: OAuthClient | undefined,
    id: string = crypto.randomUUID(),
    generation: string = crypto.randomUUID(),
  ): Entry {
    const data: Omit<Entry, 'clientPod' | 'auth'> = {
      ...(pod ? { pod } : {}),
      ...(client ? { client } : {}),
      generation,
      lifetime: new AbortController(),
      reads: new AbortController(),
      podReads: new AbortController(),
      podEpoch: 0,
      revision: null,
      adopted: 0,
      persistence: Promise.resolve(),
      epoch: 0,
      selectedVersion: 0,
      view: {
        id,
        podUrl,
        clientKind: client?.kind ?? identity?.kind ?? null,
        session: Object.freeze({ kind: 'signed-out' }),
        reading: null,
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
        // Without a session the request is sent without a credential, and
        // only while this connection still reads that way.
        if (e.anonymous) {
          if (!eligible(e)) throw new RuntimeError('disconnected');
          return null;
        }
        assertCredentialRecipient(e.view.podUrl, request.url);
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
      clientPod: (options.podFactory ?? createPod)(podUrl, {
        ...protocol,
        beforeDispatch: () => eligible(e) && sends(e),
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
  /** Signed in, or reading without a token. */
  function ready(e: Entry) {
    if (!eligible(e) || (!e.credentials && !e.anonymous))
      throw new RuntimeError('disconnected');
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
    // Another tab may store a newer state meanwhile, which this tab adopts.
    const adopted = e.adopted;
    const newer = () => e.adopted !== adopted;
    try {
      const pod = await discover(e.view.podUrl, e.lifetime.signal);
      current(e, generation);
      if (newer()) return;
      assertSessionBinding(saved.binding, binding(e, pod));
      e.pod = pod;
      const credentials = saved.credentials;
      if (due(credentials) && credentials.refreshToken) {
        // Renewed as part of restoration (#305): the connection stays
        // `restoring` until the answer, so an expired grant ends here
        // rather than after the app saw the session `active`.
        await renewRestored(e, generation, pod, saved);
        return;
      }
      if (!credentials.refreshToken && Date.now() >= credentials.expiresAt) {
        // Retired as at its first request, keeping the address.
        end(e, new RuntimeError('expired'));
        return;
      }
      install(e, credentials);
    } catch (error) {
      if (eligible(e, generation) && !newer()) {
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
        settle(e);
        publish();
        // The browser came back online while this attempt was under way: its
        // retry found the session still restoring, so try once more now.
        if (restorable && onlineEvents !== events) void retryRestore(e);
      }
    }
  }
  /**
   * Renews a restored credential that is due, while the connection still
   * restores; publishes its own outcome. Like `renew`, except that nothing is
   * dispatched meanwhile and a cause that spent nothing (storage, the claim)
   * leaves the session restorable, as an unreachable Pod does. A lost answer
   * gets the one resend of `resumeLost`; a refusal ends the session.
   */
  async function renewRestored(
    e: Entry,
    generation: string,
    pod: PodDiscovery,
    saved: Extract<SessionRecord, { kind: 'ready' }>,
  ) {
    const progress = { consumed: false };
    // The record restoration listed; another tab's change, adopted while this
    // tab waited for the lock, replaces it (and its spent refresh token).
    const adopted = e.adopted;
    const fresh = () => e.adopted === adopted;
    const failed = (error: unknown) => {
      if (!fresh()) return;
      refreshFailed(e, generation, error, progress.consumed, () => {
        e.restorable = saved;
        e.view = {
          ...e.view,
          session: Object.freeze({
            kind: 'ended',
            problem: runtimeProblem(error),
            ...runtimeFailure(error),
            restorable: true as const,
          }),
        };
        settle(e);
        publish();
      });
    };
    try {
      await exclusive(e, async () => {
        try {
          await refreshLocked(
            e,
            generation,
            pod,
            saved.credentials,
            progress,
            fresh,
          );
        } catch (error) {
          // Inside the lock, like `renew`.
          failed(error);
        }
      });
    } catch (error) {
      failed(error);
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
      await resumeLost(e, lost.pod);
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
  // A page restored from the back/forward cache missed the other tabs'
  // announcements: it reads every record again.
  const shown = (event?: unknown) => {
    if (!(event as { persisted?: boolean } | undefined)?.persisted) return;
    for (const e of entries.values()) void sync(e);
    if (lease?.store.watch)
      void sessions
        ?.list()
        .then(({ records }) => records.forEach(admit))
        .catch(() => {
          // Listed by the next start.
        });
  };
  page.addEventListener?.('pageshow', shown);
  /**
   * Resumes the session a denied (`callback`) or abandoned re-authorization
   * started from, and publishes it. Returns false, changing nothing, when the
   * stored attempt is not eligible (see the `resume` transition).
   */
  async function resume(e: Entry, callback?: URL): Promise<boolean> {
    const generation = e.generation;
    const pod = await discover(e.view.podUrl, e.lifetime.signal);
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
  /**
   * A page restored from the back/forward cache while leaving for a sign-in
   * resumes the session it started from; the silent first sign-in instead
   * ends signed out, as if never started.
   */
  function watchReturn(e: Entry, generation: string, silent = false) {
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
        if (silent) {
          noteSilent('tried');
          decline(e);
          return;
        }
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
    const adopted = e.adopted;
    let problem: RuntimeProblem = ineligible;
    let cause: unknown;
    try {
      if (await resume(e)) return;
    } catch (error) {
      problem = runtimeProblem(error);
      cause = error;
    }
    // Unless this tab adopted, or is about to read, what another tab stored
    // meanwhile.
    if (
      eligible(e, generation) &&
      e.adopted === adopted &&
      !superseded(cause)
    ) {
      e.view = {
        ...e.view,
        session: Object.freeze({
          kind: 'ended',
          problem,
          ...runtimeFailure(cause),
        }),
      };
      settle(e);
      publish();
    }
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
    /** The silent first sign-in: a Pod that needs the person first ends nothing. */
    silent = false,
  ): Promise<string> {
    const e = get(id);
    const generation = e.generation;
    const pod = await discover(e.view.podUrl, e.lifetime.signal);
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
    // Claimed: the silent attempt's answer is consumed now.
    if (silent) noteSilent('tried');
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
          registry.clear(e.view.podUrl);
        if (silent && declined(error)) decline(e);
        else end(e, error, true, hadSession);
        await e.persistence;
      }
      throw error;
    }
  }
  /**
   * The silent first sign-in's answers that ask for the person (sign in,
   * consent, another step) rather than fail.
   */
  function declined(error: unknown) {
    return error instanceof OAuthError &&
      (error.problem === 'login-required' ||
        error.problem === 'consent-required' ||
        error.problem === 'interaction-required')
      ? error.problem
      : undefined;
  }
  /**
   * The silent first sign-in came back without a session: signed out as a
   * connection never signed in to, and its record deleted, so nothing is
   * remembered. A deletion that fails ends it as `storage`, like `end`.
   */
  function decline(e: Entry) {
    stop(e, { kind: 'signed-out' });
    const signedOut = e.view.session;
    publish();
    void retire(e, undefined, true).catch(() => {
      if (entries.get(e.view.id) === e && e.view.session === signedOut) {
        e.view = {
          ...e.view,
          session: Object.freeze({ kind: 'ended', problem: 'storage' }),
        };
        publish();
      }
    });
  }
  /**
   * Under `firstSignIn: 'silent'`, with nothing stored: connects the default
   * Pod and asks it with `prompt=none`. Noted for this tab first, so nothing
   * after it can try again; a preparation that fails stays signed out.
   */
  async function signInSilently() {
    if (!noteSilent('tried')) return;
    try {
      if (ensureDefault()) publish();
      const c = await runtime.connect(defaultPodUrl);
      // Another tab signed in meanwhile.
      if (c.session.kind === 'active') return;
      await authorize(c.id, 'silent');
    } catch {
      // Signed out as before: the person signs in with a click.
    }
  }
  /**
   * Prepares and starts a sign-in. `silent` asks the Pod with `prompt=none`
   * and notes the attempt's state for this tab before it is stored, so its
   * callback is known as the silent one.
   */
  async function authorize(
    id: string,
    intent: AuthorizationIntent | 'silent',
  ): Promise<void> {
    // Kept while preparing, so another tab's record does not replace it.
    preparing.add(id);
    try {
      await prepareAuthorization(id, intent);
    } finally {
      preparing.delete(id);
    }
  }
  async function prepareAuthorization(
    id: string,
    intent: AuthorizationIntent | 'silent',
  ): Promise<void> {
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
    const pod = await discover(e.view.podUrl, signal);
    current(e, before);
    const client = await registry.resolve(pod, identity!, { signal });
    current(e, before);
    /** Prepares and stores the attempt; nothing changes before it is stored. */
    const store = async () => {
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
          // Only an explicit request to change sharing asks the Pod for its
          // consent page; a sign-in may reuse the existing grant. The silent
          // first sign-in asks it to show nothing.
          ...(intent === 'change-sharing'
            ? { prompt: 'consent' as const }
            : intent === 'silent'
              ? { prompt: 'none' as const }
              : {}),
        },
        Date.now(),
        options.development,
      );
      // Without the note, its callback would end the connection as a failed
      // sign-in: nothing is stored or started.
      if (intent === 'silent' && !noteSilent(`attempt:${attempt.state}`))
        throw new RuntimeError('storage');
      await serial(e, async () => {
        current(e, before);
        // Another tab changed the record first: shown here, and a retry
        // prepares on it.
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
        renewLifetime(e, generation);
        e.pod = pod;
        e.client = client;
        // Signing in again replaces a forget that could not be saved.
        delete e.forgetting;
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
      return { generation, url };
    };
    let prepared: { generation: string; url: string };
    if (e.revision === null && lease?.store.watch) {
      // The first record for this Pod, decided under its lock: two tabs
      // preparing at once do not both create one.
      const outcome = await locked<
        | { joined: Entry; kind: SessionRecord['kind'] }
        | { prepared: { generation: string; url: string } }
      >(`sempods:connect:${namespace}:${e.view.podUrl}`, e, async () => {
        const saved = await savedFor(e.view.podUrl);
        current(e, before);
        // This connection's own record, which an announcement did not
        // bring yet: the attempt replaces it.
        if (saved?.id === id) follow(e, saved.revision);
        else if (saved) {
          preparing.delete(id);
          admit(saved);
          const joined = entries.get(saved.id);
          if (joined) return { joined, kind: saved.value.kind };
        }
        return { prepared: await store() };
      });
      if ('joined' in outcome) {
        // Another tab signed in to this Pod meanwhile (or is renewing that
        // session): it is this tab's too, without leaving for the Pod.
        if (outcome.kind === 'ready' || outcome.kind === 'claimed') return;
        // A remembered address, or a sign-in under way in another tab: this
        // sign-in continues on that connection, replacing the attempt.
        return authorize(outcome.joined.view.id, intent);
      }
      prepared = outcome.prepared;
    } else prepared = await store();
    const { generation, url } = prepared;
    current(e, generation);
    watchReturn(e, generation, intent === 'silent');
    (options.navigate ?? ((url) => window.location.assign(url)))(url);
  }
  async function bootstrap(): Promise<StartupReport> {
    let report: StartupReport = {
      interaction: 'none',
      storage: 'unavailable',
      unreadable: [],
    };
    if (signIn === 'none') {
      // Nothing is stored and no tab holds a lease: only the default Pod,
      // read without a token.
      initialized = true;
      ensureDefault();
      publish();
      return report;
    }
    let callback = false;
    let attempted: string | undefined;
    // A callback without a matching attempt never calls a function form: on
    // the callback route it would name the callback itself.
    let destination = fixedReturnTo ?? '/';
    try {
      const location = new URL(
        (options.location ?? (() => window.location.href))(),
      );
      if (location.origin !== redirect!.origin)
        throw new RuntimeError('configuration');
      callback = location.pathname === redirect!.pathname;
      locks =
        options.locks === undefined
          ? (globalThis.navigator?.locks as SessionLocks | undefined)
          : options.locks;
      lease = await acquireSessionLease(namespace, locks, () =>
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
        redirectUri: identity!.redirectUri,
        ...protocol,
      });
      // Another tab of this app changed a record: this tab shows it too,
      // also a connection it does not list yet. Changes during this start are
      // read once it has started.
      let early: Set<string> | null = new Set();
      const changed = (id: string) => {
        const e = entries.get(id);
        if (e) void sync(e);
        else announced(id);
      };
      lease.store.watch?.((id) => {
        if (early) early.add(id);
        else if (!disposed) changed(id);
      });
      const listing = await sessions.list();
      // The silent first sign-in's note for this tab, and its attempt's state.
      const silentNote = firstSignIn === 'silent' ? readSilentNote() : 'tried';
      const silentState = silentNote?.startsWith('attempt:')
        ? silentNote.slice('attempt:'.length)
        : undefined;
      report = {
        ...report,
        storage: 'durable',
        unreadable: Object.freeze(listing.unreadable),
      };
      if (disposed) throw new RuntimeError('disconnected');
      let pending: SessionSnapshot | undefined;
      const abandoned: { e: Entry; problem: RuntimeProblem }[] = [];
      /** Refreshes an earlier page sent without an answer, resent once below. */
      const lost: Entry[] = [];
      /** Addresses an earlier start remembered, deleted under `rememberPods: false`. */
      const forgotten: SessionSnapshot[] = [];
      /** The silent first sign-in's own attempt, deleted after coming back without an answer. */
      const abandonedSilent = new Set<string>();
      // Old SDKs could save several connections for one address. Retire only
      // redundant address-only records, under the namespace lease and revision
      // check. Never merge sessions, attempts, or different exact Pod URLs.
      const represented = new Set(
        listing.records
          .filter((saved) => saved.value.kind !== 'disconnected')
          .map((saved) => sessionBinding(saved.value).pod.podUrl),
      );
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
        // A silent first sign-in left without an answer (back navigation)
        // is as if never started; this tab does not try it again.
        if (
          !callback &&
          silentState !== undefined &&
          saved.value.kind === 'authorizing' &&
          saved.value.attempt.state === silentState
        ) {
          try {
            await erase(saved.id, saved.revision);
            abandonedSilent.add(saved.id);
            continue;
          } catch {
            // Listed as an interrupted attempt; deleted by signing out.
          }
        }
        if (!allows(b.pod.podUrl)) continue;
        if (saved.value.kind === 'disconnected' && !rememberPods) {
          forgotten.push(saved);
          continue;
        }
        if (saved.value.kind === 'disconnected') {
          if (represented.has(b.pod.podUrl)) {
            try {
              await erase(saved.id, saved.revision);
              continue;
            } catch {
              // Keep it visible and forgettable if cleanup could not be saved.
            }
          }
          represented.add(b.pod.podUrl);
        }
        if (disposed) throw new RuntimeError('disconnected');
        const e = createEntry(
          b.pod.podUrl,
          b.pod,
          b.client,
          saved.id,
          b.generation,
        );
        e.revision = saved.revision;
        if (saved.value.kind === 'disconnected') {
          // A retired record holds only the address (binding) and why its
          // session ended: a remembered Pod, signed out.
          e.view = { ...e.view, session: signedOut(saved.value.reason) };
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
        if (resend) lost.push(e);
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
      for (const e of lost) void resumeLost(e);
      // Restoration publishes per connection (`restoring` → `active`/`ended`).
      // Neither the startup report nor a callback waits for another Pod, so
      // one Pod whose discovery never settles cannot hold the app open.
      void restoring;
      if (disposed) throw new RuntimeError('disconnected');
      initialized = true;
      const heard = early;
      early = null;
      heard.forEach(changed);
      if (!callback) {
        // The silent attempt left without an answer is over.
        if (silentState !== undefined) noteSilent('tried');
        if (silentNote === null) {
          // Nothing stored, judged by the durable listing: a record that an
          // app policy (`allowedPods`) hides is still an existing
          // installation. Only addresses this start deletes (`rememberPods:
          // false`) and the abandoned silent attempt are as if never stored.
          if (
            listing.unreadable.length === 0 &&
            listing.records.every(
              (saved) =>
                abandonedSilent.has(saved.id) || forgotten.includes(saved),
            )
          )
            await signInSilently();
          // An existing installation: this tab never signs in silently, also
          // after a sign-out that deletes its records.
          else noteSilent('tried');
        }
        return report;
      }
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
      // The note keeps the silent attempt's state until `redeem` has claimed
      // its callback: a callback for another state, or one refused before
      // the claim, leaves it, so the real answer is still known as the
      // silent one. Any other callback is an existing installation's, which
      // never signs in silently in this tab.
      const silent =
        silentState !== undefined &&
        pending.value.attempt.state === silentState;
      if (!silent && silentNote === null) noteSilent('tried');
      try {
        const connectionId = await redeem(
          pending.id,
          pending.revision,
          location,
          destination,
          pending.value.previous !== undefined,
          silent,
        );
        return { ...report, interaction: 'completed', connectionId };
      } catch (error) {
        const problem = silent ? declined(error) : undefined;
        if (!problem || !entries.has(pending.id)) throw error;
        const failure = (error as OAuthError).reason;
        return {
          ...report,
          firstSignIn: Object.freeze({
            connectionId: pending.id,
            problem,
            ...(failure.code === 'oauth' && failure.providerLink
              ? { providerLink: failure.providerLink }
              : {}),
          }),
        };
      }
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
      if (readsAnonymously && initialized && !disposed) {
        // Remembered Pods, and attempts that ended without a session, read
        // without a token once the callback no longer needs their records.
        let changed = false;
        for (const e of entries.values()) changed = settle(e) || changed;
        if (ensureDefault() || changed) publish();
      }
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
    const operation = retire(e, 'disconnected', deleting, true)
      .then(
        (kept) => {
          if (entries.get(id) === e) {
            // Without sign-in, a sign-out keeps the connection to read
            // without a token, also when its address is not remembered.
            if (kept || (readsAnonymously && !forget)) {
              // Only a remembered address keeps why it was signed out: one
              // not kept (`rememberPods: false`) is as if never signed in.
              e.view = {
                ...e.view,
                session: Object.freeze(
                  kept
                    ? { kind: 'signed-out', problem: 'disconnected' }
                    : { kind: 'signed-out' },
                ),
              };
              settle(e);
            } else {
              entries.delete(id);
              ensureDefault();
            }
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
    delete e.anonymous;
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
  const runtime: BrowserRuntime = {
    ...(preset ? { preset } : {}),
    ...(allowedPods ? { allowedPods } : {}),
    signIn,
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
      if (
        !initialized ||
        disposed ||
        url === undefined ||
        !allows(url) ||
        (signIn === 'none' && url !== defaultPodUrl)
      )
        throw new RuntimeError('configuration');
      for (;;) {
        const matches = [...entries.values()].filter(
          (e) => e.view.podUrl === url,
        );
        // Legacy live sessions remain independent. Prefer one to an old
        // address-only entry; the controller can preserve its active match.
        const existing =
          matches.find((e) => e.view.session.kind !== 'signed-out') ??
          matches[0];
        const pending = existing && disconnects.get(existing.view.id);
        if (!pending) {
          if (existing) return existing.view;
          break;
        }
        const result = await pending.operation;
        if (disposed) throw new RuntimeError('disconnected');
        if (result.kind === 'blocked-locally')
          throw new RuntimeError('storage');
        // Retirement may have removed it or another connect replaced it.
      }
      const pending = connecting.get(url);
      if (pending) return pending;
      const operation = (async () => {
        // A connection another tab saved for this Pod (signed in, remembered
        // or being signed in to) is this tab's too; alone, no other tab
        // saves any.
        const saved = await savedFor(url);
        if (saved) admit(saved);
        if (disposed) throw new RuntimeError('disconnected');
        /** One listed meanwhile, also announced by another tab. */
        const listed = () =>
          [...entries.values()].find((x) => x.view.podUrl === url)?.view;
        const found = listed();
        if (found) return found;
        if (readsAnonymously) {
          // Reading needs neither discovery nor a client: a sign-in
          // discovers the Pod and resolves the client itself. Creating the
          // client validates the address.
          const e = addAnonymous(url);
          publish();
          return e.view;
        }
        const pod = await discover(url, runtimeLifetime.signal);
        const client = await registry.resolve(pod, identity!);
        if (disposed) throw new RuntimeError('disconnected');
        const meanwhile = listed();
        if (meanwhile) return meanwhile;
        const e = createEntry(url, pod, client);
        entries.set(e.view.id, e);
        publish();
        return e.view;
      })();
      connecting.set(url, operation);
      try {
        return await operation;
      } finally {
        if (connecting.get(url) === operation) connecting.delete(url);
      }
    },
    async beginAuthorization(id, { intent = 'sign-in' } = {}) {
      if (
        !initialized ||
        disposed ||
        signIn === 'none' ||
        (intent !== 'sign-in' && intent !== 'change-sharing')
      )
        throw new RuntimeError('configuration');
      return authorize(id, intent);
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
          (options.podFactory ?? createPod)(e.view.podUrl, {
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
        admission,
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
      if (!isContextIri(contextIri, e.view.podUrl))
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
      runtimeLifetime.abort();
      page.removeEventListener?.('online', online);
      page.removeEventListener?.('pageshow', shown);
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
  activeMemories.set(runtime, contexts.active);
  return runtime;
}
