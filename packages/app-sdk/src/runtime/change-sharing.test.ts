/**
 * Changing sharing (#362): only an explicit request to change what the app
 * may access asks the Pod for its consent page (`prompt=consent`). A sign-in
 * may reuse the app's grant, and restoring or renewing a saved session at
 * startup never authorizes interactively; neither inherits the request.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import { createBrowserRuntime } from './runtime.js';
import { RuntimeError } from './errors.js';
import type { BrowserRuntime } from './types.js';
import {
  fixture,
  fixtureNamespace,
  jwt,
  restored,
  settleLease,
} from './fixture.test.js';
import { openSessionStore } from '../sessions/store.js';

const runtimes: BrowserRuntime[] = [];
const realNow = Date.now.bind(Date);
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
});
const keep = (runtime: BrowserRuntime) => {
  runtimes.push(runtime);
  return runtime;
};
let issued = 0;
const rotating: PodFetch = async () =>
  Response.json({
    access_token: jwt(),
    token_type: 'Bearer',
    refresh_token: 'refresh-' + ++issued,
  });
const asked = (f: ReturnType<typeof fixture>) =>
  new URL(f.navigate.mock.calls.at(-1)![0]);
async function stored(f: ReturnType<typeof fixture>, id: string) {
  const store = await openSessionStore(fixtureNamespace, f.factory);
  try {
    return (await store.read(id))?.value;
  } finally {
    store.close();
  }
}
/** A fresh start without a callback, as after a reload or a later visit. */
async function startup(f: ReturnType<typeof fixture>, current: BrowserRuntime) {
  current.dispose();
  await settleLease();
  const next = keep(
    createBrowserRuntime({
      ...f.options,
      location: () => 'https://app.example/',
    }),
  );
  await next.initialize();
  await restored(next);
  return next;
}
/** Signed in with a grant the Pod could reuse. */
async function signedIn() {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  f.setToken(rotating);
  const first = await f.begin();
  // The first sign-in asks for no consent of its own.
  expect(first.authorization.searchParams.has('prompt')).toBe(false);
  f.runtime.dispose();
  await settleLease();
  const runtime = keep(f.returned(first.authorization));
  expect(await runtime.initialize()).toMatchObject({
    interaction: 'completed',
  });
  return { f, runtime, id: first.connection.id };
}

it('asks the Pod for its consent page only when the person changes sharing', async () => {
  const { f, runtime, id } = await signedIn();
  await runtime.beginAuthorization(id, { intent: 'change-sharing' });
  const sharing = asked(f);
  expect(sharing.pathname).toBe('/alice/_system/auth/authorize');
  expect(sharing.searchParams.getAll('prompt')).toEqual(['consent']);
  // The attempt is the same as a sign-in's; nothing stores the request.
  expect(JSON.stringify(await stored(f, id))).not.toContain('prompt');
  expect(JSON.stringify(await stored(f, id))).not.toContain('consent');

  // The consent page answers like a sign-in: the new grant replaces the old.
  runtime.dispose();
  await settleLease();
  const back = keep(f.returned(sharing));
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  expect(back.getSnapshot()[0]?.session.kind).toBe('active');

  // A later sign-in may reuse the grant again: no inherited consent request.
  await back.beginAuthorization(id);
  expect(asked(f).searchParams.has('prompt')).toBe(false);
  await back.beginAuthorization(id, { intent: 'sign-in' });
  expect(asked(f).searchParams.has('prompt')).toBe(false);
});

it('resumes the earlier session when the person cancels on the consent page', async () => {
  const { f, runtime, id } = await signedIn();
  await runtime.beginAuthorization(id, { intent: 'change-sharing' });
  const sharing = asked(f);
  runtime.dispose();
  await settleLease();
  const tokens = f.count('/token');
  const back = keep(f.returned(sharing, 'error=access_denied'));
  expect(await back.initialize()).toMatchObject({
    interaction: 'cancelled',
    resumed: true,
  });
  expect(f.count('/token')).toBe(tokens);
  expect(back.getSnapshot()[0]?.session.kind).toBe('active');
});

it('restores and renews a saved session at startup without authorizing, also after changing sharing', async () => {
  const { f, runtime, id } = await signedIn();
  await runtime.beginAuthorization(id, { intent: 'change-sharing' });
  runtime.dispose();
  await settleLease();
  const back = keep(f.returned(asked(f)));
  await back.initialize();
  const navigations = f.navigate.mock.calls.length;

  // A valid saved session: restored as it is.
  const tokens = f.count('/token');
  const valid = await startup(f, back);
  expect(valid.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.count('/token')).toBe(tokens);

  // A due one: renewed with its refresh token, never by a redirect.
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 3600_000);
  const due = await startup(f, valid);
  expect(due.getSnapshot()[0]?.session.kind).toBe('active');
  expect(f.count('/token')).toBe(tokens + 1);
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
});

it('keeps the existing recovery when a saved session cannot be restored', async () => {
  const { f, runtime } = await signedIn();
  const navigations = f.navigate.mock.calls.length;
  f.setToken(async () =>
    Response.json({ error: 'invalid_grant' }, { status: 400 }),
  );
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 2 * 3600_000);
  const next = await startup(f, runtime);
  expect(next.getSnapshot()[0]?.session).toMatchObject({ kind: 'ended' });
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
});

it('rejects an unknown intent before any request or change', async () => {
  const { f, runtime, id } = await signedIn();
  const requests = f.fetch.mock.calls.length;
  const navigations = f.navigate.mock.calls.length;
  await expect(
    runtime.beginAuthorization(id, {
      intent: 'consent' as unknown as 'sign-in',
    }),
  ).rejects.toEqual(new RuntimeError('configuration'));
  expect(f.fetch).toHaveBeenCalledTimes(requests);
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
});
