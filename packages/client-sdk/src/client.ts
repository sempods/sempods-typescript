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
  FindGraph,
  FindOptions,
  GetResult,
  JsonLd,
  MatchCondition,
  Overwrite,
  QueryResult,
  ReadOptions,
  Refused,
  Stopped,
  ValueOutcome,
  WriteOptions,
  WriteResult,
} from './results.js';
import { ABSOLUTE_IRI } from './iri.js';
import { decodeSelect } from './sparql.js';

const cancelled: Cancelled = Object.freeze({ kind: 'cancelled' });
const stopped: Stopped = Object.freeze({ kind: 'stopped' });
const JSON_LD = 'application/ld+json';
/** RFC 9110 strong entity-tag: quoted, no `W/`, no wildcard. */
const STRONG_ETAG = /^"[\x21\x23-\x7E\x80-\xFF]*"$/;

/**
 * How a value write's success is read beyond its status (SPS-CRUD-044,
 * -047, -052): each outcome this operation may report, with the status that
 * must carry it, and for an added IRI the edge route its `Location` names.
 */
/** How long an applied value write waits for its outcome body. */
const OUTCOME_WAIT_MS = 5000;
const STALLED = Symbol('stalled');
/** An outcome body is a few bytes; a larger one is not read further. */
const OUTCOME_LIMIT = 64 * 1024;

interface ValueAnswer {
  readonly outcomes: Readonly<Partial<Record<ValueOutcome, 200 | 201>>>;
  readonly edge?: string;
}

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
    value?: ValueAnswer,
  ): Promise<WriteResult> {
    if (exchange.kind === 'not-sent')
      return { kind: 'not-sent', reason: exchange.reason };
    if (exchange.kind === 'lost')
      return {
        kind: 'uncertain',
        failure: { code: 'transport', problem: exchange.reason },
      };
    const response = exchange.response;
    const status = response.status;
    const untrusted = untrustedTarget(response, url);
    if (untrusted || !value || !success.includes(status)) discard(response);
    // A seen answer may still be untrustworthy; the write may have happened.
    if (untrusted)
      return {
        kind: 'uncertain',
        failure: { code: 'response', problem: 'redirected' },
      };
    if (success.includes(status)) {
      if (value) return valueApplied(response, url, value);
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
   * Resource writes claim no entity tag (SPS-CRUD-030). A creation's `Location` must name
   * the created subject's own system route (SPS-CRUD-043), with no query or the
   * request's `?context=`; anything else is not adopted as its identity. An
   * added value's `Location` names its edge route instead (`created`). Empty
   * query/fragment delimiters are removed from an otherwise accepted URL.
   */
  function createdAt(
    response: Response,
    url: string,
    created = url,
  ): string | undefined {
    const header = response.headers.get('location');
    if (response.status !== 201 || !header) return undefined;
    try {
      const route = new URL(created);
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

  /**
   * A value write that succeeded. Its outcome body and tag are informative:
   * when one is missing or does not fit, the write still happened and only
   * that field is left out.
   */
  async function valueApplied(
    response: Response,
    url: string,
    value: ValueAnswer,
  ): Promise<WriteResult> {
    const status = response.status as 200 | 201 | 204;
    const etag = response.headers.get('etag');
    const location =
      value.edge === undefined
        ? undefined
        : createdAt(response, url, value.edge);
    const outcome = await outcomeOf(response, value);
    return {
      kind: 'applied',
      status,
      ...(location ? { location } : {}),
      ...(etag && STRONG_ETAG.test(etag) ? { etag } : {}),
      ...(outcome ? { outcome } : {}),
    };
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

    /** The resource, slot or single-edge route (SPS-CRUD-005) in this Context. */
    function resourceUrl(...iris: readonly string[]): string {
      if (!iris.every((iri) => ABSOLUTE_IRI.test(iri)))
        throw failure({ code: 'invalid-argument', argument: 'iri' });
      const url = new URL(
        `${base}/_system/resources/${iris.map(base64url).join('/')}`,
      );
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
      method: 'PUT' | 'PATCH' | 'POST' | 'DELETE',
      url: string,
      condition: CreateCondition | MatchCondition | Overwrite,
      options: WriteOptions,
      success: readonly number[],
      body?: {
        readonly type: string;
        readonly value: JsonLd | readonly JsonLd[];
      },
      value?: ValueAnswer,
    ): Promise<WriteResult> {
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
      return write(exchange, url, success, value);
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
        put: async (
          iri: string,
          body: JsonLd,
          condition: CreateCondition | MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change('PUT', resourceUrl(iri), condition, options, [200, 201, 204], {
            type: JSON_LD,
            value: body,
          }),
        patch: async (
          iri: string,
          patch: JsonLd,
          condition: MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change('PATCH', resourceUrl(iri), condition, options, [200, 204], {
            type: 'application/merge-patch+json',
            value: patch,
          }),
        delete: async (
          iri: string,
          condition: MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) => change('DELETE', resourceUrl(iri), condition, options, [200, 204]),
      }),
      values: Object.freeze({
        async get(
          iri: string,
          predicate: string,
          options: ReadOptions = {},
        ): Promise<GetResult<readonly JsonLd[]>> {
          const url = resourceUrl(iri, predicate);
          const exchange = await execute(
            request('GET', url, { accept: JSON_LD }, guards, options.signal),
          );
          return read(
            exchange,
            url,
            options.signal,
            async (response) => {
              const etag = response.headers.get('etag');
              const body = await json(response);
              if (!Array.isArray(body) || !body.every(isNode))
                throw failure({ code: 'response', problem: 'body' });
              if (!etag || !STRONG_ETAG.test(etag)) {
                // An empty slot carries no tag (SPS-CRUD-050, -059): absent.
                if (body.length === 0 && !etag)
                  return { kind: 'not-found' as const };
                // One Context with a value always has one.
                throw failure({ code: 'response', problem: 'etag' });
              }
              return { kind: 'ok' as const, body: Object.freeze(body), etag };
            },
            () => ({ kind: 'not-found' as const }),
          );
        },
        add: async (
          iri: string,
          predicate: string,
          value: JsonLd,
          condition: CreateCondition | MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) => {
          const url = resourceUrl(iri, predicate);
          const target = value['@id'];
          return change(
            'POST',
            url,
            condition,
            options,
            [200, 201, 204],
            { type: JSON_LD, value },
            {
              outcomes: { created: 201, already_present: 200 },
              // Only an added IRI has an edge for `Location` to name.
              ...(typeof target === 'string' && ABSOLUTE_IRI.test(target)
                ? { edge: resourceUrl(iri, predicate, target) }
                : {}),
            },
          );
        },
        replace: async (
          iri: string,
          predicate: string,
          values: readonly JsonLd[],
          condition: CreateCondition | MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change(
            'PUT',
            resourceUrl(iri, predicate),
            condition,
            options,
            [200, 204],
            { type: JSON_LD, value: values },
            { outcomes: {} },
          ),
        clear: async (
          iri: string,
          predicate: string,
          condition: MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change(
            'DELETE',
            resourceUrl(iri, predicate),
            condition,
            options,
            [200, 204],
            undefined,
            { outcomes: { cleared: 200, already_empty: 200 } },
          ),
        remove: async (
          iri: string,
          predicate: string,
          target: string,
          condition: CreateCondition | MatchCondition | Overwrite,
          options: WriteOptions = {},
        ) =>
          change(
            'DELETE',
            resourceUrl(iri, predicate, target),
            condition,
            options,
            [200, 204],
            undefined,
            { outcomes: { removed: 200, already_absent: 200 } },
          ),
      }),
      sparql: Object.freeze({
        select: (query: string, options: ReadOptions = {}) =>
          sparql(
            query,
            'application/sparql-results+json',
            decodeSelect,
            guards,
            options,
            contextIri,
          ),
        construct: (query: string, options: ReadOptions = {}) =>
          sparql(query, JSON_LD, constructBody, guards, options, contextIri),
      }),
    });
  }

  async function sparql<T>(
    query: string,
    accept: string,
    decode: (body: unknown) => T,
    guards: readonly DispatchGuard[],
    options: ReadOptions,
    contextIri?: string,
  ): Promise<QueryResult<T>> {
    if (!query.trim())
      throw failure({ code: 'invalid-argument', argument: 'query' });
    const url = new URL(`${base}/_system/sparql/query`);
    if (contextIri !== undefined) {
      // Keep this downscope on every dispatch, including authentication retry.
      url.searchParams.set('default-graph-uri', contextIri);
      url.searchParams.set('named-graph-uri', contextIri);
    }
    const exchange = await execute(
      request(
        'POST',
        url.href,
        { accept, 'content-type': 'application/sparql-query' },
        guards,
        options.signal,
        query,
      ),
    );
    return read(exchange, url.href, options.signal, async (response) => ({
      kind: 'ok' as const,
      body: decode(await json(response, accept)),
    }));
  }

  return Object.freeze({
    podUrl: base,
    context,
    sparql: Object.freeze({
      select: (query: string, options: ReadOptions = {}) =>
        sparql(
          query,
          'application/sparql-results+json',
          decodeSelect,
          podGuards,
          options,
        ),
      construct: (query: string, options: ReadOptions = {}) =>
        sparql(query, JSON_LD, constructBody, podGuards, options),
    }),
    async find(
      text: string,
      options: FindOptions = {},
    ): Promise<QueryResult<readonly FindGraph[]>> {
      if (typeof text !== 'string' || !text.trim())
        throw failure({ code: 'invalid-argument', argument: 'text' });
      const { contexts, limit } = options;
      if (
        contexts !== undefined &&
        (!Array.isArray(contexts) ||
          !contexts.every(
            (iri) => typeof iri === 'string' && isContextIri(iri, base),
          ))
      )
        throw failure({ code: 'invalid-argument', argument: 'context' });
      if (limit !== undefined && !(Number.isSafeInteger(limit) && limit > 0))
        throw failure({ code: 'invalid-argument', argument: 'limit' });
      const scope = contexts && [...contexts];
      // One body for every dispatch: an authentication resend repeats it, so
      // the downscope (also an empty one) is never dropped.
      const body = JSON.stringify({
        text,
        include_contexts: true,
        ...(scope ? { contexts: scope } : {}),
        ...(limit === undefined ? {} : { limit }),
      });
      const url = `${base}/_system/find`;
      const exchange = await execute(
        request(
          'POST',
          url,
          { accept: JSON_LD, 'content-type': 'application/json' },
          podGuards,
          options.signal,
          body,
        ),
      );
      return read(exchange, url, options.signal, async (response) => ({
        kind: 'ok' as const,
        body: findBody(await json(response), base, scope),
      }));
    },
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
      // The Context IRI is its own registry route (SPS-CTX-031). Raw Unicode is
      // allowed in the IRI; the request uses its one serialized URL form.
      if (!isContextIri(contextIri, base))
        throw failure({ code: 'invalid-argument', argument: 'context' });
      const url = new URL(contextIri).href;
      const exchange = await execute(
        request('GET', url, { accept: JSON_LD }, podGuards, options.signal),
      );
      return read(exchange, url, options.signal, async (response) => ({
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

async function json(response: Response, expected = JSON_LD): Promise<unknown> {
  const type = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (
    type !== expected &&
    !(expected === JSON_LD && type === 'application/json')
  ) {
    discard(response);
    throw failure({ code: 'response', problem: 'content-type' });
  }
  try {
    return (await response.json()) as unknown;
  } catch (cause) {
    throw failure({ code: 'response', problem: 'body' }, cause);
  }
}

/**
 * The `{"outcome": …}` body of a value write (SPS-CRUD-044), when it is one
 * this operation reports with the answered status; otherwise nothing.
 */
async function outcomeOf(
  response: Response,
  value: ValueAnswer,
): Promise<ValueOutcome | undefined> {
  const type = response.headers
    .get('content-type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (
    response.status === 204 ||
    (type !== 'application/json' && type !== JSON_LD)
  ) {
    discard(response);
    return undefined;
  }
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  // The write already happened: a body that stalls must not hold its result,
  // and one given up on is cancelled, not left reading and buffering.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), OUTCOME_WAIT_MS);
  });
  let text: string | typeof STALLED | undefined;
  try {
    text = await Promise.race([readOutcome(reader), stalled]);
  } catch {
    text = undefined;
  } finally {
    clearTimeout(timer);
  }
  if (typeof text !== 'string') {
    void reader.cancel().catch(() => {});
    return undefined;
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  const outcome = isNode(body) ? body['outcome'] : undefined;
  return typeof outcome === 'string' &&
    Object.hasOwn(value.outcomes, outcome) &&
    value.outcomes[outcome as ValueOutcome] === response.status
    ? (outcome as ValueOutcome)
    : undefined;
}

/** The body as text, or `undefined` once it grows past an outcome's size. */
async function readOutcome(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<string | undefined> {
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > OUTCOME_LIMIT) return undefined;
    text += decoder.decode(value, { stream: true });
  }
}

function constructBody(body: unknown): readonly JsonLd[] {
  if (!Array.isArray(body) || !body.every(isNode))
    throw failure({ code: 'response', problem: 'body' });
  return Object.freeze(body);
}

/**
 * Named-graph JSON-LD (SPS-FIND-019): every group names its source Context.
 * A group without one, of another Pod, or outside the requested downscope
 * (SPS-FIND-010) makes the whole answer untrusted; nodes stay as answered.
 */
function findBody(
  body: unknown,
  base: string,
  scope: readonly string[] | undefined,
): readonly FindGraph[] {
  const requested = scope && new Set(scope);
  if (!Array.isArray(body))
    throw failure({ code: 'response', problem: 'body' });
  return Object.freeze(
    body.map((group: unknown) => {
      const context = isNode(group) ? group['@id'] : undefined;
      const nodes = isNode(group) ? group['@graph'] : undefined;
      if (
        typeof context !== 'string' ||
        !isContextIri(context, base) ||
        (requested && !requested.has(context)) ||
        !Array.isArray(nodes) ||
        !nodes.every(isNode)
      )
        throw failure({ code: 'response', problem: 'body' });
      return Object.freeze({ context, nodes: Object.freeze(nodes) });
    }),
  );
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
