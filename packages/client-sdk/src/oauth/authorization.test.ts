import { expect, it, vi } from 'vitest';
import {
  prepareAuthorization,
  exchangeAuthorization,
  refreshAuthorization,
  validateAuthorizationCallback,
} from './authorization.js';
import type { PodDiscovery } from './discovery.js';

const pod: PodDiscovery = {
  podUrl: 'https://pod.example/alice',
  issuer: 'https://pod.example/alice',
  endpoints: {
    authorization: 'https://pod.example/alice/authorize',
    token: 'https://pod.example/alice/token',
    registration: 'https://pod.example/alice/register',
    jwks: 'https://pod.example/alice/jwks',
  },
  scopes: { resource: null, authorizationServer: null },
  supportsRefreshToken: true,
  authorizationResponseIssSupported: false,
};
const client = {
  kind: 'dynamic' as const,
  podUrl: pod.podUrl,
  issuer: pod.issuer,
  clientId: 'dyn:test',
  redirectUri: 'https://app.example/callback',
};
async function attempt(announced = false) {
  return (
    await prepareAuthorization({
      pod: { ...pod, authorizationResponseIssSupported: announced },
      client,
      scopes: ['tasks', 'public-read'],
    })
  ).attempt;
}
function token(scope: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  return (
    encode({ alg: 'RS256' }) +
    '.' +
    encode({
      iss: pod.issuer,
      client_id: client.clientId,
      sub: 'urn:person:me',
      iat: now,
      exp: now + 3600,
      scope,
    }) +
    '.c2lnbmF0dXJl'
  );
}

it.each([true, false])(
  'enforces announced=%s issuer response rules',
  async (announced) => {
    const a = await attempt(announced);
    const callback = new URL(client.redirectUri);
    callback.searchParams.set('state', a.state);
    callback.searchParams.set('code', 'fixture');
    if (announced)
      expect(() => validateAuthorizationCallback(a, callback)).toThrow();
    else
      expect(validateAuthorizationCallback(a, callback).get('code')).toBe(
        'fixture',
      );
    for (const issuer of ['', 'https://foreign.example']) {
      callback.searchParams.set('iss', issuer);
      expect(() => validateAuthorizationCallback(a, callback)).toThrow();
    }
    callback.searchParams.set('iss', pod.issuer);
    expect(validateAuthorizationCallback(a, callback).get('code')).toBe(
      'fixture',
    );
    callback.searchParams.append('iss', pod.issuer);
    expect(() => validateAuthorizationCallback(a, callback)).toThrow();
  },
);
it.each(['code', 'refresh'] as const)(
  'accepts reordered %s scopes but rejects duplicates and mismatches',
  async (operation) => {
    const a = await attempt();
    const callback = new URL(
      `${client.redirectUri}?code=fixture&state=${a.state}`,
    );
    const exchange = (claimScope: string, responseScope: string) => {
      const options = {
        fetch: async () =>
          Response.json({
            access_token: token(claimScope),
            token_type: 'Bearer',
            refresh_token: 'replacement',
            scope: responseScope,
          }),
        signal: new AbortController().signal,
      };
      return operation === 'code'
        ? exchangeAuthorization(a, callback, options)
        : refreshAuthorization(a, 'original', 'urn:person:me', options);
    };
    expect(
      (await exchange('tasks public-read', 'public-read tasks')).scopes,
    ).toEqual(['tasks', 'public-read']);
    for (const [claim, response] of [
      ['tasks tasks', 'tasks'],
      ['tasks', 'tasks tasks'],
      ['tasks public-read', 'tasks'],
      ['tasks', 'tasks public-read'],
      ['tasks  public-read', 'tasks public-read'],
    ]) {
      await expect(exchange(claim!, response!)).rejects.toMatchObject({
        problem: 'claims',
      });
    }
  },
);

it('prepares a portable immutable attempt without app identity or lifetime policy', async () => {
  const { attempt: prepared, url } = await prepareAuthorization({
    pod,
    client,
  });
  expect(new URL(url).searchParams.get('client_id')).toBe(client.clientId);
  for (const field of [
    'configKey',
    'connectionId',
    'generation',
    'returnTo',
    'version',
    'lifetime',
    'createdAt',
    'expiresAt',
  ]) {
    expect(prepared).not.toHaveProperty(field);
  }
  expect(Object.isFrozen(prepared)).toBe(true);
  expect(Object.isFrozen(prepared.client)).toBe(true);
  expect(Object.isFrozen(prepared.pod.endpoints)).toBe(true);
});

it.each(['code', 'refresh'] as const)(
  'keeps %s validation bound to a detached input while the token request is pending',
  async (operation) => {
    for (const responseScope of ['tasks', 'tasks admin']) {
      const mutable = structuredClone(await attempt());
      let release!: (response: Response) => void;
      const held = new Promise<Response>((resolve) => {
        release = resolve;
      });
      const fetch = vi.fn(async () => held);
      const options = { fetch, signal: new AbortController().signal };
      const returned = new URL(
        `${client.redirectUri}?code=fixture&state=${mutable.state}`,
      );
      const pending =
        operation === 'code'
          ? exchangeAuthorization(mutable, returned, options)
          : refreshAuthorization(mutable, 'original', 'urn:person:me', options);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      (mutable.scopes as string[]).push('admin');
      (mutable.client as { clientId: string }).clientId = 'dyn:changed';
      (mutable.pod as { issuer: string }).issuer = 'https://changed.example';
      release(
        Response.json({
          access_token: token(responseScope),
          token_type: 'Bearer',
          refresh_token: 'replacement',
          scope: responseScope,
        }),
      );
      if (responseScope === 'tasks')
        await expect(pending).resolves.toMatchObject({ scopes: ['tasks'] });
      else await expect(pending).rejects.toMatchObject({ problem: 'claims' });
    }
  },
);

/** A token-endpoint answer with optional response facts a server or proxy may set. */
function answer(
  body: unknown,
  init: ResponseInit = {},
  facts: { readonly redirected?: boolean; readonly url?: string } = {},
) {
  const response = Response.json(body, init);
  if (facts.redirected !== undefined)
    Object.defineProperty(response, 'redirected', { value: facts.redirected });
  if (facts.url !== undefined)
    Object.defineProperty(response, 'url', { value: facts.url });
  return response;
}
function claims(fields: Record<string, unknown>) {
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return (
    encode({ alg: 'RS256' }) +
    '.' +
    encode({
      iss: pod.issuer,
      client_id: client.clientId,
      sub: 'urn:person:me',
      iat: now,
      exp: now + 3600,
      scope: 'tasks',
      ...fields,
    }) +
    '.c2lnbmF0dXJl'
  );
}
const tokens = (fields: Record<string, unknown> = {}) => ({
  access_token: claims({}),
  token_type: 'Bearer',
  refresh_token: 'replacement',
  ...fields,
});
const challenge = { 'www-authenticate': 'Bearer realm="pod"' };

it.each(['code', 'refresh'] as const)(
  'rejects %s token answers by their protocol cause',
  async (operation) => {
    const a = await attempt();
    const callback = new URL(
      `${client.redirectUri}?code=fixture&state=${a.state}`,
    );
    const run = (response: () => Response) => {
      const options = {
        fetch: async () => response(),
        signal: new AbortController().signal,
      };
      return operation === 'code'
        ? exchangeAuthorization(a, callback, options)
        : refreshAuthorization(a, 'original', 'urn:person:me', options);
    };
    const cases: [string, () => Response, string][] = [
      [
        'invalid_client as JSON',
        () => answer({ error: 'invalid_client' }, { status: 400 }),
        'invalid-client',
      ],
      [
        'invalid_client behind a Bearer challenge',
        () =>
          answer(
            { error: 'invalid_client' },
            { status: 401, headers: challenge },
          ),
        'invalid-client',
      ],
      [
        'invalid_client with a differently cased media type',
        () =>
          new Response(JSON.stringify({ error: 'invalid_client' }), {
            status: 401,
            headers: {
              ...challenge,
              'content-type': 'Application/JSON; charset=utf-8',
            },
          }),
        'invalid-client',
      ],
      [
        'another token error',
        () => answer({ error: 'invalid_grant' }, { status: 400 }),
        'exchange',
      ],
      // The OAuth library refuses unsupported token types before our own check.
      [
        'a non-Bearer token type',
        () => answer(tokens({ token_type: 'MAC' })),
        'exchange',
      ],
      // An ID token was never requested; the library already refuses to process it.
      [
        'an unrequested ID token',
        () => answer(tokens({ id_token: 'x.y.z' })),
        'exchange',
      ],
      [
        'a redirected answer',
        () => answer(tokens(), {}, { redirected: true }),
        'exchange',
      ],
      [
        'an answer from another URL',
        () => answer(tokens(), {}, { url: 'https://proxy.example/token' }),
        'exchange',
      ],
      [
        'a redirect status',
        () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://pod.example/alice/token' },
          }),
        'exchange',
      ],
      [
        'an expiry before its issue time',
        () =>
          answer(
            tokens({
              access_token: claims({ iat: 2_000_000_000, exp: 2_000_000_000 }),
            }),
          ),
        'claims',
      ],
      [
        'a lifetime longer than the token claims',
        () => answer(tokens({ expires_in: 7200 })),
        'claims',
      ],
      [
        'an already expired token',
        () =>
          answer(
            tokens({
              access_token: claims({ iat: 1_000_000, exp: 1_000_060 }),
            }),
          ),
        'claims',
      ],
    ];
    const outcomes = await Promise.all(
      cases.map(([, response]) =>
        run(response).then(
          () => 'accepted',
          (error: { problem?: string }) => error.problem,
        ),
      ),
    );
    expect(
      Object.fromEntries(cases.map(([name], i) => [name, outcomes[i]])),
    ).toEqual(Object.fromEntries(cases.map(([name, , p]) => [name, p])));
    // Lowercase "bearer" is the same token type.
    await expect(
      run(() => answer(tokens({ token_type: 'bearer' }))),
    ).resolves.toMatchObject({ subject: 'urn:person:me' });
  },
);

it('does not judge iat against the local clock; receipt and expires_in bound the lifetime', async () => {
  const a = await attempt();
  // The Pod's clock runs a day ahead of this device.
  const ahead = Math.floor(Date.now() / 1000) + 86_400;
  const receivedBefore = Date.now();
  const result = await refreshAuthorization(a, 'original', 'urn:person:me', {
    fetch: async () =>
      answer(
        tokens({
          access_token: claims({ iat: ahead, exp: ahead + 3600 }),
          expires_in: 3600,
        }),
      ),
    signal: new AbortController().signal,
  });
  expect(result.expiresAt - receivedBefore).toBeGreaterThanOrEqual(3_600_000);
  expect(result.expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000);
});

it('rejects error and denial callbacks distinctly and duplicate reserved parameters', async () => {
  const a = await attempt();
  const callback = (query: string) => new URL(`${client.redirectUri}?${query}`);
  expect(() =>
    validateAuthorizationCallback(
      a,
      callback(`error=access_denied&state=${a.state}`),
    ),
  ).toThrow(expect.objectContaining({ problem: 'denied' }));
  for (const query of [
    `error=access_denied&code=x&state=${a.state}`,
    `error=server_error&state=${a.state}`,
    `code=x&state=${a.state}&state=${a.state}`,
    `code=x&code=y&state=${a.state}`,
    `code=&state=${a.state}`,
    `code=x&state=other`,
  ])
    expect(
      () => validateAuthorizationCallback(a, callback(query)),
      query,
    ).toThrow(expect.objectContaining({ problem: 'callback' }));
});

it('validates portable preparation input before generating any secret', async () => {
  const cases: [string, Parameters<typeof prepareAuthorization>[0], string][] =
    [
      [
        'foreign issuer',
        { pod: { ...pod, issuer: 'https://x.example' }, client },
        'attempt',
      ],
      [
        'client of another Pod',
        { pod, client: { ...client, podUrl: 'https://pod.example/bob' } },
        'attempt',
      ],
      [
        'non-HTTPS callback',
        { pod, client: { ...client, redirectUri: 'http://app.example/cb' } },
        'attempt',
      ],
      [
        'duplicate scope',
        { pod, client, scopes: ['tasks', 'tasks'] },
        'attempt',
      ],
      [
        'scope with a space',
        { pod, client, scopes: ['tasks read'] },
        'attempt',
      ],
    ];
  for (const [name, input, problem] of cases)
    await expect(prepareAuthorization(input), name).rejects.toMatchObject({
      problem,
    });
  const valid = await prepareAuthorization({ pod, client });
  expect(new URL(valid.url).searchParams.has('scope')).toBe(false);
});
