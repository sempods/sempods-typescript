// @vitest-environment jsdom
/**
 * Write lanes across hiding and remounting (#156). React 19.2 `<Activity
 * mode="hidden">` cleans up effects but keeps state; a lane's lifetime should
 * follow its target, not its component. `it.fails` marks today's defects;
 * the controller-owned lane store turns them into ordinary tests.
 */
import { webcrypto } from 'node:crypto';
import { Activity, useEffect, useState } from 'react';
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
  // Created resources the fixture Pod has, beyond `urn:one`.
  const present = new Set<string>();
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET')
      return resourceIri(url) === 'urn:one'
        ? Response.json(one, { headers: { etag: '"v1"' } })
        : present.has(resourceIri(url))
          ? Response.json(
              { ...one, '@id': resourceIri(url) },
              { headers: { etag: '"v1"' } },
            )
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
    note: (noted?: boolean) => void;
    collect: (collection: string) => void;
    /** Runs from a child's mount effect, after the hooks' first commit. */
    auto?: () => void;
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
    const [collection, collect] = useState('tasks');
    api.note = (next = true) => setNoted(next);
    api.collect = collect;
    const list = useList(definition);
    api.mutate = useFieldUpdate(definition);
    api.other = useFieldUpdate(definition);
    api.creation = useCreation(
      (noted ? withNote : definition) as typeof definition,
      {
        initial: { title: '', done: false },
        collection,
      },
    );
    // A second form for the same collection and definition, independent.
    api.second = useCreation(definition, {
      initial: { title: '', done: false },
      collection: 'tasks',
      id: 'second',
    });
    api.rows = list.data?.items ?? api.rows ?? [];
    return <Auto />;
  }
  function Auto() {
    useEffect(() => {
      api.auto?.();
    }, []);
    return null;
  }
  // Another form of the same collection, outside the hidden part: it shares
  // the creation of `creation` (no `id`).
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
    present,
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

it('a remounted form shows its unconfirmed creation instead of allowing a resend', async () => {
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

it('forms with their own id keep their own unconfirmed creations across a remount', async () => {
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

it("another form of the collection shows a hidden form's creation, and both recover it together", async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  // Hidden: another form of the collection shows the same creation, locked.
  act(() => s.api.hide(true));
  act(() => s.api.showLate(true));
  await waitFor(() =>
    expect(s.api.late?.outcome).toMatchObject({ kind: 'unconfirmed' }),
  );
  expect(s.api.late?.draft.title).toBe('Mine');
  expect(s.api.late?.canCreate).toBe(false);
  // Shown again: both show it; either one recovers it.
  act(() => s.api.hide(false));
  expect(s.api.creation.outcome).toMatchObject({ kind: 'unconfirmed' });
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.canCreate).toBe(true));
  expect(s.api.late?.draft.title).toBe('Mine');
  expect(s.api.late?.canEdit).toBe(false);
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    await s.api.creation.create();
  });
  expect(s.puts).toEqual([iri, iri]);
  // Created: both forms start afresh.
  await waitFor(() => expect(s.api.late?.draft.title).toBe(''));
  expect(s.api.creation.draft.title).toBe('');
});

it('back on a definition it left, a form recovers its unconfirmed creation under the same IRI', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  // Away to another definition and back again.
  act(() => s.api.note(true));
  await waitFor(() => expect(s.api.creation.outcome).toBeNull());
  act(() => s.api.note(false));
  await waitFor(() => expect(s.api.creation.draft.title).toBe('New'));
  expect(s.api.creation.outcome).toMatchObject({ kind: 'unconfirmed' });
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

it('an absence acknowledged by another form of the collection holds the original for its retry', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  act(() => s.api.hide(true));
  act(() => s.api.showLate(true));
  await waitFor(() =>
    expect(s.api.late?.outcome).toMatchObject({ kind: 'unconfirmed' }),
  );
  // The other form checks, finds it absent and acknowledges.
  await act(async () => {
    expect(await s.api.late!.notice.onCheck()).toBe(true);
  });
  act(() => s.api.late!.notice.onAcknowledge());
  // Shown again: the original holds its item for the same-IRI retry.
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.creation.canCreate).toBe(true));
  expect(s.api.creation.canEdit).toBe(false);
  expect(s.api.creation.draft.title).toBe('Mine');
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toEqual([iri, iri]);
});

it('a remounted form recovers a creation it acknowledged absent before unmounting', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.outcome).toBeNull());
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  // The held item comes back for its same-IRI retry, not a blank form.
  await waitFor(() => expect(s.api.creation.draft.title).toBe('New'));
  expect(s.api.creation.canEdit).toBe(false);
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toEqual([iri, iri]);
});

it('a form shown again after another one completed its retry is usable', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  act(() => s.api.hide(true));
  act(() => s.api.showLate(true));
  await waitFor(() =>
    expect(s.api.late?.outcome).toMatchObject({ kind: 'unconfirmed' }),
  );
  // The other form checks, finds it absent, acknowledges and retries.
  await act(async () => {
    expect(await s.api.late!.notice.onCheck()).toBe(true);
  });
  act(() => s.api.late!.notice.onAcknowledge());
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.late!.create()).toMatchObject({ kind: 'created' });
  });
  // Shown again: the item exists, so the original form starts afresh.
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.creation.draft.title).toBe(''));
  expect(s.api.creation.canEdit).toBe(true);
  act(() => s.api.creation.change({ title: 'Next' }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toHaveLength(3);
  expect(s.puts.slice(0, 2)).toEqual([iri, iri]);
  expect(s.puts[2]).not.toBe(iri);
});

it("a form for another collection never sends the earlier collection's command", async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  act(() => s.api.collect('notes'));
  await waitFor(() => expect(s.api.creation.draft.title).toBe(''));
  // Its own lane is free: the earlier collection's write stays unresolved.
  expect(s.api.creation.canEdit).toBe(true);
  act(() => s.api.creation.change({ title: 'Note' }));
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toHaveLength(2);
  expect(s.puts[1]).not.toBe(iri);
});

it("a form shown during another one's retry is usable once it is created", async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  act(() => s.api.hide(true));
  act(() => s.api.showLate(true));
  await waitFor(() =>
    expect(s.api.late?.outcome).toMatchObject({ kind: 'unconfirmed' }),
  );
  await act(async () => {
    expect(await s.api.late!.notice.onCheck()).toBe(true);
  });
  act(() => s.api.late!.notice.onAcknowledge());
  const held = deferred<Response>();
  s.answer(() => held.promise);
  let sent!: Promise<unknown>;
  act(() => {
    sent = s.api.late!.create();
  });
  await waitFor(() => expect(s.api.late?.busy).toBe(true));
  // Shown again while the retry is pending: it shows that write as busy.
  act(() => s.api.hide(false));
  await waitFor(() => expect(s.api.creation.busy).toBe(true));
  await act(async () => held.resolve(new Response(null, { status: 201 })));
  expect(await sent).toMatchObject({ kind: 'created' });
  await waitFor(() => expect(s.api.creation.draft.title).toBe(''));
  expect(s.api.creation.canEdit).toBe(true);
});

it('a creation acknowledged as present clears every form that shows it', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0]!;
  act(() => s.api.showLate(true));
  await waitFor(() => expect(s.api.late?.draft.title).toBe('Mine'));
  // The Pod has it after all: one form checks and acknowledges.
  s.present.add(iri);
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.late?.draft.title).toBe(''));
  expect(s.api.creation.draft.title).toBe('');
  // The other form never sends the acknowledged item again.
  act(() => s.api.late!.change({ title: 'Next' }));
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.late!.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toHaveLength(2);
  expect(s.puts[1]).not.toBe(iri);
});

it("a write on a fresh lane after eviction is not an earlier hook's feedback", async () => {
  const s = await setup();
  // This hook's write is confirmed.
  await act(async () => {
    await s.api.mutate.for(s.api.rows[0]!).update({ done: true });
  });
  // The other hook writes enough resources to evict that settled lane.
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    for (let i = 0; i < 201; i++)
      await s.api.other.create(`urn:new:${i}`, definition, {
        title: `Task ${i}`,
        done: false,
      });
  });
  await waitFor(() =>
    expect(s.api.other.for(s.api.rows[0]!).canMutate).toBe(true),
  );
  // It writes the first resource again, on a fresh lane, unanswered.
  s.answer(() => new Response(null, { status: 202 }));
  await act(async () => {
    await s.api.other.for(s.api.rows[0]!).update({ done: true });
  });
  expect(s.api.other.notice.outcome).toMatchObject({ kind: 'unconfirmed' });
  expect(s.api.mutate.notice.outcome?.kind).not.toBe('unconfirmed');
  act(() => s.api.mutate.acknowledge());
  expect(s.api.other.unresolved).toEqual(['urn:one']);
});

it('an absence acknowledged from an earlier generation still holds the item for its retry', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  const notice = s.api.creation.notice;
  await act(async () => {
    expect(await notice.onCheck()).toBe(true);
  });
  // The form moves to another definition before the kept handler acknowledges.
  act(() => s.api.note(true));
  await waitFor(() => expect(s.api.creation.outcome).toBeNull());
  act(() => notice.onAcknowledge());
  // Back again: the item is held for the same-IRI retry, not a blank form.
  act(() => s.api.note(false));
  await waitFor(() => expect(s.api.creation.draft.title).toBe('New'));
  expect(s.api.creation.canEdit).toBe(false);
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toEqual([iri, iri]);
});

it('a presence acknowledged from an earlier generation clears the other forms', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0]!;
  act(() => s.api.showLate(true));
  await waitFor(() => expect(s.api.late?.draft.title).toBe('Mine'));
  s.present.add(iri);
  const notice = s.api.creation.notice;
  await act(async () => {
    expect(await notice.onCheck()).toBe(true);
  });
  // The form moves to another definition before the kept handler acknowledges.
  act(() => s.api.note(true));
  await waitFor(() => expect(s.api.creation.outcome).toBeNull());
  act(() => notice.onAcknowledge());
  // The other form of the collection never sends the acknowledged item again.
  await waitFor(() => expect(s.api.late?.draft.title).toBe(''));
});

it("a child's mount effect may already start a write", async () => {
  const s = await setup();
  const row = s.api.rows[0]!;
  let sent: Promise<unknown> | undefined;
  s.api.auto = () => {
    sent = s.api.mutate.for(row).update({ done: true });
  };
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  expect(sent).toBeDefined();
  await act(async () => {
    expect(await sent).toMatchObject({ kind: 'saved' });
  });
});

it("a second form keeps its own draft while another form's creation is open and after it settles", async () => {
  const s = await setup();
  act(() => s.api.showLate(true));
  await waitFor(() => expect(s.api.late).not.toBeNull());
  act(() => s.api.late!.change({ title: 'Other' }));
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'Mine' }));
  await act(async () => {
    await s.api.creation.create();
  });
  // Open: every form of the collection shows that creation, locked.
  await waitFor(() => expect(s.api.late?.draft.title).toBe('Mine'));
  expect(s.api.late?.canEdit).toBe(false);
  s.present.add(s.puts[0]!);
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  // Settled: the form that sent it starts afresh, the other keeps its own.
  await waitFor(() => expect(s.api.creation.draft.title).toBe(''));
  expect(s.api.late?.draft.title).toBe('Other');
  expect(s.api.late?.canEdit).toBe(true);
});

it('a retry without an answer stays held for another same-IRI attempt', async () => {
  const s = await setup();
  s.answer(() => new Response(null, { status: 202 }));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    await s.api.creation.create();
  });
  const iri = s.puts[0];
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.canCreate).toBe(true));
  // The retry is refused: nothing was written, the item stays held.
  // The retry is not confirmed either (the first try may have landed).
  s.answer(() => new Response(null, { status: 403 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({
      kind: 'unconfirmed',
    });
  });
  await act(async () => {
    expect(await s.api.creation.notice.onCheck()).toBe(true);
  });
  act(() => s.api.creation.notice.onAcknowledge());
  await waitFor(() => expect(s.api.creation.canCreate).toBe(true));
  expect(s.api.creation.draft.title).toBe('New');
  expect(s.api.creation.canEdit).toBe(false);
  expect(s.api.creation.canCreate).toBe(true);
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    expect(await s.api.creation.create()).toMatchObject({ kind: 'created' });
  });
  expect(s.puts).toEqual([iri, iri, iri]);
});

it('a creation command kept from a definition stays unusable after going back to it', async () => {
  const s = await setup();
  const kept = s.api.creation;
  act(() => s.api.note(true));
  await waitFor(() => expect(s.api.creation).not.toBe(kept));
  act(() => s.api.note(false));
  await waitFor(() => expect(s.api.creation.canEdit).toBe(true));
  act(() => s.api.creation.change({ title: 'New' }));
  await act(async () => {
    expect(await kept.create()).toEqual({ kind: 'not-sent', reason: 'ended' });
  });
  expect(s.writes).toEqual([]);
});

it('a spent snapshot stays locked and shows its update after its lane is evicted', async () => {
  const s = await setup();
  const old = s.api.rows[0]!;
  await act(async () => {
    expect(await s.api.mutate.for(old).update({ done: true })).toMatchObject({
      kind: 'saved',
    });
  });
  // Enough other writes to evict that settled lane.
  s.answer(() => new Response(null, { status: 201 }));
  await act(async () => {
    for (let i = 0; i < 201; i++)
      await s.api.other.create(`urn:new:${i}`, definition, {
        title: `Task ${i}`,
        done: false,
      });
  });
  expect(s.api.mutate.for(old).canMutate).toBe(false);
  expect(s.api.mutate.for(old).data.done).toBe(true);
  await act(async () => {
    expect(await s.api.mutate.for(old).update({ done: false })).toEqual({
      kind: 'not-sent',
      reason: 'stale',
    });
  });
});
