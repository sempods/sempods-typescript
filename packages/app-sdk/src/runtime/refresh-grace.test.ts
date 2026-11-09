// @vitest-environment jsdom
/**
 * A renewal whose answer is lost (#239): the refresh token is sent once more
 * while the Pod's grace period lasts, so a lost answer on a mobile network no
 * longer signs people out. Beyond it, or when the resend loses its answer too,
 * the session ends as `interrupted` and keeps the Pod address.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import {
  deferred,
  fixture,
  jwt,
  restored,
  savedRecords,
  settleLease,
  storeWith,
  unauthorized,
  work,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
const keep = (runtime: BrowserRuntime) => (runtimes.push(runtime), runtime);
const realNow = Date.now.bind(Date);
let offset = 0;
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  offset = 0;
});
/** Moves this device's clock. */
function advance(ms: number) {
  if (!vi.isMockFunction(Date.now))
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  offset += ms;
}
function goOffline() {
  const state = { offline: true };
  vi.spyOn(window.navigator, 'onLine', 'get').mockImplementation(
    () => !state.offline,
  );
  return {
    online() {
      state.offline = false;
      window.dispatchEvent(new Event('online'));
    },
  };
}
let issued = 0;
const rotated = async () =>
  Response.json({
    access_token: jwt(),
    token_type: 'Bearer',
    refresh_token: 'rotated-' + ++issued,
  });
/** A token endpoint that loses its first `lost` answers, then rotates. */
function losing(lost: number, loss: () => Promise<Response> = failed) {
  let calls = 0;
  return (async () => (++calls <= lost ? loss() : rotated())) as PodFetch;
}
const failed = () => Promise.reject(new TypeError('Failed to fetch'));
const reuse = () =>
  Promise.resolve(
    Response.json(
      { error: 'invalid_grant', error_description: 'refresh token reused' },
      { status: 400 },
    ),
  );
async function signedIn(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({ preferences: null, ...overrides });
  keep(f.runtime);
  const { runtime, id } = await f.login();
  keep(runtime);
  return { f, runtime, id };
}
/** A Pod read the Pod refuses once, which renews the credential. */
function refusedRead(
  f: ReturnType<typeof fixture>,
  runtime: BrowserRuntime,
  id: string,
) {
  let calls = 0;
  f.setQuery(async () => (++calls === 1 ? unauthorized() : Response.json([])));
  return runtime.bindPod(id).sparql.construct('CONSTRUCT {} WHERE {}');
}
function sentRefreshTokens(f: ReturnType<typeof fixture>) {
  return f.fetch.mock.calls
    .filter(([url]) => url.endsWith('/token'))
    .map(([, init]) =>
      new URLSearchParams(String(init?.body)).get('refresh_token'),
    )
    .filter((t): t is string => t !== null);
}
const session = (runtime: BrowserRuntime) => runtime.getSnapshot()[0]?.session;
const record = async (f: ReturnType<typeof fixture>) =>
  (await savedRecords(f.factory))[0]?.value as
    { kind: string; reason?: string; resend?: { resent?: true } } | undefined;
/** The page leaves while the token request is under way; its claim stays. */
async function leftMidRefresh(overrides: Partial<BrowserRuntimeOptions> = {}) {
  const { f, runtime, id } = await signedIn(overrides);
  f.setToken(() => new Promise<Response>(() => {}));
  void refusedRead(f, runtime, id);
  await vi.waitFor(() => expect(sentRefreshTokens(f)).toHaveLength(1));
  expect(await record(f)).toMatchObject({ kind: 'claimed' });
  runtime.dispose();
  await settleLease();
  return { f, id };
}
async function start(
  f: ReturnType<typeof fixture>,
  overrides: Partial<BrowserRuntimeOptions> = {},
) {
  const runtime = keep(
    createBrowserRuntime({
      ...f.options,
      location: () => 'https://app.example/',
      ...overrides,
    }),
  );
  await runtime.initialize();
  await restored(runtime);
  return runtime;
}

it('sends the refresh token once more after a lost answer and keeps the session', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(losing(1));
  expect(await refusedRead(f, runtime, id)).toEqual({ kind: 'ok', body: [] });
  expect(session(runtime)).toMatchObject({ kind: 'active' });
  // The lost answer and its resend carry the same token.
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
  expect(await record(f)).toMatchObject({ kind: 'ready' });
  // The next renewal uses the rotated token, never the resent one.
  f.setToken(rotated);
  expect(await refusedRead(f, runtime, id)).toMatchObject({ kind: 'ok' });
  expect(sentRefreshTokens(f).at(-1)).toMatch(/^rotated-/);
});

it.each([
  ['a gateway failure', 502],
  ['an unavailable server', 503],
  ['a timeout answer', 408],
  ['a rate limit', 429],
  ['a proxy refusal', 403],
  ['a missing route', 404],
] as const)('treats %s as a lost answer', async (_name, status) => {
  const { f, runtime, id } = await signedIn();
  f.setToken(losing(1, () => Promise.resolve(new Response(null, { status }))));
  expect(await refusedRead(f, runtime, id)).toMatchObject({ kind: 'ok' });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
});

it('treats an answer whose body is cut off as lost', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(
    losing(1, () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"access_'));
              controller.error(new TypeError('network error'));
            },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
      ),
    ),
  );
  expect(await refusedRead(f, runtime, id)).toMatchObject({ kind: 'ok' });
  expect(sentRefreshTokens(f)).toHaveLength(2);
});

it('gives up a token request after 20 seconds and resends it once', async () => {
  const { f, runtime, id } = await signedIn();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // Never answers and ignores its signal; the runtime bounds it anyway.
  f.setToken(losing(1, () => new Promise<Response>(() => {})));
  const read = refusedRead(f, runtime, id);
  await vi.waitFor(() => expect(sentRefreshTokens(f)).toHaveLength(1));
  await vi.advanceTimersByTimeAsync(19_000);
  expect(sentRefreshTokens(f)).toHaveLength(1);
  expect(session(runtime)).toMatchObject({ kind: 'renewing' });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await read).toMatchObject({ kind: 'ok' });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
  expect(session(runtime)).toMatchObject({ kind: 'active' });
});

it('ends the session with the server answer when the resend is refused (reuse detection)', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(async () =>
    sentRefreshTokens(f).length === 1 ? failed() : reuse(),
  );
  expect(await refusedRead(f, runtime, id)).toEqual({ kind: 'invalidated' });
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'exchange',
  });
  expect(session(runtime)).not.toHaveProperty('restorable');
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
  await vi.waitFor(async () =>
    expect(await record(f)).toEqual(
      expect.objectContaining({ kind: 'disconnected', reason: 'exchange' }),
    ),
  );
  expect(JSON.stringify(await savedRecords(f.factory))).not.toContain(
    'refresh-private',
  );
});

it('ends an explicit refusal at once, without a resend', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(reuse);
  expect(await refusedRead(f, runtime, id)).toEqual({ kind: 'invalidated' });
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'exchange',
  });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
});

it('resumes a refresh the earlier page left and resends it once', async () => {
  const { f, id } = await leftMidRefresh();
  f.setToken(rotated);
  const runtime = await start(f);
  expect(session(runtime)).toMatchObject({ kind: 'active' });
  expect(runtime.getSnapshot()[0]?.id).toBe(id);
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
  expect(await record(f)).toMatchObject({ kind: 'ready' });
});

it('ends a resumed refresh as interrupted when its resend loses the answer too', async () => {
  const { f, id } = await leftMidRefresh();
  f.setToken(failed);
  const runtime = await start(f);
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'interrupted',
  });
  expect(sentRefreshTokens(f)).toHaveLength(2);
  await vi.waitFor(async () =>
    expect(await record(f)).toEqual(
      expect.objectContaining({ kind: 'disconnected', reason: 'interrupted' }),
    ),
  );
  // Signing in again is one action: the address stays, nothing is resent.
  runtime.dispose();
  await settleLease();
  const next = await start(f);
  expect(next.getSnapshot()).toMatchObject([
    { id, session: { kind: 'signed-out', problem: 'interrupted' } },
  ]);
  expect(sentRefreshTokens(f)).toHaveLength(2);
});

it.each([
  ['older than the grace period', 'old'],
  ['resent already', 'resent'],
] as const)(
  'ends a claim %s at startup as interrupted, without a request',
  async (_name, kind) => {
    const { f, id } = await leftMidRefresh();
    if (kind === 'old') advance(60_000);
    else {
      // The earlier page sent the resend and left before its answer.
      const first = keep(
        createBrowserRuntime({
          ...f.options,
          location: () => 'https://app.example/',
        }),
      );
      await first.initialize();
      await vi.waitFor(() => expect(sentRefreshTokens(f)).toHaveLength(2));
      expect(await record(f)).toMatchObject({ resend: { resent: true } });
      first.dispose();
      await settleLease();
    }
    f.setToken(rotated);
    const sent = sentRefreshTokens(f).length;
    const runtime = await start(f);
    expect(session(runtime)).toMatchObject({
      kind: 'ended',
      problem: 'interrupted',
    });
    expect(sentRefreshTokens(f)).toHaveLength(sent);
    await vi.waitFor(async () =>
      expect(await record(f)).toEqual(
        expect.objectContaining({
          kind: 'disconnected',
          reason: 'interrupted',
        }),
      ),
    );
    expect(runtime.getSnapshot()[0]?.id).toBe(id);
  },
);

it('stays restorable while offline within the grace period and resends once online', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(losing(1));
  const network = goOffline();
  // The access loss invalidates the read that needed the renewal.
  expect(await refusedRead(f, runtime, id)).toEqual({ kind: 'invalidated' });
  expect(session(runtime)).toEqual({
    kind: 'ended',
    problem: 'network',
    restorable: true,
  });
  // Nothing is sent while offline, also on an explicit retry.
  await runtime.retryRestore(id);
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
  expect(await record(f)).toMatchObject({ kind: 'claimed' });
  network.online();
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({ kind: 'active' }),
  );
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
  expect(await refusedRead(f, runtime, id)).toMatchObject({ kind: 'ok' });
});

it('suspends bound access and pending reads while the resend waits, and restores it after', async () => {
  const { f, runtime, id } = await signedIn();
  const view = runtime.bindContext(id, work);
  const pod = runtime.bindPod(id);
  await vi.waitFor(() =>
    expect(view.getSnapshot()).toMatchObject({ read: true, write: true }),
  );
  f.setResource(() => new Promise<Response>(() => {}));
  const pending = view.subjects.get('urn:item');
  const changes = vi.fn();
  view.subscribe(changes);
  const before = view.getSnapshot().revision;
  f.setToken(losing(1));
  const network = goOffline();
  await refusedRead(f, runtime, id);
  expect(session(runtime)).toMatchObject({ kind: 'ended', restorable: true });
  expect(view.getSnapshot()).toMatchObject({
    current: true,
    read: false,
    write: false,
  });
  expect(view.getSnapshot().revision).toBeGreaterThan(before);
  expect(pod.getSnapshot()).toMatchObject({ current: true, read: false });
  expect(changes).toHaveBeenCalled();
  expect(await pending).toEqual({ kind: 'invalidated' });
  expect(await view.subjects.get('urn:item')).toEqual({ kind: 'invalidated' });
  network.online();
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({ kind: 'active' }),
  );
  expect(view.getSnapshot()).toMatchObject({ read: true, write: true });
  expect(pod.getSnapshot()).toMatchObject({ current: true, read: true });
});

it('ends as interrupted when the device stays offline beyond the grace period', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(losing(1));
  const network = goOffline();
  await refusedRead(f, runtime, id);
  expect(session(runtime)).toMatchObject({ kind: 'ended', restorable: true });
  advance(60_000);
  network.online();
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({
      kind: 'ended',
      problem: 'interrupted',
    }),
  );
  expect(session(runtime)).not.toHaveProperty('restorable');
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
  await vi.waitFor(async () =>
    expect(await record(f)).toEqual(
      expect.objectContaining({ kind: 'disconnected', reason: 'interrupted' }),
    ),
  );
  runtime.dispose();
  await settleLease();
  const next = await start(f);
  expect(next.getSnapshot()).toMatchObject([
    { id, session: { kind: 'signed-out', problem: 'interrupted' } },
  ]);
});

it('stops being restorable once the grace period has passed, while still offline', async () => {
  const { f, runtime, id } = await signedIn({ refreshGracePeriod: 200 });
  f.setToken(losing(1));
  goOffline();
  await refusedRead(f, runtime, id);
  expect(session(runtime)).toMatchObject({ kind: 'ended', restorable: true });
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({
      kind: 'ended',
      problem: 'interrupted',
    }),
  );
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
});

it('waits for the browser when the resumed refresh cannot reach its Pod', async () => {
  const { f } = await leftMidRefresh();
  const original = f.fetch.getMockImplementation()!;
  const state = { down: true };
  f.fetch.mockImplementation(async (url, init) => {
    if (state.down && url.includes('/.well-known/'))
      throw new TypeError('Failed to fetch');
    return original(url, init);
  });
  f.setToken(rotated);
  const runtime = await start(f);
  expect(session(runtime)).toEqual({
    kind: 'ended',
    problem: 'network',
    restorable: true,
  });
  expect(sentRefreshTokens(f)).toHaveLength(1);
  state.down = false;
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({ kind: 'active' }),
  );
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
});

it('sends nothing more after a sign-out while waiting offline', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(losing(1));
  const network = goOffline();
  await refusedRead(f, runtime, id);
  expect(session(runtime)).toMatchObject({ restorable: true });
  await runtime.disconnect(id);
  network.online();
  await settleLease();
  expect(session(runtime)).toMatchObject({ kind: 'signed-out' });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
  expect(JSON.stringify(await savedRecords(f.factory))).not.toContain(
    'refresh-private',
  );
});

it('ends as interrupted when the resend in the page loses its answer too', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(failed);
  expect(await refusedRead(f, runtime, id)).toEqual({ kind: 'invalidated' });
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'interrupted',
  });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
  await vi.waitFor(async () =>
    expect(await record(f)).toEqual(
      expect.objectContaining({ kind: 'disconnected', reason: 'interrupted' }),
    ),
  );
});

it('ends as interrupted when the resend after coming online loses its answer too', async () => {
  const { f, runtime, id } = await signedIn();
  f.setToken(failed);
  const network = goOffline();
  await refusedRead(f, runtime, id);
  expect(session(runtime)).toMatchObject({ restorable: true });
  network.online();
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({
      kind: 'ended',
      problem: 'interrupted',
    }),
  );
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
});

it('keeps the one resend when the network is down although the browser reports online', async () => {
  const { f, runtime, id } = await signedIn();
  // The probe before the resend fails too: wait instead of spending it.
  const original = f.fetch.getMockImplementation()!;
  const state = { down: false };
  f.fetch.mockImplementation(async (url, init) => {
    if (state.down) throw new TypeError('Failed to fetch');
    return original(url, init);
  });
  f.setToken(async () => {
    state.down = true;
    return failed();
  });
  await refusedRead(f, runtime, id);
  expect(session(runtime)).toEqual({
    kind: 'ended',
    problem: 'network',
    restorable: true,
  });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
  state.down = false;
  f.setToken(rotated);
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({ kind: 'active' }),
  );
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
});

it('sends no resend once a slow probe took it past the grace period', async () => {
  const { f, runtime, id } = await signedIn();
  const original = f.fetch.getMockImplementation()!;
  const held = deferred<void>();
  let probing = false;
  f.fetch.mockImplementation(async (url, init) => {
    if (probing && url.includes('/.well-known/')) await held.promise;
    return original(url, init);
  });
  f.setToken(async () => {
    probing = true;
    return failed();
  });
  const read = refusedRead(f, runtime, id);
  await vi.waitFor(() => expect(sentRefreshTokens(f)).toHaveLength(1));
  advance(60_000);
  held.resolve();
  expect(await read).toEqual({ kind: 'invalidated' });
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'interrupted',
  });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
});

it('sends no resend once recording it took it past the grace period', async () => {
  const { f, id } = await leftMidRefresh();
  f.setToken(rotated);
  const runtime = await start(f, {
    openStore: storeWith(f.factory, (store) => ({
      async commit(...args: Parameters<typeof store.commit>) {
        const result = await store.commit(...args);
        // The durable resend record lands after the grace period.
        if ((args[2] as { resend?: { resent?: true } }).resend?.resent)
          advance(60_000);
        return result;
      },
    })),
  });
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'interrupted',
  });
  expect(runtime.getSnapshot()[0]?.id).toBe(id);
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
});

it('leaves a sign-in started during the refresh alone when the cancelled request settles', async () => {
  const { f, runtime, id } = await signedIn();
  const held = deferred<Response>();
  f.setToken(() => held.promise);
  const read = refusedRead(f, runtime, id);
  await vi.waitFor(() => expect(sentRefreshTokens(f)).toHaveLength(1));
  await runtime.beginAuthorization(id);
  const before = session(runtime);
  held.reject(new TypeError('Failed to fetch'));
  expect(await read).toEqual({ kind: 'invalidated' });
  await settleLease();
  expect(session(runtime)).toEqual(before);
  expect(session(runtime)?.kind).not.toBe('ended');
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
  expect(await record(f)).toMatchObject({ kind: 'authorizing' });
});

it('keeps a very long grace period restorable instead of ending at once', async () => {
  const { f, runtime, id } = await signedIn({ refreshGracePeriod: 1e12 });
  f.setToken(losing(1));
  goOffline();
  await refusedRead(f, runtime, id);
  await settleLease();
  await settleLease();
  expect(session(runtime)).toMatchObject({ kind: 'ended', restorable: true });
});

it('never resends with a grace period of 0', async () => {
  const { f, runtime, id } = await signedIn({ refreshGracePeriod: 0 });
  f.setToken(losing(1));
  expect(await refusedRead(f, runtime, id)).toEqual({ kind: 'invalidated' });
  expect(session(runtime)).toMatchObject({
    kind: 'ended',
    problem: 'interrupted',
  });
  expect(sentRefreshTokens(f)).toEqual(['refresh-private']);
});

it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects a grace period of %s',
  (refreshGracePeriod) => {
    expect(() =>
      createBrowserRuntime({ ...fixture().options, refreshGracePeriod }),
    ).toThrow(expect.objectContaining({ problem: 'configuration' }));
  },
);

it('shares the resend with every waiting request', async () => {
  const { f, runtime, id } = await signedIn();
  const held = deferred<Response>();
  let calls = 0;
  f.setToken(async () =>
    ++calls === 1 ? failed() : calls === 2 ? held.promise : rotated(),
  );
  let refusals = 2;
  f.setQuery(async () => (refusals-- > 0 ? unauthorized() : Response.json([])));
  const pod = runtime.bindPod(id);
  const reads = [
    pod.sparql.construct('CONSTRUCT {} WHERE {}'),
    pod.sparql.construct('CONSTRUCT {} WHERE {}'),
  ];
  await vi.waitFor(() => expect(sentRefreshTokens(f)).toHaveLength(2));
  held.resolve(await rotated());
  expect(await Promise.all(reads)).toEqual([
    { kind: 'ok', body: [] },
    { kind: 'ok', body: [] },
  ]);
  expect(sentRefreshTokens(f)).toEqual(['refresh-private', 'refresh-private']);
});
