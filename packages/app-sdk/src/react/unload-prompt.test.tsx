// @vitest-environment jsdom
/**
 * The browser's leave prompt (#201) follows the same guards as the SDK's
 * guarded navigation: resource editors, row writes and `useDraftGuard`.
 */
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import {
  fields,
  flag,
  text,
  type ResourceEditor,
} from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  SempodsProvider,
  TargetScreen,
  useApp,
  useDraftGuard,
  useFieldUpdate,
  useList,
  useResourceEditor,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { deferred, fixture, resourceIri } from '../runtime/fixture.test.js';

const definition = fields(
  {
    title: text('urn:title', { language: null }),
    done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
  },
  { type: 'urn:Task' },
);
type Task = { readonly title: string; readonly done: boolean };
const task = (iri: string): JsonLd => ({
  '@id': iri,
  '@type': ['urn:Task'],
  'urn:title': [{ '@value': iri }],
  'urn:status': [{ '@id': 'urn:open' }],
});
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

/** Counts the `beforeunload` listeners added to `window` and not removed. */
function watchUnload() {
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');
  const of = (spy: typeof add | typeof remove) =>
    spy.mock.calls.filter(([type]) => type === 'beforeunload').length;
  return {
    added: () => of(add),
    listeners: () => of(add) - of(remove),
    asks() {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    },
  };
}

async function setup(unloadPrompt?: boolean) {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  let answer: () => Promise<Response> | Response = () =>
    new Response(null, { status: 204 });
  // The Pod keeps what a confirmed write sent.
  const stored = new Map(['urn:one', 'urn:two'].map((iri) => [iri, task(iri)]));
  let version = 1;
  f.setQuery(async () => Response.json([...stored.values()]));
  f.setResource(async (url, init) => {
    const iri = resourceIri(url);
    if ((init?.method ?? 'GET') === 'GET')
      return Response.json(stored.get(iri), {
        headers: { etag: `"v${version}"` },
      });
    const response = await answer();
    if (response.status === 204) {
      version++;
      stored.set(iri, {
        ...stored.get(iri),
        ...(JSON.parse(String(init?.body)) as JsonLd),
      });
    }
    return response;
  });
  const unload = watchUnload();
  const api = {} as {
    one: ResourceEditor<Task, Partial<Task>> | null;
    two: ResourceEditor<Task, Partial<Task>> | null;
    rows: ReturnType<typeof useFieldUpdate<Task>>;
    list: ReturnType<typeof useList<Task>>;
    app: ReturnType<typeof useApp>;
    mount: (mounted: boolean) => void;
    draft: (dirty: boolean) => void;
  };
  function Editors() {
    api.one = useResourceEditor('urn:one', definition);
    api.two = useResourceEditor('urn:two', definition);
    return null;
  }
  function Host() {
    const [mounted, mount] = useState(true);
    const [dirty, draft] = useState(false);
    useDraftGuard(dirty, () => draft(false));
    api.app = useApp();
    api.list = useList(definition);
    api.rows = useFieldUpdate(definition);
    api.mount = mount;
    api.draft = draft;
    return mounted ? <Editors /> : null;
  }
  const view = render(
    <SempodsProvider
      runtime={session.runtime}
      {...(unloadPrompt === undefined ? {} : { unloadPrompt })}
    >
      <TargetScreen>
        <Host />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => {
    expect(api.one?.state.phase).toBe('ready');
    expect(api.two?.state.phase).toBe('ready');
    expect(api.list.data?.items).toHaveLength(2);
  });
  return {
    api,
    unload,
    unmount: () => view.unmount(),
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}

it('asks while an editor is dirty and stops once it is saved', async () => {
  const s = await setup();
  expect(s.unload.listeners()).toBe(0);
  act(() => s.api.one!.change({ title: 'Changed' }));
  expect(s.unload.asks()).toBe(true);
  await act(async () => {
    expect(await s.api.one!.save()).toMatchObject({ kind: 'saved' });
  });
  expect(s.api.one!.state.dirty).toBe(false);
  expect(s.unload.listeners()).toBe(0);
  expect(s.unload.asks()).toBe(false);
});

it('shares one listener between two dirty editors until both are settled', async () => {
  const s = await setup();
  act(() => s.api.one!.change({ title: 'One changed' }));
  act(() => s.api.two!.change({ title: 'Two changed' }));
  expect(s.unload.added()).toBe(1);
  await act(async () => {
    await s.api.one!.save();
  });
  // The other draft is still unsaved.
  expect(s.unload.asks()).toBe(true);
  act(() => s.api.two!.discard());
  expect(s.unload.listeners()).toBe(0);
  expect(s.unload.added()).toBe(1);
});

it('keeps asking about a draft its unmounted screen left, until the provider goes', async () => {
  const s = await setup();
  act(() => s.api.one!.change({ title: 'Changed' }));
  act(() => s.api.mount(false));
  // The controller retains the draft for its subject: still unsaved.
  expect(s.unload.asks()).toBe(true);
  s.unmount();
  expect(s.unload.listeners()).toBe(0);
  expect(s.unload.asks()).toBe(false);
});

it('stops asking once a confirmed change discarded the draft', async () => {
  const s = await setup();
  act(() => s.api.one!.change({ title: 'Changed' }));
  let moved!: Promise<boolean>;
  act(() => {
    moved = s.api.app.navigate(() => {});
  });
  // Only the local editor guards are left by row navigation.
  await waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
  );
  expect(s.unload.asks()).toBe(true);
  act(() => {
    (
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (b) => b.textContent === 'Discard and continue',
      ) as HTMLButtonElement
    ).click();
  });
  expect(await moved).toBe(true);
  await waitFor(() => expect(s.unload.listeners()).toBe(0));
});

it('asks while a row write is pending and after it stays unconfirmed', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  const row = s.api.list.data!.items[0]!;
  let written!: Promise<unknown>;
  act(() => {
    written = s.api.rows.for(row).update({ done: true });
  });
  await waitFor(() => expect(s.unload.asks()).toBe(true));
  // Unconfirmed: the write may have landed, so leaving still asks.
  await act(async () => held.resolve(new Response(null, { status: 202 })));
  expect(await written).toMatchObject({ kind: 'unconfirmed' });
  expect(s.unload.asks()).toBe(true);
  expect(s.unload.added()).toBe(1);
});

it('follows an app draft registered with useDraftGuard', async () => {
  const s = await setup();
  act(() => s.api.draft(true));
  expect(s.unload.asks()).toBe(true);
  act(() => s.api.draft(false));
  expect(s.unload.listeners()).toBe(0);
});

it('never asks with unloadPrompt={false}', async () => {
  const s = await setup(false);
  act(() => s.api.one!.change({ title: 'Changed' }));
  act(() => s.api.draft(true));
  expect(s.unload.added()).toBe(0);
  expect(s.unload.asks()).toBe(false);
});
