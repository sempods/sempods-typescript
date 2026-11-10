// @vitest-environment jsdom
/**
 * One editing lifecycle across access changes (#274): drafts and captured
 * writes of resource editors, creations and row updates outlive hiding,
 * unmounting and a session that ends, are found again, and are never written
 * again without access. Adapted from the lifecycle review on #272.
 */
import { webcrypto } from 'node:crypto';
import { Activity, useState } from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  fields,
  snapshots,
  text,
  type ResourceEditor,
} from '@sempods/client-sdk/edit';
import {
  catalogue,
  deferred,
  fixture,
  pod,
  renewal,
  work,
} from '../runtime/fixture.test.js';
import {
  SempodsProvider,
  useContextEditor,
  useContextUpdate,
  useCreation,
  useResourceEditor,
  type ContextEditor,
} from './index.js';

const stops: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  stops.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
});

const modes = ['optional', 'required'] as const;
const definition = fields({ title: text('urn:title', { language: null }) });
const node = { '@id': 'urn:item', 'urn:title': [{ '@value': 'Original' }] };

/** Signed in under `signIn`, with `work` writable only with a token. */
async function signedIn(signIn: (typeof modes)[number]) {
  const f = fixture({ signIn, preferences: null, preset: { podUrl: pod } });
  const session = await f.login();
  stops.push(() => session.runtime.dispose());
  f.setCatalogue(async (_url, init) =>
    new Headers(init?.headers).has('authorization')
      ? catalogue()
      : catalogue([work], []),
  );
  return { ...f, ...session };
}

const editorCases = modes.flatMap((signIn) =>
  (['selected', 'explicit'] as const).flatMap((target) =>
    (['shown', 'activity', 'unmount'] as const).flatMap((presentation) =>
      (['draft', 'unconfirmed', 'pending'] as const).flatMap((state) =>
        [false, true].map((end) => ({
          signIn,
          target,
          presentation,
          state,
          end,
        })),
      ),
    ),
  ),
);

it.each(editorCases)(
  'resource editor: $signIn / $target / $presentation / $state / session ends: $end',
  async ({ signIn, target, presentation, state, end }) => {
    const f = await signedIn(signIn);
    const response = deferred<Response>();
    let writes = 0;
    f.setResource(async (_url, init) => {
      if ((init?.method ?? 'GET') === 'GET')
        return Response.json(node, { headers: { etag: '"v1"' } });
      writes++;
      return state === 'pending'
        ? response.promise
        : new Response(null, { status: 202 });
    });
    let editor: ResourceEditor<{ title: string }> | null = null;
    let context!: ContextEditor<{ title: string }>;
    function Selected() {
      editor = useResourceEditor('urn:item', definition);
      return null;
    }
    function Explicit() {
      context = useContextEditor(definition);
      editor = context.editor;
      return null;
    }
    let toggle!: (show: boolean) => void;
    function Host() {
      const [show, setShow] = useState(true);
      toggle = setShow;
      const child = target === 'selected' ? <Selected /> : <Explicit />;
      if (presentation === 'activity')
        return <Activity mode={show ? 'visible' : 'hidden'}>{child}</Activity>;
      return show ? child : null;
    }
    render(
      <SempodsProvider runtime={f.runtime}>
        <Host />
      </SempodsProvider>,
    );
    if (target === 'explicit')
      await act(async () => {
        expect(await context.open({ context: work, subject: 'urn:item' })).toBe(
          true,
        );
      });
    await waitFor(() => expect(editor?.state.draft?.title).toBe('Original'));
    act(() => editor!.change({ title: 'Retained draft' }));
    let saving: Promise<unknown> | undefined;
    if (state === 'unconfirmed') {
      await act(async () => {
        await editor!.save();
      });
      expect(editor!.state.review?.kind).toBe('unconfirmed');
    } else if (state === 'pending') {
      act(() => {
        saving = editor!.save();
      });
      await waitFor(() => expect(writes).toBe(1));
    }
    if (presentation !== 'shown') act(() => toggle(false));
    if (end)
      await act(async () => {
        await renewal(f, f.runtime, f.id, 'refused');
      });
    if (state === 'pending')
      await act(async () => {
        response.resolve(new Response(null, { status: 202 }));
        await saving;
      });
    if (presentation !== 'shown') act(() => toggle(true));
    if (target === 'explicit' && presentation === 'unmount')
      await act(async () => {
        expect(await context.open({ context: work, subject: 'urn:item' })).toBe(
          true,
        );
      });
    await waitFor(
      () => expect(editor?.state.draft?.title).toBe('Retained draft'),
      { timeout: 500 },
    );
    if (state !== 'draft')
      expect(editor!.state.review?.kind).toBe('unconfirmed');
    // Without access, nothing is written again.
    const sent = writes;
    if (end && state === 'draft')
      await act(async () => {
        await editor!.save();
      });
    expect(writes).toBe(sent);
  },
);

const rowCases = modes.flatMap((signIn) =>
  [false, true].map((end) => ({ signIn, end })),
);

it.each(rowCases)(
  'row update: recovery stays reachable ($signIn, session ends: $end)',
  async ({ signIn, end }) => {
    const f = await signedIn(signIn);
    f.setResource(async (_url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? Response.json(node, { headers: { etag: '"v1"' } })
        : new Response(null, { status: 202 }),
    );
    const view = f.runtime.bindContext(f.id, work);
    const snapshot = snapshots(view, [node], definition).items[0]!;
    let api!: ReturnType<typeof useContextUpdate<{ title: string }>>;
    function Form() {
      api = useContextUpdate(definition);
      return null;
    }
    render(
      <SempodsProvider runtime={f.runtime}>
        <Form />
      </SempodsProvider>,
    );
    await waitFor(() =>
      expect(api.for({ context: work, snapshot }).canMutate).toBe(true),
    );
    await act(async () => {
      expect(
        await api.for({ context: work, snapshot }).update({ title: 'Changed' }),
      ).toMatchObject({ kind: 'unconfirmed' });
    });
    if (end)
      await act(async () => {
        await renewal(f, f.runtime, f.id, 'refused');
      });
    expect(api.unresolved).toEqual([{ context: work, iri: 'urn:item' }]);
    expect(api.for(api.unresolved[0]!).notice.outcome?.kind).toBe(
      'unconfirmed',
    );
    if (end) expect(api.for({ context: work, snapshot }).canMutate).toBe(false);
  },
);

const creationCases = modes.flatMap((signIn) =>
  [false, true].flatMap((activity) =>
    [false, true].map((end) => ({ signIn, activity, end })),
  ),
);

it.each(creationCases)(
  'creation: a pending creation and its late result while away ($signIn, Activity: $activity, session ends: $end)',
  async ({ signIn, activity, end }) => {
    const f = await signedIn(signIn);
    let api!: ReturnType<typeof useCreation<{ title: string }>>;
    function Form() {
      api = useCreation(definition, {
        initial: { title: '' },
        iri: 'urn:item',
        context: work,
      });
      return null;
    }
    let toggle!: (show: boolean) => void;
    function Host() {
      const [show, setShow] = useState(true);
      toggle = setShow;
      if (activity)
        return (
          <Activity mode={show ? 'visible' : 'hidden'}>
            <Form />
          </Activity>
        );
      return show ? <Form /> : null;
    }
    render(
      <SempodsProvider runtime={f.runtime}>
        <Host />
      </SempodsProvider>,
    );
    await waitFor(() => expect(api.canEdit).toBe(true));
    act(() => api.change({ title: 'New item' }));
    await waitFor(() => expect(api.canCreate).toBe(true));
    const response = deferred<Response>();
    let dispatched = 0;
    f.setResource(async () => {
      dispatched++;
      return response.promise;
    });
    let creating!: Promise<unknown>;
    act(() => {
      creating = api.create();
    });
    await waitFor(() => expect(dispatched).toBe(1));
    act(() => toggle(false));
    if (end)
      await act(async () => {
        await renewal(f, f.runtime, f.id, 'refused');
      });
    await act(async () => {
      response.reject(new TypeError('Lost late response'));
      expect(await creating).toMatchObject({ kind: 'unconfirmed' });
    });
    act(() => toggle(true));
    await waitFor(() => expect(api.outcome?.kind).toBe('unconfirmed'));
    expect(api.canEdit).toBe(false);
    expect(api.canCreate).toBe(false);
    expect(api.draft.title).toBe('New item');
    expect(dispatched).toBe(1);
  },
);

const draftCases = modes.flatMap((signIn) =>
  (['never', 'before', 'after'] as const).flatMap((hidden) =>
    [false, true].map((end) => ({ signIn, hidden, end })),
  ),
);

it.each(draftCases)(
  'creation: an unsent draft stays ($signIn, hidden: $hidden the session end, session ends: $end)',
  async ({ signIn, hidden, end }) => {
    const f = await signedIn(signIn);
    let api!: ReturnType<typeof useCreation<{ title: string }>>;
    function Form() {
      api = useCreation(definition, {
        initial: { title: '' },
        iri: 'urn:item',
        context: work,
      });
      return null;
    }
    let toggle!: (show: boolean) => void;
    function Host() {
      const [show, setShow] = useState(true);
      toggle = setShow;
      return (
        <Activity mode={show ? 'visible' : 'hidden'}>
          <Form />
        </Activity>
      );
    }
    render(
      <SempodsProvider runtime={f.runtime}>
        <Host />
      </SempodsProvider>,
    );
    await waitFor(() => expect(api.canEdit).toBe(true));
    act(() => api.change({ title: 'Unsent' }));
    await waitFor(() => expect(api.draft.title).toBe('Unsent'));
    if (hidden === 'before') act(() => toggle(false));
    if (end)
      await act(async () => {
        await renewal(f, f.runtime, f.id, 'refused');
      });
    if (hidden === 'after') act(() => toggle(false));
    if (hidden !== 'never') act(() => toggle(true));
    await act(async () => {});
    expect(api.draft.title).toBe('Unsent');
    // Without access it is not sent. Reading without a token, it stays
    // editable; under `required` the sign-in screen covers the app anyway.
    if (end) expect(api.canCreate).toBe(false);
    if (end && signIn === 'required') return;
    act(() => api.change({ title: 'Unsent, edited' }));
    await waitFor(() => expect(api.draft.title).toBe('Unsent, edited'));
  },
);
