// @vitest-environment jsdom
/**
 * A saved session whose Pod cannot be reached at startup is not a sign-out: it
 * stays restorable, comes back when the browser is online again, and can be
 * retried explicitly. Any other restoration failure ends it as before.
 */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import type { BrowserRuntime } from './types.js';
import { fixture, restored, settleLease } from './fixture.test.js';

const runtimes: BrowserRuntime[] = [];
const keep = (runtime: BrowserRuntime) => (runtimes.push(runtime), runtime);
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.unstubAllGlobals();
});

/** A signed-in session, then a fresh start while `discovery` answers. */
async function restart(discovery: 'offline' | 'unavailable' | 'changed') {
  const f = fixture({ preferences: null });
  const { runtime, id } = await f.login();
  runtime.dispose();
  await settleLease();
  const original = f.fetch.getMockImplementation()!;
  const state = { down: true };
  f.fetch.mockImplementation(async (url, init) => {
    if (state.down && url.includes('/.well-known/')) {
      if (discovery === 'offline') throw new TypeError('Failed to fetch');
      if (discovery === 'unavailable')
        return new Response(null, { status: 503 });
      if (url.endsWith('/oauth-authorization-server')) {
        const answer = await original(url, init);
        const metadata = (await answer.json()) as Record<string, unknown>;
        return Response.json({
          ...metadata,
          token_endpoint: String(metadata.issuer) + '/elsewhere/token',
        });
      }
    }
    return original(url, init);
  });
  const next = keep(createBrowserRuntime(f.options));
  await next.initialize();
  await restored(next);
  return { f, runtime: next, id, state };
}
const session = (runtime: BrowserRuntime) => runtime.getSnapshot()[0]?.session;

it.each([
  ['offline', 'network'],
  ['unavailable', 'discovery'],
] as const)(
  'keeps a session restorable when its Pod is %s and restores it on demand',
  async (discovery, problem) => {
    const { f, runtime, id, state } = await restart(discovery);
    expect(session(runtime)).toMatchObject({
      kind: 'ended',
      problem,
      restorable: true,
    });
    // Still unreachable: the retry ends restorable again, nothing else changes.
    await runtime.retryRestore(id);
    expect(session(runtime)).toMatchObject({ kind: 'ended', restorable: true });
    const tokens = f.count('/token');
    state.down = false;
    const seen: string[] = [];
    const off = runtime.subscribe(() => seen.push(session(runtime)!.kind));
    await runtime.retryRestore(id);
    off();
    expect(seen[0]).toBe('restoring');
    expect(session(runtime)).toMatchObject({ kind: 'active' });
    // Restoring reuses the saved session: no new sign-in, no token request.
    expect(f.count('/token')).toBe(tokens);
    expect(f.navigate).toHaveBeenCalledTimes(1);
    await runtime.loadContexts(id);
    expect(runtime.getSnapshot()[0]?.catalogue.kind).toBe('ready');
  },
);

it('restores unreachable sessions when the browser comes back online', async () => {
  const { runtime, state } = await restart('offline');
  expect(session(runtime)).toMatchObject({ kind: 'ended', restorable: true });
  state.down = false;
  window.dispatchEvent(new Event('online'));
  await vi.waitFor(() =>
    expect(session(runtime)).toMatchObject({ kind: 'active' }),
  );
});

it('ends a session whose Pod changed its binding, without a retry', async () => {
  const { runtime, id, state } = await restart('changed');
  const ended = session(runtime);
  expect(ended).toMatchObject({ kind: 'ended' });
  expect(ended).not.toHaveProperty('restorable');
  state.down = false;
  await runtime.retryRestore(id);
  window.dispatchEvent(new Event('online'));
  await settleLease();
  expect(session(runtime)).toBe(ended);
});

it('does nothing for an active session and stops listening once disposed', async () => {
  const { runtime, id, state } = await restart('offline');
  state.down = false;
  await runtime.retryRestore(id);
  const active = session(runtime);
  expect(active).toMatchObject({ kind: 'active' });
  await runtime.retryRestore(id);
  expect(session(runtime)).toBe(active);
  const removed = vi.spyOn(window, 'removeEventListener');
  runtime.dispose();
  expect(removed).toHaveBeenCalledWith('online', expect.any(Function));
});
