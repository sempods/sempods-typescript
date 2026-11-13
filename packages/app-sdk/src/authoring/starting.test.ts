/**
 * `AppSnapshot.starting` (#304): true from `start()` until the first usable
 * screen, then false for the controller's lifetime. React-free.
 */
import { afterEach, expect, it, vi } from 'vitest';
import type { PodFetch } from '@sempods/client-sdk';
import {
  catalogue,
  deferred,
  fixture,
  memoryStorage,
  settleLease,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntimeOptions } from '../runtime/types.js';
import { createAppController, demandSelection } from './app.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});

/** A saved session, then a reload with discovery and catalogue held. */
async function staged(
  mode: 'required' | 'on-demand',
  overrides: Partial<BrowserRuntimeOptions> = {},
) {
  // The signed-in Context (`work`) is remembered for the reload.
  const f = fixture({ preferences: memoryStorage(), ...overrides });
  const signed = await f.login();
  signed.runtime.dispose();
  await settleLease();
  const discovery = deferred<boolean>();
  const contexts = deferred<Response>();
  f.setCatalogue(() => contexts.promise);
  const fetch: PodFetch = async (url, init) => {
    if (
      url.endsWith('/.well-known/oauth-protected-resource') &&
      !(await discovery.promise)
    )
      return new Response(null, { status: 503 });
    return f.fetch(url, init);
  };
  const runtime = createBrowserRuntime({ ...f.options, fetch });
  cleanups.push(() => runtime.dispose());
  const app = createAppController(runtime, { contextSelection: mode });
  const seen: boolean[] = [];
  cleanups.push(
    app.subscribe(() => {
      const value = app.getSnapshot().starting;
      if (seen.at(-1) !== value) seen.push(value);
    }),
  );
  return { f, runtime, app, seen, discovery, contexts, id: signed.id };
}

it('starts true and stays true while startup settles and the active connection restores', async () => {
  const s = await staged('on-demand');
  expect(s.app.getSnapshot().starting).toBe(true);
  s.app.start();
  cleanups.push(() => s.app.stop());
  await vi.waitFor(() => expect(s.app.getSnapshot().startup).toBeDefined());
  expect(s.runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
  expect(s.app.getSnapshot().starting).toBe(true);
  s.discovery.resolve(true);
  // On demand without a selection demand: the readable Pod is the first screen.
  await vi.waitFor(() => expect(s.app.getSnapshot().starting).toBe(false));
  expect(s.app.getSnapshot().pod?.getSnapshot().read).toBe(true);
  expect(s.seen).toEqual([true, false]);
});

it.each([
  ['required', false],
  ['on-demand', true],
] as const)(
  'covers the first catalogue (%s, selection demanded: %s)',
  async (mode, demanded) => {
    const s = await staged(mode);
    if (demanded) demandSelection(s.app, true);
    s.app.start();
    cleanups.push(() => s.app.stop());
    s.discovery.resolve(true);
    await vi.waitFor(() =>
      expect(s.runtime.getSnapshot()[0]?.session.kind).toBe('active'),
    );
    // On demand, the demanding flow (TargetScreen) starts the catalogue.
    if (demanded) void s.runtime.loadContexts(s.id);
    await vi.waitFor(() =>
      expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
    );
    expect(s.app.getSnapshot().starting).toBe(true);
    s.contexts.resolve(catalogue());
    await vi.waitFor(() => expect(s.app.getSnapshot().starting).toBe(false));
    // The remembered Context was confirmed: its view is the first screen.
    expect(s.app.getSnapshot().view).not.toBeNull();
    expect(s.seen).toEqual([true, false]);
  },
);

it('never turns true again: a later Context demand and catalogue load keep their own states', async () => {
  const s = await staged('on-demand');
  s.app.start();
  cleanups.push(() => s.app.stop());
  s.discovery.resolve(true);
  await vi.waitFor(() => expect(s.app.getSnapshot().starting).toBe(false));
  demandSelection(s.app, true);
  void s.runtime.loadContexts(s.id);
  await vi.waitFor(() =>
    expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
  );
  expect(s.app.getSnapshot().starting).toBe(false);
  s.contexts.resolve(catalogue());
  await s.runtime.retryRestore(s.id);
  expect(s.seen).toEqual([true, false]);
});

it('ends at the prompt of an unreachable active Pod', async () => {
  const s = await staged('required');
  s.app.start();
  cleanups.push(() => s.app.stop());
  s.discovery.resolve(false);
  await vi.waitFor(() => expect(s.app.getSnapshot().starting).toBe(false));
  expect(s.runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    restorable: true,
  });
  expect(s.app.getSnapshot().access.prompts).toEqual([
    expect.objectContaining({ reason: 'unreachable' }),
  ]);
});

it('ends at the gate of a connection without a required scope', async () => {
  const s = await staged('required', { scopes: { required: ['tasks'] } });
  s.app.start();
  cleanups.push(() => s.app.stop());
  s.discovery.resolve(true);
  await vi.waitFor(() => expect(s.app.getSnapshot().starting).toBe(false));
  expect(s.app.getSnapshot().access.blocking).toMatchObject({
    reason: 'missing-scopes',
  });
});

it('ends at the gate without a saved connection', async () => {
  const f = fixture({ preferences: null });
  cleanups.push(() => f.runtime.dispose());
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  await vi.waitFor(() => expect(app.getSnapshot().starting).toBe(false));
  expect(app.getSnapshot().access.blocking).toMatchObject({
    reason: 'no-connection',
  });
});

it('ends at a failed first catalogue', async () => {
  const s = await staged('required');
  s.app.start();
  cleanups.push(() => s.app.stop());
  s.discovery.resolve(true);
  await vi.waitFor(() =>
    expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
  );
  s.contexts.resolve(new Response(null, { status: 503 }));
  await vi.waitFor(() => expect(s.app.getSnapshot().starting).toBe(false));
  expect(s.runtime.getSnapshot()[0]?.catalogue.kind).toBe('failed');
});
