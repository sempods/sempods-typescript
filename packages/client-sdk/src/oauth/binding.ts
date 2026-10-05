import { callbackUrl, checkDidWeb } from './client-identity.js';
import {
  canonicalPod,
  endpoint,
  type DiscoveryOptions,
  type PodDiscovery,
} from './discovery.js';
import type { OAuthClient } from './client-registry.js';
import { OAuthError } from './errors.js';
import { scopeList } from './scopes.js';

/** Portable protocol facts bound to one client and Pod, without session storage policy. */
export interface OAuthBinding {
  readonly scopes: readonly string[];
  readonly pod: PodDiscovery;
  readonly client: OAuthClient;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function freezeBinding(binding: OAuthBinding): OAuthBinding {
  Object.freeze(binding.client);
  Object.freeze(binding.pod.endpoints);
  if (binding.pod.scopes.resource) Object.freeze(binding.pod.scopes.resource);
  if (binding.pod.scopes.authorizationServer)
    Object.freeze(binding.pod.scopes.authorizationServer);
  Object.freeze(binding.pod.scopes);
  Object.freeze(binding.pod);
  return Object.freeze(binding);
}
/** Structural binding checks do not establish freshness or authorize a network operation. */
export function validateOAuthBinding(
  value: unknown,
  development?: DiscoveryOptions['development'],
): OAuthBinding {
  try {
    if (
      !record(value) ||
      !record(value.pod) ||
      !record(value.client) ||
      !record(value.pod.endpoints) ||
      !record(value.pod.scopes)
    )
      throw new Error();
    const { pod, client } = value;
    if (typeof pod.podUrl !== 'string') throw new Error();
    const base = canonicalPod(pod.podUrl, development);
    if (
      pod.issuer !== pod.podUrl ||
      client.podUrl !== pod.podUrl ||
      client.issuer !== pod.issuer ||
      !['dynamic', 'did-web'].includes(String(client.kind)) ||
      typeof client.clientId !== 'string' ||
      typeof client.redirectUri !== 'string'
    )
      throw new Error();
    const redirectUri = client.redirectUri;
    const redirect = callbackUrl(redirectUri, development === 'loopback-http');
    if (client.kind === 'did-web') checkDidWeb(client.clientId, redirect);
    else if (!/^dyn:[^\s]+$/.test(client.clientId)) throw new Error();
    const requested = scopeList(value.scopes);
    const endpoints = pod.endpoints as Record<string, unknown>;
    for (const key of ['authorization', 'token', 'jwks']) {
      endpoint({ [key]: endpoints[key] }, key, base);
    }
    // Optional metadata: a did:web binding may have no registration endpoint.
    if (endpoints.registration !== null)
      endpoint({ registration: endpoints.registration }, 'registration', base);
    const scopes = pod.scopes as Record<string, unknown>;
    for (const key of ['resource', 'authorizationServer']) {
      if (
        scopes[key] !== null &&
        (!Array.isArray(scopes[key]) ||
          !scopes[key].every(
            (s: unknown) =>
              typeof s === 'string' && /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(s),
          ))
      )
        throw new Error();
    }
    if (
      typeof pod.supportsRefreshToken !== 'boolean' ||
      typeof pod.authorizationResponseIssSupported !== 'boolean'
    )
      throw new Error();
    return freezeBinding({
      pod: {
        podUrl: pod.podUrl,
        issuer: pod.issuer,
        endpoints: {
          authorization: endpoints.authorization as string,
          token: endpoints.token as string,
          registration: endpoints.registration as string | null,
          jwks: endpoints.jwks as string,
        },
        scopes: {
          resource:
            scopes.resource === null
              ? null
              : [...(scopes.resource as string[])],
          authorizationServer:
            scopes.authorizationServer === null
              ? null
              : [...(scopes.authorizationServer as string[])],
        },
        supportsRefreshToken: pod.supportsRefreshToken,
        authorizationResponseIssSupported:
          pod.authorizationResponseIssSupported,
      },
      scopes: requested,
      client: {
        kind: client.kind as OAuthClient['kind'],
        podUrl: pod.podUrl,
        issuer: pod.issuer,
        redirectUri,
        clientId: client.clientId,
      },
    });
  } catch {
    throw new OAuthError('attempt');
  }
}
