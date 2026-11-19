// @vitest-environment jsdom
/**
 * A confirmed row update shows the modification instant it wrote until the
 * list reads the resource again (#387), through `useFieldUpdate` and
 * `useContextUpdate`; every other outcome keeps the instants as read.
 */
import { webcrypto } from 'node:crypto';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fields,
  flag,
  text,
  timestampsOf,
  type Snapshot,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import { bought } from '../../../../examples/todo/recipes/timestamps.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  catalogue,
  deferred,
  fixture,
  personal,
  resourceIri,
  returnedSession,
  work,
} from '../runtime/fixture.test.js';
import {
  SempodsProvider,
  TargetScreen,
  useContextUpdate,
  useFieldUpdate,
  useList,
  usePodList,
} from './index.js';

const MODIFIED = 'https://schema.org/dateModified';
const DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
/** When the open item was last changed, long before it is ticked. */
const T0 = '2026-11-01T08:00:00.000Z';
/** When an item bought earlier was last changed. */
const EARLIER = '2026-11-10T08:00:00.000Z';
/** The device clock when a row is ticked. */
const T1 = '2026-11-19T09:00:00.000Z';
const T2 = '2026-11-19T09:05:00.000Z';
const instant = (value: string) => [{ '@value': value, '@type': DT }];

const stops: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(T1));
});
afterEach(() => {
  cleanup();
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Item = { readonly name: string; readonly bought: boolean };
const item = fields(
  {
    name: text('urn:name', { language: null }),
    bought: flag('urn:bought', { on: 'urn:yes', off: 'urn:no' }),
  },
  { type: 'urn:Item', timestamps: { modified: MODIFIED } },
);
const node = (iri: string, name: string, bought: boolean, at: string) => ({
  '@id': iri,
  '@type': ['urn:Item'],
  'urn:name': [{ '@value': name }],
  'urn:bought': [{ '@id': bought ? 'urn:yes' : 'urn:no' }],
  [MODIFIED]: instant(at),
});

/**
 * Items per Context, with a list read and the writes that can be held, and a
 * status other than 204 to answer writes with.
 */
function memoryPod(items: Record<string, readonly JsonLd[]>) {
  const store = new Map(
    Object.entries(items).map(([context, nodes]) => [
      context,
      new Map(nodes.map((n) => [n['@id'] as string, { body: n, version: 1 }])),
    ]),
  );
  const control = {
    list: null as Promise<void> | null,
    write: null as Promise<void> | null,
    status: 204,
  };
  const reads: string[] = [];
  const entries = (context: string) => store.get(context) ?? new Map();
  return {
    control,
    reads,
    /** Another writer changes a resource, with its own instant. */
    other(context: string, iri: string, change: JsonLd) {
      const entry = entries(context).get(iri)!;
      entry.body = { ...entry.body, ...change };
      entry.version++;
    },
    async query(context: string) {
      reads.push(context);
      await control.list;
      return Response.json([...entries(context).values()].map((e) => e.body));
    },
    async resource(context: string, iri: string, init?: RequestInit) {
      const entry = entries(context).get(iri);
      if ((init?.method ?? 'GET') === 'GET')
        return entry
          ? Response.json(entry.body, {
              headers: { etag: `"v${entry.version}"` },
            })
          : new Response(null, { status: 404 });
      await control.write;
      if (control.status === 412) {
        entry!.version++;
        return new Response(null, { status: 412 });
      }
      // A lost answer applies the change as well.
      const next: Record<string, unknown> = {
        ...entry!.body,
        ...(JSON.parse(String(init?.body)) as JsonLd),
      };
      for (const [key, value] of Object.entries(next))
        if (value === null) delete next[key];
      entry!.body = next as JsonLd;
      entry!.version++;
      return new Response(null, { status: control.status });
    },
  };
}

/** `useList` and `useFieldUpdate` on the selected target. */
async function targetList(pod: ReturnType<typeof memoryPod>) {
  const f = fixture();
  const session = await f.login();
  stops.push(() => session.runtime.dispose());
  // The selected target's items are kept under `target`.
  f.setQuery(() => pod.query('target'));
  f.setResource((url, init) => pod.resource('target', resourceIri(url), init));
  let api!: {
    list: ReturnType<typeof useList<Item>>;
    update: ReturnType<typeof useFieldUpdate<Item>>;
  };
  function Screen() {
    api = { list: useList(item), update: useFieldUpdate(item) };
    return null;
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.list.state.kind).toBe('ready'));
  const snapshot = (iri: string) =>
    api.list.data!.items.find((i) => i.iri === iri)!;
  const row = (iri: string) => api.update.for(snapshot(iri));
  return { api: () => api, snapshot, row };
}

it('useFieldUpdate: a confirmed tick orders by its own instant while the list refresh is held', async () => {
  const pod = memoryPod({
    target: [
      node('urn:old', 'Bread', true, EARLIER),
      node('urn:new', 'Milk', false, T0),
    ],
  });
  const { api, snapshot, row } = await targetList(pod);
  const original = snapshot('urn:new');
  const held = deferred<void>();
  pod.control.list = held.promise;
  await act(async () => {
    expect(await row('urn:new').update({ bought: true })).toEqual({
      kind: 'saved',
      modified: T1,
    });
  });
  await waitFor(() => expect(pod.reads.length).toBeGreaterThan(1));
  // The refresh is still on its way: the same snapshot, shown as confirmed.
  expect(snapshot('urn:new')).toBe(original);
  expect(row('urn:new').data.bought).toBe(true);
  expect(row('urn:new').timestamps).toEqual({ created: null, modified: T1 });
  // The snapshot stays the evidence of what was read.
  expect(timestampsOf(original)).toEqual({ created: null, modified: T0 });
  expect(row('urn:old').timestamps).toEqual({
    created: null,
    modified: EARLIER,
  });
  // The timestamps recipe orders the rows as shown: the item just ticked first.
  const shown = api().list.data!.items.map((i) => ({
    iri: i.iri,
    ...api().update.for(i),
  }));
  expect(bought(shown).map((r) => r.data.name)).toEqual(['Milk', 'Bread']);
  expect(bought(api().list.data!.items).map((r) => r.data.name)).toEqual([
    'Bread',
  ]);

  // Another writer renames it before the list reads it again.
  pod.other('target', 'urn:new', {
    'urn:name': [{ '@value': 'Oat milk' }],
    [MODIFIED]: instant(T2),
  });
  await act(async () => held.resolve());
  await waitFor(() => expect(snapshot('urn:new')).not.toBe(original));
  // The fresh snapshot supplies the instant again, also another writer's.
  expect(row('urn:new').timestamps).toEqual({ created: null, modified: T2 });
  expect(timestampsOf(snapshot('urn:new')).modified).toBe(T2);
  expect(api().list.state.kind).toBe('ready');
});

it('useFieldUpdate: pending, refused, conflicting and unconfirmed writes keep the instant as read', async () => {
  const pod = memoryPod({ target: [node('urn:new', 'Milk', false, T0)] });
  const { snapshot, row } = await targetList(pod);
  const read = { created: null, modified: T0 };
  // Pending, and a second command refused while it is.
  const answer = deferred<void>();
  pod.control.write = answer.promise;
  pod.control.status = 202;
  let outcome: Promise<unknown>;
  act(() => {
    outcome = row('urn:new').update({ bought: true });
  });
  await waitFor(() => expect(row('urn:new').canMutate).toBe(false));
  expect(row('urn:new').timestamps).toEqual(read);
  await act(async () => {
    expect(await row('urn:new').update({ bought: true })).toEqual({
      kind: 'not-sent',
      reason: 'busy',
    });
  });
  expect(row('urn:new').timestamps).toEqual(read);
  // The answer is lost (202): unconfirmed, though the Pod holds T1 now.
  await act(async () => answer.resolve());
  await act(async () => {
    expect(await outcome).toMatchObject({ kind: 'unconfirmed' });
  });
  expect(row('urn:new').notice.outcome?.kind).toBe('unconfirmed');
  expect(row('urn:new').data.bought).toBe(false);
  expect(row('urn:new').timestamps).toEqual(read);
  expect(timestampsOf(snapshot('urn:new'))).toEqual(read);
});

it('useFieldUpdate: a change on the Pod keeps the instant as read', async () => {
  const pod = memoryPod({ target: [node('urn:new', 'Milk', false, T0)] });
  const { row } = await targetList(pod);
  pod.control.status = 412;
  await act(async () => {
    expect(await row('urn:new').update({ bought: true })).toMatchObject({
      kind: 'changed-on-pod',
    });
  });
  expect(row('urn:new').timestamps).toEqual({ created: null, modified: T0 });
});

/** `usePodList` and `useContextUpdate` over the work and personal Contexts. */
async function overview(pod: ReturnType<typeof memoryPod>) {
  const runtimes: BrowserRuntime[] = [];
  stops.push(() => runtimes.forEach((r) => r.dispose()));
  const f = await returnedSession((r) => void runtimes.push(r));
  f.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  f.setQuery(async (url) => {
    const context = new URL(url).searchParams.get('default-graph-uri');
    if (context) return pod.query(context);
    // The Pod-wide discovery of Contexts that hold the type.
    return new Response(
      JSON.stringify({
        head: { vars: ['graph'] },
        results: {
          bindings: [work, personal].map((graph) => ({
            graph: { type: 'uri', value: graph },
          })),
        },
      }),
      { headers: { 'content-type': 'application/sparql-results+json' } },
    );
  });
  f.setResource((url, init) =>
    pod.resource(
      new URL(url).searchParams.get('context')!,
      resourceIri(url),
      init,
    ),
  );
  let api!: {
    list: ReturnType<typeof usePodList<Item>>;
    overview: ReturnType<typeof useContextUpdate<Item>>;
  };
  function Screen() {
    api = { list: usePodList(item), overview: useContextUpdate(item) };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime} contextSelection="on-demand">
      <Screen />
    </SempodsProvider>,
  );
  const entry = (iri: string) =>
    api.list.data?.items.find((i) => i.snapshot.iri === iri);
  await waitFor(() => {
    expect(entry('urn:a')).toBeDefined();
    expect(entry('urn:b')).toBeDefined();
    expect(api.overview.for(entry('urn:a')!).canMutate).toBe(true);
    expect(api.overview.for(entry('urn:b')!).canMutate).toBe(true);
  });
  const row = (iri: string) => api.overview.for(entry(iri)!);
  return { entry, row };
}

it('useContextUpdate: concurrent rows in two Contexts each show their own instant until the refresh', async () => {
  const pod = memoryPod({
    [work]: [node('urn:a', 'Buy milk', false, T0)],
    [personal]: [node('urn:b', 'Call Ann', false, T0)],
  });
  const { entry, row } = await overview(pod);
  const originals = new Map<string, Snapshot<Item>>(
    ['urn:a', 'urn:b'].map((iri) => [iri, entry(iri)!.snapshot]),
  );
  const writes = deferred<void>();
  const list = deferred<void>();
  pod.control.write = writes.promise;
  pod.control.list = list.promise;
  // Ticked at two instants, both pending at once.
  let first: Promise<unknown>;
  let second: Promise<unknown>;
  act(() => {
    first = row('urn:a').update({ bought: true });
  });
  vi.setSystemTime(new Date(T2));
  act(() => {
    second = row('urn:b').update({ bought: true });
  });
  await waitFor(() => {
    expect(row('urn:a').canMutate).toBe(false);
    expect(row('urn:b').canMutate).toBe(false);
  });
  expect(row('urn:a').timestamps.modified).toBe(T0);
  await act(async () => writes.resolve());
  await act(async () => {
    expect(await first).toEqual({ kind: 'saved', modified: T1 });
    expect(await second).toEqual({ kind: 'saved', modified: T2 });
  });
  // Both refreshes are held: each row shows its own command's instant.
  expect(entry('urn:a')!.snapshot).toBe(originals.get('urn:a'));
  expect(entry('urn:b')!.snapshot).toBe(originals.get('urn:b'));
  expect(row('urn:a').data.bought).toBe(true);
  expect(row('urn:a').timestamps.modified).toBe(T1);
  expect(row('urn:b').timestamps.modified).toBe(T2);
  for (const original of originals.values())
    expect(timestampsOf(original).modified).toBe(T0);

  await act(async () => list.resolve());
  await waitFor(() => {
    expect(entry('urn:a')!.snapshot).not.toBe(originals.get('urn:a'));
    expect(entry('urn:b')!.snapshot).not.toBe(originals.get('urn:b'));
  });
  // Read again: the instants the Pod now holds, from the fresh snapshots.
  expect(timestampsOf(entry('urn:a')!.snapshot).modified).toBe(T1);
  expect(row('urn:a').timestamps.modified).toBe(T1);
  expect(row('urn:b').timestamps.modified).toBe(T2);
});

it('useContextUpdate: an unconfirmed tick keeps the instant as read', async () => {
  const pod = memoryPod({
    [work]: [node('urn:a', 'Buy milk', false, T0)],
    [personal]: [node('urn:b', 'Call Ann', false, T0)],
  });
  const { row } = await overview(pod);
  pod.control.status = 202;
  await act(async () => {
    expect(await row('urn:a').update({ bought: true })).toMatchObject({
      kind: 'unconfirmed',
    });
  });
  expect(row('urn:a').notice.outcome?.kind).toBe('unconfirmed');
  expect(row('urn:a').timestamps).toEqual({ created: null, modified: T0 });
});
