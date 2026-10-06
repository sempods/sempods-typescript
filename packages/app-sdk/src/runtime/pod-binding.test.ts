import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import { createAppController } from '../authoring/app.js';
import { RuntimeError } from './errors.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import {
  fixture,
  deferred,
  settleLease,
  restored,
  catalogue,
  jwt,
  pod,
  work,
  personal,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));
const query = 'CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }';
const answer = () => Response.json([{ '@id': 'urn:item' }]);
const unauthorized = () =>
  new Response(null, {
    status: 401,
    headers: { 'www-authenticate': 'Bearer' },
  });

it('reads and aborts the actual request without AbortSignal.any', async () => {
  const native = Object.getOwnPropertyDescriptor(AbortSignal, 'any')!;
  Object.defineProperty(AbortSignal, 'any', { value: undefined });
  try {
    const f = await signedIn();
    expect(await f.reader.sparql.construct(query)).toMatchObject({
      kind: 'ok',
    });
    const gate = deferred<Response>();
    let signal: AbortSignal | undefined;
    f.setQuery(async (_url, init) => {
      signal = init?.signal ?? undefined;
      return gate.promise;
    });
    const caller = new AbortController();
    const read = f.reader.sparql.construct(query, { signal: caller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined());
    caller.abort();
    expect(await read).toEqual({ kind: 'cancelled' });
    expect(signal?.aborted).toBe(true);
    gate.resolve(answer());
  } finally {
    Object.defineProperty(AbortSignal, 'any', native);
  }
});

it.each([new TypeError('factory defect'), new RuntimeError('configuration')])(
  'keeps unexpected binding errors visible to the controller: %s',
  async (error) => {
    const f = await signedIn();
    const binding = vi.spyOn(f.runtime, 'bindPod').mockImplementation(() => {
      throw error;
    });
    const app = createAppController(f.runtime);
    try {
      expect(() => app.start()).toThrow(error);
    } finally {
      app.stop();
      binding.mockRestore();
    }
  },
);
async function signedIn(
  options: Partial<BrowserRuntimeOptions> = {},
  scopes = '',
) {
  const f = fixture({ preferences: null, ...options });
  runtimes.push(f.runtime);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: scopes }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  runtimes.push(runtime);
  expect(await runtime.initialize()).toMatchObject({
    interaction: 'completed',
  });
  return {
    ...f,
    runtime,
    id: connection.id,
    reader: runtime.bindPod(connection.id),
  };
}

it('binds and queries without any catalogue or Context, over the same guarded protocol client', async () => {
  const f = await signedIn();
  expect(f.runtime.getSnapshot()[0]).toMatchObject({
    selectedContext: null,
    catalogue: { kind: 'unknown' },
  });
  expect(f.runtime.bindPod(f.id)).toBe(f.reader);
  expect(f.reader.getSnapshot()).toMatchObject({ current: true, read: true });
  expect(Object.keys(f.reader).sort()).toEqual([
    'getSnapshot',
    'key',
    'podUrl',
    'sparql',
    'subscribe',
  ]);
  const before = f.fetch.mock.calls.length;
  expect(await f.reader.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  f.setQuery(
    async () =>
      new Response(
        JSON.stringify({
          head: { vars: ['x'] },
          results: { bindings: [{ x: { type: 'uri', value: 'urn:x' } }] },
        }),
        { headers: { 'content-type': 'application/sparql-results+json' } },
      ),
  );
  expect(
    await f.reader.sparql.select('SELECT ?x WHERE { ?x ?p ?o }'),
  ).toMatchObject({
    kind: 'ok',
    body: { variables: ['x'], rows: [{ x: { type: 'iri', value: 'urn:x' } }] },
  });
  const calls = f.fetch.mock.calls.slice(before);
  expect(calls).toHaveLength(2);
  for (const [url, init] of calls) {
    expect(url).toBe(pod + '/_system/sparql/query');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer /);
  }
  expect(f.count('/_system/contexts')).toBe(0);
});

it('keeps pending reads, cached handle and snapshot through two Context switches and label changes', async () => {
  const f = await signedIn();
  await f.runtime.loadContexts(f.id);
  f.runtime.selectContext(f.id, work);
  const gate = deferred<Response>();
  f.setQuery(() => gate.promise);
  const snapshot = f.reader.getSnapshot();
  const listener = vi.fn();
  const unsubscribe = f.reader.subscribe(listener);
  const read = f.reader.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/_system/sparql/query')).toBe(1));
  f.runtime.selectContext(f.id, personal);
  f.runtime.selectContext(f.id, work);
  await f.runtime.loadContexts(f.id);
  expect(f.runtime.bindPod(f.id)).toBe(f.reader);
  expect(f.reader.getSnapshot()).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  gate.resolve(answer());
  expect(await read).toMatchObject({ kind: 'ok' });
  expect(f.count('/_system/sparql/query')).toBe(1);
  unsubscribe();
});

it.each(['read-loss', 'write-loss', 'empty', 'failed', 'offline'] as const)(
  'keeps Pod reads eligible through catalogue %s',
  async (mode) => {
    const f = await signedIn();
    await f.runtime.loadContexts(f.id);
    f.runtime.selectContext(f.id, work);
    const view = f.runtime.bind(f.id);
    const gate = deferred<Response>();
    f.setQuery(() => gate.promise);
    const read = f.reader.sparql.construct(query);
    await vi.waitFor(() => expect(f.count('/_system/sparql/query')).toBe(1));
    f.setCatalogue(async () => {
      if (mode === 'offline') throw new TypeError('offline');
      if (mode === 'failed') return new Response(null, { status: 403 });
      return catalogue(
        mode === 'read-loss'
          ? [personal]
          : mode === 'empty'
            ? []
            : [work, personal],
        [],
      );
    });
    await f.runtime.loadContexts(f.id).catch(() => {});
    if (mode === 'read-loss' || mode === 'empty')
      expect(view.getSnapshot().read).toBe(false);
    expect(f.reader.getSnapshot().read).toBe(true);
    gate.resolve(answer());
    expect(await read).toMatchObject({ kind: 'ok' });
  },
);

it.each([
  'disconnect',
  'dispose',
  'authorize',
  'expired',
  'subject-change',
] as const)(
  'invalidates pending reads and retires handles on %s',
  async (mode) => {
    const f = await signedIn();
    const gate = deferred<Response>();
    let calls = 0;
    let signal: AbortSignal | undefined;
    f.setQuery(async (_url, init) => {
      calls++;
      if (calls === 1) {
        signal = init?.signal ?? undefined;
        return gate.promise;
      }
      return unauthorized();
    });
    const read = f.reader.sparql.construct(query);
    await vi.waitFor(() => expect(calls).toBe(1));
    if (mode === 'disconnect') await f.runtime.disconnect(f.id);
    else if (mode === 'dispose') f.runtime.dispose();
    else if (mode === 'authorize') await f.runtime.beginAuthorization(f.id);
    else {
      f.setToken(async () =>
        mode === 'expired'
          ? new Response(null, { status: 400 })
          : Response.json({
              access_token: jwt({ sub: 'urn:another-person' }),
              token_type: 'Bearer',
              refresh_token: 'changed',
            }),
      );
      await f.reader.sparql.construct(query);
    }
    expect(await read).toEqual({ kind: 'invalidated' });
    expect(signal?.aborted).toBe(true);
    expect(f.reader.getSnapshot()).toMatchObject({
      current: false,
      read: false,
    });
    expect(await f.reader.sparql.construct(query)).toEqual({
      kind: 'invalidated',
    });
    gate.resolve(answer());
    expect(() => f.runtime.bindPod(f.id)).toThrow();
  },
);

it('does not revive an old handle after reauthorization in the same connection', async () => {
  const f = await signedIn();
  await f.runtime.beginAuthorization(f.id);
  f.runtime.dispose();
  await settleLease();
  const next = f.returned();
  runtimes.push(next);
  expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
  const reader = next.bindPod(f.id);
  expect(reader.key).not.toBe(f.reader.key);
  expect(f.reader.getSnapshot().current).toBe(false);
  expect(await reader.sparql.construct(query)).toMatchObject({ kind: 'ok' });
});

it('allows a current unreadable handle with missing required scopes, without dispatch', async () => {
  const f = await signedIn({ scopes: { required: ['tasks'] } });
  expect(f.reader.getSnapshot()).toMatchObject({ current: true, read: false });
  const before = f.fetch.mock.calls.length;
  expect(await f.reader.sparql.construct(query)).toEqual({
    kind: 'invalidated',
  });
  expect(await f.reader.sparql.select('SELECT * WHERE {}')).toEqual({
    kind: 'invalidated',
  });
  expect(f.fetch.mock.calls).toHaveLength(before);
  // Reauthorization is explicit; a new generation with the required grant works.
  await f.runtime.beginAuthorization(f.id);
  f.runtime.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'new',
    }),
  );
  const next = f.returned();
  runtimes.push(next);
  await next.initialize();
  expect(next.bindPod(f.id).getSnapshot().read).toBe(true);
});

it.each(['same', 'optional-loss', 'required-loss'] as const)(
  'handles credential renewal with %s scopes and guards the resend',
  async (mode) => {
    const f = await signedIn(
      { scopes: { required: ['tasks'], optional: ['ai'] } },
      'tasks ai',
    );
    const oldSnapshot = f.reader.getSnapshot();
    const listener = vi.fn();
    f.reader.subscribe(listener);
    const gate = deferred<Response>();
    let calls = 0;
    f.setQuery(async () =>
      ++calls === 1 ? gate.promise : calls === 2 ? unauthorized() : answer(),
    );
    const pending = f.reader.sparql.construct(query);
    await vi.waitFor(() => expect(calls).toBe(1));
    f.setToken(async () =>
      Response.json({
        access_token: jwt({
          scope:
            mode === 'same'
              ? 'ai tasks'
              : mode === 'optional-loss'
                ? 'tasks'
                : '',
        }),
        token_type: 'Bearer',
        refresh_token: 'rotated',
      }),
    );
    const renewed = await f.reader.sparql.construct(query);
    gate.resolve(answer());
    if (mode === 'same') {
      expect(renewed.kind).toBe('ok');
      expect((await pending).kind).toBe('ok');
      expect(f.reader.getSnapshot()).toBe(oldSnapshot);
      expect(listener).not.toHaveBeenCalled();
      expect(calls).toBe(3);
    } else {
      expect(renewed).toEqual({ kind: 'invalidated' });
      expect(await pending).toEqual({ kind: 'invalidated' });
      expect(f.reader.getSnapshot().revision).toBeGreaterThan(
        oldSnapshot.revision,
      );
      expect(f.reader.getSnapshot().read).toBe(mode === 'optional-loss');
      expect(listener).toHaveBeenCalledTimes(1);
      // The lifetime abort blocks resending either changed-scope request.
      expect(calls).toBe(2);
    }
    expect(f.runtime.bindPod(f.id)).toBe(f.reader);
    expect(f.count('/token')).toBe(2);
  },
);

it('preserves bounded 401 refusal and Pod 403 without catalogue requests or session mutation', async () => {
  const f = await signedIn();
  f.setQuery(async () => unauthorized());
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 7200 }),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  expect(await f.reader.sparql.construct(query)).toEqual({
    kind: 'refused',
    status: 401,
  });
  expect(f.count('/_system/sparql/query')).toBe(2);
  const before = f.runtime.getSnapshot()[0];
  f.setQuery(async () => new Response(null, { status: 403 }));
  const calls = f.fetch.mock.calls.length;
  expect(await f.reader.sparql.construct(query)).toEqual({
    kind: 'refused',
    status: 403,
  });
  expect(f.fetch.mock.calls).toHaveLength(calls + 1);
  expect(f.runtime.getSnapshot()[0]).toBe(before);
  expect(f.count('/_system/contexts')).toBe(0);
});

it('cancels only the caller and prevents an already aborted call from dispatching', async () => {
  const f = await signedIn();
  const gate = deferred<void>();
  f.setQuery(async () => {
    await gate.promise;
    return answer();
  });
  const controller = new AbortController();
  const cancelled = f.reader.sparql.construct(query, {
    signal: controller.signal,
  });
  const kept = f.reader.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/_system/sparql/query')).toBe(2));
  controller.abort();
  expect(await cancelled).toEqual({ kind: 'cancelled' });
  expect(
    await f.reader.sparql.construct(query, { signal: controller.signal }),
  ).toEqual({ kind: 'cancelled' });
  gate.resolve();
  expect((await kept).kind).toBe('ok');
  expect(f.count('/_system/sparql/query')).toBe(2);
});

it('rejects excluded stored connections before binding or sending credentials', async () => {
  const f = await signedIn();
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    allowedPods: ['https://other.example/pod'],
  });
  runtimes.push(next);
  const before = f.fetch.mock.calls.length;
  await next.initialize();
  expect(() => next.bindPod(f.id)).toThrow();
  expect(f.fetch.mock.calls).toHaveLength(before);
});

it('exposes the active Pod in AppSnapshot, including unresolved startup and Pod switches', async () => {
  const f = await signedIn();
  const secondPod = 'https://pod.example/bob';
  const second = await f.runtime.connect(secondPod);
  await f.runtime.beginAuthorization(second.id);
  f.runtime.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ iss: secondPod }),
      token_type: 'Bearer',
      refresh_token: 'bob',
    }),
  );
  const next = f.returned();
  runtimes.push(next);
  const app = createAppController(next);
  expect(app.getSnapshot().pod).toBeNull();
  app.start();
  await vi.waitFor(() => expect(app.getSnapshot().pod?.podUrl).toBe(secondPod));
  const bob = app.getSnapshot().pod;
  await restored(next);
  await app.selectConnection(f.id);
  expect(app.getSnapshot().pod?.podUrl).toBe(pod);
  expect(app.getSnapshot().pod).toBe(next.bindPod(f.id));
  expect(app.getSnapshot().pod).not.toBe(bob);
  // Active selection changes the exposed reader, without retiring another connection's reader.
  expect(bob?.getSnapshot().current).toBe(true);
  app.stop();
});

it('prevents initial dispatch while waiting on a renewal that loses a required scope', async () => {
  const f = await signedIn({ scopes: { required: ['tasks'] } }, 'tasks');
  const gate = deferred<Response>();
  f.setToken(() => gate.promise);
  f.setQuery(async () => unauthorized());
  const first = f.reader.sparql.construct(query);
  await vi.waitFor(() => expect(f.count('/token')).toBe(2));
  const waiting = f.reader.sparql.construct(query);
  // This caller is queued in the shared credential owner, not sent with the old token.
  expect(f.count('/_system/sparql/query')).toBe(1);
  gate.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  expect(await first).toEqual({ kind: 'invalidated' });
  expect(await waiting).toEqual({ kind: 'invalidated' });
  expect(f.count('/_system/sparql/query')).toBe(1);
  expect(f.reader.getSnapshot().read).toBe(false);
});
