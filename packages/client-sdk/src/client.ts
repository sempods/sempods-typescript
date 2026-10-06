import {
  decodeCatalogue,
  decodeContextDescription,
  isContextIri,
  type CatalogueContext,
  type ContextDescription,
} from './catalogue.js';
import { SdkError, type SdkFailure } from './errors.js';
import {
  createExecutor,
  untrustedTarget,
  type Exchange,
  type PodRequest,
} from './execute.js';
import type {
  ContextOptions,
  ContextView,
  DispatchGuard,
  Pod,
  PodOptions,
} from './pod.js';
import { canonicalPodUrl } from './pod-url.js';
import type {
  Cancelled,
  CreateCondition,
  GetResult,
  JsonLd,
  MatchCondition,
  Overwrite,
  QueryResult,
  ReadOptions,
  Refused,
  Stopped,
  WriteOptions,
  WriteResult,
} from './results.js';
import { ABSOLUTE_IRI } from './iri.js';

const cancelled: Cancelled = Object.freeze({ kind: 'cancelled' });
const stopped: Stopped = Object.freeze({ kind: 'stopped' });
const JSON_LD = 'application/ld+json';
/** RFC 9110 strong entity-tag: quoted, no `W/`, no wildcard. */
const STRONG_ETAG = /^"[\x21\x23-\x7E\x80-\xFF]*"$/;

/**
 * A pod handle for one canonical pod and one credential owner. Requests go only
 * to SDK-constructed endpoints of this pod; resource IRIs are identifiers in
 * the system route, never fetched at their own origin. Importing starts nothing.
 */
export function createPod(podUrl: string, options: PodOptions): Pod {
  const base = canonicalPodUrl(podUrl, options.development);
  const execute = createExecutor(
    options.auth,
    options.fetch ?? ((url, init) => globalThis.fetch(url, init)),
  );
  const podGuards: readonly DispatchGuard[] = options.beforeDispatch
    ? [options.beforeDispatch]
    : [];

  function request(
    method: PodRequest['method'],
    url: string,
    headers: Record<string, string>,
    guards: readonly DispatchGuard[],
    signal: AbortSignal | undefined,
    body?: string,
  ): PodRequest {
    return {
      method,
      url,
      headers,
      guards,
      ...(signal ? { signal } : {}),
      ...(body === undefined ? {} : { body }),
    };
  }

  /** Shared read mapping: refusals and cancellation are results, other failures reject. */
  async function read<T, N = never>(
    exchange: Exchange,
    url: string,
    signal: AbortSignal | undefined,
    ok: (response: Response) => Promise<T>,
    notFound?: () => N,
  ): Promise<T | N | Refused | Cancelled | Stopped> {
    if (exchange.kind === 'not-sent')
      return exchange.reason === 'cancelled' ? cancelled : stopped;
    if (exchange.kind === 'lost') {
      if (exchange.reason === 'cancelled') return cancelled;
      throw failure({ code: 'transport', problem: 'network' }, exchange.cause);
    }
    const response = exchange.response;
    if (untrustedTarget(response, url)) {
      discard(response);
      throw failure({ code: 'response', problem: 'redirected' });
    }
    if (signal?.aborted) {
      discard(response);
      return cancelled;
    }
    if (response.status === 401 || response.status === 403) {
      discard(response);
      return { kind: 'refused', status: response.status };
    }
    if (response.status === 404 && notFound) {
      discard(response);
      return notFound();
    }
    if (response.status !== 200) {
      discard(response);
      throw failure({ code: 'http', status: response.status });
    }
    try {
      return await ok(response);
    } catch (cause) {
      if (signal?.aborted) return cancelled;
      throw cause;
    }
  }

  async function write(
    exchange: Exchange,
    url: string,
    success: readonly number[],
  ): Promise<WriteResult> {
    if (exchange.kind === 'not-sent')
      return { kind: 'not-sent', reason: exchange.reason };
    if (exchange.kind === 'lost')
      return {
        kind: 'uncertain',
        failure: { code: 'transport', problem: exchange.reason },
      };
    const response = exchange.response;
    discard(response);
    // A seen answer may still be untrustworthy; the write may have happened.
    if (untrustedTarget(response, url))
      return {
        kind: 'uncertain',
        failure: { code: 'response', problem: 'redirected' },
      };
    const status = response.status;
    if (success.includes(status)) {
      const location = createdAt(response, url);
      return {
        kind: 'applied',
        status: status as 200 | 201 | 204,
        ...(location ? { location } : {}),
      };
    }
    if (status === 412) return { kind: 'precondition-failed' };
    if (status === 404) return { kind: 'not-found' };
    if (status === 401 || status === 403) return { kind: 'refused', status };
    // An unexpected non-error answer (e.g. 202 Accepted) or a 5xx does not prove
    // that nothing happened: the outcome is unknown and is never resent.
    if (status < 400 || status >= 500)
      return { kind: 'uncertain', failure: { code: 'http', status } };
    // Any other answered 4xx: the Pod refused before acting.
    throw failure({ code: 'http', status });
  }

  /**
   * Writes claim no entity tag (SPS-CRUD-030). A creation's `Location` must name
   * the created subject's own system route (SPS-CRUD-043), with no query or the
   * request's `?context=`; anything else is not adopted as its identity. Empty
   * query/fragment delimiters are removed from an otherwise accepted URL.
   */
  function createdAt(response: Response, url: string): string | undefined {
    const header = response.headers.get('location');
    if (response.status !== 201 || !header) return undefined;
    try {
      const route = new URL(url);
      const location = new URL(header, url);
      if (
        location.origin !== route.origin ||
        location.pathname !== route.pathname ||
        (location.search !== '' && location.search !== route.search) ||
        location.hash !== '' ||
        location.username ||
        location.password
      )
        return undefined;
      // URL.search/hash hide bare delimiters, while href preserves them.
      // Normalize only after validating the target and any nonempty query.
      if (location.search === '') location.search = '';
      location.hash = '';
      return location.href;
    } catch {
      return undefined;
    }
  }

  function context(
    contextIri: string,
    contextOptions: ContextOptions = {},
  ): ContextView {
    if (!ABSOLUTE_IRI.test(contextIri))
      throw failure({ code: 'invalid-argument', argument: 'context' });
    const guards: readonly DispatchGuard[] = contextOptions.beforeDispatch
      ? [...podGuards, contextOptions.beforeDispatch]
      : podGuards;

    function resourceUrl(iri: string): string {
      if (!ABSOLUTE_IRI.test(iri))
        throw failure({ code: 'invalid-argument', argument: 'iri' });
      const url = new URL(`${base}/_system/resources/${base64url(iri)}`);
      url.searchParams.set('context', contextIri);
      return url.href;
    }

    function conditionHeaders(
      condition: CreateCondition | MatchCondition | Overwrite,
    ): Record<string, string> {
      if ('ifMatch' in condition) {
        // Only a version that was read; `*` would match any representation.
        if (!STRONG_ETAG.test(condition.ifMatch))
          throw failure({ code: 'invalid-argument', argument: 'condition' });
        return { 'if-match': condition.ifMatch };
      }
      if ('ifNoneMatch' in condition) return { 'if-none-match': '*' };
      return {};
    }

    async function change(
      method: 'PUT' | 'PATCH' | 'DELETE',
      iri: string,
      condition: CreateCondition | MatchCondition | Overwrite,
      options: WriteOptions,
      success: readonly number[],
      body?: { readonly type: string; readonly value: JsonLd },
    ): Promise<WriteResult> {
      const url = resourceUrl(iri);
      const headers = {
        ...conditionHeaders(condition),
        ...(body ? { 'content-type': body.type } : {}),
      };
      const exchange = await execute(
        request(
          method,
          url,
          headers,
          guards,
          options.signal,
          body ? JSON.stringify(body.value) : undefined,
        ),
      );
      return write(exchange, url, success);
    }

    return Object.freeze({
      podUrl: base,
      contextIri,
      subjects: Object.freeze({
        async get(
          iri: string,
          options: ReadOptions = {},
        ): Promise<GetResult<JsonLd>> {
          const url = resourceUrl(iri);
          const exchange = await execute(
            request('GET', url, { accept: JSON_LD }, guards, options.signal),
          );
          return read(
            exchange,
            url,
            options.signal,
            async (response) => {
              const etag = response.headers.get('etag');
              if (!etag || !STRONG_ETAG.test(etag)) {
                discard(response);
                throw failure({ code: 'response', problem: 'etag' });
              }
              const body = await json(response);
              if (!isNode(body))
                throw failure({ code: 'response', problem: 'body' });
              return { kind: 'ok' as const, body, etag };
            },
            () => ({ kind: 'not-found' as const }),
          );
        },
        put: (
          iri: string,
          body: JsonLd,
          condition: CreateCondition | MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change('PUT', iri, condition, options, [200, 201, 204], {
            type: JSON_LD,
            value: body,
          }),
        patch: (
          iri: string,
          patch: JsonLd,
          condition: MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change('PATCH', iri, condition, options, [200, 204], {
            type: 'application/merge-patch+json',
            value: patch,
          }),
        delete: (
          iri: string,
          condition: MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) => change('DELETE', iri, condition, options, [200, 204]),
      }),
      sparql: Object.freeze({
        async construct(
          query: string,
          options: ReadOptions = {},
        ): Promise<QueryResult<readonly JsonLd[]>> {
          if (!query.trim())
            throw failure({ code: 'invalid-argument', argument: 'query' });
          const url = new URL(`${base}/_system/sparql/query`);
          // Downscope to exactly this context (SPS-SPARQL-011–014).
          url.searchParams.set('default-graph-uri', contextIri);
          url.searchParams.set('named-graph-uri', contextIri);
          const exchange = await execute(
            request(
              'POST',
              url.href,
              { accept: JSON_LD, 'content-type': 'application/sparql-query' },
              guards,
              options.signal,
              query,
            ),
          );
          return read(exchange, url.href, options.signal, async (response) => {
            const body = await json(response);
            if (!Array.isArray(body) || !body.every(isNode))
              throw failure({ code: 'response', problem: 'body' });
            return { kind: 'ok' as const, body: Object.freeze(body) };
          });
        },
      }),
    });
  }

  return Object.freeze({
    podUrl: base,
    context,
    async catalogue(
      options: ReadOptions = {},
    ): Promise<QueryResult<readonly CatalogueContext[]>> {
      const url = `${base}/_system/contexts`;
      const exchange = await execute(
        request('GET', url, { accept: JSON_LD }, podGuards, options.signal),
      );
      return read(exchange, url, options.signal, async (response) => ({
        kind: 'ok' as const,
        body: decodeCatalogue(await json(response), base),
      }));
    },
    async contextDescription(
      contextIri: string,
      options: ReadOptions = {},
    ): Promise<QueryResult<ContextDescription>> {
      // The Context IRI is its own registry route (SPS-CTX-031).
      if (!isContextIri(contextIri, base))
        throw failure({ code: 'invalid-argument', argument: 'context' });
      const exchange = await execute(
        request(
          'GET',
          contextIri,
          { accept: JSON_LD },
          podGuards,
          options.signal,
        ),
      );
      return read(exchange, contextIri, options.signal, async (response) => ({
        kind: 'ok' as const,
        body: decodeContextDescription(await json(response), contextIri, base),
      }));
    },
  });
}

function failure(reason: SdkFailure, cause?: unknown): SdkError {
  return new SdkError(
    reason,
    `Pod request failed: ${reason.code}.`,
    cause === undefined ? undefined : { cause },
  );
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

async function json(response: Response): Promise<unknown> {
  const type = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (type !== JSON_LD && type !== 'application/json') {
    discard(response);
    throw failure({ code: 'response', problem: 'content-type' });
  }
  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw failure({ code: 'response', problem: 'body' }, cause);
  }
}

function isNode(value: unknown): value is JsonLd {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** UTF-8 base64url without padding (SPS-CRUD-005); works in browsers and Node. */
function base64url(iri: string): string {
  const bytes = new TextEncoder().encode(iri);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
