// @vitest-environment jsdom
/** The "clear done tasks" recipe across the Contexts of a Pod (#389). */
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
import { ClearDoneOverviewExample } from '../../../../examples/todo/recipes/clear-done-overview.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  deferred,
  personal,
  resourceIri,
  returnedSession,
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

/**
 * work: Milk and Shared done, Eggs open; personal: the same Shared IRI and
 * Call Ann, both done. personal is writable unless `readOnly`.
 */
async function overview({ readOnly = false } = {}) {
  const f = await returnedSession((r) => void runtimes.push(r));
  f.setCatalogue(async () =>
    catalogue([work, personal], readOnly ? [work] : [work, personal]),
  );
  const task = (title: string, isDone: boolean): Task => ({
    title,
    status: isDone ? done : open,
    version: 1,
  });
  const tasks = new Map<string, Map<string, Task>>([
    [
      work,
      new Map([
        ['urn:a', task('Milk', true)],
        ['urn:s', task('Shared', true)],
        ['urn:e', task('Eggs', false)],
      ]),
    ],
    [
      personal,
      new Map([
        ['urn:s', task('Shared', true)],
        ['urn:b', task('Call Ann', true)],
      ]),
    ],
  ]);
  const body = (iri: string, t: Task) => ({
    '@id': iri,
    '@type': [schema + 'Action'],
    [schema + 'name']: [{ '@value': t.title }],
    [schema + 'actionStatus']: [{ '@id': t.status }],
  });
  const deletes: string[] = [];
  // A DELETE whose response is lost after the Pod applied it, or ones held.
  const control = {
    lose: null as string | null,
    hold: new Map<string, Promise<void>>(),
  };
  f.setQuery(async (url) => {
    const context = new URL(url).searchParams.get('default-graph-uri');
    if (!context)
      // The Pod-wide discovery of Contexts that hold the type.
      return new Response(
        JSON.stringify({
          head: { vars: ['graph'] },
          results: {
            bindings: [...tasks]
              .filter(([, items]) => items.size > 0)
              .map(([graph]) => ({ graph: { type: 'uri', value: graph } })),
          },
        }),
        { headers: { 'content-type': 'application/sparql-results+json' } },
      );
    return Response.json(
      [...(tasks.get(context) ?? [])].map(([iri, t]) => body(iri, t)),
    );
  });
  f.setResource(async (url, init) => {
    const context = new URL(url).searchParams.get('context')!;
    const iri = resourceIri(url);
    const t = tasks.get(context)?.get(iri);
    if ((init?.method ?? 'GET') === 'GET')
      return t
        ? Response.json(body(iri, t), { headers: { etag: `"t${t.version}"` } })
        : new Response(null, { status: 404 });
    const key = `${context.split('/').pop()} ${iri}`;
    deletes.push(key);
    await control.hold.get(key);
    if (!t) return new Response(null, { status: 404 });
    // Only the version the row showed is deleted.
    if (new Headers(init?.headers).get('if-match') !== `"t${t.version}"`)
      return new Response(null, { status: 412 });
    tasks.get(context)!.delete(iri);
    if (control.lose === key) throw new TypeError('Failed to fetch');
    return new Response(null, { status: 204 });
  });
  render(<ClearDoneOverviewExample runtime={f.runtime} />);
  await screen.findByText('Call Ann · personal');
  await waitFor(() => expect(bulk().hasAttribute('disabled')).toBe(false));
  return { ...f, tasks, deletes, control };
}

const bulk = () => screen.getByRole('button', { name: 'Clear done tasks' });
const question = () => screen.findByRole('dialog');
const press = async (name: 'Cancel' | 'Delete') =>
  fireEvent.click(within(await question()).getByRole('button', { name }));
const reread = () =>
  act(async () => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
/** The question's area rows: name and count. */
const areas = (dialog: HTMLElement) =>
  [...dialog.querySelectorAll('dl > div')].map((row) => [
    row.querySelector('dt')!.textContent,
    row.querySelector('dd')!.textContent,
  ]);

it('asks with the total once and the counts by area; Cancel sends nothing', async () => {
  const f = await overview();
  // Each row's own delete names its area: the same task is in both.
  expect(
    screen.getAllByRole('button', { name: /^Delete: Shared in / }).length,
  ).toBe(2);
  fireEvent.click(bulk());
  const dialog = await question();
  expect(within(dialog).getByRole('heading').textContent).toBe(
    'Delete 4 done tasks from the Pod?',
  );
  // Areas in the overview's order.
  expect(areas(dialog)).toEqual([
    ['personal', '2'],
    ['work', '2'],
  ]);
  // No read-only rows, so nothing is said about them.
  expect(dialog.textContent).not.toContain('read-only');
  await press('Cancel');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(f.deletes).toEqual([]);
});

it("asks a row's own delete with its title and area", async () => {
  const f = await overview();
  fireEvent.click(
    screen.getByRole('button', { name: 'Delete: Shared in work' }),
  );
  const dialog = screen.getByRole('alertdialog');
  expect(dialog.textContent).toContain(
    'Delete “Shared” from work? This cannot be undone.',
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(f.deletes).toEqual(['work urn:s']));
  expect(f.tasks.get(personal)!.has('urn:s')).toBe(true);
});

it('deletes the same IRI in each Context where it was read', async () => {
  const f = await overview();
  fireEvent.click(bulk());
  await press('Delete');
  expect(
    (await screen.findByText('4 tasks deleted.')).getAttribute('role'),
  ).toBe('status');
  expect(f.deletes).toEqual([
    'personal urn:s',
    'personal urn:b',
    'work urn:a',
    'work urn:s',
  ]);
  expect([...f.tasks.get(work)!.keys()]).toEqual(['urn:e']);
  expect(f.tasks.get(personal)!.size).toBe(0);
});

it('counts read-only rows as kept and never sends them', async () => {
  const f = await overview({ readOnly: true });
  fireEvent.click(bulk());
  const dialog = await question();
  expect(within(dialog).getByRole('heading').textContent).toBe(
    'Delete 2 done tasks from the Pod?',
  );
  expect(areas(dialog)).toEqual([['work', '2']]);
  expect(dialog.textContent).toContain('2 read-only tasks are kept.');
  await press('Delete');
  await screen.findByText('2 tasks deleted.');
  expect(f.deletes).toEqual(['work urn:a', 'work urn:s']);
  expect(f.tasks.get(personal)!.size).toBe(2);
});

it('leaves a task completed after the question opened', async () => {
  const f = await overview();
  fireEvent.click(bulk());
  await question();
  // Ticked on another device, and read while the question is open.
  f.tasks.get(work)!.set('urn:e', { title: 'Eggs', status: done, version: 2 });
  await reread();
  await screen.findByText('Eggs · work');
  await press('Delete');
  await screen.findByText('4 tasks deleted.');
  expect(f.deletes).not.toContain('work urn:e');
  expect(f.tasks.get(work)!.has('urn:e')).toBe(true);
});

it('stops at a reopened row and keeps its recovery once it leaves the overview', async () => {
  const f = await overview();
  fireEvent.click(bulk());
  await question();
  // Reopened elsewhere after the overview was read: its IRI still exists.
  const milk = f.tasks.get(work)!.get('urn:a')!;
  milk.status = open;
  milk.version++;
  await press('Delete');
  const summary = await screen.findByText(/^2 tasks deleted\./);
  expect(summary.getAttribute('role')).toBe('alert');
  expect(summary.textContent).toBe(
    '2 tasks deleted. “Milk” in work needs your attention; see its notice. 1 task was not sent.',
  );
  expect(f.deletes).not.toContain('work urn:s');
  expect([...f.tasks.get(work)!.keys()]).toEqual(['urn:a', 'urn:s', 'urn:e']);
  // Read again, the open row leaves this view of done tasks.
  await reread();
  await waitFor(() => expect(screen.queryByText('Milk · work')).toBeNull());
  // Its notice stays reachable outside the list, with its comparison.
  expect(within(screen.getByRole('list')).queryByText(/changed/)).toBeNull();
  expect(screen.getAllByText(/The pod has changed/).length).toBeGreaterThan(0);
});

it('stops at a lost response and keeps its check once the row is gone', async () => {
  const f = await overview();
  f.control.lose = 'personal urn:b';
  fireEvent.click(bulk());
  await press('Delete');
  const summary = await screen.findByText(/^1 task deleted\./);
  expect(summary.textContent).toBe(
    '1 task deleted. “Call Ann” in personal needs your attention; see its notice. 2 tasks were not sent.',
  );
  expect(f.deletes).toEqual(['personal urn:s', 'personal urn:b']);
  await reread();
  await waitFor(() =>
    expect(screen.queryByText('Call Ann · personal')).toBeNull(),
  );
  // Never resent: the person checks the Pod through the notice.
  const notice = screen
    .getByText(/The result is unconfirmed/)
    .closest('section')!;
  expect(
    within(notice).getByRole('button', { name: 'Check current version' }),
  ).toBeTruthy();
  expect(f.deletes).toEqual(['personal urn:s', 'personal urn:b']);
});

it('sends nothing more once an area lost write access', async () => {
  const f = await overview();
  const first = deferred<void>();
  f.control.hold.set('personal urn:s', first.promise);
  fireEvent.click(bulk());
  await press('Delete');
  await waitFor(() => expect(f.deletes).toEqual(['personal urn:s']));
  expect(screen.getByText('Deleting… 0 of 4.').getAttribute('role')).toBe(
    'status',
  );
  // personal becomes read-only while its first removal is in flight.
  f.setCatalogue(async () => catalogue([work, personal], [work]));
  await act(() => f.runtime.loadContexts(f.id));
  first.resolve();
  await screen.findByText(
    '1 task deleted. An area or its access changed. 3 tasks were not sent.',
  );
  expect(f.deletes).toEqual(['personal urn:s']);
  expect(f.tasks.get(work)!.size).toBe(3);
});

it('stops at a row whose own delete has no answer yet, and names it', async () => {
  const f = await overview();
  const first = deferred<void>();
  const own = deferred<void>();
  f.control.hold.set('personal urn:s', first.promise);
  f.control.hold.set('personal urn:b', own.promise);
  fireEvent.click(bulk());
  await press('Delete');
  await waitFor(() => expect(f.deletes).toEqual(['personal urn:s']));
  // The next row's own delete starts while the run waits.
  fireEvent.click(
    screen.getByRole('button', { name: 'Delete: Call Ann in personal' }),
  );
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    }),
  );
  await waitFor(() =>
    expect(f.deletes).toEqual(['personal urn:s', 'personal urn:b']),
  );
  first.resolve();
  expect(
    (
      await screen.findByText(
        '1 task deleted. “Call Ann” in personal had another change in progress. 3 tasks were not sent.',
      )
    ).getAttribute('role'),
  ).toBe('alert');
  own.resolve();
  expect(f.deletes).toEqual(['personal urn:s', 'personal urn:b']);
});

it('stops naming a row once its area can no longer be read', async () => {
  const f = await overview();
  f.control.lose = 'personal urn:b';
  fireEvent.click(bulk());
  await press('Delete');
  await screen.findByText(/^1 task deleted\. “Call Ann” in personal/);
  // Read access to personal ends.
  f.setCatalogue(async () => catalogue([work], [work]));
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() =>
    expect(screen.queryByText('Call Ann · personal')).toBeNull(),
  );
  const summary = screen.getByText(/^1 task deleted\./);
  expect(summary.textContent).toBe(
    '1 task deleted. One task needs your attention; see its notice. 2 tasks were not sent.',
  );
});

it('closes the question when the authorization ends', async () => {
  const f = await overview();
  fireEvent.click(bulk());
  expect(areas(await question())).toEqual([
    ['personal', '2'],
    ['work', '2'],
  ]);
  await act(async () => {
    await f.runtime.disconnect(f.id);
  });
  // The SDK asks to sign in again; the question is gone with its areas.
  await waitFor(() =>
    expect(screen.queryByText('Delete 4 done tasks from the Pod?')).toBeNull(),
  );
  expect(screen.queryByText(/personal/)).toBeNull();
  expect(f.deletes).toEqual([]);
});
