// @vitest-environment jsdom
/**
 * Write lanes across hiding and remounting (#156). React 19.2 `<Activity
 * mode="hidden">` cleans up effects but keeps state; a lane's lifetime should
 * follow its target, not its component. `it.fails` marks today's defects;
 * the controller-owned lane store turns them into ordinary tests.
 */
import { webcrypto } from 'node:crypto';
import { Activity, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { fields, flag, text, type Snapshot } from '@sempods/client-sdk/edit';
import type { JsonLd } from '@sempods/client-sdk';
import {
  SempodsProvider,
  TargetScreen,
  useApp,
  useCreation,
  useFieldUpdate,
  useList,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { deferred, fixture, resourceIri } from '../runtime/fixture.test.js';

type Task = { readonly title: string; readonly done: boolean };
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
  const one: JsonLd = {
    '@id': 'urn:one',
    '@type': ['urn:Task'],
    'urn:title': [{ '@value': 'One' }],
    'urn:status': [{ '@id': 'urn:open' }],
  };
  f.setQuery(async () => Response.json([one]));
  let answer: () => Promise<Response> | Response = () =>
    new Response(null, { status: 204 });
  const writes: string[] = [];
  const puts: string[] = [];
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET')
      return resourceIri(url) === 'urn:one'
        ? Response.json(one, { headers: { etag: '"v1"' } })
        : new Response(null, { status: 404 });
    writes.push(init?.method ?? '');
    if (init?.method === 'PUT') puts.push(resourceIri(url));
    return answer();
  });
  const api = {} as {
    mutate: ReturnType<typeof useFieldUpdate<Task>>;
    other: ReturnType<typeof useFieldUpdate<Task>>;
    creation: ReturnType<typeof useCreation<Task>>;
    second: ReturnType<typeof useCreation<Task>>;
    rows: readonly Snapshot<Task>[];
    app: ReturnType<typeof useApp>;
    hide: (hidden: boolean) => void;
    late: ReturnType<typeof useCreation<Task>> | null;
    showLate: (shown: boolean) => void;
    note: () => void;
    mount: (mounted: boolean) => void;
  };
  // The same type with one more field: another definition for the form.
  const withNote = fields(
    {
      title: text('urn:title', { language: null }),
      done: flag('urn:status', { on: 'urn:done', off: 'urn:open' }),
      note: text('urn:note', { language: null, optional: true }),
    },
    { type: 'urn:Task' },
  );
  function Screen() {
    const [noted, setNoted] = useState(false);
    api.note = () => setNoted(true);
    const list = useList(definition);
    api.mutate = useFieldUpdate(definition);
    api.other = useFieldUpdate(definition);
    api.creation = useCreation(
      (noted ? withNote : definition) as typeof definition,
      {
        initial: { title: '', done: false },
        collection: 'tasks',
      },
    );
    // A second form for the same collection and definition.
    api.second = useCreation(definition, {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    api.rows = list.data?.items ?? api.rows ?? [];
    return null;
  }
  // Another form of the same collection, outside the hidden part.
  function Late() {
    api.late = useCreation(definition, {
      initial: { title: '', done: false },
      collection: 'tasks',
    });
    return null;
  }
  function Host() {
    const [hidden, hide] = useState(false);
    const [mounted, mount] = useState(true);
    const [late, showLate] = useState(false);
    api.app = useApp();
    api.hide = hide;
    api.mount = mount;
    api.showLate = showLate;
    if (!late) api.late = null;
    return (
      <>
        <Activity mode={hidden ? 'hidden' : 'visible'}>
          {mounted && <Screen />}
        </Activity>
        {late && <Late />}
      </>
    );
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <TargetScreen>
        <Host />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() => expect(api.rows).toHaveLength(1));
  await waitFor(() =>
    expect(api.mutate.for(api.rows[0]!).canMutate).toBe(true),
  );
  return {
    ...f,
    api,
    writes,
    puts,
    answer: (next: typeof answer) => {
      answer = next;
    },
  };
}

it('a pending update blocks navigation while hidden and shows its outcome on reveal', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  const row = s.api.rows[0]!;
  let sent!: Promise<unknown>;
  act(() => {
    sent = s.api.mutate.for(row).update({ done: true });
  });
  await waitFor(() => expect(s.api.mutate.busy).toBe(true));
  act(() => s.api.hide(true));
  // Still pending: a guarded change must wait for it.
  expect(await s.api.app.navigate(() => {})).toBe(false);
  await act(async () => held.resolve(new Response(null, { status: 202 })));
  expect(await sent).toMatchObject({ kind: 'unconfirmed' });
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.mutate.busy).toBe(false));
  expect(s.api.mutate.unresolved).toEqual(['urn:one']);
  expect(s.api.mutate.for('urn:one').notice.outcome).toMatchObject({
    kind: 'unconfirmed',
  });
});

it('a creation that settles while hidden leaves the form usable on reveal', async () => {
  const s = await setup();
  const held = deferred<Response>();
  s.answer(() => held.promise);
  act(() => s.api.creation.change({ title: 'New' }));
  let sent!: Promise<unknown>;
  act(() => {
    sent = s.api.creation.create();
  });
  await waitFor(() => expect(s.api.creation.busy).toBe(true));
  act(() => s.api.hide(true));
  await act(async () => held.resolve(new Response(null, { status: 201 })));
  expect(await sent).toMatchObject({ kind: 'created' });
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.creation.draft.title).toBe(''));
  expect(s.api.creation.busy).toBe(false);
  expect(s.api.creation.canEdit).toBe(true);
});

it('an unconfirmed outcome survives unmounting and remounting its screen', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  const row = s.api.rows[0]!;
  await act(async () => {
    expect(await s.api.mutate.for(row).update({ done: true })).toMatchObject({
      kind: 'unconfirmed',
    });
  });
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  await waitFor(() => expect(s.api.rows).toHaveLength(1));
  expect(s.api.mutate.unresolved).toEqual(['urn:one']);
  expect(s.api.mutate.for('urn:one').notice.outcome).toMatchObject({
    kind: 'unconfirmed',
  });
});

it.each([
  ['a success', 204, 'saved'],
  ['a definite failure', 403, 'not-saved'],
] as const)(
  '%s that settles while hidden shows on reveal',
  async (_, status, kind) => {
    const s = await setup();
    const held = deferred<Response>();
    s.answer(() => held.promise);
    const row = s.api.rows[0]!;
    let sent!: Promise<unknown>;
    act(() => {
      sent = s.api.mutate.for(row).update({ done: true });
    });
    await waitFor(() => expect(s.api.mutate.busy).toBe(true));
    act(() => s.api.hide(true));
    await act(async () => held.resolve(new Response(null, { status })));
    expect(await sent).toMatchObject({ kind });
    act(() => s.api.hide(false));
    await waitFor(() => expect(s.api.mutate.busy).toBe(false));
    expect(s.api.mutate.for('urn:one').notice.outcome).toMatchObject({
      kind,
    });
  },
);

it('two hooks share a resource lane but keep their own latest write', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  const row = s.api.rows[0]!;
  await act(async () => {
    await s.api.mutate.for(row).update({ done: true });
  });
  // The shared lane: the other hook sees the resource locked and unresolved.
  expect(s.api.other.for(row).canMutate).toBe(false);
  expect(s.api.other.unresolved).toEqual(['urn:one']);
  // Its own latest write is none: its notice is empty and its acknowledge
  // does not reach the first hook's write.
  expect(s.api.other.notice.outcome).toBeNull();
  act(() => s.api.other.acknowledge());
  expect(s.api.mutate.notice.outcome).toMatchObject({ kind: 'unconfirmed' });
  expect(s.api.mutate.unresolved).toEqual(['urn:one']);
});

it('a remounted form takes over its unconfirmed creation instead of allowing a resend', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({
      kind: 'unconfirmed',
    });
  });
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  await waitFor(() =>
    expect(s.api.creation.outcome).toMatchObject({ kind: 'unconfirmed' }),
  );
  expect(s.api.creation.canEdit).toBe(false);
  expect(s.api.creation.canCreate).toBe(false);
  expect(s.writes).toEqual(['PUT']);
  // The recovery is reachable: check, then acknowledge.
  await act(async () => {
    await s.api.creation.notice.onCheck();
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.outcome).toBeNull());
});

it('a hidden form starts no creation, also from a kept command', async () => {
  const s = await setup();
  act(() => s.api.creation.change({ title: 'New' }));
  const kept = s.api.creation;
  act(() => s.api.hide(true));
  await act(async () => {
    expect(await kept.create()).toEqual({ kind: 'not-sent', reason: 'ended' });
  });
  expect(s.writes).toEqual([]);
});

it("a form lane is not a row: an unconfirmed creation is not in the rows' unresolved", async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  expect(s.api.creation.outcome).toMatchObject({ kind: 'unconfirmed' });
  expect(s.api.mutate.unresolved).toEqual([]);
  expect(s.api.mutate.canMutate).toBe(true);
});

it('a creation command kept from an earlier definition stays unusable', async () => {
  const s = await setup();
  act(() => s.api.creation.change({ title: 'New' }));
  const kept = s.api.creation;
  act(() => s.api.note());
  await waitFor(() => expect(s.api.creation).not.toBe(kept));
  await act(async () => {
    expect(await kept.create()).toEqual({ kind: 'not-sent', reason: 'ended' });
  });
  expect(s.writes).toEqual([]);
});

it("another hook's later write to the same resource is not this hook's feedback", async () => {
  const s = await setup();
  // This hook's write is confirmed; the list reads again.
  await act(async () => {
    await s.api.mutate.for(s.api.rows[0]!).update({ done: true });
  });
  await waitFor(() =>
    expect(s.api.other.for(s.api.rows[0]!).canMutate).toBe(true),
  );
  // The other hook writes the same resource and gets no answer.
  s.answer(() => new Response(null, { status: 202 }));
  await act(async () => {
    // The fixture Pod still shows the task open, so this sends a write.
    await s.api.other.for(s.api.rows[0]!).update({ done: true });
  });
  expect(s.api.other.notice.outcome).toMatchObject({ kind: 'unconfirmed' });
  expect(s.api.mutate.notice.outcome?.kind).not.toBe('unconfirmed');
  // Acknowledging this hook's own write does not clear the other one.
  act(() => s.api.mutate.acknowledge());
  expect(s.api.other.unresolved).toEqual(['urn:one']);
  expect(s.api.other.notice.outcome).toMatchObject({ kind: 'unconfirmed' });
});

it('two forms remounting together each take over their own unconfirmed creation', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => {
    s.api.creation.change({ title: 'First' });
    s.api.second.change({ title: 'Second' });
  });
  await act(async () => {
    await s.api.creation.create();
    await s.api.second.create();
  });
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  await waitFor(() => {
    expect(s.api.creation.outcome).toMatchObject({ kind: 'unconfirmed' });
    expect(s.api.second.outcome).toMatchObject({ kind: 'unconfirmed' });
  });
  // Distinct lanes: acknowledging one after a check leaves the other.
  await act(async () => {
    await s.api.creation.notice.onCheck();
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.outcome).toBeNull());
  expect(s.api.second.outcome).toMatchObject({ kind: 'unconfirmed' });
});

it('a remounted form retries its absent creation under the same IRI, not a fresh one', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  expect(s.puts).toHaveLength(1);
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  // The draft and captured command come back with the lane.
  await waitFor(() => expect(s.api.creation.draft.title).toBe('New'));
  // The Pod does not have it (404): absence is observed, then acknowledged.
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.canCreate).toBe(true));
  expect(s.api.creation.draft.title).toBe('New');
  // The explicit retry sends the same IRI again.
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toEqual([s.puts[0], s.puts[0]]);
});

it('a form shown again after hiding takes its lane back from one that took it over', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  // Hidden: another form of the collection takes the lane over meanwhile.
  act(() => s.api.hide(true));
  act(() => s.api.showLate(true));
  await waitFor(() =>
    expect(s.api.late?.outcome).toMatchObject({ kind: 'unconfirmed' }),
  );
  // Shown again: the original form has priority; the other one lets go.
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.late?.outcome).toBeNull());
  expect(s.api.late?.draft.title).toBe('');
  expect(s.api.creation.outcome).toMatchObject({ kind: 'unconfirmed' });
  // The original still retries under its own IRI after observed absence.
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.canCreate).toBe(true));
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    await s.api.creation.create();
  });
  expect(s.puts).toEqual([iri, iri]);
});
