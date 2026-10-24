// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  OverviewToggleExample,
  TasksOverview,
} from '../../../../examples/todo/recipes/overview-toggle.js';
import { SempodsProvider, useApp } from '@sempods/app-sdk/react';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  deferred,
  personal,
  resourceIri,
  returnedSession,
  twoPods,
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

/** Two tasks: `urn:a` in work (writable), `urn:b` in personal (read-only). */
async function overview() {
  const f = await returnedSession((r) => void runtimes.push(r));
  const tasks = new Map([
    [`${work} urn:a`, { title: 'Buy milk', status: open, version: 1 }],
    [`${personal} urn:b`, { title: 'Call Ann', status: open, version: 1 }],
  ]);
  const writes: {
    context: string | null;
    ifMatch: string | null;
    body: string;
  }[] = [];
  const control = { status: 204, query: null as Promise<void> | null };
  f.setQuery(async () => {
    await control.query;
    return new Response(
      JSON.stringify({
        head: { vars: ['item', 'graph', 'title', 'status'] },
        results: {
          bindings: [...tasks].map(([key, task]) => {
            const [graph, item] = key.split(' ');
            return {
              item: { type: 'uri', value: item },
              graph: { type: 'uri', value: graph },
              title: { type: 'literal', value: task.title },
              status: { type: 'uri', value: task.status },
            };
          }),
        },
      }),
      { headers: { 'content-type': 'application/sparql-results+json' } },
    );
  });
  f.setResource(async (url, init) => {
    const context = new URL(url).searchParams.get('context');
    const iri = resourceIri(url);
    const task = tasks.get(`${context} ${iri}`);
    if ((init?.method ?? 'GET') === 'GET')
      return task
        ? Response.json(
            {
              '@id': iri,
              '@type': [schema + 'Action'],
              [schema + 'name']: [{ '@value': task.title }],
              [schema + 'actionStatus']: [{ '@id': task.status }],
            },
            { headers: { etag: `"t${task.version}"` } },
          )
        : new Response(null, { status: 404 });
    const body = String(init?.body ?? '');
    writes.push({
      context,
      ifMatch: new Headers(init?.headers).get('if-match'),
      body,
    });
    if (control.status === 412) {
      // Someone else changed the task since it was read.
      if (task) task.version++;
      return new Response(null, { status: 412 });
    }
    if (control.status !== 204)
      return new Response(null, { status: control.status });
    if (task) {
      task.version++;
      task.status = body.includes(done) ? done : open;
    }
    return new Response(null, { status: 204 });
  });
  const select = vi.spyOn(f.runtime, 'selectContext');
  render(<OverviewToggleExample runtime={f.runtime} />);
  const milk = () =>
    within(screen.getByRole('list')).getByRole('checkbox', {
      name: 'Buy milk',
    }) as HTMLInputElement;
  await waitFor(() => expect(milk().disabled).toBe(false));
  return { ...f, writes, control, select, milk };
}

it('ticks a row in its own Context with one conditional write, keeping the list and the selection', async () => {
  const f = await overview();
  const reload = deferred<void>();
  f.control.query = reload.promise;
  fireEvent.click(f.milk());
  expect(await screen.findByText('Saving…')).toBeTruthy();
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.writes[0]).toMatchObject({ context: work, ifMatch: '"t1"' });
  expect(f.writes[0]!.body).toContain(done);
  // The overview reloads without blanking the rows it already shows.
  await waitFor(() => expect(f.count('/_system/sparql/query')).toBe(2));
  expect(f.milk().checked).toBe(false);
  reload.resolve();
  await waitFor(() => expect(f.milk().checked).toBe(true));
  expect(f.select).not.toHaveBeenCalled();
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBeNull();
  expect(
    screen.queryByRole('region', { name: 'Finish the change' }),
  ).toBeNull();
});

it('offers no one-click change for a read-only Context', async () => {
  await overview();
  expect(
    (
      within(screen.getByRole('list')).getByRole('checkbox', {
        name: 'Call Ann',
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
});

it.each([
  // After a 412 the editor rebases once onto the newer version (documented).
  [412, 'The pod has changed. Compare before continuing.', ['"t1"', '"t2"']],
  [202, /unconfirmed/i, ['"t1"']],
] as const)(
  'keeps the editor with its recovery after a %i answer and resends nothing',
  async (status, text, ifMatch) => {
    const f = await overview();
    f.control.status = status;
    fireEvent.click(f.milk());
    const finish = await screen.findByRole('region', {
      name: 'Finish the change',
    });
    expect(within(finish).getByText(text)).toBeTruthy();
    expect(f.writes.map((w) => w.ifMatch)).toEqual(ifMatch);
    // Every row waits for the decision; nothing is shown as ticked.
    expect(f.milk().disabled).toBe(true);
    expect(f.milk().checked).toBe(false);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.writes).toHaveLength(ifMatch.length);
    expect(f.count('/_system/sparql/query')).toBe(1);
  },
);

it('asks before closing an unconfirmed change and keeps it on Keep editing', async () => {
  const f = await overview();
  f.control.status = 202;
  fireEvent.click(f.milk());
  const finish = await screen.findByRole('region', {
    name: 'Finish the change',
  });
  fireEvent.click(within(finish).getByRole('button', { name: 'Close' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toMatch(/unconfirmed/i);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(
    screen.getByRole('region', { name: 'Finish the change' }),
  ).toBeTruthy();
  expect(f.writes).toHaveLength(1);
});

it('finishes the change after a successful save in the recovery editor', async () => {
  const f = await overview();
  f.control.status = 412;
  fireEvent.click(f.milk());
  const finish = await screen.findByRole('region', {
    name: 'Finish the change',
  });
  f.control.status = 204;
  fireEvent.click(
    within(finish).getByRole('button', { name: 'Continue with my changes' }),
  );
  fireEvent.click(within(finish).getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Finish the change' }),
    ).toBeNull(),
  );
  await waitFor(() => expect(f.milk().checked).toBe(true));
  expect(f.milk().disabled).toBe(false);
  expect(f.count('/_system/sparql/query')).toBe(2);
});

it('offers Close when the row retires because another Pod was chosen', async () => {
  const { f, runtime, other } = await twoPods((r) => void runtimes.push(r));
  const read = deferred<Response>();
  f.setQuery(
    async () =>
      new Response(
        JSON.stringify({
          head: { vars: ['item', 'graph', 'title', 'status'] },
          results: {
            bindings: [
              {
                item: { type: 'uri', value: 'urn:a' },
                graph: { type: 'uri', value: work },
                title: { type: 'literal', value: 'Buy milk' },
                status: { type: 'uri', value: open },
              },
            ],
          },
        }),
        { headers: { 'content-type': 'application/sparql-results+json' } },
      ),
  );
  const puts: string[] = [];
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') !== 'GET') puts.push(url);
    return read.promise;
  });
  function Switch({
    id,
    name,
  }: {
    readonly id: string;
    readonly name: string;
  }) {
    const app = useApp();
    return (
      <button onClick={() => void app.selectConnection(id)}>{name}</button>
    );
  }
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Switch id={f.id} name="Alice" />
      <Switch id={other.id} name="Bob" />
      <TasksOverview />
    </SempodsProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Alice' }));
  const milk = () =>
    within(screen.getByRole('list')).getByRole('checkbox', {
      name: 'Buy milk',
    }) as HTMLInputElement;
  await waitFor(() => expect(milk().disabled).toBe(false));
  fireEvent.click(milk());
  await waitFor(() =>
    expect(
      f.fetch.mock.calls.some(([url]) => url.includes('/_system/resources/')),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bob' }));
  const finish = await screen.findByRole('region', {
    name: 'Finish the change',
  });
  expect(within(finish).getByRole('status').textContent).toBe(
    'Another Pod was chosen; this task was not changed.',
  );
  fireEvent.click(within(finish).getByRole('button', { name: 'Close' }));
  await waitFor(() =>
    expect(
      screen.queryByRole('region', { name: 'Finish the change' }),
    ).toBeNull(),
  );
  expect(puts).toEqual([]);
});
