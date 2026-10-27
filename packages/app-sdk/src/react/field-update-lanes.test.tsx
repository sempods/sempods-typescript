// @vitest-environment jsdom
/** `useFieldUpdate` keeps one write lane per resource, held at list level. */
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { fields, flag, text, type Snapshot } from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  SempodsProvider,
  TargetScreen,
  UpdateNotice,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
  useSelection,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  deferred,
  fixture,
  work,
  personal,
  resourceIri,
} from '../runtime/fixture.test.js';

const definition = fields(
  {
    title: text('urn:title', { language: null }),
    done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
  },
  { type: 'urn:Task' },
);
const task = (iri: string, title: string): JsonLd => ({
  '@id': iri,
  '@type': ['urn:Task'],
  'urn:title': [{ '@value': title }],
  'urn:status': [{ '@id': 'urn:open' }],
});
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

type Api = ReturnType<typeof useFieldUpdate<{ title: string; done: boolean }>>;
async function setup() {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  const rows = new Map<string, JsonLd>([
    ['urn:one', task('urn:one', 'One')],
    ['urn:two', task('urn:two', 'Two')],
  ]);
  const patches: string[] = [];
  let answer: () => Promise<Response> | Response = () =>
    new Response(null, { status: 204 });
  f.setQuery(async () => Response.json([...rows.values()]));
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    patches.push(iri);
    return answer();
  });
  let api!: Api;
  let app!: ReturnType<typeof useApp>;
  let creationApi!: ReturnType<
    typeof useCreation<{ title: string; done: boolean }>
  >;
  let shown: readonly Snapshot<{ title: string; done: boolean }>[] = [];
  // Each render's commands, to check that they keep their identity.
  const commands: unknown[][] = [];
  function Screen() {
    const list = useList(definition);
    api = useFieldUpdate(definition);
    shown = list.data?.items ?? shown;
    app = useApp();
    const selection = useSelection();
    const creation = useCreation(definition, {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    commands.push([
      list.reload,
      list.cancel,
      selection.select,
      creation.change,
      creation.create,
    ]);
    creationApi = creation;
    // Rows render only while the list has data, as an app's rows do.
    return (
      <ul>
        {list.data?.items.map((row) => (
          <li key={row.iri}>
            <button
              disabled={!api.for(row).canMutate}
              onClick={() => void api.for(row).update({ done: true })}
            >
              {row.data.title}
            </button>
            <UpdateNotice {...api.for(row).notice} />
          </li>
        ))}
      </ul>
    );
  }
  const view = render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await screen.findByRole('button', { name: 'One' });
  return {
    ...f,
    ...session,
    patches,
    rows,
    unmount: () => view.unmount(),
    shown: () => shown,
    commands,
    creation: () => creationApi,
    api: () => api,
    app: () => app,
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}
const button = (name: string) =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

it('locks only the resource being written; another one writes meanwhile', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  await waitFor(() => expect(button('One').disabled).toBe(false));
  act(() => button('One').click());
  await waitFor(() => expect(button('One').disabled).toBe(true));
  expect(button('Two').disabled).toBe(false);
  // Pending is not unresolved, and says nothing about another row.
  expect(s.api().unresolved).toEqual([]);
  s.answer(() => new Response(null, { status: 204 }));
  act(() => button('Two').click());
  await waitFor(() => expect(s.patches).toEqual(['urn:one', 'urn:two']));
  await act(async () => held.resolve(new Response(null, { status: 204 })));
  await waitFor(() => expect(button('One').disabled).toBe(false));
  expect(Object.keys(s.api()).sort()).toEqual(['for', 'unresolved']);
  expect(s.api().for('urn:one').canMutate).toBe(false);
});

it('keeps an unconfirmed write through lost read access while its row is gone', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  await waitFor(() => expect(button('One').disabled).toBe(false));
  act(() => button('One').click());
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  // Read access is lost: the list drops its rows, the lane stays.
  s.setCatalogue(async () => catalogue([personal], [personal]));
  await act(() => s.runtime.loadContexts(s.id));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'One' })).toBeNull(),
  );
  expect(s.api().for('urn:one').canMutate).toBe(false);
  expect(s.api().for('urn:one').notice.outcome).toMatchObject({
    kind: 'unconfirmed',
  });
  // Leaving the target still asks about the unconfirmed write.
  let left: boolean | undefined;
  void s
    .app()
    .selectContext(personal)
    .then((result) => (left = result));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  act(() => screen.getByRole('button', { name: 'Keep editing' }).click());
  await waitFor(() => expect(left).toBe(false));
  // Access returns: the row is back, still locked with its notice; nothing resent.
  s.setCatalogue(async () => catalogue());
  await act(() => s.runtime.loadContexts(s.id));
  await screen.findByRole('button', { name: 'One' });
  expect(button('One').disabled).toBe(true);
  expect(screen.getByText(/The result is unconfirmed/)).toBeTruthy();
  expect(button('Two').disabled).toBe(false);
  expect(s.patches).toEqual(['urn:one']);
});

it('sends nothing for a resource once the hook has unmounted', async () => {
  const s = await setup();
  await waitFor(() => expect(button('Two').disabled).toBe(false));
  const api = s.api();
  const two = s.shown().find((row) => row.iri === 'urn:two')!;
  s.unmount();
  expect(await api.for(two).update({ done: true })).toEqual({
    kind: 'not-sent',
    reason: 'ended',
  });
  expect(s.patches).toEqual([]);
});

it('reports an unresolved write whose row was deleted, until acknowledged', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  await waitFor(() => expect(button('One').disabled).toBe(false));
  act(() => button('One').click());
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  // Deleted elsewhere: the check finds it absent and the list drops the row.
  s.rows.delete('urn:one');
  await act(async () => {
    await s.api().for('urn:one').notice.onCheck();
  });
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'One' })).toBeNull(),
  );
  expect(s.api().unresolved).toEqual(['urn:one']);
  act(() => s.api().for('urn:one').notice.onAcknowledge());
  expect(s.api().unresolved).toEqual([]);
});

it('checks and acknowledges a row through a retained hook result', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  await waitFor(() => expect(button('One').disabled).toBe(false));
  const api = s.api();
  const one = s.shown().find((row) => row.iri === 'urn:one')!;
  await act(async () => {
    expect(await api.for(one).update({ done: true })).toMatchObject({
      kind: 'unconfirmed',
    });
  });
  await act(() => api.for(one.iri).notice.onCheck());
  act(() => api.for(one.iri).notice.onAcknowledge());
  expect(s.api().unresolved).toEqual([]);
  expect(button('One').disabled).toBe(false);
});

it('keeps row recovery when a write for another resource is refused', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  await waitFor(() => expect(button('One').disabled).toBe(false));
  act(() => button('One').click());
  expect(await screen.findByText(/The result is unconfirmed/)).toBeTruthy();
  // Write access is lost; a retained callback tries an untouched resource.
  s.setCatalogue(async () => catalogue([work, personal], []));
  await act(() => s.runtime.loadContexts(s.id));
  await waitFor(() => expect(button('Two').disabled).toBe(true));
  const two = s.shown().find((row) => row.iri === 'urn:two')!;
  await act(async () => {
    expect(await s.api().for(two).update({ done: true })).toEqual({
      kind: 'not-sent',
      reason: 'unavailable',
    });
  });
  expect(s.patches).toEqual(['urn:one']);
  expect(s.api().for('urn:one').notice.outcome).toMatchObject({
    kind: 'unconfirmed',
  });
  expect(s.api().for('urn:one').notice.outcome).toMatchObject({
    kind: 'unconfirmed',
  });
  await act(() => s.api().for('urn:one').notice.onCheck());
  act(() => s.api().for('urn:one').notice.onAcknowledge());
  expect(s.api().unresolved).toEqual([]);
  expect(s.api().for('urn:one').notice.outcome).toBeNull();
});

it('does not write again from the snapshot a confirmed update was made from', async () => {
  const s = await setup();
  await waitFor(() => expect(button('One').disabled).toBe(false));
  const one = s.shown().find((row) => row.iri === 'urn:one')!;
  await act(async () => {
    expect(await s.api().for(one).update({ done: true })).toMatchObject({
      kind: 'saved',
    });
  });
  expect(s.api().for(one).canMutate).toBe(false);
  expect(await s.api().for(one).update({ done: false })).toEqual({
    kind: 'not-sent',
    reason: 'stale',
  });
  expect(s.patches).toEqual(['urn:one']);
  // The list reads again: its fresh snapshot is writable.
  await waitFor(() =>
    expect(s.shown().find((row) => row.iri === 'urn:one')).not.toBe(one),
  );
  expect(
    s.api().for(s.shown().find((row) => row.iri === 'urn:one')!).canMutate,
  ).toBe(true);
});

it('shows a confirmed update on the row until the list reads it again', async () => {
  const s = await setup();
  const held = deferred<Response>();
  await waitFor(() => expect(button('One').disabled).toBe(false));
  const one = s.shown().find((row) => row.iri === 'urn:one')!;
  // The next list read waits, so the spent snapshot stays on screen.
  s.setQuery(() => held.promise);
  await act(async () => {
    expect(await s.api().for(one).update({ done: true })).toMatchObject({
      kind: 'saved',
    });
  });
  expect(one.data.done).toBe(false);
  expect(s.api().for(one).data).toEqual({ title: 'One', done: true });
  expect(s.api().for(one).canMutate).toBe(false);
});

it('keeps its commands for one target; they change with the target', async () => {
  const s = await setup();
  await waitFor(() => expect(button('One').disabled).toBe(false));
  const loaded = s.commands.length;
  const first = s.commands.at(-1)!;
  // A write and the list's reread render several times.
  act(() => button('Two').click());
  await waitFor(() => expect(s.patches).toEqual(['urn:two']));
  await waitFor(() => expect(button('Two').disabled).toBe(false));
  expect(s.commands.length).toBeGreaterThan(loaded + 1);
  for (const render of s.commands.slice(loaded))
    render.forEach((command, i) => expect(command).toBe(first[i]));
  // Another Context: new commands (the old ones keep their own target).
  await act(() => s.app().selectContext(personal));
  await waitFor(() => expect(s.commands.at(-1)![2]).not.toBe(first[2]));
});

it('names why a creation was not sent', async () => {
  const s = await setup();
  await waitFor(() => expect(button('One').disabled).toBe(false));
  // The draft is blank and the definition requires a title.
  expect(await s.creation().create()).toEqual({
    kind: 'not-sent',
    reason: 'invalid',
  });
  expect(s.patches).toEqual([]);
});

it('creates the next item right after a slow one, before a new render', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  await waitFor(() => expect(button('One').disabled).toBe(false));
  act(() => s.creation().change({ title: 'First' }));
  let first!: ReturnType<ReturnType<typeof s.creation>['create']>;
  act(() => {
    first = s.creation().create();
  });
  // The pending creation has rendered: that render's commands see it busy.
  await waitFor(() => expect(s.creation().busy).toBe(true));
  const batch = s.creation();
  s.answer(() => new Response(null, { status: 201 }));
  let second: Awaited<typeof first> | undefined;
  // The next item right after the first, as a batch handler does; the
  // creation's own check is live, not the last render's `canCreate`.
  await act(async () => {
    held.resolve(new Response(null, { status: 201 }));
    expect(await first).toMatchObject({ kind: 'created' });
    batch.change({ title: 'Second' });
    second = await batch.create();
  });
  expect(second).toMatchObject({ kind: 'created' });
  expect(s.patches).toHaveLength(2);
});
