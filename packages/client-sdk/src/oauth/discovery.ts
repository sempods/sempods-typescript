import * as oauth from 'oauth4webapi';
import { canonicalPodUrl } from '../pod-url.js';
import { SdkError, type PodFetch, type SdkFailure } from '../index.js';

type Failure = Extract<SdkFailure, { code: 'discovery' }>;
type Stage = Exclude<Failure['stage'], 'challenge'>;

export interface DiscoveryOptions {
  /** Trusted transport override; must honor the supplied credential/redirect policy. */
  readonly fetch?: PodFetch;
  readonly signal?: AbortSignal;
  /** Already parsed Bearer resource_metadata parameter, if discovery follows a challenge. */
  readonly challengeResourceMetadata?: string;
  /** Explicit local development only. Production and remote pods always require HTTPS. */
  readonly development?: 'loopback-http';
}

/** Validated facts, not grants. No credentials, storage, navigation or task semantics. */
export interface PodDiscovery {
  readonly podUrl: string;
  readonly issuer: string;
  readonly endpoints: {
    readonly authorization: string;
    readonly token: string;
    /** `null` when not advertised (RFC 8414 §2: optional); did:web needs none. */
    readonly registration: string | null;
    readonly jwks: string;
  };
  readonly scopes: {
    /** null means not advertised; an empty list is preserved as empty. */
    readonly resource: readonly string[] | null;
    readonly authorizationServer: readonly string[] | null;
  };
  /** Protocol support alone proves neither a refresh grant nor its lifetime. */
  readonly supportsRefreshToken: boolean;
  /** RFC 9207: require an issuer parameter on authorization responses when announced. */
  readonly authorizationResponseIssSupported: boolean;
}

/**
 * sempods pod-local discovery (SPS-AUTH-045, 064–068), not MCP discovery.
 * The caller supplies the canonical pod identity; returned URLs never redefine it.
 */
export async function discoverPod(
  podUrl: string,
  options: DiscoveryOptions = {},
): Promise<PodDiscovery> {
  const pod = canonicalPod(podUrl, options.development);
  const resourceUrl = `${podUrl}/.well-known/oauth-protected-resource`;
  if (
    options.challengeResourceMetadata !== undefined &&
    options.challengeResourceMetadata !== resourceUrl
  ) {
    throw failure('challenge', 'identity-mismatch', 'resource_metadata');
  }

  const resource = await metadata('resource', resourceUrl, pod, options);
  exactIdentity(resource.resource, podUrl, 'resource', 'resource');
  const issuers = stringList(resource, 'authorization_servers', 'resource');
  if (issuers.length !== 1 || issuers[0] !== podUrl) {
    throw failure('resource', 'identity-mismatch', 'authorization_servers');
  }
  requireValue(resource, 'bearer_methods_supported', 'header', 'resource');
  const resourceScopes = scopes(resource, 'resource');

  const server = await metadata(
    'authorization-server',
    `${podUrl}/.well-known/oauth-authorization-server`,
    pod,
    options,
  );
  exactIdentity(server.issuer, podUrl, 'authorization-server', 'issuer');
  requireValue(
    server,
    'response_types_supported',
    'code',
    'authorization-server',
  );
  const grants = requireValue(
    server,
    'grant_types_supported',
    'authorization_code',
    'authorization-server',
  );
  requireValue(
    server,
    'token_endpoint_auth_methods_supported',
    'none',
    'authorization-server',
  );
  requireValue(
    server,
    'code_challenge_methods_supported',
    'S256',
    'authorization-server',
  );

  const responseIssuer = server.authorization_response_iss_parameter_supported;
  if (responseIssuer !== undefined && typeof responseIssuer !== 'boolean')
    throw failure(
      'authorization-server',
      'invalid-metadata',
      'authorization_response_iss_parameter_supported',
    );
  const endpoints = Object.freeze({
    authorization: endpoint(server, 'authorization_endpoint', pod),
    token: endpoint(server, 'token_endpoint', pod),
    registration:
      server.registration_endpoint === undefined
        ? null
        : endpoint(server, 'registration_endpoint', pod),
    jwks: endpoint(server, 'jwks_uri', pod),
  });
  return Object.freeze({
    podUrl,
    issuer: podUrl,
    endpoints,
    scopes: Object.freeze({
      resource: resourceScopes,
      authorizationServer: scopes(server, 'authorization-server'),
    }),
    supportsRefreshToken: grants.includes('refresh_token'),
    authorizationResponseIssSupported: responseIssuer === true,
  });
}

/** Internal shared validation; not exported from the package entry points. */
export function canonicalPod(
  value: string,
  development: DiscoveryOptions['development'],
): URL {
  return new URL(canonicalPodUrl(value, development));
}

async function metadata(
  stage: Stage,
  url: string,
  pod: URL,
  options: DiscoveryOptions,
): Promise<Record<string, unknown>> {
  checkCancellation(stage, options.signal);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (cause) {
    checkCancellation(stage, options.signal);
    throw failure(stage, 'network', undefined, cause);
  }
  checkCancellation(stage, options.signal);
  if (
    response.redirected ||
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400) ||
    (response.url !== '' && response.url !== url)
  ) {
    throw failure(stage, 'invalid-metadata', 'redirect');
  }
  if (response.status !== 200) {
    throw new SdkError(
      { code: 'discovery', stage, problem: 'http', status: response.status },
      `Discovery ${stage} returned HTTP ${response.status}.`,
    );
  }
  if (
    response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  ) {
    throw failure(stage, 'invalid-metadata', 'content-type');
  }
  try {
    // Use the library's response processors, but not its host-rooted request builders.
    const result =
      stage === 'resource'
        ? await oauth.processResourceDiscoveryResponse(pod, response)
        : await oauth.processDiscoveryResponse(pod, response);
    checkCancellation(stage, options.signal);
    return result;
  } catch (cause) {
    checkCancellation(stage, options.signal);
    const mismatch =
      cause instanceof oauth.OperationProcessingError &&
      cause.code === oauth.JSON_ATTRIBUTE_COMPARISON;
    throw failure(
      stage,
      mismatch ? 'identity-mismatch' : 'invalid-metadata',
      mismatch ? (stage === 'resource' ? 'resource' : 'issuer') : undefined,
      cause,
    );
  }
}

function exactIdentity(
  value: unknown,
  expected: string,
  stage: Stage,
  field: string,
): void {
  // oauth4webapi compares parsed URLs; sempods additionally requires exact strings.
  if (value !== expected) throw failure(stage, 'identity-mismatch', field);
}

function stringList(
  data: Record<string, unknown>,
  field: string,
  stage: Stage,
): readonly string[] {
  const value = data[field];
  if (
    !Array.isArray(value) ||
    !value.every(
      (item: unknown): item is string =>
        typeof item === 'string' && item.length > 0,
    )
  ) {
    throw failure(stage, 'invalid-metadata', field);
  }
  return Object.freeze([...value]);
}

function requireValue(
  data: Record<string, unknown>,
  field: string,
  value: string,
  stage: Stage,
): readonly string[] {
  const values = stringList(data, field, stage);
  if (!values.includes(value)) throw failure(stage, 'unsupported-flow', field);
  return values;
}

function scopes(
  data: Record<string, unknown>,
  stage: Stage,
): readonly string[] | null {
  if (data.scopes_supported === undefined) return null;
  const values = stringList(data, 'scopes_supported', stage);
  // RFC 6749 scope-token. Do not turn malformed multi-scope strings into grants.
  if (values.some((value) => !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value))) {
    throw failure(stage, 'invalid-metadata', 'scopes_supported');
  }
  return values;
}

export function endpoint(
  data: Record<string, unknown>,
  field: string,
  pod: URL,
): string {
  const value = data[field];
  try {
    if (
      typeof value !== 'string' ||
      !/^https?:\/\//i.test(value) ||
      /[\s\\]/.test(value)
    ) {
      throw new Error('Expected an absolute HTTP(S) endpoint.');
    }
    const url = new URL(value);
    const allowed =
      url.protocol === 'https:' ||
      (pod.protocol === 'http:' && url.origin === pod.origin);
    if (!allowed || url.username || url.password || value.includes('#')) {
      throw new Error('Endpoint violates the discovery transport profile.');
    }
    return value;
  } catch (cause) {
    throw failure('authorization-server', 'invalid-metadata', field, cause);
  }
}

function checkCancellation(stage: Stage, signal?: AbortSignal): void {
  if (signal?.aborted)
    throw failure(stage, 'cancelled', undefined, signal.reason);
}

function failure(
  stage: Failure['stage'],
  problem: Failure['problem'],
  field?: string,
  cause?: unknown,
): SdkError {
  return new SdkError(
    {
      code: 'discovery',
      stage,
      problem,
      ...(field === undefined ? {} : { field }),
    },
    `Discovery ${stage}: ${problem}${field === undefined ? '' : ` (${field})`}.`,
    { cause },
  );
}
