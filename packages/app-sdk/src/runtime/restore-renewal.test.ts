/**
 * A saved credential that is due when restored is renewed as part of
 * restoration (#305): the connection stays `restoring` until the answer, so
 * an expired grant ends there instead of after the app saw it `active`.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime, SessionFact } from './types.js';
import {
  fixture,
  jwt,
  restored,
  savedRecords,
  settleLease,
  storeWith,
} from './fixture.test.js';
import { SessionStorageError } from '../sessions/store.js';
import type { SessionStore } from '../sessions/types.js';

const runtimes: BrowserRuntime[] = [];
const realNow = Date.now.bind(Date);
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});
/** Moves this device's clock past the saved token's lifetime. */
function later(ms: number) {
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms);
}
let issued = 0;
const rotating: PodFetch = async () =>
  Response.json({
    access_token: jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    token_type: 'Bearer',
    refresh_token: 'refresh-' + ++issued,
  });
/** Signed in, then a reload with `token` answering refreshes. */
async function reloaded(
  token: PodFetch,
  options: {
    refreshToken?: boolean;
    after?: number;
    store?: (store: SessionStore) => Partial<SessionStore>;
  } = {},
) {
  const f = fixture({ preferences: null });
  if (options.refreshToken === false)
    f.setToken(async () =>
      Response.json({ access_token: jwt(), token_type: 'Bearer' }),
    );
  runtimes.push(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const returned = f.returned();
  runtimes.push(returned);
  await returned.initialize();
  await restored(returned);
  returned.dispose();
  await settleLease();
  if (options.after) later(options.after);
  f.setToken(token);
  const before = f.count('/token');
  const runtime = createBrowserRuntime({
    ...f.options,
    ...(options.store
      ? { openStore: storeWith(f.factory, options.store) }
      : {}),
    location: () => 'https://app.example/',
  });
  runtimes.push(runtime);
  const seen: SessionFact['kind'][] = [];
  runtime.subscribe(() => {
    const kind = runtime.getSnapshot()[0]?.session.kind;
    if (kind && seen.at(-1) !== kind) seen.push(kind);
  });
  await runtime.initialize();
  await restored(runtime);
  return {
    f,
    runtime,
    id: connection.id,
    seen,
    refreshes: () => f.count('/token') - before,
  };
}

it('restores a valid credential without a token request', async () => {
  const r = await reloaded(rotating);
  expect(r.seen).toEqual(['restoring', 'active']);
  expect(r.refreshes()).toBe(0);
});

it('renews an expired credential while it restores, then becomes active', async () => {
  const r = await reloaded(rotating, { after: 2 * 3600_000 });
  expect(r.seen).toEqual(['restoring', 'active']);
  expect(r.refreshes()).toBe(1);
});

it('renews a credential within the renewal margin while it restores', async () => {
  const r = await reloaded(rotating, { after: 3600_000 - 30_000 });
  expect(r.seen).toEqual(['restoring', 'active']);
  expect(r.refreshes()).toBe(1);
});

it('ends an expired grant at restoration when its renewal is refused, never active', async () => {
  const r = await reloaded(
    async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    { after: 2 * 3600_000 },
  );
  expect(r.seen).toEqual(['restoring', 'ended']);
  expect(r.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
  });
  expect(r.runtime.getSnapshot()[0]?.session).not.toHaveProperty('restorable');
  // Retired as at a first request: the address stays, signed out next time.
  await vi.waitFor(async () =>
    expect((await savedRecords(r.f.factory))[0]).toMatchObject({
      value: { kind: 'disconnected' },
    }),
  );
});

it('ends an expired credential without a refresh token at restoration', async () => {
  const r = await reloaded(rotating, {
    refreshToken: false,
    after: 2 * 3600_000,
  });
  expect(r.seen).toEqual(['restoring', 'ended']);
  expect(r.runtime.getSnapshot()[0]?.session).toEqual({
    kind: 'ended',
    problem: 'expired',
  });
  expect(r.refreshes()).toBe(0);
});

it('resends once after a lost answer while it restores, then becomes active', async () => {
  let calls = 0;
  const r = await reloaded(
    async (url, init) =>
      ++calls === 1 ? new Response(null, { status: 503 }) : rotating(url, init),
    { after: 2 * 3600_000 },
  );
  expect(r.seen).toEqual(['restoring', 'active']);
  expect(r.refreshes()).toBe(2);
});

it('stays restorable when the claim cannot be stored, and restores on retry', async () => {
  let failures = 1;
  const r = await reloaded(rotating, {
    after: 2 * 3600_000,
    store: (store) => ({
      commit: (...args) =>
        failures-- > 0
          ? Promise.reject(new SessionStorageError('unavailable'))
          : store.commit(...args),
    }),
  });
  expect(r.seen).toEqual(['restoring', 'ended']);
  expect(r.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    restorable: true,
  });
  expect(r.refreshes()).toBe(0);
  await r.runtime.retryRestore(r.id);
  await restored(r.runtime);
  expect(r.runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expect(r.refreshes()).toBe(1);
});
