import {
  prepareAuthorization,
  OAuthError,
  type OAuthBinding,
  type AuthorizationAttempt,
  type DiscoveryOptions,
} from '@sempods/client-sdk/oauth';
import {
  validateOAuthBinding,
  scopeList,
} from '@sempods/client-sdk/oauth/host';

export interface SessionBinding extends OAuthBinding {
  readonly configKey: string;
  readonly connectionId: string;
  readonly generation: string;
}
export interface SessionAttempt extends SessionBinding, AuthorizationAttempt {
  readonly version: 1;
  readonly lifetime: 'session';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly returnTo: string;
}
type ProtocolOptions = Pick<DiscoveryOptions, 'development'>;
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * `routeMoved: 'follow'` lets a record that holds no outstanding authorization
 * (credentials, a refresh claim, a disconnect) follow a callback route moved
 * within the same validated did:web identity. An outstanding attempt keeps its
 * exact redirect binding: its code can only be redeemed with that redirect.
 */
export function parseSessionBinding(
  value: unknown,
  configKey: string,
  redirectUri: string,
  development: ProtocolOptions['development'],
  routeMoved: 'refuse' | 'follow' = 'refuse',
): SessionBinding {
  if (
    !record(value) ||
    value.configKey !== configKey ||
    typeof value.connectionId !== 'string' ||
    !value.connectionId ||
    typeof value.generation !== 'string' ||
    !value.generation
  )
    throw new OAuthError('attempt');
  let binding = validateOAuthBinding(value, development);
  if (binding.client.redirectUri !== redirectUri) {
    if (routeMoved !== 'follow' || binding.client.kind !== 'did-web')
      throw new OAuthError('attempt');
    // Revalidated as a whole: the new route must belong to the same did:web.
    binding = validateOAuthBinding(
      { ...binding, client: { ...binding.client, redirectUri } },
      development,
    );
  }
  return {
    ...binding,
    configKey,
    connectionId: value.connectionId,
    generation: value.generation,
  };
}
export async function prepareSessionAuthorization(
  input: Omit<SessionBinding, 'scopes'> & {
    readonly scopes?: readonly string[];
    readonly returnTo: string;
  },
  now = Date.now(),
  development?: DiscoveryOptions['development'],
): Promise<{ readonly attempt: SessionAttempt; readonly url: string }> {
  const binding = parseSessionBinding(
    { ...input, scopes: scopeList(input.scopes ?? []) },
    input.configKey,
    input.client.redirectUri,
    development,
  );
  const returnTo = safeReturnTo(input.returnTo, input.client.redirectUri);
  const { attempt, url } = await prepareAuthorization(
    binding,
    development ? { development } : {},
  );
  return {
    url,
    attempt: {
      ...binding,
      ...attempt,
      version: 1,
      lifetime: 'session',
      createdAt: now,
      expiresAt: now + 10 * 60_000,
      returnTo,
    },
  };
}
export function safeReturnTo(value: string, redirectUri: string): string {
  const redirect = new URL(redirectUri);
  const url = new URL(value, redirect);
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    url.pathname.startsWith('//') ||
    /[\\\r\n]/.test(value) ||
    url.origin !== redirect.origin ||
    url.pathname === redirect.pathname ||
    ['code', 'state', 'error', 'iss', 'response'].some((key) =>
      url.searchParams.has(key),
    )
  ) {
    throw new OAuthError('configuration');
  }
  return url.pathname + url.search + url.hash;
}

/** Shape validation also permits an expired attempt, so recovery can still identify it. */
export function parseStoredAttempt(
  value: unknown,
  configKey: string,
  redirectUri: string,
  development: ProtocolOptions['development'],
): SessionAttempt {
  try {
    const binding = parseSessionBinding(
      value,
      configKey,
      redirectUri,
      development,
    );
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.state !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/.test(value.state) ||
      typeof value.verifier !== 'string' ||
      !/^[A-Za-z0-9._~-]{43,128}$/.test(value.verifier) ||
      !Array.isArray(value.scopes) ||
      value.lifetime !== 'session' ||
      typeof value.createdAt !== 'number' ||
      !Number.isFinite(value.createdAt) ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt - value.createdAt !== 10 * 60_000 ||
      typeof value.returnTo !== 'string' ||
      safeReturnTo(value.returnTo, redirectUri) !== value.returnTo
    )
      throw new Error();
    return {
      ...binding,
      version: 1,
      state: value.state,
      verifier: value.verifier,
      scopes: binding.scopes,
      lifetime: 'session',
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      returnTo: value.returnTo,
    };
  } catch {
    throw new OAuthError('attempt');
  }
}

/** Validate persisted input and its lifetime before using its endpoint, client or verifier. */
export function parseAttempt(
  value: unknown,
  configKey: string,
  redirectUri: string,
  development: ProtocolOptions['development'],
  now: number,
): SessionAttempt {
  const attempt = parseStoredAttempt(
    value,
    configKey,
    redirectUri,
    development,
  );
  assertAttemptFresh(attempt, now);
  return attempt;
}

export function assertAttemptFresh(attempt: SessionAttempt, now: number): void {
  if (
    !Number.isFinite(now) ||
    attempt.createdAt > now ||
    attempt.expiresAt <= now
  )
    throw new OAuthError('attempt');
}
