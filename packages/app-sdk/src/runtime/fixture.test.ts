import { IDBFactory } from 'fake-indexeddb';
import { expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import { openSessionStore } from '../sessions/store.js';

export const pod = 'https://pod.example/alice';
export const callback = 'https://app.example/oauth/callback';
export const work = pod + '/_system/contexts/work';
export const personal = pod + '/_system/contexts/personal';
/** Startup no longer waits for restoration; tests wait for each saved Pod to settle. */
export async function restored(runtime: BrowserRuntime) {
  await vi.waitFor(() => {
    if (runtime.getSnapshot().some((c) => c.session.kind === 'restoring'))
      throw new Error('still restoring');
  });
}
export async function settleLease() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((r, f) => {
    resolve = r;
    reject = f;
  });
  return { promise, resolve, reject };
}
export function jwt(changes: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const value = {
    iss: pod,
    client_id: 'dyn:test',
    sub: 'https://person.example/#me',
    exp: now + 3600,
    iat: now,
    scope: '',
    ...changes,
  };
  const encode = (v: unknown) =>
    Buffer.from(JSON.stringify(v)).toString('base64url');
  return encode({ alg: 'RS256' }) + '.' + encode(value) + '.c2lnbmF0dXJl';
}
export function catalogue(
  readable = [work, personal],
  writable = [work],
  base = pod,
) {
  return Response.json({
    '@id': base + '/_system/contexts',
    '@type': [
      'http://www.w3.org/ns/sparql-service-description#GraphCollection',
    ],
    ['http://www.w3.org/ns/sparql-service-description#namedGraph']:
      readable.map((iri) => ({ '@id': iri })),
    ['https://schema.sempods.org/readableContext']: readable.map((iri) => ({
      '@id': iri,
    })),
    ['https://schema.sempods.org/writableContext']: writable.map((iri) => ({
      '@id': iri,
    })),
  });
}
export function fixture(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const factory = new IDBFactory();
  let held = false;
  const locks = {
    async request(
      _name: string,
      _opts: { ifAvailable: true },
      fn: (lock: { name: string } | null) => Promise<void>,
    ) {
      if (held) return fn(null);
      held = true;
      try {
        await fn({ name: 'fixture' });
      } finally {
        held = false;
      }
    },
  };
  let token: PodFetch = async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'refresh-private',
    });
  let query: PodFetch = async () => Response.json([{ '@id': 'urn:item' }]);
  let resource: PodFetch = async () =>
    Response.json({ '@id': 'urn:item' }, { headers: { etag: '"v1"' } });
  let contexts: PodFetch = async () => catalogue();
  // Context descriptions (SPS-CTX-032): none by default, so no labels appear.
  let descriptions: PodFetch = async () => new Response(null, { status: 404 });
  const fetch = vi.fn<PodFetch>(async (url, init) => {
    const base = url.split('/.well-known')[0]!.split('/_system')[0]!;
    if (url.endsWith('/.well-known/oauth-protected-resource'))
      return Response.json({
        resource: base,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
      });
    if (url.endsWith('/.well-known/oauth-authorization-server'))
      return Response.json({
        issuer: base,
        authorization_endpoint: base + '/_system/auth/authorize',
        token_endpoint: base + '/_system/auth/token',
        registration_endpoint: base + '/_system/auth/register',
        jwks_uri: base + '/_system/auth/jwks.json',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.endsWith('/register'))
      return Response.json(
        {
          client_id: 'dyn:test',
          redirect_uris: [callback],
          response_types: ['code'],
          grant_types: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_method: 'none',
        },
        { status: 201 },
      );
    if (url.endsWith('/token')) return token(url, init);
    if (url.endsWith('/_system/contexts')) return contexts(url, init);
    if (url.includes('/_system/contexts/')) return descriptions(url, init);
    if (url.includes('/_system/sparql/query')) return query(url, init);
    if (url.includes('/_system/resources/')) return resource(url, init);
    throw new Error('Unexpected fixture route.');
  });
  const navigate = vi.fn<(url: string) => void>();
  const replaceUrl = vi.fn<(url: string) => void>();
  const options: BrowserRuntimeOptions = {
    identity: { kind: 'dynamic', name: 'Test', redirectUri: callback },
    fetch,
    navigate,
    replaceUrl,
    locks,
    openStore: (namespace) => openSessionStore(namespace, factory),
    location: () => 'https://app.example/',
    ...overrides,
  };
  const runtime = createBrowserRuntime(options);
  async function begin() {
    await runtime.initialize();
    const connection = await runtime.connect(pod);
    await runtime.beginAuthorization(connection.id);
    return {
      connection,
      authorization: new URL(navigate.mock.calls.at(-1)![0]),
    };
  }
  async function login() {
    const { connection, authorization } = await begin();
    runtime.dispose();
    await settleLease();
    const next = returned(authorization);
    expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
    await next.loadContexts(connection.id);
    next.selectContext(connection.id, work);
    return { runtime: next, id: connection.id, view: next.bind(connection.id) };
  }
  /** A runtime opened on the callback for an attempt; `answer` precedes its state. */
  function returned(auth?: URL, answer = 'code=fixture-code') {
    const authorization = auth ?? new URL(navigate.mock.calls.at(-1)![0]);
    return createBrowserRuntime({
      ...options,
      location: () =>
        `${callback}?${answer}&state=` +
        authorization.searchParams.get('state'),
    });
  }
  return {
    runtime,
    factory,
    options,
    fetch,
    navigate,
    replaceUrl,
    begin,
    login,
    returned,
    setToken: (fn: PodFetch) => {
      token = fn;
    },
    setQuery: (fn: PodFetch) => {
      query = fn;
    },
    setResource: (fn: PodFetch) => {
      resource = fn;
    },
    setCatalogue: (fn: PodFetch) => {
      contexts = fn;
    },
    setDescriptions: (fn: PodFetch) => {
      descriptions = fn;
    },
    count: (suffix: string) =>
      fetch.mock.calls.filter(([url]) => new URL(url).pathname.endsWith(suffix))
        .length,
  };
}
it('constructs a runtime without opening storage or contacting a Pod', () => {
  const f = fixture();
  expect(f.fetch).not.toHaveBeenCalled();
  f.runtime.dispose();
});
