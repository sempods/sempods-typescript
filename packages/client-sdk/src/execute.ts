import type { AuthCredential, PodAuth } from './auth.js';
import { SdkError } from './errors.js';
import type { DispatchGuard } from './pod.js';
import type { PodFetch, PodRequestInit } from './transport.js';

/** One logical request, captured once; a resend repeats exactly this. */
export interface PodRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly guards: readonly DispatchGuard[];
}

/** What happened to one logical request, before operation-specific mapping. */
export type Exchange =
  /** Nothing was dispatched. */
  | { readonly kind: 'not-sent'; readonly reason: 'cancelled' | 'stopped' }
  /** The last dispatch was answered (possibly the first 401, if no resend happened). */
  | { readonly kind: 'answered'; readonly response: Response }
  /** A dispatch got no answer: its outcome on the Pod is unknown. */
  | {
      readonly kind: 'lost';
      readonly reason: 'cancelled' | 'network';
      readonly cause: unknown;
    };

/**
 * The client's sole resend authority. The credential owner renews; this
 * executor decides whether to send again: at most once, only after an answered
 * Bearer 401, only with a different credential, and only while the caller's
 * signal and every dispatch guard still allow it.
 */
export function createExecutor(auth: PodAuth, transport: PodFetch) {
  const allowed = (request: PodRequest) =>
    request.guards.every((guard) => guard());

  async function credential(
    request: PodRequest,
  ): Promise<AuthCredential | null> {
    try {
      return await auth.credential(
        request.signal
          ? { url: request.url, signal: request.signal }
          : { url: request.url },
      );
    } catch (cause) {
      if (cause instanceof SdkError) throw cause;
      throw new SdkError(
        { code: 'authentication' },
        'The credential owner failed before dispatch.',
        { cause },
      );
    }
  }

  async function dispatch(
    request: PodRequest,
    current: AuthCredential | null,
  ): Promise<Exchange> {
    const headers = new Headers(request.headers);
    if (current) headers.set('authorization', current.authorization);
    const init: PodRequestInit = {
      method: request.method,
      headers,
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(request.signal ? { signal: request.signal } : {}),
    };
    try {
      return {
        kind: 'answered',
        response: await transport(request.url, init),
      };
    } catch (cause) {
      // A rejected fetch cannot tell whether the Pod received the request.
      return {
        kind: 'lost',
        reason: request.signal?.aborted ? 'cancelled' : 'network',
        cause,
      };
    }
  }

  return async function execute(request: PodRequest): Promise<Exchange> {
    if (request.signal?.aborted)
      return { kind: 'not-sent', reason: 'cancelled' };
    if (!allowed(request)) return { kind: 'not-sent', reason: 'stopped' };
    let first: AuthCredential | null;
    try {
      first = await credential(request);
    } catch (error) {
      // A caller cancellation while waiting is not an authentication failure.
      if (request.signal?.aborted)
        return { kind: 'not-sent', reason: 'cancelled' };
      throw error;
    }
    // Decide immediately before dispatch, after every await.
    if (request.signal?.aborted)
      return { kind: 'not-sent', reason: 'cancelled' };
    if (!allowed(request)) return { kind: 'not-sent', reason: 'stopped' };
    const answer = await dispatch(request, first);
    if (
      answer.kind !== 'answered' ||
      // An answer from another URL is not trusted, so it cannot justify a resend.
      untrustedTarget(answer.response, request.url) ||
      answer.response.status !== 401 ||
      first === null ||
      !bearerChallenge(answer.response)
    ) {
      return answer;
    }
    const challenge = answer.response.headers.get('www-authenticate');
    void answer.response.body?.cancel().catch(() => {});
    // From here on, without a second dispatch the known refusal stands.
    let renewed: boolean;
    try {
      renewed = await auth.renew(
        first,
        request.signal
          ? { wwwAuthenticate: challenge, signal: request.signal }
          : { wwwAuthenticate: challenge },
      );
    } catch {
      renewed = false;
    }
    if (!renewed || request.signal?.aborted || !allowed(request)) return answer;
    let replacement: AuthCredential | null;
    try {
      replacement = await credential(request);
    } catch {
      return answer;
    }
    if (
      replacement === null ||
      replacement === first ||
      request.signal?.aborted ||
      !allowed(request)
    ) {
      return answer;
    }
    return dispatch(request, replacement);
  };
}

export type Executor = ReturnType<typeof createExecutor>;

/** SPS-CORE-015: a recoverable refusal carries a Bearer challenge. */
function bearerChallenge(response: Response): boolean {
  return challengeSchemes(response.headers.get('www-authenticate') ?? '').some(
    (scheme) => scheme.toLowerCase() === 'bearer',
  );
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+/;

/**
 * Auth schemes of a `WWW-Authenticate` value (RFC 9110 §11.6.1), conservatively.
 * Commas inside quoted strings do not split; an element whose leading token is
 * followed by `=` is an auth-param of the previous challenge, not a scheme.
 * Malformed input (an unterminated quoted string) yields no schemes.
 */
export function challengeSchemes(header: string): string[] {
  const elements: string[] = [];
  let element = '';
  let quoted = false;
  for (let i = 0; i < header.length; i++) {
    const char = header[i]!;
    if (quoted && char === '\\') {
      element += char + (header[++i] ?? '');
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (char === ',' && !quoted) {
      elements.push(element);
      element = '';
    } else element += char;
  }
  if (quoted) return [];
  elements.push(element);
  const schemes: string[] = [];
  for (const raw of elements) {
    const item = raw.trim();
    const scheme = TOKEN.exec(item)?.[0];
    if (!scheme) continue;
    const rest = item.slice(scheme.length);
    if (rest === '' || (/^\s/.test(rest) && !rest.trimStart().startsWith('=')))
      schemes.push(scheme);
  }
  return schemes;
}

/** Redirects are refused by policy; an answer from another URL is not trusted. */
export function untrustedTarget(response: Response, url: string): boolean {
  return (
    response.redirected ||
    response.type === 'opaqueredirect' ||
    (response.url !== '' && response.url !== url)
  );
}
