/**
 * Re-authorization outcomes (#98, #393): the attempt is stored beside the
 * session, which keeps working. Only a validated callback replaces it; a
 * denial, any other failed callback, a return without a callback and expiry
 * leave the session as it is.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
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
  storeWith,
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

it('keeps the session beside the stored attempt', async () => {
  const { f, id } = await reauthorizing();
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    binding: { connectionId: id, scopes: ['tasks', 'share'] },
    credentials: { subject: me, scopes: ['tasks'] },
    pending: {
      kind: 'open',
      attempt: { connectionId: id, scopes: ['tasks', 'share'] },
    },
  });
});

it('keeps the session after a matched denial, without a token request', async () => {
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
  expect(await stored(f, id)).not.toHaveProperty('pending');
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
  const report = await forged.initialize();
  expect(report).toMatchObject({
    interaction: 'failed',
    problem: 'callback',
    attemptConnectionId: id,
  });
  expect(report).not.toHaveProperty('resumed');
  await restored(forged);
  expect(forged.getSnapshot()[0]?.session.kind).toBe('active');
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    pending: { kind: 'open' },
  });
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
    expect(await stored(f, id)).toMatchObject({
      kind: 'ready',
      pending: { kind: 'open' },
    });
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

it('keeps the session for another provider answer, without claiming it is unchanged', async () => {
  const { f, id, authorization, tokens } = await reauthorizing();
  const next = denial(f, authorization, 'server_error');
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'provider-unavailable',
    attemptConnectionId: id,
    resumed: true,
  });
  await restored(next);
  expect(next.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: me,
  });
  expect(f.count('/token')).toBe(tokens);
  expect(await stored(f, id)).toMatchObject({ kind: 'ready' });
  expect(await stored(f, id)).not.toHaveProperty('pending');
});

it('hands the attempt over when the session expires while away; its callback then signs in', async () => {
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
  // Back without a callback: the expired session ends, its attempt stays.
  const back = keep(createBrowserRuntime(f.options));
  await back.initialize();
  await vi.waitFor(() =>
    expect(back.getSnapshot()[0]?.session).toEqual({
      kind: 'ended',
      problem: 'expired',
    }),
  );
  await vi.waitFor(async () =>
    expect(await stored(f, id)).toMatchObject({ kind: 'authorizing' }),
  );
  back.dispose();
  await settleLease();
  // A denial then ends it as for a first sign-in.
  const next = denial(f, authorization);
  const report = await next.initialize();
  expect(report).toMatchObject({ interaction: 'cancelled' });
  expect(report).not.toHaveProperty('resumed');
  expect(next.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'denied',
  });
});

it('renews a session that expired while away; the expired attempt’s late answer changes nothing', async () => {
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
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  await restored(next);
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
  expect(await stored(f, id)).not.toHaveProperty('pending');
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

it('keeps the session when the code answer is lost, and never sends the code again', async () => {
  const { f, id, authorization } = await reauthorizing();
  f.setToken(async () => {
    throw new TypeError('lost response');
  });
  const tokens = f.count('/token');
  const next = keep(f.returned(authorization));
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    attemptConnectionId: id,
    resumed: true,
  });
  expect(f.count('/token')).toBe(tokens + 1);
  await restored(next);
  expect(next.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: me,
  });
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'first-refresh' },
  });
  expect(await stored(f, id)).not.toHaveProperty('pending');
  next.dispose();
  await settleLease();
  const replay = keep(f.returned(authorization));
  expect(await replay.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(f.count('/token')).toBe(tokens + 1);
});

it('restores the session when the person comes back without a callback', async () => {
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

it('keeps the attempt when its answer cannot be stored', async () => {
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
  put.mockRestore();
  await restored(failing);
  expect(failing.getSnapshot()[0]?.session.kind).toBe('active');
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    pending: { kind: 'open' },
  });
  failing.dispose();
  await settleLease();
  expect(await denial(f, authorization).initialize()).toMatchObject({
    resumed: true,
  });
});

it('does not complete on a record another writer changed', async () => {
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
    pending: undefined,
  });
  store.close();
  discovery.resolve();
  expect(await report).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  expect(await stored(f, id)).toMatchObject({ kind: 'disconnected' });
});

it('waits for a refresh under way, then stores the attempt beside its result', async () => {
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
  const navigations = f.navigate.mock.calls.length;
  const begun = runtime.beginAuthorization(id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(f.navigate.mock.calls.length).toBe(navigations);
  held.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'late',
    }),
  );
  await begun;
  await read;
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'late' },
    pending: { kind: 'open' },
  });
  runtime.dispose();
  await settleLease();
  const next = denial(f, authorization);
  expect(await next.initialize()).toMatchObject({ resumed: true });
  await restored(next);
  expect(next.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.count('/token')).toBe(tokens + 1);
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
  expect(next.getSnapshot()).toMatchObject([
    { id, session: { kind: 'signed-out', problem: 'disconnected' } },
  ]);
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
  // The attempt stays for its callback.
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    pending: { kind: 'open' },
  });
});

it('stays on the page when its redirect did not leave', async () => {
  const page = new EventTarget();
  vi.stubGlobal('addEventListener', page.addEventListener.bind(page));
  vi.stubGlobal('removeEventListener', page.removeEventListener.bind(page));
  const f = fixture();
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  // Not leaving: nothing to abandon.
  expect(runtime.cancelAuthorization(id)).toBe(false);
  await runtime.beginAuthorization(id);
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('leaving');
  // The browser stopped the navigation; the person stays here.
  expect(runtime.cancelAuthorization(id)).toBe(true);
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
  expect(runtime.cancelAuthorization(id)).toBe(false);
  await restored(runtime);
  expect(runtime.getSnapshot()[0]).toMatchObject({
    session: { kind: 'active', subject: me },
    selectedContext: work,
  });
  expect(await runtime.bind(id).subjects.get('urn:item')).toMatchObject({
    kind: 'ok',
  });
  expect(await stored(f, id)).toMatchObject({ kind: 'ready' });
  // A later return from the back/forward cache resumes nothing again.
  page.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  // A first sign-in that did not leave has no session to resume: it ends
  // here, also with its Pod offline, and its attempt is retired.
  const other = await runtime.connect('https://pod.example/bob');
  await runtime.beginAuthorization(other.id);
  expect(await stored(f, other.id)).toMatchObject({ kind: 'authorizing' });
  const navigation = f.navigate.mock.calls.at(-1)![1]!;
  expect(navigation.signal.aborted).toBe(false);
  f.fetch.mockRejectedValue(new TypeError('offline'));
  const requests = f.fetch.mock.calls.length;
  expect(runtime.cancelAuthorization(other.id)).toBe(true);
  // The app's own navigation is told to stop.
  expect(navigation.signal.aborted).toBe(true);
  expect(
    runtime.getSnapshot().find((c) => c.id === other.id)?.session,
  ).toMatchObject({ kind: 'ended', problem: 'interrupted' });
  await vi.waitFor(async () =>
    expect((await stored(f, other.id))?.kind).not.toBe('authorizing'),
  );
  expect(f.fetch.mock.calls.length).toBe(requests);
});

it('stops the document only for a navigation that does not cancel itself', async () => {
  const stop = vi.fn();
  vi.stubGlobal('stop', stop);
  const f = fixture();
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  await runtime.beginAuthorization(id);
  expect(runtime.cancelAuthorization(id)).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
  await restored(runtime);
  // A host-managed sign-in cancels on its signal: the page's loads go on.
  f.navigate.mockReturnValueOnce('signal');
  await runtime.beginAuthorization(id);
  const { signal } = f.navigate.mock.calls.at(-1)![1]!;
  expect(runtime.cancelAuthorization(id)).toBe(true);
  expect(signal.aborted).toBe(true);
  expect(stop).toHaveBeenCalledTimes(1);
  await restored(runtime);
  // Staying from within `navigate` waits for its answer: a host-managed one
  // that could not open its sign-in stops nothing.
  f.navigate.mockImplementationOnce((_url, options) => {
    expect(runtime.cancelAuthorization(id)).toBe(true);
    expect(options?.signal.aborted).toBe(true);
    return 'signal';
  });
  await runtime.beginAuthorization(id);
  expect(stop).toHaveBeenCalledTimes(1);
  await restored(runtime);
  // One that navigates this document is stopped once it returns.
  f.navigate.mockImplementationOnce(() => {
    runtime.cancelAuthorization(id);
    expect(stop).toHaveBeenCalledTimes(1);
  });
  await runtime.beginAuthorization(id);
  expect(stop).toHaveBeenCalledTimes(2);
  await restored(runtime);
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
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

it('publishes nothing from a callback that settles after dispose', async () => {
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

/** Rewrites the stored record as `change` makes it, as another SDK would. */
async function rewrite(
  f: ReturnType<typeof fixture>,
  id: string,
  change: (value: Record<string, unknown>) => Record<string, unknown>,
) {
  const store = await openSessionStore(namespace, f.factory);
  try {
    const current = (await store.read(id))!;
    const written = await store.commit(
      id,
      current.revision,
      change(current.value as Record<string, unknown>),
    );
    expect(written.kind).toBe('committed');
  } finally {
    store.close();
  }
}

it('restores and completes a re-authorization stored by SDK 0.6 to 0.9', async () => {
  const { f, id, authorization } = await reauthorizing();
  // SDK 0.9 kept the session as `previous` of its attempt.
  await rewrite(f, id, ({ binding, credentials, pending }) => ({
    version: 1,
    kind: 'authorizing',
    attempt: (pending as { attempt: unknown }).attempt,
    previous: { binding, credentials },
  }));
  // Back without a callback: the session restores at once.
  const back = await reload(f);
  expect(back.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: me,
  });
  back.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'tasks share' }),
      token_type: 'Bearer',
      refresh_token: 'consented',
      scope: 'tasks share',
    }),
  );
  const next = keep(f.returned(authorization));
  expect(await next.initialize()).toMatchObject({
    interaction: 'completed',
    connectionId: id,
  });
  expect(next.getSnapshot()[0]?.grantedScopes).toEqual(['tasks', 'share']);
  expect(await stored(f, id)).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'consented' },
  });
  expect(await stored(f, id)).not.toHaveProperty('previous');
});

it('keeps the session when an SDK 0.9 tab drops the pending attempt; its callback then fails', async () => {
  const { f, id, authorization, tokens } = await reauthorizing();
  // A 0.9 tab's renewal writes only what it knows.
  await rewrite(f, id, (value) => {
    const session = { ...value };
    delete session.pending;
    return session;
  });
  const next = keep(f.returned(authorization));
  const report = await next.initialize();
  expect(report).toMatchObject({ interaction: 'failed', problem: 'attempt' });
  expect(report).not.toHaveProperty('resumed');
  expect(f.count('/token')).toBe(tokens);
  await restored(next);
  expect(next.getSnapshot()[0]?.session).toEqual({
    kind: 'active',
    subject: me,
  });
});

it('leaves a newer attempt for its own callback when a replaced one answers late', async () => {
  const { f, id, authorization: first } = await reauthorizing();
  const again = await reload(f);
  await again.beginAuthorization(id, { intent: 'change-sharing' });
  const second = new URL(f.navigate.mock.calls.at(-1)![0]);
  again.dispose();
  await settleLease();
  const tokens = f.count('/token');
  const late = keep(f.returned(first));
  expect(await late.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'attempt',
  });
  late.dispose();
  await settleLease();
  // A wrong issuer for the current attempt changes nothing either.
  const forged = keep(
    f.returned(second, 'code=fixture-code&iss=https%3A%2F%2Fevil.example'),
  );
  expect(await forged.initialize()).toMatchObject({
    interaction: 'failed',
    problem: 'callback',
  });
  expect(f.count('/token')).toBe(tokens);
  forged.dispose();
  await settleLease();
  const real = keep(f.returned(second));
  expect(await real.initialize()).toMatchObject({
    interaction: 'completed',
    connectionId: id,
  });
});

it('reports no resumed session when the session expired while the person was at the Pod', async () => {
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
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000);
  const next = denial(f, authorization);
  const report = await next.initialize();
  expect(report).toMatchObject({ interaction: 'cancelled', problem: 'denied' });
  expect(report).not.toHaveProperty('resumed');
  expect(next.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'expired',
  });
});

it('reports a lock it waited too long for at its deadline, while a due session waits to restore', async () => {
  const { f, id, authorization } = await reauthorizing();
  // Another tab holds the session's refresh lock and does not let go.
  const held = deferred<void>();
  void f.options.locks!.request(
    `sempods:refresh:${namespace}:${id}`,
    {},
    () => held.promise,
  );
  // The saved credential is due, so its restoration needs that lock too.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3590_000);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const discovered = f.count('/.well-known/oauth-authorization-server');
    const next = denial(f, authorization);
    let report: Awaited<ReturnType<BrowserRuntime['initialize']>> | undefined;
    void next.initialize().then((value) => (report = value));
    // Its wait starts once its discovery answered; the deadline is 60 s.
    await vi.waitFor(() =>
      expect(f.count('/.well-known/oauth-authorization-server')).toBe(
        discovered + 1,
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(report).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() =>
      expect(report).toMatchObject({
        interaction: 'failed',
        problem: 'coordination',
      }),
    );
    expect(report).not.toHaveProperty('resumed');
  } finally {
    vi.useRealTimers();
    held.resolve();
  }
});

/**
 * A re-authorization whose callback stored the new grant and waits at that
 * commit's answer; `failing` makes later commits or one read fail.
 */
async function grantStored(failing: { commit?: boolean; read?: boolean } = {}) {
  const factory = new IDBFactory();
  const gate: { held?: ReturnType<typeof deferred<void>>; reached?: boolean } =
    {};
  const f = fixture({
    scopes: { required: ['tasks'], optional: ['share'] },
    openStore: storeWith(factory, (store) => ({
      async commit(id, revision, value) {
        if (
          failing.commit &&
          gate.reached &&
          (value as { kind?: string }).kind === 'disconnected'
        )
          throw new Error('disk full');
        const result = await store.commit(id, revision, value);
        const v = value as { kind?: string; pending?: unknown };
        if (gate.held && v.kind === 'ready' && v.pending === undefined) {
          gate.reached = true;
          await gate.held.promise;
        }
        return result;
      },
      async read(id) {
        if (failing.read && gate.reached) {
          failing.read = false;
          throw new Error('read failed');
        }
        return store.read(id);
      },
    })),
  });
  const { id, authorization } = await reauthorizing(f);
  gate.held = deferred<void>();
  const next = keep(f.returned(authorization));
  const report = next.initialize();
  await vi.waitFor(() => expect(gate.reached).toBe(true));
  const release = () => {
    const held = gate.held!;
    delete gate.held;
    held.resolve();
  };
  const saved = async () => {
    const store = await openSessionStore(namespace, factory);
    try {
      return (await store.read(id))?.value;
    } finally {
      store.close();
    }
  };
  return { f, id, next, report, release, saved, gate };
}

it('lets a sign-out after the new grant was stored, before this tab uses it, stay in effect', async () => {
  const t = await grantStored();
  expect(await t.next.disconnect(t.id)).toEqual({ kind: 'disconnected' });
  t.release();
  expect(await t.report).toMatchObject({
    interaction: 'failed',
    problem: 'disconnected',
  });
  expect(t.next.getSnapshot()).toMatchObject([
    { id: t.id, session: { kind: 'signed-out', problem: 'disconnected' } },
  ]);
  expect(await t.saved()).toMatchObject({
    kind: 'disconnected',
    reason: 'disconnected',
  });
});

it('keeps a sign-out here that could not be saved, also once the new grant was stored', async () => {
  const t = await grantStored({ commit: true });
  const signOut = t.next.disconnect(t.id);
  t.release();
  expect(await signOut).toEqual({ kind: 'blocked-locally' });
  expect(await t.report).toMatchObject({
    interaction: 'failed',
    problem: 'disconnected',
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(t.next.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'disconnected',
    saved: false,
  });
  // The stored grant is not used here until the person signs in again.
  expect(await t.saved()).toMatchObject({ kind: 'ready' });
});

it('uses the stored grant when the record cannot be read right after it', async () => {
  const t = await grantStored({ read: true });
  t.release();
  expect(await t.report).toMatchObject({
    interaction: 'completed',
    connectionId: t.id,
  });
  expect(t.next.getSnapshot()[0]?.session.kind).toBe('active');
});
