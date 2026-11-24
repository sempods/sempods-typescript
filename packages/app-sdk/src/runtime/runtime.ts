import {
  prepareSessionAuthorization,
  safeReturnTo,
  type SessionAttempt,
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
  attemptOf,
  beside,
  openPending,
  recordGeneration,
  recordPodUrl,
  replacesAddress,
  sessionBinding,
  type RefreshResend,
  type BoundSessionRecord,
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
import { connectionRemovals } from './removals.js';

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
/**
 * How long saving an added Pod's address waits for another tab holding that
 * Pod's connect lock before the Pod is listed in this page only.
 */
const ADDRESS_LOCK_WAIT = 3_000;
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

/**
 * One redirect to a Pod's sign-in: whether its `navigate` cancels it on the
 * signal itself (`owned`), whether that call is still running (`calling`),
 * and whether the page stayed meanwhile (`stayed`), so the document stop
 * waits for its answer.
 */
interface Navigation {
  readonly controller: AbortController;
  owned: boolean;
  calling: boolean;
  stayed: boolean;
}
/** Stops a navigation of this document still loading. */
function stopDocument() {
  (globalThis as { stop?: () => void }).stop?.();
}

/** Creates no storage, request or navigation until initialize/connect is called. */
/** A first sign-in's attempt write, as `dispose()` settles it (`owed`). */
interface OwedWrite {
  readonly id: string;
  readonly podUrl: string;
  /** The revision of an attempt the write saved over an address, once it settled. */
  readonly settled: Promise<string | undefined>;
}
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
   * This tab's note that it tried the silent first sign-in (`tried`; SDK 0.9
   * also noted `attempt:` and its state, read as tried). Read lazily:
   * construction touches no storage.
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
  /** Replaces the callback address, without a history entry. */
  const replaceUrl = (url: string) =>
    (
      options.replaceUrl ??
      ((url) => window.history.replaceState(null, '', url))
    )(url);
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
  /** Abandons this page's redirect of a `leaving` connection; see `watchReturn`. */
  const abandons = new Map<
    string,
    {
      readonly abandon: (staying: boolean) => boolean;
      readonly navigation: Navigation;
    }
  >();
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
  /** How often each ID was removed (`connectionRemovals`). */
  const removals = new Map<string, number>();
  /** Removes a connection; one added again under its ID is another one. */
  const dropEntry = (id: string) => {
    if (entries.delete(id)) removals.set(id, (removals.get(id) ?? 0) + 1);
  };
  const listeners = new Set<() => void>();
  /**
   * First sign-ins' attempt writes whose page has not left for the Pod yet,
   * also while in flight: `dispose()` waits for each and puts back the
   * address an attempt replaced (#372), only while that attempt is
   * unchanged, before it closes the store.
   */
  const owed = new Set<OwedWrite>();
  /** The owed cleanup still running, which every close of the store waits for. */
  let cleanup: Promise<unknown> = Promise.resolve();
  /**
   * Closes `closing` once every owed attempt write has settled and the
   * address it replaced is back (#372). Every close goes through here, so a
   * second `dispose()` or a failed start's own close waits for the first.
   */
  function closeStore(closing: SessionLease | undefined) {
    if (!closing) return;
    const writes = [...owed];
    owed.clear();
    const shared = sessions;
    const run = Promise.allSettled(
      writes.map(async (w) => {
        const revision = await w.settled;
        if (revision !== undefined && shared)
          await shared.remember(w.id, w.podUrl, revision);
      }),
    );
    cleanup = Promise.allSettled([cleanup, run]);
    // A replacement runtime in this page waits for this close (#419).
    closing.close(cleanup);
  }
  const disconnects = new Map<
    string,
    {
      /**
       * A forget: it deletes the record. A sign-out under `rememberPods:
       * false` may put an address back instead (#372), so a forget asked
       * meanwhile runs after it.
       */
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
   * the connection's lifetime ends (or `signal` aborts); `e`'s queued writes
   * land before it passes on.
   */
  function locked<T>(
    name: string,
    e: Entry,
    work: () => Promise<T>,
    signal = e.lifetime.signal,
  ): Promise<T> {
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
  /**
   * Whether this tab signed the connection out or forgot it: in progress,
   * done, or blocked locally because it could not be saved.
   */
  function signedOutHere(e: Entry) {
    const s = e.view.session;
    return (
      disconnects.has(e.view.id) ||
      ((s.kind === 'ended' || s.kind === 'signed-out') &&
        s.problem === 'disconnected')
    );
  }
  /** Whether the connection has, or is getting, a session another tab may end. */
  function inSession(e: Entry) {
    const s = e.view.session;
    return s.kind !== 'signed-out' && !(s.kind === 'ended' && !s.restorable);
  }
  /**
   * Follows what another tab stored for this connection. A renewal of this
   * session is used here too and a refresh another tab claimed for it stays
   * that tab's (see `latest`); anything else lists the record anew, as a
   * start would (`replace`). Runs inside `serial`; returns whether it changed
   * this tab's connection.
   */
  function adopt(e: Entry, stored: SessionSnapshot | undefined): boolean {
    if ((stored?.revision ?? null) === e.revision) return false;
    if (entries.get(e.view.id) !== e || disposed) return false;
    // This tab's own sign-out or forget continues on the newer record.
    if (disconnects.has(e.view.id)) {
      e.revision = stored?.revision ?? null;
      return false;
    }
    const value = stored?.value;
    const same = value && recordGeneration(value) === e.generation;
    // A sign-out or forget here that could not be saved keeps this session
    // blocked, and a retry applies to the newer record; only a new sign-in
    // elsewhere, or a sign-out there that saves a sign-out, replaces it.
    const s = e.view.session;
    // A page that left to re-authorize covers the session it left from too.
    const covered =
      same ||
      (value !== undefined &&
        e.leftFrom !== undefined &&
        recordGeneration(value) === e.leftFrom);
    if (
      covered &&
      s.kind === 'ended' &&
      s.problem === 'disconnected' &&
      s.saved === false &&
      (value.kind !== 'disconnected' || e.forgetting)
    ) {
      e.revision = stored!.revision;
      return false;
    }
    // This page leaves for its re-authorization, which other tabs' renewals
    // keep pending: it stays leaving (see `watchReturn`).
    if (
      s.kind === 'leaving' &&
      openPending(value)?.attempt.generation === e.generation
    ) {
      e.revision = stored!.revision;
      return false;
    }
    if (same && !e.lifetime.signal.aborted) {
      // A re-authorization started or ended elsewhere leaves this session
      // as it is, apart from reading Context access again (`noteAttempt`).
      if (
        value.kind === 'ready' &&
        (s.kind === 'active' || s.kind === 'renewing') &&
        e.credentials?.accessToken === value.credentials.accessToken &&
        e.credentials.refreshToken === value.credentials.refreshToken &&
        sameBinding(e, value)
      ) {
        e.revision = stored!.revision;
        noteAttempt(e, value);
        return false;
      }
      // Its result follows here when this tab uses or restores the session;
      // a tab not in it lists the claim anew, and the refresh lock decides
      // whether it is due a resend.
      if (
        value.kind === 'claimed' &&
        value.operation === 'refresh' &&
        inSession(e)
      )
        return false;
      // Only under the binding this connection has: a grant under another
      // client is restored as a start restores it, which checks its binding
      // and takes its client.
      if (value.kind === 'ready' && sameBinding(e, value)) {
        e.revision = stored!.revision;
        if (e.lost) clearTimeout(e.lost.timer);
        delete e.lost;
        delete e.restorable;
        install(e, value.credentials);
        // A renewal elsewhere that dropped an attempt this tab saw.
        noteAttempt(e, value);
        return true;
      }
    }
    replace(e, stored);
    return true;
  }
  /**
   * Another tab's sign-in to join: a session, or its refresh claim that no
   * tab sends (read under the refresh lock) while it can still be resent.
   */
  function holdsSession(value: SessionRecord) {
    if (value.kind === 'ready') return true;
    if (value.kind !== 'claimed' || value.operation !== 'refresh') return false;
    const { resend } = value;
    return !!resend && !resend.resent && withinGrace(resend.sentAt);
  }
  /** Whether `value` binds the client and scopes this connection uses. */
  function sameBinding(e: Entry, value: BoundSessionRecord) {
    const b = sessionBinding(value);
    return (
      e.client?.clientId === b.client.clientId &&
      e.client.issuer === b.client.issuer &&
      e.view.requestedScopes.length === b.scopes.length &&
      e.view.requestedScopes.every((s) => b.scopes.includes(s))
    );
  }
  /**
   * Lists the record anew, as a start would, in place of `e`: nothing of this
   * tab's connection continues. A deleted record removes the connection and
   * the Context chosen for it.
   */
  function replace(e: Entry, stored: SessionSnapshot | undefined) {
    const id = e.view.id;
    const next = stored && fromRecord(stored);
    if (next) swap(e, next);
    else {
      dropEntry(id);
      stop(e, { kind: 'signed-out' });
    }
    if (next) {
      settle(next);
      begin(next, stored!.value);
    } else {
      contexts.forget(id);
      ensureDefault();
      // Another record for the Pod may remain, as when a start removed this
      // one as a duplicate: it is listed instead.
      if (lease?.store.watch)
        void savedFor(e.view.podUrl)
          .then((saved) => saved && admit(saved))
          .catch(() => {
            // Listed by the next start.
          });
    }
    publish();
  }
  /**
   * Puts `next` in place of `e`, first, so the old connection does not settle
   * to read without a token, and keeps its place in the list; nothing of `e`
   * continues. Publishes nothing itself.
   */
  function swap(e: Entry, next: Entry) {
    entries.set(e.view.id, next);
    stop(e, { kind: 'signed-out' });
  }
  /**
   * A connection for a saved record, as a start lists it: a session or a
   * refresh claim restores (also while a re-authorization of it is pending),
   * a remembered address and a silent first sign-in under way are signed
   * out, and another sign-in under way shows as interrupted.
   */
  function fromRecord(saved: SessionSnapshot): Entry {
    const value = saved.value;
    if (value.kind === 'address') {
      // A Pod never signed in to: neither discovered nor bound to a client.
      const e = createEntry(value.podUrl, undefined, undefined, saved.id);
      e.revision = saved.revision;
      return e;
    }
    const b = sessionBinding(value);
    const e = createEntry(
      b.pod.podUrl,
      b.pod,
      b.client,
      saved.id,
      b.generation,
    );
    e.revision = saved.revision;
    if (value.kind === 'disconnected') {
      // A retired record holds only the address (binding) and why its
      // session ended: a remembered Pod, signed out.
      e.view = { ...e.view, session: signedOut(value.reason) };
      return e;
    }
    if (value.kind === 'authorizing' && value.silent) {
      // Signed out, with the scopes its answer is checked against.
      e.view = { ...e.view, requestedScopes: b.scopes };
      return e;
    }
    if (value.kind === 'ready' || value.kind === 'claimed')
      e.attemptEnded = value.attemptEnded;
    const problem = interruption(value);
    const restores =
      value.kind === 'ready' ||
      (value.kind === 'claimed' && value.resend !== undefined);
    e.view = {
      ...e.view,
      requestedScopes: b.scopes,
      session: Object.freeze(
        restores ? { kind: 'restoring' } : { kind: 'ended', problem },
      ),
    };
    return e;
  }
  /** How a sign-in under way elsewhere, or left, shows here. */
  function interruption(value: SessionRecord): RuntimeProblem {
    return value.kind === 'authorizing' && value.attempt.expiresAt <= Date.now()
      ? 'expired'
      : 'interrupted';
  }
  /**
   * Starts what `fromRecord` lists as restoring: a session restores, and a
   * refresh claim no tab finished is resent once within the grace period
   * (also one of SDK 0.8), or ends as `interrupted`.
   */
  function begin(e: Entry, value: SessionRecord) {
    if (value.kind === 'ready') void restore(e, value);
    else if (value.kind === 'claimed' && value.resend) void resumeLost(e);
  }

  /**
   * Lists a connection another tab saved, which this tab does not list yet
   * (a sign-in there, or a Pod remembered there), so one Pod address keeps
   * one saved connection. A connection of this tab to the same Pod without a
   * record of its own and without a session gives way to it. With
   * `rememberPods: false` this tab lists no address another tab remembers,
   * as its start deletes them: its own connection to that Pod stays in this
   * page; a sign-in to that Pod there saves its attempt on that address
   * (`prepareAuthorization`). Returns whether the record is listed now.
   */
  function admit(stored: SessionSnapshot): boolean {
    if (disposed || !initialized || entries.has(stored.id)) return false;
    if (!rememberPods && stored.value.kind === 'address') return false;
    const podUrl = recordPodUrl(stored.value);
    if (!allows(podUrl)) return false;
    const same = [...entries.values()].filter((x) => x.view.podUrl === podUrl);
    if (
      same.some(
        (x) =>
          x.revision !== null ||
          inSession(x) ||
          disconnects.has(x.view.id) ||
          preparing.has(x.view.id) ||
          // It still puts back the address that record replaced (#372).
          x.wroteOn !== undefined,
      )
    )
      return false;
    for (const x of same) {
      // Removed first, so it does not settle to read without a token.
      dropEntry(x.view.id);
      stop(x, { kind: 'signed-out' });
    }
    const e = fromRecord(stored);
    entries.set(stored.id, e);
    settle(e);
    begin(e, stored.value);
    publish();
    return true;
  }
  /**
   * The record another tab saved for `podUrl`, with a shared store: a
   * session first, then a remembered address, then a sign-in under way, then
   * the address of a Pod never signed in to.
   * Rejects with `storage` when the records cannot be listed.
   */
  async function savedFor(podUrl: string) {
    if (!sessions || !lease?.store.watch) return undefined;
    let records: readonly SessionSnapshot[];
    try {
      ({ records } = await sessions.list());
    } catch {
      throw new RuntimeError('storage');
    }
    const saved = records.filter((r) => recordPodUrl(r.value) === podUrl);
    return (
      saved.find((r) => r.value.kind === 'ready') ??
      saved.find((r) => r.value.kind === 'disconnected') ??
      saved.find((r) => r.value.kind !== 'address') ??
      saved[0]
    );
  }
  /**
   * Lists a record another tab announced. Listed meanwhile (by an earlier
   * announcement's read), the connection reads it again in turn instead.
   */
  function announced(id: string) {
    void sessions
      ?.read(id)
      .then((stored) => {
        const listed = entries.get(id);
        if (listed) void sync(listed);
        else if (stored) admit(stored);
      })
      .catch(() => {
        // Listed by the next start.
      });
  }
  /**
   * Reads the record again and adopts what another tab stored; best effort.
   * A read queued for a connection replaced meanwhile reads for the one that
   * replaced it.
   */
  function sync(e: Entry): Promise<void> {
    return serial(e, async () => {
      if (!sessions || disposed) return undefined;
      if (entries.get(e.view.id) !== e) return entries.get(e.view.id);
      adopt(e, await sessions.read(e.view.id));
      return undefined;
    }).then(
      (successor) => (successor ? sync(successor) : undefined),
      () => {
        // An unreadable record is listed by the next start.
      },
    );
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
          e.revision = stored.revision;
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
  /**
   * Under `rememberPods`, saves the address of `e`, a Pod other than the
   * default one read without a token and not listed yet, so the next start
   * lists it again; with a shared store, under the Pod's lock, so two tabs do
   * not both save one. Returns the record another tab saved for the Pod
   * meanwhile instead. Best effort: unsaved, the Pod is listed in this page
   * only.
   */
  async function rememberAddress(
    e: Entry,
  ): Promise<SessionSnapshot | undefined> {
    const shared = sessions;
    // The default Pod is listed on every start anyway.
    if (!rememberPods || !shared || e.view.podUrl === defaultPodUrl)
      return undefined;
    const save = async () => {
      const saved = await savedFor(e.view.podUrl);
      if (saved) return saved;
      const change = await shared.remember(e.view.id, e.view.podUrl);
      if (change.kind === 'committed') e.revision = change.record.revision;
      return undefined;
    };
    if (!lease?.store.watch) return save().catch(() => undefined);
    // Waiting for another tab's lock ends with the runtime (the connection
    // is not listed yet, so `dispose` reaches it only that way) and after
    // ADDRESS_LOCK_WAIT: a tab suspended while holding it does not keep this
    // page from reading the Pod, which is then listed here only.
    const patience = new AbortController();
    const timer = setTimeout(() => patience.abort(), ADDRESS_LOCK_WAIT);
    const waiting = combineSignals(
      runtimeLifetime.signal,
      e.lifetime.signal,
      patience.signal,
    );
    try {
      return await locked(
        `sempods:connect:${namespace}:${e.view.podUrl}`,
        e,
        save,
        waiting.signal,
      );
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      waiting.dispose();
    }
  }
  /** A connection without discovery or client that reads without a token. */
  function anonymousEntry(podUrl: string, id?: string) {
    const e = createEntry(podUrl, undefined, undefined, id);
    e.anonymous = true;
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
    entries.set(defaultPodUrl, anonymousEntry(defaultPodUrl, defaultPodUrl));
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
  /** Whether `e`'s record is a first sign-in that replaced an address. */
  async function replacingAddress(e: Entry) {
    const stored = await sessions!.read(e.view.id);
    return stored?.revision === e.revision && replacesAddress(stored.value);
  }
  /**
   * Retires the saved session: keeps only the address and why it ended
   * (`reason`), or deletes the record (`deleting`). Resolves the kind of the
   * record that stays; without one, nothing is remembered.
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
  ): Promise<SessionRecord['kind'] | undefined> {
    return serial(e, async () => {
      // An attempt a cancelled sign-in here saved on another tab's address
      // (#372) is put back first; a failure is this retirement's.
      await restoreWritten(e);
      for (let round = 0; ; round++) {
        if (!sessions || !e.revision) {
          contexts.forget(e.view.id);
          return undefined;
        }
        // A session that ended here (not a sign-out) while a
        // re-authorization of it is out: its attempt becomes the record,
        // which its callback signs in with.
        const handing = !insist;
        // A first sign-in that replaced another tab's address (#372) puts
        // it back rather than delete it, unless it is forgotten.
        if (!deleting || (!e.forgetting && (await replacingAddress(e)))) {
          const change = await sessions.disconnect(
            e.view.id,
            e.revision,
            reason,
            handing,
          );
          if (change.kind === 'committed') {
            e.revision = change.record.revision;
            return change.record.value.kind;
          }
        } else {
          const handed = handing
            ? await sessions.handOver(e.view.id, e.revision)
            : undefined;
          if (handed?.kind === 'committed') {
            e.revision = handed.record.revision;
            return handed.record.value.kind;
          }
          if (!handed && (await remove(e.view.id, e.revision))) {
            e.revision = null;
            return undefined;
          }
        }
        const stored = await sessions.read(e.view.id);
        if (!insist) {
          adopt(e, stored);
          return stored?.value.kind;
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
    await finishRenewal(e, generation, pod, claim, sent.result);
    return 'installed';
  }
  /**
   * Stores a renewal's checked result and uses it here. A renewal that
   * dropped a re-authorization (expired, or claimed by a tab that closed
   * during its exchange) also reads Context access again (`noteAttempt`).
   */
  async function finishRenewal(
    e: Entry,
    generation: string,
    pod: PodDiscovery,
    claim: { complete(result: ExchangeResult): Promise<SessionChange> },
    result: ExchangeResult,
  ) {
    const change = await serial(e, async () => {
      current(e, generation);
      const change = await claim.complete(result);
      accepted(e, change);
      return change;
    });
    current(e, generation);
    e.pod = pod;
    install(e, result);
    if (change.kind === 'committed') noteAttempt(e, change.record.value);
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
    await finishRenewal(e, generation, pod, claim, sent.result);
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

  /**
   * Reads Context access again after a consent outcome: once a catalogue
   * read under way settled, as it may describe the access from before. Only
   * for a connection whose catalogue the app read.
   */
  function recheckAccess(
    e: Entry,
    /**
     * A catch-up without an outcome of its own (a page back from the
     * back/forward cache): a recheck read under way answers it.
     */
    join = false,
  ) {
    if (e.view.catalogue.kind === 'unknown') return;
    if (e.catalogue && e.catalogue === e.rechecking) {
      // A new consent outcome during a recheck read: once more after it.
      if (!join) e.recheckAgain = true;
      return;
    }
    // The read itself invalidates exactly the Contexts whose access changed.
    const generation = e.generation;
    const again = () => {
      if (!eligible(e, generation)) return;
      const read = load(e);
      e.rechecking = read;
      void read
        .catch(() => {})
        .finally(() => {
          if (e.rechecking !== read) return;
          delete e.rechecking;
          if (e.recheckAgain) {
            delete e.recheckAgain;
            recheckAccess(e);
          }
        });
    };
    if (e.catalogue) void e.catalogue.then(again, again);
    else again();
  }
  /**
   * Follows the record's `attemptEnded` marker: a re-authorization that
   * ended without a new grant (denied, failed, dropped by a renewal), also
   * one this tab never saw, may still have changed what the Pod grants (a
   * removed access, a narrower choice whose answer was lost), so Context
   * access is read again.
   */
  function noteAttempt(e: Entry, value: SessionRecord) {
    if (value.kind !== 'ready' && value.kind !== 'claimed') return;
    if (value.attemptEnded === e.attemptEnded) return;
    e.attemptEnded = value.attemptEnded;
    recheckAccess(e);
  }
  /** Counts the browser's `online` events, so a restoration knows it missed one. */
  let onlineEvents = 0;
  /** Restores one saved signed-in Pod; publishes its own outcome (`active`/`ended`). */
  async function restore(
    e: Entry,
    saved: Extract<SessionRecord, { kind: 'ready' }>,
    /** The Pod as just discovered, which this restoration then uses. */
    known?: PodDiscovery,
  ) {
    const generation = e.generation;
    const events = onlineEvents;
    // Another tab may renew the session meanwhile, which this tab installs.
    const newer = () => e.view.session.kind !== 'restoring';
    try {
      const pod = known ?? (await discover(e.view.podUrl, e.lifetime.signal));
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
    // The record restoration listed; another tab's renewal, installed while
    // this tab waited for the lock, replaces it (and its spent refresh token).
    const fresh = () => e.view.session.kind === 'restoring';
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
    if (e.relisting) {
      // A page that stayed, whose record could not be read.
      const { leftFrom } = e.relisting;
      delete e.relisting;
      e.view = { ...e.view, session: Object.freeze({ kind: 'restoring' }) };
      publish();
      await relist(e, leftFrom);
      return;
    }
    if (lost && eligible(e, lost.generation)) {
      // Offline still: keep the one resend for later.
      if (offline() && withinGrace(lost.sentAt)) return;
      clearTimeout(lost.timer);
      delete e.lost;
      e.view = { ...e.view, session: Object.freeze({ kind: 'restoring' }) };
      publish();
      await resumeLost(e, lost.pod);
      // Its renewal compared the marker; a catalogue the page kept may wait.
      caughtUp(e);
      return;
    }
    if (!saved) return;
    delete e.restorable;
    e.view = { ...e.view, session: Object.freeze({ kind: 'restoring' }) };
    publish();
    await restore(e, saved);
    // Also a relisted page whose first restoration could not reach its Pod.
    caughtUp(e, saved);
  }
  /**
   * After a restoration that keeps a page's view (`relist`): what that view
   * has not seen yet. A start's own view has seen nothing, so this does
   * nothing there. `value` is the record restored, absent after a resent
   * renewal, which compared its own.
   */
  function caughtUp(
    e: Entry,
    value?: Extract<SessionRecord, { kind: 'ready' }>,
  ) {
    if (!eligible(e) || e.view.session.kind !== 'active') return;
    // A consent that ended meanwhile reads Context access again. A renewal
    // installed instead (here or by another tab) already compared its own,
    // newer record.
    if (value && e.credentials === value.credentials) noteAttempt(e, value);
    // A catalogue read the leaving page aborted starts again, keeping the
    // contexts it already confirmed.
    if (e.view.catalogue.kind === 'loading' && !e.catalogue)
      void load(e).catch(() => {});
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
  // announcements: it reads every record again. Records it does not list
  // yet are listed after its connections followed theirs, so a connection
  // another tab forgot meanwhile no longer keeps its Pod's new one out.
  const shown = (event?: unknown) => {
    if (!(event as { persisted?: boolean } | undefined)?.persisted) return;
    const synced = Promise.all([...entries.values()].map(sync));
    // A consent round trip it missed usually shows as a changed
    // `attemptEnded`; what no record shows (an SDK 0.9 tab dropping an
    // attempt, a change at the Pod) is read again here as well.
    void synced.then(() => {
      for (const e of entries.values())
        if (
          e.view.session.kind === 'active' ||
          e.view.session.kind === 'renewing'
        )
          recheckAccess(e, true);
    });
    if (lease?.store.watch)
      void synced
        .then(() => sessions?.list())
        .then((listing) => listing?.records.forEach(admit))
        .catch(() => {
          // Listed by the next start.
        });
  };
  page.addEventListener?.('pageshow', shown);
  /**
   * Lists a connection's record anew, whatever its revision: for a page that
   * left for a sign-in and stays or comes back (see `watchReturn`). A session
   * it left to re-authorize restores at once, keeping the page's Context
   * choice and catalogue; handles of the page's earlier lifetime stay
   * retired.
   */
  function relist(
    e: Entry,
    /** The generation of the session the page showed; only its view is kept. */
    leftFrom?: string,
    /** The Pod as just discovered (the callback's), for its restoration. */
    pod?: PodDiscovery,
  ): Promise<void> {
    return serial(e, async () => {
      if (!sessions || disposed || entries.get(e.view.id) !== e) return;
      // A sign-out here, saved or not, stays as it is.
      if (signedOutHere(e)) return;
      const stored = await sessions.read(e.view.id);
      if (entries.get(e.view.id) !== e || disposed) return;
      // Also one that started while the record was read.
      if (signedOutHere(e)) return;
      const value = stored?.value;
      // That session, or another tab's renewal of it under way.
      const session =
        value?.kind === 'ready' ||
        (value?.kind === 'claimed' &&
          value.operation === 'refresh' &&
          value.resend !== undefined);
      if (!session || e.view.session.kind !== 'restoring') {
        replace(e, stored);
        return;
      }
      // Another grant replaced that session meanwhile (another account,
      // other scopes): nothing of the page's view continues.
      if (value.binding.generation !== leftFrom) {
        replace(e, stored);
        return;
      }
      const { selectedContext, catalogue } = e.view;
      const next = fromRecord(stored!);
      next.view = { ...next.view, selectedContext, catalogue };
      // With the view, what that view has seen: an outcome it missed is
      // compared once the session is restored.
      next.attemptEnded = e.attemptEnded;
      swap(e, next);
      publish();
      return { next, value };
    })
      .then(async (restoring) => {
        if (!restoring) return;
        const { next, value } = restoring;
        if (value.kind === 'ready') {
          await restore(next, value, pod);
          caughtUp(next, value);
          return;
        }
        // The renewal's result follows under the refresh lock, compared as
        // the record it stores; one no tab finished is resent once.
        await resumeLost(next);
        caughtUp(next);
      })
      .catch(() => {
        // Unreadable now: shown as a storage problem the person can retry
        // (`retryRestore`, also on `online`), rather than restoring forever.
        if (
          disposed ||
          entries.get(e.view.id) !== e ||
          e.view.session.kind !== 'restoring'
        )
          return;
        e.relisting = leftFrom === undefined ? {} : { leftFrom };
        e.view = {
          ...e.view,
          session: Object.freeze({
            kind: 'ended',
            problem: 'storage',
            restorable: true,
          }),
        };
        publish();
      });
  }
  /**
   * A page that left for a sign-in and comes back from the back/forward
   * cache (`pageshow`), or stays (`cancelAuthorization`), without a callback.
   * The stored attempt stays for its callback, a newer attempt, a sign-out
   * or its expiry; the page lists the record anew, as a start would: a
   * re-authorized session restores at once, and a silent first sign-in is
   * signed out. A first sign-in the page stays for ends here.
   */
  function watchReturn(
    e: Entry,
    generation: string,
    navigation: Navigation,
    /** The silent first sign-in. */
    silent: boolean,
  ) {
    // A re-authorization stored beside the session it left from (`leftFrom`).
    const leftFrom = e.leftFrom;
    const kind = silent
      ? 'silent'
      : leftFrom !== undefined
        ? 'reauthorize'
        : 'first';
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
    const id = e.view.id;
    const stop = () => {
      page.removeEventListener?.('pageshow', shown);
      if (abandons.get(id)?.abandon === abandon) abandons.delete(id);
    };
    function abandon(staying: boolean) {
      stop();
      if (!eligible(e, generation) || e.view.session.kind !== 'leaving')
        return false;
      navigation.controller.abort(new RuntimeError('interrupted'));
      if (kind === 'first' && staying) {
        end(e, new RuntimeError('interrupted'), true, false);
        return true;
      }
      if (kind === 'silent') noteSilent('tried');
      // Shown at once; the record then decides.
      e.view = {
        ...e.view,
        session: Object.freeze(
          kind === 'reauthorize'
            ? { kind: 'restoring' }
            : kind === 'silent'
              ? { kind: 'signed-out' }
              : { kind: 'ended', problem: 'interrupted' },
        ),
      };
      publish();
      void relist(e, leftFrom);
      return true;
    }
    function shown(event: Event) {
      if ((event as Event & { persisted?: boolean }).persisted) abandon(false);
    }
    abandons.set(id, { abandon, navigation });
    page.addEventListener?.('pageshow', shown);
    e.lifetime.signal.addEventListener('abort', stop, { once: true });
  }
  /**
   * Exchanges a code within one token timeout (also for a `fetch` that
   * ignores its signal); a late answer is dropped as `interrupted`.
   */
  async function exchangeWithin(attempt: SessionAttempt, location: URL) {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new RuntimeError('interrupted')),
      TOKEN_TIMEOUT,
    );
    const signal = combineSignals(runtimeLifetime.signal, timeout.signal);
    const send: NonNullable<typeof protocol.fetch> =
      protocol.fetch ?? ((url, init) => globalThis.fetch(url, init));
    // Connected until the exchange settles, which reads the answer's body.
    const requests: { dispose(): void }[] = [];
    try {
      return await waitFor(
        exchangeAuthorization(attempt, location, {
          ...protocol,
          fetch: (url, init) => {
            // The deadline aborts the request too, beside the library's own
            // signal.
            const both = combineSignals(
              init?.signal ?? undefined,
              signal.signal,
            );
            requests.push(both);
            return send(url, { ...init, signal: both.signal });
          },
        }),
        signal.signal,
      );
    } catch (error) {
      if (runtimeLifetime.signal.aborted)
        throw new RuntimeError('disconnected');
      if (timeout.signal.aborted) throw new RuntimeError('interrupted');
      throw error;
    } finally {
      clearTimeout(timer);
      for (const request of requests) request.dispose();
      signal.dispose();
    }
  }
  /**
   * Completes a re-authorization's callback on the session it was pending
   * for. Under that connection's refresh lock, waited for at most as long as
   * a refresh with its discovery and one resend takes (`coordination` past
   * it), the code is claimed and exchanged within a deadline. Only a
   * validated result, stored, replaces the session (in every tab:
   * `completed`). Any other answer drops the attempt and leaves the session
   * (`kept`, with the cause). Rejects when the attempt is gone, forged or
   * waited for too long (the record is unchanged), or when a sign-out or
   * forget meanwhile stays in effect.
   */
  async function reauthorize(
    id: string,
    attempt: SessionAttempt,
    location: URL,
    destination: string,
  ): Promise<
    | { readonly kind: 'completed' }
    | {
        readonly kind: 'kept';
        readonly error: unknown;
        /** The Pod as discovered for the callback, for the restoration. */
        readonly pod: PodDiscovery;
      }
  > {
    const shared = sessions!;
    const e = get(id);
    const pod = await discover(e.view.podUrl, runtimeLifetime.signal);
    if (disposed) throw new RuntimeError('disconnected');
    const expected: SessionBinding = {
      configKey: namespace,
      connectionId: id,
      generation: attempt.generation,
      pod,
      client: attempt.client,
      scopes: attempt.scopes,
    };
    const waiting = new AbortController();
    const timer = setTimeout(
      () => waiting.abort(),
      // With a margin for the holder's own storage writes.
      DISCOVERY_TIMEOUT + 2 * TOKEN_TIMEOUT + 5_000,
    );
    const signal = combineSignals(runtimeLifetime.signal, waiting.signal);
    type Outcome =
      | {
          readonly kind: 'completed';
          readonly record: SessionSnapshot;
          readonly result: ExchangeResult;
        }
      | { readonly kind: 'kept'; readonly error: unknown };
    let outcome: Outcome;
    try {
      outcome = await locked<Outcome>(
        `sempods:refresh:${namespace}:${id}`,
        e,
        async () => {
          clearTimeout(timer);
          // A session that ended between the read and the claim handed the
          // attempt over (`handOver`): claimed there on a second read.
          let claim = await shared.claimPending(id, expected, location);
          if (claim.kind === 'conflict')
            claim = await shared.claimPending(id, expected, location);
          if (claim.kind === 'conflict') throw new RuntimeError('attempt');
          if (claim.kind === 'answered') {
            if (!claim.kept) throw claim.error;
            return { kind: 'kept', error: claim.error };
          }
          replaceUrl(destination);
          try {
            const result = await exchangeWithin(claim.attempt, location);
            const change = await claim.complete(result);
            // A sign-out or forget meanwhile stays in effect.
            if (change.kind === 'conflict') throw conflict();
            return { kind: 'completed', record: change.record, result };
          } catch (error) {
            if (superseded(error)) throw error;
            if (
              error instanceof OAuthError &&
              error.problem === 'invalid-client'
            )
              registry.clear(e.view.podUrl);
            // Its code may be spent: the attempt is dropped either way.
            const left = await shared
              .discardPending(id, attempt.generation, runtimeProblem(error))
              .catch(() => 'none' as const);
            if (left === 'kept') return { kind: 'kept', error };
            // Not dropped here (storage, a newer attempt): the session stays
            // all the same while the record holds one.
            if (left === 'none') {
              const now = await shared.read(id).catch(() => undefined);
              if (beside(now?.value)) return { kind: 'kept', error };
            }
            throw error;
          }
        },
        signal.signal,
      );
    } catch (error) {
      if (waiting.signal.aborted && !runtimeLifetime.signal.aborted)
        throw new RuntimeError('coordination');
      throw error;
    } finally {
      clearTimeout(timer);
      signal.dispose();
    }
    if (disposed) throw new RuntimeError('disconnected');
    if (outcome.kind === 'kept') return { ...outcome, pod };
    // A sign-out or forget after the grant was stored stays in effect, also
    // one here that could not be saved: the grant is used only while this
    // tab has not signed out and the record still holds it.
    let now: SessionSnapshot | undefined;
    let read = true;
    try {
      now = await shared.read(id);
    } catch {
      // Unreadable now: the stored grant stands, and the next read corrects.
      read = false;
    }
    if (disposed) throw new RuntimeError('disconnected');
    const old = entries.get(id);
    if (old && signedOutHere(old)) {
      // That sign-out covers the stored grant: renewals of it elsewhere keep
      // this connection blocked (see `adopt`), and its retry retires it.
      old.generation = recordGeneration(outcome.record.value)!;
      throw new RuntimeError('disconnected');
    }
    if (!old || (read && (!now || now.value.kind === 'disconnected')))
      throw new RuntimeError('disconnected');
    if (old !== e || (read && now!.revision !== outcome.record.revision)) {
      // Changed meanwhile: the connection follows the record as it is now.
      void sync(old);
      return { kind: 'completed' };
    }
    // The new grant: nothing of the earlier session's connection continues.
    const next = fromRecord(outcome.record);
    next.pod = pod;
    swap(e, next);
    install(next, outcome.result);
    return { kind: 'completed' };
  }
  /** Redeems the callback's code once for its stored attempt; returns the connection. */
  async function redeem(
    id: string,
    revision: string,
    location: URL,
    destination: string,
    /** The silent first sign-in: a Pod that needs the person first ends nothing. */
    silent = false,
  ): Promise<string> {
    const e = get(id);
    const generation = e.generation;
    const pod = await discover(e.view.podUrl, e.lifetime.signal);
    const exchange = async () => {
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
      replaceUrl(destination);
      try {
        // A disposed page lets go of the lock, as a closed tab does, and so
        // does a connection that ended meanwhile (another tab signed out):
        // a late answer then installs nothing.
        const result = await waitFor(
          exchangeAuthorization(claim.attempt, location, protocol),
          runtimeLifetime.signal,
          e.lifetime.signal,
        );
        await serial(e, async () => {
          current(e, generation);
          accepted(e, await claim.complete(result));
        });
        return result;
      } catch (error) {
        if (eligible(e, generation)) {
          if (error instanceof OAuthError && error.problem === 'invalid-client')
            registry.clear(e.view.podUrl);
          if (silent && declined(error)) decline(e);
          else end(e, error, true, false);
          await e.persistence;
        }
        throw error;
      }
    };
    // Under the record's refresh lock with other tabs (#372): a first
    // sign-in another tab starts for this Pod meanwhile waits for this code
    // exchange and its outcome rather than replacing the claim, as it would
    // replace one a closed tab left.
    const result = lease?.store.watch
      ? await locked(`sempods:refresh:${namespace}:${id}`, e, exchange)
      : await exchange();
    current(e, generation);
    install(e, result);
    return e.view.id;
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
    } catch (error) {
      preparing.delete(id);
      // A record another tab saved for this Pod meanwhile was left to this
      // preparation, which did not get to it: listed now.
      listSavedFor(id);
      throw error;
    } finally {
      preparing.delete(id);
    }
  }
  /** Lists the record another tab saved for the Pod of `id`'s connection without one. */
  function listSavedFor(id: string) {
    const e = entries.get(id);
    if (!e || e.revision !== null || !lease?.store.watch) return;
    void savedFor(e.view.podUrl)
      .then((saved) => {
        if (!saved) return;
        const listed = entries.get(saved.id);
        if (listed) void sync(listed);
        else admit(saved);
      })
      .catch(() => {
        // Listed by the next start.
      });
  }
  /** A stored attempt, ready to leave for: its generation and URL. */
  type Prepared = { readonly generation: string; readonly url: string };
  /**
   * Puts back the address a cancelled sign-in of `e` saved its attempt over
   * (`wroteOn`, #372): a sign-out or forget here does as it retires `e`, and
   * reports a failure so a retry can; otherwise (a dispose, a newer sign-in)
   * at once, best effort.
   */
  async function unwrite(e: Entry) {
    if (!e.wroteOn || disconnects.has(e.view.id)) return;
    // Put back by `dispose()`.
    if (disposed) {
      delete e.wroteOn;
      return;
    }
    await restoreWritten(e).catch(() => {});
  }
  /** Puts back the address `e`'s sign-in saved an attempt over, if any. */
  async function restoreWritten(e: Entry) {
    const written = e.wroteOn;
    if (!written || !sessions) return;
    // A conflict: another tab changed the record since, which stays.
    await sessions.remember(written.id, written.podUrl, written.revision);
    if (e.wroteOn === written) delete e.wroteOn;
  }
  async function prepareAuthorization(
    id: string,
    intent: AuthorizationIntent | 'silent',
    replaced = false,
  ): Promise<void> {
    let e = get(id);
    // A first sign-in: the Pod was never discovered here, or another tab's
    // record replaced this connection while it was (`replaced`).
    const first = replaced || e.pod === undefined;
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
    const self = e;
    /** This sign-in's attempt over an address, until it leaves (`owed`). */
    let owing: OwedWrite | undefined;
    const preparation = {};
    self.preparation = preparation;
    /**
     * Whether this preparation still stores its attempt: not after a
     * sign-out, forget, dispose or a newer sign-in here; a session that
     * ended meanwhile is signed in to again.
     */
    const still = () =>
      !disposed &&
      entries.get(id) === self &&
      self.preparation === preparation &&
      !disconnects.has(id);
    /**
     * Another tab signed in, or began to, on the address both list (#372):
     * its record replaced this connection while discovery ran or this
     * sign-in waited for the Pod's lock. A session it stored is the result
     * of the sign-in asked for here, and a sign-in under way there is
     * followed rather than replaced: its session reaches this tab when it
     * completes. Otherwise (an expired attempt, a sign-out there) the
     * sign-in goes on on the replacing connection. A sign-out, forget or
     * dispose here still cancels it.
     */
    const reconcile = (error: unknown): Promise<void> => {
      const now = entries.get(id);
      if (
        !first ||
        disposed ||
        now === undefined ||
        now === self ||
        disconnects.has(id)
      )
        throw error;
      const s = now.view.session;
      if (
        s.kind === 'restoring' ||
        s.kind === 'active' ||
        s.kind === 'renewing' ||
        (s.kind === 'ended' && s.problem === 'interrupted')
      )
        return Promise.resolve();
      return prepareAuthorization(id, intent, true);
    };
    const signal = e.lifetime.signal;
    let pod: PodDiscovery;
    let client: OAuthClient;
    try {
      pod = await discover(e.view.podUrl, signal);
      current(e, before);
      client = await registry.resolve(pod, identity!, { signal });
      current(e, before);
    } catch (error) {
      return reconcile(error);
    }
    /**
     * Prepares and stores the attempt on `t`: this connection, or another
     * tab's address for the Pod, not listed until the attempt is stored (see
     * below). Nothing changes before it is stored.
     */
    const store = async (t: Entry = e) => {
      // `t` stores while this preparation does; another tab's address also
      // while it is not retired.
      const storing = () =>
        still() && (t === self || !t.lifetime.signal.aborted);
      const generation = crypto.randomUUID();
      const { attempt, url } = await prepareSessionAuthorization(
        {
          configKey: namespace,
          connectionId: t.view.id,
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
      const commit = (locking = false) =>
        serial(t, async () => {
          if (!storing()) throw new RuntimeError('disconnected');
          // Kept local until the attempt is stored: the record it expects.
          let expected = t.revision;
          if (locking) {
            // A renewal of this session that finished before the lock was
            // granted, whose announcement has not arrived yet: the attempt
            // is stored beside its result.
            const stored = await sessions!.read(id);
            if (!storing()) throw new RuntimeError('disconnected');
            const value = stored?.value;
            if (
              stored &&
              beside(value) &&
              sessionBinding(value).generation === before
            )
              // Only for this commit: if it fails, the connection still
              // reads that renewal (and its rotated token) as new.
              expected = stored.revision;
          }
          // Another tab changed the record first: shown here, and a retry
          // prepares on it.
          // Known to `dispose()` before it is sent, so an attempt that
          // replaces an address is undone also when the page is disposed
          // while the write is in flight.
          let settle!: (revision: string | undefined) => void;
          const write = {
            id: t.view.id,
            podUrl: t.view.podUrl,
            settled: new Promise<string | undefined>((resolve) => {
              settle = resolve;
            }),
          };
          owed.add(write);
          let change: SessionChange;
          try {
            change = await sessions!.prepare(
              attempt,
              expected,
              intent === 'silent',
            );
          } catch (error) {
            settle(undefined);
            owed.delete(write);
            throw error;
          }
          const replaced =
            change.kind === 'committed' && replacesAddress(change.record.value)
              ? change.record.revision
              : undefined;
          settle(replaced);
          if (replaced === undefined) owed.delete(write);
          else owing = write;
          accepted(t, change);
          // Saved on another tab's address: until this page leaves for the
          // Pod, a sign-out, forget or dispose puts the address back.
          if (t !== self && replaced !== undefined)
            self.wroteOn = {
              id: t.view.id,
              podUrl: t.view.podUrl,
              revision: replaced,
            };
          // The revision is recorded first, so a disconnect that ran during
          // the commit retires the new attempt; this lifetime must not
          // continue.
          if (!storing()) {
            await unwrite(self);
            throw new RuntimeError('disconnected');
          }
          // Committed durably: switch to the new lifetime in the same step,
          // so nothing of the old one dispatches from this page while it
          // leaves. The facts stay for display until the page leaves.
          const shown = t.view;
          const subject =
            shown.session.kind === 'active' ||
            shown.session.kind === 'renewing' ||
            shown.session.kind === 'leaving'
              ? shown.session.subject
              : undefined;
          renewLifetime(t, generation);
          t.pod = pod;
          t.client = client;
          // Signing in again replaces a forget that could not be saved.
          delete t.forgetting;
          t.view = {
            ...shown,
            session: Object.freeze(
              subject === undefined
                ? { kind: 'leaving' }
                : { kind: 'leaving', subject },
            ),
          };
          publish();
          // Beside a session, which keeps working in the other tabs: its
          // generation.
          return change.kind === 'committed' &&
            change.record.value.kind !== 'authorizing'
            ? recordGeneration(change.record.value)
            : undefined;
        });
      // A session's record is changed under its refresh lock, so no refresh
      // of it is under way meanwhile (a refresh here or in another tab
      // finishes first), and a refresh claim found then is one no tab sends,
      // which the attempt is stored beside. Waited for until the runtime is
      // disposed: a session that ends meanwhile is signed in to again.
      // Another tab's address has no session.
      const leftFrom =
        t !== self || t.revision === null
          ? await commit()
          : await locked(
              `sempods:refresh:${namespace}:${id}`,
              t,
              () => commit(true),
              runtimeLifetime.signal,
            );
      // The session this page left from, which a sign-out here covers.
      if (leftFrom === undefined) delete t.leftFrom;
      else t.leftFrom = leftFrom;
      return { generation, url };
    };
    let prepared: Prepared;
    if (
      (e.revision === null || e.pod === undefined || intent === 'silent') &&
      lease?.store.watch
    ) {
      // The first record for this Pod, decided under its lock: two tabs
      // preparing at once do not both create one. The first sign-in over a
      // saved address (#372) decides there too, so a session another tab
      // stored meanwhile is joined, not prepared over. A silent sign-in
      // decides there too, also on a record it listed meanwhile (see
      // `follows`).
      let outcome:
        | { joined: Entry; session: boolean }
        | { prepared: Prepared; target?: Entry };
      try {
        outcome = await locked<
          | { joined: Entry; session: boolean }
          | { prepared: Prepared; target?: Entry }
        >(`sempods:connect:${namespace}:${e.view.podUrl}`, e, async () => {
          let saved = await savedFor(e.view.podUrl);
          current(e, before);
          // A refresh or code another tab claimed is read again under the
          // record's refresh lock: a tab still sending it finishes first, and a
          // refresh claim left then is joined only while it can be resent
          // (`holdsSession`); a code claim left then (its tab closed) is
          // replaced. A silent sign-in follows a code claim without waiting.
          const shared = sessions;
          if (
            shared &&
            saved?.value.kind === 'claimed' &&
            (saved.value.operation === 'refresh' || intent !== 'silent')
          ) {
            const claimed = saved.id;
            saved = await locked(
              `sempods:refresh:${namespace}:${claimed}`,
              e,
              () => shared.read(claimed),
            );
            current(e, before);
          }
          // A silent first sign-in follows a sign-in another tab has under
          // way for this Pod, up to the end of its code exchange, rather than
          // replacing its attempt. So does a first sign-in that meets an open
          // attempt on its own record before this tab heard of it (#372); one
          // already listed here is replaced, as a deliberate retry.
          const open =
            saved?.value.kind === 'authorizing' &&
            saved.value.attempt.expiresAt > Date.now();
          const follows =
            (intent === 'silent' &&
              (open ||
                (saved?.value.kind === 'claimed' &&
                  saved.value.operation === 'code'))) ||
            (first &&
              open &&
              saved?.id === id &&
              saved.revision !== e.revision);
          // The default Pod's address, which another tab saved after this
          // start listed nothing (#372): the silent first sign-in leaves it, as
          // a start that finds it does, since a declined answer would delete
          // it. The address is listed, read without a token.
          const kept = intent === 'silent' && saved?.value.kind === 'address';
          if (saved?.id === id) {
            if (kept) return { joined: e, session: true };
            // This connection's own record, which an announcement did not
            // bring yet (the default Pod's stable id): a session another tab
            // stored is this tab's too; otherwise the attempt replaces it, as
            // it replaces an interrupted code exchange.
            if (follows || holdsSession(saved.value)) {
              await serial(e, async () => {
                adopt(e, saved);
              });
              const joined = entries.get(id);
              if (joined) return { joined, session: true };
            }
            e.revision = saved.revision;
          } else if (saved?.value.kind === 'address' && !kept) {
            // The address another tab saved for this Pod (#372), not listed
            // here (its announcement is under way, or this tab does not
            // remember Pods): the attempt is saved on it, so the Pod keeps one
            // record, and this connection gives way only once it is saved, so
            // a failed preparation leaves it and its handles working.
            const target = fromRecord(saved);
            const saving = store(target);
            // A sign-out or forget of this connection waits for that write.
            void serial(e, () => saving).catch(() => {});
            return { prepared: await saving, target };
          } else if (saved) {
            // An open attempt another tab began, which this tab has not
            // listed yet (#372): followed, as on this connection's own record.
            const unseen = first && open && !entries.has(saved.id);
            preparing.delete(id);
            admit(saved);
            const joined = entries.get(saved.id);
            if (joined)
              return {
                joined,
                session: kept || follows || unseen || holdsSession(saved.value),
              };
            if (kept) throw new RuntimeError('disconnected');
          }
          return { prepared: await store() };
        });
      } catch (error) {
        return reconcile(error);
      }
      if ('joined' in outcome) {
        // Another tab signed in to this Pod meanwhile (or is renewing that
        // session, or signing in while this one would sign in silently): it
        // is this tab's too, without leaving for the Pod. A silent sign-in
        // that met the default Pod's address ends here too.
        if (outcome.session) return;
        // A remembered address, or a sign-in under way or interrupted in
        // another tab: this sign-in continues on that connection, replacing
        // the attempt.
        return authorize(outcome.joined.view.id, intent);
      }
      prepared = outcome.prepared;
      const target = outcome.target;
      if (target) {
        // A sign-out, forget or dispose here after the attempt was saved on
        // the other tab's address: the address is restored in its place, as
        // that tab saved it (best effort), and nothing navigates.
        if (!still()) {
          target.lifetime.abort(new RuntimeError('disconnected'));
          await unwrite(e);
          throw new RuntimeError('disconnected');
        }
        // Saved on the other tab's address: this connection gives way to it.
        // A sign-out or forget of it puts the address back as its record
        // says (`address`); a dispose before it leaves does (`owed`).
        delete e.wroteOn;
        dropEntry(id);
        stop(e, { kind: 'signed-out' });
        entries.set(target.view.id, target);
        publish();
        e = target;
      }
    } else prepared = await store();
    const { generation, url } = prepared;
    current(e, generation);
    // Leaving for the Pod: its callback decides about the address now.
    if (owing) owed.delete(owing);
    const navigation: Navigation = {
      controller: new AbortController(),
      owned: false,
      calling: true,
      stayed: false,
    };
    watchReturn(e, generation, navigation, intent === 'silent');
    let handled: unknown;
    try {
      handled = (options.navigate ?? ((url) => window.location.assign(url)))(
        url,
        { signal: navigation.controller.signal },
      );
    } finally {
      navigation.calling = false;
      navigation.owned = handled === 'signal';
      // Staying from within `navigate` (it could not open its sign-in): the
      // document stops only for a navigation that does not cancel itself.
      if (navigation.stayed && !navigation.owned) stopDocument();
    }
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
      lease = await acquireSessionLease(
        namespace,
        locks,
        () =>
          options.openStore
            ? options.openStore(namespace)
            : openSessionStore(namespace),
        runtimeLifetime.signal,
      );
      if (disposed) {
        closeStore(lease);
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
      // Whether this tab tried the silent first sign-in.
      const silentNote = firstSignIn === 'silent' ? readSilentNote() : 'tried';
      report = {
        ...report,
        storage: 'durable',
        unreadable: Object.freeze(listing.unreadable),
      };
      if (disposed) throw new RuntimeError('disconnected');
      let pending: SessionSnapshot | undefined;
      const returned =
        location.searchParams.getAll('state').length === 1
          ? location.searchParams.get('state')
          : null;
      /** Addresses an earlier start remembered, deleted under `rememberPods: false`. */
      const forgotten: SessionSnapshot[] = [];
      /** Silent first sign-ins that expired without an answer: deleted, as if never started. */
      const expiredSilent = new Set<string>();
      // Old SDKs could save several connections for one address. Retire only
      // redundant address-only records, under the namespace lease and revision
      // check. Never merge sessions, attempts, or different exact Pod URLs.
      // An address of a Pod never signed in to gives way to any other record.
      const addressOnly = (saved: SessionSnapshot) =>
        saved.value.kind === 'disconnected' || saved.value.kind === 'address';
      const represented = new Set(
        listing.records
          .filter((saved) => !addressOnly(saved))
          .map((saved) => recordPodUrl(saved.value)),
      );
      const ordered = [
        ...listing.records.filter((saved) => saved.value.kind !== 'address'),
        ...listing.records.filter((saved) => saved.value.kind === 'address'),
      ];
      for (const saved of ordered) {
        const podUrl = recordPodUrl(saved.value);
        // Find the callback even when its Pod is excluded. Reject it below without
        // discovery, code claim or mutation of the foreign durable record.
        if (
          callback &&
          returned !== null &&
          attemptOf(saved.value)?.state === returned
        ) {
          if (pending) throw new RuntimeError('attempt');
          pending = saved;
        }
        // Records of Pods outside `allowedPods` stay untouched.
        if (!allows(podUrl)) continue;
        if (
          !callback &&
          saved.value.kind === 'authorizing' &&
          saved.value.silent &&
          saved.value.attempt.expiresAt <= Date.now()
        ) {
          try {
            await erase(saved.id, saved.revision);
            expiredSilent.add(saved.id);
            continue;
          } catch {
            // Listed signed out; deleted by the next start.
          }
        }
        if (addressOnly(saved) && !rememberPods) {
          forgotten.push(saved);
          continue;
        }
        if (addressOnly(saved)) {
          if (represented.has(podUrl)) {
            try {
              await erase(saved.id, saved.revision);
              continue;
            } catch {
              // Keep it visible and forgettable if cleanup could not be saved.
            }
          }
          represented.add(podUrl);
        }
        if (disposed) throw new RuntimeError('disconnected');
        // A session restores also while a re-authorization of it is out, in
        // this tab (back navigation, a reload, a tab opened from it) or
        // another; that attempt stays for its own callback.
        entries.set(saved.id, fromRecord(saved));
      }
      publish();
      // Best effort: a record left by a failed deletion is deleted next time.
      for (const saved of forgotten)
        void erase(saved.id, saved.revision).catch(() => {});
      // Restoration publishes per connection (`restoring` → `active`/`ended`).
      // Neither the startup report nor a callback waits for another Pod, so
      // one Pod whose discovery never settles cannot hold the app open.
      // A session whose re-authorization this callback answers restores once
      // the callback settled (`reauthorize`), so a refresh of it does not
      // hold up the code exchange.
      const answering =
        callback && pending && pending.value.kind !== 'authorizing'
          ? pending.id
          : undefined;
      for (const saved of listing.records) {
        const e = entries.get(saved.id);
        if (e && saved.id !== answering) begin(e, saved.value);
      }
      if (disposed) throw new RuntimeError('disconnected');
      initialized = true;
      const heard = early;
      early = null;
      heard.forEach(changed);
      if (!callback) {
        if (silentNote === null) {
          // Nothing stored, judged by the durable listing: a record that an
          // app policy (`allowedPods`) hides is still an existing
          // installation. Only addresses this start deletes (`rememberPods:
          // false`), expired silent attempts and the addresses of other
          // Pods never signed in to are as if never stored. The default
          // Pod's own address (saved under another default) counts: a
          // declined attempt would delete it.
          if (
            listing.unreadable.length === 0 &&
            listing.records.every(
              (saved) =>
                expiredSilent.has(saved.id) ||
                forgotten.includes(saved) ||
                (saved.value.kind === 'address' &&
                  saved.value.podUrl !== defaultPodUrl),
            )
          )
            await signInSilently();
          // An existing installation: this tab never signs in silently, also
          // after a sign-out that deletes its records.
          else noteSilent('tried');
        }
        return report;
      }
      const attempt = pending && attemptOf(pending.value);
      if (!pending || !attempt) throw new RuntimeError('attempt');
      destination = attempt.returnTo;
      if (!allows(recordPodUrl(pending.value)))
        throw new RuntimeError('configuration');
      attempted = pending.id;
      // A tab that returned from a sign-in never signs in silently.
      if (silentNote === null) noteSilent('tried');
      if (pending.value.kind !== 'authorizing') {
        // A re-authorization: its session stays unless the callback
        // validates.
        let outcome: Awaited<ReturnType<typeof reauthorize>> | undefined;
        try {
          outcome = await reauthorize(
            pending.id,
            attempt,
            location,
            destination,
          );
        } finally {
          // Any outcome but a new grant leaves the session to restore: before
          // the report once the attempt was answered, otherwise (waited too
          // long for the lock, a forged callback) beside it, so the report
          // comes at its deadline.
          const listed = entries.get(pending.id);
          if (outcome?.kind === 'kept' && listed)
            await relist(listed, listed.generation, outcome.pod);
          else if (outcome?.kind !== 'completed' && listed)
            void relist(listed, listed.generation);
        }
        if (outcome.kind === 'completed')
          return {
            ...report,
            interaction: 'completed',
            connectionId: pending.id,
          };
        const problem = runtimeProblem(outcome.error);
        // Only a session in use again: not one that expired while the
        // person was at the Pod, nor one only a retry may restore.
        const kept = entries.get(pending.id)?.view.session;
        return {
          ...report,
          interaction: problem === 'denied' ? 'cancelled' : 'failed',
          attemptConnectionId: pending.id,
          ...(kept?.kind === 'active' || kept?.kind === 'renewing'
            ? { resumed: true as const }
            : {}),
          problem,
          ...runtimeFailure(outcome.error),
        };
      }
      // Also one an SDK 0.9 tab started, noted only in this tab's storage.
      const silent =
        pending.value.silent === true ||
        silentNote === `attempt:${attempt.state}`;
      try {
        const connectionId = await redeem(
          pending.id,
          pending.revision,
          location,
          destination,
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
        closeStore(lease);
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
      if (callback && !disposed) replaceUrl(destination);
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
      if (!forget || pending.erase) return pending.operation;
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
    // A sign-in this tab still prepares (one waiting for the refresh lock)
    // stops: only a new action signs in again.
    delete e.preparation;
    // Register before abort/notifications so reentrant callers see the retirement.
    const operation = retire(e, 'disconnected', deleting, true)
      .then(
        (kept) => {
          if (entries.get(id) === e) {
            // Without sign-in, a sign-out keeps the connection to read
            // without a token, also when its address is not remembered.
            if (kept || (readsAnonymously && !forget)) {
              // Only a remembered address keeps why it was signed out: one
              // not kept (`rememberPods: false`), or a Pod never signed in
              // to, is as if never signed in.
              e.view = {
                ...e.view,
                session: Object.freeze(
                  kept && kept !== 'address'
                    ? { kind: 'signed-out', problem: 'disconnected' }
                    : { kind: 'signed-out' },
                ),
              };
              settle(e);
            } else {
              dropEntry(id);
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
    disconnects.set(id, { erase: forget, operation });
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
        // Best effort: unreadable, this tab lists none.
        const saved = await savedFor(url).catch(() => undefined);
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
          const e = anonymousEntry(url);
          const saved = await rememberAddress(e);
          if (disposed) throw new RuntimeError('disconnected');
          // Another tab saved this Pod meanwhile: its connection is this
          // tab's too.
          if (saved) admit(saved);
          const meanwhile = listed();
          if (meanwhile) {
            if (e.revision) void remove(e.view.id, e.revision).catch(() => {});
            return meanwhile;
          }
          entries.set(e.view.id, e);
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
    cancelAuthorization(id) {
      const attempt = abandons.get(id);
      if (!attempt) return false;
      // A navigation of this document still loading stops here, whichever
      // `navigate` started it, unless that one cancels on its `signal`
      // itself; `abandon` aborts the signal. While `navigate` still runs,
      // its answer decides once it returns.
      const navigation = attempt.navigation;
      if (navigation.calling) navigation.stayed = true;
      else if (!navigation.owned) stopDocument();
      return attempt.abandon(true);
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
      // Addresses of sign-ins that never left for their Pod go back first
      // (#372), each only while its attempt is unchanged.
      closeStore(lease);
      publish();
      listeners.clear();
      snapshot = Object.freeze([]);
    },
  };
  activeMemories.set(runtime, contexts.active);
  connectionRemovals.set(runtime, (id) => removals.get(id) ?? 0);
  return runtime;
}
