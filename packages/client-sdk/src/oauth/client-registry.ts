import * as oauth from 'oauth4webapi';
import type { PodFetch } from '../index.js';
import {
  canonicalPod,
  endpoint,
  type DiscoveryOptions,
  type PodDiscovery,
} from './discovery.js';
import {
  callbackUrl,
  checkClientCancellation,
  checkDidWeb,
  clientFailure,
  sameRegisteredCallback,
} from './client-identity.js';

/** One explicit identity per app deployment. There is no automatic DCR fallback. */
export type ClientIdentity =
  | {
      readonly kind: 'did-web';
      readonly clientId: string;
      readonly redirectUri: string;
    }
  | {
      readonly kind: 'dynamic';
      readonly name: string;
      readonly redirectUri: string;
    };

/** Public identity bound to a pod and callback, not a session or an authorization grant. */
export interface OAuthClient {
  readonly kind: ClientIdentity['kind'];
  readonly podUrl: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
}

export interface ClientRegistryOptions {
  /** Trusted transport override, with the same obligations as discovery's fetch. */
  readonly fetch?: PodFetch;
  /** Also required for loopback callbacks, including HTTPS loopback callbacks. */
  readonly development?: DiscoveryOptions['development'];
}

export interface ClientRegistry {
  resolve(
    pod: PodDiscovery,
    identity: ClientIdentity,
    options?: { readonly signal?: AbortSignal },
  ): Promise<OAuthClient>;
  /** Forget one pod (or all); outstanding calls cannot refill an evicted cache. */
  clear(podUrl?: string): void;
}

/** Memory-only registration reuse. Session persistence and cross-tab coordination belong to the driver. */
export function createClientRegistry(
  options: ClientRegistryOptions = {},
): ClientRegistry {
  const transport = options.fetch ?? globalThis.fetch;
  const development = options.development;
  const pods = new Map<string, Map<string, OAuthClient>>();
  return {
    async resolve(pod, identity, { signal } = {}) {
      checkClientCancellation(signal);
      const base = canonicalPod(pod.podUrl, development);
      if (pod.issuer !== pod.podUrl)
        throw clientFailure('invalid-config', 'issuer');
      const redirect = callbackUrl(
        identity.redirectUri,
        development === 'loopback-http',
      );
      // Snapshot caller-owned objects before the first await.
      const result = {
        kind: identity.kind,
        podUrl: pod.podUrl,
        issuer: pod.issuer,
        redirectUri: identity.redirectUri,
      };
      if (identity.kind === 'did-web') {
        checkDidWeb(identity.clientId, redirect);
        return Object.freeze({ ...result, clientId: identity.clientId });
      }
      if (identity.kind !== 'dynamic' || !identity.name?.trim()) {
        throw clientFailure('invalid-config', 'name');
      }
      // Dynamic clients need a registration endpoint; did:web returned above.
      if (pod.endpoints.registration === null)
        throw clientFailure('invalid-config', 'registration_endpoint');
      const registration = endpoint(
        { registration_endpoint: pod.endpoints.registration },
        'registration_endpoint',
        base,
      );
      const metadata = {
        client_name: identity.name,
        redirect_uris: [identity.redirectUri],
        token_endpoint_auth_method: 'none',
        response_types: ['code'],
        grant_types: pod.supportsRefreshToken
          ? ['authorization_code', 'refresh_token']
          : ['authorization_code'],
      };
      // Include every request-affecting value. Loopback ports are intentionally distinct here.
      const key = JSON.stringify([
        result.podUrl,
        result.issuer,
        registration,
        metadata,
      ]);
      let cache = pods.get(result.podUrl);
      if (!cache) {
        cache = new Map();
        pods.set(result.podUrl, cache);
      }
      const existing = cache.get(key);
      if (existing) return existing;
      const clientId = await register(
        result.issuer,
        registration,
        metadata,
        transport,
        development,
        signal,
      );
      checkClientCancellation(signal);
      const client = Object.freeze({ ...result, clientId });
      if (pods.get(result.podUrl) === cache) cache.set(key, client);
      return client;
    },
    clear(podUrl) {
      if (podUrl === undefined) pods.clear();
      else pods.delete(podUrl);
    },
  };
}

type RegistrationMetadata = {
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  response_types: string[];
  grant_types: string[];
};

async function register(
  issuer: string,
  registration: string,
  metadata: RegistrationMetadata,
  fetch: PodFetch,
  development: ClientRegistryOptions['development'],
  signal?: AbortSignal,
): Promise<string> {
  let response: Response;
  try {
    response = await oauth.dynamicClientRegistrationRequest(
      { issuer, registration_endpoint: registration },
      metadata,
      {
        [oauth.customFetch]: (url, init) =>
          fetch(url, {
            ...init,
            credentials: 'omit',
            redirect: 'error',
            cache: 'no-store',
            referrerPolicy: 'no-referrer',
          }),
        // The endpoint was already checked against the pod's explicit transport profile.
        [oauth.allowInsecureRequests]: development === 'loopback-http',
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (cause) {
    checkClientCancellation(signal);
    throw clientFailure('network', undefined, cause);
  }
  checkClientCancellation(signal);
  if (
    response.redirected ||
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400) ||
    (response.url !== '' && response.url !== new URL(registration).href)
  ) {
    throw clientFailure('invalid-response', 'redirect');
  }
  if (response.status !== 201)
    throw clientFailure('http', undefined, undefined, response.status);
  if (
    response.headers
      .get('content-type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase() !== 'application/json'
  ) {
    throw clientFailure('invalid-response', 'content-type');
  }
  let body: oauth.Client;
  try {
    body = await oauth.processDynamicClientRegistrationResponse(response);
  } catch {
    checkClientCancellation(signal);
    // Do not retain response bodies as diagnostics: a mistaken service response may contain secrets.
    throw clientFailure('invalid-response');
  }
  checkClientCancellation(signal);
  if (!/^dyn:[^\s]+$/.test(body.client_id))
    throw clientFailure('invalid-response', 'client_id');
  if (
    'client_secret' in body ||
    'registration_access_token' in body ||
    body.token_endpoint_auth_method !== 'none'
  ) {
    throw clientFailure('invalid-response', 'token_endpoint_auth_method');
  }
  const grants = body.grant_types;
  if (
    !Array.isArray(grants) ||
    !grants.includes('authorization_code') ||
    grants.some(
      (grant) => grant !== 'authorization_code' && grant !== 'refresh_token',
    )
  ) {
    throw clientFailure('invalid-response', 'grant_types');
  }
  if (
    !Array.isArray(body.response_types) ||
    body.response_types.length !== 1 ||
    body.response_types[0] !== 'code'
  ) {
    throw clientFailure('invalid-response', 'response_types');
  }
  if (
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length !== 1 ||
    typeof body.redirect_uris[0] !== 'string' ||
    !sameRegisteredCallback(
      body.redirect_uris[0],
      metadata.redirect_uris[0]!,
      development === 'loopback-http',
    )
  ) {
    throw clientFailure('invalid-response', 'redirect_uris');
  }
  return body.client_id;
}
