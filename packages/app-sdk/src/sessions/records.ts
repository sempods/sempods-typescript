import {
  parseSessionBinding,
  parseStoredAttempt,
  type SessionBinding,
  type SessionAttempt,
} from './authorization.js';
import { anonymous, createPod } from '@sempods/client-sdk';
import { type ExchangeResult } from '@sempods/client-sdk/oauth';
import {
  parseStoredCredentials,
  scopeList,
} from '@sempods/client-sdk/oauth/host';
import type { DiscoveryOptions } from '@sempods/client-sdk/oauth';
import type { StoredSession, SessionTransitionProblem } from './types.js';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SessionConfiguration {
  readonly configKey: string;
  readonly redirectUri: string;
  readonly development?: DiscoveryOptions['development'];
}

/**
 * A re-authorization of a session, kept beside that session until it settles
 * (0.10.0): `open` with its verifier until its callback claims the code, then
 * `claimed` without it while that exchange runs. Its binding's generation
 * becomes the new grant's. Only a validated callback replaces the session;
 * any other outcome drops the attempt and leaves the session as it is.
 */
export type PendingAttempt =
  | { readonly kind: 'open'; readonly attempt: SessionAttempt }
  | {
      readonly kind: 'claimed';
      readonly state: string;
      readonly binding: SessionBinding;
    };
export type SessionRecord = { readonly version: 1 } & (
  | {
      readonly kind: 'authorizing';
      readonly attempt: SessionAttempt;
      /**
       * The silent first sign-in (`firstSignIn: 'silent'`, 0.10.0): shown
       * signed out in every tab while it is out, never as interrupted.
       */
      readonly silent?: true;
      /**
       * The first sign-in replaced the address of a Pod never signed in to
       * (#372): a sign-in that fails, or a sign-out of it, puts the address
       * back. Absent in records of SDKs that do not save addresses.
       */
      readonly address?: true;
    }
  | {
      readonly kind: 'ready';
      readonly binding: SessionBinding;
      readonly credentials: ExchangeResult;
      readonly pending?: PendingAttempt;
      readonly attemptEnded?: string;
    }
  | {
      readonly kind: 'claimed';
      readonly binding: SessionBinding;
      readonly operation: 'code' | 'refresh';
      readonly subject: string | null;
      /**
       * A refresh claim's one resend after a lost answer (refresh claims of
       * SDK 0.8 and later only). Absent in code claims and in refresh claims
       * of SDK 0.7 and earlier, which are never sent again.
       */
      readonly resend?: RefreshResend;
      /** A refresh claim's session's re-authorization; never in a code claim. */
      readonly pending?: PendingAttempt;
      /**
       * Changes each time a re-authorization of this session ends without a
       * new grant (0.10.0), so every tab reads Context access again, also
       * one that never saw the attempt. Kept by renewals; in `ready` too.
       */
      readonly attemptEnded?: string;
      /** A code claim of an attempt that replaced an address; see `authorizing`. */
      readonly address?: true;
    }
  | {
      readonly kind: 'disconnected';
      readonly binding: SessionBinding;
      /**
       * Why the session ended, for display (a runtime problem such as
       * `expired`; `disconnected` for a sign-out). Absent in records of SDK
       * 0.7 and earlier. A retired record holds no token and no verifier.
       */
      readonly reason?: string;
    }
  | {
      /**
       * A Pod read without a token that was never signed in to (`signIn:
       * 'optional'`): only its address, neither discovered nor bound to a
       * client. A sign-in replaces it. SDKs without this kind (such as 0.9.0-dev.3) list it as
       * unreadable and leave it untouched.
       */
      readonly kind: 'address';
      readonly configKey: string;
      readonly connectionId: string;
      readonly podUrl: string;
    }
);
/** A record bound to a discovered Pod and a client: every kind but `address`. */
export type BoundSessionRecord = Exclude<SessionRecord, { kind: 'address' }>;
/**
 * What one resend of a claimed refresh needs: the refresh token that was
 * sent, the granted scopes it continues and when it was first sent (this
 * device's clock). `resent` records that the one resend was sent.
 */
export interface RefreshResend {
  readonly refreshToken: string;
  readonly scopes: readonly string[];
  readonly sentAt: number;
  readonly resent?: true;
}
export interface SessionSnapshot {
  readonly id: string;
  readonly revision: string;
  readonly value: SessionRecord;
}

export class SessionTransitionError extends Error {
  constructor(readonly problem: SessionTransitionProblem) {
    super(`Session transition: ${problem}`);
    this.name = 'SessionTransitionError';
  }
}

export function sessionBinding(value: BoundSessionRecord): SessionBinding {
  if (value.kind !== 'authorizing') return value.binding;
  const { configKey, connectionId, generation, pod, client, scopes } =
    value.attempt;
  return { configKey, connectionId, generation, pod, client, scopes };
}

/**
 * Whether a first sign-in under way replaced the address of a Pod never
 * signed in to, which its failure or sign-out puts back (#372).
 */
export function replacesAddress(value: SessionRecord): boolean {
  return (
    (value.kind === 'authorizing' || value.kind === 'claimed') &&
    value.address === true
  );
}

/** The exact Pod URL a record is for. */
export function recordPodUrl(value: SessionRecord): string {
  return value.kind === 'address'
    ? value.podUrl
    : sessionBinding(value).pod.podUrl;
}

/** The generation a record belongs to; an address has none. */
export function recordGeneration(value: SessionRecord): string | undefined {
  return value.kind === 'address'
    ? undefined
    : sessionBinding(value).generation;
}

/** Parse stored shape and identity, without deciding freshness, eligibility or network dispatch. */
export function parseSessionRecord(
  stored: StoredSession,
  config: SessionConfiguration,
): SessionSnapshot {
  const value = stored.value;
  if (
    record(value) &&
    typeof value.version === 'number' &&
    Number.isInteger(value.version) &&
    value.version > 1
  ) {
    throw new SessionTransitionError('unsupported');
  }
  try {
    if (!record(value) || value.version !== 1) throw new Error();
    let parsed: BoundSessionRecord;
    if (value.kind === 'address') {
      if (
        value.configKey !== config.configKey ||
        value.connectionId !== stored.id ||
        typeof value.podUrl !== 'string'
      )
        throw new Error();
      // The portable client's canonical address rule; construction sends nothing.
      createPod(value.podUrl, {
        auth: anonymous(),
        ...(config.development ? { development: config.development } : {}),
      });
      return {
        id: stored.id,
        revision: stored.revision,
        value: {
          version: 1,
          kind: 'address',
          configKey: value.configKey,
          connectionId: value.connectionId,
          podUrl: value.podUrl,
        },
      };
    }
    if (value.kind === 'authorizing') {
      const attempt = parseStoredAttempt(
        value.attempt,
        config.configKey,
        config.redirectUri,
        config.development,
      );
      // SDK 0.6 to 0.9 kept a re-authorized session as `previous` of its
      // attempt: read as that session with the attempt pending, which the
      // next write stores.
      parsed =
        value.previous === undefined
          ? {
              version: 1,
              kind: 'authorizing',
              attempt,
              ...(value.silent === true ? { silent: true as const } : {}),
              ...(value.address === true ? { address: true as const } : {}),
            }
          : {
              version: 1,
              kind: 'ready',
              ...parsePrevious(value.previous, config),
              pending: { kind: 'open', attempt },
            };
      if (sessionBinding(parsed).connectionId !== attempt.connectionId)
        throw new Error();
    } else {
      // Only a code claim still depends on its exact redirect.
      const holdsAttempt =
        value.kind === 'claimed' && value.operation === 'code';
      const binding = parseSessionBinding(
        value.binding,
        config.configKey,
        config.redirectUri,
        config.development,
        holdsAttempt ? 'refuse' : 'follow',
      );
      switch (value.kind) {
        case 'ready':
          parsed = {
            version: 1,
            kind: 'ready',
            binding,
            credentials: parseStoredCredentials(value.credentials, {
              ...binding,
              scopes: binding.scopes,
            }),
            ...parsePending(value.pending, binding, config),
            ...parseEnded(value.attemptEnded),
          };
          break;
        case 'claimed':
          if (
            (value.operation !== 'code' && value.operation !== 'refresh') ||
            (value.operation === 'code'
              ? value.subject !== null
              : typeof value.subject !== 'string' ||
                // The same absolute-IRI rule client-sdk applies to a token's sub.
                !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/.test(value.subject))
          )
            throw new Error();
          parsed = {
            version: 1,
            kind: 'claimed',
            binding,
            operation: value.operation,
            subject: value.subject as string | null,
            ...(value.resend === undefined || value.operation !== 'refresh'
              ? {}
              : { resend: parseResend(value.resend) }),
            ...(value.operation === 'refresh'
              ? {
                  ...parsePending(value.pending, binding, config),
                  ...parseEnded(value.attemptEnded),
                }
              : {}),
            ...(value.address === true && value.operation === 'code'
              ? { address: true as const }
              : {}),
          };
          break;
        case 'disconnected':
          // Display only: a reason this SDK cannot read is left out, so the
          // remembered address survives a reason a newer SDK wrote.
          parsed = {
            version: 1,
            kind: 'disconnected',
            binding,
            ...(typeof value.reason === 'string' &&
            /^[a-z][a-z-]{0,39}$/.test(value.reason)
              ? { reason: value.reason }
              : {}),
          };
          break;
        default:
          throw new Error();
      }
    }
    if (sessionBinding(parsed).connectionId !== stored.id) throw new Error();
    return { id: stored.id, revision: stored.revision, value: parsed };
  } catch {
    throw new SessionTransitionError('corrupt');
  }
}

function parseResend(value: unknown): RefreshResend {
  if (
    !record(value) ||
    typeof value.refreshToken !== 'string' ||
    !value.refreshToken ||
    typeof value.sentAt !== 'number' ||
    !Number.isFinite(value.sentAt) ||
    value.sentAt < 0 ||
    (value.resent !== undefined && value.resent !== true)
  )
    throw new Error();
  return {
    refreshToken: value.refreshToken,
    scopes: scopeList(value.scopes),
    sentAt: value.sentAt,
    ...(value.resent ? { resent: true as const } : {}),
  };
}

/**
 * The re-authorization a session record carries. One this SDK cannot read
 * (corrupt, or written by a newer SDK) is left out rather than losing the
 * session: the next write drops it, and its callback fails as `attempt`.
 */
function parsePending(
  value: unknown,
  session: SessionBinding,
  config: SessionConfiguration,
): { readonly pending?: PendingAttempt } {
  if (value === undefined) return {};
  try {
    if (!record(value)) throw new Error();
    let pending: PendingAttempt;
    let binding: SessionBinding;
    if (value.kind === 'open') {
      const attempt = parseStoredAttempt(
        value.attempt,
        config.configKey,
        config.redirectUri,
        config.development,
      );
      pending = { kind: 'open', attempt };
      binding = attempt;
    } else if (value.kind === 'claimed') {
      if (
        typeof value.state !== 'string' ||
        !/^[A-Za-z0-9_-]{32,128}$/.test(value.state)
      )
        throw new Error();
      // Its code can only be redeemed with this exact redirect.
      binding = parseSessionBinding(
        value.binding,
        config.configKey,
        config.redirectUri,
        config.development,
      );
      pending = { kind: 'claimed', state: value.state, binding };
    } else throw new Error();
    if (
      binding.connectionId !== session.connectionId ||
      binding.generation === session.generation
    )
      throw new Error();
    return { pending };
  } catch {
    return {};
  }
}

/** A marker this SDK cannot read is left out, like an unreadable `pending`. */
function parseEnded(value: unknown): { readonly attemptEnded?: string } {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    ? { attemptEnded: value }
    : {};
}

/** A pending attempt that may still settle: claimed, or open and unexpired. */
export function livePending(
  pending: PendingAttempt | undefined,
  now = Date.now(),
): PendingAttempt | undefined {
  if (!pending) return undefined;
  if (pending.kind === 'claimed') return pending;
  const { createdAt, expiresAt } = pending.attempt;
  return createdAt <= now && now < expiresAt ? pending : undefined;
}

/** A session record an attempt can be stored beside: `ready` or a refresh claim. */
export function beside(
  value: SessionRecord | undefined,
): value is Extract<SessionRecord, { kind: 'ready' | 'claimed' }> {
  return (
    value?.kind === 'ready' ||
    (value?.kind === 'claimed' && value.operation === 'refresh')
  );
}
/** The re-authorization a session record carries. */
export function pendingOf(
  value: SessionRecord | undefined,
): PendingAttempt | undefined {
  return value?.kind === 'ready' || value?.kind === 'claimed'
    ? value.pending
    : undefined;
}
/** Its open attempt while unexpired: the one a callback may still answer. */
export function openPending(
  value: SessionRecord | undefined,
  now = Date.now(),
) {
  const pending = livePending(pendingOf(value), now);
  return pending?.kind === 'open' ? pending : undefined;
}
/** The attempt a record has out: its own, or one pending beside a session. */
export function attemptOf(
  value: SessionRecord | undefined,
): SessionAttempt | undefined {
  if (value?.kind === 'authorizing') return value.attempt;
  const pending = pendingOf(value);
  return pending?.kind === 'open' ? pending.attempt : undefined;
}

function parsePrevious(
  value: unknown,
  config: SessionConfiguration,
): { readonly binding: SessionBinding; readonly credentials: ExchangeResult } {
  if (!record(value)) throw new Error();
  // Like a ready record, it holds no outstanding authorization of its own.
  const binding = parseSessionBinding(
    value.binding,
    config.configKey,
    config.redirectUri,
    config.development,
    'follow',
  );
  return {
    binding,
    credentials: parseStoredCredentials(value.credentials, binding),
  };
}
