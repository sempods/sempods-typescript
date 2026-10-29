// @vitest-environment jsdom
/** One chooser for Contexts across connected Pods (#188). */
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
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
import {
  SempodsProvider,
  TargetScreen,
  useDraftGuard,
  useApp,
  usePodContexts,
  type PodContextList,
} from './index.js';
import { useController } from './app.js';
import type { AppSnapshot, TargetSelection } from '../index.js';
import { targetProblem } from '../authoring/app.js';
import type { Connection } from '../runtime/types.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  personal,
  renewal,
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

const bobUrl = 'https://pod.example/bob';
const shop = bobUrl + '/_system/contexts/shop';
const archive = bobUrl + '/_system/contexts/archive';
const sd = 'http://www.w3.org/ns/sparql-service-description#';
const description = (iri: string, label: string) =>
  Response.json({
    '@id': iri,
    '@type': [`${sd}NamedGraph`],
    [`${sd}name`]: [{ '@id': iri }],
    'https://schema.sempods.org/public': [{ '@value': false }],
    'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': label }],
  });
// "Shopping" exists on both Pods; Bob's archive is read-only.
const labels: Record<string, string> = {
  [work]: 'Shopping',
  [personal]: 'Home',
  [shop]: 'Shopping',
  [archive]: 'Archive',
};

async function setup({ mode = 'required' as 'required' | 'on-demand' } = {}) {
  const { f, runtime, other } = await twoPods(keep);
  const answers = {
    alice: () => Promise.resolve(catalogue([work, personal], [work])),
    bob: () => Promise.resolve(catalogue([shop, archive], [shop], bobUrl)),
  };
  f.setCatalogue((url) =>
    url.startsWith(bobUrl) ? answers.bob() : answers.alice(),
  );
  f.setDescriptions(async (url) => description(url, labels[url] ?? 'Other'));
  const api = {} as {
    list: PodContextList;
    snapshots: AppSnapshot[];
    dirty: (value: boolean) => void;
    controller: ReturnType<typeof useController>;
  };
  api.snapshots = [];
  function Probe() {
    api.list = usePodContexts({ podNames: { [bobUrl]: 'Bob' } });
    const controller = useController();
    api.controller = controller;
    useState(() =>
      controller.subscribe(() => api.snapshots.push(controller.getSnapshot())),
    );
    const [dirty, setDirty] = useState(false);
    api.dirty = setDirty;
    useDraftGuard(dirty, () => setDirty(false));
    useApp();
    return (
      <ul>
        {api.list.choices.map((choice) => (
          <li key={choice.key}>
            <button
              disabled={!choice.selectable}
              onClick={() => void api.list.select(choice)}
            >
              {choice.name}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  render(
    <SempodsProvider runtime={runtime} contextSelection={mode}>
      <Probe />
      <TargetScreen>
        <p>Screen</p>
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(api.list.pods.map((p) => p.status)).toEqual(['ready', 'ready']),
  );
  return { f, runtime, alice: f.id, bob: other.id, api, answers };
}
const pod = (api: { list: PodContextList }, id: string) =>
  api.list.pods.find((p) => p.connectionId === id)!;
const target = (connectionId: string, contextIri: string) => ({
  connectionId,
  contextIri,
});
const select = async (
  api: { list: PodContextList },
  connectionId: string,
  contextIri: string,
) => {
  let result!: Promise<TargetSelection>;
  act(() => {
    result = api.list.select(target(connectionId, contextIri));
  });
  return result;
};

it("lists every Pod's readable Contexts and tells equal names apart by Pod", async () => {
  const { api, alice, bob } = await setup();
  const names = {
    [alice]: [
      [alice, 'Shopping · pod.example/alice'],
      [alice, 'Home'],
    ],
    [bob]: [
      [bob, 'Shopping · Bob'],
      [bob, 'Archive'],
    ],
  };
  // In connection order, which the runtime decides.
  await waitFor(() =>
    expect(api.list.choices.map((c) => [c.connectionId, c.name])).toEqual(
      api.list.pods.flatMap((p) => names[p.connectionId]!),
    ),
  );
  expect(pod(api, bob).name).toBe('Bob');
  expect(pod(api, alice).name).toBe('pod.example/alice');
  expect(
    Object.fromEntries(api.list.choices.map((c) => [c.iri, c.writable])),
  ).toEqual({
    [work]: true,
    [personal]: false,
    [shop]: true,
    [archive]: false,
  });
  // Read-only Contexts are selectable too; a key tells equal IRIs apart.
  expect(api.list.choices.every((c) => c.selectable)).toBe(true);
  expect(new Set(api.list.choices.map((c) => c.key)).size).toBe(4);
});

it("switches Pod and Context in one step without showing the new Pod's old Context", async () => {
  const { api, runtime, alice, bob } = await setup();
  expect(await select(api, alice, work)).toEqual({ kind: 'selected' });
  // Bob's Pod remembers another Context from earlier.
  act(() => runtime.selectContext(bob, archive));
  api.snapshots.length = 0;
  expect(await select(api, bob, shop)).toEqual({ kind: 'selected' });
  const active = api.snapshots.filter((s) => s.activeId === bob);
  expect(active.length).toBeGreaterThan(0);
  for (const s of active)
    expect(s.connections.find((c) => c.id === bob)?.selectedContext).toBe(shop);
  await waitFor(() =>
    expect(api.list.selected).toMatchObject({ connectionId: bob, iri: shop }),
  );
  // Selecting it again changes nothing.
  expect(await select(api, bob, shop)).toEqual({ kind: 'selected' });
});

it('asks once about a draft; declining keeps Pod and Context', async () => {
  const { api, alice, bob } = await setup();
  await act(async () => {
    await api.list.select(target(alice, work));
  });
  act(() => api.dirty(true));
  const pending = select(api, bob, shop);
  const dialog = await screen.findByRole('alertdialog');
  expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
  expect(await pending).toEqual({ kind: 'declined' });
  expect(api.list.selected).toMatchObject({ connectionId: alice, iri: work });
  // Confirming switches and discards the draft.
  const again = select(api, bob, shop);
  fireEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: 'Discard and continue',
    }),
  );
  expect(await again).toEqual({ kind: 'selected' });
  expect(api.list.selected).toMatchObject({ connectionId: bob, iri: shop });
});

it('withdraws the question when the target disappears and switches nothing', async () => {
  const { api, runtime, alice, bob, answers } = await setup();
  await act(async () => {
    await api.list.select(target(alice, work));
  });
  act(() => api.dirty(true));
  const pending = select(api, bob, shop);
  await screen.findByRole('alertdialog');
  // Bob's Pod no longer shares the shopping list.
  answers.bob = () => Promise.resolve(catalogue([archive], [], bobUrl));
  await act(() => runtime.loadContexts(bob));
  expect(await pending).toEqual({ kind: 'unavailable', reason: 'unlisted' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(api.list.selected).toMatchObject({ connectionId: alice, iri: work });
});

it('refuses unknown, unlisted and ended targets before asking', async () => {
  const { api, runtime, bob } = await setup();
  expect(await select(api, 'nope', shop)).toEqual({
    kind: 'unavailable',
    reason: 'connection',
  });
  expect(await select(api, bob, bobUrl + '/_system/contexts/hidden')).toEqual({
    kind: 'unavailable',
    reason: 'unlisted',
  });
  await act(() => runtime.disconnect(bob));
  await waitFor(() => expect(api.list.pods).toHaveLength(1));
  expect(await select(api, bob, shop)).toEqual({
    kind: 'unavailable',
    reason: 'connection',
  });
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it("keeps a Pod's known entries when its catalogue fails, and retries only it", async () => {
  const { api, runtime, alice, bob, answers } = await setup();
  answers.bob = () => Promise.resolve(new Response(null, { status: 500 }));
  await act(() => runtime.loadContexts(bob).catch(() => {}));
  await waitFor(() => expect(pod(api, bob).status).toBe('failed'));
  // Known entries stay, but cannot be selected until the catalogue is read.
  expect(pod(api, bob).choices.map((c) => c.iri)).toEqual([shop, archive]);
  expect(pod(api, bob).choices.every((c) => !c.selectable)).toBe(true);
  expect(pod(api, alice).status).toBe('ready');
  answers.bob = () =>
    Promise.resolve(catalogue([shop, archive], [shop], bobUrl));
  await act(() => pod(api, bob).retry());
  await waitFor(() => expect(pod(api, bob).status).toBe('ready'));
  expect(pod(api, bob).choices.every((c) => c.selectable)).toBe(true);
});

it('does not read labels again when a session only renews', async () => {
  const { f, api, runtime, alice } = await setup();
  const reads = () =>
    f.fetch.mock.calls.filter(([url]) => url.includes('/_system/contexts/'))
      .length;
  await waitFor(() => expect(api.list.choices[0]?.name).toContain('Shopping'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = reads();
  await act(() => renewal(f, runtime, alice, 'rotated'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(reads()).toBe(before);
  expect(pod(api, alice).status).toBe('ready');
});

it('discovers every signed-in Pod also on demand', async () => {
  const { api } = await setup({ mode: 'on-demand' });
  expect(api.list.choices).toHaveLength(4);
});

it('is blocked by a pending write and asks nothing', async () => {
  const { api, alice, bob } = await setup();
  expect(await select(api, alice, work)).toEqual({ kind: 'selected' });
  const release = api.controller.register({
    blocked: () => true,
    dirty: () => false,
    discard: () => {},
  });
  expect(await select(api, bob, shop)).toEqual({ kind: 'blocked' });
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(api.list.selected).toMatchObject({ connectionId: alice, iri: work });
  release();
  expect(await select(api, bob, shop)).toEqual({ kind: 'selected' });
});

it("keeps each Pod's own selected Context when switching back", async () => {
  const { api, runtime, alice, bob } = await setup();
  expect(await select(api, bob, shop)).toEqual({ kind: 'selected' });
  expect(await select(api, alice, personal)).toEqual({ kind: 'selected' });
  const selected = (id: string) =>
    runtime.getSnapshot().find((c) => c.id === id)?.selectedContext;
  expect([selected(alice), selected(bob)]).toEqual([personal, shop]);
});

it('names why a target cannot be selected', () => {
  const ready = {
    id: 'a',
    podUrl: 'https://pod.example/alice',
    session: { kind: 'active', subject: 'urn:alice' },
    missingRequiredScopes: [],
    catalogue: {
      kind: 'ready',
      contexts: [{ iri: work, readable: true, writable: false }],
    },
  } as unknown as Connection;
  const at = (
    c: Partial<Connection>,
    preset?: { podUrl: string; contextIri?: string },
  ) =>
    targetProblem([{ ...ready, ...c } as Connection], preset as never, {
      connectionId: 'a',
      contextIri: work,
    });
  expect(at({})).toBeNull();
  expect(at({ session: { kind: 'restoring' } } as Partial<Connection>)).toBe(
    'session',
  );
  expect(at({ missingRequiredScopes: ['urn:scope'] })).toBe('session');
  expect(at({ catalogue: { kind: 'loading' } })).toBe('catalogue');
  expect(
    at({ catalogue: { kind: 'ready', contexts: [] } } as Partial<Connection>),
  ).toBe('unlisted');
  expect(at({}, { podUrl: ready.podUrl, contextIri: personal })).toBe('preset');
  expect(at({}, { podUrl: ready.podUrl })).toBeNull();
});
