// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import {
  act,
  cleanup,
  render,
  waitFor,
  screen,
  fireEvent,
} from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fields,
  flag,
  text,
  type EditDefinition,
  type ResourceEditor as Editor,
} from '@sempods/client-sdk/edit';
import { type JsonLd, type PodFetch } from '@sempods/client-sdk';
import {
  fixture,
  catalogue,
  deferred,
  work,
  personal,
} from '../runtime/fixture.test.js';
import {
  SempodsProvider,
  TargetScreen,
  ResourceEditor,
  UpdateNotice,
  useCreation,
  useFieldUpdate,
  useList,
  useResourceEditor,
  useSelection,
} from './index.js';
import { useController } from './app.js';
const definition = fields(
  {
    title: text('urn:title', { language: null }),
    done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
  },
  { type: 'urn:Task' },
);
type Task = { readonly title: string; readonly done: boolean };
const initial: Task = { title: '', done: false };
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
async function setup(
  language: 'en' | 'de' = 'en',
  // Holds the batch input above TargetScreen, so it survives target changes.
  { hostInput = false } = {},
) {
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
  const writes: { iri: string; method: string; body?: JsonLd }[] = [];
  let revision = 1;
  const resource: PodFetch = async (url, init) => {
    const iri = Buffer.from(
      new URL(url).pathname.split('/').at(-1)!,
      'base64url',
    ).toString();
    const method = init?.method ?? 'GET';
    if (method === 'GET')
      return rows.has(iri)
        ? Response.json(rows.get(iri), { headers: { etag: `"v${revision}"` } })
        : new Response(null, { status: 404 });
    const body = init?.body
      ? (JSON.parse(init.body as string) as JsonLd)
      : undefined;
    writes.push({ iri, method, ...(body ? { body } : {}) });
    revision++;
    if (method === 'DELETE') rows.delete(iri);
    else if (body) rows.set(iri, { ...rows.get(iri), ...body });
    return new Response(null, { status: method === 'PUT' ? 201 : 204 });
  };
  f.setResource(resource);
  f.setQuery(async () => Response.json([...rows.values()]));
  let api!: {
    creation: ReturnType<typeof useCreation<Task>>;
    mutation: ReturnType<typeof useFieldUpdate<Task>>;
    selection: ReturnType<typeof useSelection<string>>;
    list: ReturnType<typeof useList<Task>>;
    app: ReturnType<typeof useController>;
    editor: Editor<Task, Partial<Task>> | null;
    input: string;
    setInput: (input: string) => void;
    addAll: () => Promise<void>;
  };
  type Input = readonly [string, (input: string) => void];
  function Screen({ host }: { readonly host?: Input | undefined }) {
    const creation = useCreation(definition, {
      initial: { ...initial },
      collection: 'tasks',
    });
    const mutation = useFieldUpdate(definition);
    const selection = useSelection();
    const list = useList(definition);
    // Leave-dialog internals (confirm/cancel, snapshot) are not public API.
    const app = useController();
    const editor = useResourceEditor(selection.selected, definition);
    const local = useState('');
    const [input, setInput] = host ?? local;
    // The guide's pattern for several resources from one input
    // (docs/react-authoring.md); keep both in step.
    async function addAll() {
      // Settle a pending, uncertain or stopped item in the draft first.
      if (!creation.canEdit || creation.draft.title !== '') return;
      const names = input
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      for (const [index, name] of names.entries()) {
        creation.change({ title: name });
        const outcome = await creation.create();
        if (outcome?.kind === 'created') continue;
        // Stop. This item is held in the draft or may already exist: it never
        // returns to the input. Only the unsent rest does.
        setInput(names.slice(index + 1).join(', '));
        return;
      }
      setInput('');
    }
    api = {
      creation,
      mutation,
      selection,
      list,
      app,
      editor,
      input,
      setInput,
      addAll,
    };
    return (
      <>
        <UpdateNotice {...creation.notice} />
        <UpdateNotice {...mutation.notice} />
      </>
    );
  }
  function Host() {
    const input = useState('');
    return (
      <TargetScreen>
        <Screen host={hostInput ? input : undefined} />
      </TargetScreen>
    );
  }
  render(
    <SempodsProvider runtime={session.runtime} language={language}>
      <Host />
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.list.state.kind).toBe('ready'));
  return {
    ...f,
    ...session,
    rows,
    writes,
    resource,
    get api() {
      return api;
    },
  };
}
it('locks the captured creation before rerender, saves typed data and refreshes lists automatically', async () => {
  const f = await setup();
  const gate = deferred<Response>();
  f.setResource(async (url, init) => {
    if (init?.method === 'PUT') {
      await f.resource(url, init);
      return gate.promise;
    }
    return f.resource(url, init);
  });
  act(() => f.api.creation.change({ title: 'Created' }));
  let first!: ReturnType<typeof f.api.creation.create>;
  act(() => {
    const captured = f.api.creation;
    first = captured.create();
    void captured.create();
    captured.change({ title: 'Must not replace pending command' });
  });
  await waitFor(() => expect(f.writes).toHaveLength(1));
  expect(f.api.creation.canEdit).toBe(false);
  expect(f.api.creation.draft.title).toBe('Created');
  expect(f.writes[0]?.iri).toMatch(/\/tasks\/[\w-]+$/);
  expect(f.writes[0]?.body).toMatchObject({
    '@type': ['urn:Task'],
    'urn:title': [{ '@value': 'Created' }],
  });
  await act(async () => {
    gate.resolve(new Response(null, { status: 201 }));
    await first;
  });
  await waitFor(() =>
    expect(f.api.list.state).toMatchObject({
      kind: 'ready',
      data: {
        items: expect.arrayContaining([
          expect.objectContaining({ data: { title: 'Created', done: false } }),
        ]),
      },
    }),
  );
  expect(f.api.creation.draft).toEqual(initial);
  act(() => f.api.creation.change({ title: 'Another draft' }));
  expect(f.api.creation.outcome).toBeNull();
});
it('checks the exact uncertain creation without replay, requires checking before consuming its draft', async () => {
  const f = await setup();
  f.setResource(async (url, init) => {
    const result = await f.resource(url, init);
    return init?.method === 'PUT'
      ? new Response(null, { status: 202 })
      : result;
  });
  act(() => f.api.creation.change({ title: 'Maybe' }));
  await act(async () => {
    await f.api.creation.create();
  });
  expect(f.api.creation.canCreate).toBe(false);
  act(() => {
    f.api.creation.change({ title: 'Lost' });
    f.api.creation.notice.onAcknowledge();
  });
  expect(f.api.creation.draft.title).toBe('Maybe');
  await act(async () => {
    expect(await f.api.creation.notice.onCheck()).toBe(true);
  });
  expect(f.api.creation.outcome?.kind).toBe('unconfirmed');
  act(() => f.api.creation.notice.onAcknowledge());
  expect(f.api.creation.draft).toEqual(initial);
  expect(f.writes).toHaveLength(1);
});
it('row conflict blocks its lane and acknowledgement preserves an unrelated creation draft', async () => {
  const f = await setup();
  const state = f.api.list.state;
  if (state.kind !== 'ready') throw new Error('fixture');
  const item = state.data.items[0]!;
  f.rows.set(item.iri, {
    ...f.rows.get(item.iri),
    'urn:status': [{ '@id': 'urn:done' }],
  });
  act(() => f.api.creation.change({ title: 'Keep draft' }));
  await act(async () => {
    await f.api.mutation.update(item, { done: true });
  });
  expect(f.api.mutation.outcome?.kind).toBe('changed-on-pod');
  expect(f.api.mutation.canMutate).toBe(false);
  await act(async () => {
    expect(await f.api.mutation.notice.onCheck()).toBe(true);
  });
  act(() => f.api.mutation.notice.onAcknowledge());
  expect(f.api.creation.draft.title).toBe('Keep draft');
  expect(f.api.mutation.canMutate).toBe(true);
  expect(f.writes).toHaveLength(0);
});
it('guards selection and target changes, preserving drafts on cancellation and resetting A-B-A', async () => {
  const f = await setup();
  await act(async () => {
    await f.api.selection.select('urn:one');
  });
  await waitFor(() => expect(f.api.editor?.state.phase).toBe('ready'));
  act(() => f.api.editor!.change({ title: 'Unsaved' }));
  await act(async () => {
    expect(await f.api.selection.select('urn:one')).toBe(true);
  });
  expect(f.api.app.getSnapshot().confirmingLeave).toBe(false);
  expect(f.api.editor?.state.draft?.title).toBe('Unsaved');
  let moving!: Promise<boolean>;
  act(() => {
    moving = f.api.selection.select(null);
  });
  expect(f.api.app.getSnapshot().confirmingLeave).toBe(true);
  act(() => f.api.app.cancelLeave());
  expect(await moving).toBe(false);
  expect(f.api.editor?.state.draft?.title).toBe('Unsaved');
  act(() => f.api.creation.change({ title: 'New draft' }));
  act(() => {
    moving = f.api.app.selectContext(personal);
  });
  await act(async () => {
    await f.api.app.confirmLeave();
    await moving;
  });
  await waitFor(() => expect(f.api.creation.draft).toEqual(initial));
  await act(async () => {
    await f.api.app.selectContext(work);
  });
  expect(f.api.selection.selected).toBeNull();
  expect(f.api.creation.draft).toEqual(initial);
});
it('write loss disables mutations, retains drafts, and late old-target completion cannot clear a new draft', async () => {
  const f = await setup();
  act(() => f.api.creation.change({ title: 'Before' }));
  f.setCatalogue(async () => catalogue([work, personal], []));
  await act(() => f.runtime.loadContexts(f.id));
  expect(f.api.creation.canCreate).toBe(false);
  expect(f.api.mutation.canMutate).toBe(false);
  expect(f.api.creation.draft.title).toBe('Before');
  f.setCatalogue(async () => catalogue([work, personal], [work, personal]));
  await act(() => f.runtime.loadContexts(f.id));
  const gate = deferred<Response>();
  f.setResource(() => gate.promise);
  let pending!: ReturnType<typeof f.api.creation.create>;
  act(() => {
    pending = f.api.creation.create();
  });
  await act(async () => {
    f.runtime.selectContext(f.id, personal);
  });
  act(() => f.api.creation.change({ title: 'New target' }));
  await act(async () => {
    gate.resolve(new Response(null, { status: 201 }));
    await pending;
  });
  expect(f.api.creation.draft.title).toBe('New target');
  expect(f.api.creation.outcome).toBeNull();
});
it('editor saves and deletes refresh lists, while cancelled lists stay cancelled', async () => {
  const f = await setup();
  await act(async () => {
    await f.api.selection.select('urn:one');
  });
  await waitFor(() => expect(f.api.editor?.state.phase).toBe('ready'));
  act(() => f.api.editor!.change({ title: 'Renamed' }));
  await act(async () => {
    await f.api.editor!.save();
  });
  await waitFor(() =>
    expect(f.api.list.state).toMatchObject({
      kind: 'ready',
      data: { items: [{ data: { title: 'Renamed' } }] },
    }),
  );
  await act(async () => {
    await f.api.editor!.remove();
  });
  await waitFor(() =>
    expect(f.api.list.state).toMatchObject({
      kind: 'ready',
      data: { items: [] },
    }),
  );
  act(() => {
    f.api.list.cancel();
    f.api.creation.change({ title: 'Next' });
  });
  await act(async () => {
    await f.api.creation.create();
  });
  expect(f.api.list.state.kind).toBe('cancelled');
});
it('keeps arbitrary definition and copied-definition changes complete through hooks and ResourceEditor children', () => {
  type Variant = { kind: 'a'; a: string } | { kind: 'b'; b: string };
  const variant: EditDefinition<Variant> = {
    read: () => ({ kind: 'a', a: '' }),
    patch: () => ({}),
  };
  function TypeProbe() {
    const original = useResourceEditor('urn:one', definition);
    original?.change({ title: 'Partial' });
    const copied = useResourceEditor('urn:one', { ...definition });
    // @ts-expect-error Copies require complete drafts, matching the portable editor.
    copied?.change({ title: 'Incomplete' });
    const arbitrary = useResourceEditor('urn:one', variant);
    // @ts-expect-error A discriminant alone is not a complete variant.
    arbitrary?.change({ kind: 'b' });
    return (
      <>
        <ResourceEditor editor={original}>
          {(_draft, change) => {
            change({ title: 'Partial' });
            return null;
          }}
        </ResourceEditor>
        <ResourceEditor editor={arbitrary}>
          {(_draft, change) => {
            // @ts-expect-error The render prop preserves the complete-draft contract too.
            change({ kind: 'b' });
            return null;
          }}
        </ResourceEditor>
      </>
    );
  }
  void TypeProbe;
});

it('a late comparison cannot authorize acknowledgement of a newer uncertain mutation', async () => {
  const f = await setup();
  const state = f.api.list.state;
  if (state.kind !== 'ready') throw new Error('fixture');
  const item = state.data.items[0]!;
  const uncertain: PodFetch = async (url, init) =>
    init?.method === 'DELETE'
      ? new Response(null, { status: 202 })
      : f.resource(url, init);
  f.setResource(uncertain);
  await act(async () => {
    await f.api.mutation.remove(item);
  });
  const gate = deferred<Response>();
  f.setResource(() => gate.promise);
  let comparing!: Promise<boolean>;
  act(() => {
    comparing = f.api.mutation.notice.onCheck();
  });
  act(() => f.api.mutation.acknowledge());
  f.setResource(uncertain);
  await act(async () => {
    await f.api.mutation.remove(item);
  });
  await act(async () => {
    gate.resolve(
      Response.json(f.rows.get(item.iri), { headers: { etag: '"v1"' } }),
    );
    expect(await comparing).toBe(false);
  });
  act(() => f.api.mutation.notice.onAcknowledge());
  expect(f.api.mutation.outcome?.kind).toBe('unconfirmed');
  expect(f.api.mutation.canMutate).toBe(false);
});

it.each([
  { present: true, language: 'en' as const },
  { present: false, language: 'en' as const },
  { present: false, language: 'de' as const },
])(
  'R1: shows exact-subject evidence ($present/$language) before acknowledgement even if list reload fails',
  async ({ present, language }) => {
    const f = await setup(language);
    f.setResource(async (url, init) => {
      if (init?.method === 'PUT') {
        if (present) await f.resource(url, init);
        return new Response(null, { status: 202 });
      }
      return f.resource(url, init);
    });
    act(() => f.api.creation.change({ title: 'Unconfirmed task' }));
    await act(async () => {
      await f.api.creation.create();
    });
    f.setQuery(async () => new Response(null, { status: 500 }));
    const acknowledge = screen.getByText(
      language === 'en' ? 'I have checked the pod' : 'Ich habe den Pod geprüft',
    ) as HTMLButtonElement;
    expect(acknowledge.disabled).toBe(true);
    fireEvent.click(
      screen.getByText(
        language === 'en' ? 'Check current version' : 'Aktuellen Stand prüfen',
      ),
    );
    await waitFor(() => expect(acknowledge.disabled).toBe(false));
    const evidence = screen.getByRole('region', {
      name: language === 'en' ? 'Current on the pod' : 'Aktuell auf dem Pod',
    });
    expect(evidence.textContent).toContain(
      present
        ? 'Unconfirmed task'
        : language === 'en'
          ? 'not currently present'
          : 'nicht auf dem Pod vorhanden',
    );
    await waitFor(() => expect(f.api.list.state.kind).toBe('failed'));
    expect(f.api.creation.outcome?.kind).toBe('unconfirmed');
    fireEvent.click(acknowledge);
    expect(f.api.creation.draft).toEqual(
      present ? initial : { ...initial, title: 'Unconfirmed task' },
    );
    expect(f.api.creation.canEdit).toBe(present);
    expect(f.api.creation.canCreate).toBe(!present);
  },
);

it.each([false, true])(
  'C1: absence keeps the draft and explicit retries use the captured IRI/body (late original: %s)',
  async (lateOriginal) => {
    const f = await setup();
    const attempts: {
      url: string;
      init: NonNullable<Parameters<PodFetch>[1]>;
    }[] = [];
    f.setResource(async (url, init) => {
      if (init?.method !== 'PUT') return f.resource(url, init);
      attempts.push({ url, init });
      if (attempts.length === 1) return new Response(null, { status: 202 });
      const body = JSON.parse(init.body as string) as JsonLd;
      if (f.rows.has(body['@id'] as string))
        return new Response(null, { status: 412 });
      return f.resource(url, init);
    });
    act(() => f.api.creation.change({ title: 'Keep my task' }));
    await act(async () => {
      expect(await f.api.creation.create()).toMatchObject({
        kind: 'unconfirmed',
      });
    });
    await act(async () => {
      expect(await f.api.creation.notice.onCheck()).toBe(true);
    });
    expect(f.api.creation.notice.current).toBeNull();
    act(() => f.api.creation.notice.onAcknowledge());
    expect(f.api.creation.draft.title).toBe('Keep my task');
    expect(f.api.creation.canCreate).toBe(true);
    expect(f.api.creation.canEdit).toBe(false);
    expect(attempts).toHaveLength(1); // Checking/acknowledgement never replay.
    act(() => f.api.creation.change({ title: 'Different intent' }));
    expect(f.api.creation.draft.title).toBe('Keep my task');
    if (lateOriginal) await f.resource(attempts[0]!.url, attempts[0]!.init);
    await act(async () => {
      // The real form normalizes on every submit, including explicit retries.
      f.api.creation.change({ title: f.api.creation.draft.title.trim() });
      expect(await f.api.creation.create()).toMatchObject({
        kind: lateOriginal ? 'unconfirmed' : 'created',
      });
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.url).toBe(attempts[0]!.url);
    expect(attempts[1]!.init.body).toBe(attempts[0]!.init.body);
    for (const { init } of attempts)
      expect(new Headers(init.headers).get('if-none-match')).toBe('*');
    expect(f.rows.size).toBe(2); // Existing row plus exactly one new task.
    if (lateOriginal) {
      expect(f.api.creation.draft.title).toBe('Keep my task');
      expect(f.api.creation.canCreate).toBe(false);
      await act(async () => {
        expect(await f.api.creation.notice.onCheck()).toBe(true);
      });
      expect(f.api.creation.notice.current).toEqual({
        title: 'Keep my task',
        done: false,
      });
      act(() => f.api.creation.notice.onAcknowledge());
    }
    expect(f.api.creation.draft).toEqual(initial);
    expect(f.api.creation.canEdit).toBe(true);
  },
);

it('R3: after a definitive exists, the next explicit create uses a fresh IRI', async () => {
  const f = await setup();
  const attempts: string[] = [];
  f.setResource(async (url, init) => {
    if (init?.method !== 'PUT') return f.resource(url, init);
    attempts.push(url);
    // The generated IRI is already taken on the first attempt.
    if (attempts.length === 1) return taken(f, url);
    return f.resource(url, init);
  });
  act(() => f.api.creation.change({ title: 'Unchanged' }));
  await act(async () => {
    expect(await f.api.creation.create()).toMatchObject({ kind: 'exists' });
  });
  // The draft stays editable and is still there; nothing was retried.
  expect(f.api.creation.draft.title).toBe('Unchanged');
  expect(f.api.creation.canEdit).toBe(true);
  expect(attempts).toHaveLength(1);
  await act(async () => {
    expect(await f.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).not.toBe(attempts[0]);
  expect(f.api.creation.draft).toEqual(initial);
});

it('a creation the browser resent is not taken for a collision and gets no fresh IRI', async () => {
  const f = await setup();
  const attempts: string[] = [];
  f.setResource(async (url, init) => {
    if (init?.method !== 'PUT') return f.resource(url, init);
    attempts.push(url);
    // Applied, then resent below Fetch: the resend fails If-None-Match.
    await f.resource(url, init);
    return new Response(null, { status: 412 });
  });
  act(() => f.api.creation.change({ title: 'Once' }));
  await act(async () => {
    expect(await f.api.creation.create()).toEqual({
      kind: 'unconfirmed',
      desiredObserved: true,
    });
  });
  expect(f.api.creation.canCreate).toBe(false);
  expect(f.api.creation.canEdit).toBe(false);
  await act(async () => {
    expect(await f.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => f.api.creation.notice.onAcknowledge());
  // Present evidence settles it: no second creation under another IRI.
  expect(f.api.creation.draft).toEqual(initial);
  expect(attempts).toHaveLength(1);
  expect(f.rows.size).toBe(2); // the existing row plus this one
});

type Setup = Awaited<ReturnType<typeof setup>>;
type Init = NonNullable<Parameters<PodFetch>[1]>;
const iriOf = (url: string) =>
  Buffer.from(new URL(url).pathname.split('/').at(-1)!, 'base64url').toString();
/** Another resource holds the IRI, so a create-only PUT fails its condition. */
function taken(f: Setup, url: string) {
  const iri = iriOf(url);
  f.rows.set(iri, {
    '@id': iri,
    '@type': ['urn:Task'],
    'urn:title': [{ '@value': 'Someone else' }],
    'urn:status': [{ '@id': 'urn:open' }],
  });
  return new Response(null, { status: 412 });
}
/** Records each creation attempt; each answer is slow enough for React to render. */
function trackPuts(
  f: Setup,
  answer: (attempt: number, url: string, init: Init) => Promise<Response>,
) {
  const puts: {
    iri: string;
    title: unknown;
    body: string;
    ifNoneMatch: string | null;
  }[] = [];
  let inFlight = 0;
  let most = 0;
  f.setResource(async (url, init) => {
    if (init?.method !== 'PUT') return f.resource(url, init);
    const body = init.body as string;
    puts.push({
      iri: iriOf(url),
      title: (JSON.parse(body) as { 'urn:title': [{ '@value': string }] })[
        'urn:title'
      ][0]['@value'],
      body,
      ifNoneMatch: new Headers(init.headers).get('if-none-match'),
    });
    most = Math.max(most, ++inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return await answer(puts.length, url, init);
    } finally {
      inFlight--;
    }
  });
  return { puts, most: () => most };
}
/** Starts the screen's batch as a click would, then waits until it has returned. */
async function addAll(f: Setup) {
  let finished = false;
  act(() => {
    void f.api.addAll().then(() => {
      finished = true;
    });
  });
  await waitFor(() => expect(finished).toBe(true));
}
const listed = (f: Setup) =>
  f.api.list.state.kind === 'ready'
    ? f.api.list.state.data.items.map((item) => item.data.title).sort()
    : [];

it('S1: creates several items from one input one at a time, in order, each under a fresh IRI', async () => {
  const f = await setup();
  const track = trackPuts(f, (_, url, init) => f.resource(url, init));
  act(() => f.api.setInput('Milk, 2 Bananas, Bread'));
  await addAll(f);
  expect(track.puts.map((put) => put.title)).toEqual([
    'Milk',
    '2 Bananas',
    'Bread',
  ]);
  expect(track.most()).toBe(1); // never two creations in flight
  expect(new Set(track.puts.map((put) => put.iri)).size).toBe(3);
  for (const put of track.puts) {
    expect(put.iri).toMatch(/\/tasks\/[\w-]+$/);
    expect(put.ifNoneMatch).toBe('*');
  }
  await waitFor(() => expect(f.api.input).toBe(''));
  expect(f.api.creation.draft).toEqual(initial);
  expect(f.api.creation.outcome).toEqual({ kind: 'created' });
  expect(f.api.creation.canEdit).toBe(true);
  expect(screen.getByRole('status').textContent).toBe('Created.');
  await waitFor(() =>
    expect(listed(f)).toEqual(['2 Bananas', 'Bread', 'Milk', 'One']),
  );
});

it.each([
  {
    stop: 'unconfirmed',
    answer: async (f: Setup, url: string, init: Init) => {
      await f.resource(url, init); // applied, but the answer is lost
      return new Response(null, { status: 202 });
    },
    outcome: { kind: 'unconfirmed' },
    held: true,
    canCreate: false,
    rows: 4, // the lost answer's item landed
  },
  {
    stop: 'refused',
    answer: async () => new Response(null, { status: 403 }),
    outcome: { kind: 'not-created', reason: 'refused' },
    held: false,
    canCreate: true,
    rows: 3,
  },
  {
    stop: 'exists',
    answer: async (f: Setup, url: string) => taken(f, url),
    outcome: { kind: 'exists' },
    held: false,
    canCreate: true,
    rows: 4, // the other resource holding the IRI
  },
  {
    stop: 'not sent (write access lost)',
    answer: undefined,
    outcome: null,
    held: false,
    canCreate: false,
    rows: 3,
  },
])(
  'S2: stops at the first $stop item; confirmed items stay created and the rest is not sent',
  async ({ answer, outcome, held, canCreate, rows }) => {
    const f = await setup();
    const track = trackPuts(f, async (attempt, url, init) => {
      if (attempt === 3 && answer) return answer(f, url, init);
      const result = await f.resource(url, init);
      if (attempt === 2 && !answer) {
        // Before the third item: the target stays, its write access goes.
        f.setCatalogue(async () => catalogue([work, personal], []));
        await f.runtime.loadContexts(f.id);
      }
      return result;
    });
    act(() => f.api.setInput('Milk, Bananas, Bread, Eggs'));
    await addAll(f);
    const sent = answer ? 3 : 2;
    expect(track.puts.map((put) => put.title)).toEqual(
      ['Milk', 'Bananas', 'Bread'].slice(0, sent),
    );
    // The stopped item stays in the draft; only the unsent rest returns.
    await waitFor(() => expect(f.api.input).toBe('Eggs'));
    expect(f.api.creation.outcome).toEqual(outcome);
    expect(f.api.creation.draft).toEqual({ ...initial, title: 'Bread' });
    expect(f.api.creation.canEdit).toBe(!held);
    expect(f.api.creation.canCreate).toBe(canCreate);
    await waitFor(() =>
      expect(listed(f)).toEqual(
        expect.arrayContaining(['Bananas', 'Milk', 'One']),
      ),
    );
    expect(f.rows.size).toBe(rows);
    // Nothing is retried on its own, and the next batch cannot replace the
    // stopped item in the draft.
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    await addAll(f);
    expect(f.api.creation.draft.title).toBe('Bread');
    expect(f.api.input).toBe('Eggs');
    if (held) {
      act(() => f.api.creation.change({ title: 'Eggs' }));
      await act(async () => {
        expect(await f.api.creation.create()).toBeUndefined();
      });
      expect(f.api.creation.draft.title).toBe('Bread');
    }
    expect(track.puts).toHaveLength(sent);
  },
);

it('S3: an unconfirmed item keeps its IRI through recovery; the rest continues afterwards', async () => {
  const f = await setup();
  const track = trackPuts(f, async (attempt, url, init) => {
    // The third item's first answer is lost before anything was stored.
    if (attempt === 3) return new Response(null, { status: 202 });
    return f.resource(url, init);
  });
  act(() => f.api.setInput('Milk, Bananas, Bread, Eggs'));
  await addAll(f);
  await waitFor(() => expect(f.api.input).toBe('Eggs'));
  expect(f.api.creation.outcome).toEqual({ kind: 'unconfirmed' });
  expect(
    screen.getByText(
      'The result is unconfirmed. Check the pod before deciding; nothing is retried automatically.',
    ),
  ).toBeTruthy();
  await act(async () => {
    expect(await f.api.creation.notice.onCheck()).toBe(true);
  });
  expect(f.api.creation.notice.current).toBeNull(); // observed absence
  act(() => f.api.creation.notice.onAcknowledge());
  // Absence is no proof: the same command stays held for an explicit retry.
  expect(f.api.creation.draft.title).toBe('Bread');
  expect(f.api.creation.canEdit).toBe(false);
  expect(f.api.creation.canCreate).toBe(true);
  await addAll(f); // the batch waits until the held item is settled
  expect(track.puts).toHaveLength(3);
  await act(async () => {
    expect(await f.api.creation.create()).toEqual({ kind: 'created' });
  });
  expect(track.puts).toHaveLength(4);
  expect(track.puts[3]!.iri).toBe(track.puts[2]!.iri);
  expect(track.puts[3]!.body).toBe(track.puts[2]!.body);
  expect(f.api.creation.draft).toEqual(initial);
  expect(f.api.creation.canEdit).toBe(true);
  await addAll(f);
  await waitFor(() => expect(f.api.input).toBe(''));
  expect(track.puts.map((put) => put.title)).toEqual([
    'Milk',
    'Bananas',
    'Bread',
    'Bread',
    'Eggs',
  ]);
  expect(new Set(track.puts.map((put) => put.iri)).size).toBe(4);
  await waitFor(() =>
    expect(listed(f)).toEqual(['Bananas', 'Bread', 'Eggs', 'Milk', 'One']),
  );
});

it.each([false, true])(
  'S4: a target change during a creation stops the batch without returning its possibly written item (input above TargetScreen: %s)',
  async (hostInput) => {
    const f = await setup('en', { hostInput });
    const gate = deferred<void>();
    const track = trackPuts(f, async (attempt, url, init) => {
      const result = await f.resource(url, init); // the write lands
      if (attempt === 2) await gate.promise;
      return result;
    });
    act(() => f.api.setInput('Milk, Bananas, Bread'));
    let finished = false;
    act(() => {
      void f.api.addAll().then(() => {
        finished = true;
      });
    });
    await waitFor(() => expect(f.rows.size).toBe(3)); // One, Milk, Bananas
    // An unguarded switch through the runtime while the answer is pending.
    await act(async () => {
      f.runtime.selectContext(f.id, personal);
    });
    await act(async () => {
      gate.resolve();
    });
    await waitFor(() => expect(finished).toBe(true));
    // The answer was applied, but it belongs to the ended lifetime: the hook
    // reports `undefined` and the new lifetime starts with a blank draft.
    expect(f.api.creation.draft).toEqual(initial);
    expect(f.api.creation.outcome).toBeNull();
    expect(f.api.input).toBe(hostInput ? 'Bread' : '');
    await act(async () => {
      f.runtime.selectContext(f.id, work);
    });
    await waitFor(() => expect(listed(f)).toEqual(['Bananas', 'Milk', 'One']));
    if (hostInput) {
      await addAll(f); // the rest continues; Bananas is not sent again
      await waitFor(() => expect(f.api.input).toBe(''));
    }
    expect(track.puts.map((put) => put.title)).toEqual(
      hostInput ? ['Milk', 'Bananas', 'Bread'] : ['Milk', 'Bananas'],
    );
  },
);
