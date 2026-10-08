// @vitest-environment jsdom
import { StrictMode, useState } from 'react';
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
  usePodLoad,
  useLoad,
  useDraftGuard,
  useWorkflowAccess,
  type ContextTarget,
} from './index.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import { createAppController } from '../authoring/app.js';
import { createViewLoader } from '../authoring/load.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  fixture,
  catalogue,
  deferred,
  jwt,
  personal,
  pod,
  restored,
  settleLease,
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
async function returned(f = fixture({ preferences: null })) {
  runtimes.push(f.runtime);
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  runtimes.push(runtime);
  return { ...f, runtime, id: connection.id };
}
const descriptions = (f: ReturnType<typeof fixture>) =>
  f.fetch.mock.calls.filter(([url]) =>
    /\/_system\/contexts\/[^/]+$/.test(new URL(url).pathname),
  );
function Overview() {
  // An inline callback must not reload on ordinary render/Context/label changes.
  const { state, reload, cancel } = usePodLoad((reader, signal) =>
    reader.sparql.construct('CONSTRUCT {} WHERE {}', { signal }),
  );
  const workflow = useWorkflowAccess();
  const { startup, pod: reader } = useAppState();
  return (
    <>
      <output data-testid="overview">
        {state.kind === 'ready' ? JSON.stringify(state.data) : state.kind}
      </output>
      <output data-testid="workflow">{String(workflow.read)}</output>
      <output data-testid="signed-in">
        {String(Boolean(reader && startup))}
      </output>
      <button onClick={() => void reload()}>Read again</button>
      <button onClick={cancel}>Cancel read</button>
    </>
  );
}
function Scoped({ twice = false }: { readonly twice?: boolean }) {
  return (
    <>
      <TargetScreen>
        <ContextDraft />
      </TargetScreen>
      {twice && (
        <TargetScreen>
          <p>Second screen</p>
        </TargetScreen>
      )}
    </>
  );
}
function ContextDraft() {
  const [draft, setDraft] = useState('draft');
  useDraftGuard(draft !== 'draft', () => setDraft('draft'));
  return (
    <input
      aria-label="Context draft"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
    />
  );
}
function Harness({
  show = false,
  twice = false,
}: {
  readonly show?: boolean;
  readonly twice?: boolean;
}) {
  const [scoped, setScoped] = useState(show);
  const [manage, setManage] = useState(false);
  return (
    <>
      <AppAccess appName="Overview" open={manage} />
      <Overview />
      <button onClick={() => setScoped(!scoped)}>Toggle Context flow</button>
      <button onClick={() => setManage(!manage)}>Manage access</button>
      {scoped && <Scoped twice={twice} />}
    </>
  );
}

it('settles unavailable after startup fails instead of leaving the Pod overview loading', async () => {
  const f = fixture({ preferences: null });
  runtimes.push(f.runtime);
  const startup = deferred<Awaited<ReturnType<BrowserRuntime['initialize']>>>();
  vi.spyOn(f.runtime, 'initialize').mockReturnValue(startup.promise);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Harness />
    </SempodsProvider>,
  );
  expect(screen.getByTestId('overview').textContent).toBe('loading');
  expect(screen.queryByRole('alert')).toBeNull();
  await act(async () => startup.reject(new Error('Storage startup failed')));
  await waitFor(() =>
    expect(screen.getByTestId('overview').textContent).toBe('unavailable'),
  );
  expect(screen.getByRole('alert').textContent).toBeTruthy();
  fireEvent.click(screen.getByText('Read again'));
  expect(screen.getByTestId('overview').textContent).toBe('unavailable');
  expect(f.count('/_system/contexts')).toBe(0);
  expect(descriptions(f)).toHaveLength(0);
  expect(f.count('/_system/sparql/query')).toBe(0);
});

it('starts a Pod overview with no catalogue, labels or Context access, and opens discovery explicitly', async () => {
  const f = await returned();
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Harness />
    </SempodsProvider>,
  );
  await screen.findByText('[{"@id":"urn:item"}]');
  expect(screen.getByTestId('workflow').textContent).toBe('false');
  expect(screen.queryByRole('combobox', { name: 'Data context' })).toBeNull();
  expect(f.count('/_system/contexts')).toBe(0);
  expect(descriptions(f)).toHaveLength(0);
  fireEvent.click(screen.getByText('Manage access'));
  await screen.findByRole('option', { name: 'work' });
  expect(f.count('/_system/contexts')).toBe(1);
  expect(descriptions(f)).toHaveLength(0);
  expect(screen.getByTestId('overview').textContent).toContain('urn:item');
});

it.each(['before', 'after'] as const)(
  'activates concurrent StrictMode TargetScreens %s login eligibility without deadlock',
  async (timing) => {
    const f = await returned(
      fixture({ preferences: null, preset: { podUrl: pod, contextIri: work } }),
    );
    render(
      <StrictMode>
        <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
          <Harness show={timing === 'before'} twice />
        </SempodsProvider>
      </StrictMode>,
    );
    if (timing === 'after') {
      await waitFor(() =>
        expect(screen.getByTestId('signed-in').textContent).toBe('true'),
      );
      expect(f.count('/_system/contexts')).toBe(0);
      fireEvent.click(screen.getByText('Toggle Context flow'));
    }
    const input = await screen.findByLabelText('Context draft');
    expect(screen.getByText('Second screen')).toBeTruthy();
    expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
    expect(f.count('/_system/contexts')).toBe(1);
    expect(descriptions(f).map(([url]) => url)).toEqual([work]);
    fireEvent.change(input, { target: { value: 'Unfinished' } });
    await act(() => f.runtime.loadContexts(f.id));
    expect(screen.getByLabelText('Context draft')).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Unfinished');
  },
);

it('exposes a chooser with fallback names while the selected label is pending or fails', async () => {
  const f = await returned();
  const label = deferred<Response>();
  f.setDescriptions(() => label.promise);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Harness show />
    </SempodsProvider>,
  );
  const picker = await screen.findByRole('combobox', { name: 'Data context' });
  await screen.findByRole('option', { name: 'work' });
  expect(descriptions(f)).toHaveLength(0);
  fireEvent.change(picker, { target: { value: work } });
  await screen.findByLabelText('Context draft');
  await waitFor(() =>
    expect(descriptions(f).map(([url]) => url)).toEqual([work]),
  );
  expect(screen.getByTestId('overview').textContent).toContain('urn:item');
  await act(async () => label.resolve(new Response(null, { status: 403 })));
  fireEvent.click(screen.getByText('Manage access'));
  expect(screen.getByRole('option', { name: 'personal' })).toBeTruthy();
  expect(descriptions(f)).toHaveLength(1);
});

it.each(['empty', 'refused', 'offline'] as const)(
  'shows reachable %s discovery and retries only on explicit demand',
  async (mode) => {
    const f = await returned();
    f.setCatalogue(async () => {
      if (mode === 'offline') throw new TypeError('offline');
      return mode === 'empty'
        ? catalogue([], [])
        : new Response(null, { status: 403 });
    });
    render(
      <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
        <Harness show twice />
      </SempodsProvider>,
    );
    await waitFor(() =>
      expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe(
        mode === 'empty' ? 'ready' : 'failed',
      ),
    );
    expect(screen.getByRole('button', { name: 'Check access' })).toBeTruthy();
    expect(screen.getByTestId('overview').textContent).toContain('urn:item');
    expect(f.count('/_system/contexts')).toBe(1);
    fireEvent.click(screen.getByText('Toggle Context flow'));
    fireEvent.click(screen.getByText('Toggle Context flow'));
    await act(async () => {});
    expect(f.count('/_system/contexts')).toBe(1);
    f.setCatalogue(async () => catalogue());
    fireEvent.click(screen.getByRole('button', { name: 'Check access' }));
    await screen.findByRole('option', { name: 'work' });
    expect(f.count('/_system/contexts')).toBe(2);
  },
);

it('keeps a pending Pod read through A-B-A Context switches without retry or cancellation', async () => {
  const f = await returned();
  const response = deferred<Response>();
  let signal: AbortSignal | undefined;
  f.setQuery(async (_url, init) => {
    signal = init?.signal ?? undefined;
    return response.promise;
  });
  const ui = () => (
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Harness show />
    </SempodsProvider>
  );
  const { rerender } = render(ui());
  await screen.findByRole('option', { name: 'work' });
  await waitFor(() => expect(f.count('/_system/sparql/query')).toBe(1));
  await act(async () => {
    f.runtime.selectContext(f.id, work);
    f.runtime.selectContext(f.id, personal);
    f.runtime.selectContext(f.id, work);
  });
  rerender(ui());
  expect(signal?.aborted).toBe(false);
  await act(async () =>
    response.resolve(Response.json([{ '@id': 'urn:result' }])),
  );
  await screen.findByText('[{"@id":"urn:result"}]');
  expect(f.count('/_system/sparql/query')).toBe(1);
});

it.each(['scope-loss', 'ended', 'refused'] as const)(
  'reacts to Pod %s without catalogue recovery',
  async (mode) => {
    const f = await returned(
      fixture({ preferences: null, scopes: { required: ['tasks'] } }),
    );
    f.setToken(async () =>
      Response.json({
        access_token: jwt({ scope: 'tasks' }),
        token_type: 'Bearer',
        refresh_token: 'initial',
      }),
    );
    render(
      <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
        <Harness />
      </SempodsProvider>,
    );
    await screen.findByText('[{"@id":"urn:item"}]');
    f.setQuery(
      async () =>
        new Response(null, {
          status: mode === 'refused' ? 403 : 401,
          headers: { 'www-authenticate': 'Bearer' },
        }),
    );
    f.setToken(async () =>
      mode === 'ended'
        ? new Response(null, { status: 400 })
        : Response.json({
            access_token: jwt(),
            token_type: 'Bearer',
            refresh_token: 'rotated',
          }),
    );
    fireEvent.click(screen.getByText('Read again'));
    if (mode === 'refused')
      await waitFor(() =>
        expect(screen.getByTestId('overview').textContent).toBe('failed'),
      );
    else if (mode === 'ended')
      await screen.findByRole('button', { name: 'Sign in' });
    else await screen.findByRole('button', { name: 'Update access' });
    expect(screen.queryByRole('combobox', { name: 'Data context' })).toBeNull();
    expect(f.count('/_system/contexts')).toBe(0);
    expect(descriptions(f)).toHaveLength(0);
  },
);

it('cancels actual transport on unmount and ignores its late answer', async () => {
  const f = await returned();
  const gate = deferred<Response>();
  let signal: AbortSignal | undefined;
  f.setQuery(async (_url, init) => {
    signal = init?.signal ?? undefined;
    return gate.promise;
  });
  const { unmount } = render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Overview />
    </SempodsProvider>,
  );
  await waitFor(() => expect(signal).toBeDefined());
  unmount();
  expect(signal?.aborted).toBe(true);
  gate.resolve(Response.json([]));
  expect(f.count('/_system/sparql/query')).toBe(1);
});

it.each(['required', 'on-demand'] as const)(
  'displays selected labels without UI-driven description requests in %s mode',
  async (contextSelection) => {
    const f = await returned();
    f.setDescriptions(async (url) =>
      Response.json({
        '@id': url,
        '@type': ['http://www.w3.org/ns/sparql-service-description#NamedGraph'],
        'http://www.w3.org/ns/sparql-service-description#name': [
          { '@id': url },
        ],
        'https://schema.sempods.org/public': [{ '@value': false }],
        'http://www.w3.org/2000/01/rdf-schema#label': [
          { '@value': 'Selected work' },
        ],
      }),
    );
    render(
      <SempodsProvider runtime={f.runtime} contextSelection={contextSelection}>
        <Harness show />
      </SempodsProvider>,
    );
    await screen.findByRole('option', { name: 'work' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Data context' }), {
      target: { value: work },
    });
    await waitFor(() =>
      expect(f.runtime.getSnapshot()[0]?.catalogue).toMatchObject({
        labels: { [work]: 'Selected work' },
      }),
    );
    fireEvent.click(screen.getByText('Manage access'));
    expect(screen.getByRole('option', { name: 'Selected work' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'personal' })).toBeTruthy();
    expect(descriptions(f).map(([url]) => url)).toEqual([work]);
  },
);

it.each(['preset', 'remembered'] as const)(
  'defers %s Context validation across restore and does not discover inactive connections',
  async (choice) => {
    const memory = new Map<string, string>();
    const preferences = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => {
        memory.set(key, value);
      },
      removeItem: (key: string) => {
        memory.delete(key);
      },
    };
    const f = await returned(
      fixture({
        preferences,
        ...(choice === 'preset'
          ? { preset: { podUrl: pod, contextIri: work } }
          : {}),
      }),
    );
    await f.runtime.initialize();
    await f.runtime.loadContexts(f.id);
    f.runtime.selectContext(f.id, work);
    const otherUrl = 'https://pod.example/bob';
    const other = await f.runtime.connect(otherUrl);
    await f.runtime.beginAuthorization(other.id);
    f.runtime.dispose();
    await settleLease();
    f.setToken(async (url) =>
      Response.json({
        access_token: jwt({ iss: url.split('/_system')[0] }),
        token_type: 'Bearer',
        refresh_token: 'fresh',
      }),
    );
    const signedIn = f.returned();
    runtimes.push(signedIn);
    await signedIn.initialize();
    await restored(signedIn);
    signedIn.dispose();
    await settleLease();
    const runtime = createBrowserRuntime({
      ...f.options,
      location: () => 'https://app.example/',
    });
    runtimes.push(runtime);
    const before = f.count('/_system/contexts');
    const beforeLabels = descriptions(f).length;
    render(
      <SempodsProvider runtime={runtime} contextSelection="on-demand">
        <Harness />
        <Switch id={f.id} />
      </SempodsProvider>,
    );
    await screen.findByText('[{"@id":"urn:item"}]');
    await restored(runtime);
    expect(runtime.getSnapshot()).toHaveLength(2);
    expect(
      runtime
        .getSnapshot()
        .every(
          (c) => c.catalogue.kind === 'unknown' && c.selectedContext === null,
        ),
    ).toBe(true);
    expect(f.count('/_system/contexts')).toBe(before);
    expect(descriptions(f)).toHaveLength(beforeLabels);
    fireEvent.click(screen.getByText('Switch Pod'));
    await act(async () => {});
    fireEvent.click(screen.getByText('Toggle Context flow'));
    await screen.findByLabelText('Context draft');
    expect(f.count('/_system/contexts')).toBe(before + 1);
    expect(
      runtime.getSnapshot().find((c) => c.id === other.id)?.catalogue.kind,
    ).toBe('unknown');
  },
);

it('keeps headless controller discovery on-demand and uses the shared loader for Pod reads', async () => {
  const f = await returned();
  const app = createAppController(f.runtime, { contextSelection: 'on-demand' });
  app.start();
  await vi.waitFor(() => expect(app.getSnapshot().pod).not.toBeNull());
  const reader = app.getSnapshot().pod!;
  const load = createViewLoader(reader, (target, signal) =>
    target.sparql.construct('CONSTRUCT {} WHERE {}', { signal }),
  );
  try {
    await load.reload();
    expect(load.getSnapshot().kind).toBe('ready');
    expect(f.count('/_system/contexts')).toBe(0);
    expect(app.getSnapshot().contextSelection).toBe('on-demand');
  } finally {
    load.dispose();
    app.stop();
  }
});

// The guarded connection actions remain shared with Pod-only screens.
function Switch({ id }: { readonly id: string }) {
  const app = useApp();
  return (
    <button onClick={() => void app.selectConnection(id)}>Switch Pod</button>
  );
}
it('discards a late result when the active Pod changes', async () => {
  const f = await returned(
    fixture({ preferences: null, preset: { podUrl: pod } }),
  );
  await f.runtime.initialize();
  const otherUrl = 'https://pod.example/bob';
  const other = await f.runtime.connect(otherUrl);
  await f.runtime.beginAuthorization(other.id);
  f.runtime.dispose();
  await settleLease();
  f.setToken(async (url) =>
    Response.json({
      access_token: jwt({ iss: url.split('/_system')[0] }),
      token_type: 'Bearer',
      refresh_token: 'fresh',
    }),
  );
  const runtime = f.returned();
  runtimes.push(runtime);
  await runtime.initialize();
  await restored(runtime);
  const gate = deferred<Response>();
  let signal: AbortSignal | undefined;
  f.setQuery(async (url, init) => {
    if (url.startsWith(pod + '/')) {
      signal = init?.signal ?? undefined;
      return gate.promise;
    }
    return Response.json([{ '@id': 'urn:bob' }]);
  });
  const ui = (id: string) => (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Overview />
      <Switch id={id} />
    </SempodsProvider>
  );
  const { rerender } = render(ui(f.id));
  // The completed callback activates Bob; explicitly start Alice's pending read.
  await waitFor(() =>
    expect(screen.getByTestId('signed-in').textContent).toBe('true'),
  );
  fireEvent.click(screen.getByText('Switch Pod'));
  await waitFor(() => expect(signal).toBeDefined());
  rerender(ui(other.id));
  fireEvent.click(screen.getByText('Switch Pod'));
  await screen.findByText('[{"@id":"urn:bob"}]');
  expect(signal?.aborted).toBe(true);
  await act(async () =>
    gate.resolve(Response.json([{ '@id': 'urn:late-alice' }])),
  );
  expect(screen.getByTestId('overview').textContent).toContain('urn:bob');
  expect(f.count('/_system/contexts')).toBe(0);
});

it('bounds invalidated Pod callback recovery to one retry', async () => {
  const f = await returned();
  await f.runtime.initialize();
  const read = vi.fn(async () => ({ kind: 'invalidated' }) as const);
  const loader = createViewLoader(f.runtime.bindPod(f.id), read);
  try {
    await loader.reload();
    expect(read).toHaveBeenCalledTimes(2);
    expect(loader.getSnapshot().kind).toBe('unavailable');
    expect(f.count('/_system/contexts')).toBe(0);
  } finally {
    loader.dispose();
  }
});

it('refreshes a completed Pod result after optional grants change without touching Context discovery', async () => {
  const f = await returned(
    fixture({ preferences: null, scopes: { optional: ['ai'] } }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'ai' }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Overview />
    </SempodsProvider>,
  );
  await screen.findByText('[{"@id":"urn:item"}]');
  let calls = 0;
  f.setQuery(async () =>
    ++calls === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : Response.json([{ '@id': 'urn:changed-grants' }]),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  // Renewal by a separate reader also invalidates already displayed Pod data.
  await act(() =>
    f.runtime.bindPod(f.id).sparql.construct('CONSTRUCT {} WHERE {}'),
  );
  await screen.findByText('[{"@id":"urn:changed-grants"}]');
  expect(f.count('/_system/contexts')).toBe(0);
  expect(descriptions(f)).toHaveLength(0);
});

it('keeps a refused Pod operation failed after changed grants until explicit reload', async () => {
  const f = await returned(
    fixture({ preferences: null, scopes: { optional: ['ai'] } }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'ai' }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  f.setQuery(async () => new Response(null, { status: 403 }));
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Overview />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('overview').textContent).toBe('failed'),
  );
  let calls = 0;
  f.setQuery(async () =>
    ++calls === 1
      ? new Response(null, {
          status: 401,
          headers: { 'www-authenticate': 'Bearer' },
        })
      : Response.json([{ '@id': 'urn:changed-grants' }]),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt(),
      token_type: 'Bearer',
      refresh_token: 'rotated',
    }),
  );
  // Renewal by another reader loses optional grants on the same handle.
  const reader = f.runtime.bindPod(f.id);
  const revision = reader.getSnapshot().revision;
  await act(async () => {
    expect(await reader.sparql.construct('CONSTRUCT {} WHERE {}')).toEqual({
      kind: 'invalidated',
    });
  });
  expect(reader.getSnapshot().revision).toBeGreaterThan(revision);
  expect(f.runtime.bindPod(f.id)).toBe(reader);
  expect(screen.getByTestId('overview').textContent).toBe('failed');
  expect(calls).toBe(1); // The other read's 401 is invalidated by changed grants.
  fireEvent.click(screen.getByText('Read again'));
  await screen.findByText('[{"@id":"urn:changed-grants"}]');
  expect(calls).toBe(2);
  expect(f.count('/_system/contexts')).toBe(0);
  expect(descriptions(f)).toHaveLength(0);
});

it('never substitutes another Context when an on-demand preset is unreadable', async () => {
  const f = await returned(
    fixture({ preferences: null, preset: { podUrl: pod, contextIri: work } }),
  );
  f.setCatalogue(async () => catalogue([personal], [personal]));
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Harness show />
    </SempodsProvider>,
  );
  await screen.findByText('[{"@id":"urn:item"}]');
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe('ready'),
  );
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBeNull();
  expect(screen.queryByLabelText('Context draft')).toBeNull();
  expect(screen.getByRole('button', { name: 'Check access' })).toBeTruthy();
  expect(descriptions(f)).toHaveLength(0);
});

function ScopedRead() {
  const { state } = useLoad((view, signal) =>
    view.sparql.construct('CONSTRUCT {} WHERE {}', { signal }),
  );
  return <output data-testid="scoped-read">{state.kind}</output>;
}
it.each([400, 403])(
  'keeps every Context query scoped through %s and recovery',
  async (status) => {
    const f = await returned(
      fixture({ preferences: null, preset: { podUrl: pod, contextIri: work } }),
    );
    let calls = 0;
    f.setQuery(async () => {
      calls++;
      // A 403 revalidation changes rights, causing the shared loader's one retry.
      if (status === 403 && calls === 1)
        f.setCatalogue(async () => catalogue([work, personal], []));
      return new Response(null, { status: calls === 1 ? status : 400 });
    });
    render(
      <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
        <AppAccess appName="Scoped" />
        <TargetScreen>
          <ScopedRead />
        </TargetScreen>
      </SempodsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('scoped-read').textContent).toBe('failed'),
    );
    const queries = f.fetch.mock.calls.filter(([url]) =>
      url.includes('/_system/sparql/query'),
    );
    expect(queries).toHaveLength(status === 403 ? 2 : 1);
    for (const [url] of queries) {
      expect(new URL(url).searchParams.getAll('default-graph-uri')).toEqual([
        work,
      ]);
      expect(new URL(url).searchParams.getAll('named-graph-uri')).toEqual([
        work,
      ]);
    }
  },
);

it('keeps on-demand drafts through permission loss/recovery and guards Context selection', async () => {
  const f = await returned();
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Harness show />
    </SempodsProvider>,
  );
  const picker = await screen.findByRole('combobox', { name: 'Data context' });
  fireEvent.change(picker, { target: { value: work } });
  const input = await screen.findByLabelText('Context draft');
  fireEvent.change(input, { target: { value: 'Unfinished' } });
  f.setCatalogue(async () => catalogue([personal], [personal]));
  await act(() => f.runtime.loadContexts(f.id));
  expect(screen.getByTestId('workflow').textContent).toBe('false');
  expect(
    (screen.getByLabelText('Context draft') as HTMLInputElement).value,
  ).toBe('Unfinished');
  expect(screen.getByTestId('overview').textContent).toContain('urn:item');
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  fireEvent.click(screen.getByText('Manage access'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Data context' }), {
    target: { value: personal },
  });
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
  expect(screen.getByLabelText('Context draft')).toBe(input);
  expect((input as HTMLInputElement).value).toBe('Unfinished');
});

// Editing an overview row in its own Context (#54).
const note = fields(
  { title: text('urn:note:title', { language: null }) },
  { type: 'urn:Note' },
);
const rows: readonly ContextTarget[] = [
  { subject: 'urn:a', context: work },
  { subject: 'urn:b', context: work },
  { subject: 'urn:a', context: personal },
];
const label = (t: ContextTarget) =>
  `Edit ${t.subject} in ${t.context === work ? 'work' : 'personal'}`;
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
  const state = { hold: null as Promise<void> | null };
  f.setResource(async (url, init) => {
    const target = new URL(url);
    const iri = Buffer.from(
      target.pathname.split('/').at(-1)!,
      'base64url',
    ).toString();
    const context = target.searchParams.get('context');
    const stored = data.get(`${context} ${iri}`);
    if ((init?.method ?? 'GET') === 'GET')
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
    writes.push({
      context,
      iri,
      ifMatch: new Headers(init?.headers).get('if-match'),
    });
    await state.hold;
    if (stored) stored.version++;
    return new Response(null, { status: 204 });
  });
  return { writes, state };
}
function RowEditor({ draft = false }: { readonly draft?: boolean }) {
  const [manage, setManage] = useState(false);
  const edit = useContextEditor(note);
  const { activeId } = useAppState();
  return (
    <>
      <AppAccess appName="Overview" open={manage} />
      <output data-testid="active">{activeId}</output>
      <button onClick={() => setManage(!manage)}>Manage access</button>
      <output data-testid="phase">
        {edit.reason ? `${edit.phase}:${edit.reason}` : edit.phase}
      </output>
      {rows.map((row) => (
        <button key={label(row)} onClick={() => void edit.open(row)}>
          {label(row)}
        </button>
      ))}
      <button onClick={() => void edit.close()}>Close editor</button>
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
      {draft && (
        <TargetScreen>
          <ContextDraft />
        </TargetScreen>
      )}
    </>
  );
}
const phase = () => screen.getByTestId('phase').textContent;
/** Opens a row once a connection is active, as an overview only offers then. */
async function edit(row: string, active?: string) {
  await waitFor(() =>
    expect(screen.getByTestId('active').textContent).toEqual(
      active ?? expect.stringMatching(/./),
    ),
  );
  fireEvent.click(screen.getByText(row));
}
const title = () => screen.getByLabelText('Note title') as HTMLInputElement;

it('edits an overview row in its own Context with a fresh read and If-Match', async () => {
  const f = await returned();
  const { writes } = notes(f);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <RowEditor />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('active').textContent).toBe(f.id),
  );
  expect(f.count('/_system/contexts')).toBe(0);
  await edit('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  expect(phase()).toBe('ready');
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
  expect(f.count('/_system/contexts')).toBe(1);
  fireEvent.change(title(), { target: { value: 'Edited' } });
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]).toEqual({ context: work, iri: 'urn:a', ifMatch: '"n1"' });
  expect(f.count('/_system/sparql/query')).toBe(0);
});

it('runs target changes and close under the leave policy and blocks them while saving', async () => {
  const f = await returned();
  const { writes, state } = notes(f);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <RowEditor />
    </SempodsProvider>,
  );
  await edit('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  fireEvent.change(title(), { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(title().value).toBe('Unsaved');
  fireEvent.click(screen.getByText('Close editor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  expect(title().value).toBe('Unsaved');
  // A pending write blocks leaving instead of retiring its outcome.
  const gate = deferred<void>();
  state.hold = gate.promise;
  fireEvent.click(screen.getByText('Save'));
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.click(screen.getByText('Close editor'));
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  await act(async () => {});
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(phase()).toBe('ready');
  await act(async () => gate.resolve());
  await waitFor(() =>
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(true),
  );
  fireEvent.change(title(), { target: { value: 'Second draft' } });
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() => expect(title().value).toBe('B at work'));
  fireEvent.click(screen.getByText('Close editor'));
  await waitFor(() => expect(phase()).toBe('idle'));
  expect(screen.queryByLabelText('Note title')).toBeNull();
  expect(writes).toHaveLength(1);
});

it.each(['discovered', 'pending'] as const)(
  'selects a %s Context once after the guarded opening settles, under StrictMode',
  async (catalogueState) => {
    const f = await returned();
    notes(f);
    const answer = deferred<Response>();
    if (catalogueState === 'pending') f.setCatalogue(() => answer.promise);
    const select = vi.spyOn(f.runtime, 'selectContext');
    render(
      <StrictMode>
        <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
          <RowEditor />
        </SempodsProvider>
      </StrictMode>,
    );
    if (catalogueState === 'discovered') {
      fireEvent.click(await screen.findByText('Manage access'));
      await screen.findByRole('option', { name: 'work' });
      fireEvent.click(screen.getByText('Manage access'));
    }
    await edit('Edit urn:a in work');
    if (catalogueState === 'pending') {
      await waitFor(() => expect(f.count('/_system/contexts')).toBe(1));
      expect(phase()).toBe('activating');
      await act(async () => answer.resolve(catalogue()));
    }
    await waitFor(() => expect(title().value).toBe('A at work'));
    expect(select.mock.calls).toEqual([[f.id, work]]);
    expect(f.count('/_system/contexts')).toBe(1);
  },
);

it('retires on a declined selection and keeps the draft elsewhere', async () => {
  const f = await returned();
  notes(f);
  const select = vi.spyOn(f.runtime, 'selectContext');
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <RowEditor draft />
    </SempodsProvider>,
  );
  await edit('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  fireEvent.change(screen.getByLabelText('Context draft'), {
    target: { value: 'Draft elsewhere' },
  });
  fireEvent.click(screen.getByText('Edit urn:a in personal'));
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(phase()).toBe('retired:declined'));
  // One attempt per target: keeping the draft does not ask a second time.
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByLabelText('Note title')).toBeNull();
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
  expect(
    (screen.getByLabelText('Context draft') as HTMLInputElement).value,
  ).toBe('Draft elsewhere');
  await act(async () => {});
  expect(select.mock.calls).toEqual([[f.id, work]]);
});

it('retires instead of selecting its Context again after a change elsewhere', async () => {
  const f = await returned();
  notes(f);
  const select = vi.spyOn(f.runtime, 'selectContext');
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <RowEditor />
    </SempodsProvider>,
  );
  await edit('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  fireEvent.click(screen.getByText('Manage access'));
  fireEvent.change(screen.getByRole('combobox', { name: 'Data context' }), {
    target: { value: personal },
  });
  await waitFor(() => expect(phase()).toBe('retired:context-changed'));
  await act(async () => {});
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(personal);
  expect(select.mock.calls).toEqual([
    [f.id, work],
    [f.id, personal],
  ]);
  expect(screen.queryByLabelText('Note title')).toBeNull();
  // Opening the row again is a new, explicit choice.
  fireEvent.click(screen.getByText('Edit urn:a in work'));
  await waitFor(() => expect(title().value).toBe('A at work'));
});

/** Alice (`f.id`) and Bob (`other`), with Bob active after his completed callback. */
async function twoPods(preset = true) {
  const f = await returned(
    fixture({
      preferences: null,
      ...(preset ? { preset: { podUrl: pod } } : {}),
    }),
  );
  await f.runtime.initialize();
  const otherUrl = 'https://pod.example/bob';
  const other = await f.runtime.connect(otherUrl);
  await f.runtime.beginAuthorization(other.id);
  f.runtime.dispose();
  await settleLease();
  f.setToken(async (url) =>
    Response.json({
      access_token: jwt({ iss: url.split('/_system')[0] }),
      token_type: 'Bearer',
      refresh_token: 'fresh',
    }),
  );
  const runtime = f.returned();
  runtimes.push(runtime);
  await runtime.initialize();
  await restored(runtime);
  notes(f);
  return { f, runtime, other, otherUrl };
}
it.each(['before', 'after'] as const)(
  'retires on a Pod switch %s activation without discovery on the new Pod',
  async (timing) => {
    const { f, runtime, other, otherUrl } = await twoPods();
    const answer = deferred<Response>();
    // Only Alice's catalogue is expected; Bob's would be a failed test anyway.
    f.setCatalogue(() =>
      timing === 'before' ? answer.promise : Promise.resolve(catalogue()),
    );
    const select = vi.spyOn(runtime, 'selectContext');
    const bob = () =>
      f.fetch.mock.calls.filter(([url]) =>
        url.startsWith(otherUrl + '/_system/contexts'),
      );
    const ui = (id: string) => (
      <SempodsProvider runtime={runtime} contextSelection="on-demand">
        <RowEditor />
        <Switch id={id} />
      </SempodsProvider>
    );
    const { rerender } = render(ui(f.id));
    // The completed callback activates Bob; edit a row of Alice's Pod.
    fireEvent.click(await screen.findByText('Switch Pod'));
    await edit('Edit urn:a in work', f.id);
    if (timing === 'before')
      await waitFor(() => expect(phase()).toBe('activating'));
    else await waitFor(() => expect(title().value).toBe('A at work'));
    rerender(ui(other.id));
    fireEvent.click(screen.getByText('Switch Pod'));
    await waitFor(() => expect(phase()).toBe('retired:connection-changed'));
    if (timing === 'before') await act(async () => answer.resolve(catalogue()));
    await act(async () => {});
    expect(screen.queryByLabelText('Note title')).toBeNull();
    expect(bob()).toEqual([]);
    // Returning to Alice does not reactivate the retired target.
    rerender(ui(f.id));
    fireEvent.click(screen.getByText('Switch Pod'));
    await act(async () => {});
    expect(phase()).toBe('retired:connection-changed');
    expect(select.mock.calls).toEqual(timing === 'after' ? [[f.id, work]] : []);
  },
);

it.each(['unreadable', 'refused', 'offline'] as const)(
  'stays unavailable on %s discovery until the catalogue lists the Context',
  async (mode) => {
    const f = await returned();
    notes(f);
    f.setCatalogue(async () => {
      if (mode === 'offline') throw new TypeError('offline');
      return mode === 'refused'
        ? new Response(null, { status: 403 })
        : catalogue([personal], [personal]);
    });
    const select = vi.spyOn(f.runtime, 'selectContext');
    render(
      <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
        <RowEditor />
      </SempodsProvider>,
    );
    await edit('Edit urn:a in work');
    await waitFor(() => expect(phase()).toBe('unavailable'));
    expect(select).not.toHaveBeenCalled();
    // AppAccess offers the explicit retry for the demanded catalogue.
    f.setCatalogue(async () => catalogue());
    fireEvent.click(screen.getByRole('button', { name: 'Check access' }));
    await waitFor(() => expect(title().value).toBe('A at work'));
    expect(select.mock.calls).toEqual([[f.id, work]]);
  },
);

it('keeps the editor and its draft through read loss after activation', async () => {
  const f = await returned();
  notes(f);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <RowEditor />
    </SempodsProvider>,
  );
  await edit('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  const input = title();
  fireEvent.change(input, { target: { value: 'Unfinished' } });
  f.setCatalogue(async () => catalogue([personal], [personal]));
  await act(() => f.runtime.loadContexts(f.id));
  expect(phase()).toBe('ready');
  expect(title()).toBe(input);
  expect(input.value).toBe('Unfinished');
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  expect(phase()).toBe('ready');
  expect(title().value).toBe('Unfinished');
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
});

it('requires readable evidence again when a row is reopened after read loss', async () => {
  const f = await returned();
  notes(f);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <RowEditor />
    </SempodsProvider>,
  );
  await edit('Edit urn:a in work');
  await waitFor(() => expect(title().value).toBe('A at work'));
  f.setCatalogue(async () => catalogue([personal], [personal]));
  await act(() => f.runtime.loadContexts(f.id));
  expect(phase()).toBe('ready');
  fireEvent.click(screen.getByText('Close editor'));
  const leave = screen.queryByRole('button', { name: 'Discard and continue' });
  if (leave) fireEvent.click(leave);
  await waitFor(() => expect(phase()).toBe('idle'));
  // The controller keeps the view, but a newly opened target needs evidence.
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
  fireEvent.click(screen.getByText('Edit urn:a in work'));
  await waitFor(() => expect(phase()).toBe('unavailable'));
  expect(screen.queryByLabelText('Note title')).toBeNull();
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() => expect(title().value).toBe('A at work'));
});

it('keeps an opened row on its connection when another becomes active during the leave prompt', async () => {
  const { f, runtime, other, otherUrl } = await twoPods(false);
  const bob = () =>
    f.fetch.mock.calls.filter(([url]) => url.startsWith(otherUrl + '/'));
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <RowEditor />
      <Switch id={f.id} />
    </SempodsProvider>,
  );
  fireEvent.click(await screen.findByText('Switch Pod'));
  await edit('Edit urn:a in work', f.id);
  await waitFor(() => expect(title().value).toBe('A at work'));
  fireEvent.change(title(), { target: { value: 'Unsaved' } });
  fireEvent.click(screen.getByText('Edit urn:b in work'));
  await screen.findByRole('alertdialog');
  const before = bob().length;
  // Alice disappears while the person decides; the controller activates Bob.
  await act(async () => {
    await runtime.disconnect(f.id);
  });
  await waitFor(() =>
    expect(screen.getByTestId('active').textContent).toBe(other.id),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard and continue' }));
  await waitFor(() => expect(phase()).toBe('retired:connection-changed'));
  await act(async () => {});
  expect(screen.queryByLabelText('Note title')).toBeNull();
  expect(bob().slice(before)).toEqual([]);
});

function Unsaved() {
  useDraftGuard(true, () => {});
  return null;
}
it('selects nothing when another connection became active during the selection prompt', async () => {
  const { f, runtime, other } = await twoPods();
  const report = await runtime.initialize();
  // Startup is still settling: Alice is active by preset until it completes.
  const startup = deferred<typeof report>();
  vi.spyOn(runtime, 'initialize').mockReturnValue(startup.promise);
  const select = vi.spyOn(runtime, 'selectContext');
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <RowEditor />
      <Unsaved />
    </SempodsProvider>,
  );
  await edit('Edit urn:a in work', f.id);
  await screen.findByRole('alertdialog');
  // The completed callback activates Bob while the person decides.
  await act(async () => startup.resolve({ ...report, connectionId: other.id }));
  await waitFor(() =>
    expect(screen.getByTestId('active').textContent).toBe(other.id),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard and continue' }));
  await waitFor(() => expect(phase()).toBe('retired:connection-changed'));
  await act(async () => {});
  expect(select).not.toHaveBeenCalled();
  expect(
    runtime.getSnapshot().find((c) => c.id === f.id)?.selectedContext,
  ).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});
