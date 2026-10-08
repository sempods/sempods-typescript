// @vitest-environment jsdom
import { Component, StrictMode, useState, type ReactNode } from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { fields, text } from '@sempods/client-sdk/edit';
import type { PodFetch } from '@sempods/client-sdk';
import {
  AppAccess,
  ResourceEditor,
  SempodsProvider,
  TargetScreen,
  useApp,
  useAppState,
  useContextEditor,
  useDraftGuard,
  type ContextTarget,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { RuntimeError } from '../runtime/errors.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  pod,
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
const keep = (runtime: BrowserRuntime) => void runtimes.push(runtime);
const returned = (f?: ReturnType<typeof fixture>) => returnedSession(keep, f);

const note = fields(
  { title: text('urn:note:title', { language: null }) },
  { type: 'urn:Note' },
);
const rows: readonly ContextTarget[] = [
  { subject: 'urn:a', context: work },
  { subject: 'urn:b', context: work },
  { subject: 'urn:a', context: personal },
  { subject: 'urn:x', context: 'https://pod.example/bob/_system/contexts/x' },
];
const label = (t: ContextTarget) =>
  `Edit ${t.subject} in ${
    t.context === work ? 'work' : t.context === personal ? 'personal' : 'bob'
  }`;
/** One note per Context and subject; records conditional writes. */
function notes(f: { setResource(fn: PodFetch): void }) {
  const data = new Map([
    [`${work} urn:a`, { title: 'A at work', version: 1 }],
    [`${work} urn:b`, { title: 'B at work', version: 1 }],
    [`${personal} urn:a`, { title: 'A at home', version: 1 }],
  ]);
  const writes: {
    readonly context: string | null;
    readonly iri: string;
    readonly ifMatch: string | null;
  }[] = [];
  const reads: string[] = [];
  const control = {
    hold: null as Promise<void> | null,
    offline: false,
  };
  f.setResource(async (url, init) => {
    const target = new URL(url);
    const iri = resourceIri(url);
    const context = target.searchParams.get('context');
    const stored = data.get(`${context} ${iri}`);
    if ((init?.method ?? 'GET') === 'GET') {
      reads.push(`${context} ${iri}`);
      if (control.offline) throw new TypeError('offline');
      return stored
        ? Response.json(
            {
              '@id': iri,
              '@type': ['urn:Note'],
              'urn:note:title': [{ '@value': stored.title }],
            },
            { headers: { etag: `"n${stored.version}"` } },
          )
        : new Response(null, { status: 404 });
    }
    writes.push({
      context,
      iri,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    await control.hold;
    if (stored) stored.version++;
    return new Response(null, { status: 204 });
  });
  return { data, writes, reads, control };
}
/** A creation-style draft in the selected Context (target scope). */
function SelectedDraft() {
  const [draft, setDraft] = useState('');
  useDraftGuard(draft !== '', () => setDraft(''));
  return (
    <input
      aria-label="Selected draft"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}
function Harness({ selected = false }: { readonly selected?: boolean }) {
  const [manage, setManage] = useState(false);
  const [result, setResult] = useState('');
  const edit = useContextEditor(note);
  const app = useApp();
  const { activeId } = useAppState();
  return (
    <>
      <AppAccess appName="Overview" open={manage} />
      <output data-testid="active">{activeId}</output>
      <button onClick={() => setManage(!manage)}>Manage access</button>
      <output data-testid="phase">
        {edit.problem ? `${edit.phase}:${edit.problem}` : edit.phase}
      </output>
      {rows.map((row) => (
        <button key={label(row)} onClick={() => void edit.open(row)}>
          {label(row)}
        </button>
      ))}
      <button onClick={() => void edit.close()}>Close editor</button>
      <button onClick={() => void app.selectContext(personal)}>
        Select personal
      </button>
      <button
        onClick={() =>
          void Promise.all([edit.open(rows[0]!), edit.open(rows[0]!)]).then(
            (r) => setResult(JSON.stringify(r)),
          )
        }
      >
        Open urn:a twice
      </button>
      <button
        onClick={() =>
          void Promise.all([edit.open(rows[1]!), edit.open(rows[1]!)]).then(
            (r) => setResult('b:' + JSON.stringify(r)),
          )
        }
      >
        Open urn:b twice
      </button>
      <button
        onClick={() =>
          void (async () => {
            const opened = await edit.open(rows[0]!);
            const switched = await edit.open(rows[1]!);
            const closed = await edit.close();
            setResult(JSON.stringify([opened, switched, closed]));
          })()
        }
      >
        Open, switch and close
      </button>
      <output data-testid="result">{result}</output>
      {edit.editor && (
        <ResourceEditor editor={edit.editor}>
          {(value, change) => (
            <input
              aria-label="Note title"
              value={value.title}
              onChange={(e) => change({ title: e.target.value })}
            />
          )}
        </ResourceEditor>
      )}
      {selected && (
        <TargetScreen>
          <SelectedDraft />
        </TargetScreen>
      )}
    </>
  );
}
function Switch({ id }: { readonly id: string }) {
  const app = useApp();
  return (
    <button onClick={() => void app.selectConnection(id)}>Switch Pod</button>
  );
}
const phase = () => screen.getByTestId('phase').textContent;
const title = () => screen.getByLabelText('Note title') as HTMLInputElement;
/** Opens a row once a connection is active, as an overview only offers then. */
async function open(row: string, active?: string) {
  await waitFor(() =>
    expect(screen.getByTestId('active').textContent).toEqual(
      active ?? expect.stringMatching(/./),
    ),
  );
  fireEvent.click(screen.getByText(row));
}
function ui(runtime: BrowserRuntime, children = <Harness />) {
  return (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      {children}
    </SempodsProvider>
  );
}

it('edits a row in its own Context with a fresh read and If-Match, leaving the selection alone', async () => {
  const f = await returned();
  const { writes } = notes(f);
  const bind = vi.spyOn(f.runtime, 'bindContext');
  const select = vi.spyOn(f.runtime, 'selectContext');
  render(ui(f.runtime));
  // The callback completes and the session restores before the row opens.
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active'),
  );
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  expect(phase()).toBe('ready');
  expect(bind.mock.calls).toEqual([[f.id, work]]);
  expect(select).not.toHaveBeenCalled();
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBeNull();
  fireEvent.change(title(), { target: { value: 'Edited' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ context: work, iri: 'urn:a', ifMatch: '"n1"' });
  expect(f.count('/_system/sparql/query')).toBe(0);
});

it('keeps a draft in the selected Context while a row of another Context is edited and saved', async () => {
  const f = await returned();
  const { writes } = notes(f);
  render(ui(f.runtime, <Harness selected />));
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active'),
  );
  await act(() => f.runtime.loadContexts(f.id));
  act(() => f.runtime.selectContext(f.id, personal));
  const draft = (await screen.findByLabelText(
    'Selected draft',
  )) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved in personal' } });
  // Opening and saving a row from work asks nothing about the personal draft.
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  expect(screen.queryByRole('alertdialog')).toBeNull();
  fireEvent.change(title(), { target: { value: 'Saved at work' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]?.context).toBe(work);
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(personal);
  expect(screen.getByLabelText('Selected draft')).toBe(draft);
  expect(draft.value).toBe('Unsaved in personal');
});

it('keeps the editor and its draft when another Context is selected, without asking', async () => {
  const f = await returned();
  notes(f);
  render(ui(f.runtime));
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  const input = title();
  fireEvent.change(input, { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByText('Select personal'));
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(personal),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(phase()).toBe('ready');
  expect(title()).toBe(input);
  expect(input.value).toBe('Unsaved');
});

it('runs target changes and close under the leave policy and blocks them while saving', async () => {
  const f = await returned();
  const { writes, control } = notes(f);
  render(ui(f.runtime));
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  fireEvent.change(title(), { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(title().value).toBe('Unsaved');
  const gate = deferred<void>();
  control.hold = gate.promise;
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.click(screen.getByText('Close editor'));
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  await act(async () => {});
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(phase()).toBe('ready');
  await act(async () => gate.resolve());
  fireEvent.change(title(), { target: { value: 'Second draft' } });
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() => expect(title().value).toBe('B at work'));
  fireEvent.click(screen.getByText('Close editor'));
  await waitFor(() => expect(phase()).toBe('idle'));
  expect(writes).toHaveLength(1);
});

it('shares one open between calls made before a re-render and chains on the latest target', async () => {
  const f = await returned();
  notes(f);
  render(ui(f.runtime));
  await open('Open urn:a twice');
  await waitFor(() =>
    expect(screen.getByTestId('result').textContent).toBe('[true,true]'),
  );
  await waitFor(() => expect(title().value).toBe('A at work'));
  // While the first call waits for the leave prompt, the second shares it.
  fireEvent.change(title(), { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByText('Open urn:b twice'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() =>
    expect(screen.getByTestId('result').textContent).toBe('b:[true,true]'),
  );
  await waitFor(() => expect(title().value).toBe('B at work'));
  fireEvent.click(screen.getByText('Close editor'));
  await waitFor(() => expect(phase()).toBe('idle'));
  fireEvent.click(screen.getByText('Open, switch and close'));
  await waitFor(() =>
    expect(screen.getByTestId('result').textContent).toBe('[true,true,true]'),
  );
  await waitFor(() => expect(phase()).toBe('idle'));
});

it.each(['unreadable', 'refused', 'offline'] as const)(
  'reports %s discovery as unavailable until the catalogue lists the Context',
  async (mode) => {
    const f = await returned();
    const { reads } = notes(f);
    f.setCatalogue(async () => {
      if (mode === 'offline') throw new TypeError('offline');
      return mode === 'refused'
        ? new Response(null, { status: 403 })
        : catalogue([personal], [personal]);
    });
    render(ui(f.runtime));
    await open('Edit urn:a in work');
    await waitFor(() =>
      expect(phase()).toBe(
        mode === 'unreadable'
          ? 'unavailable:unreadable'
          : 'unavailable:discovery-failed',
      ),
    );
    expect(reads).toEqual([]);
    f.setCatalogue(async () => catalogue());
    fireEvent.click(
      await screen.findByRole('button', { name: 'Check access' }),
    );
    await waitFor(() => expect(title().value).toBe('A at work'));
  },
);

it.each([
  ['an exact preset for another Context', 'Edit urn:a in work'],
  ['a Context of another Pod', 'Edit urn:x in bob'],
])(
  'reports a binding refused for %s as unavailable without a request',
  async (_case, row) => {
    const f = await returned(
      fixture({
        preferences: null,
        ...(row === 'Edit urn:a in work'
          ? { preset: { podUrl: pod, contextIri: personal } }
          : {}),
      }),
    );
    const { reads } = notes(f);
    const select = vi.spyOn(f.runtime, 'selectContext');
    render(ui(f.runtime));
    await open(row);
    await waitFor(() => expect(phase()).toBe('unavailable:refused'));
    await act(async () => {});
    expect(reads).toEqual([]);
    expect(select).not.toHaveBeenCalled();
    expect(f.runtime.getSnapshot()[0]?.selectedContext ?? null).not.toBe(work);
    fireEvent.click(screen.getByText('Close editor'));
    await waitFor(() => expect(phase()).toBe('idle'));
    fireEvent.click(screen.getByText(row));
    await waitFor(() => expect(phase()).toBe('unavailable:refused'));
  },
);

it.each(['missing', 'offline'] as const)(
  'stays ready with a blocked editor and a reachable retry when the first read is %s',
  async (mode) => {
    const f = await returned();
    const { data, control } = notes(f);
    if (mode === 'missing') data.delete(`${work} urn:a`);
    else control.offline = true;
    render(ui(f.runtime));
    await open('Edit urn:a in work');
    await waitFor(() => expect(phase()).toBe('ready'));
    // The editor's own retry, inside the exposed editor.
    const retry = () =>
      document
        .querySelector('[data-sempods-ui="editor"]')!
        .querySelector<HTMLButtonElement>('button:last-of-type')!;
    await waitFor(() => expect(retry().textContent).toBe('Check again'));
    expect(screen.queryByLabelText('Note title')).toBeNull();
    if (mode === 'missing')
      data.set(`${work} urn:a`, { title: 'Created meanwhile', version: 1 });
    else control.offline = false;
    fireEvent.click(retry());
    await waitFor(() =>
      expect(title().value).toBe(
        mode === 'missing' ? 'Created meanwhile' : 'A at work',
      ),
    );
  },
);

it('keeps the editor and its draft through read loss, and requires evidence again for a reopened row', async () => {
  const f = await returned();
  notes(f);
  render(ui(f.runtime));
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  const input = title();
  fireEvent.change(input, { target: { value: 'Unfinished' } });
  f.setCatalogue(async () => catalogue([personal], [personal]));
  await act(() => f.runtime.loadContexts(f.id));
  expect(phase()).toBe('ready');
  expect(title()).toBe(input);
  expect(input.value).toBe('Unfinished');
  fireEvent.click(screen.getByText('Close editor'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() => expect(phase()).toBe('idle'));
  fireEvent.click(screen.getByText('Edit urn:a in work'));
  await waitFor(() => expect(phase()).toBe('unavailable:unreadable'));
  expect(screen.queryByLabelText('Note title')).toBeNull();
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() => expect(title().value).toBe('A at work'));
});

it.each(['before', 'after'] as const)(
  'retires on a guarded Pod switch %s activation without discovery on the new Pod',
  async (timing) => {
    const { f, runtime, other, otherUrl } = await twoPods(keep);
    notes(f);
    const answer = deferred<Response>();
    f.setCatalogue(() =>
      timing === 'before' ? answer.promise : Promise.resolve(catalogue()),
    );
    const bob = () =>
      f.fetch.mock.calls.filter(([url]) =>
        url.startsWith(otherUrl + '/_system/contexts'),
      );
    const view = (id: string) =>
      ui(
        runtime,
        <>
          <Harness />
          <Switch id={id} />
        </>,
      );
    const { rerender } = render(view(f.id));
    fireEvent.click(await screen.findByText('Switch Pod'));
    await open('Edit urn:a in work', f.id);
    if (timing === 'before')
      await waitFor(() => expect(phase()).toBe('loading'));
    else {
      await waitFor(() => expect(title().value).toBe('A at work'));
      fireEvent.change(title(), { target: { value: 'Unsaved' } });
    }
    rerender(view(other.id));
    fireEvent.click(screen.getByText('Switch Pod'));
    if (timing === 'after') {
      // The connection action asks about the connection-scoped editor first.
      fireEvent.click(
        await screen.findByRole('button', { name: 'Keep editing' }),
      );
      expect(title().value).toBe('Unsaved');
      fireEvent.click(screen.getByText('Switch Pod'));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Discard and continue' }),
      );
    }
    await waitFor(() => expect(phase()).toBe('retired'));
    if (timing === 'before') await act(async () => answer.resolve(catalogue()));
    await act(async () => {});
    expect(screen.queryByLabelText('Note title')).toBeNull();
    expect(bob()).toEqual([]);
    // Returning to Alice does not revive the retired target; close clears it.
    rerender(view(f.id));
    fireEvent.click(screen.getByText('Switch Pod'));
    await act(async () => {});
    expect(phase()).toBe('retired');
    fireEvent.click(screen.getByText('Close editor'));
    await waitFor(() => expect(phase()).toBe('idle'));
  },
);

it('binds nothing until startup settles', async () => {
  const f = await returned();
  const { reads } = notes(f);
  const report = await f.runtime.initialize();
  const startup = deferred<typeof report>();
  vi.spyOn(f.runtime, 'initialize').mockReturnValue(startup.promise);
  const bind = vi.spyOn(f.runtime, 'bindContext');
  render(ui(f.runtime));
  await open('Edit urn:a in work');
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe('ready'),
  );
  expect(phase()).toBe('loading');
  expect(bind).not.toHaveBeenCalled();
  expect(reads).toEqual([]);
  await act(async () => startup.resolve(report));
  await waitFor(() => expect(title().value).toBe('A at work'));
  expect(bind).toHaveBeenCalledOnce();
});

it('binds and reads once under StrictMode', async () => {
  const f = await returned();
  const { reads } = notes(f);
  const bind = vi.spyOn(f.runtime, 'bindContext');
  render(<StrictMode>{ui(f.runtime)}</StrictMode>);
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  expect(new Set(bind.mock.results.map((r) => r.value)).size).toBe(1);
  expect(reads).toEqual([`${work} urn:a`]);
  expect(f.count('/_system/contexts')).toBe(1);
});

it('waits instead of refusing while the binding reports no signed-in session', async () => {
  const f = await returned();
  notes(f);
  const real = f.runtime.bindContext.bind(f.runtime);
  let attempts = 0;
  vi.spyOn(f.runtime, 'bindContext').mockImplementation((id, iri) => {
    if (++attempts === 1) throw new RuntimeError('disconnected');
    return real(id, iri);
  });
  render(ui(f.runtime));
  await open('Edit urn:a in work');
  await waitFor(() => expect(attempts).toBe(1));
  expect(phase()).toBe('loading');
  // A later change of the connection's facts retries the binding.
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() => expect(title().value).toBe('A at work'));
});

class Boundary extends Component<
  { readonly children: ReactNode },
  { readonly error: unknown }
> {
  override state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error ? (
      <p role="alert">{String(this.state.error)}</p>
    ) : (
      this.props.children
    );
  }
}
it('surfaces an unexpected binding failure instead of reporting a refusal', async () => {
  const f = await returned();
  notes(f);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(f.runtime, 'bindContext').mockImplementation(() => {
    throw new TypeError('binding defect');
  });
  render(
    ui(
      f.runtime,
      <Boundary>
        <Harness />
      </Boundary>,
    ),
  );
  await open('Edit urn:a in work');
  expect((await screen.findByRole('alert')).textContent).toContain(
    'binding defect',
  );
});

it('keeps the editor and its draft when the session ends, and reopens the row in a fresh lane', async () => {
  const f = await returned();
  notes(f);
  render(ui(f.runtime));
  await open('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  const input = title();
  fireEvent.change(input, { target: { value: 'Unsaved' } });
  // The session ends: a renewal after a refused request is refused too.
  f.setQuery(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      }),
  );
  f.setToken(async () => new Response(null, { status: 400 }));
  await act(async () => {
    await f.runtime
      .bindPod(f.id)
      .sparql.construct('CONSTRUCT {} WHERE {}')
      .catch(() => {});
  });
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('ended'),
  );
  expect(phase()).toBe('ready');
  expect(title()).toBe(input);
  expect(input.value).toBe('Unsaved');
  // The binding can never become valid again: reopening the same row starts a
  // fresh lane, and the leave policy asks about the old draft first.
  fireEvent.click(screen.getByText('Edit urn:a in work'));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(title().value).toBe('Unsaved');
  // The declined open settles before the person clicks again.
  await act(async () => {});
  fireEvent.click(screen.getByText('Edit urn:a in work'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() => expect(phase()).toBe('loading'));
  expect(screen.queryByLabelText('Note title')).toBeNull();
});

it('needs a successful listing for a row opened after a failed catalogue refresh', async () => {
  const f = await returned();
  const { reads } = notes(f);
  render(ui(f.runtime));
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active'),
  );
  await act(() => f.runtime.loadContexts(f.id));
  f.setCatalogue(async () => {
    throw new TypeError('offline');
  });
  await act(() => f.runtime.loadContexts(f.id).catch(() => {}));
  expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe('failed');
  // The retained evidence still lists work, but a newly opened row waits.
  await open('Edit urn:a in work');
  await waitFor(() => expect(phase()).toBe('unavailable:discovery-failed'));
  expect(reads).toEqual([]);
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() => expect(title().value).toBe('A at work'));
});
