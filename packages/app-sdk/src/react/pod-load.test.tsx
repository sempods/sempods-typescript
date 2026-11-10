// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type { BoundPod, BrowserRuntime, Connection } from '../index.js';
import {
  LoadNotice,
  SempodsProvider,
  useApp,
  useAppState,
  useConnections,
  usePodLoad,
} from './index.js';
import {
  deferred,
  fixture,
  jwt,
  pod,
  returnedSession,
  twoPods,
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

/** One source: an explicit handle, its own state, notice and retry. */
function Source({
  name,
  reader,
  query = '',
  seen,
}: {
  readonly name: string;
  readonly reader: BoundPod | null;
  readonly query?: string;
  readonly seen?: string[];
}) {
  // Inline callback and data type inferred from the handle form.
  const load = usePodLoad(
    reader,
    (target, signal) =>
      target.sparql.construct(`CONSTRUCT {} WHERE {} # ${query}`, { signal }),
    { key: query },
  );
  seen?.push(load.state.kind);
  return (
    <section aria-label={name}>
      <output>
        {load.state.kind === 'ready'
          ? JSON.stringify(load.data)
          : load.state.kind}
      </output>
      <LoadNotice {...load} />
      <button onClick={() => void load.reload()}>Read {name} again</button>
    </section>
  );
}
const region = (name: string) => within(screen.getByRole('region', { name }));
const text = (name: string) =>
  screen.getByRole('region', { name }).querySelector('output')!.textContent;

/** The recipe: read only connections that read; bindPod never throws then. */
const reads = ({ reading }: Connection) => reading !== null;
function EachConnection({ runtime }: { readonly runtime: BrowserRuntime }) {
  return useConnections()
    .filter(reads)
    .map((connection) => (
      <Source
        key={connection.id}
        name={connection.podUrl}
        reader={reads(connection) ? runtime.bindPod(connection.id) : null}
      />
    ));
}

it('reads each connection through its own handle, failing and retrying independently', async () => {
  const { f, runtime, otherUrl } = await twoPods(keep);
  let alice = 0;
  let bob = 0;
  f.setQuery(async (url) => {
    if (url.startsWith(pod + '/'))
      return ++alice === 1
        ? new Response(null, { status: 403 })
        : Response.json([{ '@id': 'urn:alice' }]);
    bob++;
    return Response.json([{ '@id': 'urn:bob' }]);
  });
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <EachConnection runtime={runtime} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(text(otherUrl)).toBe('[{"@id":"urn:bob"}]'));
  await waitFor(() => expect(text(pod)).toBe('failed'));
  // The SDK notice explains the refusal; its retry reads only this source.
  expect(region(pod).getByRole('alert')).toBeTruthy();
  expect(region(otherUrl).queryByRole('alert')).toBeNull();
  fireEvent.click(region(pod).getByRole('button', { name: 'Try again' }));
  await waitFor(() => expect(text(pod)).toBe('[{"@id":"urn:alice"}]'));
  expect([alice, bob]).toEqual([2, 1]);
  expect(text(otherUrl)).toBe('[{"@id":"urn:bob"}]');
});

it('withdraws only the disconnected connection’s result, also from a kept handle', async () => {
  const { f, runtime, other, otherUrl } = await twoPods(keep);
  f.setQuery(async (url) =>
    Response.json([
      { '@id': url.startsWith(pod + '/') ? 'urn:alice' : 'urn:bob' },
    ]),
  );
  const kept = runtime.bindPod(other.id);
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <EachConnection runtime={runtime} />
      <Source name="kept" reader={kept} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(text('kept')).toBe('[{"@id":"urn:bob"}]'));
  await waitFor(() => expect(text(otherUrl)).toBe('[{"@id":"urn:bob"}]'));
  await waitFor(() => expect(text(pod)).toBe('[{"@id":"urn:alice"}]'));
  await act(() => runtime.disconnect(other.id));
  // The recipe drops the signed-out source; a kept handle withdraws its data.
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: otherUrl })).toBeNull(),
  );
  expect(text('kept')).toBe('unavailable');
  expect(text(pod)).toBe('[{"@id":"urn:alice"}]');
  expect(screen.queryByText(/urn:bob/)).toBeNull();
  // An ended handle never revives on retry.
  fireEvent.click(screen.getByText('Read kept again'));
  expect(text('kept')).toBe('unavailable');
});

it('aborts the superseded handle’s read and ignores its late answer', async () => {
  const { f, runtime, other } = await twoPods(keep);
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
      <Source name="source" reader={runtime.bindPod(id)} />
    </SempodsProvider>
  );
  const { rerender } = render(ui(f.id));
  await waitFor(() => expect(signal).toBeDefined());
  expect(text('source')).toBe('loading');
  rerender(ui(other.id));
  await waitFor(() => expect(text('source')).toBe('[{"@id":"urn:bob"}]'));
  expect(signal?.aborted).toBe(true);
  await act(async () => gate.resolve(Response.json([{ '@id': 'urn:alice' }])));
  expect(text('source')).toBe('[{"@id":"urn:bob"}]');
});

it('shows a new or replaced handle as loading, never unavailable, until it answers', async () => {
  const { f, runtime, other } = await twoPods(keep);
  f.setQuery(async (url) =>
    Response.json([
      { '@id': url.startsWith(pod + '/') ? 'urn:alice' : 'urn:bob' },
    ]),
  );
  const seen: string[] = [];
  let settledAtMount: boolean | undefined;
  /** Mounts the source only once startup has settled. */
  function AfterStartup({ id }: { readonly id: string }) {
    const { startup } = useAppState();
    if (!startup) return null;
    settledAtMount ??= true;
    return <Source name="source" reader={runtime.bindPod(id)} seen={seen} />;
  }
  const ui = (id: string) => (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <AfterStartup id={id} />
    </SempodsProvider>
  );
  const { rerender } = render(ui(f.id));
  await waitFor(() => expect(text('source')).toBe('[{"@id":"urn:alice"}]'));
  expect(settledAtMount).toBe(true);
  expect(seen[0]).toBe('loading');
  rerender(ui(other.id));
  await waitFor(() => expect(text('source')).toBe('[{"@id":"urn:bob"}]'));
  expect(seen).not.toContain('unavailable');
});

it('does not follow or re-render for the active connection', async () => {
  const { f, runtime, other } = await twoPods(keep);
  f.setQuery(async (url) =>
    Response.json([
      { '@id': url.startsWith(pod + '/') ? 'urn:alice' : 'urn:bob' },
    ]),
  );
  const seen: string[] = [];
  function Active() {
    const app = useApp();
    const { activeId } = useAppState();
    return (
      <>
        <output data-testid="active">{activeId}</output>
        <button onClick={() => void app.selectConnection(f.id)}>Alice</button>
        <button onClick={() => void app.selectConnection(other.id)}>Bob</button>
      </>
    );
  }
  const reader = runtime.bindPod(f.id);
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Active />
      <Source name="source" reader={reader} seen={seen} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(text('source')).toBe('[{"@id":"urn:alice"}]'));
  const target =
    screen.getByTestId('active').textContent === f.id ? 'Bob' : 'Alice';
  const renders = seen.length;
  fireEvent.click(screen.getByText(target));
  await waitFor(() =>
    expect(screen.getByTestId('active').textContent).toBe(
      target === 'Bob' ? other.id : f.id,
    ),
  );
  expect(seen).toHaveLength(renders);
  expect(text('source')).toBe('[{"@id":"urn:alice"}]');
});

it('cancels a superseded query when its key changes and never shows the old inputs’ data', async () => {
  const { f, runtime } = await twoPods(keep);
  const gate = deferred<Response>();
  const signals: (AbortSignal | undefined)[] = [];
  f.setQuery(async (_url, init) => {
    signals.push(init?.signal ?? undefined);
    return signals.length === 1
      ? gate.promise
      : Response.json([{ '@id': 'urn:second' }]);
  });
  const reader = runtime.bindPod(f.id);
  const ui = (query: string) => (
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Source name="source" reader={reader} query={query} />
    </SempodsProvider>
  );
  const { rerender } = render(ui('first'));
  await waitFor(() => expect(signals).toHaveLength(1));
  rerender(ui('second'));
  await waitFor(() => expect(text('source')).toBe('[{"@id":"urn:second"}]'));
  expect(signals[0]?.aborted).toBe(true);
  await act(async () => gate.resolve(Response.json([{ '@id': 'urn:first' }])));
  expect(text('source')).toBe('[{"@id":"urn:second"}]');
});

it('shows no handle as loading until startup settles, then unavailable, without any request', async () => {
  const f = fixture({ preferences: null });
  keep(f.runtime);
  const startup = deferred<Awaited<ReturnType<BrowserRuntime['initialize']>>>();
  vi.spyOn(f.runtime, 'initialize').mockReturnValue(startup.promise);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Source name="source" reader={null} />
    </SempodsProvider>,
  );
  expect(text('source')).toBe('loading');
  await act(async () => startup.reject(new Error('Storage startup failed')));
  await waitFor(() => expect(text('source')).toBe('unavailable'));
  expect(
    region('source').getByText('This cannot be read right now.'),
  ).toBeTruthy();
  expect(f.count('/_system/sparql/query')).toBe(0);
});

it('refreshes a ready explicit read after its grants change', async () => {
  const f = await returnedSession(
    keep,
    fixture({ preferences: null, scopes: { optional: ['ai'] } }),
  );
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ scope: 'ai' }),
      token_type: 'Bearer',
      refresh_token: 'initial',
    }),
  );
  await f.runtime.initialize();
  const reader = f.runtime.bindPod(f.id);
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Source name="source" reader={reader} />
    </SempodsProvider>,
  );
  await waitFor(() => expect(text('source')).toBe('[{"@id":"urn:item"}]'));
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
  // Renewal by another read drops the optional grant on the same handle.
  await act(() => reader.sparql.construct('CONSTRUCT {} WHERE {}'));
  await waitFor(() =>
    expect(text('source')).toBe('[{"@id":"urn:changed-grants"}]'),
  );
  expect(f.count('/_system/contexts')).toBe(0);
});

it('explicit reads wait for a podReadLimit slot and all become ready', async () => {
  const f = await returnedSession(
    keep,
    fixture({ preferences: null, podReadLimit: { perPod: 1 } }),
  );
  await f.runtime.initialize();
  const reader = f.runtime.bindPod(f.id);
  const gates: (() => void)[] = [];
  let running = 0;
  let most = 0;
  f.setQuery(async (_url, init) => {
    most = Math.max(most, ++running);
    const name = String(init?.body).split('# ')[1];
    await new Promise<void>((resolve) => gates.push(resolve));
    running--;
    return Response.json([{ '@id': `urn:${name}` }]);
  });
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Source name="one" reader={reader} query="one" />
      <Source name="two" reader={reader} query="two" />
      <Source name="three" reader={reader} query="three" />
    </SempodsProvider>,
  );
  await waitFor(() => expect(gates).toHaveLength(1));
  for (let answered = 0; answered < 3; answered++) {
    await waitFor(() => expect(gates.length).toBeGreaterThan(answered));
    act(() => gates[answered]!());
  }
  await waitFor(() => expect(text('three')).toBe('[{"@id":"urn:three"}]'));
  expect(text('one')).toBe('[{"@id":"urn:one"}]');
  expect(text('two')).toBe('[{"@id":"urn:two"}]');
  expect(most).toBe(1);
  expect(f.count('/_system/sparql/query')).toBe(3);
});
