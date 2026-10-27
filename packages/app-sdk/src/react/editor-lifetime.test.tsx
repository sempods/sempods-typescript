// @vitest-environment jsdom
/**
 * A resource editor across hiding and remounting (follow-up of #156). React
 * 19.2 `<Activity mode="hidden">` cleans up effects but keeps state; the
 * editor's draft, its pending write and its leave guard should follow its
 * target, not its component.
 */
import { webcrypto } from 'node:crypto';
import { Activity, useState } from 'react';
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

async function setup() {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  let version = 1;
  const one = (): JsonLd => ({
    '@id': 'urn:one',
    '@type': ['urn:Task'],
    'urn:title': [{ '@value': 'One' }],
    'urn:status': [{ '@id': 'urn:open' }],
  });
  let answer: () => Promise<Response> | Response = () =>
    new Response(null, { status: 204 });
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET')
      return resourceIri(url) === 'urn:one'
        ? Response.json(one(), { headers: { etag: `"v${version}"` } })
        : new Response(null, { status: 404 });
    writes.push(init?.method ?? '');
    const response = await answer();
    if (response.status === 204) version++;
    return response;
  });
  const api = {} as {
    editor: ResourceEditor<
      { readonly title: string; readonly done: boolean },
      Partial<{ readonly title: string; readonly done: boolean }>
    > | null;
    app: ReturnType<typeof useApp>;
    hide: (hidden: boolean) => void;
    mount: (mounted: boolean) => void;
  };
  function Screen() {
    api.editor = useResourceEditor('urn:one', definition);
    return null;
  }
  function Host() {
    const [hidden, hide] = useState(false);
    const [mounted, mount] = useState(true);
    api.app = useApp();
    api.hide = hide;
    api.mount = mount;
    return (
      <Activity mode={hidden ? 'hidden' : 'visible'}>
        {mounted && <Screen />}
      </Activity>
    );
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Host />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.editor?.state.phase).toBe('ready'));
  return {
    ...f,
    api,
    writes,
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}

it('keeps a draft across hiding and asks about it while hidden', async () => {
  const s = await setup();
  act(() => s.api.editor!.change({ title: 'Changed' }));
  const before = s.api.editor;
  act(() => s.api.hide(true));
  // Hidden, the draft still guards a change.
  let moved!: Promise<boolean>;
  act(() => {
    moved = s.api.app.navigate(() => {});
  });
  await waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
  );
  act(() => {
    (
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (b) => b.textContent === 'Keep editing',
      ) as HTMLButtonElement
    ).click();
  });
  expect(await moved).toBe(false);
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.editor?.state.draft?.title).toBe('Changed'));
  expect(s.api.editor).toBe(before);
});

it('a save pending while hidden blocks navigation and shows its outcome on reveal', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  act(() => s.api.editor!.change({ title: 'Changed' }));
  let saved!: Promise<unknown>;
  act(() => {
    saved = s.api.editor!.save();
  });
  await waitFor(() => expect(s.api.editor?.state.phase).toBe('saving'));
  act(() => s.api.hide(true));
  expect(await s.api.app.navigate(() => {})).toBe(false);
  await act(async () => held.resolve(new Response(null, { status: 202 })));
  expect(await saved).toMatchObject({ kind: 'review' });
  act(() => s.api.hide(false));
  await waitFor(() =>
    expect(s.api.editor?.state.review?.kind).toBe('unconfirmed'),
  );
  expect(s.writes).toHaveLength(1);
});

it('an unconfirmed save survives unmounting and remounting its screen', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.editor!.change({ title: 'Changed' }));
  await act(async () => {
    await s.api.editor!.save();
  });
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  await waitFor(() =>
    expect(s.api.editor?.state.review?.kind).toBe('unconfirmed'),
  );
  expect(s.api.editor?.state.draft?.title).toBe('Changed');
  expect(s.writes).toHaveLength(1);
});

it('a clean editor shown again is the same one, with its data', async () => {
  const s = await setup();
  const before = s.api.editor;
  act(() => s.api.hide(true));
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.editor?.state.phase).toBe('ready'));
  expect(s.api.editor?.state.draft?.title).toBe('One');
  // The same editor: shown again, it does not read afresh.
  expect(s.api.editor).toBe(before);
});
