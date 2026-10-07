/**
 * Renewal before expiry: a credential near or past its own `expiresAt` is
 * renewed before dispatch, so recovery does not depend on the Pod's 401
 * challenge (issue #51).
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import type { BrowserRuntime } from './types.js';
import { createBrowserRuntime } from './runtime.js';
import {
  deferred,
  fixture,
  jwt,
  restored,
  settleLease,
} from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
const realNow = Date.now.bind(Date);
let offset = 0;
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
  offset = 0;
});
/** Moves this device's clock; issued tokens and expiry checks follow it. */
function advance(ms: number) {
  if (!vi.isMockFunction(Date.now))
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  offset += ms;
}
let issued = 0;
/** Rotates the refresh token on every answer, as continuity requires. */
const rotating: PodFetch = async () =>
  Response.json({
    access_token: jwt(),
    token_type: 'Bearer',
    refresh_token: 'refresh-' + ++issued,
  });
async function logged(token: PodFetch = rotating) {
  const f = fixture();
  f.setToken(token);
  runtimes.push(f.runtime);
  const result = await f.login();
  runtimes.push(result.runtime);
  return { ...f, ...result };
}
const query = 'CONSTRUCT {} WHERE {}';
/** The Pod refuses a credential it received after the token's lifetime, like the field Pod. */
function expiringPod(
  f: Awaited<ReturnType<typeof logged>>,
  challenge: boolean,
) {
  const sent: string[] = [];
  const expired = new Set<string>();
  f.setQuery(async (_url, init) => {
    const authorization = new Headers(init?.headers).get('authorization')!;
    sent.push(authorization);
    if (expired.has(authorization))
      return new Response(null, {
        status: 401,
        headers: challenge
          ? { 'www-authenticate': 'Bearer error="invalid_token"' }
          : {},
      });
    return Response.json([]);
  });
  return {
    sent,
    expire: () => sent.forEach((authorization) => expired.add(authorization)),
  };
}
function tokenRequests(f: Awaited<ReturnType<typeof logged>>) {
  return f.fetch.mock.calls
    .filter(([url]) => url.endsWith('/token'))
    .map(([, init]) => new URLSearchParams(String(init?.body)));
}

it.each([
  ['without a challenge', false],
  ['with a Bearer challenge', true],
])(
  'renews an expired credential before dispatch, for a Pod answering %s',
  async (_name, challenge) => {
    const f = await logged();
    const pod = expiringPod(f, challenge);
    expect(await f.view.sparql.construct(query)).toEqual({
      kind: 'ok',
      body: [],
    });
    pod.expire();
    advance(3600_000);
    expect(await f.view.sparql.construct(query)).toEqual({
      kind: 'ok',
      body: [],
    });
    expect(pod.sent).toHaveLength(2);
    expect(pod.sent[1]).not.toBe(pod.sent[0]);
    expect(tokenRequests(f).at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active');
  },
);

it('renews within a minute of expiry and shares one refresh across reads', async () => {
  const f = await logged();
  const pod = expiringPod(f, false);
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  const exchanged = tokenRequests(f).length;
  advance(3600_000 - 30_000);
  const reads = await Promise.all([
    f.view.sparql.construct(query),
    f.view.sparql.construct(query),
    f.view.sparql.construct(query),
  ]);
  expect(reads).toEqual(Array(3).fill({ kind: 'ok', body: [] }));
  // Still valid: sent without waiting while one renewal runs.
  expect(new Set(pod.sent)).toEqual(new Set([pod.sent[0]]));
  await vi.waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active'),
  );
  expect(tokenRequests(f)).toHaveLength(exchanged + 1);
  // The renewed credential is used and not due again.
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(pod.sent.at(-1)).not.toBe(pod.sent[0]);
  expect(tokenRequests(f)).toHaveLength(exchanged + 1);
});

it('does not hold back a still-valid credential behind a hanging renewal, but waits once it expired', async () => {
  const f = await logged();
  const pod = expiringPod(f, false);
  const hanging = deferred<Response>();
  f.setToken(() => hanging.promise);
  advance(3600_000 - 30_000);
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('renewing');
  advance(30_000);
  const caller = new AbortController();
  const waiting = f.view.sparql.construct(query, { signal: caller.signal });
  await settleLease();
  expect(pod.sent).toHaveLength(1);
  caller.abort();
  expect(await waiting).toEqual({ kind: 'cancelled' });
  expect(pod.sent).toHaveLength(1);
  hanging.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'refresh-' + ++issued,
    }),
  );
  await vi.waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active'),
  );
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(pod.sent.at(-1)).not.toBe(pod.sent[0]);
});

it('waits for an early renewal once the Pod refused the still-valid credential', async () => {
  const f = await logged();
  const hanging = deferred<Response>();
  f.setToken(() => hanging.promise);
  const sent: string[] = [];
  f.setQuery(async (_url, init) => {
    const authorization = new Headers(init?.headers).get('authorization')!;
    sent.push(authorization);
    // This Pod revokes the old token as soon as its refresh begins.
    return sent.length === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
        })
      : Response.json([]);
  });
  advance(3600_000 - 30_000);
  const refused = f.view.sparql.construct(query);
  await vi.waitFor(() => expect(sent).toHaveLength(1));
  const later = f.view.sparql.construct(query);
  await settleLease();
  expect(sent).toHaveLength(1);
  hanging.resolve(
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'refresh-' + ++issued,
    }),
  );
  expect(await refused).toEqual({ kind: 'ok', body: [] });
  expect(await later).toEqual({ kind: 'ok', body: [] });
  expect(sent).toHaveLength(3);
  expect(sent[1]).toBe(sent[2]);
  expect(sent[1]).not.toBe(sent[0]);
});

it('keeps a credential outside the renewal margin', async () => {
  const f = await logged();
  const exchanged = tokenRequests(f).length;
  advance(3600_000 - 90_000);
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(tokenRequests(f)).toHaveLength(exchanged);
});

it('uses half the lifetime as margin for short tokens', async () => {
  const short: PodFetch = async () => {
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      access_token: jwt({ iat: now, exp: now + 10 }),
      token_type: 'Bearer',
      expires_in: 10,
      refresh_token: 'refresh-' + ++issued,
    });
  };
  const f = await logged(short);
  const exchanged = tokenRequests(f).length;
  advance(4_000);
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  expect(tokenRequests(f)).toHaveLength(exchanged);
  advance(2_000);
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  await vi.waitFor(() => expect(tokenRequests(f)).toHaveLength(exchanged + 1));
});

it('renews a restored credential that expired while the app was closed', async () => {
  const f = await logged();
  f.runtime.dispose();
  for (const r of runtimes) r.dispose();
  await settleLease();
  advance(3600_000);
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  const pod = expiringPod(f, false);
  await next.initialize();
  await restored(next);
  const id = next.getSnapshot()[0]!.id;
  expect(await next.bindPod(id).sparql.construct(query)).toEqual({
    kind: 'ok',
    body: [],
  });
  expect(pod.sent).toHaveLength(1);
  expect(tokenRequests(f).at(-1)?.get('grant_type')).toBe('refresh_token');
});

it('sends a due credential without refresh token until it expires, then ends the session', async () => {
  const f = await logged(async () =>
    Response.json({ access_token: jwt(), token_type: 'Bearer' }),
  );
  const pod = expiringPod(f, false);
  advance(3600_000 - 30_000);
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'ok',
    body: [],
  });
  advance(30_000);
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'invalidated',
  });
  expect(pod.sent).toHaveLength(1);
  expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'expired',
  });
});

it('ends the session visibly when renewal before expiry is refused, without sending the expired credential', async () => {
  const f = await logged();
  const pod = expiringPod(f, false);
  f.setToken(async () =>
    Response.json({ error: 'invalid_grant' }, { status: 400 }),
  );
  advance(3600_000);
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'invalidated',
  });
  expect(pod.sent).toHaveLength(0);
  expect(f.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    problem: 'exchange',
  });
});

it('stays signed in after a transient failure and renews on the next read', async () => {
  const f = await logged();
  const pod = expiringPod(f, false);
  const original = f.fetch.getMockImplementation()!;
  const offline = deferred<void>();
  let failing = true;
  f.fetch.mockImplementation(async (url, init) => {
    if (failing && url.includes('/.well-known/')) {
      offline.resolve();
      throw new TypeError('offline');
    }
    return original(url, init);
  });
  expect(await f.view.sparql.construct(query)).toMatchObject({ kind: 'ok' });
  pod.expire();
  advance(3600_000);
  // The unspent refresh token stays; the expired credential is still offered.
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'refused',
    status: 401,
  });
  await offline.promise;
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active');
  failing = false;
  expect(await f.view.sparql.construct(query)).toEqual({
    kind: 'ok',
    body: [],
  });
  expect(tokenRequests(f).at(-1)?.get('grant_type')).toBe('refresh_token');
});
