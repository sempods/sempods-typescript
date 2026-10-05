import {
  parseSessionBinding,
  parseStoredAttempt,
  type SessionBinding,
  type SessionAttempt,
} from './authorization.js';
import { type ExchangeResult } from '@sempods/client-sdk/oauth';
import { parseStoredCredentials } from '@sempods/client-sdk/oauth/host';
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

export type SessionRecord = { readonly version: 1 } & (
  | { readonly kind: 'authorizing'; readonly attempt: SessionAttempt }
  | {
      readonly kind: 'ready';
      readonly binding: SessionBinding;
      readonly credentials: ExchangeResult;
    }
  | {
      readonly kind: 'claimed';
      readonly binding: SessionBinding;
      readonly operation: 'code' | 'refresh';
      readonly subject: string | null;
    }
  | { readonly kind: 'disconnected'; readonly binding: SessionBinding }
);
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

export function sessionBinding(value: SessionRecord): SessionBinding {
  if (value.kind !== 'authorizing') return value.binding;
  const { configKey, connectionId, generation, pod, client, scopes } =
    value.attempt;
  return { configKey, connectionId, generation, pod, client, scopes };
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
    let parsed: SessionRecord;
    if (value.kind === 'authorizing') {
      parsed = {
        version: 1,
        kind: 'authorizing',
        attempt: parseStoredAttempt(
          value.attempt,
          config.configKey,
          config.redirectUri,
          config.development,
        ),
      };
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
          };
          break;
        case 'disconnected':
          parsed = { version: 1, kind: 'disconnected', binding };
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
