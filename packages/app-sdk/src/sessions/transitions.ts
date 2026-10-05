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
  parseSessionRecord,
  sessionBinding,
  SessionTransitionError,
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
export type RefreshClaim = Completion & {
  readonly kind: 'claimed';
  readonly binding: SessionBinding;
  readonly credentials: ExchangeResult;
};
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
    before: SessionRecord,
    binding: SessionBinding,
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
          const scopes =
            before.kind === 'ready'
              ? before.credentials.scopes
              : binding.scopes;
          result = parseStoredCredentials(input, { ...binding, scopes });
          if (result.expiresAt <= Date.now()) throw new Error();
          if (before.kind === 'ready')
            assertRefreshContinuity(before.credentials, result);
        } catch {
          throw new SessionTransitionError('result');
        }
        return commit(claimed.id, claimed.revision, {
          version: 1,
          kind: 'ready',
          binding,
          credentials: result,
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
    // No verifier, access token or refresh token survives in this durable claim.
    return commit(current.id, current.revision, {
      version: 1,
      kind: 'claimed',
      binding: expected,
      operation,
      subject:
        current.value.kind === 'ready'
          ? current.value.credentials.subject
          : null,
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
    async prepare(
      input: SessionAttempt,
      expectedRevision: string | null,
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
      return commit(snapshot.connectionId, expectedRevision, {
        version: 1,
        kind: 'authorizing',
        attempt: snapshot,
      });
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
        // A matching denial consumes its attempt; forged or malformed callbacks leave it intact.
        if (!(error instanceof OAuthError) || error.problem !== 'denied')
          throw new SessionTransitionError('callback');
      }
      const result = await claim(current, 'code', binding);
      return result.kind === 'conflict'
        ? conflict
        : {
            kind: 'claimed',
            attempt,
            ...completion(result.record, current.value, binding),
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
      const result = await claim(current, 'refresh', binding);
      return result.kind === 'conflict'
        ? conflict
        : {
            kind: 'claimed',
            binding: structuredClone(binding),
            credentials: structuredClone(current.value.credentials),
            ...completion(result.record, current.value, binding),
          };
    },
    async disconnect(id: string, revision: string): Promise<SessionChange> {
      const current = await observed(id, revision);
      if (!current) return conflict;
      return commit(id, revision, {
        version: 1,
        kind: 'disconnected',
        binding: sessionBinding(current.value),
      });
    },
  };
}

/** Resume and exchange claims use the same discovery/client continuity checks. */
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
