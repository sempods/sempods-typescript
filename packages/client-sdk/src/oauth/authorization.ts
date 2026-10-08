import * as oauth from 'oauth4webapi';
import type { PodFetch } from '../index.js';
import type { DiscoveryOptions } from './discovery.js';
import { validateOAuthBinding, type OAuthBinding } from './binding.js';
import { scopeList } from './scopes.js';
import { OAuthError, type OAuthProblem } from './errors.js';
import { ABSOLUTE_IRI } from '../iri.js';

export interface AuthorizationAttempt extends OAuthBinding {
  readonly state: string;
  readonly verifier: string;
}

export interface ExchangeResult {
  /** Local receipt time and endpoint lifetime are retained to validate persisted expiry. */
  readonly receivedAt: number;
  readonly expiresIn?: number;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly subject: string;
  readonly expiresAt: number;
  readonly scopes: readonly string[];
}

type ProtocolOptions = {
  readonly fetch?: PodFetch;
  readonly development?: DiscoveryOptions['development'];
};

/** Preparation returns data; the host owns retention, lifetime and user interaction. */
export async function prepareAuthorization(
  input: Omit<OAuthBinding, 'scopes'> & { readonly scopes?: readonly string[] },
  options: Pick<ProtocolOptions, 'development'> = {},
): Promise<{ readonly attempt: AuthorizationAttempt; readonly url: string }> {
  const binding = validateOAuthBinding(
    { ...input, scopes: input.scopes ?? [] },
    options.development,
  );
  const scopes = binding.scopes;
  const verifier = oauth.generateRandomCodeVerifier();
  const state = oauth.generateRandomState();
  const url = new URL(binding.pod.endpoints.authorization);
  url.searchParams.set('client_id', binding.client.clientId);
  url.searchParams.set('redirect_uri', binding.client.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set(
    'code_challenge',
    await oauth.calculatePKCECodeChallenge(verifier),
  );
  if (scopes.length) url.searchParams.set('scope', scopes.join(' '));
  else url.searchParams.delete('scope');
  return {
    attempt: Object.freeze({ ...binding, state, verifier }),
    url: url.href,
  };
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Shared preflight for claims and exchanges. An error answer bound to the attempt
 * (denial, login required, …) is distinct from an invalid callback (`callback`).
 */
export function validateAuthorizationCallback(
  attempt: AuthorizationAttempt,
  callback: URL,
): URLSearchParams {
  const redirect = new URL(attempt.client.redirectUri);
  if (
    callback.origin !== redirect.origin ||
    callback.pathname !== redirect.pathname ||
    callback.hash
  ) {
    throw new OAuthError('callback');
  }
  for (const [key, value] of redirect.searchParams) {
    if (
      callback.searchParams.getAll(key).length !== 1 ||
      callback.searchParams.get(key) !== value
    ) {
      throw new OAuthError('callback');
    }
  }
  const server = {
    issuer: attempt.pod.issuer,
    token_endpoint: attempt.pod.endpoints.token,
    authorization_response_iss_parameter_supported:
      attempt.pod.authorizationResponseIssSupported,
  };
  const client = {
    client_id: attempt.client.clientId,
    token_endpoint_auth_method: 'none',
  };
  try {
    if (callback.searchParams.has('error') && callback.searchParams.has('code'))
      throw new Error();
    // An empty iss is present and invalid, even in the compatibility profile.
    if (
      callback.searchParams.has('iss') &&
      callback.searchParams.get('iss') !== attempt.pod.issuer
    )
      throw new Error();
    const params = oauth.validateAuthResponse(
      server,
      client,
      callback,
      attempt.state,
    );
    if (params.getAll('code').length !== 1 || !params.get('code'))
      throw new Error();
    return params;
  } catch (error) {
    // The library checks issuer and state first: this error answers the attempt.
    if (error instanceof oauth.AuthorizationResponseError)
      throw new OAuthError(authorizationProblem(error.error));
    throw new OAuthError('callback');
  }
}

/** Classifies the error code only; the provider's free-text description is never kept. */
function authorizationProblem(code: string): OAuthProblem {
  switch (code) {
    case 'access_denied':
      return 'denied';
    case 'login_required':
      return 'login-required';
    case 'interaction_required':
      return 'interaction-required';
    case 'consent_required':
      return 'consent-required';
    case 'temporarily_unavailable':
    case 'server_error':
      return 'provider-unavailable';
    default:
      return 'rejected';
  }
}

export async function exchangeAuthorization(
  attempt: AuthorizationAttempt,
  callback: URL,
  options: ProtocolOptions = {},
): Promise<ExchangeResult> {
  const binding = validateOAuthBinding(attempt, options.development);
  if (
    !/^[A-Za-z0-9_-]{32,128}$/.test(attempt.state) ||
    !/^[A-Za-z0-9._~-]{43,128}$/.test(attempt.verifier)
  )
    throw new OAuthError('attempt');
  attempt = Object.freeze({
    ...binding,
    state: attempt.state,
    verifier: attempt.verifier,
  });
  const params = validateAuthorizationCallback(attempt, new URL(callback.href));
  const server = {
    issuer: attempt.pod.issuer,
    token_endpoint: attempt.pod.endpoints.token,
    authorization_response_iss_parameter_supported:
      attempt.pod.authorizationResponseIssSupported,
  };
  const client = {
    client_id: attempt.client.clientId,
    token_endpoint_auth_method: 'none',
  };
  try {
    const response = await oauth.authorizationCodeGrantRequest(
      server,
      client,
      oauth.None(),
      params,
      attempt.client.redirectUri,
      attempt.verifier,
      tokenEndpointOptions(options),
    );
    const receivedAt = Date.now();
    assertTokenEndpointResponse(response, server.token_endpoint);
    const tokens = await readTokenResponse(response, () =>
      oauth.processAuthorizationCodeResponse(server, client, response),
    );
    return checkedTokens(tokens, attempt, receivedAt);
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // Library errors may retain response bodies; never propagate them to the UI/logs.
    throw new OAuthError('exchange');
  }
}

/** A single exchange only. The coordinator owns sharing, consumption and publication. */
export async function refreshAuthorization(
  binding: OAuthBinding,
  refreshToken: string,
  subject: string,
  options: ProtocolOptions & { readonly signal: AbortSignal },
): Promise<ExchangeResult> {
  binding = validateOAuthBinding(binding, options.development);
  const server = {
    issuer: binding.pod.issuer,
    token_endpoint: binding.pod.endpoints.token,
  };
  const client = {
    client_id: binding.client.clientId,
    token_endpoint_auth_method: 'none',
  };
  try {
    const response = await oauth.refreshTokenGrantRequest(
      server,
      client,
      oauth.None(),
      refreshToken,
      tokenEndpointOptions(options, options.signal),
    );
    const receivedAt = Date.now();
    assertTokenEndpointResponse(response, server.token_endpoint);
    const tokens = await readTokenResponse(response, () =>
      oauth.processRefreshTokenResponse(server, client, response),
    );
    const result = checkedTokens(tokens, binding, receivedAt);
    assertRefreshContinuity(
      { subject, refreshToken, scopes: binding.scopes },
      result,
    );
    // A missing replacement never resurrects the refresh token already submitted.
    return result;
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    // Includes uncertain network failures: never leak responses or retry a spent token.
    throw new OAuthError('exchange');
  }
}

/** Shared by endpoint response processing and durable acceptance. */
export function assertRefreshContinuity(
  before: Pick<ExchangeResult, 'subject' | 'refreshToken' | 'scopes'>,
  result: ExchangeResult,
): void {
  if (
    result.subject !== before.subject ||
    result.refreshToken === before.refreshToken ||
    result.scopes.some((scope) => !before.scopes.includes(scope))
  )
    // `continuity`: a valid token that does not continue this session.
    throw new OAuthError('claims', 'continuity');
}

function tokenEndpointOptions(
  options: ProtocolOptions,
  signal?: AbortSignal,
): oauth.TokenEndpointRequestOptions {
  return {
    ...(signal ? { signal } : {}),
    [oauth.allowInsecureRequests]: options.development === 'loopback-http',
    [oauth.customFetch]: (url, init) =>
      (options.fetch ?? globalThis.fetch)(url, {
        ...init,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      }),
  };
}

function assertTokenEndpointResponse(response: Response, endpoint: string) {
  if (
    response.redirected ||
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400) ||
    (response.url !== '' && response.url !== new URL(endpoint).href)
  )
    throw new OAuthError('exchange');
}

/** Preserve invalid-client recovery consistently for code exchange and refresh. */
async function readTokenResponse(
  response: Response,
  process: () => Promise<oauth.TokenEndpointResponse>,
): Promise<oauth.TokenEndpointResponse> {
  // oauth4webapi prioritizes a WWW-Authenticate challenge over the JSON error body.
  const refusal = response.status === 401 ? response.clone() : undefined;
  try {
    return await process();
  } catch (error) {
    if (
      error instanceof oauth.ResponseBodyError &&
      error.error === 'invalid_client'
    )
      throw new OAuthError('invalid-client');
    // Media types are case-insensitive (RFC 9110); parameters such as charset
    // do not change the JSON error body.
    if (
      refusal?.headers
        .get('content-type')
        ?.split(';')[0]
        ?.trim()
        .toLowerCase() === 'application/json'
    ) {
      const body: unknown = await refusal.json().catch(() => undefined);
      if (record(body) && body.error === 'invalid_client')
        throw new OAuthError('invalid-client');
    }
    throw error;
  }
}

function checkedTokens(
  tokens: oauth.TokenEndpointResponse,
  binding: OAuthBinding,
  receivedAt: number,
): ExchangeResult {
  if (
    tokens.token_type.toLowerCase() !== 'bearer' ||
    tokens.id_token !== undefined
  )
    throw new OAuthError('claims');
  const claims = tokenClaims(
    tokens.access_token,
    binding,
    receivedAt,
    tokens.expires_in,
  );
  if (tokens.scope !== undefined) {
    const returned = tokenScopes(tokens.scope);
    if (
      returned.length !== claims.scopes.length ||
      returned.some((s) => !claims.scopes.includes(s))
    )
      throw new OAuthError('claims');
  }
  return {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token === undefined
      ? {}
      : { refreshToken: tokens.refresh_token }),
    ...claims,
  };
}

function tokenScopes(value: string): readonly string[] {
  try {
    return scopeList(value === '' ? [] : value.split(' '));
  } catch {
    throw new OAuthError('claims');
  }
}

function tokenIdentity(token: string, attempt: OAuthBinding) {
  try {
    const parts = token.split('.');
    if (
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new Error();
    const payload = parts[1]!;
    const bytes = Uint8Array.from(
      atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
      (c) => c.charCodeAt(0),
    );
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
    if (!record(value)) throw new Error();
    // `sub`: a missing or malformed subject, distinct from a changed one.
    if (typeof value.sub !== 'string' || !ABSOLUTE_IRI.test(value.sub))
      throw new OAuthError('claims', 'sub');
    if (
      value.iss !== attempt.pod.issuer ||
      value.client_id !== attempt.client.clientId ||
      typeof value.exp !== 'number' ||
      !Number.isFinite(value.exp) ||
      typeof value.iat !== 'number' ||
      !Number.isFinite(value.iat) ||
      value.iat < 0 ||
      value.exp <= value.iat ||
      typeof value.scope !== 'string'
    )
      throw new Error();
    const scopes = tokenScopes(value.scope);
    // Consent may independently add public-read; other grants must have been requested.
    if (scopes.some((s) => s !== 'public-read' && !attempt.scopes.includes(s)))
      throw new Error();
    return {
      subject: value.sub,
      issuedAt: value.iat,
      expires: value.exp,
      scopes: Object.freeze(scopes),
    };
  } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError('claims');
  }
}

function tokenClaims(
  token: string,
  binding: OAuthBinding,
  receivedAt: number,
  expiresIn?: number,
): Omit<ExchangeResult, 'accessToken' | 'refreshToken'> {
  const claims = tokenIdentity(token, binding);
  const expiresAt = credentialExpiry(claims, receivedAt, expiresIn);
  if (expiresAt <= Date.now()) throw new OAuthError('claims');
  return {
    subject: claims.subject,
    scopes: claims.scopes,
    expiresAt,
    receivedAt,
    ...(expiresIn === undefined ? {} : { expiresIn }),
  };
}

function credentialExpiry(
  claims: { expires: number; issuedAt: number },
  receivedAt: number,
  expiresIn?: number,
): number {
  // Receipt and endpoint lifetime handle clock offset without trusting an arbitrary stored deadline.
  // Clock policy: iat is never compared with this device's clock (Pods and
  // devices drift); a token must only be internally plausible (exp > iat,
  // expires_in within exp - iat) and not yet expired by its effective deadline.
  if (
    !Number.isFinite(receivedAt) ||
    receivedAt < 0 ||
    (expiresIn !== undefined &&
      (!Number.isFinite(expiresIn) ||
        expiresIn <= 0 ||
        expiresIn > claims.expires - claims.issuedAt))
  ) {
    throw new OAuthError('claims');
  }
  const expiresAt =
    expiresIn === undefined
      ? claims.expires * 1000
      : receivedAt + expiresIn * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= 0)
    throw new OAuthError('claims');
  return expiresAt;
}

/** Stored tokens are untrusted input, not a new token-endpoint response. No lifetime extension. */
export function parseStoredCredentials(
  value: unknown,
  binding: OAuthBinding,
): ExchangeResult {
  try {
    if (
      !record(value) ||
      typeof value.accessToken !== 'string' ||
      !value.accessToken ||
      typeof value.receivedAt !== 'number' ||
      (value.expiresIn !== undefined && typeof value.expiresIn !== 'number') ||
      (value.refreshToken !== undefined &&
        (typeof value.refreshToken !== 'string' || !value.refreshToken)) ||
      typeof value.expiresAt !== 'number' ||
      !Number.isFinite(value.expiresAt) ||
      value.expiresAt <= 0 ||
      !Array.isArray(value.scopes) ||
      !value.scopes.every((scope: unknown) => typeof scope === 'string')
    )
      throw new Error();
    const claims = tokenIdentity(value.accessToken, binding);
    if (
      value.expiresAt !==
        credentialExpiry(claims, value.receivedAt, value.expiresIn) ||
      value.subject !== claims.subject ||
      scopeList(value.scopes).length !== claims.scopes.length ||
      value.scopes.some((scope) => !claims.scopes.includes(scope))
    )
      throw new Error();
    return {
      accessToken: value.accessToken,
      subject: claims.subject,
      scopes: claims.scopes,
      expiresAt: value.expiresAt,
      receivedAt: value.receivedAt,
      ...(value.expiresIn === undefined ? {} : { expiresIn: value.expiresIn }),
      ...(value.refreshToken === undefined
        ? {}
        : { refreshToken: value.refreshToken }),
    };
  } catch {
    throw new OAuthError('claims');
  }
}
