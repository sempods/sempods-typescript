import { afterEach, expect, it, vi } from 'vitest';
import { createBrowserRuntime } from './runtime.js';
import { createAppController } from '../authoring/app.js';
import type { BrowserRuntime } from './types.js';
import { openSessionStore } from '../sessions/store.js';
import {
  callback,
  fixture,
  pod,
  restored,
  settleLease,
  work,
} from './fixture.test.js';

const other = 'https://pod.example/bob';
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
function track(runtime: BrowserRuntime) {
  cleanups.push(() => runtime.dispose());
  return runtime;
}
async function records(f: ReturnType<typeof fixture>) {
  const store = await openSessionStore(
    JSON.stringify(['dynamic', callback]),
    f.factory,
  );
  try {
    return (await store.list()).records;
  } finally {
    store.close();
  }
}

it('validates and freezes exact allowed Pods before any I/O', () => {
  const allowedPods = [pod, other];
  const f = fixture({ allowedPods });
  track(f.runtime);
  allowedPods.splice(0, 2, 'https://changed.example');
  expect(f.runtime.allowedPods).toEqual([pod, other]);
  expect(Object.isFrozen(f.runtime.allowedPods)).toBe(true);
  const openStore = vi.fn(f.options.openStore!);
  for (const list of [[], [pod, pod]])
    expect(() =>
      createBrowserRuntime({ ...f.options, openStore, allowedPods: list }),
    ).toThrow(expect.objectContaining({ problem: 'configuration' }));
  for (const invalid of [
    pod + '/',
    pod + '?',
    pod + '#',
    'not a URL',
    'http://remote.example',
    'https://POD.example/alice',
  ])
    expect(() =>
      createBrowserRuntime({ ...f.options, openStore, allowedPods: [invalid] }),
    ).toThrow(expect.objectContaining({ reason: { code: 'invalid-pod-url' } }));
  expect(() =>
    createBrowserRuntime({
      ...f.options,
      allowedPods: [other],
      preset: { podUrl: pod },
    }),
  ).toThrow(expect.objectContaining({ problem: 'configuration' }));
  expect(openStore).not.toHaveBeenCalled();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
});

it('uses the sole allowed Pod as a reusable default without starting authorization', async () => {
  const f = fixture({ allowedPods: [pod] });
  track(f.runtime);
  await f.runtime.initialize();
  const [first, second] = await Promise.all([
    f.runtime.connect(),
    f.runtime.connect(pod),
  ]);
  expect(first.id).toBe(second.id);
  expect(f.runtime.getSnapshot()).toHaveLength(1);
  expect(f.navigate).not.toHaveBeenCalled();
  const before = f.fetch.mock.calls.length;
  for (const url of [
    other,
    pod + '/child',
    pod + '.evil',
    'https://elsewhere.example/alice',
  ])
    await expect(f.runtime.connect(url)).rejects.toMatchObject({
      problem: 'configuration',
    });
  expect(f.fetch).toHaveBeenCalledTimes(before);
});

it('requires an explicit choice for a set, unless a permitted preset supplies the default', async () => {
  const f = fixture({ allowedPods: [pod, other] });
  track(f.runtime);
  await f.runtime.initialize();
  await expect(f.runtime.connect()).rejects.toMatchObject({
    problem: 'configuration',
  });
  expect(f.fetch).not.toHaveBeenCalled();
  expect((await f.runtime.connect(pod)).podUrl).toBe(pod);
  expect((await f.runtime.connect(other)).podUrl).toBe(other);
  f.runtime.dispose();
  await settleLease();
  const next = track(
    createBrowserRuntime({ ...f.options, preset: { podUrl: other } }),
  );
  await next.initialize();
  expect((await next.connect()).podUrl).toBe(other);
});

it('hides foreign saved sessions without discovery, handles or record deletion; widening restores them', async () => {
  const f = fixture({ preferences: null });
  const logged = await f.login();
  logged.runtime.dispose();
  await settleLease();
  const before = await records(f);
  f.fetch.mockClear();
  const restricted = track(
    createBrowserRuntime({ ...f.options, allowedPods: [other] }),
  );
  expect(await restricted.initialize()).toMatchObject({
    interaction: 'none',
    storage: 'durable',
    unreadable: [],
  });
  expect(restricted.getSnapshot()).toEqual([]);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(() => restricted.bind(logged.id)).toThrow();
  expect(() => restricted.selectContext(logged.id, work)).toThrow();
  await expect(restricted.beginAuthorization(logged.id)).rejects.toThrow();
  await expect(restricted.loadContexts(logged.id)).rejects.toThrow();
  const app = createAppController(restricted);
  cleanups.push(() => app.stop());
  app.start();
  await vi.waitFor(() => expect(app.getSnapshot().startup).toBeDefined());
  expect(app.getSnapshot().allowedPods).toEqual([other]);
  await expect(app.selectConnection(logged.id)).rejects.toMatchObject({
    problem: 'disconnected',
  });
  expect(app.getSnapshot().view).toBeNull();
  expect(app.getSnapshot().activeId).toBeNull();
  expect(await records(f)).toEqual(before);
  app.stop();
  restricted.dispose();
  await settleLease();
  const widened = track(createBrowserRuntime(f.options));
  await widened.initialize();
  await restored(widened);
  expect(widened.getSnapshot()[0]).toMatchObject({
    id: logged.id,
    session: { kind: 'active' },
  });
  await widened.loadContexts(logged.id);
  widened.selectContext(logged.id, work);
  expect(widened.bind(logged.id).getSnapshot().read).toBe(true);
});

it('rejects and scrubs a foreign callback without consuming its attempt or contacting that Pod', async () => {
  const f = fixture({ returnTo: '/shopping' });
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const before = await records(f);
  f.fetch.mockClear();
  const next = track(
    createBrowserRuntime({
      ...f.options,
      allowedPods: [other],
      location: () =>
        callback +
        '?code=private-code&state=' +
        authorization.searchParams.get('state'),
    }),
  );
  expect(await next.initialize()).toMatchObject({
    interaction: 'failed',
    storage: 'durable',
    problem: 'configuration',
  });
  expect(next.getSnapshot()).toEqual([]);
  expect(f.replaceUrl).toHaveBeenLastCalledWith('/shopping');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(await records(f)).toEqual(before);
  // Failure of this callback does not disable the permitted sign-in path.
  expect((await next.connect()).podUrl).toBe(other);
});

it.each([[pod], [pod, other]])(
  'keeps permitted callback, context and scope checks with policy %j',
  async (...urls) => {
    const f = fixture({
      allowedPods: urls,
      scopes: { required: ['tasks'] },
      preset: { podUrl: pod, contextIri: work },
    });
    const logged = await f.login();
    track(logged.runtime);
    expect(logged.runtime.getSnapshot()[0]!.missingRequiredScopes).toEqual([
      'tasks',
    ]);
    expect(logged.view.getSnapshot()).toMatchObject({
      read: false,
      write: false,
    });
    expect(() =>
      logged.runtime.selectContext(
        logged.id,
        pod + '/_system/contexts/personal',
      ),
    ).toThrow();
  },
);

it('guards sign-in to the sole allowed Pod and preserves a draft when cancelled', async () => {
  const f = fixture({ allowedPods: [pod] });
  const logged = await f.login();
  track(logged.runtime);
  const app = createAppController(logged.runtime);
  cleanups.push(() => app.stop());
  app.start();
  await vi.waitFor(() => expect(app.getSnapshot().startup).toBeDefined());
  const discard = vi.fn();
  app.register({
    scope: 'target',
    blocked: () => false,
    dirty: () => true,
    discard,
  });
  const before = f.fetch.mock.calls.length;
  const signingIn = app.connect();
  expect(app.getSnapshot().confirmingLeave).toBe(true);
  expect(f.fetch).toHaveBeenCalledTimes(before);
  app.cancelLeave();
  expect(await signingIn).toBe(false);
  expect(discard).not.toHaveBeenCalled();
  expect(app.getSnapshot().view).toBe(logged.view);
  const confirmed = app.connect();
  await app.confirmLeave();
  expect(await confirmed).toBe(true);
  expect(logged.runtime.getSnapshot()).toHaveLength(1);
  expect(f.navigate).toHaveBeenCalledTimes(2);
});
