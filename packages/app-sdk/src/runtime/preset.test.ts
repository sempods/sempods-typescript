import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import { createAppController } from '../authoring/app.js';
import type { BrowserRuntime, BrowserRuntimeOptions } from './types.js';
import {
  fixture,
  pod,
  personal,
  work,
  catalogue,
  callback,
  jwt,
  restored,
  settleLease,
} from './fixture.test.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
});
function track(runtime: BrowserRuntime) {
  cleanups.push(() => runtime.dispose());
  return runtime;
}
async function login(options: Partial<BrowserRuntimeOptions> = {}) {
  const f = fixture({ preset: { podUrl: pod }, preferences: null, ...options });
  track(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = track(f.returned());
  expect(await runtime.initialize()).toMatchObject({
    interaction: 'completed',
  });
  await runtime.loadContexts(connection.id);
  return { ...f, runtime, id: connection.id };
}
async function reload(
  f: Awaited<ReturnType<typeof login>>,
  options: Partial<BrowserRuntimeOptions> = {},
) {
  f.runtime.dispose();
  await settleLease();
  const runtime = track(createBrowserRuntime({ ...f.options, ...options }));
  await runtime.initialize();
  await restored(runtime);
  return runtime;
}

it('validates and freezes the preset without discovery, storage or navigation', () => {
  const preset = { podUrl: pod, contextIri: personal };
  const f = fixture({ preset });
  track(f.runtime);
  preset.podUrl = 'https://changed.example';
  expect(f.runtime.preset).toEqual({ podUrl: pod, contextIri: personal });
  expect(Object.isFrozen(f.runtime.preset)).toBe(true);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
  expect(f.runtime.getSnapshot()).toEqual([]);
  for (const invalid of [
    pod + '/',
    pod + '?',
    'http://remote.example',
    'not a URL',
  ]) {
    expect(() =>
      createBrowserRuntime({ ...f.options, preset: { podUrl: invalid } }),
    ).toThrow();
  }
  for (const contextIri of [
    '',
    'urn:task',
    work.replace('/alice/', '/bob/'),
    work + '/..',
    work + '%20',
    work + '?',
  ]) {
    expect(() =>
      createBrowserRuntime({
        ...f.options,
        preset: { podUrl: pod, contextIri },
      }),
    ).toThrow();
  }
  expect(f.fetch).not.toHaveBeenCalled();
});

it('reuses concurrent preset connections without auto-login and still allows explicit other Pods', async () => {
  const f = fixture({ preset: { podUrl: pod } });
  track(f.runtime);
  await f.runtime.initialize();
  const [a, b] = await Promise.all([
    f.runtime.connect(),
    f.runtime.connect(pod),
  ]);
  expect(a.id).toBe(b.id);
  expect(f.runtime.getSnapshot()).toHaveLength(1);
  expect(f.navigate).not.toHaveBeenCalled();
  const other = await f.runtime.connect('https://pod.example/bob');
  expect(other.podUrl).toBe('https://pod.example/bob');
  expect(f.runtime.getSnapshot()).toHaveLength(2);
});

it('keeps explicit selection when no context is configured', async () => {
  const f = await login();
  expect(f.runtime.getSnapshot()[0]!.selectedContext).toBeNull();
  f.runtime.selectContext(f.id, work);
  expect(f.runtime.bind(f.id).contextIri).toBe(work);
});

it('applies the exact read-only context after fresh catalogue evidence, never a writable alternative', async () => {
  const f = await login({ preset: { podUrl: pod, contextIri: personal } });
  const view = f.runtime.bind(f.id);
  expect(view.contextIri).toBe(personal);
  expect(view.getSnapshot()).toMatchObject({ read: true, write: false });
  expect(() => f.runtime.selectContext(f.id, work)).toThrow();
  f.setCatalogue(async () => catalogue([work], [work]));
  await f.runtime.loadContexts(f.id);
  expect(f.runtime.bind(f.id)).toBe(view);
  expect(view.getSnapshot()).toMatchObject({
    current: true,
    read: false,
    write: false,
  });
  f.setCatalogue(async () => catalogue());
  await f.runtime.loadContexts(f.id);
  expect(f.runtime.bind(f.id)).toBe(view);
  expect(view.getSnapshot().read).toBe(true);
});

it('does not bind an absent configured context; catalogue failure and recovery remain separate', async () => {
  const absent = pod + '/_system/contexts/absent';
  const f = await login({ preset: { podUrl: pod, contextIri: absent } });
  expect(f.runtime.getSnapshot()[0]!.selectedContext).toBeNull();
  expect(() => f.runtime.bind(f.id)).toThrow();
  f.setCatalogue(async () => new Response(null, { status: 503 }));
  await expect(f.runtime.loadContexts(f.id)).rejects.toThrow();
  expect(f.runtime.getSnapshot()[0]!.catalogue.kind).toBe('failed');
  f.setCatalogue(async () => catalogue([absent], []));
  await f.runtime.loadContexts(f.id);
  expect(f.runtime.bind(f.id).contextIri).toBe(absent);
});

it('configuration changes keep the namespace but override an old remembered context', async () => {
  const values = new Map<string, string>();
  const preferences = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const f = await login({ preferences });
  f.runtime.selectContext(f.id, work);
  const next = await reload(f, {
    preset: { podUrl: pod, contextIri: personal },
  });
  expect(next.getSnapshot()[0]!.id).toBe(f.id);
  expect(next.getSnapshot()[0]!.selectedContext).toBeNull();
  await next.loadContexts(f.id);
  expect(next.bind(f.id).contextIri).toBe(personal);
  expect(f.navigate).toHaveBeenCalledTimes(1);
});

it('a foreign restored session is preserved but not silently made the preset target', async () => {
  const f = await login();
  f.runtime.selectContext(f.id, work);
  const next = await reload(f, {
    preset: { podUrl: 'https://pod.example/bob' },
  });
  const app = createAppController(next);
  cleanups.push(() => app.stop());
  app.start();
  await vi.waitFor(() =>
    expect(app.getSnapshot().startup?.storage).toBe('durable'),
  );
  expect(next.getSnapshot()[0]!.session.kind).toBe('active');
  expect(app.getSnapshot().activeId).toBeNull();
  expect(await app.selectConnection(f.id)).toBe(true);
  expect(app.getSnapshot().activeId).toBe(f.id);
  next.selectContext(f.id, work);
  expect(app.getSnapshot().view?.contextIri).toBe(work);
});

it('preset selection never substitutes for required feature grants', async () => {
  const f = await login({
    preset: { podUrl: pod, contextIri: work },
    scopes: { required: ['tasks'], optional: ['ai'] },
  });
  expect(f.runtime.getSnapshot()[0]!.session.kind).toBe('active');
  expect(f.runtime.getSnapshot()[0]!.missingRequiredScopes).toEqual(['tasks']);
  expect(f.runtime.bind(f.id).getSnapshot()).toMatchObject({
    read: false,
    write: false,
  });
  // Reload keeps the existing accepted grant facts; changing the request does not grant them.
  const next = await reload(f, { scopes: { optional: ['ai'] } });
  await next.loadContexts(f.id);
  expect(next.bind(f.id).getSnapshot().read).toBe(true);
});

it('the facade guards preset sign-in and reuses the connection after failed preparation', async () => {
  const f = await login();
  f.runtime.selectContext(f.id, work);
  const app = createAppController(f.runtime);
  cleanups.push(() => app.stop());
  app.start();
  await vi.waitFor(() => expect(app.getSnapshot().startup).toBeDefined());
  const discard = vi.fn();
  const off = app.register({
    scope: 'target',
    blocked: () => false,
    dirty: () => true,
    discard,
  });
  const before = f.fetch.mock.calls.length;
  const guarded = app.connect();
  expect(app.getSnapshot().confirmingLeave).toBe(true);
  expect(f.fetch.mock.calls.length).toBe(before);
  app.cancelLeave();
  expect(await guarded).toBe(false);
  expect(discard).not.toHaveBeenCalled();
  off();
  f.fetch.mockRejectedValueOnce(new Error('offline'));
  await expect(app.connect()).rejects.toThrow();
  expect(f.runtime.getSnapshot()).toHaveLength(1);
  expect(f.runtime.getSnapshot()[0]!.session.kind).toBe('active');
  f.setToken(async () =>
    Response.json({ access_token: jwt(), token_type: 'Bearer' }),
  );
  expect(await app.connect()).toBe(true);
  expect(f.runtime.getSnapshot()).toHaveLength(1);
  expect(f.navigate).toHaveBeenCalledTimes(2);
});

it('finishes an explicitly initiated foreign callback after a preset change without deleting it', async () => {
  const f = fixture({ preset: { podUrl: pod } });
  const { connection, authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const next = track(
    createBrowserRuntime({
      ...f.options,
      preset: { podUrl: 'https://pod.example/bob' },
      location: () =>
        callback +
        '?code=fixture-code&state=' +
        authorization.searchParams.get('state'),
    }),
  );
  const app = createAppController(next);
  cleanups.push(() => app.stop());
  app.start();
  await vi.waitFor(() =>
    expect(app.getSnapshot().startup?.interaction).toBe('completed'),
  );
  expect(app.getSnapshot().activeId).toBe(connection.id);
  expect(next.getSnapshot()[0]!.podUrl).toBe(pod);
  expect(next.getSnapshot()[0]!.session.kind).toBe('active');
  expect(next.preset?.podUrl).toBe('https://pod.example/bob');
});
