import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anonymous,
  bearer,
  CatalogueError,
  createPod,
  sdkFailure,
  SdkError,
  type AuthCredential,
  type PodAuth,
  type PodFetch,
  type PodRequestInit,
} from './index.js';
import { challengeSchemes } from './execute.js';

const ctx = 'https://pod.example/alice/_system/contexts/tasks';
const task = 'https://pod.example/alice/tasks/ü-1';
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url');

describe('against a loopback HTTP pod', () => {
  type Seen = {
    method: string;
    url: URL;
    headers: IncomingMessage['headers'];
    body: string;
  };
  const seen: Seen[] = [];
  let reply: (req: Seen) => {
    status: number;
    headers?: Record<string, string>;
    body?: string;
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      const entry = {
        method: req.method ?? '',
        url: new URL(req.url ?? '/', `http://${req.headers.host}`),
        headers: req.headers,
        body,
      };
      seen.push(entry);
      const answer = reply(entry);
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body ?? '');
    });
  });
  let podUrl = '';
  beforeAll(async () => {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    podUrl = `http://127.0.0.1:${address.port}/alice`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const view = () =>
    createPod(podUrl, {
      auth: bearer('secret'),
      development: 'loopback-http',
    }).context(ctx);
  const ldJson = (value: unknown, extra: Record<string, string> = {}) => ({
    status: 200,
    headers: { 'content-type': 'application/ld+json', ...extra },
    body: JSON.stringify(value),
  });

  it('reads one subject in exactly one context through the system route', async () => {
    seen.length = 0;
    reply = () => ldJson({ '@id': task }, { etag: '"v1"' });
    const result = await view().subjects.get(task);
    expect(result).toEqual({ kind: 'ok', body: { '@id': task }, etag: '"v1"' });
    const [request] = seen;
    expect(request?.method).toBe('GET');
    expect(request?.url.pathname).toBe(`/alice/_system/resources/${b64(task)}`);
    expect(request?.url.searchParams.getAll('context')).toEqual([ctx]);
    expect(request?.headers.authorization).toBe('Bearer secret');
    expect(request?.headers.accept).toBe('application/ld+json');
    expect(request?.headers.cookie).toBeUndefined();
    expect(request?.headers.referer).toBeUndefined();
  });

  it('maps read statuses to results and rejects untrusted answers', async () => {
    reply = () => ({ status: 404 });
    expect(await view().subjects.get(task)).toEqual({ kind: 'not-found' });
    reply = () => ({ status: 403 });
    expect(await view().subjects.get(task)).toEqual({
      kind: 'refused',
      status: 403,
    });
    reply = () => ({ status: 500 });
    await expect(view().subjects.get(task)).rejects.toMatchObject({
      reason: { code: 'http', status: 500 },
    });
    reply = () => ldJson({ '@id': task }, { etag: 'W/"weak"' });
    await expect(view().subjects.get(task)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'etag' },
    });
    reply = () => ({ status: 200, headers: { etag: '"v"' }, body: '{}' });
    await expect(view().subjects.get(task)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'content-type' },
    });
    reply = () => ldJson([{ '@id': task }], { etag: '"v"' });
    await expect(view().subjects.get(task)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'body' },
    });
  });

  it('sends conditional writes and maps their documented outcomes', async () => {
    seen.length = 0;
    // A relative Location naming the created subject's own route.
    reply = () => ({ status: 201, headers: { location: b64(task) } });
    expect(
      await view().subjects.put(task, { '@id': task }, { ifNoneMatch: '*' }),
    ).toEqual({
      kind: 'applied',
      status: 201,
      location: `${podUrl}/_system/resources/${b64(task)}`,
    });
    expect(seen[0]?.headers['if-none-match']).toBe('*');
    expect(seen[0]?.headers['content-type']).toBe('application/ld+json');
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual({ '@id': task });

    reply = (req) => ({
      status: req.headers['if-match'] === '"v1"' ? 204 : 412,
    });
    expect(
      await view().subjects.patch(task, { 'urn:p': [] }, { ifMatch: '"v1"' }),
    ).toEqual({ kind: 'applied', status: 204 });
    expect(seen[1]?.headers['content-type']).toBe(
      'application/merge-patch+json',
    );
    expect(
      await view().subjects.patch(task, { 'urn:p': [] }, { ifMatch: '"old"' }),
    ).toEqual({ kind: 'precondition-failed' });

    reply = () => ({ status: 204 });
    expect(await view().subjects.delete(task, { ifMatch: '"v1"' })).toEqual({
      kind: 'applied',
      status: 204,
    });
    reply = () => ({ status: 404 });
    expect(await view().subjects.delete(task, { ifMatch: '"v1"' })).toEqual({
      kind: 'not-found',
    });
    expect(
      seen.every((req) => req.url.searchParams.getAll('context').length === 1),
    ).toBe(true);
  });

  it('treats 5xx on a write as unknown and other answered 4xx as a rejection', async () => {
    reply = () => ({ status: 503 });
    expect(await view().subjects.patch(task, {}, { ifMatch: '"v"' })).toEqual({
      kind: 'uncertain',
      failure: { code: 'http', status: 503 },
    });
    reply = () => ({ status: 400 });
    await expect(
      view().subjects.patch(task, {}, { ifMatch: '"v"' }),
    ).rejects.toMatchObject({ reason: { code: 'http', status: 400 } });
  });

  it('downscopes CONSTRUCT to the view context', async () => {
    seen.length = 0;
    reply = () => ldJson([{ '@id': task }]);
    const query = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
    expect(await view().sparql.construct(query)).toEqual({
      kind: 'ok',
      body: [{ '@id': task }],
    });
    const [request] = seen;
    expect(request?.method).toBe('POST');
    expect(request?.url.pathname).toBe('/alice/_system/sparql/query');
    expect(request?.url.searchParams.getAll('default-graph-uri')).toEqual([
      ctx,
    ]);
    expect(request?.url.searchParams.getAll('named-graph-uri')).toEqual([ctx]);
    expect(request?.headers['content-type']).toBe('application/sparql-query');
    expect(request?.body).toBe(query);
    reply = () => ldJson({ '@graph': [] });
    await expect(view().sparql.construct(query)).rejects.toMatchObject({
      reason: { code: 'response', problem: 'body' },
    });
  });

  it('reads the catalogue and reports an invalid one as a catalogue failure', async () => {
    const pod = createPod(podUrl, {
      auth: bearer('secret'),
      development: 'loopback-http',
    });
    reply = () =>
      ldJson({
        '@id': `${podUrl}/_system/contexts`,
        '@type': [
          'http://www.w3.org/ns/sparql-service-description#GraphCollection',
        ],
      });
    expect(await pod.catalogue()).toEqual({ kind: 'ok', body: [] });
    reply = () => ldJson({ '@id': 'wrong' });
    const error = await pod.catalogue().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CatalogueError);
    expect(error).toBeInstanceOf(SdkError);
    expect(sdkFailure(error)).toEqual({ code: 'catalogue' });
  });

  it('reads a Context description from the Context IRI', async () => {
    const pod = createPod(podUrl, {
      auth: bearer('secret'),
      development: 'loopback-http',
    });
    const contextIri = `${podUrl}/_system/contexts/tasks`;
    seen.length = 0;
    reply = () =>
      ldJson({
        '@id': contextIri,
        '@type': ['http://www.w3.org/ns/sparql-service-description#NamedGraph'],
        'http://www.w3.org/ns/sparql-service-description#name': [
          { '@id': contextIri },
        ],
        'https://schema.sempods.org/public': [{ '@value': true }],
        'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': 'Tasks' }],
      });
    expect(await pod.contextDescription(contextIri)).toEqual({
      kind: 'ok',
      body: { iri: contextIri, public: true, label: 'Tasks' },
    });
    expect(seen[0]?.method).toBe('GET');
    expect(seen[0]?.url.pathname).toBe('/alice/_system/contexts/tasks');
    expect(seen[0]?.headers.accept).toBe('application/ld+json');
    expect(seen[0]?.headers.authorization).toBe('Bearer secret');
    reply = () => ({ status: 403 });
    expect(await pod.contextDescription(contextIri)).toEqual({
      kind: 'refused',
      status: 403,
    });
    // Like the catalogue, a missing description is an HTTP failure, not empty.
    reply = () => ({ status: 404 });
    const missing = await pod
      .contextDescription(contextIri)
      .catch((cause: unknown) => cause);
    expect(sdkFailure(missing)).toEqual({ code: 'http', status: 404 });
    // Never a request outside the Pod's context registry.
    seen.length = 0;
    for (const iri of [
      `${podUrl}/tasks`,
      'https://other.example/_system/contexts/x',
    ])
      await expect(pod.contextDescription(iri)).rejects.toBeInstanceOf(
        SdkError,
      );
    expect(seen).toHaveLength(0);
  });
});

describe('request executor', () => {
  type Call = { url: string; init: PodRequestInit | undefined };
  function fakeFetch(...responses: Array<(call: Call) => Promise<Response>>) {
    const calls: Call[] = [];
    const fetch: PodFetch = (url, init) => {
      const call = { url, init };
      calls.push(call);
      const next = responses.shift();
      if (!next) throw new Error('unexpected dispatch');
      return next(call);
    };
    return { fetch, calls };
  }
  const answer =
    (status: number, headers: Record<string, string> = {}) =>
    async () =>
      new Response(status === 204 ? null : '', { status, headers });
  const challenge = { 'www-authenticate': 'Bearer error="invalid_token"' };
  const pod = 'https://pod.example/alice';
  const patch = (fetch: PodFetch, auth: PodAuth, options = {}) =>
    createPod(pod, { auth, fetch, ...options })
      .context(ctx)
      .subjects.patch(task, { 'urn:p': [] }, { ifMatch: '"v1"' });

  /** A renewable owner: one stable object per accepted credential (R2). */
  function renewable(onRenew: () => Promise<boolean> | boolean = () => true) {
    const first: AuthCredential = Object.freeze({ authorization: 'Bearer a' });
    const second: AuthCredential = Object.freeze({ authorization: 'Bearer b' });
    let current = first;
    let renewals = 0;
    let rotations = 0;
    const auth: PodAuth = {
      credential: async () => current,
      async renew(refused) {
        renewals++;
        if (refused !== current) return true; // already replaced by another request
        const ok = await onRenew();
        if (ok) {
          current = second;
          rotations++;
        }
        return ok;
      },
    };
    return {
      auth,
      first,
      renewals: () => renewals,
      rotations: () => rotations,
    };
  }

  it('applies the safe request policy on every dispatch', async () => {
    const { fetch, calls } = fakeFetch(answer(204));
    await patch(fetch, bearer('t'));
    expect(calls[0]?.init).toMatchObject({
      method: 'PATCH',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  });

  it('sends nothing when cancelled or stopped before dispatch', async () => {
    const aborted = AbortSignal.abort();
    const none = fakeFetch();
    const view = (beforeDispatch: () => boolean) =>
      createPod(pod, {
        auth: bearer('t'),
        fetch: none.fetch,
        beforeDispatch,
      }).context(ctx);
    expect(
      await view(() => true).subjects.patch(
        task,
        {},
        { ifMatch: '"v"' },
        { signal: aborted },
      ),
    ).toEqual({ kind: 'not-sent', reason: 'cancelled' });
    expect(
      await view(() => false).subjects.patch(task, {}, { ifMatch: '"v"' }),
    ).toEqual({ kind: 'not-sent', reason: 'stopped' });
    expect(await view(() => false).subjects.get(task)).toEqual({
      kind: 'stopped',
    });
    expect(
      await view(() => true).subjects.get(task, { signal: aborted }),
    ).toEqual({
      kind: 'cancelled',
    });
    expect(none.calls).toHaveLength(0);
  });

  it('rechecks the guard after waiting for a credential', async () => {
    let open = true;
    const { fetch, calls } = fakeFetch();
    const auth: PodAuth = {
      credential: async () => {
        open = false; // the target changed while the credential was resolved
        return { authorization: 'Bearer t' };
      },
      renew: async () => false,
    };
    expect(await patch(fetch, auth, { beforeDispatch: () => open })).toEqual({
      kind: 'not-sent',
      reason: 'stopped',
    });
    expect(calls).toHaveLength(0);
  });

  it('reports a write without an answer as uncertain and never resends it', async () => {
    const controller = new AbortController();
    const cancelledAfterDispatch = fakeFetch(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    expect(
      await createPod(pod, {
        auth: bearer('t'),
        fetch: cancelledAfterDispatch.fetch,
      })
        .context(ctx)
        .subjects.patch(
          task,
          {},
          { ifMatch: '"v"' },
          { signal: controller.signal },
        ),
    ).toEqual({
      kind: 'uncertain',
      failure: { code: 'transport', problem: 'cancelled' },
    });
    const network = fakeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await patch(network.fetch, bearer('t'))).toEqual({
      kind: 'uncertain',
      failure: { code: 'transport', problem: 'network' },
    });
    expect(cancelledAfterDispatch.calls).toHaveLength(1);
    expect(network.calls).toHaveLength(1);
  });

  it('keeps a known answer even if the caller cancels afterwards', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(async () => {
      const response = new Response(null, { status: 204 });
      controller.abort();
      return response;
    });
    expect(
      await createPod(pod, { auth: bearer('t'), fetch })
        .context(ctx)
        .subjects.patch(
          task,
          {},
          { ifMatch: '"v"' },
          { signal: controller.signal },
        ),
    ).toEqual({ kind: 'applied', status: 204 });
  });

  it('does not trust an answer from another URL', async () => {
    const { fetch } = fakeFetch(async () => {
      const response = new Response(null, { status: 204 });
      Object.defineProperty(response, 'url', {
        value: 'https://evil.example/x',
      });
      return response;
    });
    expect(await patch(fetch, bearer('t'))).toEqual({
      kind: 'uncertain',
      failure: { code: 'response', problem: 'redirected' },
    });
  });

  it('resends exactly once with a renewed credential after a Bearer 401', async () => {
    const owner = renewable();
    const { fetch, calls } = fakeFetch(answer(401, challenge), answer(204));
    expect(await patch(fetch, owner.auth)).toEqual({
      kind: 'applied',
      status: 204,
    });
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map(
      (call) => new Headers(call.init?.headers),
    );
    expect(first?.get('authorization')).toBe('Bearer a');
    expect(second?.get('authorization')).toBe('Bearer b');
    expect(second?.get('if-match')).toBe('"v1"');
    expect(calls[1]?.init?.body).toBe(calls[0]?.init?.body);
    expect(calls[1]?.url).toBe(calls[0]?.url);
  });

  it('never exceeds one resend', async () => {
    const { fetch, calls } = fakeFetch(
      answer(401, challenge),
      answer(401, challenge),
    );
    expect(await patch(fetch, renewable().auth)).toEqual({
      kind: 'refused',
      status: 401,
    });
    expect(calls).toHaveLength(2);
  });

  it('keeps the first 401 as refused when no second dispatch happens', async () => {
    // Fixed bearer: renewal is impossible.
    const fixed = fakeFetch(answer(401, challenge));
    expect(await patch(fixed.fetch, bearer('t'))).toEqual({
      kind: 'refused',
      status: 401,
    });
    // Renewal fails.
    const failing = fakeFetch(answer(401, challenge));
    expect(
      await patch(
        failing.fetch,
        renewable(() => Promise.reject(new Error('storage'))).auth,
      ),
    ).toEqual({ kind: 'refused', status: 401 });
    // The guard stops the resend.
    let open = true;
    const guarded = fakeFetch(async () => {
      open = false;
      return new Response('', { status: 401, headers: challenge });
    });
    expect(
      await patch(guarded.fetch, renewable().auth, {
        beforeDispatch: () => open,
      }),
    ).toEqual({
      kind: 'refused',
      status: 401,
    });
    // The caller cancels while waiting for renewal: a write keeps the refusal.
    const controller = new AbortController();
    const waiting = fakeFetch(answer(401, challenge));
    const owner = renewable(() => {
      controller.abort();
      return true;
    });
    expect(
      await createPod(pod, { auth: owner.auth, fetch: waiting.fetch })
        .context(ctx)
        .subjects.patch(
          task,
          {},
          { ifMatch: '"v"' },
          { signal: controller.signal },
        ),
    ).toEqual({ kind: 'refused', status: 401 });
    for (const run of [fixed, failing, guarded, waiting])
      expect(run.calls).toHaveLength(1);
  });

  it('does not resend with the same credential object', async () => {
    const same: AuthCredential = Object.freeze({
      authorization: 'Bearer same',
    });
    const { fetch, calls } = fakeFetch(answer(401, challenge));
    const auth: PodAuth = {
      credential: async () => same,
      renew: async () => true,
    };
    expect(await patch(fetch, auth)).toEqual({ kind: 'refused', status: 401 });
    expect(calls).toHaveLength(1);
  });

  it('uses a replacement another request already obtained for a delayed old 401', async () => {
    const owner = renewable();
    const { fetch, calls } = fakeFetch(async () => {
      // While this request (sent with the old credential) is in flight, another request renews.
      await owner.auth.renew(owner.first, { wwwAuthenticate: null });
      return new Response('', { status: 401, headers: challenge });
    }, answer(204));
    expect(await patch(fetch, owner.auth)).toEqual({
      kind: 'applied',
      status: 204,
    });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe(
      'Bearer b',
    );
    expect(owner.rotations()).toBe(1); // no second rotation for the delayed refusal
  });

  it('does not renew without a Bearer challenge or for anonymous requests', async () => {
    const owner = renewable();
    const noChallenge = fakeFetch(answer(401));
    expect(await patch(noChallenge.fetch, owner.auth)).toEqual({
      kind: 'refused',
      status: 401,
    });
    const anon = fakeFetch(answer(401, challenge));
    expect(await patch(anon.fetch, anonymous())).toEqual({
      kind: 'refused',
      status: 401,
    });
    expect(new Headers(anon.calls[0]?.init?.headers).has('authorization')).toBe(
      false,
    );
    expect(owner.renewals()).toBe(0);
    expect(noChallenge.calls).toHaveLength(1);
  });

  it('rejects before dispatch when the credential owner fails', async () => {
    const { fetch, calls } = fakeFetch();
    const auth: PodAuth = {
      credential: () => Promise.reject(new Error('locked')),
      renew: async () => false,
    };
    await expect(patch(fetch, auth)).rejects.toMatchObject({
      reason: { code: 'authentication' },
    });
    expect(calls).toHaveLength(0);
  });

  it('reports read cancellation during renewal as cancelled', async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(answer(401, challenge));
    const owner = renewable(() => {
      controller.abort();
      return true;
    });
    expect(
      await createPod(pod, { auth: owner.auth, fetch })
        .context(ctx)
        .subjects.get(task, { signal: controller.signal }),
    ).toEqual({ kind: 'cancelled' });
  });
});

describe('conditional write and transport outcomes', () => {
  const challenge = { 'www-authenticate': 'Bearer error="invalid_token"' };
  const pod = 'https://pod.example/alice';
  function recorder(...responses: Array<() => Promise<Response>>) {
    const calls: string[] = [];
    const fetch: PodFetch = (url) => {
      calls.push(url);
      const next = responses.shift();
      if (!next) throw new Error('unexpected dispatch');
      return next();
    };
    return { fetch, calls };
  }

  it('R1: never renews or resends on an untrusted 401', async () => {
    let renewals = 0;
    const auth: PodAuth = {
      credential: async () => ({ authorization: 'Bearer a' }),
      renew: async () => {
        renewals++;
        return true;
      },
    };
    const { fetch, calls } = recorder(async () => {
      const response = new Response('', { status: 401, headers: challenge });
      Object.defineProperty(response, 'url', {
        value: 'https://evil.example/x',
      });
      return response;
    });
    expect(
      await createPod(pod, { auth, fetch })
        .context(ctx)
        .subjects.patch(task, {}, { ifMatch: '"v1"' }),
    ).toEqual({
      kind: 'uncertain',
      failure: { code: 'response', problem: 'redirected' },
    });
    expect(calls).toHaveLength(1);
    expect(renewals).toBe(0);
  });

  it('R2: a cancellation while waiting for the first credential stays a pre-dispatch result', async () => {
    const owner = (controller: AbortController): PodAuth => ({
      credential: async () => {
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
      renew: async () => false,
    });
    const writeAbort = new AbortController();
    const write = recorder();
    expect(
      await createPod(pod, { auth: owner(writeAbort), fetch: write.fetch })
        .context(ctx)
        .subjects.patch(
          task,
          {},
          { ifMatch: '"v1"' },
          { signal: writeAbort.signal },
        ),
    ).toEqual({ kind: 'not-sent', reason: 'cancelled' });
    const readAbort = new AbortController();
    const read = recorder();
    expect(
      await createPod(pod, { auth: owner(readAbort), fetch: read.fetch })
        .context(ctx)
        .subjects.get(task, { signal: readAbort.signal }),
    ).toEqual({ kind: 'cancelled' });
    expect(write.calls).toHaveLength(0);
    expect(read.calls).toHaveLength(0);
  });

  it('R3: an unexpected non-error answer to a write is unknown, never a rejection', async () => {
    for (const status of [202, 201, 205]) {
      const { fetch, calls } = recorder(
        async () => new Response(null, { status }),
      );
      expect(
        await createPod(pod, { auth: bearer('t'), fetch })
          .context(ctx)
          .subjects.patch(task, {}, { ifMatch: '"v1"' }),
      ).toEqual({ kind: 'uncertain', failure: { code: 'http', status } });
      expect(calls).toHaveLength(1);
    }
  });

  it('R4: accepts only strong entity tags as versions', async () => {
    for (const etag of ['*', 'v1', 'W/"v1"', '"v"1"']) {
      const { fetch } = recorder(
        async () =>
          new Response(JSON.stringify({ '@id': task }), {
            status: 200,
            headers: { 'content-type': 'application/ld+json', etag },
          }),
      );
      await expect(
        createPod(pod, { auth: bearer('t'), fetch })
          .context(ctx)
          .subjects.get(task),
      ).rejects.toMatchObject({
        reason: { code: 'response', problem: 'etag' },
      });
    }
    const none = recorder();
    await expect(
      createPod(pod, { auth: bearer('t'), fetch: none.fetch })
        .context(ctx)
        .subjects.patch(task, {}, { ifMatch: '*' }),
    ).rejects.toMatchObject({
      reason: { code: 'invalid-argument', argument: 'condition' },
    });
    expect(none.calls).toHaveLength(0);
  });
  it('R5: recognizes Bearer only as an auth scheme, never inside a quoted parameter', async () => {
    const run = async (header: string) => {
      let renewals = 0;
      const tokens = [
        Object.freeze({ authorization: 'Bearer a' }),
        Object.freeze({ authorization: 'Bearer b' }),
      ];
      let current = tokens[0]!;
      const auth: PodAuth = {
        credential: async () => current,
        renew: async () => {
          renewals++;
          current = tokens[1]!;
          return true;
        },
      };
      const { fetch, calls } = recorder(
        async () =>
          new Response('', {
            status: 401,
            headers: { 'www-authenticate': header },
          }),
        async () => new Response(null, { status: 204 }),
      );
      const result = await createPod(pod, { auth, fetch })
        .context(ctx)
        .subjects.patch(task, { 'urn:p': [] }, { ifMatch: '"v1"' });
      return { result, dispatches: calls.length, renewals };
    };
    expect(await run('Basic realm="Users, Bearer documentation"')).toEqual({
      result: { kind: 'refused', status: 401 },
      dispatches: 1,
      renewals: 0,
    });
    expect(
      await run('Basic realm="a, b", Bearer error="invalid_token"'),
    ).toEqual({
      result: { kind: 'applied', status: 204 },
      dispatches: 2,
      renewals: 1,
    });
  });

  it('R5: parses challenge schemes per RFC 9110 §11.6.1', () => {
    expect(challengeSchemes('Bearer')).toEqual(['Bearer']);
    expect(
      challengeSchemes('bearer realm="pod", error="invalid_token"'),
    ).toEqual(['bearer']);
    expect(
      challengeSchemes(
        'Newauth realm="apps", type=1, title="Login to \\"apps\\", Bearer", Basic realm="simple"',
      ),
    ).toEqual(['Newauth', 'Basic']);
    expect(challengeSchemes('Negotiate abc==, Bearer')).toEqual([
      'Negotiate',
      'Bearer',
    ]);
    expect(challengeSchemes('Basic realm = "x", Bearer = "y"')).toEqual([
      'Basic',
    ]);
    expect(challengeSchemes('Basic realm="unterminated, Bearer')).toEqual([]);
    expect(challengeSchemes('')).toEqual([]);
  });
});

describe('validation', () => {
  it('accepts only canonical pod URLs and absolute IRIs', async () => {
    for (const url of [
      'https://pod.example/alice/',
      'https://pod.example/alice?x=1',
      'http://pod.example/alice',
      'https://user@pod.example/alice',
      'not a url',
    ]) {
      expect(() => createPod(url, { auth: anonymous() })).toThrow(SdkError);
    }
    expect(() =>
      createPod('http://pod.example/alice', {
        auth: anonymous(),
        development: 'loopback-http',
      }),
    ).toThrow(SdkError);
    const pod = createPod('https://pod.example/alice', { auth: anonymous() });
    expect(() => pod.context('relative/context')).toThrow(
      expect.objectContaining({
        reason: { code: 'invalid-argument', argument: 'context' },
      }),
    );
    await expect(
      pod.context(ctx).subjects.get('relative'),
    ).rejects.toMatchObject({
      reason: { code: 'invalid-argument', argument: 'iri' },
    });
    await expect(pod.context(ctx).sparql.construct('  ')).rejects.toMatchObject(
      {
        reason: { code: 'invalid-argument', argument: 'query' },
      },
    );
    await expect(
      pod.context(ctx).subjects.patch(task, {}, { ifMatch: '' }),
    ).rejects.toMatchObject({
      reason: { code: 'invalid-argument', argument: 'condition' },
    });
  });

  it('keeps one stable credential object for a fixed bearer', async () => {
    const auth = bearer('t');
    expect(await auth.credential({ url: 'x' })).toBe(
      await auth.credential({ url: 'y' }),
    );
  });
});
