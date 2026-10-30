// @vitest-environment jsdom
/** The "clear done tasks" recipe: one decision over captured rows (#189). */
import { webcrypto } from 'node:crypto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ClearDoneExample } from '../../../../examples/todo/recipes/clear-done.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  resourceIri,
  work,
} from '../runtime/fixture.test.js';

const runtimes: BrowserRuntime[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  runtimes.splice(0).forEach((r) => r.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const schema = 'https://schema.org/';
const done = schema + 'CompletedActionStatus';
const open = schema + 'PotentialActionStatus';
type Task = { title: string; status: string; version: number };

async function setup(
  initial: [string, string, boolean][] = [
    ['urn:a', 'Milk', true],
    ['urn:b', 'Bread', true],
    ['urn:c', 'Eggs', false],
    ['urn:d', 'Tea', true],
  ],
) {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  const tasks = new Map<string, Map<string, Task>>([
    [
      work,
      new Map(
        initial.map(([iri, title, isDone]) => [
          iri,
          { title, status: isDone ? done : open, version: 1 },
        ]),
      ),
    ],
    [personal, new Map()],
  ]);
  const body = (iri: string, task: Task) => ({
    '@id': iri,
    '@type': [schema + 'Action'],
    [schema + 'name']: [{ '@value': task.title }],
    [schema + 'actionStatus']: [{ '@id': task.status }],
  });
  const deletes: string[] = [];
  const control = { held: null as Promise<void> | null };
  f.setQuery(async (url) => {
    const context = new URL(url).searchParams.get('default-graph-uri')!;
    return Response.json(
      [...(tasks.get(context) ?? [])].map(([iri, task]) => body(iri, task)),
    );
  });
  f.setResource(async (url, init) => {
    const context = new URL(url).searchParams.get('context')!;
    const iri = resourceIri(url);
    const task = tasks.get(context)?.get(iri);
    if ((init?.method ?? 'GET') === 'GET')
      return task
        ? Response.json(body(iri, task), {
            headers: { etag: `"t${task.version}"` },
          })
        : new Response(null, { status: 404 });
    deletes.push(iri);
    await control.held;
    if (!task) return new Response(null, { status: 404 });
    // Only the version the row showed is deleted.
    if (new Headers(init?.headers).get('if-match') !== `"t${task.version}"`)
      return new Response(null, { status: 412 });
    tasks.get(context)!.delete(iri);
    return new Response(null, { status: 204 });
  });
  render(<ClearDoneExample runtime={session.runtime} />);
  await screen.findByText('Milk', { exact: false });
  return { ...f, ...session, tasks, deletes, control };
}

const clear = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Clear done tasks' }));
const question = () => screen.findByRole('alertdialog');
const confirm = async () =>
  fireEvent.click(
    within(await question()).getByRole('button', { name: 'Delete' }),
  );

it('asks with the captured number and sends nothing on Cancel', async () => {
  const { deletes } = await setup();
  clear();
  expect((await question()).textContent).toContain(
    'Delete 3 done tasks from this list?',
  );
  fireEvent.click(
    within(await question()).getByRole('button', { name: 'Cancel' }),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(deletes).toEqual([]);
});

it('removes every captured done row one after the other and keeps open ones', async () => {
  const { deletes } = await setup();
  clear();
  await confirm();
  expect(
    (await screen.findByText('3 tasks deleted.')).getAttribute('role'),
  ).toBe('status');
  expect(deletes).toEqual(['urn:a', 'urn:b', 'urn:d']);
  await waitFor(() => expect(screen.queryByText(/Milk/)).toBeNull());
  expect(screen.getByText(/Eggs/)).toBeTruthy();
});

it('uses the singular for one row', async () => {
  await setup([['urn:a', 'Milk', true]]);
  clear();
  expect((await question()).textContent).toContain(
    'Delete 1 done task from this list?',
  );
  await confirm();
  await screen.findByText('1 task deleted.');
});

it('stops at a row reopened elsewhere, never deletes it and keeps the rest unsent', async () => {
  const { deletes, tasks } = await setup();
  clear();
  await question();
  // Reopened on another device after the list was read: its IRI still exists.
  const bread = tasks.get(work)!.get('urn:b')!;
  bread.status = open;
  bread.version++;
  await confirm();
  const summary = await screen.findByText(/^1 task deleted\./);
  expect(summary.getAttribute('role')).toBe('alert');
  expect(summary.textContent).toBe(
    '1 task deleted. One task needs your attention; see its notice. 1 task was not sent.',
  );
  // Its comparison read finds the change, so not even a DELETE is sent.
  expect(deletes).toEqual(['urn:a']);
  expect(tasks.get(work)!.has('urn:b')).toBe(true);
  expect(tasks.get(work)!.has('urn:d')).toBe(true);
  // The stopped row keeps its SDK recovery with a comparison.
  expect(
    (await screen.findAllByRole('alert')).some((n) =>
      n.textContent?.includes('changed'),
    ),
  ).toBe(true);
});

it('does not include rows that appear after the decision was captured', async () => {
  const { deletes, tasks, runtime } = await setup();
  clear();
  await question();
  tasks.get(work)!.set('urn:e', { title: 'Late', status: done, version: 1 });
  // The page becomes visible again and the list reads once more.
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await screen.findByText(/Late/);
  await confirm();
  await screen.findByText('3 tasks deleted.');
  expect(deletes).not.toContain('urn:e');
  expect(runtime).toBeDefined();
});

it('sends nothing more once the Context changed', async () => {
  const { deletes, runtime, id, control, tasks } = await setup();
  const first = deferred<void>();
  control.held = first.promise;
  clear();
  await confirm();
  await waitFor(() => expect(deletes).toEqual(['urn:a']));
  // Another Context is chosen while the first removal is in flight.
  await act(async () => {
    runtime.selectContext(id, personal);
    first.resolve();
  });
  // The screen now shows the other list; the summary belonged to the old one.
  await waitFor(() => expect(screen.queryByText(/Bread/)).toBeNull());
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(deletes).toEqual(['urn:a']);
  expect([...tasks.get(work)!.keys()]).toEqual(['urn:b', 'urn:c', 'urn:d']);
});

it('sends nothing more after write access is lost', async () => {
  const { deletes, runtime, id, control, setCatalogue } = await setup();
  const first = deferred<void>();
  control.held = first.promise;
  clear();
  await confirm();
  await waitFor(() => expect(deletes).toEqual(['urn:a']));
  setCatalogue(async () => catalogue([work, personal], []));
  await act(() => runtime.loadContexts(id));
  first.resolve();
  await screen.findByText(
    '1 task deleted. The list or its access changed. 2 tasks were not sent.',
  );
  expect(deletes).toEqual(['urn:a']);
});
