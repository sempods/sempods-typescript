// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { useLayoutEffect, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fields,
  flag,
  text,
  type ResourceEditor as Editor,
} from '@sempods/client-sdk/edit';
import type { JsonLd, PodFetch } from '@sempods/client-sdk';
import { fixture } from '../runtime/fixture.test.js';
import {
  SempodsProvider,
  TargetScreen,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
  useLoad,
  useResourceEditor,
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
  cleanups.splice(0).forEach((f) => f());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
type Task = { readonly title: string; readonly done: boolean };
/** Written inline on purpose: a fresh but equal definition on every call. */
const inline = (language: string | null = null) =>
  fields(
    {
      title: text('urn:title', { language }),
      done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
    },
    { type: 'urn:Task' },
  );
async function setup() {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  const rows = new Map<string, JsonLd>([
    [
      'urn:one',
      {
        '@id': 'urn:one',
        '@type': ['urn:Task'],
        'urn:title': [{ '@value': 'One' }],
        'urn:status': [{ '@id': 'urn:open' }],
      },
    ],
  ]);
  const resource: PodFetch = async (url, init) => {
    const iri = Buffer.from(
      new URL(url).pathname.split('/').at(-1)!,
      'base64url',
    ).toString();
    if ((init?.method ?? 'GET') === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  };
  f.setResource(resource);
  f.setQuery(async () => Response.json([...rows.values()]));
  return { ...f, ...session, rows, resource };
}
const count = (f: Awaited<ReturnType<typeof setup>>, part: string) =>
  f.fetch.mock.calls.filter(([url]) => url.includes(part)).length;

it('useApp exposes only the guarded actions, as one stable object', async () => {
  const f = await setup();
  const seen: ReturnType<typeof useApp>[] = [];
  let rerender!: () => void;
  function Probe() {
    const [, set] = useState(0);
    rerender = () => set((n) => n + 1);
    seen.push(useApp());
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <Probe />
    </SempodsProvider>,
  );
  act(() => rerender());
  expect(seen.at(-1)).toBe(seen[0]);
  expect(Object.isFrozen(seen[0])).toBe(true);
  expect(Object.keys(seen[0]!).sort()).toEqual([
    'authorize',
    'connect',
    'disconnect',
    'navigate',
    'refreshContexts',
    'selectConnection',
    'selectContext',
  ]);
  const before = count(f, '/_system/contexts');
  await act(async () => {
    await seen[0]!.refreshContexts(f.id);
  });
  expect(count(f, '/_system/contexts')).toBe(before + 1);
});

it('inline fields() and read functions neither loop nor drop drafts', async () => {
  const f = await setup();
  let api!: {
    list: ReturnType<typeof useList<Task>>;
    custom: ReturnType<typeof useLoad<number>>;
    editor: Editor<Task, Partial<Task>> | null;
    creation: ReturnType<typeof useCreation<Task>>;
    rerender: () => void;
  };
  function Screen() {
    const [, set] = useState(0);
    const list = useList(inline());
    // An inline read function: a new identity on every render.
    const custom = useLoad(async (view) => {
      const r = await view.sparql.construct('CONSTRUCT {} WHERE {}');
      return r.kind === 'ok' ? { kind: 'ok', body: r.body.length } : r;
    });
    const editor = useResourceEditor('urn:one', inline());
    const creation = useCreation(inline(), {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    api = {
      list,
      custom,
      editor,
      creation,
      rerender: () => set((n) => n + 1),
    };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => {
    expect(api.list.state.kind).toBe('ready');
    expect(api.custom.state.kind).toBe('ready');
    expect(api.editor?.state.phase).toBe('ready');
  });
  const editor = api.editor;
  const queries = count(f, '/_system/sparql/query');
  const reads = count(f, '/_system/resources/');
  act(() => {
    editor!.change({ title: 'Mine' });
    api.creation.change({ title: 'Draft' });
  });
  for (let i = 0; i < 5; i++) act(() => api.rerender());
  await new Promise((r) => setTimeout(r, 20));
  expect(api.editor).toBe(editor);
  expect(api.editor?.state.draft).toEqual({ title: 'Mine', done: false });
  expect(api.creation.draft.title).toBe('Draft');
  expect(count(f, '/_system/sparql/query')).toBe(queries);
  expect(count(f, '/_system/resources/')).toBe(reads);
});

it('a real definition change still recreates the editor and reloads the list', async () => {
  const f = await setup();
  let api!: {
    list: ReturnType<typeof useList<Task>>;
    editor: Editor<Task, Partial<Task>> | null;
    setLanguage: (language: string | null) => void;
  };
  function Screen() {
    const [language, setLanguage] = useState<string | null>(null);
    const list = useList(inline(language));
    const editor = useResourceEditor('urn:one', inline(language));
    api = { list, editor, setLanguage };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.editor?.state.phase).toBe('ready'));
  const editor = api.editor;
  const queries = count(f, '/_system/sparql/query');
  act(() => api.setLanguage('de'));
  await waitFor(() => expect(api.editor).not.toBe(editor));
  await waitFor(() =>
    expect(count(f, '/_system/sparql/query')).toBe(queries + 1),
  );
});

it('an inline custom definition never loops, keeps its editor and warns once', async () => {
  const f = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const base = inline();
  let api!: {
    editor: Editor<Task> | null;
    rerender: () => void;
  };
  function Screen() {
    const [, set] = useState(0);
    // A copied definition is not a fields() definition: a new identity each render.
    const editor = useResourceEditor<Task>('urn:one', { ...base });
    api = { editor, rerender: () => set((n) => n + 1) };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.editor?.state.phase).toBe('ready'));
  const editor = api.editor;
  const reads = count(f, '/_system/resources/');
  act(() => editor!.change({ title: 'Mine', done: false }));
  for (let i = 0; i < 5; i++) act(() => api.rerender());
  await new Promise((r) => setTimeout(r, 20));
  expect(api.editor).toBe(editor);
  expect(api.editor?.state.draft).toEqual({ title: 'Mine', done: false });
  expect(count(f, '/_system/resources/')).toBe(reads);
  expect(
    warn.mock.calls.filter(([m]) => String(m).includes('changed identity')),
  ).toHaveLength(1);
});

it('warns when a real field change drops a pending write or an unsaved draft (N3)', async () => {
  const f = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let release!: (response: Response) => void;
  const gate = new Promise<Response>((r) => (release = r));
  f.setResource(async (url, init) =>
    (init?.method ?? 'GET') === 'GET' ? f.resource(url, init) : gate,
  );
  let api!: {
    update: ReturnType<typeof useFieldUpdate<Task>>;
    editor: Editor<Task, Partial<Task>> | null;
    list: ReturnType<typeof useList<Task>>;
    setLanguage: (language: string | null) => void;
  };
  function Screen() {
    const [language, setLanguage] = useState<string | null>(null);
    const update = useFieldUpdate(inline(language));
    const editor = useResourceEditor('urn:one', inline(language));
    const list = useList(inline());
    api = { update, editor, list, setLanguage };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => {
    expect(api.list.state.kind).toBe('ready');
    expect(api.editor?.state.phase).toBe('ready');
  });
  const state = api.list.state;
  if (state.kind !== 'ready') throw new Error('fixture');
  act(() => {
    void api.update.update(state.data.items[0]!, { done: true });
    api.editor!.change({ title: 'Unsaved' });
  });
  act(() => api.setLanguage('de'));
  await waitFor(() => {
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('while a write was pending or unresolved'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'its unsaved draft, pending write or open review',
      ),
    );
  });
  release(new Response(null, { status: 204 }));
});

it('R1: an inline definition shared by useList and useFieldUpdate updates and removes rows', async () => {
  const f = await setup();
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push(method);
    return f.resource(url, init);
  });
  let api!: {
    list: ReturnType<typeof useList<Task>>;
    update: ReturnType<typeof useFieldUpdate<Task>>;
    rerender: () => void;
  };
  function Screen() {
    const [, set] = useState(0);
    // One inline definition per render, shared by the list and its actions.
    const definition = inline();
    const list = useList(definition);
    const update = useFieldUpdate(definition);
    api = { list, update, rerender: () => set((n) => n + 1) };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => {
    expect(api.list.state.kind).toBe('ready');
    expect(api.update.canMutate).toBe(true);
  });
  act(() => api.rerender());
  const ready = () => {
    const state = api.list.state;
    if (state.kind !== 'ready') throw new Error('fixture');
    return state.data.items[0]!;
  };
  let outcome: unknown;
  await act(async () => {
    outcome = await api.update.update(ready(), { done: true });
  });
  expect(outcome).toMatchObject({ kind: 'saved' });
  await waitFor(() => expect(api.list.state.kind).toBe('ready'));
  act(() => api.rerender());
  await act(async () => {
    outcome = await api.update.remove(ready());
  });
  expect(outcome).toMatchObject({ kind: 'removed' });
  expect(writes).toEqual(['PATCH', 'DELETE']);
});

it('R2: warns when a real field change replaces an editor with a pending removal', async () => {
  const f = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let release!: (response: Response) => void;
  const gate = new Promise<Response>((r) => (release = r));
  f.setResource(async (url, init) =>
    (init?.method ?? 'GET') === 'DELETE' ? gate : f.resource(url, init),
  );
  let api!: {
    editor: Editor<Task, Partial<Task>> | null;
    setLanguage: (language: string | null) => void;
  };
  function Screen() {
    const [language, setLanguage] = useState<string | null>(null);
    const editor = useResourceEditor('urn:one', inline(language));
    api = { editor, setLanguage };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.editor?.state.phase).toBe('ready'));
  const removing = api.editor!.remove();
  await waitFor(() => expect(api.editor?.state.phase).toBe('saving'));
  expect(api.editor?.state.dirty).toBe(false);
  act(() => api.setLanguage('de'));
  await waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('pending write or open review was discarded'),
    ),
  );
  release(new Response(null, { status: 204 }));
  await removing;
});

it('R3: warns when a real field change resets an unsaved creation draft', async () => {
  const f = await setup();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  let api!: {
    creation: ReturnType<typeof useCreation<Task>>;
    setLanguage: (language: string | null) => void;
  };
  function Screen() {
    const [language, setLanguage] = useState<string | null>(null);
    const creation = useCreation(inline(language), {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    api = { creation, setLanguage };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.creation.canEdit).toBe(true));
  act(() => api.creation.change({ title: 'Unsaved input' }));
  act(() => api.setLanguage('de'));
  expect(api.creation.draft.title).toBe('');
  expect(warn).toHaveBeenCalledWith(
    expect.stringContaining('unsaved creation draft was reset'),
  );
});

it('R4: a real definition change never offers the previous rows to the new updater', async () => {
  const f = await setup();
  // A German title too, so the row is valid under the changed definition.
  f.rows.set('urn:one', {
    ...f.rows.get('urn:one')!,
    'urn:title': [{ '@value': 'One' }, { '@value': 'Eins', '@language': 'de' }],
  });
  const commits: { language: string | null; kind: string }[] = [];
  let api!: {
    list: ReturnType<typeof useList<Task>>;
    update: ReturnType<typeof useFieldUpdate<Task>>;
    setLanguage: (language: string | null) => void;
  };
  function Screen() {
    const [language, setLanguage] = useState<string | null>(null);
    const definition = inline(language);
    const list = useList(definition);
    const update = useFieldUpdate(definition);
    // What each committed render offers, before any effect can reload.
    useLayoutEffect(() => {
      commits.push({ language, kind: list.state.kind });
    });
    api = { list, update, setLanguage };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.list.state.kind).toBe('ready'));
  const before = commits.length;
  act(() => api.setLanguage('de'));
  // The first commit with the new definition must not offer old snapshots.
  expect(commits[before]).toEqual({ language: 'de', kind: 'loading' });
  await waitFor(() => expect(api.list.state.kind).toBe('ready'));
  const state = api.list.state;
  if (state.kind !== 'ready') throw new Error('fixture');
  let outcome: unknown;
  await act(async () => {
    outcome = await api.update.update(state.data.items[0]!, { done: true });
  });
  expect(outcome).toMatchObject({ kind: 'saved' });
});

it('R5: the same fields in another order keep the editor and both drafts', async () => {
  const f = await setup();
  const title = text('urn:title', { language: null });
  const done = flag('urn:status', { on: 'urn:done', off: 'urn:open' });
  const ordered = (reversed: boolean) =>
    reversed
      ? fields({ done, title }, { type: 'urn:Task' })
      : fields({ title, done }, { type: 'urn:Task' });
  let api!: {
    editor: Editor<Task, Partial<Task>> | null;
    creation: ReturnType<typeof useCreation<Task>>;
    setReversed: (reversed: boolean) => void;
  };
  function Screen() {
    const [reversed, setReversed] = useState(false);
    const editor = useResourceEditor('urn:one', ordered(reversed));
    const creation = useCreation(ordered(reversed), {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    api = { editor, creation, setReversed };
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <Screen />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.editor?.state.phase).toBe('ready'));
  const editor = api.editor;
  act(() => {
    editor!.change({ title: 'Unsaved edit' });
    api.creation.change({ title: 'Unsaved creation' });
  });
  act(() => api.setReversed(true));
  await new Promise((r) => setTimeout(r, 20));
  expect(api.editor).toBe(editor);
  expect(api.editor?.state.draft?.title).toBe('Unsaved edit');
  expect(api.creation.draft.title).toBe('Unsaved creation');
});
