// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { Suspense, startTransition, useLayoutEffect, useState } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fields, text } from '@sempods/client-sdk/edit';
import { fixture, personal, work } from '../runtime/fixture.test.js';
import {
  SempodsProvider,
  TargetScreen,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
  useLoad,
  usePodLoad,
} from './index.js';

const cleanups: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function suspendedRender() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('a child layout draft change is kept for a parent layout creation', async () => {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  const definition = fields({ title: text('urn:title', { language: null }) });
  const sent: unknown[] = [];
  f.setResource(async (_, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response(null, { status: 201 });
  });
  let outcome: unknown;
  function Child({
    change,
    revision,
  }: {
    change: (patch: { title: string }) => void;
    revision: number;
  }) {
    useLayoutEffect(() => {
      if (revision === 1) change({ title: 'From child' });
    }, [change, revision]);
    return null;
  }
  function Parent() {
    const [revision, setRevision] = useState(0);
    const creation = useCreation(definition, {
      initial: { title: '' },
      collection: 'tasks',
    });
    const { create } = creation;
    useLayoutEffect(() => {
      if (revision === 1)
        void create().then((result) => {
          outcome = result;
        });
    }, [create, revision]);
    return (
      <>
        <Child change={creation.change} revision={revision} />
        <button
          onClick={() => {
            creation.change({ title: 'Before child' });
            setRevision(1);
          }}
        >
          Prepare draft
        </button>
      </>
    );
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Parent />
      </TargetScreen>
    </SempodsProvider>,
  );
  fireEvent.click(await screen.findByText('Prepare draft'));
  await waitFor(() => expect(outcome).toMatchObject({ kind: 'created' }));
  expect(sent).toEqual([
    expect.objectContaining({
      'urn:title': [{ '@value': 'From child' }],
    }),
  ]);
});

it.each(['context', 'pod'] as const)(
  'a child layout effect reloads %s data with the same commit inputs and retention',
  async (kind) => {
    const f = fixture();
    const session = await f.login();
    cleanups.push(() => session.runtime.dispose());
    const reads: string[] = [];
    const gate = suspendedRender();
    let delay = false;
    const useRead = kind === 'context' ? useLoad<string> : usePodLoad<string>;
    function Child({
      reload,
      query,
    }: {
      reload: () => unknown;
      query: string;
    }) {
      useLayoutEffect(() => {
        if (query === 'B') void reload();
      }, [reload, query]);
      return null;
    }
    function Parent() {
      const [query, setQuery] = useState('A');
      const load = useRead(
        async () => {
          reads.push(query);
          if (delay) await gate.promise;
          return { kind: 'ok', body: query };
        },
        { retain: query === 'A' },
      );
      return (
        <>
          <Child reload={load.reload} query={query} />
          <button onClick={() => setQuery('B')}>Next query</button>
          <span>
            Data: {load.state.kind === 'ready' ? load.data : load.state.kind}
          </span>
          <span>
            Previous: {'previous' in load.state ? load.state.previous : 'none'}
          </span>
        </>
      );
    }
    render(
      <SempodsProvider runtime={session.runtime}>
        <TargetScreen>
          <Parent />
        </TargetScreen>
      </SempodsProvider>,
    );
    await screen.findByText('Data: A');
    delay = true;
    fireEvent.click(screen.getByText('Next query'));
    await screen.findByText('Data: loading');
    expect(reads).toEqual(['A', 'B']);
    expect(screen.getByText('Previous: none')).toBeTruthy();
    await act(async () => gate.resolve());
    await screen.findByText('Data: B');
  },
);

it.each(['draft', 'unconfirmed'] as const)(
  'Suspense hiding and revealing a mounted creation preserves its %s and guard',
  async (operation) => {
    const f = fixture();
    const session = await f.login();
    cleanups.push(() => session.runtime.dispose());
    const definition = fields({ title: text('urn:title', { language: null }) });
    const hidden = suspendedRender();
    let rejectWrite!: (error: Error) => void;
    const answer = new Promise<Response>((_, reject) => {
      rejectWrite = reject;
    });
    let writes = 0;
    f.setResource(async () => {
      writes++;
      return operation === 'unconfirmed'
        ? answer
        : new Response(null, { status: 201 });
    });
    let result: unknown = 'pending';
    let navigation: unknown = 'pending';
    function Probe({ hide }: { hide: boolean }) {
      const creation = useCreation(definition, {
        initial: { title: '' },
        collection: 'tasks',
      });
      if (hide) throw hidden.promise;
      return (
        <>
          <input
            aria-label="Draft"
            value={creation.draft.title}
            disabled={!creation.canEdit}
            onChange={(event) => creation.change({ title: event.target.value })}
          />
          <button
            disabled={!creation.canCreate}
            onClick={() =>
              void creation.create().then((value) => {
                result = value;
              })
            }
          >
            Create
          </button>
          <span>Outcome: {creation.outcome?.kind ?? 'none'}</span>
        </>
      );
    }
    function Host() {
      const [hide, setHide] = useState(false);
      const app = useApp();
      return (
        <>
          <button onClick={() => setHide(true)}>Hide</button>
          <button onClick={() => setHide(false)}>Reveal</button>
          <button
            onClick={() =>
              void app.selectContext(personal).then((value) => {
                navigation = value;
              })
            }
          >
            Change context
          </button>
          <Suspense fallback={<span>Fallback</span>}>
            <Probe hide={hide} />
          </Suspense>
        </>
      );
    }
    render(
      <SempodsProvider runtime={session.runtime}>
        <TargetScreen>
          <Host />
        </TargetScreen>
      </SempodsProvider>,
    );
    await screen.findByLabelText('Draft');
    act(() =>
      fireEvent.change(screen.getByLabelText('Draft'), {
        target: { value: 'Task' },
      }),
    );
    await waitFor(() =>
      expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    if (operation === 'unconfirmed') {
      act(() => fireEvent.click(screen.getByText('Create')));
      await waitFor(() => expect(writes).toBe(1));
    }
    act(() => fireEvent.click(screen.getByText('Hide')));
    await screen.findByText('Fallback');
    if (operation === 'unconfirmed') {
      await act(async () =>
        rejectWrite(new TypeError('Answer lost while hidden')),
      );
      await waitFor(() =>
        expect(result).toMatchObject({ kind: 'unconfirmed' }),
      );
    }
    act(() => fireEvent.click(screen.getByText('Change context')));
    await screen.findByRole('alertdialog');
    expect(
      session.runtime
        .getSnapshot()
        .find((connection) => connection.id === session.id)?.selectedContext,
    ).toBe(work);
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })),
    );
    await waitFor(() => expect(navigation).toBe(false));
    act(() => fireEvent.click(screen.getByText('Reveal')));
    await waitFor(() => expect(screen.queryByText('Fallback')).toBeNull());
    expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe(
      'Task',
    );
    expect((screen.getByText('Create') as HTMLButtonElement).disabled).toBe(
      operation === 'unconfirmed',
    );
    if (operation === 'draft') {
      act(() => fireEvent.click(screen.getByText('Create')));
      await waitFor(() => expect(result).toMatchObject({ kind: 'created' }));
      expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe(
        '',
      );
    } else expect(screen.getByText('Outcome: unconfirmed')).toBeTruthy();
    expect(writes).toBe(1);
  },
);

it.each(['context', 'pod'] as const)(
  '%s reload uses committed inputs through suspension and a later commit',
  async (kind) => {
    const f = fixture();
    const session = await f.login();
    cleanups.push(() => session.runtime.dispose());
    const gate = suspendedRender();
    const reads: string[] = [];
    const commits: string[] = [];
    let attemptedB = false;
    let suspended = true;
    let reloadGate: ReturnType<typeof suspendedRender> | undefined;
    const useRead = kind === 'context' ? useLoad<string> : usePodLoad<string>;
    function Probe({ query }: { query: string }) {
      const load = useRead(
        async () => {
          reads.push(query);
          await reloadGate?.promise;
          return { kind: 'ok', body: query };
        },
        { retain: query === 'A' },
      );
      useLayoutEffect(() => {
        commits.push(query);
      });
      if (query === 'B' && suspended) {
        attemptedB = true;
        throw gate.promise;
      }
      return (
        <>
          <span>Visible query: {query}</span>
          <span>
            Data:{' '}
            {load.state.kind === 'ready' ? load.state.data : load.state.kind}
          </span>
          <span>
            Previous: {'previous' in load.state ? load.state.previous : 'none'}
          </span>
          <button onClick={() => void load.reload()}>Reload</button>
        </>
      );
    }
    function Host() {
      const [query, setQuery] = useState('A');
      return (
        <>
          <button onClick={() => startTransition(() => setQuery('B'))}>
            Start B
          </button>
          <Suspense fallback={<span>Fallback</span>}>
            <Probe query={query} />
          </Suspense>
        </>
      );
    }
    render(
      <SempodsProvider runtime={session.runtime}>
        <TargetScreen>
          <Host />
        </TargetScreen>
      </SempodsProvider>,
    );
    await screen.findByText('Data: A');
    act(() => fireEvent.click(screen.getByText('Start B')));
    await waitFor(() => expect(attemptedB).toBe(true));
    expect(screen.getByText('Visible query: A')).toBeTruthy();
    expect(commits.every((value) => value === 'A')).toBe(true);
    reloadGate = suspendedRender();
    act(() => fireEvent.click(screen.getByText('Reload')));
    await screen.findByText('Data: loading');
    expect(screen.getByText('Previous: A')).toBeTruthy();
    await act(async () => reloadGate!.resolve());
    expect(reads).toEqual(['A', 'A']);
    expect(screen.getByText('Data: A')).toBeTruthy();

    await act(async () => {
      suspended = false;
      gate.resolve();
    });
    await screen.findByText('Visible query: B');
    reloadGate = suspendedRender();
    act(() => fireEvent.click(screen.getByText('Reload')));
    await screen.findByText('Data: loading');
    expect(screen.getByText('Previous: none')).toBeTruthy();
    await act(async () => reloadGate!.resolve());
    expect(reads).toEqual(['A', 'A', 'B']);
    expect(screen.getByText('Data: B')).toBeTruthy();
  },
);

it.each(['update', 'create', 'draft'] as const)(
  'an abandoned schema render preserves the committed %s and its Context guard',
  async (operation) => {
    const f = fixture();
    const session = await f.login();
    cleanups.push(() => session.runtime.dispose());
    const definitionA = fields(
      { title: text('urn:title', { language: null }) },
      { type: 'urn:Task' },
    );
    const definitionB = fields(
      { title: text('urn:title-b', { language: null }) },
      { type: 'urn:Task' },
    );
    const row = {
      '@id': 'urn:one',
      '@type': ['urn:Task'],
      'urn:title': [{ '@value': 'One' }],
    };
    f.setQuery(async () => Response.json([row]));
    let rejectWrite!: (error: Error) => void;
    const answer = new Promise<Response>((_, reject) => {
      rejectWrite = reject;
    });
    let writes = 0;
    f.setResource(async (_, init) => {
      if ((init?.method ?? 'GET') === 'GET')
        return Response.json(row, { headers: { etag: '"v1"' } });
      writes++;
      return answer;
    });
    let result: unknown = 'pending';
    let navigation: unknown = 'pending';
    let attemptedB = false;
    const commits: string[] = [];
    const gate = suspendedRender();
    function Probe({ schema }: { schema: string }) {
      const definition = schema === 'A' ? definitionA : definitionB;
      const list = useList(definitionA);
      const update = useFieldUpdate(definition);
      const creation = useCreation(definition, {
        initial: { title: '' },
        collection: 'tasks',
      });
      const app = useApp();
      useLayoutEffect(() => {
        commits.push(schema);
      });
      if (schema === 'B') {
        attemptedB = true;
        throw gate.promise;
      }
      const row = list.data?.items[0];
      const own = row ? update.for(row) : undefined;
      const outcome =
        operation === 'update' ? own?.notice.outcome : creation.outcome;
      return (
        <>
          <span>Visible schema: {schema}</span>
          <span>Mutation: {outcome?.kind ?? 'idle'}</span>
          <input
            aria-label="Creation draft"
            value={creation.draft.title}
            disabled={!creation.canEdit}
            onChange={(event) => creation.change({ title: event.target.value })}
          />
          <button
            disabled={
              operation === 'update'
                ? !own?.canMutate || list.state.kind !== 'ready'
                : !creation.canCreate
            }
            onClick={() => {
              if (operation === 'update' && list.state.kind === 'ready')
                void update
                  .for(list.state.data.items[0]!)
                  .update({ title: 'Mine' })
                  .then((value) => {
                    result = value;
                  });
              else
                void creation.create().then((value) => {
                  result = value;
                });
            }}
          >
            Save
          </button>
          <button
            onClick={() =>
              void app.selectContext(personal).then((value) => {
                navigation = value;
              })
            }
          >
            Change context
          </button>
        </>
      );
    }
    function Host() {
      const [schema, setSchema] = useState('A');
      return (
        <>
          <button onClick={() => startTransition(() => setSchema('B'))}>
            Start B
          </button>
          <button onClick={() => setSchema('A')}>Abandon B</button>
          <Suspense fallback={<span>Fallback</span>}>
            <Probe schema={schema} />
          </Suspense>
        </>
      );
    }
    render(
      <SempodsProvider runtime={session.runtime}>
        <TargetScreen>
          <Host />
        </TargetScreen>
      </SempodsProvider>,
    );
    await screen.findByText('Visible schema: A');
    if (operation !== 'update')
      act(() =>
        fireEvent.change(screen.getByLabelText('Creation draft'), {
          target: { value: 'Mine' },
        }),
      );
    await waitFor(() =>
      expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    if (operation !== 'draft') {
      act(() => fireEvent.click(screen.getByText('Save')));
      await waitFor(() => expect(writes).toBe(1));
    }
    act(() => fireEvent.click(screen.getByText('Start B')));
    await waitFor(() => expect(attemptedB).toBe(true));
    expect(screen.getByText('Visible schema: A')).toBeTruthy();
    expect(commits.every((value) => value === 'A')).toBe(true);
    if (operation !== 'draft') {
      await act(async () =>
        rejectWrite(new TypeError('Answer lost after dispatch')),
      );
      await waitFor(() =>
        expect(result).toMatchObject({ kind: 'unconfirmed' }),
      );
      await screen.findByText('Mutation: unconfirmed');
    }
    act(() => fireEvent.click(screen.getByText('Abandon B')));
    if (operation !== 'update')
      expect(
        (screen.getByLabelText('Creation draft') as HTMLInputElement).value,
      ).toBe('Mine');
    act(() => fireEvent.click(screen.getByText('Change context')));
    await screen.findByRole('alertdialog');
    expect(
      session.runtime
        .getSnapshot()
        .find((connection) => connection.id === session.id)?.selectedContext,
    ).toBe(work);
    act(() =>
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' })),
    );
    await waitFor(() => expect(navigation).toBe(false));
    expect(writes).toBe(operation === 'draft' ? 0 : 1);
  },
);
