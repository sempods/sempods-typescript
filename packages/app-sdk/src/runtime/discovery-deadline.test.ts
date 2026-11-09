/**
 * A Pod whose discovery never settles (#253): discovery only reads metadata,
 * so after its deadline the Pod counts as unreachable. A restoration then
 * reports `restorable` feedback and keeps the saved session, a late answer is
 * dropped, an explicit retry restores it, and other connections' actions never
 * wait for it. Nothing is replayed: no refresh or code exchange is resent.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime } from './types.js';
import {
  deferred,
  fixture,
  jwt,
  pod,
  savedRecords,
  settleLease,
  unauthorized,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
const keep = (runtime: BrowserRuntime) => (runtimes.push(runtime), runtime);
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const bob = 'https://pod.example/bob';
/** Lets storage and fetch mocks settle without moving the faked clock. */
async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
}
/** Waits for `check` to pass without moving the faked clock. */
async function until(check: () => void) {
  for (let i = 0; ; i++) {
    try {
      check();
      return;
    } catch (error) {
      if (i > 500) throw error;
      await flush(1);
    }
  }
}
const query = 'CONSTRUCT {} WHERE {}';

/** Alice and Bob signed in, saved in one store; nothing restored yet. */
async function saved() {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const first = await f.login();
  keep(first.runtime);
  const second = await first.runtime.connect(bob);
  await first.runtime.beginAuthorization(second.id);
  first.runtime.dispose();
  await settleLease();
  f.setToken(async (url) =>
    Response.json({
      access_token: jwt({ iss: url.split('/_system')[0] }),
      token_type: 'Bearer',
      refresh_token: 'fresh-' + url.split('/')[3],
    }),
  );
  const completed = keep(f.returned());
  expect(await completed.initialize()).toMatchObject({
    interaction: 'completed',
  });
  completed.dispose();
  await settleLease();
  return { f, alice: first.id, bob: second.id };
}
/**
 * The next start, with Alice's discovery never answering (it ignores its
 * signal) while Bob's answers. `release` answers Alice's held requests.
 */
async function stalled() {
  const { f, alice, bob: bobId } = await saved();
  const original = f.fetch.getMockImplementation()!;
  const held: ReturnType<typeof deferred<void>>[] = [];
  const state = { stalled: true };
  f.fetch.mockImplementation(async (url, init) => {
    if (state.stalled && url.startsWith(`${pod}/.well-known/`)) {
      const hold = deferred<void>();
      held.push(hold);
      await hold.promise;
    }
    return original(url, init);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const runtime = keep(
    createBrowserRuntime({
      ...f.options,
      location: () => 'https://app.example/',
    }),
  );
  expect(await runtime.initialize()).toMatchObject({ storage: 'durable' });
  await until(() =>
    expect(sessions(runtime)).toEqual({
      [pod]: 'restoring',
      [bob]: 'active',
    }),
  );
  return {
    f,
    runtime,
    alice,
    bob: bobId,
    held,
    /** Lets new discovery requests through; held ones stay pending. */
    unstall() {
      state.stalled = false;
    },
    release() {
      state.stalled = false;
      held.splice(0).forEach((hold) => hold.resolve());
    },
  };
}
const sessions = (runtime: BrowserRuntime) =>
  Object.fromEntries(
    runtime.getSnapshot().map((c) => [c.podUrl, c.session.kind]),
  );
const session = (runtime: BrowserRuntime, id: string) =>
  runtime.getSnapshot().find((c) => c.id === id)?.session;
const aliceRecord = async (f: ReturnType<typeof fixture>, id: string) =>
  (await savedRecords(f.factory)).find((r) => r.id === id)?.value as
    { kind: string; credentials?: { refreshToken?: string } } | undefined;

it('reaches restorable feedback for a never-settling discovery beside a healthy Pod, keeping the saved session', async () => {
  const { f, runtime, alice, bob: bobId } = await stalled();
  const tokens = f.count('/token');
  await vi.advanceTimersByTimeAsync(14_900);
  expect(session(runtime, alice)?.kind).toBe('restoring');
  await vi.advanceTimersByTimeAsync(100);
  expect(session(runtime, alice)).toEqual({
    kind: 'ended',
    problem: 'network',
    restorable: true,
  });
  // The healthy Pod is unaffected and readable.
  expect(session(runtime, bobId)?.kind).toBe('active');
  expect(await runtime.bindPod(bobId).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  // Nothing was spent or retired: the saved session stays as it was.
  expect(await aliceRecord(f, alice)).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'refresh-private' },
  });
  expect(f.count('/token')).toBe(tokens);
  expect(f.navigate).toHaveBeenCalledTimes(2);
});

it('ignores a late discovery answer after the deadline, then restores on explicit retry', async () => {
  const { f, runtime, alice, release } = await stalled();
  await vi.advanceTimersByTimeAsync(15_000);
  const ended = session(runtime, alice);
  expect(ended).toMatchObject({ restorable: true });
  // The late answer publishes nothing and installs no credentials.
  release();
  await flush();
  expect(session(runtime, alice)).toBe(ended);
  expect(() => runtime.bindPod(alice)).toThrow(
    expect.objectContaining({ problem: 'disconnected' }),
  );
  // An explicit retry restores the saved session without a token request.
  const tokens = f.count('/token');
  const seen: string[] = [];
  const off = runtime.subscribe(() => seen.push(session(runtime, alice)!.kind));
  await runtime.retryRestore(alice);
  off();
  expect(seen[0]).toBe('restoring');
  expect(session(runtime, alice)?.kind).toBe('active');
  expect(f.count('/token')).toBe(tokens);
  expect(await runtime.bindPod(alice).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
});

it('ends restorable again when the retried discovery stalls too', async () => {
  const { runtime, alice } = await stalled();
  await vi.advanceTimersByTimeAsync(15_000);
  const retry = runtime.retryRestore(alice);
  expect(session(runtime, alice)?.kind).toBe('restoring');
  await vi.advanceTimersByTimeAsync(15_000);
  await retry;
  expect(session(runtime, alice)).toMatchObject({
    kind: 'ended',
    restorable: true,
  });
});

it('drops a late answer after a sign-out during the restoration', async () => {
  const { f, runtime, alice, release } = await stalled();
  expect(await runtime.disconnect(alice)).toEqual({ kind: 'disconnected' });
  expect(session(runtime, alice)).toMatchObject({ kind: 'signed-out' });
  release();
  await vi.advanceTimersByTimeAsync(15_000);
  await flush();
  expect(session(runtime, alice)).toMatchObject({ kind: 'signed-out' });
  expect(await aliceRecord(f, alice)).toMatchObject({ kind: 'disconnected' });
  expect(JSON.stringify(await aliceRecord(f, alice))).not.toContain(
    'refresh-private',
  );
});

it('keeps per-connection and global actions available while another Pod restores', async () => {
  const { f, runtime, alice, bob: bobId } = await stalled();
  // Global: connecting another Pod does not wait for Alice.
  const carol = await runtime.connect('https://pod.example/carol');
  expect(sessions(runtime)).toMatchObject({
    [pod]: 'restoring',
    'https://pod.example/carol': 'signed-out',
  });
  // Another connection's reads and a sign-in work.
  expect(await runtime.bindPod(bobId).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  await runtime.beginAuthorization(carol.id);
  expect(f.navigate).toHaveBeenCalledTimes(3);
  expect(session(runtime, carol.id)?.kind).toBe('leaving');
  // Another connection's sign-out and forget work.
  expect(await runtime.disconnect(bobId)).toEqual({ kind: 'disconnected' });
  expect(await runtime.forget(bobId)).toEqual({ kind: 'disconnected' });
  expect(session(runtime, alice)?.kind).toBe('restoring');
});

it('lets a sign-in of the restoring connection win over its pending restoration', async () => {
  const { runtime, alice, held, unstall, release } = await stalled();
  // Preparing the sign-in needs its own discovery, which answers; the
  // restoration's discovery stays pending.
  unstall();
  await runtime.beginAuthorization(alice);
  expect(session(runtime, alice)?.kind).toBe('leaving');
  expect(held.length).toBeGreaterThan(0);
  // The restoration's discovery answers late, then its deadline passes.
  release();
  await flush();
  await vi.advanceTimersByTimeAsync(15_000);
  await flush();
  // The earlier restoration publishes nothing over the stored attempt.
  expect(session(runtime, alice)?.kind).toBe('leaving');
});

it('stays signed in when the discovery before a refresh claim stalls, and renews later', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  const original = f.fetch.getMockImplementation()!;
  const state = { stalled: true };
  f.fetch.mockImplementation(async (url, init) => {
    if (state.stalled && url.includes('/.well-known/'))
      return new Promise<Response>(() => {});
    return original(url, init);
  });
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  let refusals = 1;
  f.setQuery(async () => (refusals-- > 0 ? unauthorized() : Response.json([])));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const read = runtime.bindPod(id).sparql.construct(query);
  await until(() =>
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('renewing'),
  );
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await read).toEqual({ kind: 'refused', status: 401 });
  // Nothing was claimed: the unspent refresh token stays.
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.count('/token')).toBe(1);
  expect((await savedRecords(f.factory))[0]?.value).toMatchObject({
    kind: 'ready',
    credentials: { refreshToken: 'refresh-private' },
  });
  state.stalled = false;
  refusals = 1;
  expect(await runtime.bindPod(id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
  expect(f.count('/token')).toBe(2);
});

it('rejects a connect whose discovery never settles, adding no connection', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  await f.runtime.initialize();
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) =>
    url.includes('/.well-known/')
      ? new Promise<Response>(() => {})
      : original(url, init),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const connecting = f.runtime.connect(pod);
  const outcome = expect(connecting).rejects.toMatchObject({
    problem: 'network',
  });
  await vi.advanceTimersByTimeAsync(15_000);
  await outcome;
  expect(f.runtime.getSnapshot()).toEqual([]);
});

it('stops a connect whose discovery stalls at once on dispose', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  await f.runtime.initialize();
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) =>
    url.includes('/.well-known/')
      ? new Promise<Response>(() => {})
      : original(url, init),
  );
  const connecting = f.runtime.connect(pod);
  const outcome = expect(connecting).rejects.toMatchObject({
    problem: 'disconnected',
  });
  await vi.waitFor(() =>
    expect(
      f.fetch.mock.calls.some(([url]) => url.includes('/.well-known/')),
    ).toBe(true),
  );
  f.runtime.dispose();
  await outcome;
});

/** A signed-in runtime whose Pod's discovery stalls once `stall` is called. */
async function signedIn() {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  const original = f.fetch.getMockImplementation()!;
  const state = { stalled: false };
  f.fetch.mockImplementation(async (url, init) =>
    state.stalled && url.includes('/.well-known/')
      ? new Promise<Response>(() => {})
      : original(url, init),
  );
  return { f, runtime, id, state };
}

it('rejects a sign-in whose discovery never settles, resetting nothing', async () => {
  const { f, runtime, id, state } = await signedIn();
  state.stalled = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const navigations = f.navigate.mock.calls.length;
  const begun = runtime.beginAuthorization(id);
  const outcome = expect(begun).rejects.toMatchObject({ problem: 'network' });
  await vi.advanceTimersByTimeAsync(15_000);
  await outcome;
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect(await runtime.bindPod(id).sparql.construct(query)).toMatchObject({
    kind: 'ok',
  });
});

it('stops waiting for a stalled sign-in discovery at once when the person signs out', async () => {
  const { runtime, id, state } = await signedIn();
  state.stalled = true;
  const begun = runtime.beginAuthorization(id);
  const outcome = expect(begun).rejects.toMatchObject({
    problem: 'disconnected',
  });
  await flush();
  await runtime.disconnect(id);
  await outcome;
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('signed-out');
});

it('fails a callback whose discovery never settles before claiming its attempt', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) =>
    url.includes('/.well-known/')
      ? new Promise<Response>(() => {})
      : original(url, init),
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const returned = keep(f.returned());
  const report = returned.initialize();
  await flush();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await report).toMatchObject({
    interaction: 'failed',
    problem: 'network',
    attemptConnectionId: connection.id,
  });
  // The attempt was not claimed: its code was never sent.
  expect(f.count('/token')).toBe(0);
  expect(
    (await savedRecords(f.factory)).find((r) => r.id === connection.id)?.value,
  ).toMatchObject({ kind: 'authorizing' });
});

it('waits restorable when the probe before the resend of a lost renewal answer stalls', async () => {
  const { f, runtime, id, state } = await signedIn();
  f.setToken(async () => {
    // The answer is lost; the probe that follows never settles.
    state.stalled = true;
    throw new TypeError('Failed to fetch');
  });
  let refusals = 1;
  f.setQuery(async () => (refusals-- > 0 ? unauthorized() : Response.json([])));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const read = runtime.bindPod(id).sparql.construct(query);
  await until(() => expect(state.stalled).toBe(true));
  await flush();
  await vi.advanceTimersByTimeAsync(15_000);
  await read;
  expect(runtime.getSnapshot()[0]?.session).toEqual({
    kind: 'ended',
    problem: 'network',
    restorable: true,
  });
  expect(f.count('/token')).toBe(2);
});
