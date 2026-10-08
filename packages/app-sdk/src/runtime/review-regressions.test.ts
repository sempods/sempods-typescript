import { afterEach, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { SdkError } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import {
  RuntimeError,
  runtimeFailure,
  runtimeProblem,
  transientBeforeClaim,
} from './errors.js';
import { SessionTransitionError } from '../sessions/records.js';
import { openSessionStore, SessionStorageError } from '../sessions/store.js';
import {
  fixture,
  settleLease,
  deferred,
  catalogue,
  pod,
  work,
  personal,
  callback,
  jwt,
  restored,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((runtime) => runtime.dispose());
  vi.restoreAllMocks();
});
async function logged(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture(overrides);
  runtimes.push(f.runtime);
  const result = await f.login();
  runtimes.push(result.runtime);
  return { ...f, ...result };
}
async function reload(
  f: Awaited<ReturnType<typeof logged>>,
  overrides: Partial<BrowserRuntimeOptions> = {},
) {
  f.runtime.dispose();
  await settleLease();
  const runtime = createBrowserRuntime({ ...f.options, ...overrides });
  runtimes.push(runtime);
  await runtime.initialize();
  await restored(runtime);
  return runtime;
}
const query = 'CONSTRUCT {} WHERE {}';
const dynamicNamespace = JSON.stringify(['dynamic', callback]);

it.each(['offline', 'http', 'storage'] as const)(
  'preserves an unspent durable session after pre-claim %s failure',
  async (mode) => {
    const f = await logged();
    const originalFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation((url, init) => {
      if (url.includes('/.well-known/') && mode !== 'storage') {
        if (mode === 'offline') throw new TypeError('offline');
        return Promise.resolve(new Response(null, { status: 503 }));
      }
      return originalFetch(url, init);
    });
    if (mode === 'storage') {
      const put = IDBObjectStore.prototype.put;
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        if (value?.value?.kind === 'claimed') throw new Error('disk failed');
        return put.call(this, value, key);
      });
    }
    f.setResource(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    expect(
      await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
    ).toEqual({ kind: 'refused', status: 401 });
    expect(f.count('/token')).toBe(1);
    // Nothing was spent, so the session stays signed in (no reload needed).
    expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
      kind: 'active',
    });
    const store = await openSessionStore(dynamicNamespace, f.factory);
    expect((await store.read(f.id))?.value).toMatchObject({ kind: 'ready' });
    store.close();
    vi.restoreAllMocks();
    f.fetch.mockImplementation(originalFetch);
    // Back online: the next refused request renews in memory and is resent once.
    f.setToken(async () =>
      Response.json({
        access_token: jwt(),
        token_type: 'Bearer',
        refresh_token: 'rotated',
      }),
    );
    let answered = 0;
    f.setResource(async () =>
      ++answered === 1
        ? new Response(null, {
            status: 401,
            headers: { 'www-authenticate': 'Bearer' },
          })
        : new Response(null, { status: 204 }),
    );
    expect(
      await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
    ).toMatchObject({ kind: 'applied' });
    expect(f.count('/token')).toBe(2);
    const next = await reload(f);
    await vi.waitFor(() =>
      expect(next.getSnapshot()[0]?.session.kind).toBe('active'),
    );
  },
);
it.each([
  ['token-endpoint', 'state'],
  ['no-refresh', 'state'],
  ['unsupported-flow', 'discovery'],
] as const)(
  'ends instead of retrying forever when renewal fails permanently before the claim (%s)',
  async (mode, problem) => {
    const f = await logged();
    const originalFetch = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const answer = await originalFetch(url, init);
      if (!url.endsWith('/.well-known/oauth-authorization-server'))
        return answer;
      const metadata = (await answer.json()) as Record<string, unknown>;
      if (mode === 'token-endpoint')
        metadata['token_endpoint'] = `${pod}/_system/auth/token-v2`;
      if (mode === 'no-refresh')
        metadata['grant_types_supported'] = ['authorization_code'];
      if (mode === 'unsupported-flow')
        metadata['code_challenge_methods_supported'] = ['plain'];
      return Response.json(metadata);
    });
    f.setResource(
      async () =>
        new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    expect(
      await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
    ).toEqual({ kind: 'refused', status: 401 });
    // The changed binding or flow is surfaced: the app shows a new sign-in.
    expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
      kind: 'ended',
      problem,
    });
    expect(f.count('/token')).toBe(1);
    // Nothing was spent: the durable record keeps its unspent refresh token.
    const store = await openSessionStore(dynamicNamespace, f.factory);
    expect((await store.read(f.id))?.value).toMatchObject({ kind: 'ready' });
    store.close();
    // A reload reaches the same visible end instead of an active session.
    expect((await reload(f)).getSnapshot()[0]?.session).toMatchObject({
      kind: 'ended',
      problem,
    });
  },
);
it('ends instead of staying active when another tab upgrades the session database', async () => {
  const f = await logged();
  // A newer database version closes this runtime's store for good.
  await new Promise<void>((resolve, reject) => {
    const request = f.factory.open('sempods:app-sdk:sessions', 2);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
  f.setResource(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'refused', status: 401 });
  expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'storage',
  });
  // The refresh token was neither spent nor replayed.
  expect(f.count('/token')).toBe(1);
});
it('retries renewal only after failures that may pass', () => {
  const discovery = (
    problem: 'http' | 'network' | 'invalid-metadata',
    status?: number,
  ) =>
    new SdkError(
      {
        code: 'discovery',
        stage: 'authorization-server',
        problem,
        ...(status === undefined ? {} : { status }),
      },
      'discovery',
    );
  expect(
    [
      discovery('network'),
      discovery('http', 503),
      discovery('http', 429),
      new SdkError({ code: 'transport', problem: 'network' }, 'transport'),
      new SessionStorageError('unavailable'),
    ].map(transientBeforeClaim),
  ).toEqual([true, true, true, true, true]);
  expect(
    [
      discovery('http', 404),
      discovery('invalid-metadata'),
      new SessionTransitionError('state'),
      new SessionStorageError('corrupt'),
      new SessionStorageError('closed'),
      new RuntimeError('storage'),
      new RuntimeError('disconnected'),
      new TypeError('unexpected'),
    ].map(transientBeforeClaim),
  ).toEqual([false, false, false, false, false, false, false, false]);
});
it('stores only a secret-free claim at the moment the refresh is dispatched', async () => {
  const f = await logged();
  const store = await openSessionStore(dynamicNamespace, f.factory);
  let atDispatch: unknown;
  f.setToken(async () => {
    atDispatch = (await store.read(f.id))?.value;
    return Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    });
  });
  let answered = 0;
  f.setResource(async () =>
    ++answered === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : new Response(null, { status: 204 }),
  );
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toMatchObject({ kind: 'applied' });
  expect(atDispatch).toMatchObject({ kind: 'claimed' });
  // Neither the spent refresh token nor any access token is in that record.
  expect(JSON.stringify(atDispatch)).not.toContain('refresh-private');
  expect(JSON.stringify(atDispatch)).not.toMatch(/eyJ|access/i);
  expect((await store.read(f.id))?.value).toMatchObject({ kind: 'ready' });
  store.close();
});

it('reports missing Web Locks without touching records, and a later start recovers', async () => {
  const f = await logged();
  const before = await openSessionStore(dynamicNamespace, f.factory);
  const record = await before.read(f.id);
  before.close();
  f.runtime.dispose();
  await settleLease();
  const unlocked = createBrowserRuntime({ ...f.options, locks: null });
  runtimes.push(unlocked);
  expect(await unlocked.initialize()).toMatchObject({
    interaction: 'none',
    storage: 'unavailable',
    problem: 'coordination',
  });
  expect(unlocked.getSnapshot()).toEqual([]);
  unlocked.dispose();
  const after = await openSessionStore(dynamicNamespace, f.factory);
  expect(await after.read(f.id)).toEqual(record);
  after.close();
  // With coordination available again, the saved session restores.
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  await next.initialize();
  await restored(next);
  expect(next.getSnapshot()[0]?.session.kind).toBe('active');
});

it('retires the consumed refresh after a lost token answer and never retries it on reload', async () => {
  const f = await logged();
  f.setResource(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  f.setToken(async () => {
    throw new TypeError('lost response');
  });
  expect(
    await f.view.subjects.patch('urn:item', {}, { ifMatch: '"v1"' }),
  ).toEqual({ kind: 'refused', status: 401 });
  const store = await openSessionStore(dynamicNamespace, f.factory);
  await vi.waitFor(async () =>
    expect((await store.read(f.id))?.value).toMatchObject({
      kind: 'disconnected',
    }),
  );
  store.close();
  expect((await reload(f)).getSnapshot()).toEqual([]);
  expect(f.count('/token')).toBe(2);
});

it.each(['unchanged', 'other-context', 'refused', 'offline'] as const)(
  'keeps a concurrent read eligible through %s 403 revalidation',
  async (mode) => {
    const f = await logged();
    const held = deferred<Response>();
    let reads = 0;
    f.setQuery(() =>
      ++reads === 1
        ? held.promise
        : Promise.resolve(new Response(null, { status: 403 })),
    );
    const pending = f.view.sparql.construct(query);
    await vi.waitFor(() => expect(reads).toBe(1));
    f.setCatalogue(async () => {
      if (mode === 'offline') throw new TypeError('offline');
      if (mode === 'refused') return new Response(null, { status: 403 });
      return catalogue(
        [work, personal],
        mode === 'other-context' ? [work, personal] : [work],
      );
    });
    expect(await f.view.sparql.construct(query)).toEqual({
      kind: 'refused',
      status: 403,
    });
    held.resolve(Response.json([{ '@id': 'urn:kept' }]));
    expect(await pending).toEqual({
      kind: 'ok',
      body: [{ '@id': 'urn:kept' }],
    });
    expect(f.count('/_system/contexts')).toBe(2);
  },
);
it.each(['read-loss', 'write-loss'] as const)(
  'invalidates pending reads on actual selected-context %s',
  async (mode) => {
    const f = await logged();
    const held = deferred<Response>();
    f.setQuery(() => held.promise);
    const pending = f.view.sparql.construct(query);
    await vi.waitFor(() => expect(f.count('/_system/sparql/query')).toBe(1));
    f.setCatalogue(async () =>
      catalogue(mode === 'read-loss' ? [] : [work, personal], []),
    );
    await f.runtime.loadContexts(f.id);
    expect(await pending).toEqual({ kind: 'invalidated' });
    held.resolve(Response.json([]));
    expect(f.runtime.bind(f.id)).toBe(f.view);
  },
);
it('settles an answered 403 write when its caller aborts a hung catalogue wait', async () => {
  const f = await logged();
  const held = deferred<Response>();
  f.setResource(async () => new Response(null, { status: 403 }));
  f.setCatalogue(() => held.promise);
  const caller = new AbortController();
  const pending = f.view.subjects.patch(
    'urn:item',
    {},
    { ifMatch: '"v1"' },
    { signal: caller.signal },
  );
  await vi.waitFor(() => expect(f.count('/_system/contexts')).toBe(2));
  caller.abort();
  expect(await pending).toEqual({ kind: 'refused', status: 403 });
  held.resolve(catalogue([work, personal], []));
  await vi.waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe('ready'),
  );
});
it('restores dynamic sessions across name, property-order and scope-policy changes', async () => {
  const f = await logged({ scopes: { optional: ['tasks', 'ai'] } });
  const next = await reload(f, {
    identity: { redirectUri: callback, name: 'Renamed', kind: 'dynamic' },
    scopes: { required: ['ai', 'tasks'], optional: ['new-feature'] },
  });
  expect(next.getSnapshot()).toHaveLength(1);
  expect(next.getSnapshot()[0]).toMatchObject({
    id: f.id,
    session: { kind: 'active' },
    requestedScopes: ['tasks', 'ai'],
    missingRequiredScopes: ['ai', 'tasks'],
  });
  await next.loadContexts(f.id);
  next.selectContext(f.id, work);
  expect(await next.bind(f.id).sparql.construct(query)).toEqual({
    kind: 'invalidated',
  });
  const busy = createBrowserRuntime({ ...f.options, scopes: {} });
  runtimes.push(busy);
  expect(await busy.initialize()).toMatchObject({ problem: 'busy' });
});
it('isolates different dynamic callback identities', async () => {
  const f = await logged();
  const next = await reload(f, {
    identity: {
      kind: 'dynamic',
      name: 'Other',
      redirectUri: 'https://app.example/other-callback',
    },
  });
  expect(next.getSnapshot()).toEqual([]);
});
it('preserves structured safe discovery failures and distinguishes session transition failures', () => {
  const error = new SdkError(
    {
      code: 'discovery',
      stage: 'authorization-server',
      problem: 'identity-mismatch',
      field: 'issuer',
    },
    'private diagnostic',
    { cause: new Error('private body') },
  );
  expect(runtimeProblem(error)).toBe('discovery');
  expect(runtimeFailure(error)).toEqual({ failure: error.reason });
  expect(JSON.stringify(runtimeFailure(error))).not.toContain('private');
  expect(runtimeProblem(new SessionTransitionError('state'))).toBe('state');
  expect(runtimeProblem(new SessionTransitionError('result'))).toBe('result');
});
it.each(['authorizing', 'expired', 'claimed'] as const)(
  'reports a recoverable %s record explicitly without blind cleanup',
  async (kind) => {
    const f = fixture();
    runtimes.push(f.runtime);
    const { connection } = await f.begin();
    f.runtime.dispose();
    await settleLease();
    const store = await openSessionStore(dynamicNamespace, f.factory);
    const saved = (await store.read(connection.id))!;
    const value = saved.value as {
      attempt: { createdAt: number; expiresAt: number; [key: string]: unknown };
    };
    if (kind === 'expired') {
      value.attempt.createdAt -= 20 * 60_000;
      value.attempt.expiresAt -= 20 * 60_000;
      await store.commit(saved.id, saved.revision, value);
    } else if (kind === 'claimed') {
      const { configKey, connectionId, generation, scopes, pod, client } =
        value.attempt;
      await store.commit(saved.id, saved.revision, {
        version: 1,
        kind: 'claimed',
        operation: 'code',
        subject: null,
        binding: { configKey, connectionId, generation, scopes, pod, client },
      });
    }
    const before = await store.read(saved.id);
    const next = createBrowserRuntime(f.options);
    runtimes.push(next);
    await next.initialize();
    expect(next.getSnapshot()[0]?.session).toEqual({
      kind: 'ended',
      problem: kind === 'expired' ? 'expired' : 'interrupted',
    });
    expect(await store.read(saved.id)).toEqual(before);
    expect(f.count('/token')).toBe(0);
    await next.disconnect(saved.id);
    expect((await store.read(saved.id))?.value).toMatchObject({
      kind: 'disconnected',
    });
    expect(JSON.stringify((await store.read(saved.id))?.value)).not.toContain(
      'verifier',
    );
    store.close();
  },
);

it.each(['missing', 'empty', 'foreign', 'valid'] as const)(
  'carries announced issuer checking across persistence: %s callback',
  async (issuer) => {
    const f = fixture();
    runtimes.push(f.runtime);
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (!url.endsWith('/.well-known/oauth-authorization-server'))
        return response;
      return Response.json({
        ...(await response.json()),
        authorization_response_iss_parameter_supported: true,
      });
    });
    const { connection, authorization } = await f.begin();
    f.runtime.dispose();
    await settleLease();
    const returned = new URL(callback);
    returned.searchParams.set(
      'state',
      authorization.searchParams.get('state')!,
    );
    returned.searchParams.set('code', 'fixture');
    if (issuer !== 'missing')
      returned.searchParams.set(
        'iss',
        issuer === 'valid'
          ? pod
          : issuer === 'empty'
            ? ''
            : 'https://foreign.example',
      );
    const next = createBrowserRuntime({
      ...f.options,
      location: () => returned.href,
    });
    runtimes.push(next);
    const report = await next.initialize();
    if (issuer === 'valid') {
      expect(report.interaction).toBe('completed');
      expect(f.count('/token')).toBe(1);
    } else {
      expect(report).toMatchObject({
        interaction: 'failed',
        problem: 'callback',
      });
      expect(f.count('/token')).toBe(0);
      const store = await openSessionStore(dynamicNamespace, f.factory);
      expect((await store.read(connection.id))?.value).toMatchObject({
        kind: 'authorizing',
      });
      store.close();
    }
  },
);
it('restores did:web sessions with changed scope policy and identity property order', async () => {
  const f = fixture({
    identity: {
      kind: 'did-web',
      clientId: 'did:web:app.example',
      redirectUri: callback,
    },
    scopes: { optional: ['tasks'] },
  });
  runtimes.push(f.runtime);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ client_id: 'did:web:app.example', scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'one',
    }),
  );
  const result = await f.login();
  runtimes.push(result.runtime);
  const next = await reload(
    { ...f, ...result },
    {
      identity: {
        redirectUri: callback,
        clientId: 'did:web:app.example',
        kind: 'did-web',
      },
      scopes: { required: ['tasks', 'ai'] },
    },
  );
  expect(next.getSnapshot()[0]).toMatchObject({
    id: result.id,
    session: { kind: 'active' },
    grantedScopes: ['tasks'],
    missingRequiredScopes: ['ai'],
  });
  expect(f.count('/register')).toBe(0);
});

it.each(['network', 'cancelled'] as const)(
  'retains client transport %s facts after client merge',
  (problem) => {
    const error = new SdkError(
      { code: 'transport', problem },
      'hidden diagnostic',
    );
    expect(runtimeProblem(error)).toBe(problem);
    expect(runtimeFailure(error)).toEqual({
      failure: { code: 'transport', problem },
    });
  },
);

it.each(['resume', 'fail', 'disconnect', 'dispose'] as const)(
  'finishes a healthy callback independently of another held Pod restore (%s)',
  async (outcome) => {
    const f = await logged();
    const secondPod = 'https://pod.example/bob';
    const second = await f.runtime.connect(secondPod);
    await f.runtime.beginAuthorization(second.id);
    const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
    f.runtime.dispose();
    await settleLease();
    const held = deferred<Response>();
    const original = f.fetch.getMockImplementation()!;
    const firstMetadata = pod + '/.well-known/oauth-protected-resource';
    let restoreSignal: AbortSignal | undefined;
    f.fetch.mockImplementation((url, init) => {
      if (url === firstMetadata) {
        restoreSignal = init?.signal ?? undefined;
        return held.promise;
      }
      return original(url, init);
    });
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ iss: secondPod }),
        token_type: 'Bearer',
        refresh_token: 'bob',
      }),
    );
    const next = f.returned(authorization);
    runtimes.push(next);
    let report: Awaited<ReturnType<BrowserRuntime['initialize']>> | undefined;
    const startup = next.initialize().then((value) => {
      report = value;
      return value;
    });
    try {
      // This assertion must pass while the other Pod's discovery is still held.
      await vi.waitFor(() =>
        expect(report).toMatchObject({
          interaction: 'completed',
          storage: 'durable',
        }),
      );
      expect(await startup).toBe(report);
      expect(f.count('/token')).toBe(2);
      expect(
        next.getSnapshot().find((c) => c.id === second.id)?.session.kind,
      ).toBe('active');
      expect(next.getSnapshot().find((c) => c.id === f.id)?.session.kind).toBe(
        'restoring',
      );
      expect(f.replaceUrl).toHaveBeenLastCalledWith('/');
      await expect(next.loadContexts(f.id)).rejects.toMatchObject({
        problem: 'disconnected',
      });
      if (outcome === 'disconnect') await next.disconnect(f.id);
      if (outcome === 'dispose') next.dispose();
      if (outcome === 'disconnect' || outcome === 'dispose')
        expect(restoreSignal?.aborted).toBe(true);
      if (outcome === 'fail') held.reject(new TypeError('offline'));
      else held.resolve(await original(firstMetadata));
      if (outcome === 'resume' || outcome === 'fail') {
        await vi.waitFor(() =>
          expect(
            next.getSnapshot().find((c) => c.id === f.id)?.session,
          ).toMatchObject(
            outcome === 'resume'
              ? { kind: 'active' }
              : { kind: 'ended', problem: 'network' },
          ),
        );
        expect(
          next.getSnapshot().find((c) => c.id === second.id)?.session.kind,
        ).toBe('active');
      } else {
        // A same-store read yields past the ignored network answer and any install microtasks.
        const store = await openSessionStore(dynamicNamespace, f.factory);
        await store.read(f.id);
        store.close();
        expect(next.getSnapshot().some((c) => c.id === f.id)).toBe(false);
      }
    } finally {
      held.resolve(await original(firstMetadata));
    }
  },
);

it.each([
  'authorize',
  'authorize-offline',
  'disconnect',
  'disconnect-storage',
] as const)(
  'publishes all required scopes as missing when grants are cleared: %s',
  async (mode) => {
    const f = fixture({ scopes: { required: ['tasks'], optional: ['ai'] } });
    runtimes.push(f.runtime);
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ scope: 'tasks ai' }),
        token_type: 'Bearer',
        refresh_token: 'refresh-private',
        scope: 'tasks ai',
      }),
    );
    const login = await f.login();
    runtimes.push(login.runtime);
    expect(login.runtime.getSnapshot()[0]).toMatchObject({
      grantedScopes: ['tasks', 'ai'],
      missingRequiredScopes: [],
    });
    if (mode === 'authorize-offline') {
      f.fetch.mockRejectedValue(new TypeError('offline'));
    }
    if (mode === 'disconnect-storage') {
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
        throw new Error('disk failed');
      });
    }
    const snapshots: ReturnType<BrowserRuntime['getSnapshot']>[] = [];
    login.runtime.subscribe(() => snapshots.push(login.runtime.getSnapshot()));
    const operation = mode.startsWith('authorize')
      ? login.runtime.beginAuthorization(login.id)
      : login.runtime.disconnect(login.id);
    // Capture before awaiting I/O, but settle the operation before asserting.
    const immediate = snapshots[0]?.[0];
    if (mode === 'authorize-offline') {
      await expect(operation).rejects.toBeDefined();
      // A failed preparation resets nothing: grants and session stay.
      expect(snapshots).toEqual([]);
      expect(login.runtime.getSnapshot()[0]).toMatchObject({
        session: { kind: 'active' },
        grantedScopes: ['tasks', 'ai'],
      });
      return;
    }
    if (mode === 'authorize') {
      await operation;
      // Only the stored attempt resets the session, and then completely.
      expect(snapshots.length).toBeGreaterThan(0);
    } else if (mode.startsWith('disconnect')) {
      await expect(operation).resolves.toEqual({
        kind: mode === 'disconnect' ? 'disconnected' : 'blocked-locally',
      });
    }
    if (mode !== 'authorize')
      expect(immediate).toMatchObject({
        grantedScopes: [],
        missingRequiredScopes: ['tasks'],
      });
    for (const snapshot of snapshots) {
      for (const connection of snapshot) {
        expect(connection.grantedScopes).toEqual([]);
        expect(connection.missingRequiredScopes).toEqual(['tasks']);
      }
    }
    expect(await login.view.sparql.construct(query)).toEqual({
      kind: 'invalidated',
    });
  },
);

function throwingSubscriber(runtime: BrowserRuntime, when = () => true) {
  const error = new Error('consumer listener failed');
  const reported: unknown[] = [];
  const schedule = globalThis.queueMicrotask;
  // Preserve real microtask timing; intercept only this test's expected host error.
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    schedule(() => {
      try {
        callback();
      } catch (cause) {
        if (cause !== error) throw cause;
        reported.push(cause);
      }
    });
  });
  runtime.subscribe(() => {
    if (when()) throw error;
  });
  const laterListener = vi.fn();
  runtime.subscribe(laterListener);
  return { reported, laterListener };
}

it('persists disconnect and keeps notifying other listeners when a subscriber throws', async () => {
  const f = await logged();
  const { reported, laterListener } = throwingSubscriber(f.runtime);
  await expect(f.runtime.disconnect(f.id)).resolves.toEqual({
    kind: 'disconnected',
  });
  expect(laterListener).toHaveBeenCalled();
  expect(reported.length).toBe(laterListener.mock.calls.length);
  const store = await openSessionStore(dynamicNamespace, f.factory);
  expect((await store.read(f.id))?.value).toMatchObject({
    kind: 'disconnected',
  });
  store.close();
  expect((await reload(f)).getSnapshot()).toEqual([]);
});

it('keeps a completed callback and its durable session when a subscriber throws', async () => {
  const f = fixture();
  runtimes.push(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  runtimes.push(runtime);
  const { reported, laterListener } = throwingSubscriber(runtime, () =>
    runtime.getSnapshot().some((c) => c.session.kind === 'active'),
  );
  await expect(runtime.initialize()).resolves.toMatchObject({
    interaction: 'completed',
  });
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(reported).toHaveLength(1);
  expect(laterListener).toHaveBeenCalled();
  const store = await openSessionStore(dynamicNamespace, f.factory);
  expect((await store.read(connection.id))?.value).toMatchObject({
    kind: 'ready',
  });
  store.close();
  runtime.dispose();
  await settleLease();
  const resumed = createBrowserRuntime(f.options);
  runtimes.push(resumed);
  await resumed.initialize();
  await restored(resumed);
  expect(resumed.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.count('/token')).toBe(1);
});

it('preserves successful renewal and its accepted replacement when a subscriber throws', async () => {
  const f = await logged();
  const { reported, laterListener } = throwingSubscriber(f.runtime);
  let calls = 0;
  f.setQuery(async () =>
    ++calls === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : Response.json([{ '@id': 'urn:renewed' }]),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
      token_type: 'Bearer',
      refresh_token: 'replacement-private',
    }),
  );
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'ok',
    body: [{ '@id': 'urn:renewed' }],
  });
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(reported.length).toBeGreaterThan(0);
  expect(reported.length).toBe(laterListener.mock.calls.length);
  const store = await openSessionStore(dynamicNamespace, f.factory);
  expect((await store.read(f.id))?.value).toMatchObject({ kind: 'ready' });
  store.close();
  expect((await reload(f)).getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.count('/token')).toBe(2);
});
