import { SdkError } from './errors.js';

/**
 * Canonical pod base URL without a trailing slash, query, fragment or user
 * information. HTTPS only; loopback HTTP needs the explicit development option.
 * Same rule as discovery; ambiguous input is rejected, never normalized.
 */
export function canonicalPodUrl(
  value: string,
  development?: 'loopback-http',
): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw invalid(cause);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const allowed =
    url.protocol === 'https:' ||
    (development === 'loopback-http' && url.protocol === 'http:' && loopback);
  if (
    !allowed ||
    url.username ||
    url.password ||
    /[?#]/.test(value) ||
    value !== url.href.replace(/\/$/, '')
  ) {
    throw invalid();
  }
  return value;
}

function invalid(cause?: unknown): SdkError {
  return new SdkError(
    { code: 'invalid-pod-url' },
    'Expected a canonical pod base URL without a trailing slash.',
    cause === undefined ? undefined : { cause },
  );
}
