import type {
  SdkFailure,
  CatalogueContext,
  CatalogueResult,
  Pod,
  PodOptions,
} from '@sempods/client-sdk';
import type { ClientIdentity } from '@sempods/client-sdk/oauth';
import type { SessionLocks, SessionStore } from '../sessions/types.js';
import type { RuntimeProblem } from './errors.js';
import type { BoundPod, BoundRead, BoundView } from './view.js';

export type FeatureScopes = {
  readonly required?: readonly string[];
  readonly optional?: readonly string[];
};
export type SessionFact =
  | { readonly kind: 'signed-out' | 'restoring' }
  | { readonly kind: 'active' | 'renewing'; readonly subject: string }
  | {
      readonly kind: 'ended';
      readonly problem: RuntimeProblem;
      readonly failure?: SdkFailure;
    };
/**
 * Registry labels (`rdfs:label`, SPS-CTX-032) keyed by exact context IRI, read
 * only for the selected, validated Context in the background. Display text only: absent while
 * unread, for contexts without a label and after a failed read; never an
 * identity or a grant.
 */
export type ContextLabels = Readonly<Record<string, string>>;
export type CatalogueFact =
  | { readonly kind: 'unknown' }
  | {
      readonly kind: 'loading';
      readonly contexts?: readonly CatalogueContext[];
      readonly labels?: ContextLabels;
    }
  | {
      readonly kind: 'ready';
      readonly contexts: readonly CatalogueContext[];
      readonly labels?: ContextLabels;
    }
  | {
      readonly kind: 'failed';
      readonly contexts?: readonly CatalogueContext[];
      readonly labels?: ContextLabels;
    };
export interface Connection {
  readonly id: string;
  readonly podUrl: string;
  readonly clientKind: ClientIdentity['kind'];
  readonly session: SessionFact;
  readonly catalogue: CatalogueFact;
  readonly requestedScopes: readonly string[];
  readonly requiredScopes: readonly string[];
  readonly optionalScopes: readonly string[];
  readonly grantedScopes: readonly string[];
  readonly missingRequiredScopes: readonly string[];
  readonly selectedContext: string | null;
}
/** Startup interaction and storage outcomes are independent of restored connections. */
export interface StartupReport {
  /**
   * Present only after a completed callback. The callback selects no context; a
   * remembered choice may be reselected once the catalogue confirms it.
   */
  readonly connectionId?: string;
  /**
   * Present only after a failed or cancelled callback that matched a stored
   * attempt: the connection being signed in to. It stays listed, ended with
   * the cause when the provider answered with an error.
   */
  readonly attemptConnectionId?: string;
  /** The returning sign-in's outcome; `none` without a callback, even when startup fails. */
  readonly interaction: 'none' | 'completed' | 'cancelled' | 'failed';
  readonly storage: 'durable' | 'unavailable' | 'busy';
  readonly problem?: RuntimeProblem;
  readonly failure?: SdkFailure;
  readonly unreadable: readonly {
    readonly id: string | null;
    readonly problem: 'corrupt' | 'unsupported';
  }[];
}
export type DisconnectResult = {
  readonly kind: 'disconnected' | 'blocked-locally';
};
/** Optional advanced composition seam; ordinary applications use the production client. */
export type PodFactory = (url: string, options: PodOptions) => Pod;
/**
 * A UI default for one known Pod, not an allowed-Pod policy.
 * Construction rejects an invalid podUrl with SdkError (invalid-pod-url),
 * or an invalid contextIri with RuntimeError (configuration), before I/O.
 */
export interface PodPreset {
  readonly podUrl: string;
  /** Exact canonical context of this Pod; no fallback to another context. */
  readonly contextIri?: string;
}
export interface BrowserRuntimeOptions {
  /** Stable for this runtime lifetime; scopes remain runtime-wide. */
  readonly preset?: PodPreset;
  /**
   * Opt-in restriction to exact canonical Pod URLs. Omit for unrestricted use;
   * an empty list, duplicates or a preset outside the list are configuration
   * errors. Invalid URLs use the client's invalid-pod-url error. Copied/frozen
   * at construction, before I/O; never changes the identity/storage namespace.
   * A single allowed Pod is also the default for connect() without a preset.
   * Foreign stored records remain untouched and absent from snapshots. A
   * foreign callback fails with configuration, without discovery/token exchange;
   * its URL is scrubbed but its stored attempt is not consumed or deleted.
   * This app policy does not replace server-side authorization.
   */
  readonly allowedPods?: readonly string[];
  readonly identity: ClientIdentity;
  readonly returnTo?: string;
  readonly scopes?: FeatureScopes;
  readonly development?: 'loopback-http';
  readonly fetch?: PodOptions['fetch'];
  /** Defaults to createPod. Overrides must preserve the client request and outcome contract. */
  readonly podFactory?: PodFactory;
  readonly location?: () => string;
  readonly navigate?: (url: string) => void;
  readonly replaceUrl?: (url: string) => void;
  /** Advanced/test storage adapters; omitted adapters use IndexedDB and Web Locks. */
  readonly openStore?: (namespace: string) => Promise<SessionStore>;
  readonly locks?: SessionLocks | null;
  /**
   * Remembers each connection's last chosen context for the next start; it is
   * reselected only while still readable. Defaults to localStorage; `null`
   * disables remembering.
   */
  readonly preferences?: PreferenceStorage | null;
}
/** Minimal synchronous key-value storage with the shape of `localStorage`. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface BrowserRuntime {
  /** Validated, frozen copy of the configured default; never a grant. */
  readonly preset?: PodPreset;
  /** Frozen exact Pod restriction, or undefined for unrestricted use. */
  readonly allowedPods?: readonly string[];
  initialize(): Promise<StartupReport>;
  getSnapshot(): readonly Connection[];
  /** Listener exceptions are reported asynchronously and never interrupt session transitions. */
  subscribe(listener: () => void): () => void;
  /**
   * Omit the URL to use the preset or sole allowed Pod. Matching default
   * connections are reused after
   * any pending disconnect settles. Waiting rejects with RuntimeError (storage)
   * if retirement fails, or (disconnected) if this runtime was disposed.
   * Concurrent default connects share discovery; connecting never starts login.
   * Outside-list URLs reject with RuntimeError (configuration) before discovery.
   */
  connect(url?: string): Promise<Connection>;
  beginAuthorization(id: string): Promise<void>;
  disconnect(id: string): Promise<DisconnectResult>;
  loadContexts(
    id: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<BoundRead<CatalogueResult>>;
  selectContext(id: string, iri: string): void;
  bind(id: string): BoundView;
  /**
   * A view of one explicit Context of a signed-in eligible connection, for
   * example the Context a Pod-overview row names. It never changes or
   * remembers the selection and loads no label. It is always its own handle,
   * also when `contextIri` is the selected Context, and it survives selection
   * changes. Repeated calls return the same handle for the same authorization
   * lifetime (connection, generation, subject).
   *
   * Access follows the last confirmed catalogue evidence for this Context, as
   * for the selected view: without it, or once a successful catalogue removes
   * the permission, requests are not dispatched. A permission change for this
   * Context, changed grants, session end, subject change, a new authorization
   * or disconnect invalidate its pending reads; a selection change does not.
   *
   * Throws `RuntimeError('disconnected')` without an eligible signed-in
   * session, and `RuntimeError('configuration')` for an IRI that is not a
   * Context of this connection's Pod, or for another Context than an exact
   * preset `contextIri` on the preset's Pod.
   */
  bindContext(id: string, contextIri: string): BoundView;
  /** Requires a signed-in eligible connection, but neither selection nor catalogue;
   * throws `RuntimeError('disconnected')` while restoring or after the session ended.
   * Missing required scopes leave the handle current with read=false and stop dispatch.
   * Pod 403 returns refused without catalogue recovery or inferred session changes.
   */
  bindPod(id: string): BoundPod;
  dispose(): void;
}
