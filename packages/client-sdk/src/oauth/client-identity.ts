import { OAuthError, type OAuthProblem } from './errors.js';
const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Deliberately canonical browser callbacks; preserve the exact URI for OAuth. */
/** Authorization-response parameters (RFC 6749 4.1.2, RFC 9207, JARM): a callback must not own them. */
const reservedCallbackParameters = [
  'code',
  'state',
  'iss',
  'error',
  'error_description',
  'error_uri',
  'response',
];
export function callbackUrl(value: string, development: boolean): URL {
  try {
    const url = new URL(value);
    const loopback = loopbackHosts.has(url.hostname);
    const host = url.hostname;
    const dnsName = host
      .replace(/\.$/, '')
      .split('.')
      .every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
    if (
      (!host.startsWith('[') && !dnsName) ||
      url.href !== value ||
      url.username ||
      url.password ||
      value.includes('#') ||
      /%(?![0-9a-f]{2})/i.test(value) ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      (loopback && !development) ||
      reservedCallbackParameters.some((name) => url.searchParams.has(name))
    ) {
      throw new Error(
        'Expected a canonical HTTPS callback, or explicit loopback development.',
      );
    }
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) {
      throw new Error('Callback query keys must be unique.');
    }
    // Also reject dot segments hidden behind an encoded slash (the server decodes paths).
    if (
      decodeURIComponent(url.pathname)
        .split('/')
        .some((part) => part === '.' || part === '..')
    ) {
      throw new Error('Callback path contains dot segments.');
    }
    return url;
  } catch (cause) {
    throw clientFailure('invalid-config', 'redirectUri', cause);
  }
}

/**
 * Structural did:web check only. Never dereference a DID document.
 * Outside loopback development, the host must be a domain name with a dot: the
 * did:web method forbids IP literals, and `*.localhost` names resolve to loopback.
 */
export function checkDidWeb(clientId: string, redirect: URL): void {
  try {
    if (!clientId.startsWith('did:web:')) throw new Error('Expected did:web.');
    const [encodedHost, ...encodedPath] = clientId
      .slice('did:web:'.length)
      .split(':');
    const host = decodeURIComponent(encodedHost!);
    const target = new URL(`https://${host}`);
    // Match the canonical form produced by Kotlin DidWeb.clientId. Reject ambiguous identities.
    if (host !== target.host || target.username || target.password)
      throw new Error('Invalid DID authority.');
    // Loopback stays possible: callbackUrl admits it only in development (SPS-AUTH-006).
    const labels = target.hostname.replace(/\.$/, '').split('.');
    if (
      !loopbackHosts.has(target.hostname) &&
      (target.hostname.startsWith('[') ||
        /^\d+(?:\.\d+){3}$/.test(target.hostname) ||
        labels.length < 2 ||
        ['localhost', 'invalid'].includes(labels.at(-1)!))
    )
      throw new Error('Expected a did:web domain name.');
    const path = encodedPath.map((part) => decodeURIComponent(part));
    if (
      path.some(
        (part) =>
          !/^[A-Za-z0-9._-]+$/.test(part) || part === '.' || part === '..',
      )
    ) {
      throw new Error('Expected simple did:web path segments.');
    }
    const prefix = '/' + path.join('/');
    const callbackPath = decodeURIComponent(redirect.pathname);
    const port =
      redirect.port || (redirect.protocol === 'https:' ? '443' : '80');
    if (
      target.hostname !== redirect.hostname ||
      (target.port || '443') !== port ||
      (prefix !== '/' &&
        callbackPath !== prefix &&
        !callbackPath.startsWith(prefix + '/'))
    ) {
      throw new Error('DID authority or path does not cover the callback.');
    }
  } catch (cause) {
    throw clientFailure('invalid-config', 'clientId', cause);
  }
}

/** Only registered loopback callbacks ignore ports; did:web always checks them. */
export function sameRegisteredCallback(
  actual: string,
  expected: string,
  development: boolean,
): boolean {
  try {
    if (actual === expected) return true;
    const requested = callbackUrl(expected, development);
    if (!loopbackHosts.has(requested.hostname)) return false;
    // Parse to reject invalid ports, but compare raw strings: only the port may differ.
    // A stored explicit default port is valid even though URL.href would remove it.
    new URL(actual);
    const withoutPort = (value: string) =>
      value.replace(
        /^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?::[0-9]+)?(?=[/?]|$)/,
        '$1',
      );
    return withoutPort(actual) === withoutPort(expected);
  } catch {
    return false;
  }
}

export function checkClientCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) throw clientFailure('cancelled');
}

export function clientFailure(
  problem: OAuthProblem,
  field?: string,
  _cause?: unknown,
  status?: number,
): OAuthError {
  return new OAuthError(problem, field, status, 'client-identity');
}
