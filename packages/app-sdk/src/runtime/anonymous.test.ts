/**
 * Apps without sign-in, or with optional sign-in (#240): under `signIn:
 * 'optional'` or `'none'` a connection without a session reads the Pod's
 * public Contexts without a token (`reading: 'anonymous'`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import { RuntimeError } from './errors.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  pod,
  renewal,
  restart,
  savedRecords,
  settleLease,
  without,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((runtime) => runtime.dispose()));
const keep = (runtime: BrowserRuntime) => {
  runtimes.push(runtime);
  return runtime;
};

/** Only `work` is public: an anonymous catalogue lists it as readable only. */
const publicCatalogue = () => catalogue([work], []);
const authorization = (init?: RequestInit) =>
  new Headers(init?.headers).get('authorization');
/** Calls to `suffix`, split by whether they carried a token. */
function sent(f: ReturnType<typeof fixture>, suffix: string) {
  const calls = f.fetch.mock.calls.filter(([url]) =>
    new URL(url).pathname.endsWith(suffix),
  );
  return {
    anonymous: calls.filter(([, init]) => authorization(init) === null).length,
    bearer: calls.filter(([, init]) => authorization(init) !== null).length,
  };
}
const discovery = (f: ReturnType<typeof fixture>) =>
  f.count('/oauth-protected-resource') +
  f.count('/oauth-authorization-server') +
  f.count('/register');

function optional(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({
    preferences: null,
    signIn: 'optional',
    preset: { podUrl: pod },
    ...overrides,
  });
  keep(f.runtime);
  // A Pod answers a request without a token with its public Contexts only.
  f.setCatalogue(async (_url, init) =>
    authorization(init) === null ? publicCatalogue() : catalogue(),
  );
  return f;
}
/** Signed in under `signIn: 'optional'`, with `work` selected. */
async function signedIn(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = optional(overrides);
  const login = await f.login();
  keep(login.runtime);
  return { ...f, ...login };
}

describe('configuration', () => {
  const identity = {
    kind: 'dynamic',
    name: 'Test',
    redirectUri: 'https://app.example/oauth/callback',
  } as const;
  it.each<[string, BrowserRuntimeOptions]>([
    ['an unknown mode', { identity, signIn: 'maybe' as 'none' }],
    [
      'no identity with sign-in',
      { signIn: 'optional', preset: { podUrl: pod } },
    ],
    ['no identity by default', {}],
    [
      'required scopes under optional',
      { identity, signIn: 'optional', scopes: { required: ['tasks'] } },
    ],
    [
      'optional scopes under none',
      { signIn: 'none', preset: { podUrl: pod }, scopes: { optional: ['x'] } },
    ],
    [
      'required scopes under none',
      { signIn: 'none', preset: { podUrl: pod }, scopes: { required: ['x'] } },
    ],
    ['none without a default Pod', { signIn: 'none' }],
    [
      'none with several allowed Pods',
      { signIn: 'none', allowedPods: [pod, 'https://pod.example/bob'] },
    ],
  ])('rejects %s before any request', (_name, options) => {
    expect(() => createBrowserRuntime(options)).toThrow(
      new RuntimeError('configuration'),
    );
  });
  it('accepts none with a sole allowed Pod and no identity', () => {
    const runtime = keep(
      createBrowserRuntime({ signIn: 'none', allowedPods: [pod] }),
    );
    expect(runtime.signIn).toBe('none');
  });
  it('defaults to required and asks for public-read only under optional', async () => {
    expect(keep(createBrowserRuntime({ identity })).signIn).toBe('required');
    const f = optional({ scopes: { optional: ['tasks'] } });
    await f.runtime.initialize();
    expect(f.runtime.getSnapshot()[0]).toMatchObject({
      requestedScopes: ['tasks', 'public-read'],
      optionalScopes: ['tasks', 'public-read'],
      requiredScopes: [],
    });
    // Listed by the app already: not twice.
    const g = optional({ scopes: { optional: ['public-read'] } });
    await g.runtime.initialize();
    expect(g.runtime.getSnapshot()[0]!.requestedScopes).toEqual([
      'public-read',
    ]);
  });
});

describe('signIn: optional', () => {
  it('starts with the default Pod read without a token, without discovery or a client', async () => {
    const f = optional();
    expect(await f.runtime.initialize()).toMatchObject({
      interaction: 'none',
      storage: 'durable',
    });
    expect(f.runtime.getSnapshot()).toMatchObject([
      {
        id: pod,
        podUrl: pod,
        clientKind: 'dynamic',
        session: { kind: 'signed-out' },
        reading: 'anonymous',
        catalogue: { kind: 'unknown' },
      },
    ]);
    const result = await f.runtime.loadContexts(pod);
    expect(result).toMatchObject({ kind: 'ok' });
    expect(f.runtime.getSnapshot()[0]!.catalogue).toEqual({
      kind: 'ready',
      contexts: [
        { iri: work, readable: true, writable: false, manageable: false },
      ],
    });
    expect(sent(f, '/_system/contexts')).toEqual({ anonymous: 1, bearer: 0 });
    expect(discovery(f)).toBe(0);
    expect(f.count('/token')).toBe(0);
  });

  it('reads a public Context and never dispatches a write', async () => {
    const f = optional();
    await f.runtime.initialize();
    await f.runtime.loadContexts(pod);
    f.runtime.selectContext(pod, work);
    const view = f.runtime.bind(pod);
    expect(view.getSnapshot()).toMatchObject({
      current: true,
      read: true,
      write: false,
    });
    expect(await view.subjects.get('urn:item')).toMatchObject({ kind: 'ok' });
    expect(
      await view.subjects.put(
        'urn:item',
        { '@id': 'urn:item' },
        { ifNoneMatch: '*' },
      ),
    ).toMatchObject({ kind: 'not-sent' });
    const pods = f.runtime.bindPod(pod);
    expect(pods.getSnapshot()).toMatchObject({ current: true, read: true });
    expect(await pods.sparql.construct('CONSTRUCT {} WHERE {}')).toMatchObject({
      kind: 'ok',
    });
    const calls = f.fetch.mock.calls.filter(
      ([url]) => !new URL(url).pathname.endsWith('/_system/contexts'),
    );
    expect(calls.map(([, init]) => init?.method ?? 'GET')).not.toContain('PUT');
    expect(calls.every(([, init]) => authorization(init) === null)).toBe(true);
    // Another Context is not listed: neither selectable nor readable.
    expect(() => f.runtime.selectContext(pod, personal)).toThrow(
      new RuntimeError('configuration'),
    );
    expect(f.runtime.bindContext(pod, personal).getSnapshot().read).toBe(false);
  });

  it('adds a Pod without discovery and validates its address', async () => {
    const f = optional(without('preset'));
    await f.runtime.initialize();
    expect(f.runtime.getSnapshot()).toEqual([]);
    const bob = await f.runtime.connect('https://pod.example/bob');
    expect(bob).toMatchObject({
      podUrl: 'https://pod.example/bob',
      session: { kind: 'signed-out' },
      reading: 'anonymous',
    });
    expect(discovery(f)).toBe(0);
    await expect(
      f.runtime.connect('https://pod.example/bob/'),
    ).rejects.toThrow();
    expect(f.runtime.getSnapshot()).toHaveLength(1);
  });

  it('discovers only when signing in, and reads with the token after the callback', async () => {
    const f = optional();
    await f.runtime.initialize();
    // A pending anonymous read is invalidated by the sign-in.
    const held = deferred<Response>();
    f.setCatalogue(() => held.promise);
    const pending = f.runtime.loadContexts(pod);
    expect(discovery(f)).toBe(0);
    await f.runtime.beginAuthorization(pod);
    expect(discovery(f)).toBeGreaterThan(0);
    expect(f.runtime.getSnapshot()[0]).toMatchObject({
      session: { kind: 'leaving' },
      reading: null,
    });
    held.resolve(publicCatalogue());
    expect(await pending).toEqual({ kind: 'invalidated' });
    f.runtime.dispose();
    await settleLease();
    f.setCatalogue(async (_url, init) =>
      authorization(init) === null ? publicCatalogue() : catalogue(),
    );
    const next = keep(f.returned());
    expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
    expect(next.getSnapshot()).toMatchObject([
      { id: pod, session: { kind: 'active' }, reading: 'session' },
    ]);
    await next.loadContexts(pod);
    expect(sent(f, '/_system/contexts').bearer).toBe(1);
    expect(next.getSnapshot()[0]!.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [{ iri: work, writable: true }, { iri: personal }],
    });
  });

  it('reads without the token after a refused renewal, without resending the refused request', async () => {
    const f = await signedIn();
    const before = f.runtime.bind(f.id);
    expect(before.getSnapshot().write).toBe(true);
    const queries: (string | null)[] = [];
    f.setQuery(async (_url, init) => {
      queries.push(authorization(init));
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      });
    });
    f.setToken(async () =>
      Response.json({ error: 'invalid_grant' }, { status: 400 }),
    );
    await f.runtime
      .bindPod(f.id)
      .sparql.construct('CONSTRUCT {} WHERE {}')
      .catch(() => {});
    await vi.waitFor(() =>
      expect(f.runtime.getSnapshot()[0]).toMatchObject({
        session: { kind: 'ended' },
        reading: 'anonymous',
        catalogue: { kind: 'unknown' },
        grantedScopes: [],
      }),
    );
    // The refused query was sent once, with the token, and not again without it.
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^Bearer /);
    // The session's handle is replaced; the new one reads the public catalogue.
    expect(before.getSnapshot()).toMatchObject({ current: false, read: false });
    await f.runtime.loadContexts(f.id);
    const after = f.runtime.bind(f.id);
    expect(after).not.toBe(before);
    expect(after.key).not.toBe(before.key);
    expect(after.getSnapshot()).toMatchObject({ read: true, write: false });
  });

  it('reads without a token after a sign-out, also when the address is not remembered', async () => {
    for (const rememberPods of [true, false]) {
      const f = await signedIn({ rememberPods });
      expect(await f.runtime.disconnect(f.id)).toEqual({
        kind: 'disconnected',
      });
      expect(f.runtime.getSnapshot()).toMatchObject([
        {
          id: f.id,
          session: { kind: 'signed-out', problem: 'disconnected' },
          reading: 'anonymous',
        },
      ]);
      expect((await savedRecords(f.factory)).length).toBe(rememberPods ? 1 : 0);
      runtimes.splice(0).forEach((runtime) => runtime.dispose());
      await settleLease();
    }
  });

  it('lists a remembered Pod after a reload, read without a token', async () => {
    const f = await signedIn();
    await renewal(f, f.runtime, f.id, 'refused');
    expect(f.runtime.getSnapshot()[0]!.reading).toBe('anonymous');
    await vi.waitFor(async () =>
      expect((await savedRecords(f.factory))[0]?.value).toMatchObject({
        kind: 'disconnected',
      }),
    );
    const next = await restart(f, f.runtime, keep);
    expect(next.getSnapshot()).toMatchObject([
      {
        id: f.id,
        session: { kind: 'signed-out', problem: expect.any(String) },
        reading: 'anonymous',
      },
    ]);
    expect(await next.loadContexts(f.id)).toMatchObject({ kind: 'ok' });
  });

  it('adds the default Pod again after it was forgotten', async () => {
    const f = await signedIn();
    expect(await f.runtime.forget(f.id)).toEqual({ kind: 'disconnected' });
    expect(f.runtime.getSnapshot()).toMatchObject([
      { id: pod, session: { kind: 'signed-out' }, reading: 'anonymous' },
    ]);
    expect(f.runtime.getSnapshot()[0]!.session).toEqual({
      kind: 'signed-out',
    });
    expect(await savedRecords(f.factory)).toEqual([]);
  });

  it('sends nothing while a saved session restores', async () => {
    const f = await signedIn();
    const held = deferred<Response>();
    const fetch = f.fetch.getMockImplementation()!;
    const next = await (async () => {
      f.runtime.dispose();
      await settleLease();
      const runtime = keep(
        createBrowserRuntime({
          ...f.options,
          location: () => 'https://app.example/',
          fetch: vi.fn<PodFetch>((url, init) =>
            url.includes('/.well-known/') ? held.promise : fetch(url, init),
          ),
        }),
      );
      await runtime.initialize();
      return runtime;
    })();
    expect(next.getSnapshot()).toMatchObject([
      { session: { kind: 'restoring' }, reading: null },
    ]);
    expect(() => next.bind(f.id)).toThrow(new RuntimeError('disconnected'));
    held.resolve(new Response(null, { status: 503 }));
    await vi.waitFor(() =>
      expect(next.getSnapshot()[0]).toMatchObject({
        session: { kind: 'ended', restorable: true },
        reading: null,
      }),
    );
  });
});

describe('signIn: none', () => {
  function none(overrides: Partial<BrowserRuntimeOptions> = {}) {
    const f = fixture({
      preferences: null,
      signIn: 'none',
      preset: { podUrl: pod },
      ...without('identity'),
      openStore: () => Promise.reject(new Error('no store expected')),
      locks: {
        request: () => Promise.reject(new Error('no lock expected')),
      },
      ...overrides,
    });
    keep(f.runtime);
    f.setCatalogue(async () => publicCatalogue());
    return f;
  }

  it('opens no store and takes no lock, so several tabs start side by side', async () => {
    const a = none();
    const b = none();
    for (const f of [a, b]) {
      expect(await f.runtime.initialize()).toEqual({
        interaction: 'none',
        storage: 'unavailable',
        unreadable: [],
      });
      expect(f.runtime.getSnapshot()).toMatchObject([
        {
          id: pod,
          clientKind: null,
          session: { kind: 'signed-out' },
          reading: 'anonymous',
        },
      ]);
      expect(await f.runtime.loadContexts(pod)).toMatchObject({ kind: 'ok' });
      expect(sent(f, '/_system/contexts')).toEqual({ anonymous: 1, bearer: 0 });
      expect(discovery(f)).toBe(0);
    }
  });

  it('rejects signing in, signing out, forgetting and other Pods', async () => {
    const f = none();
    await f.runtime.initialize();
    const configuration = new RuntimeError('configuration');
    await expect(f.runtime.beginAuthorization(pod)).rejects.toThrow(
      configuration,
    );
    await expect(f.runtime.disconnect(pod)).rejects.toThrow(configuration);
    await expect(f.runtime.forget(pod)).rejects.toThrow(configuration);
    await expect(f.runtime.connect('https://pod.example/bob')).rejects.toThrow(
      configuration,
    );
    expect((await f.runtime.connect()).id).toBe(pod);
    expect(f.navigate).not.toHaveBeenCalled();
  });

  it('remembers the chosen Context per Pod across starts', async () => {
    const storage = new Map<string, string>();
    const preferences = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
    };
    const f = none({ preferences });
    await f.runtime.initialize();
    await f.runtime.loadContexts(pod);
    f.runtime.selectContext(pod, work);
    f.runtime.dispose();
    const g = none({ preferences });
    await g.runtime.initialize();
    await g.runtime.loadContexts(pod);
    expect(g.runtime.getSnapshot()[0]!.selectedContext).toBe(work);
  });
});

describe('signIn: required', () => {
  it('keeps a connection without a session from sending anything', async () => {
    const f = fixture({ preferences: null, preset: { podUrl: pod } });
    keep(f.runtime);
    await f.runtime.initialize();
    expect(f.runtime.getSnapshot()).toEqual([]);
    const connection = await f.runtime.connect();
    expect(connection).toMatchObject({
      session: { kind: 'signed-out' },
      reading: null,
    });
    expect(() => f.runtime.bindPod(connection.id)).toThrow(
      new RuntimeError('disconnected'),
    );
    await expect(f.runtime.loadContexts(connection.id)).rejects.toThrow(
      new RuntimeError('disconnected'),
    );
  });
});
