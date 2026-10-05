export { discoverPod } from './discovery.js';
export type { DiscoveryOptions, PodDiscovery } from './discovery.js';
export { createClientRegistry } from './client-registry.js';
export type {
  ClientIdentity,
  OAuthClient,
  ClientRegistry,
  ClientRegistryOptions,
} from './client-registry.js';
export { OAuthError } from './errors.js';
export type { OAuthFailure, OAuthProblem } from './errors.js';
export {
  prepareAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
} from './authorization.js';
export type { AuthorizationAttempt, ExchangeResult } from './authorization.js';
export type { OAuthBinding } from './binding.js';
// Persistence/resume helpers for session coordinators live in `./oauth/host`.
