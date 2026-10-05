import { describe, expect, it, vi } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { sdkFailure, type PodFetch, type SdkFailure } from '../index.js';
import { discoverPod } from './index.js';

const alice = 'https://example.test/alice';
const bob = 'https://example.test/bob';

// Wire shapes from PodOAuthMetadataEndpoint.kt and its HTTP tests at Kotlin 7bdd886.
// This is source-derived fixture evidence, not a response captured from a running server.
function documents(pod = alice) {
  const scopes = [
    'public-read',
    'service-clients:manage',
    'contexts:manage',
    'offline_access',
  ];
  return {
    resource: {
      resource: pod,
      authorization_servers: [pod],
      bearer_methods_supported: ['header'],
      scopes_supported: scopes,
      public_contexts: 1,
      name: 'Example pod',
    },
    server: {
      issuer: pod,
      authorization_endpoint: `${pod}/_system/auth/authorize`,
      token_endpoint: `${pod}/_system/auth/token`,
      registration_endpoint: `${pod}/_system/auth/register`,
      jwks_uri: `${pod}/_system/auth/jwks.json`,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        'client_credentials',
      ],
      scopes_supported: scopes,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'],
      sempods_service_consent_endpoint: `${pod}/_system/auth/service-consent`,
    },
  };
}

function fixture(pod = alice, resource: object = {}, server: object = {}) {
  const docs = documents(pod);
  const fetch = vi.fn<PodFetch>(async (url) => {
    if (url === `${pod}/.well-known/oauth-protected-resource`)
      return Response.json({ ...docs.resource, ...resource });
    if (url === `${pod}/.well-known/oauth-authorization-server`)
      return Response.json({ ...docs.server, ...server });
    return new Response(null, { status: 404 });
  });
  return fetch;
}

async function rejects(
  promise: Promise<unknown>,
  reason: SdkFailure,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ reason });
}

describe('pod-local OAuth discovery', () => {
  it('uses only path-scoped metadata routes, without credentials, and returns discovered endpoints', async () => {
    const fetch = fixture(
      alice,
      {},
      { token_endpoint: `${alice}/custom-token?version=2` },
    );
    const result = await discoverPod(alice, { fetch });
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${alice}/.well-known/oauth-protected-resource`,
      `${alice}/.well-known/oauth-authorization-server`,
    ]);
    for (const [, init] of fetch.mock.calls) {
      expect(init).toMatchObject({
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json' },
      });
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      expect(init?.body).toBeUndefined();
    }
    expect(result).toEqual({
      podUrl: alice,
      issuer: alice,
      endpoints: {
        authorization: `${alice}/_system/auth/authorize`,
        token: `${alice}/custom-token?version=2`,
        registration: `${alice}/_system/auth/register`,
        jwks: `${alice}/_system/auth/jwks.json`,
      },
      scopes: {
        resource: documents().resource.scopes_supported,
        authorizationServer: documents().server.scopes_supported,
      },
      supportsRefreshToken: true,
      authorizationResponseIssSupported: false,
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.endpoints)).toBe(true);
    expect(Object.isFrozen(result.scopes.resource)).toBe(true);
    // Advertising service-client support does not select that flow or grant scopes.
    expect(result).not.toHaveProperty('grantedScopes');
  });

  it('keeps Alice and Bob on the same origin independent', async () => {
    const [a, b] = await Promise.all([
      discoverPod(alice, { fetch: fixture(alice) }),
      discoverPod(bob, { fetch: fixture(bob) }),
    ]);
    expect(a.issuer).toBe(alice);
    expect(b.issuer).toBe(bob);
    expect(a.endpoints.token).not.toBe(b.endpoints.token);
  });

  it('supports an origin-root pod without requiring a trailing slash', async () => {
    const pod = 'https://alice.example';
    expect((await discoverPod(pod, { fetch: fixture(pod) })).issuer).toBe(pod);
  });

  it('accepts the exact parsed challenge hint and rejects every different hint before fetching', async () => {
    const hint = `${alice}/.well-known/oauth-protected-resource`;
    await discoverPod(alice, {
      fetch: fixture(),
      challengeResourceMetadata: hint,
    });
    for (const other of [
      '',
      hint + '/',
      hint + '?',
      hint + '#',
      hint.replace('/alice/', '/bob/'),
      'https://example.test/.well-known/oauth-protected-resource/alice',
    ]) {
      const fetch = fixture();
      await rejects(
        discoverPod(alice, { fetch, challengeResourceMetadata: other }),
        {
          code: 'discovery',
          stage: 'challenge',
          problem: 'identity-mismatch',
          field: 'resource_metadata',
        },
      );
      expect(fetch).not.toHaveBeenCalled();
    }
  });

  it.each([
    { resource: bob },
    { resource: alice + '/' },
    { resource: 'https://EXAMPLE.test/alice' },
    { resource: 'https://example.test:443/alice' },
    { resource: `${alice}/../alice` },
    { authorization_servers: [bob] },
    { authorization_servers: [alice, bob] },
    { authorization_servers: [alice, alice] },
    { authorization_servers: [] },
  ])(
    'rejects mismatched resource identity without fetching the next document: %j',
    async (patch) => {
      const fetch = fixture(alice, patch);
      await expect(discoverPod(alice, { fetch })).rejects.toMatchObject({
        reason: {
          code: 'discovery',
          stage: 'resource',
          problem: 'identity-mismatch',
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    bob,
    alice + '/',
    `${alice}/_system/auth`,
    'https://EXAMPLE.test/alice',
    'https://example.test:443/alice',
  ])('requires exact issuer identity: %s', async (issuer) => {
    await rejects(
      discoverPod(alice, { fetch: fixture(alice, {}, { issuer }) }),
      {
        code: 'discovery',
        stage: 'authorization-server',
        problem: 'identity-mismatch',
        field: 'issuer',
      },
    );
  });

  it.each([
    '',
    '/alice',
    ' https://example.test/alice',
    alice + '/',
    alice + '?',
    alice + '#',
    'https://user:secret@example.test/alice',
    'http://example.test/alice',
    'file:///alice',
    'https://example.test/a/../alice',
  ])(
    'rejects invalid/noncanonical pod URLs before fetching: %s',
    async (pod) => {
      const fetch = fixture();
      await rejects(discoverPod(pod, { fetch }), { code: 'invalid-pod-url' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://localhost:8080/alice',
    'http://127.0.0.1:8080/alice',
    'http://[::1]:8080/alice',
  ])(
    'allows loopback HTTP only with an explicit development option: %s',
    async (pod) => {
      const fetch = fixture(pod);
      await rejects(discoverPod(pod, { fetch }), { code: 'invalid-pod-url' });
      expect(fetch).not.toHaveBeenCalled();
      expect(
        (await discoverPod(pod, { fetch, development: 'loopback-http' }))
          .issuer,
      ).toBe(pod);
    },
  );

  it('does not extend the HTTP exception to a remote pod or another endpoint origin', async () => {
    const fetch = fixture();
    await rejects(
      discoverPod('http://remote.test/alice', {
        fetch,
        development: 'loopback-http',
      }),
      { code: 'invalid-pod-url' },
    );
    expect(fetch).not.toHaveBeenCalled();
    const pod = 'http://localhost:8080/alice';
    await rejects(
      discoverPod(pod, {
        development: 'loopback-http',
        fetch: fixture(
          pod,
          {},
          { token_endpoint: 'http://localhost:9000/token' },
        ),
      }),
      {
        code: 'discovery',
        stage: 'authorization-server',
        problem: 'invalid-metadata',
        field: 'token_endpoint',
      },
    );
  });

  it.each([
    'authorization_endpoint',
    'token_endpoint',
    'registration_endpoint',
    'jwks_uri',
  ])('requires an absolute safe endpoint in %s', async (field) => {
    for (const value of [
      null,
      '',
      '/token',
      'https:other.test/token',
      'http://localhost/token',
      'https://user:pass@example.test/token',
      'https://example.test/token#',
      'https://example.test/\\token',
    ]) {
      await rejects(
        discoverPod(alice, { fetch: fixture(alice, {}, { [field]: value }) }),
        {
          code: 'discovery',
          stage: 'authorization-server',
          problem: 'invalid-metadata',
          field,
        },
      );
    }
  });

  it('uses HTTPS endpoints advertised by the bound issuer, without inventing same-path restrictions', async () => {
    const token = 'https://auth.example.test/token';
    expect(
      (
        await discoverPod(alice, {
          fetch: fixture(alice, {}, { token_endpoint: token }),
        })
      ).endpoints.token,
    ).toBe(token);
  });

  it.each([
    ['response_types_supported', ['token']],
    ['grant_types_supported', ['client_credentials']],
    ['token_endpoint_auth_methods_supported', ['client_secret_basic']],
    ['code_challenge_methods_supported', ['plain']],
  ] as const)(
    'requires the public Code + S256 flow: %s',
    async (field, values) => {
      await rejects(
        discoverPod(alice, { fetch: fixture(alice, {}, { [field]: values }) }),
        {
          code: 'discovery',
          stage: 'authorization-server',
          problem: 'unsupported-flow',
          field,
        },
      );
    },
  );

  it('requires header-based bearer support', async () => {
    await rejects(
      discoverPod(alice, {
        fetch: fixture(alice, { bearer_methods_supported: ['query'] }),
      }),
      {
        code: 'discovery',
        stage: 'resource',
        problem: 'unsupported-flow',
        field: 'bearer_methods_supported',
      },
    );
  });

  it.each([
    'issuer',
    'authorization_endpoint',
    'token_endpoint',
    'jwks_uri',
    'response_types_supported',
    'grant_types_supported',
    'token_endpoint_auth_methods_supported',
    'code_challenge_methods_supported',
  ])('rejects missing required authorization metadata: %s', async (field) => {
    await expect(
      discoverPod(alice, { fetch: fixture(alice, {}, { [field]: undefined }) }),
    ).rejects.toMatchObject({
      reason: { stage: 'authorization-server', problem: 'invalid-metadata' },
    });
  });

  it('accepts a missing registration endpoint (optional, RFC 8414) but validates a present one', async () => {
    const result = await discoverPod(alice, {
      fetch: fixture(alice, {}, { registration_endpoint: undefined }),
    });
    expect(result.endpoints.registration).toBeNull();
    await expect(
      discoverPod(alice, {
        fetch: fixture(alice, {}, { registration_endpoint: 'not a url' }),
      }),
    ).rejects.toMatchObject({
      reason: { stage: 'authorization-server', problem: 'invalid-metadata' },
    });
  });

  it('keeps missing scope support unknown, empty support empty, and each document separate', async () => {
    const result = await discoverPod(alice, {
      fetch: fixture(
        alice,
        { scopes_supported: undefined },
        { scopes_supported: [], grant_types_supported: ['authorization_code'] },
      ),
    });
    expect(result.scopes).toEqual({ resource: null, authorizationServer: [] });
    expect(result.supportsRefreshToken).toBe(false);
  });

  it.each([
    null,
    'public-read',
    [1],
    [''],
    ['read write'],
    ['read\nwrite'],
    ['read"write'],
  ])(
    'rejects malformed supported scopes instead of deriving grants: %j',
    async (scopes) => {
      await expect(
        discoverPod(alice, {
          fetch: fixture(alice, { scopes_supported: scopes }),
        }),
      ).rejects.toMatchObject({
        reason: { problem: 'invalid-metadata', field: 'scopes_supported' },
      });
    },
  );

  it.each(['resource', 'authorization_servers', 'bearer_methods_supported'])(
    'rejects malformed required resource members: %s',
    async (field) => {
      await expect(
        discoverPod(alice, { fetch: fixture(alice, { [field]: null }) }),
      ).rejects.toMatchObject({
        reason: {
          code: 'discovery',
          stage: 'resource',
          problem: 'invalid-metadata',
        },
      });
    },
  );

  it.each([401, 403, 404, 500])(
    'reports HTTP %i without fallback or auth side effects',
    async (status) => {
      const fetch = vi.fn<PodFetch>(async () => new Response(null, { status }));
      await rejects(discoverPod(alice, { fetch }), {
        code: 'discovery',
        stage: 'resource',
        problem: 'http',
        status,
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    () =>
      new Response(null, {
        status: 302,
        headers: { location: `${bob}/.well-known/oauth-protected-resource` },
      }),
    () => new Response('{}', { headers: { 'content-type': 'text/html' } }),
    () =>
      new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => Response.json([]),
    () => Response.json(null),
  ])(
    'rejects redirects, wrong content types and malformed JSON',
    async (response) => {
      const fetch = vi.fn<PodFetch>(async () => response());
      await expect(discoverPod(alice, { fetch })).rejects.toMatchObject({
        reason: {
          code: 'discovery',
          stage: 'resource',
          problem: 'invalid-metadata',
        },
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it('reports transport failure without substituting fabricated endpoints', async () => {
    const cause = new TypeError('private diagnostic');
    const fetch = vi.fn<PodFetch>(async () => {
      throw cause;
    });
    try {
      await discoverPod(alice, { fetch });
      expect.unreachable();
    } catch (error) {
      expect(sdkFailure(error)).toEqual({
        code: 'discovery',
        stage: 'resource',
        problem: 'network',
      });
      expect(error).toHaveProperty('cause', cause);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels before a request and refuses late results from a transport that ignores abort', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    const fetch = fixture();
    await rejects(discoverPod(alice, { fetch, signal: cancelled.signal }), {
      code: 'discovery',
      stage: 'resource',
      problem: 'cancelled',
    });
    expect(fetch).not.toHaveBeenCalled();

    const controller = new AbortController();
    const late = vi.fn<PodFetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      return Response.json(documents().resource);
    });
    await rejects(
      discoverPod(alice, { fetch: late, signal: controller.signal }),
      {
        code: 'discovery',
        stage: 'resource',
        problem: 'cancelled',
      },
    );
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('never caches validation results or failures across discovery attempts', async () => {
    await expect(
      discoverPod(alice, { fetch: fixture(alice, {}, { issuer: bob }) }),
    ).rejects.toThrow();
    const fetch = fixture();
    await discoverPod(alice, { fetch });
    await discoverPod(alice, { fetch });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

// Exercise the real fetch boundary too; the server below is a fixture, not Kotlin.
async function withHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    if (address === null || typeof address === 'string')
      throw new Error('Missing fixture address.');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it('reads the pinned wire shape over HTTP without a host-rooted route or credentials', async () => {
  const requests: IncomingMessage[] = [];
  await withHttpServer(
    (request, response) => {
      requests.push(request);
      const pod = `http://${request.headers.host}/alice`;
      const docs = documents(pod);
      const body =
        request.url === '/alice/.well-known/oauth-protected-resource'
          ? docs.resource
          : request.url === '/alice/.well-known/oauth-authorization-server'
            ? docs.server
            : null;
      response.writeHead(body === null ? 404 : 200, {
        'content-type': 'application/json; charset=utf-8',
      });
      response.end(JSON.stringify(body));
    },
    async (origin) => {
      const result = await discoverPod(`${origin}/alice`, {
        development: 'loopback-http',
      });
      expect(result.issuer).toBe(`${origin}/alice`);
      expect(result.endpoints.token).toBe(`${origin}/alice/_system/auth/token`);
    },
  );
  expect(requests.map((request) => request.url)).toEqual([
    '/alice/.well-known/oauth-protected-resource',
    '/alice/.well-known/oauth-authorization-server',
  ]);
  for (const request of requests) {
    expect(request.method).toBe('GET');
    expect(request.headers.authorization).toBeUndefined();
    expect(request.headers.cookie).toBeUndefined();
  }
});

it('does not follow HTTP redirects to another pod', async () => {
  const paths: (string | undefined)[] = [];
  await withHttpServer(
    (request, response) => {
      paths.push(request.url);
      response.writeHead(302, {
        location: '/bob/.well-known/oauth-protected-resource',
      });
      response.end();
    },
    async (origin) => {
      await rejects(
        discoverPod(`${origin}/alice`, { development: 'loopback-http' }),
        {
          code: 'discovery',
          stage: 'resource',
          problem: 'network',
        },
      );
    },
  );
  expect(paths).toEqual(['/alice/.well-known/oauth-protected-resource']);
});

it.each([undefined, false, true])(
  'retains the authorization response issuer announcement %s',
  async (announced) => {
    const result = await discoverPod(alice, {
      fetch: fixture(
        alice,
        {},
        {
          authorization_response_iss_parameter_supported: announced,
        },
      ),
    });
    expect(result.authorizationResponseIssSupported).toBe(announced === true);
  },
);
it.each(['true', 1, null])(
  'rejects malformed issuer support metadata %s',
  async (announced) => {
    await expect(
      discoverPod(alice, {
        fetch: fixture(
          alice,
          {},
          {
            authorization_response_iss_parameter_supported: announced,
          },
        ),
      }),
    ).rejects.toMatchObject({
      reason: {
        code: 'discovery',
        problem: 'invalid-metadata',
        field: 'authorization_response_iss_parameter_supported',
      },
    });
  },
);
