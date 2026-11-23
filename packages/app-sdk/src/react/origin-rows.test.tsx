// @vitest-environment jsdom
/** Overview rows and editors bound to the connection they were read from (#408). */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { listSubjects } from '@sempods/client-sdk/edit';
import {
  SempodsProvider,
  UnresolvedNotices,
  UpdateNotice,
  useApp,
  useAppState,
  useContextEditor,
  useContextUpdate,
  type ContextEditor,
  type ContextResource,
  type ContextUpdateItem,
} from './index.js';
import { taskFields, type Task } from '../../../../examples/todo/src/domain.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import { useDiscoveryDemand } from './app.js';
import { browserChannel, openSessionStore } from '../sessions/store.js';
import {
  catalogue,
  fixture,
  personal,
  pod,
  resourceIri,
  restored,
  settleLease,
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
const bobUrl = 'https://pod.example/bob';
const home = bobUrl + '/_system/contexts/home';
type Stored = { title: string; done: boolean; version: number };
type Row = ContextUpdateItem<Task> & { readonly connection: string };

/** The app's actions and state, for the test to drive and read. */
let app: ReturnType<typeof useApp>;
let state: ReturnType<typeof useAppState>;
let setRows: (rows: readonly Row[]) => void;
let unresolved: readonly ContextResource[] = [];
let edit: ContextEditor<Task, Partial<Task>>;
const outcomes: string[] = [];

function Probe() {
  app = useApp();
  state = useAppState();
  return null;
}

/** Rows from both Pods, each written in the connection it was read from. */
function Overview({ names }: { readonly names: Record<string, string> }) {
  const [rows, set] = useState<readonly Row[]>([]);
  setRows = set;
  const overview = useContextUpdate(taskFields);
  unresolved = overview.unresolved;
  edit = useContextEditor(taskFields);
  return (
    <>
      <ul>
        {rows.map((item) => {
          const row = overview.for(item);
          const where = `${row.data.title} in ${names[item.connection]}`;
          return (
            <li
              key={`${item.connection}\n${item.context} ${item.snapshot.iri}`}
            >
              <button
                disabled={!row.canMutate}
                onClick={() =>
                  void row
                    .update({ done: !row.data.done })
                    .then((o) => outcomes.push(`${where}: ${o.kind}`))
                }
              >
                Toggle {where}
              </button>
              {row.problem && <p>Problem {where}</p>}
              <UpdateNotice {...row.notice} />
            </li>
          );
        })}
      </ul>
      <section aria-label="Unresolved">
        <UnresolvedNotices of={overview} shown={rows} />
      </section>
      {/* A bulk run: one captured row command after the other. */}
      <button
        onClick={() => {
          const removes = rows.map((item) => overview.for(item).remove);
          void (async () => {
            for (const remove of removes) {
              const outcome = await remove();
              outcomes.push(`bulk: ${outcome.kind}`);
              if (outcome.kind !== 'removed') return;
            }
          })();
        }}
      >
        Remove all
      </button>
    </>
  );
}

/**
 * Alice (`f.id`) with Milk (`urn:a`) and Shared (`urn:s`) in work; Bob with
 * his own Shared (`urn:s`, the same IRI) in home. Bob is active, as after his
 * sign-in. `lose` names a resource (`<pod> <iri>`) whose next write the Pod
 * applies while its response is lost.
 */
async function setup({
  tabs = false,
  signIn,
}: { tabs?: boolean; signIn?: 'optional' } = {}) {
  // With `tabs`, a store whose changes reach other tabs (`BroadcastChannel`).
  const factory = new IDBFactory();
  const { f, runtime, other } = await twoPods((r) => void runtimes.push(r), {
    ...(tabs
      ? {
          openStore: (namespace) =>
            openSessionStore(namespace, factory, browserChannel),
        }
      : {}),
    ...(signIn ? { signIn } : {}),
  });
  const alice = f.id;
  const bob = other.id;
  f.setCatalogue(async (url) =>
    url.startsWith(bobUrl)
      ? catalogue([home], [home], bobUrl)
      : catalogue([work, personal], [work, personal]),
  );
  const store = new Map<string, Map<string, Stored>>([
    [
      work,
      new Map([
        ['urn:a', { title: 'Milk', done: false, version: 1 }],
        ['urn:s', { title: 'Shared', done: false, version: 1 }],
      ]),
    ],
    [home, new Map([['urn:s', { title: 'Shared', done: false, version: 1 }]])],
  ]);
  const body = (iri: string, t: Stored) => ({
    '@id': iri,
    '@type': [schema + 'Action'],
    [schema + 'name']: [{ '@value': t.title }],
    [schema + 'actionStatus']: [
      {
        '@id':
          schema + (t.done ? 'CompletedActionStatus' : 'PotentialActionStatus'),
      },
    ],
  });
  f.setQuery(async (url) => {
    const context = new URL(url).searchParams.get('default-graph-uri')!;
    return Response.json(
      [...(store.get(context) ?? [])].map(([iri, t]) => body(iri, t)),
    );
  });
  const writes: string[] = [];
  const control = { lose: null as string | null };
  f.setResource(async (url, init) => {
    const context = new URL(url).searchParams.get('context')!;
    const iri = resourceIri(url);
    const items = store.get(context);
    const t = items?.get(iri);
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return t
        ? Response.json(body(iri, t), { headers: { etag: `"t${t.version}"` } })
        : new Response(null, { status: 404 });
    const key = `${context.startsWith(bobUrl) ? 'bob' : 'alice'} ${iri}`;
    writes.push(`${method} ${key}`);
    if (!t) return new Response(null, { status: 404 });
    if (new Headers(init?.headers).get('if-match') !== `"t${t.version}"`)
      return new Response(null, { status: 412 });
    if (method === 'DELETE') items!.delete(iri);
    else {
      // The changed fields, whatever the write's form (a PATCH here).
      const sent = String(init!.body);
      items!.set(iri, {
        title: sent.includes('Oat milk') ? 'Oat milk' : t.title,
        done: sent.includes('CompletedActionStatus')
          ? true
          : sent.includes('PotentialActionStatus')
            ? false
            : t.done,
        version: t.version + 1,
      });
    }
    if (control.lose === key) {
      control.lose = null;
      throw new TypeError('Failed to fetch');
    }
    return new Response(null, {
      status: method === 'DELETE' ? 204 : 200,
      headers: { etag: `"t${items!.get(iri)?.version ?? 0}"` },
    });
  });
  outcomes.splice(0);
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Probe />
      <Overview names={{ [alice]: 'Alice', [bob]: 'Bob' }} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(state.activeId).toBe(bob));
  // Each Pod's rows, read in their own Context as an app's per-Pod read does.
  const read = async (connection: string, context: string) => {
    await runtime.loadContexts(connection);
    const result = await listSubjects(
      runtime.bindContext(connection, context),
      taskFields,
    );
    if (result.kind !== 'ok') throw new Error(result.kind);
    return result.body.items.map((snapshot): Row => ({
      connection,
      context,
      snapshot,
    }));
  };
  const rows = [...(await read(alice, work)), ...(await read(bob, home))];
  act(() => setRows(rows));
  await waitFor(() =>
    expect(toggle('Milk in Alice').hasAttribute('disabled')).toBe(false),
  );
  return { f, runtime, alice, bob, store, writes, control, rows };
}

/** Declines the SDK's leave question. */
const stay = () => screen.getByRole('button', { name: 'Keep editing' }).click();
const toggle = (where: string) =>
  screen.getByRole('button', { name: `Toggle ${where}` });
/** Milk, not done, as a Pod returns it. */
const milk = (iri: string) => ({
  '@id': iri,
  '@type': [schema + 'Action'],
  [schema + 'name']: [{ '@value': 'Milk' }],
  [schema + 'actionStatus']: [{ '@id': schema + 'PotentialActionStatus' }],
});
/** A Milk row (`urn:a`) read elsewhere: its snapshot needs no catalogue. */
async function milkRows(connection: string, context: string) {
  const listed = await listSubjects(
    {
      sparql: {
        construct: async () => ({ kind: 'ok', body: [milk('urn:a')] }),
      },
    } as unknown as Parameters<typeof listSubjects>[0],
    taskFields,
  );
  if (listed.kind !== 'ok') throw new Error(listed.kind);
  return listed.body.items.map((snapshot): Row => ({
    connection,
    context,
    snapshot,
  }));
}
/** Opens a row in the editor and leaves a draft (`Oat milk`) there. */
async function openWithDraft(target: {
  subject: string;
  context: string;
  connection: string;
}) {
  await act(async () => {
    expect(await edit.open(target)).toBe(true);
  });
  await waitFor(() => expect(edit.phase).toBe('ready'));
  await act(async () => {
    await edit.editor!.loaded;
  });
  act(() => edit.editor!.change({ title: 'Oat milk' }));
}

it('writes a row in the connection it was read from without selecting it', async () => {
  const { alice, bob, store, writes } = await setup();
  // Bob is active; Alice's rows are writable in her own work Context.
  expect(toggle('Shared in Bob').hasAttribute('disabled')).toBe(false);
  expect(screen.queryByText(/^Problem/)).toBeNull();
  act(() => toggle('Milk in Alice').click());
  await waitFor(() => expect(outcomes).toEqual(['Milk in Alice: saved']));
  expect(writes).toEqual(['PATCH alice urn:a']);
  expect(store.get(work)!.get('urn:a')!.done).toBe(true);
  // Neither the active Pod nor its selection changed.
  expect(state.activeId).toBe(bob);
  expect(
    state.connections.find((c) => c.id === alice)?.selectedContext,
  ).toBeNull();
});

it('keeps an unresolved row with its connection while the active Pod changes', async () => {
  const { alice, bob, writes, control, rows } = await setup();
  control.lose = 'alice urn:s';
  act(() => toggle('Shared in Alice').click());
  await waitFor(() =>
    expect(outcomes).toEqual(['Shared in Alice: unconfirmed']),
  );
  // The same subject IRI in Bob's Pod is another resource.
  expect(unresolved).toEqual([
    { connection: alice, context: work, iri: 'urn:s' },
  ]);
  expect(toggle('Shared in Alice').hasAttribute('disabled')).toBe(true);
  expect(toggle('Shared in Bob').hasAttribute('disabled')).toBe(false);
  // Switching the active Pod neither asks about nor retires it.
  let switched: boolean | undefined;
  await act(async () => {
    switched = await app.selectConnection(alice);
  });
  expect(switched).toBe(true);
  await act(async () => {
    await app.selectConnection(bob);
  });
  expect(unresolved).toEqual([
    { connection: alice, context: work, iri: 'urn:s' },
  ]);
  // Once its row leaves the screen, its notice stays reachable there.
  act(() => setRows(rows.filter((r) => r.connection !== alice)));
  const notices = screen.getByRole('region', { name: 'Unresolved' });
  await waitFor(() => expect(notices.textContent).not.toBe(''));
  // Bob's Shared, the same IRI on screen, does not hide it.
  expect(screen.getByText(/Toggle Shared in Bob/)).toBeTruthy();
  // Signing Bob out does not ask about it; signing Alice out does.
  await act(async () => {
    expect(await app.disconnect(bob)).toBe(true);
  });
  let signOut: Promise<boolean> | undefined;
  act(() => {
    signOut = app.disconnect(alice);
  });
  await waitFor(() => expect(state.confirmingLeave).toBe(true));
  act(() => stay());
  expect(await signOut).toBe(false);
  expect(writes).toEqual(['PATCH alice urn:s']);
});

it('runs a bulk removal one captured row at a time and stops on uncertainty', async () => {
  const { bob, store, writes, control } = await setup();
  control.lose = 'alice urn:s';
  act(() => screen.getByRole('button', { name: 'Remove all' }).click());
  await waitFor(() =>
    expect(outcomes).toEqual(['bulk: removed', 'bulk: unconfirmed']),
  );
  // Milk is gone, Shared's answer was lost, Bob's Shared is never sent.
  expect(writes).toEqual(['DELETE alice urn:a', 'DELETE alice urn:s']);
  expect(store.get(home)!.has('urn:s')).toBe(true);
  expect(state.activeId).toBe(bob);
});

it('edits a row in its own connection and keeps the draft across active Pod changes', async () => {
  const { alice, bob, writes } = await setup();
  const alices = { subject: 'urn:a', context: work, connection: alice };
  await openWithDraft(alices);
  expect(edit.target).toEqual(alices);
  // Another active Pod, there and back, neither asks nor retires it.
  await act(async () => {
    expect(await app.selectConnection(alice)).toBe(true);
    expect(await app.selectConnection(bob)).toBe(true);
  });
  expect(edit.phase).toBe('ready');
  expect(edit.editor!.state.draft?.title).toBe('Oat milk');
  // The same subject in another connection is another target.
  let other: Promise<boolean> | undefined;
  act(() => {
    other = edit.open({ subject: 'urn:s', context: home, connection: bob });
  });
  await waitFor(() => expect(state.confirmingLeave).toBe(true));
  act(() => stay());
  expect(await other).toBe(false);
  await act(async () => {
    await edit.editor!.save();
  });
  expect(writes).toEqual(['PATCH alice urn:a']);
  expect(state.activeId).toBe(bob);
});

it('ends the work bound to a connection once that connection is removed', async () => {
  const { alice, bob, control } = await setup();
  control.lose = 'alice urn:s';
  act(() => toggle('Shared in Alice').click());
  await waitFor(() =>
    expect(outcomes).toEqual(['Shared in Alice: unconfirmed']),
  );
  await act(async () => {
    await edit.open({ subject: 'urn:a', context: work, connection: alice });
  });
  await waitFor(() => expect(edit.phase).toBe('ready'));
  let removal: Promise<boolean> | undefined;
  act(() => {
    removal = app.forget(alice);
  });
  await waitFor(() => expect(state.confirmingLeave).toBe(true));
  act(() =>
    screen.getByRole('button', { name: 'Discard and continue' }).click(),
  );
  expect(await removal).toBe(true);
  await waitFor(() => expect(edit.phase).toBe('retired'));
  expect(unresolved).toEqual([]);
  expect(state.activeId).toBe(bob);
});

it('asks before leaving a live editor for a retained one of another connection', async () => {
  const { alice, bob, writes } = await setup();
  const bobs = { subject: 'urn:s', context: home, connection: bob };
  const alices = { subject: 'urn:a', context: work, connection: alice };
  await act(async () => {
    expect(await edit.open(bobs)).toBe(true);
  });
  await waitFor(() => expect(edit.phase).toBe('ready'));
  // Bob's idle editor stays retained once Alice's row opens.
  await openWithDraft(alices);
  // Back to Bob's row: Alice's draft is left, so the SDK asks first.
  let back: Promise<boolean> | undefined;
  act(() => {
    back = edit.open(bobs);
  });
  await waitFor(() => expect(state.confirmingLeave).toBe(true));
  act(() => stay());
  expect(await back).toBe(false);
  expect(edit.target).toEqual(alices);
  expect(edit.editor!.state.draft?.title).toBe('Oat milk');
  expect(writes).toEqual([]);
});

// While the person is asked: Alice's Pod is forgotten, or she signs out and
// her connection stays listed but no longer reads, also in another tab (one
// publication of the change).
it.each(['forget', 'disconnect', 'disconnect in another tab'] as const)(
  'withdraws the question when the row to open goes meanwhile (%s)',
  async (leave) => {
    const { f, runtime, alice, bob } = await setup({
      tabs: leave === 'disconnect in another tab',
    });
    const other =
      leave === 'disconnect in another tab'
        ? createBrowserRuntime({
            ...f.options,
            location: () => 'https://app.example/',
          })
        : null;
    if (other) {
      runtimes.push(other);
      await other.initialize();
      await restored(other);
    }
    const bobs = { subject: 'urn:s', context: home, connection: bob };
    await openWithDraft(bobs);
    let opening: Promise<boolean> | undefined;
    act(() => {
      opening = edit.open({
        subject: 'urn:a',
        context: work,
        connection: alice,
      });
    });
    await waitFor(() => expect(state.confirmingLeave).toBe(true));
    await act(async () => {
      if (other) await other.disconnect(alice);
      else if (leave === 'forget') await runtime.forget(alice);
      else await runtime.disconnect(alice);
    });
    if (other)
      await waitFor(() =>
        expect(
          state.connections.find((c) => c.id === alice)?.reading ?? null,
        ).toBeNull(),
      );
    expect(state.connections.some((c) => c.id === alice)).toBe(
      leave !== 'forget',
    );
    expect(await opening).toBe(false);
    expect(state.confirmingLeave).toBe(false);
    expect(edit.target).toEqual(bobs);
    expect(edit.phase).toBe('ready');
    expect(edit.editor!.state.draft?.title).toBe('Oat milk');
  },
);

it('keeps the question about a row of another connection while the active one changes', async () => {
  const { f, alice, bob } = await setup({ tabs: true });
  const other = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(other);
  await other.initialize();
  await restored(other);
  await openWithDraft({ subject: 'urn:s', context: home, connection: bob });
  const alices = { subject: 'urn:a', context: work, connection: alice };
  let opening: Promise<boolean> | undefined;
  act(() => {
    opening = edit.open(alices);
  });
  await waitFor(() => expect(state.confirmingLeave).toBe(true));
  // Bob signs out in another tab: Alice becomes active. Her row does not
  // depend on that, so the question stays.
  await act(async () => {
    await other.disconnect(bob);
  });
  await waitFor(() => expect(state.activeId).toBe(alice));
  expect(state.confirmingLeave).toBe(true);
  act(() =>
    screen.getByRole('button', { name: 'Discard and continue' }).click(),
  );
  expect(await opening).toBe(true);
  expect(edit.target).toEqual(alices);
});

// Alice's work Context, listed when her row is opened, loses its access
// while the person is asked: revoked while she stays signed in, or not in the
// catalogue she reads without a token after signing out in another tab
// (optional sign-in).
it.each(['revoked', 'signed out in another tab'] as const)(
  'withdraws the question when the Context to open loses its access meanwhile (%s)',
  async (how) => {
    const tab = how === 'signed out in another tab';
    const { f, alice, bob } = await setup(
      tab ? { tabs: true, signIn: 'optional' } : {},
    );
    const other = tab
      ? createBrowserRuntime({
          ...f.options,
          location: () => 'https://app.example/',
        })
      : null;
    if (other) {
      runtimes.push(other);
      await other.initialize();
      await restored(other);
    }
    const bobs = { subject: 'urn:s', context: home, connection: bob };
    await openWithDraft(bobs);
    let opening: Promise<boolean> | undefined;
    act(() => {
      opening = edit.open({
        subject: 'urn:a',
        context: work,
        connection: alice,
      });
    });
    await waitFor(() => expect(state.confirmingLeave).toBe(true));
    f.setCatalogue(async (url) =>
      url.startsWith(bobUrl)
        ? catalogue([home], [home], bobUrl)
        : catalogue([personal], [personal]),
    );
    await act(async () => {
      if (other) await other.disconnect(alice);
      else await app.refreshContexts(alice);
    });
    // Her shown rows ask for the catalogue she reads now.
    await waitFor(() =>
      expect(
        state.connections.find((c) => c.id === alice)?.catalogue.kind,
      ).toBe('ready'),
    );
    expect(await opening).toBe(false);
    expect(state.confirmingLeave).toBe(false);
    expect(edit.target).toEqual(bobs);
    expect(edit.editor!.state.draft?.title).toBe('Oat milk');
  },
);

// Alice's catalogue is read again while the person is asked: an earlier
// listing of her work Context does not count while that read is under way,
// nor after it failed.
it.each(['while refreshing', 'after a failed refresh'] as const)(
  'keeps the draft when the destination listing is not fresh (%s)',
  async (when) => {
    const { f, alice, bob } = await setup();
    const bobs = { subject: 'urn:s', context: home, connection: bob };
    await openWithDraft(bobs);
    let opening: Promise<boolean> | undefined;
    act(() => {
      opening = edit.open({
        subject: 'urn:a',
        context: work,
        connection: alice,
      });
    });
    await waitFor(() => expect(state.confirmingLeave).toBe(true));
    let answer: (response: Response) => void = () => {};
    f.setCatalogue(async (url) =>
      url.startsWith(bobUrl)
        ? catalogue([home], [home], bobUrl)
        : when === 'while refreshing'
          ? new Promise<Response>((resolve) => (answer = resolve))
          : new Response(null, { status: 403 }),
    );
    let refreshed: Promise<unknown> | undefined;
    act(() => {
      refreshed = app.refreshContexts(alice).catch(() => {});
    });
    const alices = () => state.connections.find((c) => c.id === alice)!;
    if (when === 'while refreshing') {
      await waitFor(() => expect(alices().catalogue.kind).toBe('loading'));
      // Confirmed before the answer: nothing runs.
      act(() =>
        screen.getByRole('button', { name: 'Discard and continue' }).click(),
      );
      expect(await opening).toBe(false);
      await act(async () => {
        answer(catalogue([personal], [personal]));
        await refreshed;
      });
    } else {
      await act(async () => {
        await refreshed;
      });
      expect(alices().catalogue.kind).toBe('failed');
      expect(await opening).toBe(false);
    }
    expect(state.confirmingLeave).toBe(false);
    expect(edit.target).toEqual(bobs);
    expect(edit.editor!.state.draft?.title).toBe('Oat milk');
  },
);

/** Rows the child shows from its own state; the parent only owns the hook. */
let showRows: (rows: readonly Row[]) => void;
function Revealing({
  overview,
}: {
  readonly overview: ReturnType<typeof useContextUpdate<Task>>;
}) {
  const [rows, set] = useState<readonly Row[]>([]);
  useEffect(() => {
    showRows = set;
  }, []);
  return (
    <ul>
      {rows.map((item) => {
        const row = overview.for(item);
        return (
          <li key={item.snapshot.iri}>
            <button disabled={!row.canMutate}>Toggle {row.data.title}</button>
          </li>
        );
      })}
    </ul>
  );
}
function Owner() {
  const overview = useContextUpdate(taskFields);
  state = useAppState();
  return <Revealing overview={overview} />;
}

it("asks for an inactive Pod's catalogue when a row's own component first shows it", async () => {
  const two = await twoPods((r) => void runtimes.push(r));
  const { f } = two;
  const bob = two.other.id;
  f.setCatalogue(async (url) =>
    url.startsWith(bobUrl)
      ? catalogue([home], [home], bobUrl)
      : catalogue([work, personal], [work, personal]),
  );
  // A later page start, not a sign-in's return: no catalogue is read yet.
  two.runtime.dispose();
  await settleLease();
  const runtime = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(runtime);
  await runtime.initialize();
  await restored(runtime);
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Owner />
    </SempodsProvider>,
  );
  await waitFor(() => expect(showRows).toBeDefined());
  // Bob's Pod is not active, and nothing read its catalogue yet.
  const bobs = () => state.connections.find((c) => c.id === bob)!;
  await waitFor(() => expect(state.activeId).toBe(f.id));
  expect(bobs().catalogue.kind).toBe('unknown');
  // A row read elsewhere: its snapshot needs no catalogue to exist.
  const rows = await milkRows(bob, home);
  act(() => showRows(rows));
  await waitFor(() => expect(bobs().catalogue.kind).toBe('ready'));
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Toggle Milk' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
});

it("drops catalogue demand once a row's own component hides its last row", async () => {
  const factory = new IDBFactory();
  const { f, runtime, other } = await twoPods((r) => void runtimes.push(r), {
    signIn: 'optional',
    openStore: (namespace) =>
      openSessionStore(namespace, factory, browserChannel),
  });
  const tab = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  runtimes.push(tab);
  await tab.initialize();
  await restored(tab);
  const alice = f.id;
  const bob = other.id;
  let asked = 0;
  f.setCatalogue(async (url) => {
    if (url.startsWith(bobUrl)) return catalogue([home], [home], bobUrl);
    asked++;
    return catalogue([work, personal], [work, personal]);
  });
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Owner />
    </SempodsProvider>,
  );
  await waitFor(() => expect(showRows).toBeDefined());
  await waitFor(() => expect(state.activeId).toBe(bob));
  await act(async () => {
    await runtime.loadContexts(alice);
  });
  const alices = () => state.connections.find((c) => c.id === alice)!;
  await waitFor(() => expect(alices().catalogue.kind).toBe('ready'));
  // The child switches from Alice's row in one Context to one in another,
  // then hides them all; her catalogue is there throughout.
  const inWork = await milkRows(alice, work);
  const inPersonal = await milkRows(alice, personal);
  // The first shown row renders the hook's owner again, before the switch.
  await act(async () => {
    showRows(inWork);
    await Promise.resolve();
  });
  act(() => showRows(inPersonal));
  act(() => showRows([]));
  asked = 0;
  // Signed out in another tab under optional sign-in, she reads without a
  // token, with no catalogue yet: no row of hers asks for one.
  await act(async () => {
    await tab.disconnect(alice);
  });
  await waitFor(() => expect(alices().reading).toBe('anonymous'));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(asked).toBe(0);
  expect(alices().catalogue.kind).toBe('unknown');
});

it('retires an editor whose connection is forgotten and added again under its ID', async () => {
  const f = fixture({
    preferences: null,
    signIn: 'optional',
    preset: { podUrl: pod },
  });
  runtimes.push(f.runtime);
  f.setCatalogue(async () => catalogue([work], []));
  f.setResource(async (url) =>
    Response.json(milk(resourceIri(url)), { headers: { etag: '"t1"' } }),
  );
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Probe />
      <Overview names={{}} />
    </SempodsProvider>,
  );
  // The default Pod, read without a token, under its stable ID.
  await waitFor(() => expect(state.activeId).toBe(pod));
  await act(async () => {
    await edit.open({ subject: 'urn:a', context: work, connection: pod });
  });
  await waitFor(() => expect(edit.phase).toBe('ready'));
  await act(async () => {
    expect(await app.forget(pod)).toBe(true);
  });
  // The runtime lists the default Pod again under the same ID.
  expect(state.connections.map((c) => c.id)).toEqual([pod]);
  await waitFor(() => expect(edit.phase).toBe('retired'));
});

it('asks for no catalogue of a connection once its rows are gone, also when it needs one again', async () => {
  const { f, runtime, alice, rows } = await setup({ signIn: 'optional' });
  const aliceState = () => state.connections.find((c) => c.id === alice)!;
  expect(aliceState().catalogue.kind).toBe('ready');
  let asked = 0;
  f.setCatalogue(async (url) => {
    if (url.startsWith(bobUrl)) return catalogue([home], [home], bobUrl);
    asked++;
    return catalogue([work, personal], [work, personal]);
  });
  // Alice's rows are filtered out, then she signs out: under optional
  // sign-in her connection reads without a token, with no catalogue yet.
  act(() => setRows(rows.filter((row) => row.connection !== alice)));
  await act(async () => {
    await runtime.disconnect(alice);
  });
  await waitFor(() => expect(aliceState().reading).toBe('anonymous'));
  expect(aliceState().catalogue.kind).toBe('unknown');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(asked).toBe(0);
  expect(aliceState().catalogue.kind).toBe('unknown');
  // A row of hers shown again asks for it.
  act(() => setRows(rows));
  await waitFor(() => expect(aliceState().catalogue.kind).toBe('ready'));
  expect(asked).toBe(1);
});

it('asks for no catalogue of a connection added again once its rows are gone', async () => {
  const f = fixture({
    preferences: null,
    signIn: 'optional',
    preset: { podUrl: pod },
  });
  runtimes.push(f.runtime);
  const asked: string[] = [];
  f.setCatalogue(async (url) => {
    asked.push(url.startsWith(bobUrl) ? 'bob' : 'default');
    return url.startsWith(bobUrl)
      ? catalogue([home], [], bobUrl)
      : catalogue([work], []);
  });
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Probe />
      <Overview names={{}} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(state.activeId).toBe(pod));
  // Bob's Pod, read without a token, becomes the active one.
  const bob = (await f.runtime.connect(bobUrl)).id;
  await act(async () => {
    expect(await app.selectConnection(bob)).toBe(true);
  });
  await waitFor(() => expect(state.activeId).toBe(bob));
  const defaults = () => state.connections.find((c) => c.id === pod)!;
  // A row of the default Pod asks for its catalogue.
  const rows = await milkRows(pod, work);
  act(() => setRows(rows));
  await waitFor(() => expect(defaults().catalogue.kind).toBe('ready'));
  const before = asked.filter((a) => a === 'default').length;
  // Its rows are filtered out, then it is forgotten: the runtime lists the
  // default Pod again under the same ID, with no catalogue read.
  act(() => setRows([]));
  await act(async () => {
    expect(await app.forget(pod)).toBe(true);
  });
  expect(state.connections.map((c) => c.id)).toContain(pod);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(asked.filter((a) => a === 'default').length).toBe(before);
  expect(defaults().catalogue.kind).toBe('unknown');
  // A row of its own asks again.
  act(() => setRows(rows));
  await waitFor(() => expect(defaults().catalogue.kind).toBe('ready'));
  expect(asked.filter((a) => a === 'default').length).toBe(before + 1);
});

/** Only an editor, and whether anything demands catalogue discovery. */
let demanded = false;
function EditorOnly() {
  state = useAppState();
  edit = useContextEditor(taskFields);
  demanded = useDiscoveryDemand();
  return null;
}

it('demands discovery for a row of the active connection opened with its connection', async () => {
  const { f, runtime, other } = await twoPods((r) => void runtimes.push(r));
  const bob = other.id;
  f.setCatalogue(async (url) =>
    url.startsWith(bobUrl)
      ? catalogue([home], [home], bobUrl)
      : catalogue([work, personal], [work, personal]),
  );
  f.setResource(async (url) =>
    Response.json(milk(resourceIri(url)), { headers: { etag: '"t1"' } }),
  );
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <EditorOnly />
    </SempodsProvider>,
  );
  await waitFor(() => expect(state.activeId).toBe(bob));
  expect(demanded).toBe(false);
  // Bob's own row, with its connection, as an overview across Pods opens it:
  // AppAccess presents his catalogue as for a row without `connection`.
  await act(async () => {
    expect(
      await edit.open({ subject: 'urn:s', context: home, connection: bob }),
    ).toBe(true);
  });
  await waitFor(() => expect(edit.phase).toBe('ready'));
  expect(demanded).toBe(true);
});
