import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { PodFetch } from '../index.js';
import {
  createClientRegistry,
  type ClientIdentity,
  type PodDiscovery,
} from './index.js';

const pod: PodDiscovery = {
  podUrl: 'https://example.test/alice',
  issuer: 'https://example.test/alice',
  endpoints: {
    authorization: 'https://example.test/alice/_system/auth/authorize',
    token: 'https://example.test/alice/_system/auth/token',
    registration: 'https://example.test/alice/_system/auth/register',
    jwks: 'https://example.test/alice/_system/auth/jwks.json',
  },
  scopes: { resource: null, authorizationServer: null },
  supportsRefreshToken: true,
  authorizationResponseIssSupported: false,
};
const dynamic = {
  kind: 'dynamic',
  name: 'Tiny TODO',
  redirectUri: 'https://app.example/todo/callback?view=list',
} as const;
const did = {
  kind: 'did-web',
  clientId: 'did:web:app.example:todo',
  redirectUri: dynamic.redirectUri,
} as const;

// Source-derived public wire shape from Kotlin PodRegistrationResponses at 7bdd886.
function response(overrides: Record<string, unknown> = {}) {
  return Response.json(
    {
      client_id: 'dyn:example',
      redirect_uris: [dynamic.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      client_name: dynamic.name,
      ...overrides,
    },
    { status: 201 },
  );
}
function fixture(overrides: Record<string, unknown> = {}) {
  return vi.fn<PodFetch>(async () => response(overrides));
}
function invalidConfig(field: string) {
  return {
    reason: {
      code: 'oauth',
      stage: 'client-identity',
      problem: 'invalid-config',
      field,
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('did:web client identity', () => {
  it('resolves without fetching a DID document, registering or touching browser globals', async () => {
    const fetch = fixture();
    const client = await createClientRegistry({ fetch }).resolve(pod, did);
    expect(client).toEqual({
      kind: 'did-web',
      clientId: did.clientId,
      redirectUri: did.redirectUri,
      podUrl: pod.podUrl,
      issuer: pod.issuer,
    });
    expect(Object.isFrozen(client)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('needs no registration endpoint for did:web, while a dynamic client does', async () => {
    const noRegistration = {
      ...pod,
      endpoints: { ...pod.endpoints, registration: null },
    };
    await expect(
      createClientRegistry().resolve(noRegistration, did),
    ).resolves.toMatchObject({ kind: 'did-web', clientId: did.clientId });
    await expect(
      createClientRegistry().resolve(noRegistration, {
        kind: 'dynamic',
        name: 'Tasks',
        redirectUri: did.redirectUri,
      }),
    ).rejects.toMatchObject({
      reason: { problem: 'invalid-config', field: 'registration_endpoint' },
    });
  });
  it.each([
    ['did:web:app.example', 'https://app.example/'],
    ['did:web:app.example:todo', 'https://app.example/todo'],
    ['did:web:app.example:todo', 'https://app.example/todo/callback'],
    ['did:web:app.example:todo', 'https://app.example/%74odo/callback'],
    [
      'did:web:app.example%3A8443:todo',
      'https://app.example:8443/todo/callback',
    ],
    ['did:web:apps.home.arpa', 'https://apps.home.arpa/callback'],
    ['did:web:app.local', 'https://app.local/callback'],
    [
      `did:web:${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`,
      `https://${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}/`,
    ],
  ])('accepts %s covering %s', async (clientId, redirectUri) => {
    await expect(
      createClientRegistry().resolve(pod, {
        kind: 'did-web',
        clientId,
        redirectUri,
      }),
    ).resolves.toMatchObject({ clientId, redirectUri });
  });
  it.each([
    ['dyn:no-fallback', dynamic.redirectUri],
    ['did:web:other.example', dynamic.redirectUri],
    ['did:web:app.example:todo', 'https://app.example/todo-other/callback'],
    ['did:web:app.example:todo', 'https://app.example/'],
    ['did:web:app.example%3A8443', 'https://app.example:9443/'],
    ['did:web:app.example%2Fevil', dynamic.redirectUri],
    ['did:web:app.example%40other.example', dynamic.redirectUri],
    ['did:web:app.example:', dynamic.redirectUri],
    ['did:web:app.example:..', dynamic.redirectUri],
    ['did:web:app.example:todo%2F..', dynamic.redirectUri],
    ['did:web:app.example:%XX', dynamic.redirectUri],
    ['did:web:192.0.2.1', 'https://192.0.2.1/'],
    ['did:web:%5B2001%3Adb8%3A%3A2%5D', 'https://[2001:db8::2]/'],
    ['did:web:intranet', 'https://intranet/'],
    ['did:web:intranet.', 'https://intranet./'],
    ['did:web:foo.localhost', 'https://foo.localhost/'],
    ['did:web:app.invalid', 'https://app.invalid/'],
    [`did:web:${'a'.repeat(64)}.example`, `https://${'a'.repeat(64)}.example/`],
    [
      `did:web:${`${'a'.repeat(63)}.`.repeat(4)}example`,
      `https://${`${'a'.repeat(63)}.`.repeat(4)}example/`,
    ],
  ])(
    'rejects %s against %s without fallback',
    async (clientId, redirectUri) => {
      const fetch = fixture();
      await expect(
        createClientRegistry({ fetch }).resolve(pod, {
          kind: 'did-web',
          clientId,
          redirectUri,
        }),
      ).rejects.toMatchObject(invalidConfig('clientId'));
      expect(fetch).not.toHaveBeenCalled();
    },
  );
  it('keeps development explicit and still requires a matching loopback identity and port', async () => {
    const identity: ClientIdentity = {
      kind: 'did-web',
      clientId: 'did:web:localhost%3A3210:todo',
      redirectUri: 'http://localhost:3210/todo/callback',
    };
    await expect(
      createClientRegistry().resolve(pod, identity),
    ).rejects.toMatchObject(invalidConfig('redirectUri'));
    const registry = createClientRegistry({ development: 'loopback-http' });
    await expect(registry.resolve(pod, identity)).resolves.toMatchObject(
      identity,
    );
    await expect(
      registry.resolve(pod, {
        ...identity,
        redirectUri: 'http://localhost:3211/todo/callback',
      }),
    ).rejects.toMatchObject(invalidConfig('clientId'));
    await expect(
      registry.resolve(pod, { ...identity, clientId: did.clientId }),
    ).rejects.toMatchObject(invalidConfig('clientId'));
    await expect(
      registry.resolve(pod, {
        ...identity,
        redirectUri: 'http://remote.example:3210/todo/callback',
      }),
    ).rejects.toMatchObject(invalidConfig('redirectUri'));
    await expect(
      registry.resolve(pod, {
        kind: 'did-web',
        clientId: 'did:web:127.0.0.1%3A3210',
        redirectUri: 'http://127.0.0.1:3210/callback',
      }),
    ).resolves.toMatchObject({ clientId: 'did:web:127.0.0.1%3A3210' });
    await expect(
      registry.resolve(pod, {
        kind: 'did-web',
        clientId: 'did:web:%5B%3A%3A1%5D%3A3210',
        redirectUri: 'http://[::1]:3210/callback',
      }),
    ).resolves.toMatchObject({ clientId: 'did:web:%5B%3A%3A1%5D%3A3210' });
    await expect(
      registry.resolve(pod, {
        kind: 'did-web',
        clientId: 'did:web:a.localhost%3A3210',
        redirectUri: 'https://a.localhost:3210/callback',
      }),
    ).rejects.toMatchObject(invalidConfig('clientId'));
    await expect(
      createClientRegistry().resolve(pod, {
        kind: 'did-web',
        clientId: 'did:web:localhost',
        redirectUri: 'https://localhost/callback',
      }),
    ).rejects.toMatchObject(invalidConfig('redirectUri'));
  });
});

describe('callback validation', () => {
  it.each([
    'https://app.example/cb#',
    'https://app.example/cb#fragment',
    '/callback',
    'https://user:password@app.example/callback',
    'https://app.example/a/../callback',
    'https://app.example/a%2F..%2Fcallback',
    'http://app.example/callback',
    'https://app.example/cb?code',
    'https://app.example/cb?%63ode=x',
    'https://app.example/cb?state=x',
    'https://app.example/cb?response=x',
    'https://app.example/cb?%73tate=x',
    'https://app.example/%XX',
    'https://app.example/cb\n',
    'javascript:alert(1)',
    'https://app_name.example/cb',
    'https://app.example/cb?next=%XX',
  ])('rejects %s before registration', async (redirectUri) => {
    const fetch = fixture();
    await expect(
      createClientRegistry({ fetch }).resolve(pod, { ...dynamic, redirectUri }),
    ).rejects.toMatchObject(invalidConfig('redirectUri'));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    'https://app.example/cb?CODE=x',
    'https://app.example/cb?next=a%26state%3Dx',
  ])('preserves benign query %s', async (redirectUri) => {
    const client = await createClientRegistry({
      fetch: fixture({ redirect_uris: [redirectUri] }),
    }).resolve(pod, { ...dynamic, redirectUri });
    expect(client.redirectUri).toBe(redirectUri);
  });
});

describe('public dynamic client registration', () => {
  it('uses the advertised endpoint and an explicit public Code profile, returning only public identity', async () => {
    const fetch = fixture({ ignored_extension: { example: true } });
    const custom = {
      ...pod,
      endpoints: {
        ...pod.endpoints,
        registration: 'https://register.example/custom',
      },
    };
    const client = await createClientRegistry({ fetch }).resolve(
      custom,
      dynamic,
    );
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(custom.endpoints.registration);
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    });
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    expect(new Headers(init?.headers).get('content-type')).toBe(
      'application/json',
    );
    expect(JSON.parse(init?.body as string)).toEqual({
      client_name: 'Tiny TODO',
      redirect_uris: [dynamic.redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    expect(client).toEqual({
      kind: 'dynamic',
      clientId: 'dyn:example',
      redirectUri: dynamic.redirectUri,
      podUrl: pod.podUrl,
      issuer: pod.issuer,
    });
    expect(Object.isFrozen(client)).toBe(true);
  });
  it('does not request refresh support when it is not advertised', async () => {
    const fetch = fixture({ grant_types: ['authorization_code'] });
    await createClientRegistry({ fetch }).resolve(
      { ...pod, supportsRefreshToken: false },
      dynamic,
    );
    expect(
      JSON.parse(fetch.mock.calls[0]![1]!.body as string).grant_types,
    ).toEqual(['authorization_code']);
  });
  it.each([
    { client_id: 'service:one' },
    { client_id: '' },
    { client_id: 'dyn:' },
    { client_id: 'dyn:bad id' },
    { client_id: 123 },
    { token_endpoint_auth_method: 'client_secret_basic' },
    { token_endpoint_auth_method: undefined },
    { client_secret: 'never-return-this' },
    { client_secret: null },
    { registration_access_token: 'never-return-this' },
    { grant_types: ['client_credentials'] },
    { grant_types: ['authorization_code', 'client_credentials'] },
    { grant_types: undefined },
    { response_types: ['token'] },
    { response_types: undefined },
    { response_types: ['code', 'token'] },
    { redirect_uris: undefined },
    { redirect_uris: ['https://attacker.example/callback'] },
    {
      redirect_uris: [dynamic.redirectUri, 'https://attacker.example/callback'],
    },
    { redirect_uris: ['https://app.example/todo/callback?view=other'] },
  ])(
    'rejects incompatible response %j without caching or leaking response contents',
    async (overrides) => {
      const fetch = fixture(overrides);
      const registry = createClientRegistry({ fetch });
      for (let i = 0; i < 2; i++) {
        await expect(registry.resolve(pod, dynamic)).rejects.toMatchObject({
          reason: {
            code: 'oauth',
            stage: 'client-identity',
            problem: 'invalid-response',
          },
          cause: undefined,
        });
      }
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([400, 401, 403, 429, 500])(
    'reports HTTP %i without automatic retries',
    async (status) => {
      const fetch = vi.fn<PodFetch>(async () =>
        Response.json(
          {
            error: 'invalid_client_metadata',
            error_description: 'untrusted text',
          },
          { status },
        ),
      );
      await expect(
        createClientRegistry({ fetch }).resolve(pod, dynamic),
      ).rejects.toMatchObject({
        reason: {
          code: 'oauth',
          stage: 'client-identity',
          problem: 'http',
          status,
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.example' },
      }),
    () =>
      new Response('{}', {
        status: 201,
        headers: { 'content-type': 'text/html' },
      }),
    () =>
      new Response('broken', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    () => Response.json([], { status: 201 }),
    () => {
      const value = response();
      Object.defineProperty(value, 'url', { value: 'https://other.example' });
      return value;
    },
    () => {
      const value = response();
      Object.defineProperty(value, 'redirected', { value: true });
      return value;
    },
  ])('rejects redirects and malformed responses', async (makeResponse) => {
    await expect(
      createClientRegistry({ fetch: async () => makeResponse() }).resolve(
        pod,
        dynamic,
      ),
    ).rejects.toMatchObject({
      reason: {
        code: 'oauth',
        stage: 'client-identity',
        problem: 'invalid-response',
      },
    });
  });
  it('checks pod identity and endpoint transport before sending', async () => {
    const fetch = fixture();
    const registry = createClientRegistry({
      fetch,
      development: 'loopback-http',
    });
    await expect(
      registry.resolve({ ...pod, issuer: pod.podUrl + '/other' }, dynamic),
    ).rejects.toMatchObject(invalidConfig('issuer'));
    await expect(
      registry.resolve(
        {
          ...pod,
          endpoints: {
            ...pod.endpoints,
            registration: 'http://localhost:3210/register',
          },
        },
        dynamic,
      ),
    ).rejects.toMatchObject({
      reason: { code: 'discovery', problem: 'invalid-metadata' },
    });
    await expect(
      registry.resolve(pod, { ...dynamic, name: '  ' }),
    ).rejects.toMatchObject(invalidConfig('name'));
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    'http://localhost:3210/cb',
    'http://127.0.0.1:3210/cb',
    'http://[::1]:3210/cb',
  ])(
    'accepts a stored loopback port while retaining the requested callback: %s',
    async (redirectUri) => {
      const fetch = fixture({
        redirect_uris: [redirectUri.replace('3210', '9876')],
      });
      const registry = createClientRegistry({
        fetch,
        development: 'loopback-http',
      });
      expect(
        (await registry.resolve(pod, { ...dynamic, redirectUri })).redirectUri,
      ).toBe(redirectUri);
    },
  );
  it.each([
    'http://localhost:3210/other',
    'http://127.0.0.1:3210/cb',
    'https://localhost:3210/cb',
  ])('does not ignore loopback path, host or scheme: %s', async (stored) => {
    await expect(
      createClientRegistry({
        fetch: fixture({ redirect_uris: [stored] }),
        development: 'loopback-http',
      }).resolve(pod, { ...dynamic, redirectUri: 'http://localhost:3210/cb' }),
    ).rejects.toMatchObject({
      reason: { problem: 'invalid-response', field: 'redirect_uris' },
    });
  });
  it('accepts a stored explicit default loopback port without normalizing other URI parts', async () => {
    const registry = createClientRegistry({
      fetch: fixture({ redirect_uris: ['https://localhost:443/cb'] }),
      development: 'loopback-http',
    });
    expect(
      (
        await registry.resolve(pod, {
          ...dynamic,
          redirectUri: 'https://localhost:3210/cb',
        })
      ).redirectUri,
    ).toBe('https://localhost:3210/cb');
    for (const stored of [
      'https://LOCALHOST:443/cb',
      'https://localhost:443/a/../cb',
      'https://localhost:99999/cb',
      'https://localhost:443/%63b',
    ]) {
      await expect(
        createClientRegistry({
          fetch: fixture({ redirect_uris: [stored] }),
          development: 'loopback-http',
        }).resolve(pod, {
          ...dynamic,
          redirectUri: 'https://localhost:3210/cb',
        }),
      ).rejects.toMatchObject({
        reason: { problem: 'invalid-response', field: 'redirect_uris' },
      });
    }
  });
  it('does not ignore remote callback ports', async () => {
    await expect(
      createClientRegistry({
        fetch: fixture({
          redirect_uris: ['https://app.example:8443/todo/callback?view=list'],
        }),
      }).resolve(pod, dynamic),
    ).rejects.toMatchObject({
      reason: { problem: 'invalid-response', field: 'redirect_uris' },
    });
  });
});

describe('registration cache and cancellation', () => {
  it('clears one pod while retaining completed and pending registrations for another', async () => {
    const other = {
      ...pod,
      podUrl: 'https://other.test/bob',
      issuer: 'https://other.test/bob',
      endpoints: {
        ...pod.endpoints,
        registration: 'https://other.test/bob/_system/auth/register',
      },
    };
    const pending = deferred<Response>();
    const fetch = fixture();
    const registry = createClientRegistry({ fetch });
    await registry.resolve(pod, dynamic);
    const retained = await registry.resolve(other, dynamic);
    fetch.mockImplementationOnce(() => pending.promise);
    const resolving = registry.resolve(other, {
      ...dynamic,
      name: 'Second identity',
    });
    registry.clear(pod.podUrl);
    pending.resolve(response());
    const completed = await resolving;
    expect(await registry.resolve(other, dynamic)).toBe(retained);
    expect(
      await registry.resolve(other, { ...dynamic, name: 'Second identity' }),
    ).toBe(completed);
    expect(fetch).toHaveBeenCalledTimes(3);
    await registry.resolve(pod, dynamic);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('does not refill an evicted pod cache from an outstanding registration', async () => {
    const pending = deferred<Response>();
    const fetch = fixture().mockImplementationOnce(() => pending.promise);
    const registry = createClientRegistry({ fetch });
    const resolving = registry.resolve(pod, dynamic);
    registry.clear(pod.podUrl);
    const replacement = await registry.resolve(pod, dynamic);
    pending.resolve(response({ client_id: 'dyn:outdated' }));
    await resolving;
    expect(await registry.resolve(pod, dynamic)).toBe(replacement);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reuses completed registrations but separates pods, endpoints and all request metadata', async () => {
    const fetch = vi.fn<PodFetch>(async (_url, init) =>
      response({
        redirect_uris: JSON.parse(init!.body as string).redirect_uris,
      }),
    );
    const registry = createClientRegistry({ fetch });
    const first = await registry.resolve(pod, dynamic);
    expect(await registry.resolve(pod, { ...dynamic })).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    await registry.resolve(
      {
        ...pod,
        podUrl: 'https://example.test/bob',
        issuer: 'https://example.test/bob',
      },
      dynamic,
    );
    await registry.resolve(
      {
        ...pod,
        endpoints: {
          ...pod.endpoints,
          registration: 'https://register.example/',
        },
      },
      dynamic,
    );
    await registry.resolve({ ...pod, supportsRefreshToken: false }, dynamic);
    await registry.resolve(pod, { ...dynamic, name: 'Other app' });
    await registry.resolve(pod, {
      ...dynamic,
      redirectUri: 'https://app.example/other',
    });
    expect(fetch).toHaveBeenCalledTimes(6);
    registry.clear();
    await registry.resolve(pod, dynamic);
    expect(fetch).toHaveBeenCalledTimes(7);
  });
  it('snapshots mutable caller configuration across a request', async () => {
    const pending = deferred<Response>();
    const fetch = vi.fn<PodFetch>(() => pending.promise);
    const input = { ...dynamic };
    const mutablePod = { ...pod };
    const registry = createClientRegistry({ fetch });
    const resolving = registry.resolve(mutablePod, input);
    Object.assign(input, {
      redirectUri: 'https://other.example/',
      name: 'Changed',
    });
    mutablePod.podUrl = 'https://other.example';
    pending.resolve(response());
    const result = await resolving;
    expect(result.redirectUri).toBe(dynamic.redirectUri);
    expect(result.podUrl).toBe(pod.podUrl);
    expect(await registry.resolve(pod, dynamic)).toBe(result);
  });
  it('clear prevents an outstanding registration from repopulating the cache', async () => {
    const pending = deferred<Response>();
    const fetch = vi
      .fn<PodFetch>()
      .mockImplementationOnce(() => pending.promise)
      .mockImplementation(async () => response());
    const registry = createClientRegistry({ fetch });
    const resolving = registry.resolve(pod, dynamic);
    registry.clear();
    pending.resolve(response());
    await resolving;
    await registry.resolve(pod, dynamic);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('reports network failures without caching them', async () => {
    const fetch = vi
      .fn<PodFetch>()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(response());
    const registry = createClientRegistry({ fetch });
    await expect(registry.resolve(pod, dynamic)).rejects.toMatchObject({
      reason: { problem: 'network' },
    });
    await registry.resolve(pod, dynamic);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects pre-aborted calls even on a cache hit', async () => {
    const fetch = fixture();
    const registry = createClientRegistry({ fetch });
    const signal = AbortSignal.abort();
    await expect(registry.resolve(pod, did, { signal })).rejects.toMatchObject({
      reason: { problem: 'cancelled' },
    });
    await expect(
      registry.resolve(pod, dynamic, { signal }),
    ).rejects.toMatchObject({ reason: { problem: 'cancelled' } });
    expect(fetch).not.toHaveBeenCalled();
    await registry.resolve(pod, dynamic);
    await expect(
      registry.resolve(pod, dynamic, { signal }),
    ).rejects.toMatchObject({ reason: { problem: 'cancelled' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps concurrent callers independent and does not cache a cancelled response', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    const controller = new AbortController();
    const fetch = vi
      .fn<PodFetch>()
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    const registry = createClientRegistry({ fetch });
    const first = registry.resolve(pod, dynamic, { signal: controller.signal });
    const second = registry.resolve(pod, dynamic);
    expect(fetch.mock.calls[0]![1]?.signal).toBe(controller.signal);
    controller.abort();
    a.resolve(response({ client_id: 'dyn:cancelled' }));
    await expect(first).rejects.toMatchObject({
      reason: { problem: 'cancelled' },
    });
    b.resolve(response({ client_id: 'dyn:second' }));
    expect((await second).clientId).toBe('dyn:second');
    expect((await registry.resolve(pod, dynamic)).clientId).toBe('dyn:second');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not cache cancellation during response body processing', async () => {
    const controller = new AbortController();
    const body = response();
    const json = body.json.bind(body);
    vi.spyOn(body, 'json').mockImplementation(async () => {
      const result = await json();
      controller.abort();
      return result;
    });
    const fetch = vi
      .fn<PodFetch>()
      .mockResolvedValueOnce(body)
      .mockImplementation(async () => response());
    const registry = createClientRegistry({ fetch });
    await expect(
      registry.resolve(pod, dynamic, { signal: controller.signal }),
    ).rejects.toMatchObject({ reason: { problem: 'cancelled' } });
    await registry.resolve(pod, dynamic);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

it('registers through native fetch against a loopback HTTP fixture', async () => {
  let received = '';
  let authorization: string | undefined;
  const server = createServer(async (request, res) => {
    authorization = request.headers.authorization;
    for await (const part of request) received += part.toString();
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(await response().text());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Expected a TCP server.');
    const base = `http://127.0.0.1:${address.port}/alice`;
    const local = {
      ...pod,
      podUrl: base,
      issuer: base,
      endpoints: {
        ...pod.endpoints,
        registration: `${base}/_system/auth/register`,
      },
    };
    const client = await createClientRegistry({
      development: 'loopback-http',
    }).resolve(local, dynamic);
    expect(client.clientId).toBe('dyn:example');
    expect(JSON.parse(received).token_endpoint_auth_method).toBe('none');
    expect(authorization).toBeUndefined();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.each([
  'code',
  'response',
  'state',
  'error',
  'error_description',
  'error_uri',
  'iss',
  '%65rror',
  '%69ss',
])(
  'rejects the reserved callback query key %s for both client identities before a request',
  async (key) => {
    for (const identity of [dynamic, did]) {
      const fetch = fixture();
      await expect(
        createClientRegistry({ fetch }).resolve(pod, {
          ...identity,
          redirectUri: `https://app.example/todo/callback?${key}=value`,
        }),
      ).rejects.toMatchObject(invalidConfig('redirectUri'));
      expect(fetch).not.toHaveBeenCalled();
    }
  },
);

it.each(['tenant=a&tenant=b', 'tenant=a&tenant=a', 'tenant=a&%74enant=b'])(
  'rejects duplicate callback keys %s for both client identities before registration',
  async (query) => {
    for (const identity of [dynamic, did]) {
      const redirectUri = `https://app.example/todo/callback?${query}`;
      const fetch = fixture({ redirect_uris: [redirectUri] });
      await expect(
        createClientRegistry({ fetch }).resolve(pod, {
          ...identity,
          redirectUri,
        }),
      ).rejects.toMatchObject(invalidConfig('redirectUri'));
      expect(fetch).not.toHaveBeenCalled();
    }
  },
);
