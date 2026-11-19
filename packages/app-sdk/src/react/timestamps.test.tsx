// @vitest-environment jsdom
/**
 * Opt-in timestamps through the standard hooks (#367): creation, a row's
 * quick update and an editor save stamp them; a definition that differs only
 * in its timestamps is a structure of its own.
 */
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fields,
  flag,
  text,
  timestampsOf,
  type ResourceEditor as Editor,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import { fixture, resourceIri } from '../runtime/fixture.test.js';
import {
  SempodsProvider,
  TargetScreen,
  useCreation,
  useFieldUpdate,
  useList,
  useResourceEditor,
} from './index.js';

const CREATED = 'https://schema.org/dateCreated';
const MODIFIED = 'https://schema.org/dateModified';
const DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const T0 = '2026-11-01T08:00:00+01:00';
const T1 = '2026-11-17T09:00:00.000Z';
const instant = (value: string) => [{ '@value': value, '@type': DT }];

const cleanups: (() => void)[] = [];
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
  cleanups.splice(0).forEach((f) => f());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type Item = { readonly name: string; readonly bought: boolean };
/** Written inline on purpose: a fresh but equal definition on every call. */
const inline = (stamped: boolean) =>
  fields(
    {
      name: text('urn:name', { language: null }),
      bought: flag('urn:bought', { on: 'urn:yes', off: 'urn:no' }),
    },
    {
      type: 'urn:Item',
      ...(stamped
        ? { timestamps: { created: CREATED, modified: MODIFIED } }
        : {}),
    },
  );

it('stamps creation, a row update and an editor save, and keys definitions by their timestamps', async () => {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  const rows = new Map<string, JsonLd>([
    [
      'urn:one',
      {
        '@id': 'urn:one',
        '@type': ['urn:Item'],
        'urn:name': [{ '@value': 'Milk' }],
        'urn:bought': [{ '@id': 'urn:no' }],
        [CREATED]: instant(T0),
        [MODIFIED]: instant(T0),
      },
    ],
  ]);
  const writes: { method: string; body: JsonLd }[] = [];
  let version = 1;
  f.setQuery(async () => Response.json([...rows.values()]));
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: `"v${version}"` } })
        : new Response(null, { status: 404 });
    const body = JSON.parse(String(init?.body)) as JsonLd;
    writes.push({ method, body });
    const before = rows.get(iri) ?? {};
    const next: Record<string, unknown> = { ...before, ...body };
    for (const [key, value] of Object.entries(body))
      if (value === null) delete next[key];
    rows.set(iri, next);
    version++;
    return new Response(null, { status: method === 'PUT' ? 201 : 204 });
  });

  let api!: {
    plain: ReturnType<typeof useList<Item>>;
    list: ReturnType<typeof useList<Item>>;
    update: ReturnType<typeof useFieldUpdate<Item>>;
    creation: ReturnType<typeof useCreation<Item>>;
    editor: Editor<Item, Partial<Item>> | null;
  };
  function Screen() {
    const [initial] = useState({ name: '', bought: false });
    // The same fields without timestamps registered first: a different
    // structure, never the instance the stamped hooks use.
    const plain = useList(inline(false));
    const list = useList(inline(true));
    const update = useFieldUpdate(inline(true));
    const creation = useCreation(inline(true), {
      initial,
      collection: 'items',
    });
    const editor = useResourceEditor('urn:one', inline(true));
    api = { plain, list, update, creation, editor };
    return null;
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => {
    expect(api.plain.state.kind).toBe('ready');
    expect(api.list.state.kind).toBe('ready');
    expect(api.editor?.state.phase).toBe('ready');
  });
  const row = () => api.list.data!.items.find((i) => i.iri === 'urn:one')!;
  expect(timestampsOf(row())).toEqual({ created: T0, modified: T0 });
  // A row of the plain list belongs to another definition.
  let refused: unknown;
  await act(async () => {
    refused = await api.update
      .for(api.plain.data!.items[0]!)
      .update({ bought: true })
      .catch((error: unknown) => error);
  });
  expect(refused).toMatchObject({ kind: 'not-saved', reason: 'failure' });

  await act(async () => {
    expect(await api.update.for(row()).update({ bought: true })).toEqual({
      kind: 'saved',
      modified: T1,
    });
  });
  // The plain row's update was refused: only the stamped one was sent.
  expect(writes).toEqual([
    {
      method: 'PATCH',
      body: { 'urn:bought': [{ '@id': 'urn:yes' }], [MODIFIED]: instant(T1) },
    },
  ]);

  await act(async () => {
    await api.editor!.refresh();
  });
  act(() => api.editor!.change({ name: 'Oat milk' }));
  await act(async () => {
    expect(await api.editor!.save()).toMatchObject({ kind: 'saved' });
  });
  expect(writes.at(-1)).toEqual({
    method: 'PATCH',
    body: { 'urn:name': [{ '@value': 'Oat milk' }], [MODIFIED]: instant(T1) },
  });

  act(() => api.creation.change({ name: 'Bread' }));
  let created: unknown;
  await act(async () => {
    created = await api.creation.create();
  });
  expect(created).toMatchObject({ kind: 'created' });
  expect(writes.at(-1)).toMatchObject({
    method: 'PUT',
    body: {
      '@type': ['urn:Item'],
      'urn:name': [{ '@value': 'Bread' }],
      [CREATED]: instant(T1),
      [MODIFIED]: instant(T1),
    },
  });
  expect(rows.get('urn:one')![CREATED]).toEqual(instant(T0));
});
