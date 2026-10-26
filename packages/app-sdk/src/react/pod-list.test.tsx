// @vitest-environment jsdom
/** `usePodList`: one type across the Pod's readable Contexts, with partial results. */
import { webcrypto } from 'node:crypto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fields, flag, text } from '@sempods/client-sdk/edit';
import {
  LoadNotice,
  SempodsProvider,
  useCreation,
  usePodList,
} from './index.js';
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
const task = fields(
  {
    title: text('urn:title', { language: null }),
    done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
  },
  { type: 'urn:Task' },
);
const node = (iri: string, title: string) => ({
  '@id': iri,
  '@type': ['urn:Task'],
  'urn:title': [{ '@value': title }],
  'urn:status': [{ '@id': 'urn:open' }],
});

/** Tasks per Context; the Pod query names the Contexts that hold any. */
async function setup() {
  const f = await returnedSession((r) => void runtimes.push(r));
  f.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  const tasks = new Map<string, Map<string, ReturnType<typeof node>>>([
    [work, new Map([['urn:a', node('urn:a', 'Buy milk')]])],
    [personal, new Map()],
  ]);
  const failing = new Set<string>();
  // Reads of these Contexts wait until released.
  const held = new Map<string, Promise<void>>();
  const reads: string[] = [];
  f.setQuery(async (url, init) => {
    const context = new URL(url).searchParams.get('default-graph-uri');
    if (!context) {
      // The Pod-wide discovery.
      const graphs = [...tasks].filter(([, items]) => items.size > 0);
      return new Response(
        JSON.stringify({
          head: { vars: ['graph'] },
          results: {
            bindings: graphs.map(([graph]) => ({
              graph: { type: 'uri', value: graph },
            })),
          },
        }),
        { headers: { 'content-type': 'application/sparql-results+json' } },
      );
    }
    expect(String(init?.body)).toContain('CONSTRUCT');
    reads.push(context);
    await held.get(context);
    if (failing.has(context)) return new Response(null, { status: 500 });
    return Response.json([...(tasks.get(context)?.values() ?? [])]);
  });
  f.setResource(async (url, init) => {
    const context = new URL(url).searchParams.get('context')!;
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return tasks.get(context)?.has(iri)
        ? Response.json(tasks.get(context)!.get(iri))
        : new Response(null, { status: 404 });
    // A creation lands in its Context.
    const body = JSON.parse(String(init?.body)) as ReturnType<typeof node>;
    tasks.get(context)!.set(iri, body);
    return new Response(null, { status: 201 });
  });
  let api!: {
    list: ReturnType<typeof usePodList<{ title: string; done: boolean }>>;
    creation: ReturnType<typeof useCreation<{ title: string; done: boolean }>>;
  };
  function Overview() {
    const list = usePodList(task);
    const creation = useCreation(task, {
      initial: { title: '', done: false },
      collection: 'tasks',
      context: personal,
    });
    api = { list, creation };
    return (
      <>
        <LoadNotice {...list} />
        <ul>
          {list.data?.items.map((item) => (
            <li key={`${item.context} ${item.snapshot.iri}`}>
              {item.snapshot.data.title}
            </li>
          ))}
        </ul>
      </>
    );
  }
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Overview />
    </SempodsProvider>,
  );
  return { ...f, tasks, failing, held, reads, api: () => api };
}

it('lists the type from every Context that holds it, each with its own state', async () => {
  const f = await setup();
  f.tasks.get(personal)!.set('urn:b', node('urn:b', 'Call Ann'));
  await waitFor(() => expect(f.api().list.complete).toBe(true));
  expect(
    f.api().list.data!.items.map((i) => [i.context, i.snapshot.data.title]),
  ).toEqual(
    expect.arrayContaining([
      [work, 'Buy milk'],
      [personal, 'Call Ann'],
    ]),
  );
  expect(f.api().list.contexts.map((c) => c.state.kind)).toEqual([
    'ready',
    'ready',
  ]);
});

it('shows the readable part when one Context fails, and retries only that one', async () => {
  const f = await setup();
  f.tasks.get(personal)!.set('urn:b', node('urn:b', 'Call Ann'));
  f.failing.add(personal);
  expect(await screen.findByText('Buy milk')).toBeTruthy();
  await waitFor(() =>
    expect(
      f.api().list.contexts.find((c) => c.context === personal)?.state.kind,
    ).toBe('failed'),
  );
  expect(f.api().list.complete).toBe(false);
  expect((await screen.findByRole('alert')).textContent).toBe(
    '1 of 2 lists could not be read; the others are shown.',
  );
  // Retry reads only the failed Context again.
  f.failing.clear();
  const before = f.reads.filter((c) => c === work).length;
  act(() => screen.getByRole('button', { name: 'Try again' }).click());
  expect(await screen.findByText('Call Ann')).toBeTruthy();
  await waitFor(() => expect(f.api().list.complete).toBe(true));
  expect(f.reads.filter((c) => c === work).length).toBe(before);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('finds a Context again after this app creates its first item there', async () => {
  const f = await setup();
  await waitFor(() => expect(f.api().list.complete).toBe(true));
  expect(f.api().list.contexts.map((c) => c.context)).toEqual([work]);
  const workReads = f.reads.filter((c) => c === work).length;
  await waitFor(() => expect(f.api().creation.canEdit).toBe(true));
  act(() => f.api().creation.change({ title: 'Call Ann' }));
  await act(async () => {
    expect(await f.api().creation.create()).toMatchObject({ kind: 'created' });
  });
  // No manual reload: the Pod-wide signal re-runs discovery.
  expect(await screen.findByText('Call Ann')).toBeTruthy();
  expect(
    f
      .api()
      .list.contexts.map((c) => c.context)
      .sort(),
  ).toEqual([personal, work].sort());
  // The new Context was added; the one already read kept its rows and read.
  expect(f.reads.filter((c) => c === work).length).toBe(workReads);
  expect(screen.getByText('Buy milk')).toBeTruthy();
});

it('drops a Context whose read access is lost and says the list is incomplete', async () => {
  const f = await setup();
  f.tasks.get(personal)!.set('urn:b', node('urn:b', 'Call Ann'));
  expect(await screen.findByText('Call Ann')).toBeTruthy();
  f.setCatalogue(async () => catalogue([work], [work]));
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() => expect(screen.queryByText('Call Ann')).toBeNull());
  expect(screen.getByText('Buy milk')).toBeTruthy();
  expect(
    f.api().list.contexts.find((c) => c.context === personal)?.problem,
  ).toBe('unreadable');
  expect(f.api().list.complete).toBe(false);
});

it('is loading, not finished or empty, until every Context has answered once', async () => {
  const f = await setup();
  f.tasks.get(personal)!.set('urn:b', node('urn:b', 'Call Ann'));
  const workRead = deferred<void>();
  const personalRead = deferred<void>();
  f.held.set(work, workRead.promise);
  f.held.set(personal, personalRead.promise);
  // Discovery is done, no Context has answered: loading, and no empty list.
  await waitFor(() => expect(f.api().list.contexts).toHaveLength(2));
  expect(f.api().list.state.kind).toBe('loading');
  expect(f.api().list.data).toBeUndefined();
  expect(screen.getByText('Loading…')).toBeTruthy();
  // One answered: its rows show, the overview is still loading.
  await act(async () => workRead.resolve());
  expect(await screen.findByText('Buy milk')).toBeTruthy();
  expect(f.api().list.state.kind).toBe('loading');
  expect(f.api().list.complete).toBe(false);
  await act(async () => personalRead.resolve());
  await waitFor(() => expect(f.api().list.state.kind).toBe('ready'));
  expect(f.api().list.complete).toBe(true);
});
