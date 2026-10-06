import { describe, expect, it, vi } from 'vitest';
import {
  bearer,
  createPod,
  type AuthCredential,
  type Pod,
  type PodAuth,
  type PodFetch,
  type SelectResult,
} from './index.js';

const base = 'https://pod.example/alice';
const context = `${base}/_system/contexts/tasks`;
const media = 'application/sparql-results+json';
const result = (bindings: unknown = [], vars: unknown = ['x']) => ({
  head: { vars },
  results: { bindings },
});
const response = (body: unknown, type = media) =>
  new Response(JSON.stringify(body), {
    headers: { 'content-type': type },
  });
const select = async (body: unknown): Promise<SelectResult> => {
  const pod = createPod(base, {
    auth: bearer('test'),
    fetch: async () => response(body),
  });
  const answer = await pod.sparql.select('SELECT ?x WHERE { ?x ?p ?o }');
  if (answer.kind !== 'ok') throw new Error(answer.kind);
  return answer.body;
};

describe('SELECT decoding', () => {
  it('retains projected order, duplicate rows, unbound variables and RDF lexical values', async () => {
    const row = {
      resource: { type: 'uri', value: 'urn:example:ä' },
      blank: { type: 'bnode', value: 'b1' },
      title: { type: 'literal', value: 'Grüße', 'xml:lang': 'de-DE' },
      count: {
        type: 'literal',
        value: '01',
        datatype: 'http://www.w3.org/2001/XMLSchema#integer',
      },
      empty: { type: 'literal', value: '' },
    };
    const vars = ['absent', ...Object.keys(row)];
    const decoded = await select(result([row, row, {}], vars));
    expect(decoded.variables).toEqual(vars);
    expect(decoded.rows).toEqual([
      {
        resource: { type: 'iri', value: 'urn:example:ä' },
        blank: { type: 'blank', value: 'b1' },
        title: { type: 'literal', value: 'Grüße', language: 'de-DE' },
        count: {
          type: 'literal',
          value: '01',
          datatype: 'http://www.w3.org/2001/XMLSchema#integer',
        },
        empty: { type: 'literal', value: '' },
      },
      expect.any(Object),
      {},
    ]);
    expect(decoded.rows[1]).toEqual(decoded.rows[0]);
    expect(Object.hasOwn(decoded.rows[0]!, 'absent')).toBe(false);
    expect(Object.isFrozen(decoded.rows)).toBe(true);
  });

  it('preserves unsupported term payloads without requiring the known-term value shape', async () => {
    for (const term of [
      { type: 'typed-literal', value: '42', datatype: 'urn:integer' },
      { type: 'triple', value: { subject: { type: 'uri', value: 'urn:s' } } },
      { type: 'future', extension: [1, { nested: true }] },
    ]) {
      const decoded = await select(result([{ x: term }]));
      expect(decoded.rows[0]?.['x']).toEqual({ type: 'unsupported', term });
    }
  });

  it('preserves empty headers and projected headers without interpreting the query', async () => {
    expect(await select(result([], ['x', 'title']))).toEqual({
      variables: ['x', 'title'],
      rows: [],
    });
    expect(await select(result([], []))).toEqual({ variables: [], rows: [] });
    expect((await select(result([{}], []))).rows).toEqual([{}]);
  });

  it('handles prototype-like variable names and absent bindings as data', async () => {
    const term = { type: 'literal', value: 'value' };
    const bindings = JSON.parse(
      '{"__proto__":{"type":"literal","value":"value"}}',
    ) as unknown;
    const decoded = await select(
      result(
        [bindings, { constructor: term }, {}],
        ['__proto__', 'constructor', 'toString'],
      ),
    );
    expect(decoded.rows[0]?.['__proto__']).toEqual(term);
    expect(decoded.rows[0]?.['constructor']).toBeUndefined();
    expect(decoded.rows[1]?.['constructor']).toEqual(term);
    expect(decoded.rows[2]?.['toString']).toBeUndefined();
  });

  it.each([
    null,
    [],
    {},
    { head: {}, results: { bindings: [] } },
    { head: { vars: ['x'] } },
    result({}, ['x']),
    result([], [1]),
    result([null]),
    result([[]]),
    result([{ extra: { type: 'literal', value: 'x' } }]),
    { ...result(), boolean: true },
  ])('rejects malformed SELECT structure %#', async (body) => {
    await expect(select(body)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'body' },
    });
  });

  it.each([
    null,
    [],
    'x',
    {},
    { type: '' },
    { type: 1 },
    { type: 'uri' },
    { type: 'uri', value: 1 },
    { type: 'uri', value: 'relative' },
    { type: 'uri', value: 'urn:x', 'xml:lang': 'en' },
    { type: 'bnode', value: '' },
    { type: 'bnode', value: null },
    { type: 'bnode', value: 'b', datatype: 'urn:type' },
    { type: 'literal' },
    { type: 'literal', value: false },
    { type: 'literal', value: 'x', datatype: null },
    { type: 'literal', value: 'x', datatype: 'relative' },
    { type: 'literal', value: 'x', 'xml:lang': 1 },
    { type: 'literal', value: 'x', 'xml:lang': '' },
    { type: 'literal', value: 'x', 'xml:lang': 'en', datatype: 'urn:type' },
  ])(
    'rejects malformed terms instead of treating known terms as extensions %#',
    async (term) => {
      await expect(select(result([{ x: term }]))).rejects.toMatchObject({
        reason: { code: 'response', problem: 'body' },
      });
    },
  );
});

describe.each(['select', 'construct'] as const)('Pod %s requests', (method) => {
  const query =
    method === 'select'
      ? 'SELECT ?x WHERE { GRAPH ?g { ?x ?p ?o } }'
      : 'CONSTRUCT { ?x ?p ?o } WHERE { ?x ?p ?o }';
  const type = method === 'select' ? media : 'application/ld+json';
  const body = method === 'select' ? result() : [{ '@id': 'urn:result' }];
  const run = (pod: Pod, signal?: AbortSignal) =>
    pod.sparql[method](query, signal ? { signal } : {});

  it('makes exactly one authenticated POST with unchanged query and no discovery or dataset parameters', async () => {
    const fetch = vi.fn<PodFetch>(async () => response(body, type));
    const pod = createPod(base, { auth: bearer('test'), fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect((await run(pod)).kind).toBe('ok');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${base}/_system/sparql/query`,
      expect.objectContaining({
        method: 'POST',
        body: query,
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      }),
    );
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get('accept')).toBe(type);
    expect(headers.get('content-type')).toBe('application/sparql-query');
    expect(headers.get('authorization')).toBe('Bearer test');
  });

  it.each([401, 403])(
    'returns refusal %s without catalogue or renewal',
    async (status) => {
      const renew = vi.fn(async () => false);
      const auth = { ...bearer('test'), renew };
      const fetch = vi.fn<PodFetch>(async () => new Response(null, { status }));
      expect(await run(createPod(base, { auth, fetch }))).toEqual({
        kind: 'refused',
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(renew).not.toHaveBeenCalled();
    },
  );

  it('renews only once for an answered Bearer 401, retaining endpoint and query', async () => {
    let credential: AuthCredential = { authorization: 'Bearer old' };
    const renew = vi.fn(async () => {
      credential = { authorization: 'Bearer new' };
      return true;
    });
    const auth: PodAuth = { credential: async () => credential, renew };
    const fetch = vi.fn<PodFetch>(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    expect(await run(createPod(base, { auth, fetch }))).toEqual({
      kind: 'refused',
      status: 401,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(renew).toHaveBeenCalledTimes(1);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toBe(`${base}/_system/sparql/query`);
      expect(init?.body).toBe(query);
    }
    expect(
      new Headers(fetch.mock.calls[1]?.[1]?.headers).get('authorization'),
    ).toBe('Bearer new');
  });

  it('checks cancellation and dispatch guards before sending or resending', async () => {
    const fetch = vi.fn<PodFetch>(async () => response(body, type));
    expect(
      await run(
        createPod(base, { auth: bearer('test'), fetch }),
        AbortSignal.abort(),
      ),
    ).toEqual({ kind: 'cancelled' });
    expect(
      await run(
        createPod(base, {
          auth: bearer('test'),
          fetch,
          beforeDispatch: () => false,
        }),
      ),
    ).toEqual({ kind: 'stopped' });
    expect(fetch).not.toHaveBeenCalled();
    let allowed = true;
    let credential = { authorization: 'Bearer old' };
    const auth: PodAuth = {
      credential: async () => credential,
      renew: async () => {
        allowed = false;
        credential = { authorization: 'Bearer new' };
        return true;
      },
    };
    fetch.mockImplementation(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    expect(
      await run(
        createPod(base, { auth, fetch, beforeDispatch: () => allowed }),
      ),
    ).toEqual({ kind: 'refused', status: 401 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps in-flight cancellation and network failure without retry', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<PodFetch>(async () => {
      controller.abort();
      throw new Error('aborted');
    });
    expect(
      await run(
        createPod(base, { auth: bearer('test'), fetch }),
        controller.signal,
      ),
    ).toEqual({ kind: 'cancelled' });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockImplementation(async () => {
      throw new Error('network');
    });
    await expect(
      run(createPod(base, { auth: bearer('test'), fetch })),
    ).rejects.toMatchObject({
      reason: { code: 'transport', problem: 'network' },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects empty input, redirects, wrong media types and malformed bodies', async () => {
    const fetch = vi.fn<PodFetch>(async () => response(body, type));
    const pod = createPod(base, { auth: bearer('test'), fetch });
    await expect(pod.sparql[method](' \n ')).rejects.toMatchObject({
      reason: { code: 'invalid-argument', argument: 'query' },
    });
    expect(fetch).not.toHaveBeenCalled();
    const redirected = response(body, type);
    Object.defineProperty(redirected, 'url', {
      value: 'https://other.example/query',
    });
    fetch.mockImplementationOnce(async () => redirected);
    await expect(run(pod)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'redirected' },
    });
    fetch.mockImplementationOnce(async () => response(body, 'text/html'));
    await expect(run(pod)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'content-type' },
    });
    fetch.mockImplementationOnce(
      async () => new Response('{', { headers: { 'content-type': type } }),
    );
    await expect(run(pod)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'body' },
    });
    fetch.mockImplementationOnce(async () => response(null, type));
    await expect(run(pod)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'body' },
    });
  });
});

it('retains the scoped dataset and both guards on renewal, with no unscoped failure fallback', async () => {
  let credential = { authorization: 'Bearer old' };
  const auth: PodAuth = {
    credential: async () => credential,
    renew: async () => {
      credential = { authorization: 'Bearer new' };
      return true;
    },
  };
  const podGuard = vi.fn(() => true);
  const viewGuard = vi.fn(() => true);
  const fetch = vi
    .fn<PodFetch>()
    .mockImplementationOnce(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    )
    .mockImplementationOnce(async () => new Response(null, { status: 400 }));
  const view = createPod(base, {
    auth,
    fetch,
    beforeDispatch: podGuard,
  }).context(context, { beforeDispatch: viewGuard });
  await expect(
    view.sparql.construct('CONSTRUCT WHERE { ?s ?p ?o }'),
  ).rejects.toMatchObject({ reason: { code: 'http', status: 400 } });
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [url] of fetch.mock.calls) {
    expect(
      new URL(String(url)).searchParams.getAll('default-graph-uri'),
    ).toEqual([context]);
    expect(new URL(String(url)).searchParams.getAll('named-graph-uri')).toEqual(
      [context],
    );
  }
  expect(podGuard).toHaveBeenCalled();
  expect(viewGuard).toHaveBeenCalled();
});
