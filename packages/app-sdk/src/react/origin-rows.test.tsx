// @vitest-environment jsdom
/** Overview rows and editors bound to the connection they were read from (#408). */
import { webcrypto } from 'node:crypto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
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
} from '@sempods/app-sdk/react';
import { taskFields, type Task } from '../../../../examples/todo/src/domain.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  personal,
  resourceIri,
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
async function setup() {
  const { f, runtime, other } = await twoPods((r) => void runtimes.push(r));
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
  let opened: boolean | undefined;
  await act(async () => {
    opened = await edit.open({
      subject: 'urn:a',
      context: work,
      connection: alice,
    });
  });
  expect(opened).toBe(true);
  await waitFor(() => expect(edit.phase).toBe('ready'));
  expect(edit.target).toEqual({
    subject: 'urn:a',
    context: work,
    connection: alice,
  });
  await act(async () => {
    await edit.editor!.loaded;
  });
  act(() => edit.editor!.change({ title: 'Oat milk' }));
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
