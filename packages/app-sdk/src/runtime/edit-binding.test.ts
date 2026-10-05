/**
 * The portable edit controller over a real runtime-bound view, with the
 * production client executor (`createPod`) behind the runtime.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { createPod, type PodFetch } from '@sempods/client-sdk';
import {
  createResourceEditor,
  fields,
  flag,
  text,
  type ResourceEditor,
} from '@sempods/client-sdk/edit';
import type { BrowserRuntime } from './types.js';
import { deferred, fixture, personal, work } from './fixture.test.js';

const NAME = 'https://schema.org/name';
const STATUS = 'https://schema.org/actionStatus';
const DONE = 'https://schema.org/CompletedActionStatus';
const OPEN = 'https://schema.org/PotentialActionStatus';
const TASK = 'https://pod.example/alice/tasks/1';
const task = fields({
  title: text(NAME, { language: null }),
  done: flag(STATUS, { on: DONE, off: OPEN }),
});

const runtimes: BrowserRuntime[] = [];
afterEach(() => runtimes.splice(0).forEach((r) => r.dispose()));

/** One stored resource per context, with strong versions and RFC 7396 patches. */
function resources() {
  const store = new Map<string, { body: Record<string, unknown>; v: number }>();
  let version = 0;
  const seen: { method: string; context: string | null; headers: Headers }[] =
    [];
  const key = (url: URL) => url.searchParams.get('context') ?? '';
  const handler: PodFetch = async (raw, init) => {
    const url = new URL(raw);
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    seen.push({ method, context: url.searchParams.get('context'), headers });
    const current = store.get(key(url));
    const etag = current ? `"v${current.v}"` : undefined;
    if (method === 'GET')
      return current
        ? Response.json(current.body, { headers: { etag: etag! } })
        : new Response(null, { status: 404 });
    if (method === 'PATCH') {
      if (!current) return new Response(null, { status: 404 });
      if (headers.get('if-match') !== etag)
        return new Response(null, { status: 412 });
      const body = { ...current.body };
      for (const [k, v] of Object.entries(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      ))
        if (v === null) delete body[k];
        else body[k] = v;
      store.set(key(url), { body, v: ++version });
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  };
  return {
    handler,
    seen,
    put(context: string, body: Record<string, unknown>) {
      store.set(context, { body, v: ++version });
    },
    body: (context: string) => store.get(context)?.body,
  };
}

async function editing() {
  const pods = resources();
  pods.put(work, {
    '@id': TASK,
    [NAME]: [{ '@value': 'Buy milk' }],
    [STATUS]: [{ '@id': OPEN }],
  });
  const f = fixture({ podFactory: createPod });
  runtimes.push(f.runtime);
  f.setResource(pods.handler);
  const session = await f.login();
  runtimes.push(session.runtime);
  const editor = createResourceEditor(session.view, TASK, task);
  await vi.waitFor(() => expect(editor.state.phase).not.toBe('loading'));
  return { ...session, f, pods, editor };
}

it('loads, saves and rebases through a runtime-bound view and the production executor', async () => {
  const { pods, editor } = await editing();
  expect(editor.state).toMatchObject({
    phase: 'ready',
    draft: { title: 'Buy milk', done: false },
  });
  editor.change({ title: 'Buy oat milk', done: false });
  expect(await editor.save()).toEqual({ kind: 'saved' });
  const patch = pods.seen.find((s) => s.method === 'PATCH')!;
  expect(patch.context).toBe(work);
  expect(patch.headers.get('if-match')).toMatch(/^"v\d+"$/);
  expect(patch.headers.get('authorization')).toMatch(/^Bearer /);
  expect(pods.body(work)?.[NAME]).toEqual([{ '@value': 'Buy oat milk' }]);

  // Another device completes the task; this editor's rename still lands.
  pods.put(work, { ...pods.body(work)!, [STATUS]: [{ '@id': DONE }] });
  // Only the title is edited here; `done` still holds the value that was read.
  editor.change({ title: 'Buy almond milk', done: false });
  expect(await editor.save()).toEqual({ kind: 'saved', alongside: true });
  expect(pods.body(work)).toMatchObject({
    [NAME]: [{ '@value': 'Buy almond milk' }],
    [STATUS]: [{ '@id': DONE }],
  });
  expect(editor.state.draft).toEqual({ title: 'Buy almond milk', done: true });
});

it('reports a read invalidated by a target switch as unavailable and keeps the draft', async () => {
  const { runtime, id, f, pods, editor } = await editing();
  editor.change({ title: 'Mine', done: false });
  const gate = deferred<void>();
  const original = pods.handler;
  f.setResource(async (url, init) => {
    await gate.promise;
    return original(url, init);
  });
  const refreshing = editor.refresh();
  // The person switches the target while the read is pending.
  runtime.selectContext(id, personal);
  gate.resolve();
  await refreshing;
  expect(editor.state).toMatchObject({
    draft: { title: 'Mine' },
    problem: { kind: 'unavailable', reason: 'invalidated' },
  });
  // The old view never writes to the new target.
  const editorOnOld: ResourceEditor<unknown> = editor;
  expect(await editorOnOld.save()).toMatchObject({ kind: 'not-saved' });
  expect(pods.seen.filter((s) => s.method === 'PATCH')).toHaveLength(0);
});
