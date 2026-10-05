import { afterEach, expect, it, vi } from 'vitest';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  fixture,
  catalogue,
  work,
  personal,
  deferred,
  jwt,
  settleLease,
} from '../runtime/fixture.test.js';
import { bindResourceEditor } from './editor.js';
import { createAppController } from './app.js';
import { createViewLoader } from './load.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
});
async function connected() {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  return { ...f, ...session };
}
const title = fields({ title: text('urn:name', { language: null }) });
const body = { '@id': 'urn:item', 'urn:name': [{ '@value': 'Original' }] };
it('view subscriptions retain lifetime across refresh and expose only accepted access', async () => {
  const f = await connected();
  const original = f.view.getSnapshot();
  const listener = vi.fn();
  const off = f.view.subscribe(listener);
  await f.runtime.loadContexts(f.id);
  expect(f.runtime.bind(f.id)).toBe(f.view);
  expect(f.view.getSnapshot().revision).toBe(original.revision);
  f.setCatalogue(async () => catalogue([work, personal], []));
  await f.runtime.loadContexts(f.id);
  expect(f.view.getSnapshot()).toMatchObject({
    current: true,
    read: true,
    write: false,
  });
  f.setCatalogue(async () => new Response(null, { status: 500 }));
  await expect(f.runtime.loadContexts(f.id)).rejects.toThrow();
  expect(f.view.getSnapshot()).toMatchObject({
    read: true,
    write: false,
    catalogue: 'failed',
  });
  off();
  const calls = listener.mock.calls.length;
  f.runtime.dispose();
  expect(listener).toHaveBeenCalledTimes(calls);
  expect(f.view.getSnapshot().current).toBe(false);
});
it('same-target editor keeps drafts for write/read loss and clears its usable baseline', async () => {
  const f = await connected();
  f.setResource(async () => Response.json(body, { headers: { etag: '"v1"' } }));
  const editor = bindResourceEditor(f.view, 'urn:item', title);
  cleanups.push(() => editor.dispose());
  await editor.loaded;
  editor.change({ title: 'Mine' });
  await f.runtime.loadContexts(f.id);
  expect(editor.state).toMatchObject({
    draft: { title: 'Mine' },
    canSave: true,
  });
  f.setCatalogue(async () => catalogue([work, personal], []));
  await f.runtime.loadContexts(f.id);
  expect(editor.state).toMatchObject({
    draft: { title: 'Mine' },
    canSave: false,
  });
  f.setCatalogue(async () => catalogue([personal], []));
  await f.runtime.loadContexts(f.id);
  expect(editor.state).toMatchObject({
    draft: { title: 'Mine' },
    phase: 'blocked',
    canSave: false,
  });
  f.setCatalogue(async () => catalogue());
  await f.runtime.loadContexts(f.id);
  await vi.waitFor(() => expect(editor.state.phase).toBe('review'));
  expect(editor.state.draft).toEqual({ title: 'Mine' });
});
it.each(['read', 'save'] as const)(
  'recovers when read access is lost and regained during a %s',
  async (operation) => {
    const f = await connected();
    let stored = { ...body };
    let etag = 1;
    const gate = deferred<void>();
    let hold: 'GET' | 'PATCH' | null = null;
    f.setResource(async (_url, init) => {
      const method = init?.method ?? 'GET';
      if (method === hold) {
        hold = null;
        await gate.promise;
      }
      if (method === 'PATCH') {
        const change = JSON.parse(init!.body as string) as typeof body;
        stored = { ...stored, ...change };
        etag++;
        return new Response(null, { status: 204 });
      }
      return Response.json(stored, { headers: { etag: `"v${etag}"` } });
    });
    const editor = bindResourceEditor(f.view, 'urn:item', title);
    cleanups.push(() => editor.dispose());
    await editor.loaded;
    let saving: Promise<unknown> | undefined;
    if (operation === 'read') {
      hold = 'GET';
      void editor.refresh();
    } else {
      editor.change({ title: 'Saved through loss' });
      hold = 'PATCH';
      saving = editor.save();
    }
    // Access is lost and returns while that request is still pending.
    f.setCatalogue(async () => catalogue([personal], []));
    await f.runtime.loadContexts(f.id);
    expect(editor.state.problem).toEqual({ kind: 'refused', status: 403 });
    f.setCatalogue(async () => catalogue());
    await f.runtime.loadContexts(f.id);
    gate.resolve();
    await saving;
    await vi.waitFor(() =>
      expect(editor.state).toMatchObject({
        phase: 'ready',
        problem: null,
        dirty: false,
        canRemove: true,
      }),
    );
    expect(editor.state.draft).toEqual({
      title: operation === 'read' ? 'Original' : 'Saved through loss',
    });
  },
);
it('A → B → A creates a new target lifetime and invalidates old subscriptions', async () => {
  const f = await connected();
  const listener = vi.fn();
  f.view.subscribe(listener);
  f.runtime.selectContext(f.id, personal);
  expect(f.view.getSnapshot().current).toBe(false);
  f.runtime.selectContext(f.id, work);
  expect(f.runtime.bind(f.id).key).not.toBe(f.view.key);
  expect(listener).toHaveBeenCalled();
});
it('guards target and row changes, with busy writes unconditionally blocking', async () => {
  const f = await connected();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  let dirty = true;
  let busy = false;
  const discarded = vi.fn(() => {
    dirty = false;
  });
  app.register({ dirty: () => dirty, blocked: () => busy, discard: discarded });
  const change = app.selectContext(personal);
  expect(app.getSnapshot().confirmingLeave).toBe(true);
  app.cancelLeave();
  expect(await change).toBe(false);
  expect(f.runtime.bind(f.id)).toBe(f.view);
  const next = app.selectContext(personal);
  await app.confirmLeave();
  expect(await next).toBe(true);
  expect(discarded).toHaveBeenCalledOnce();
  busy = true;
  const row = vi.fn();
  expect(await app.navigate(row)).toBe(false);
  expect(row).not.toHaveBeenCalled();
});
it('retries an invalidated custom read once, never indefinitely', async () => {
  const f = await connected();
  const read = vi.fn(async () => ({ kind: 'invalidated' }) as const);
  const loader = createViewLoader(f.view, read);
  cleanups.push(() => loader.dispose());
  await loader.reload();
  expect(read).toHaveBeenCalledTimes(2);
  expect(loader.getSnapshot().kind).toBe('unavailable');
});
it('cancellation and a target switch discard an ignored-abort completion without retry', async () => {
  for (const mode of ['cancel', 'switch'] as const) {
    const f = await connected();
    const gate = deferred<{ kind: 'ok'; body: string }>();
    const read = vi.fn(() => gate.promise);
    const loader = createViewLoader(f.view, read);
    cleanups.push(() => loader.dispose());
    const pending = loader.reload();
    if (mode === 'cancel') loader.cancel();
    else f.runtime.selectContext(f.id, personal);
    gate.resolve({ kind: 'ok', body: 'stale' });
    await pending;
    expect(loader.getSnapshot().kind).toBe(
      mode === 'cancel' ? 'cancelled' : 'unavailable',
    );
    expect(read).toHaveBeenCalledOnce();
  }
});
it('read recovery retries once and write-only loss retains the displayed result', async () => {
  const f = await connected();
  const read = vi.fn(async () => ({ kind: 'ok', body: 'visible' }) as const);
  const loader = createViewLoader(f.view, read);
  cleanups.push(() => loader.dispose());
  await loader.reload();
  f.setCatalogue(async () => catalogue([work, personal], []));
  await f.runtime.loadContexts(f.id);
  expect(loader.getSnapshot()).toEqual({ kind: 'ready', data: 'visible' });
  expect(read).toHaveBeenCalledOnce();
  f.setCatalogue(async () => catalogue([personal], []));
  await f.runtime.loadContexts(f.id);
  expect(loader.getSnapshot().kind).toBe('unavailable');
  f.setCatalogue(async () => catalogue());
  await f.runtime.loadContexts(f.id);
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(loader.getSnapshot()).toEqual({ kind: 'ready', data: 'visible' });
});

it('exhausted recovery cancels even an ignored-abort retry and never publishes its late data', async () => {
  const f = await connected();
  const first = deferred<{ kind: 'ok'; body: string }>();
  const second = deferred<{ kind: 'ok'; body: string }>();
  const read = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);
  const loader = createViewLoader(f.view, read);
  cleanups.push(() => loader.dispose());
  const pending = loader.reload();
  f.setCatalogue(async () => catalogue([work, personal], []));
  await f.runtime.loadContexts(f.id);
  expect(read).toHaveBeenCalledTimes(2);
  f.setCatalogue(async () => catalogue());
  await f.runtime.loadContexts(f.id);
  expect(loader.getSnapshot().kind).toBe('unavailable');
  first.resolve({ kind: 'ok', body: 'old' });
  second.resolve({ kind: 'ok', body: 'also old' });
  await pending;
  await Promise.resolve();
  expect(loader.getSnapshot().kind).toBe('unavailable');
  expect(read).toHaveBeenCalledTimes(2);
});

it('does not publish startup completion after the controller is stopped', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  const gate = deferred<Awaited<ReturnType<typeof f.runtime.initialize>>>();
  vi.spyOn(f.runtime, 'initialize').mockReturnValue(gate.promise);
  const app = createAppController(f.runtime);
  const notified = vi.fn();
  app.subscribe(notified);
  app.start();
  app.stop();
  const before = notified.mock.calls.length;
  gate.resolve({ storage: 'durable', interaction: 'none', unreadable: [] });
  await Promise.resolve();
  expect(notified).toHaveBeenCalledTimes(before);
  app.start();
  await Promise.resolve();
  expect(app.getSnapshot().startup?.storage).toBe('durable');
  app.stop();
});

it('keeps a dirty draft when a target disappears during leave confirmation', async () => {
  const f = await connected();
  f.setResource(async () => Response.json(body, { headers: { etag: '"v1"' } }));
  const editor = bindResourceEditor(f.view, 'urn:item', title);
  await editor.loaded;
  editor.change({ title: 'Mine' });
  cleanups.push(() => editor.dispose());
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  const discard = vi.fn(() => editor.discard());
  app.register({
    dirty: () => editor.state.dirty,
    blocked: () => false,
    discard,
  });
  const navigation = app.selectContext(personal);
  f.setCatalogue(async () => catalogue([work], [work]));
  await f.runtime.loadContexts(f.id);
  await expect(app.confirmLeave()).rejects.toThrow();
  expect(await navigation).toBe(false);
  expect(discard).not.toHaveBeenCalled();
  expect(editor.state.draft).toEqual({ title: 'Mine' });
  expect(app.getSnapshot().view).toBe(f.view);
});
it('discards captured guards after successful navigation even if rendering unregistered them', async () => {
  const f = await connected();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  const discard = vi.fn();
  const unregister = app.register({
    dirty: () => true,
    blocked: () => false,
    discard,
  });
  const navigation = app.navigate(() => unregister());
  await app.confirmLeave();
  expect(await navigation).toBe(true);
  expect(discard).toHaveBeenCalledOnce();
});

it('a throwing host discard neither fails the navigation nor skips other guards', async () => {
  const f = await connected();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  const reported: unknown[] = [];
  vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((task) => {
    try {
      task();
    } catch (error) {
      reported.push(error);
    }
  });
  const failing = new Error('host discard failed');
  const discard = vi.fn();
  app.register({
    dirty: () => true,
    blocked: () => false,
    discard: () => {
      throw failing;
    },
  });
  app.register({ dirty: () => true, blocked: () => false, discard });
  const navigation = app.navigate(() => {});
  await app.confirmLeave();
  expect(await navigation).toBe(true);
  expect(discard).toHaveBeenCalledOnce();
  expect(reported).toEqual([failing]);
});

it('local navigation discards only local guards while target changes warn about unresolved writes', async () => {
  const f = await connected();
  const app = createAppController(f.runtime);
  app.start();
  cleanups.push(() => app.stop());
  let rowDirty = true;
  let unresolved = true;
  const discardRow = vi.fn(() => {
    rowDirty = false;
  });
  const discardOutcome = vi.fn(() => {
    unresolved = false;
  });
  app.register({
    scope: 'local',
    dirty: () => rowDirty,
    blocked: () => false,
    discard: discardRow,
  });
  app.register({
    scope: 'target',
    dirty: () => unresolved,
    unconfirmed: () => unresolved,
    blocked: () => false,
    discard: discardOutcome,
  });
  const row = app.navigate(() => {});
  expect(app.getSnapshot().unconfirmedLeave).toBe(false);
  await app.confirmLeave();
  expect(await row).toBe(true);
  expect(discardRow).toHaveBeenCalledOnce();
  expect(discardOutcome).not.toHaveBeenCalled();
  const target = app.selectContext(personal);
  expect(app.getSnapshot().unconfirmedLeave).toBe(true);
  await app.confirmLeave();
  expect(await target).toBe(true);
  expect(discardOutcome).toHaveBeenCalledOnce();
  expect(app.getSnapshot().unconfirmedLeave).toBe(false);
});

it.each([false, true])(
  'publishes changing throughout preparation, including confirmed navigation (%s)',
  async (dirty) => {
    const f = await connected();
    const app = createAppController(f.runtime);
    app.start();
    cleanups.push(() => app.stop());
    app.register({
      dirty: () => dirty,
      blocked: () => false,
      discard: () => {},
    });
    const preparation = deferred<void>();
    vi.spyOn(f.runtime, 'beginAuthorization').mockImplementation(() => {
      expect(app.getSnapshot().changing).toBe(true);
      return preparation.promise;
    });
    const navigation = app.authorize(f.id);
    const confirmation = dirty ? app.confirmLeave() : Promise.resolve();
    expect(app.getSnapshot().changing).toBe(true);
    expect(
      await app.navigate(() => {
        throw new Error('Must not navigate');
      }),
    ).toBe(false);
    preparation.resolve();
    await confirmation;
    expect(await navigation).toBe(true);
    expect(app.getSnapshot().changing).toBe(false);
  },
);

it('activates the completed callback connection without choosing a context or resetting later user selection', async () => {
  const f = await connected();
  const otherPod = 'https://pod.example/bob';
  const second = await f.runtime.connect(otherPod);
  await f.runtime.beginAuthorization(second.id);
  const auth = new URL(f.navigate.mock.calls.at(-1)![0]);
  f.runtime.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ iss: otherPod }),
      token_type: 'Bearer',
      refresh_token: 'fixture-bob',
    }),
  );
  const returned = f.returned(auth);
  cleanups.push(() => returned.dispose());
  const app = createAppController(returned);
  cleanups.push(() => app.stop());
  app.start();
  await vi.waitFor(() =>
    expect(app.getSnapshot().startup?.interaction).toBe('completed'),
  );
  expect(app.getSnapshot().startup?.connectionId).toBe(second.id);
  expect(app.getSnapshot().activeId).toBe(second.id);
  expect(app.getSnapshot().view).toBeNull();
  expect(
    app.getSnapshot().connections.find((c) => c.id === second.id)
      ?.selectedContext,
  ).toBeNull();
  await app.selectConnection(f.id);
  app.stop();
  app.start();
  await Promise.resolve();
  expect(app.getSnapshot().activeId).toBe(f.id);
});
