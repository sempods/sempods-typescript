import {
  assertAttemptFresh,
  parseAttempt,
  parseSessionBinding,
  type SessionBinding,
  type SessionAttempt,
} from './authorization.js';
import { OAuthError, type ExchangeResult } from '@sempods/client-sdk/oauth';
import {
  assertRefreshContinuity,
  validateAuthorizationCallback,
  parseStoredCredentials,
} from '@sempods/client-sdk/oauth/host';
import {
  attemptOf,
  beside,
  livePending,
  openPending,
  parseSessionRecord,
  pendingOf,
  sessionBinding,
  SessionTransitionError,
  type PendingAttempt,
  type RefreshResend,
  type SessionConfiguration,
  type SessionRecord,
  type SessionSnapshot,
} from './records.js';
import type { SessionStore } from './store.js';

export type SessionChange =
  | { readonly kind: 'committed'; readonly record: SessionSnapshot }
  | { readonly kind: 'conflict' };
type Completion = {
  readonly revision: string;
  /** Only checked protocol results belong here. Success means the result is durably accepted. */
  complete(result: ExchangeResult): Promise<SessionChange>;
};
export type CodeClaim = Completion & {
  readonly kind: 'claimed';
  readonly attempt: SessionAttempt;
};
/**
 * A re-authorization's callback, claimed on the session it was pending for:
 * `claimed` with the attempt to exchange its code, or `answered` when the
 * provider answered this attempt with an error, which consumed it.
 */
export type PendingClaim =
  | CodeClaim
  | {
      readonly kind: 'answered';
      readonly error: OAuthError;
      /** Whether the session it was pending for stays (not a handed-over one). */
      readonly kept: boolean;
    };
export type RefreshClaim = Completion & {
  readonly kind: 'claimed';
  readonly binding: SessionBinding;
  readonly credentials: ExchangeResult;
  /** When the refresh token was claimed for sending (this device's clock). */
  readonly sentAt: number;
};
/** The one resend of a claimed refresh whose answer was lost. */
export type RefreshResendClaim = Completion & {
  readonly kind: 'claimed';
  readonly binding: SessionBinding;
  readonly subject: string;
  readonly resend: RefreshResend;
};
/** What a refresh result must continue: the subject, the sent token and the granted scopes. */
type Continuity = Pick<ExchangeResult, 'subject' | 'refreshToken' | 'scopes'>;
const conflict = { kind: 'conflict' } as const;

/** Internal transition functions for the single browser coordinator; no network, timers or UI ownership. */
export function createSessionTransitions(
  store: SessionStore,
  configuration: SessionConfiguration,
) {
  const config = { ...configuration };
  function validate<T>(
    problem: 'attempt' | 'configuration',
    parse: () => T,
  ): T {
    try {
      return parse();
    } catch {
      throw new SessionTransitionError(problem);
    }
  }
  function expectedBinding(value: SessionBinding) {
    return validate('configuration', () =>
      parseSessionBinding(
        value,
        config.configKey,
        config.redirectUri,
        config.development,
      ),
    );
  }
  async function read(id: string): Promise<SessionSnapshot | undefined> {
    const stored = await store.read(id);
    return stored === undefined
      ? undefined
      : parseSessionRecord(stored, config);
  }
  async function commit(
    id: string,
    revision: string | null,
    value: SessionRecord,
  ): Promise<SessionChange> {
    const result = await store.commit(id, revision, value);
    return result.kind === 'conflict'
      ? result
      : {
          kind: 'committed',
          record: parseSessionRecord(result.record, config),
        };
  }
  async function observed(id: string, revision: string) {
    const current = await read(id);
    return current?.revision === revision ? current : undefined;
  }
  function completion(
    claimed: SessionSnapshot,
    binding: SessionBinding,
    /** A refresh's continuity; absent for a code exchange. */
    before?: Continuity,
  ): Completion {
    // One attempt to complete: a rejected result is never retried, and a
    // failed claim is retired by the coordinator's disconnect.
    let open = true;
    return {
      revision: claimed.revision,
      async complete(input) {
        if (!open) throw new SessionTransitionError('consumed');
        open = false;
        let result: ExchangeResult;
        try {
          const scopes = before ? before.scopes : binding.scopes;
          result = parseStoredCredentials(input, { ...binding, scopes });
          if (result.expiresAt <= Date.now()) throw new Error();
          if (before) assertRefreshContinuity(before, result);
        } catch {
          throw new SessionTransitionError('result');
        }
        // A renewal keeps the session's re-authorization pending; a code
        // exchange is the new grant, with nothing pending.
        return commit(claimed.id, claimed.revision, {
          version: 1,
          kind: 'ready',
          binding,
          credentials: result,
          ...(before ? following(claimed.value) : {}),
        });
      },
    };
  }
  async function claim(
    current: SessionSnapshot,
    operation: 'code' | 'refresh',
    expected: SessionBinding,
  ) {
    const binding = sessionBinding(current.value);
    assertSessionBinding(binding, expected);
    if (operation === 'refresh' && !expected.pod.supportsRefreshToken)
      throw new SessionTransitionError('state');
    // No verifier or access token survives in this durable claim. A refresh
    // claim keeps the refresh token it sends, for one resend after a lost
    // answer within the Pod's grace period; a code claim keeps nothing.
    const credentials =
      current.value.kind === 'ready' ? current.value.credentials : undefined;
    const kept = operation === 'refresh' ? following(current.value) : {};
    return commit(current.id, current.revision, {
      version: 1,
      kind: 'claimed',
      binding: expected,
      operation,
      subject: credentials?.subject ?? null,
      ...kept,
      ...(operation === 'refresh' && credentials?.refreshToken
        ? {
            resend: {
              refreshToken: credentials.refreshToken,
              scopes: credentials.scopes,
              sentAt: Date.now(),
            },
          }
        : {}),
    });
  }
  return {
    read,
    async list() {
      const listing = await store.list();
      const records: SessionSnapshot[] = [];
      const unreadable = [...listing.unreadable];
      for (const stored of listing.records) {
        try {
          records.push(parseSessionRecord(stored, config));
        } catch (error) {
          if (
            !(error instanceof SessionTransitionError) ||
            (error.problem !== 'corrupt' && error.problem !== 'unsupported')
          )
            throw error;
          unreadable.push({ id: stored.id, problem: error.problem });
        }
      }
      return { records, unreadable };
    },
    /**
     * Stores a sign-in attempt. Beside a session (a `ready` record, or a
     * refresh claim the coordinator found under the refresh lock with no tab
     * sending it) the attempt is pending and the session keeps working,
     * replacing an earlier pending attempt; otherwise the attempt is the
     * record (`authorizing`), `silent` for the silent first sign-in.
     */
    async prepare(
      input: SessionAttempt,
      expectedRevision: string | null,
      silent = false,
    ): Promise<SessionChange> {
      // Parsing creates a detached snapshot before the first await.
      const snapshot = validate('attempt', () =>
        parseAttempt(
          input,
          config.configKey,
          config.redirectUri,
          config.development,
          Date.now(),
        ),
      );
      const current = await read(snapshot.connectionId);
      if ((current?.revision ?? null) !== expectedRevision) return conflict;
      if (
        current &&
        sessionBinding(current.value).generation === snapshot.generation
      )
        throw new SessionTransitionError('state');
      const value = current?.value;
      if (beside(value))
        return commit(snapshot.connectionId, expectedRevision, {
          ...value,
          pending: { kind: 'open', attempt: snapshot },
        });
      return commit(snapshot.connectionId, expectedRevision, {
        version: 1,
        kind: 'authorizing',
        attempt: snapshot,
        ...(silent ? { silent: true as const } : {}),
      });
    },
    /**
     * Under the refresh lock: claims the code of a re-authorization's callback
     * on the session it is pending for, which keeps working meanwhile. Only
     * the open attempt with the callback's state is claimed; the verifier is
     * then dropped from the record, so a second callback cannot exchange the
     * code again. A matching error answer (a denial, a server error)
     * consumes the attempt (`answered`) and leaves the session as it is. A
     * forged or malformed callback throws `callback`; a missing, replaced,
     * claimed or expired attempt throws `attempt`; neither changes the
     * record. An attempt its session handed over (`handOver`) is claimed as
     * a first sign-in's: an error answer then retires the record. `expected`
     * is the attempt's binding under the coordinator's fresh discovery.
     */
    async claimPending(
      id: string,
      expected: SessionBinding,
      callback: URL,
    ): Promise<PendingClaim | typeof conflict> {
      const binding = expectedBinding(expected);
      const returned = validate('configuration', () => new URL(callback.href));
      const current = await read(id);
      const value = current?.value;
      const state = returned.searchParams.get('state');
      // The session ended meanwhile and handed the attempt over (`handOver`):
      // claimed as a first sign-in's.
      const handed = value?.kind === 'authorizing';
      const attempt = attemptOf(value);
      if (
        !current ||
        !value ||
        !attempt ||
        attempt.state !== state ||
        returned.searchParams.getAll('state').length !== 1
      )
        throw new SessionTransitionError('attempt');
      validate('attempt', () => assertAttemptFresh(attempt, Date.now()));
      let answer: OAuthError | undefined;
      try {
        validateAuthorizationCallback(attempt, returned);
      } catch (error) {
        if (!(error instanceof OAuthError) || error.problem === 'callback')
          throw new SessionTransitionError('callback');
        answer = error;
      }
      if (answer) {
        const change = await commit(
          id,
          current.revision,
          handed
            ? retired(sessionBinding(value), answer.problem)
            : ended(value),
        );
        return change.kind === 'conflict'
          ? conflict
          : { kind: 'answered', error: answer, kept: !handed };
      }
      assertSessionBinding(attempt, binding);
      const claimed = await commit(
        id,
        current.revision,
        handed
          ? {
              version: 1,
              kind: 'claimed',
              binding,
              operation: 'code',
              subject: null,
            }
          : {
              ...(value as Extract<
                SessionRecord,
                { kind: 'ready' | 'claimed' }
              >),
              pending: { kind: 'claimed', state: attempt.state, binding },
            },
      );
      if (claimed.kind === 'conflict') return conflict;
      const base = completion(claimed.record, binding);
      let open = true;
      return {
        kind: 'claimed',
        attempt,
        revision: base.revision,
        async complete(result) {
          if (!open) throw new SessionTransitionError('consumed');
          open = false;
          const change = await base.complete(result);
          if (change.kind === 'committed') return change;
          // A session that ended meanwhile (not a sign-out) handed this
          // claim over as a code claim of its generation: completed there.
          const now = await read(id);
          if (
            now?.value.kind !== 'claimed' ||
            now.value.operation !== 'code' ||
            now.value.binding.generation !== binding.generation
          )
            return conflict;
          return completion(now, binding).complete(result);
        },
      };
    },
    /**
     * Drops the re-authorization of generation `generation` after its
     * exchange failed: the session it was pending for stays (`kept`). A code
     * claim it was handed over as (`handOver`) is retired with `reason`
     * (`ended`). Changes nothing (`none`) once the record holds neither.
     */
    async discardPending(
      id: string,
      generation: string,
      reason?: string,
    ): Promise<'kept' | 'ended' | 'none'> {
      for (let round = 0; round < 3; round++) {
        const current = await read(id);
        const value = current?.value;
        if (!current || !value) return 'none';
        let next: SessionRecord;
        let outcome: 'kept' | 'ended';
        const pending = pendingOf(value);
        if (
          pending &&
          (pending.kind === 'open'
            ? pending.attempt.generation
            : pending.binding.generation) === generation
        ) {
          next = ended(value);
          outcome = 'kept';
        } else if (
          value.kind === 'claimed' &&
          value.operation === 'code' &&
          value.binding.generation === generation
        ) {
          next = retired(value.binding, reason);
          outcome = 'ended';
        } else return 'none';
        if ((await commit(id, current.revision, next)).kind === 'committed')
          return outcome;
      }
      throw new SessionTransitionError('state');
    },
    /**
     * A session that ended while a re-authorization of it was out (not by a
     * sign-out): the attempt becomes the record, so its callback still
     * signs in as a first sign-in would. Returns `undefined` when the record
     * holds no such attempt.
     */
    async handOver(
      id: string,
      revision: string,
    ): Promise<SessionChange | undefined> {
      const current = await observed(id, revision);
      if (!current) return conflict;
      const next = handedOver(current.value);
      return next && commit(id, revision, next);
    },
    async claimCode(
      id: string,
      revision: string,
      expected: SessionBinding,
      callback: URL,
    ): Promise<CodeClaim | typeof conflict> {
      const binding = expectedBinding(expected);
      const returned = validate('configuration', () => new URL(callback.href));
      const current = await observed(id, revision);
      if (!current) return conflict;
      if (current.value.kind !== 'authorizing')
        throw new SessionTransitionError('state');
      const attempt = current.value.attempt;
      validate('attempt', () => assertAttemptFresh(attempt, Date.now()));
      try {
        validateAuthorizationCallback(attempt, returned);
      } catch (error) {
        // A matching error answer (denial, login required, …) consumes its
        // attempt; forged or malformed callbacks leave it intact.
        if (!(error instanceof OAuthError) || error.problem === 'callback')
          throw new SessionTransitionError('callback');
      }
      const result = await claim(current, 'code', binding);
      return result.kind === 'conflict'
        ? conflict
        : {
            kind: 'claimed',
            attempt,
            ...completion(result.record, binding),
          };
    },
    async claimRefresh(
      id: string,
      revision: string,
      expected: SessionBinding,
    ): Promise<RefreshClaim | typeof conflict> {
      const binding = expectedBinding(expected);
      const current = await observed(id, revision);
      if (!current) return conflict;
      if (
        current.value.kind !== 'ready' ||
        !current.value.credentials.refreshToken
      )
        throw new SessionTransitionError('state');
      const credentials = current.value.credentials;
      const result = await claim(current, 'refresh', binding);
      if (result.kind === 'conflict') return conflict;
      const claimed = result.record.value;
      if (claimed.kind !== 'claimed' || !claimed.resend)
        throw new SessionTransitionError('state');
      return {
        kind: 'claimed',
        binding: structuredClone(binding),
        credentials: structuredClone(credentials),
        sentAt: claimed.resend.sentAt,
        ...completion(result.record, binding, credentials),
      };
    },
    /**
     * Claims the one resend of a refresh whose answer was lost: records that
     * it is sent (`resent`), keeping when the refresh was first sent. Throws
     * `state` for any other record, also once the resend was claimed; the
     * coordinator decides whether the Pod's grace period still allows it.
     */
    async resendRefresh(
      id: string,
      revision: string,
      expected: SessionBinding,
    ): Promise<RefreshResendClaim | typeof conflict> {
      const binding = expectedBinding(expected);
      const current = await observed(id, revision);
      if (!current) return conflict;
      const value = current.value;
      if (
        value.kind !== 'claimed' ||
        value.operation !== 'refresh' ||
        value.subject === null ||
        !value.resend ||
        value.resend.resent
      )
        throw new SessionTransitionError('state');
      assertSessionBinding(value.binding, binding);
      const resend = { ...value.resend, resent: true as const };
      const result = await commit(id, revision, {
        ...withoutPending(value),
        binding,
        resend,
        ...following(value),
      });
      if (result.kind === 'conflict') return conflict;
      return {
        kind: 'claimed',
        binding: structuredClone(binding),
        subject: value.subject,
        resend: structuredClone(resend),
        ...completion(result.record, binding, {
          subject: value.subject,
          refreshToken: resend.refreshToken,
          scopes: resend.scopes,
        }),
      };
    },
    /**
     * Retires the record: only its binding (the Pod address) and why it ended
     * stay, without token or verifier.
     */
    async disconnect(
      id: string,
      revision: string,
      reason?: string,
      /** A session that ended, not a sign-out: an attempt out is handed over. */
      handOver = false,
    ): Promise<SessionChange> {
      const current = await observed(id, revision);
      if (!current) return conflict;
      return commit(
        id,
        revision,
        (handOver && handedOver(current.value)) ||
          retired(sessionBinding(current.value), reason),
      );
    },
    /** Deletes the record, whatever it holds, while it is still at `revision`. */
    async forget(
      id: string,
      revision: string,
    ): Promise<'removed' | 'conflict'> {
      return (await store.remove(id, revision)).kind;
    },
  };
}

/**
 * The re-authorization a write under the refresh lock keeps: an open attempt
 * until it expires. A claimed one found there was left by a tab that closed
 * during its exchange (a closed tab's Web Locks are released): its code
 * counts as spent, and it is dropped.
 */
function carried(value: SessionRecord): PendingAttempt | undefined {
  return openPending(value);
}
/** A retired record: only the address and why its session ended. */
function retired(binding: SessionBinding, reason?: string): SessionRecord {
  return {
    version: 1,
    kind: 'disconnected',
    binding,
    ...(reason === undefined ? {} : { reason }),
  };
}
/**
 * The record a session's attempt out becomes once that session ended (an
 * open attempt `authorizing`, a claimed one a code claim), if it has one.
 */
function handedOver(value: SessionRecord): SessionRecord | undefined {
  const pending = livePending(pendingOf(value));
  if (!pending) return undefined;
  return pending.kind === 'open'
    ? { version: 1, kind: 'authorizing', attempt: pending.attempt }
    : {
        version: 1,
        kind: 'claimed',
        binding: pending.binding,
        operation: 'code',
        subject: null,
      };
}
function withoutPending<T extends SessionRecord>(value: T): T {
  if (!('pending' in value)) return value;
  const next = { ...value };
  delete (next as { pending?: PendingAttempt }).pending;
  return next;
}
/** A new `attemptEnded` marker: a re-authorization ended without a grant. */
const endMark = () => crypto.randomUUID();
/** The session without its attempt, which ended without a new grant. */
function ended<T extends SessionRecord>(value: T): T {
  return { ...withoutPending(value), attemptEnded: endMark() };
}
/**
 * What a renewal of the session keeps: its attempt while `carried`, and the
 * `attemptEnded` marker, renewed when the renewal drops an attempt.
 */
function following(value: SessionRecord): {
  readonly pending?: PendingAttempt;
  readonly attemptEnded?: string;
} {
  if (value.kind !== 'ready' && value.kind !== 'claimed') return {};
  const pending = carried(value);
  const mark = value.pending && !pending ? endMark() : value.attemptEnded;
  return {
    ...(pending ? { pending } : {}),
    ...(mark ? { attemptEnded: mark } : {}),
  };
}

/** Exchange claims use the same discovery/client continuity checks. */
export function assertSessionBinding(
  binding: SessionBinding,
  expected: SessionBinding,
): void {
  // The coordinator supplies discovery/client facts independently validated before dispatch.
  const scopes = (values: readonly string[] | null) =>
    values === null ? null : [...new Set(values)].sort();
  const key = (b: SessionBinding) =>
    JSON.stringify([
      b.configKey,
      b.connectionId,
      b.generation,
      b.pod.podUrl,
      b.pod.issuer,
      b.client.kind,
      b.client.podUrl,
      b.client.issuer,
      b.client.clientId,
      b.client.redirectUri,
      b.pod.endpoints.authorization,
      b.pod.endpoints.token,
      b.pod.endpoints.registration,
      b.pod.endpoints.jwks,
      b.pod.supportsRefreshToken,
      b.pod.authorizationResponseIssSupported,
      scopes(b.scopes),
      scopes(b.pod.scopes.resource),
      scopes(b.pod.scopes.authorizationServer),
    ]);
  if (key(binding) !== key(expected)) throw new SessionTransitionError('state');
}
