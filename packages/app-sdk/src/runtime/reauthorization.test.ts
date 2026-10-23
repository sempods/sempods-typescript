/**
 * Re-authorization outcomes (#98): a denied or abandoned attempt resumes the
 * session it started from when that session is still valid; every other
 * outcome ends the connection, and a successful grant replaces the old one.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import { createBrowserRuntime } from './runtime.js';
import { openSessionStore } from '../sessions/store.js';
import type { BrowserRuntime } from './types.js';
import {
  callback,
  catalogue,
  deferred,
  fixture,
  jwt,
  restored,
  settleLease,
  unauthorized,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const namespace = JSON.stringify(['dynamic', callback]);
const me = 'https://person.example/#me';
const keep = (runtime: BrowserRuntime) => {
  runtimes.push(runtime);
  return runtime;
};

/** Signed in, then re-authorizing: the page has left for the provider. */
async function reauthorizing(
  f = fixture({ scopes: { required: ['tasks'], optional: ['share'] } }),
) {
  keep(f.runtime);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'first-refresh',
      scope: 'tasks',
    }),
  );
  const { runtime, id } = await f.login();
  keep(runtime);
  await runtime.beginAuthorization(id);
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  runtime.dispose();
  await settleLease();
  return { f, id, authorization, tokens: f.count('/token') };
}
function denial(
  f: ReturnType<typeof fixture>,
  authorization: URL,
  error = 'access_denied',
) {
  return keep(f.returned(authorization, `error=${error}`));
}
async function stored(f: ReturnType<typeof fixture>, id: string) {
  const store = await openSessionStore(namespace, f.factory);
  try {
    return (await store.read(id))?.value as Record<string, unknown>;
  } finally {
    store.close();
  }
}
/** A fresh start without a callback, as after a reload. */
async function reload(f: ReturnType<typeof fixture>) {
  await settleLease();
  const next = keep(createBrowserRuntime(f.options));
  await next.initialize();
  await restored(next);
  return next;
}

it('keeps the earlier session beside the stored attempt', async () => {
  const { f, id } = await reauthorizing();
  expect(await stored(f, id)).toMatchObject({
    kind: 'authorizing',
    previous: {
      binding: { connectionId: id, scopes: ['tasks', 'share'] },
      credentials: { subject: me, scopes: ['tasks'] },
    },
  });
});

it('resumes the earlier session after a matched denial, without a token request', async () => {
  const { f, id, authorization, tokens } = await reauthorizing();
  const next = denial(f, authorization);
  expect(await next.initialize()).toMatchObject({
    interaction: 'cancelled',
    problem: 'denied',
    attemptConnectionId: id,
    resumed: true,
  });
  expect(f.count('/token')).toBe(tokens);
  expect(next.getSnapshot()[0]).toMatchObject({
    session: { kind: 'active', subject: me },
    grantedScopes: ['tasks'],
    missingRequiredScopes: [],
  });
  expect(f.replaceUrl).toHaveBeenLastCalledWith('/');
  await next.loadContexts(id);
  next.selectContext(id, work);
  expect(await next.bind(id).subjects.get('urn:item')).toMatchObject({
    kind: 'ok',
  });
  expect(await stored(f, id)).toMatchObject({ kind: 'ready' });
  expect(await stored(f, id)).not.toHaveProperty('previous');
  // A reload restores it like any saved session.
  next.dispose();
  const after = await reload(f);
  expect(after.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: me,
  });
});

it('refuses a replayed denial after resuming, and keeps the session', async () => {
  const { f, id, authorization } = await reauthorizing();
  const first = denial(f, authorization);
  await first.initialize();
  first.dispose();
  await settleLease();
  const replay = denial(f, authorization);
  expect(await replay.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(replay.getSnapshot()[0]?.session).toMatchObject({
    kind: 'restoring',
  });
  await restored(replay);
  expect(replay.getSnapshot()[0]).toMatchObject({
    id,
    session: { kind: 'active', subject: me },
  });
});

it('leaves the attempt intact for a forged callback; the real denial still resumes', async () => {
  const { f, id, authorization } = await reauthorizing();
  const forged = keep(
    f.returned(authorization, 'error=access_denied&iss=https%3A%2F%2Fevil'),
  );
  expect(await forged.initialize()).toMatchObject({
    interaction: 'failed',
    attemptConnectionId: id,
  });
  expect(forged.getSnapshot()[0]?.session.kind).toBe('ended');
  expect(await stored(f, id)).toMatchObject({ kind: 'authorizing' });
  forged.dispose();
  await settleLease();
  const real = denial(f, authorization);
  expect(await real.initialize()).toMatchObject({ resumed: true });
});

it.each(['wrong', 'missing', 'duplicated'] as const)(
  'leaves a pending re-authorization for a callback with a %s state',
  async (problem) => {
    const { f, id, authorization } = await reauthorizing();
    const state = authorization.searchParams.get('state')!;
    const answer = {
      wrong: `code=fixture-code&state=${'x'.repeat(43)}`,
      missing: 'code=fixture-code',
      duplicated: `code=fixture-code&state=${state}&state=${state}`,
    }[problem];
    const stray = keep(
      createBrowserRuntime({
        ...f.options,
        location: () => `${callback}?${answer}`,
      }),
    );
    expect(await stray.initialize()).toMatchObject({
      interaction: 'failed',
      problem: 'attempt',
    });
    expect(await stored(f, id)).toMatchObject({ kind: 'authorizing' });
    stray.dispose();
    await settleLease();
    // The real callback still redeems its code.
    const real = keep(f.returned(authorization));
    expect(await real.initialize()).toMatchObject({
      interaction: 'completed',
      connectionId: id,
    });
  },
);

it('keeps a first sign-in denial signed out', async () => {
  const f = fixture();
  keep(f.runtime);
  const { authorization, connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const next = denial(f, authorization);
  const report = await next.initialize();
  expect(report).toMatchObject({
    interaction: 'cancelled',
    problem: 'denied',
    attemptConnectionId: connection.id,
  });
  expect(report).not.toHaveProperty('resumed');
  expect(next.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'denied',
  });
});

it('ends the connection for another provider answer during re-authorization', async () => {
  const { f, id, authorization } = await reauthorizing();
  const next = denial(f, authorization, 'login_required');
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'login-required',
  });
  expect(next.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'login-required',
  });
  await vi.waitFor(async () =>
    expect(await stored(f, id)).toMatchObject({ kind: 'disconnected' }),
  );
  next.dispose();
  expect((await reload(f)).getSnapshot()).toEqual([]);
});

it('ends the connection when the earlier credential expired without a refresh token', async () => {
  const f = fixture();
  keep(f.runtime);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 120 }),
      token_type: 'Bearer',
    }),
  );
  const { runtime, id } = await f.login();
  keep(runtime);
  await runtime.beginAuthorization(id);
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  runtime.dispose();
  await settleLease();
  const later = Date.now() + 5 * 60_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  // Abandoned: shown as interrupted, nothing resumed.
  const back = keep(createBrowserRuntime(f.options));
  await back.initialize();
  await vi.waitFor(() =>
    expect(back.getSnapshot()[0]?.session).toEqual({
      kind: 'ended',
      problem: 'interrupted',
    }),
  );
  back.dispose();
  await settleLease();
  // Denied: ends as for a first sign-in.
  const next = denial(f, authorization);
  const report = await next.initialize();
  expect(report).toMatchObject({ interaction: 'cancelled' });
  expect(report).not.toHaveProperty('resumed');
  expect(next.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'denied',
  });
});

it('resumes an earlier session that expired while away, then renews it', async () => {
  const { f, id, authorization } = await reauthorizing();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 3600_000);
  f.setToken(async () =>
    Response.json({
      access_token: jwt({
        scope: 'tasks',
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      }),
      token_type: 'Bearer',
      refresh_token: 'second-refresh',
      scope: 'tasks',
    }),
  );
  const next = denial(f, authorization);
  expect(await next.initialize()).toMatchObject({ resumed: true });
  const reads = next.bindPod(id);
  await reads.sparql.construct('CONSTRUCT {} WHERE {}');
  await vi.waitFor(async () =>
    expect(await stored(f, id)).toMatchObject({
      kind: 'ready',
      credentials: { refreshToken: 'second-refresh' },
    }),
  );
  expect(next.getSnapshot()[0]?.session.kind).toBe('active');
});

it('replaces the earlier grant with a narrower successful one, never merging', async () => {
  const { f, id, authorization } = await reauthorizing(
    fixture({ scopes: { optional: ['tasks', 'share'] } }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: '' }),
      token_type: 'Bearer',
      refresh_token: 'narrow',
    }),
  );
  const next = keep(f.returned(authorization));
  expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
  expect(next.getSnapshot()[0]?.grantedScopes).toEqual([]);
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    credentials: { scopes: [], refreshToken: 'narrow' },
  });
  expect(await stored(f, id)).not.toHaveProperty('previous');
  next.dispose();
  expect((await reload(f)).getSnapshot()[0]?.grantedScopes).toEqual([]);
});

it('signs in the other account a successful re-authorization returns', async () => {
  const { f, authorization } = await reauthorizing();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ sub: 'urn:another-person', scope: 'tasks' }),
      token_type: 'Bearer',
      refresh_token: 'other',
      scope: 'tasks',
    }),
  );
  const next = keep(f.returned(authorization));
  expect(await next.initialize()).toMatchObject({ interaction: 'completed' });
  expect(next.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: 'urn:another-person',
  });
});

it('ends the connection when the token answer is lost; the old one never returns', async () => {
  const { f, id, authorization } = await reauthorizing();
  f.setToken(async () => {
    throw new TypeError('lost response');
  });
  const next = keep(f.returned(authorization));
  expect(await next.initialize()).toMatchObject({ interaction: 'failed' });
  expect(next.getSnapshot()[0]?.session.kind).toBe('ended');
  expect(await stored(f, id)).toMatchObject({ kind: 'disconnected' });
  next.dispose();
  expect((await reload(f)).getSnapshot()).toEqual([]);
});

it('resumes the earlier session when the person comes back without a callback', async () => {
  const { f, id, tokens } = await reauthorizing();
  // Also once the attempt itself expired.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60_000);
  const back = keep(createBrowserRuntime(f.options));
  expect(await back.initialize()).toMatchObject({ interaction: 'none' });
  expect(back.getSnapshot()[0]?.session.kind).toBe('restoring');
  await restored(back);
  expect(back.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: me,
  });
  expect(f.count('/token')).toBe(tokens);
  expect(await stored(f, id)).toMatchObject({ kind: 'ready' });
});

it('keeps an abandoned attempt for the next start when storage fails', async () => {
  const { f, id, authorization } = await reauthorizing();
  const put = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementation(() => {
      throw new Error('disk failed');
    });
  const failing = denial(f, authorization);
  expect(await failing.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'storage',
    attemptConnectionId: id,
  });
  expect(failing.getSnapshot()[0]?.session.kind).toBe('ended');
  put.mockRestore();
  expect(await stored(f, id)).toMatchObject({ kind: 'authorizing' });
  failing.dispose();
  // The callback was scrubbed; the next start resumes it as abandoned.
  const after = await reload(f);
  expect(after.getSnapshot()[0]?.session.kind).toBe('active');
});

it('does not resume over a record another writer changed (CAS)', async () => {
  const { f, id, authorization } = await reauthorizing();
  const original = f.fetch.getMockImplementation()!;
  const discovery = deferred<void>();
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) await discovery.promise;
    return original(url, init);
  });
  const next = denial(f, authorization);
  const report = next.initialize();
  await vi.waitFor(() =>
    expect(f.count('/.well-known/oauth-protected-resource')).toBeGreaterThan(0),
  );
  // Another writer retires the record while discovery is pending.
  const store = await openSessionStore(namespace, f.factory);
  const current = await store.read(id);
  await store.commit(id, current!.revision, {
    ...(current!.value as object),
    kind: 'disconnected',
    binding: (current!.value as { previous: { binding: unknown } }).previous
      .binding,
  });
  store.close();
  discovery.resolve();
  expect(await report).toMatchObject({ interaction: 'failed' });
  expect(next.getSnapshot()[0]?.session.kind).toBe('ended');
  expect(await stored(f, id)).toMatchObject({ kind: 'disconnected' });
});

it('does not keep a session whose refresh was claimed when re-authorization began', async () => {
  const f = fixture();
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  const held = deferred<Response>();
  f.setQuery(async () => unauthorized());
  f.setToken(() => held.promise);
  const tokens = f.count('/token');
  const read = runtime.bindPod(id).sparql.construct('CONSTRUCT {} WHERE {}');
  await vi.waitFor(() => expect(f.count('/token')).toBe(tokens + 1));
  await runtime.beginAuthorization(id);
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  expect(await stored(f, id)).not.toHaveProperty('previous');
  held.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'late',
    }),
  );
  await read;
  runtime.dispose();
  await settleLease();
  const next = denial(f, authorization);
  expect(await next.initialize()).not.toHaveProperty('resumed');
  expect(next.getSnapshot()[0]?.session.kind).toBe('ended');
});

it('does not resurrect a connection disconnected while leaving', async () => {
  const f = fixture();
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  await runtime.beginAuthorization(id);
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  expect(await runtime.disconnect(id)).toEqual({ kind: 'disconnected' });
  runtime.dispose();
  await settleLease();
  const next = denial(f, authorization);
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(next.getSnapshot()).toEqual([]);
});

it('keeps the earlier facts while leaving and resumes from the back/forward cache', async () => {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  const f = fixture();
  keep(f.runtime);
  const { runtime, id, view } = await f.login();
  keep(runtime);
  const kinds: string[] = [];
  runtime.subscribe(() =>
    kinds.push(runtime.getSnapshot()[0]?.session.kind ?? 'none'),
  );
  await runtime.beginAuthorization(id);
  // No signed-out state on the way out; nothing of the old session dispatches.
  expect(kinds).toEqual(['leaving']);
  expect(runtime.getSnapshot()[0]).toMatchObject({
    session: { kind: 'leaving', subject: me },
    selectedContext: work,
    catalogue: { kind: 'ready' },
  });
  expect(await view.subjects.get('urn:item')).toEqual({ kind: 'invalidated' });
  expect(() => runtime.bind(id)).toThrow();
  // A page shown again without being persisted is not a return.
  page.dispatchEvent(new Event('pageshow'));
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('leaving');
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
  await restored(runtime);
  expect(runtime.getSnapshot()[0]).toMatchObject({
    session: { kind: 'active', subject: me },
    selectedContext: work,
  });
  expect(await runtime.bind(id).subjects.get('urn:item')).toMatchObject({
    kind: 'ok',
  });
  // The handle of the earlier lifetime stays retired.
  expect(await view.subjects.get('urn:item')).toEqual({ kind: 'invalidated' });
  expect(await stored(f, id)).toMatchObject({ kind: 'ready' });
});

it('restarts a catalogue read the leaving page aborted when it resumes', async () => {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  const f = fixture();
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  f.setCatalogue(() => new Promise<Response>(() => {}));
  void runtime.loadContexts(id).catch(() => {});
  expect(runtime.getSnapshot()[0]?.catalogue).toMatchObject({
    kind: 'loading',
    contexts: [{ iri: work }, expect.anything()],
  });
  await runtime.beginAuthorization(id);
  f.setCatalogue(async () => catalogue([work], [work]));
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  await restored(runtime);
  await vi.waitFor(() =>
    expect(runtime.getSnapshot()[0]?.catalogue).toMatchObject({
      kind: 'ready',
      contexts: [{ iri: work }],
    }),
  );
});

it('publishes nothing from a resume that settles after dispose', async () => {
  const { f, authorization } = await reauthorizing();
  const original = f.fetch.getMockImplementation()!;
  const discovery = deferred<void>();
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) await discovery.promise;
    return original(url, init);
  });
  const next = denial(f, authorization);
  const report = next.initialize();
  await vi.waitFor(() =>
    expect(f.count('/.well-known/oauth-protected-resource')).toBeGreaterThan(0),
  );
  const seen = vi.fn();
  next.subscribe(seen);
  next.dispose();
  discovery.resolve();
  await report;
  expect(next.getSnapshot()).toEqual([]);
  expect(seen).toHaveBeenCalledTimes(1);
});
