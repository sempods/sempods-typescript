// @vitest-environment jsdom
/** The one-click overview recipe: `usePodList` with `useContextUpdate` (#158). */
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
import { Activity, memo, useReducer, useState, type ReactElement } from 'react';
import { OverviewToggleExample } from '../../../../examples/todo/recipes/overview-toggle.js';
import {
  SempodsProvider,
  useApp,
  useContextUpdate,
  usePodList,
  type PodListItem,
} from './index.js';
import { useController } from './app.js';
import { fields, flag, text } from '@sempods/client-sdk/edit';
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
 * `urn:a` in work and `urn:b` in personal; work is writable, personal too
 * unless `readOnly`. Each Context answers its own list query.
 */
async function overview({
  readOnly = false,
  personalReadable = true,
  ui = (runtime: BrowserRuntime): ReactElement => (
    <OverviewToggleExample runtime={runtime} />
  ),
  ready = async () => {},
} = {}) {
  const f = await returnedSession((r) => void runtimes.push(r));
  f.setCatalogue(async () =>
    personalReadable
      ? catalogue([work, personal], readOnly ? [work] : [work, personal])
      : catalogue([work], [work]),
  );
  const tasks = new Map<string, Map<string, Task>>([
    [
      work,
      new Map([['urn:a', { title: 'Buy milk', status: open, version: 1 }]]),
    ],
    [
      personal,
      new Map([['urn:b', { title: 'Call Ann', status: open, version: 1 }]]),
    ],
  ]);
  const body = (iri: string, task: Task) => ({
    '@id': iri,
    '@type': [schema + 'Action'],
    [schema + 'name']: [{ '@value': task.title }],
    [schema + 'actionStatus']: [{ '@id': task.status }],
  });
  const writes: { context: string; iri: string; ifMatch: string | null }[] = [];
  const reads: string[] = [];
  const control = {
    status: 204,
    held: null as Promise<void> | null,
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
    reads.push(context);
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
    writes.push({
      context,
      iri,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    if (init?.method === 'DELETE') {
      tasks.get(context)?.delete(iri);
      return new Response(null, { status: 204 });
    }
    await control.held;
    if (control.status === 412) {
      // Someone else changed the task since it was read.
      if (task) task.version++;
      return new Response(null, { status: 412 });
    }
    if (control.status !== 204)
      return new Response(null, { status: control.status });
    if (task) {
      task.version++;
      task.status = String(init?.body ?? '').includes(done) ? done : open;
    }
    return new Response(null, { status: 204 });
  });
  const select = vi.spyOn(f.runtime, 'selectContext');
  render(ui(f.runtime));
  await ready();
  const box = (name: string) =>
    within(screen.getByRole('list')).getByRole('checkbox', {
      name,
    }) as HTMLInputElement;
  await waitFor(() => expect(box('Buy milk').disabled).toBe(false));
  if (personalReadable)
    await waitFor(() => expect(screen.queryByText('Call Ann')).not.toBeNull());
  return { ...f, tasks, writes, reads, control, select, box };
}

it('ticks rows in two Contexts at once, each with one conditional write, and keeps the selection', async () => {
  const f = await overview();
  await waitFor(() => expect(f.box('Call Ann').disabled).toBe(false));
  const held = deferred<void>();
  f.control.held = held.promise;
  fireEvent.click(f.box('Buy milk'));
  fireEvent.click(f.box('Call Ann'));
  // Both are sent while the other is pending: one lane per row.
  await waitFor(() => expect(f.writes).toHaveLength(2));
  expect(f.writes).toEqual([
    { context: work, iri: 'urn:a', ifMatch: '"t1"' },
    { context: personal, iri: 'urn:b', ifMatch: '"t1"' },
  ]);
  // Nothing is shown as ticked before the Pod confirms it.
  expect(f.box('Buy milk').checked).toBe(false);
  f.reads.length = 0;
  await act(async () => held.resolve());
  await waitFor(() => expect(f.box('Buy milk').checked).toBe(true));
  await waitFor(() => expect(f.box('Call Ann').checked).toBe(true));
  // Each Context read its list again; the selection stayed.
  await waitFor(() =>
    expect(new Set(f.reads)).toEqual(new Set([work, personal])),
  );
  expect(f.select).not.toHaveBeenCalled();
  expect(f.writes).toHaveLength(2);
});

it('offers no one-click change in a read-only Context', async () => {
  const f = await overview({ readOnly: true });
  expect(f.box('Call Ann').disabled).toBe(true);
  expect(f.box('Buy milk').disabled).toBe(false);
  expect(f.writes).toEqual([]);
});

it('shows a change on the Pod with its comparison after one rebase', async () => {
  const f = await overview();
  f.control.status = 412;
  fireEvent.click(f.box('Buy milk'));
  expect(
    await screen.findByText('The pod has changed. Compare before continuing.'),
  ).toBeTruthy();
  // The SDK's single rebase onto a fresh read, then nothing more.
  expect(f.writes.map((w) => w.ifMatch)).toEqual(['"t1"', '"t2"']);
  // That row waits for its recovery; the other row stays usable.
  expect(f.box('Buy milk').disabled).toBe(true);
  await waitFor(() => expect(f.box('Call Ann').disabled).toBe(false));
});

it('keeps an unconfirmed tick checkable outside the list once its row is gone', async () => {
  const f = await overview();
  f.control.status = 202;
  fireEvent.click(f.box('Buy milk'));
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  expect(f.writes).toHaveLength(1);
  // Deleted elsewhere: the next read no longer lists the row.
  f.tasks.get(work)!.delete('urn:a');
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'Buy milk' })).toBeNull(),
  );
  // Its notice stays, outside the list, with check and acknowledgement.
  const notice = screen
    .getByText(/The result is unconfirmed/)
    .closest('section')!;
  expect(
    within(screen.getByRole('list')).queryByText(/unconfirmed/),
  ).toBeNull();
  fireEvent.click(
    within(notice).getByRole('button', { name: 'Check current version' }),
  );
  await waitFor(() =>
    expect(
      (
        within(notice).getByRole('button', {
          name: 'I have checked the pod',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(
    within(notice).getByRole('button', { name: 'I have checked the pod' }),
  );
  await waitFor(() =>
    expect(screen.queryByText(/The result is unconfirmed/)).toBeNull(),
  );
  expect(f.writes).toHaveLength(1);
});

it('names a Context the app may not use in the reader language', async () => {
  const f = await overview();
  expect(f.writes).toEqual([]);
  // The SDK's texts, also in German.
  const { createLocale } = await import('../locale.js');
  expect(createLocale({ language: 'de' }).messages.contextProblems).toEqual({
    unreadable:
      'Dieser Kontext ist für diese App nicht verfügbar. Prüfe den Zugriff.',
    'discovery-failed':
      'Der Zugriff auf Kontexte konnte nicht geprüft werden. Versuche es erneut.',
    refused: 'Diese App arbeitet nicht mit diesem Kontext.',
  });
});

const task = fields(
  {
    title: text(schema + 'name', { language: null }),
    done: flag(schema + 'actionStatus', { on: done, off: open }),
  },
  { type: schema + 'Action' },
);

it("an unresolved row's guard survives row navigation and Context selection, and asks before a connection action", async () => {
  let app!: ReturnType<typeof useApp>;
  function Rows() {
    app = useApp();
    const list = usePodList(task);
    const overview = useContextUpdate(task);
    return (
      <ul>
        {list.data?.items.map((item) => {
          const row = overview.for(item);
          return (
            <li key={`${item.context} ${item.snapshot.iri}`}>
              <label>
                <input
                  type="checkbox"
                  checked={row.data.done}
                  disabled={!row.canMutate}
                  onChange={(e) => void row.update({ done: e.target.checked })}
                />
                {row.data.title}
              </label>
            </li>
          );
        })}
      </ul>
    );
  }
  const f = await overview({
    ui: (runtime) => (
      <SempodsProvider runtime={runtime} contextSelection="on-demand">
        <Rows />
      </SempodsProvider>
    ),
  });
  f.control.status = 202;
  fireEvent.click(f.box('Buy milk'));
  await waitFor(() => expect(f.writes).toHaveLength(1));
  await waitFor(() => expect(f.box('Buy milk').disabled).toBe(true));
  // Neither row navigation nor a Context selection asks about it.
  await act(async () => {
    expect(await app.navigate(() => {})).toBe(true);
    expect(await app.selectContext(personal)).toBe(true);
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  // A connection action does: the write may have changed the Pod.
  let left!: Promise<boolean>;
  act(() => {
    left = app.disconnect(f.id);
  });
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
  expect(await left).toBe(false);
  expect(f.writes).toHaveLength(1);
});

it('offers its rows again once a guarded change that re-rendered them ends', async () => {
  let app!: ReturnType<typeof useApp>;
  // Apart from the rows: `useApp` renders again with the provider.
  function Actions() {
    app = useApp();
    return null;
  }
  // The list's items, handed over without rendering the rows.
  const shared = {
    items: [] as readonly PodListItem<{
      readonly title: string;
      readonly done: boolean;
    }>[],
    render: () => {},
  };
  function List() {
    shared.items = usePodList(task).data?.items ?? [];
    return null;
  }
  // The rows on their own: only `useContextUpdate` (or `render`) renders them.
  const Rows = memo(function Rows() {
    const [, render] = useReducer((n: number) => n + 1, 0);
    shared.render = render;
    const overview = useContextUpdate(task);
    return (
      <ul>
        {shared.items.map((item) => {
          const row = overview.for(item);
          return (
            <li key={`${item.context} ${item.snapshot.iri}`}>
              <label>
                <input
                  type="checkbox"
                  checked={row.data.done}
                  disabled={!row.canMutate}
                  readOnly
                />
                {row.data.title}
              </label>
            </li>
          );
        })}
      </ul>
    );
  });
  const f = await overview({
    ui: (runtime) => (
      <SempodsProvider runtime={runtime} contextSelection="on-demand">
        <Actions />
        <List />
        <Rows />
      </SempodsProvider>
    ),
    ready: async () => {
      await waitFor(() => expect(shared.items).toHaveLength(2));
      act(() => shared.render());
    },
  });
  const held = deferred<void>();
  let moved!: Promise<boolean>;
  act(() => {
    moved = app.navigate(() => held.promise);
  });
  // Rendered during the change, for example by a list reload: disabled.
  act(() => shared.render());
  expect(f.box('Buy milk').disabled).toBe(true);
  await act(async () => held.resolve());
  expect(await moved).toBe(true);
  await waitFor(() => expect(f.box('Buy milk').disabled).toBe(false));
});

/** Rows written through `useContextUpdate`, with what a test needs of it. */
function harness() {
  const api = {} as {
    app: ReturnType<typeof useApp>;
    controller: ReturnType<typeof useController>;
    rows: Record<
      string,
      { update(change: { done: boolean }): Promise<unknown> }
    >;
    overview: ReturnType<
      typeof useContextUpdate<{
        readonly title: string;
        readonly done: boolean;
      }>
    >;
    hide: (hidden: boolean) => void;
  };
  function Rows() {
    api.app = useApp();
    api.controller = useController();
    api.rows = {};
    const list = usePodList(task);
    const overview = (api.overview = useContextUpdate(task));
    return (
      <ul>
        {list.data?.items.map((item) => {
          const row = overview.for(item);
          api.rows[row.data.title] = row;
          return (
            <li key={`${item.context} ${item.snapshot.iri}`}>
              <label>
                <input
                  type="checkbox"
                  checked={row.data.done}
                  disabled={!row.canMutate}
                  onChange={(e) => void row.update({ done: e.target.checked })}
                />
                {row.data.title}
              </label>
              <button onClick={() => void row.remove()}>
                Remove {row.data.title}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }
  function Host() {
    const [hidden, hide] = useState(false);
    api.hide = hide;
    return (
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        <Rows />
      </Activity>
    );
  }
  return {
    api,
    ui: (runtime: BrowserRuntime) => (
      <SempodsProvider runtime={runtime} contextSelection="on-demand">
        <Host />
      </SempodsProvider>
    ),
  };
}

it('removes a row in its own Context with one conditional delete', async () => {
  const h = harness();
  const f = await overview({ ui: h.ui });
  fireEvent.click(screen.getByRole('button', { name: 'Remove Buy milk' }));
  await waitFor(() =>
    expect(screen.queryByRole('checkbox', { name: 'Buy milk' })).toBeNull(),
  );
  expect(f.writes).toEqual([{ context: work, iri: 'urn:a', ifMatch: '"t1"' }]);
  expect(f.box('Call Ann')).toBeTruthy();
});

it('gives a resource without its row only its notice and problem', async () => {
  const h = harness();
  await overview({ ui: h.ui, personalReadable: false });
  const state = h.api.overview.for({ context: personal, iri: 'urn:b' });
  expect(state).toMatchObject({
    context: personal,
    problem: 'unreadable',
    canMutate: false,
    notice: { outcome: null },
  });
  expect('update' in state).toBe(false);
  // A Context it may use has no problem, and still nothing to write from.
  expect(h.api.overview.for({ context: work, iri: 'urn:a' })).toMatchObject({
    problem: null,
    canMutate: false,
  });
});

it('a tick that settles while the overview is hidden shows on reveal', async () => {
  const h = harness();
  const f = await overview({ ui: h.ui });
  const held = deferred<void>();
  f.control.held = held.promise;
  fireEvent.click(f.box('Buy milk'));
  await waitFor(() => expect(f.writes).toHaveLength(1));
  act(() => h.api.hide(true));
  await act(async () => held.resolve());
  act(() => h.api.hide(false));
  await waitFor(() => expect(f.box('Buy milk').checked).toBe(true));
  expect(f.writes).toHaveLength(1);
});

it('follows a change of write access in a Context', async () => {
  const h = harness();
  const f = await overview({ ui: h.ui });
  await waitFor(() => expect(f.box('Call Ann').disabled).toBe(false));
  // The catalogue now lists personal as read-only.
  f.setCatalogue(async () => catalogue([work, personal], [work]));
  await act(async () => {
    await h.api.app.refreshContexts(f.id);
  });
  await waitFor(() => expect(f.box('Call Ann').disabled).toBe(true));
  expect(f.box('Buy milk').disabled).toBe(false);
});

it('a row command kept past a switch to another connection sends nothing', async () => {
  const h = harness();
  const f = await overview({ ui: h.ui });
  const kept = h.api.rows['Buy milk']!;
  // The controller switched before this screen rendered again.
  const snapshot = h.api.controller.getSnapshot;
  vi.spyOn(h.api.controller, 'getSnapshot').mockImplementation(() => ({
    ...snapshot(),
    activeId: 'another',
  }));
  expect(await kept.update({ done: true })).toEqual({
    kind: 'not-sent',
    reason: 'ended',
  });
  expect(f.writes).toEqual([]);
});
