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
  useDraftGuard,
  useResourceEditor,
  useSelection,
} from './index.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  deferred,
  fixture,
  personal,
  resourceIri,
  work,
} from '../runtime/fixture.test.js';

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

async function setup(selection = false, extra?: React.ReactNode) {
  const f = fixture();
  const session = await f.login();
  runtimes.push(session.runtime);
  let version = 1;
  const one = (iri = 'urn:one'): JsonLd => ({
    '@id': iri,
    '@type': ['urn:Task'],
    'urn:title': [{ '@value': 'One' }],
    'urn:status': [{ '@id': 'urn:open' }],
  });
  let answer: () => Promise<Response> | Response = () =>
    new Response(null, { status: 204 });
  const writes: string[] = [];
  f.setResource(async (url, init) => {
    if ((init?.method ?? 'GET') === 'GET')
      return ['urn:one', 'urn:two'].includes(resourceIri(url))
        ? Response.json(one(resourceIri(url)), {
            headers: { etag: `"v${version}"` },
          })
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
    note: (noted: boolean) => void;
    copies: ResourceEditor<unknown>[];
    selection: ReturnType<typeof useSelection<string>>;
  };
  // The same type with one more field: another definition for the editor.
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
    api.note = setNoted;
    api.selection = useSelection();
    api.editor = useResourceEditor(
      selection ? api.selection.selected : 'urn:one',
      (noted ? withNote : definition) as typeof definition,
    );
    return null;
  }
  function Host() {
    const [hidden, hide] = useState(false);
    const [mounted, mount] = useState(true);
    api.app = useApp();
    api.hide = hide;
    api.mount = mount;
    return (
      <>
        {extra}
        <Activity mode={hidden ? 'hidden' : 'visible'}>
          {mounted && <Screen />}
        </Activity>
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
  if (selection) {
    await waitFor(() => expect(api.selection).toBeDefined());
    await act(async () => {
      expect(await api.selection.select('urn:one')).toBe(true);
    });
  }
  await waitFor(() => expect(api.editor?.state.phase).toBe('ready'));
  return {
    render: (ui: React.ReactElement) =>
      render(
        <SempodsProvider runtime={session.runtime}>
          <TargetScreen>{ui}</TargetScreen>
        </SempodsProvider>,
      ),
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

function remount(s: Awaited<ReturnType<typeof setup>>) {
  act(() => s.api.mount(false));
  act(() => s.api.mount(true));
  expect(s.api.selection.selected).toBeNull();
  expect(s.api.editor).toBeNull();
}

async function reopen(s: Awaited<ReturnType<typeof setup>>) {
  let opened!: Promise<boolean>;
  act(() => {
    opened = s.api.selection.select('urn:one');
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => {
    expect(await opened).toBe(true);
  });
  await waitFor(() => expect(s.api.editor).not.toBeNull());
}

async function answerLeave(discard: boolean) {
  await waitFor(() =>
    expect(document.querySelector('[role="alertdialog"]')).not.toBeNull(),
  );
  await act(async () => {
    (
      [...document.querySelectorAll('[role="alertdialog"] button')].find(
        (button) => (button.textContent !== 'Keep editing') === discard,
      ) as HTMLButtonElement
    ).click();
  });
}

it.each(['dirty', 'unconfirmed'] as const)(
  'reopens a %s editor after selection remount without discarding or replaying it',
  async (kind) => {
    const s = await setup(true);
    act(() => s.api.editor!.change({ title: 'Keep me' }));
    const retained = s.api.editor;
    if (kind === 'unconfirmed') {
      s.answer(() => new Response(null, { status: 202 }));
      await act(async () => {
        await s.api.editor!.save();
      });
    }
    remount(s);
    await reopen(s);
    expect(s.api.editor).toBe(retained);
    expect(s.api.editor!.state.draft?.title).toBe('Keep me');
    expect(s.api.editor!.state.review?.kind).toBe(
      kind === 'unconfirmed' ? 'unconfirmed' : undefined,
    );
    expect(s.writes).toHaveLength(kind === 'unconfirmed' ? 1 : 0);
    // Reopening did not unregister its guard: closing still asks.
    let closed!: Promise<boolean>;
    act(() => {
      closed = s.api.selection.select(null);
    });
    await answerLeave(false);
    expect(await closed).toBe(false);
    expect(s.api.selection.selected).toBe('urn:one');
  },
);

it.each(['local', 'connection'] as const)(
  'reopening still asks about an unrelated %s guard and retains only its own editor',
  async (scope) => {
    let markDirty!: () => void;
    const discarded = vi.fn();
    function Draft() {
      const [dirty, setDirty] = useState(false);
      markDirty = () => setDirty(true);
      useDraftGuard(
        dirty,
        () => {
          discarded();
          setDirty(false);
        },
        scope,
      );
      return null;
    }
    const s = await setup(true, <Draft />);
    act(() => s.api.editor!.change({ title: 'Keep me' }));
    remount(s);
    act(markDirty);
    let opened!: Promise<boolean>;
    act(() => {
      opened = s.api.selection.select('urn:one');
    });
    await answerLeave(false);
    expect(await opened).toBe(false);
    expect(s.api.selection.selected).toBeNull();
    expect(discarded).not.toHaveBeenCalled();
    act(() => {
      opened = s.api.selection.select('urn:one');
    });
    await answerLeave(true);
    expect(await opened).toBe(true);
    await waitFor(() =>
      expect(s.api.editor?.state.draft?.title).toBe('Keep me'),
    );
    expect(discarded).toHaveBeenCalledOnce();
  },
);

it('reopening still asks about another resource editor and discards only that editor', async () => {
  let other: Awaited<ReturnType<typeof setup>>['api']['editor'];
  function Other() {
    other = useResourceEditor('urn:two', definition);
    return null;
  }
  const s = await setup(true, <Other />);
  await waitFor(() => expect(other?.state.phase).toBe('ready'));
  act(() => {
    s.api.editor!.change({ title: 'Keep me' });
    other!.change({ title: 'Leave me' });
  });
  remount(s);
  let opened!: Promise<boolean>;
  act(() => {
    opened = s.api.selection.select('urn:one');
  });
  await answerLeave(true);
  expect(await opened).toBe(true);
  await waitFor(() => expect(s.api.editor?.state.draft?.title).toBe('Keep me'));
  expect(other!.state.draft?.title).toBe('One');
});

it('pending writes still block reopening until they settle, then recovery returns without replay', async () => {
  const s = await setup(true);
  const held = deferred<Response>();
  s.answer(() => held.promise);
  act(() => s.api.editor!.change({ title: 'Keep me' }));
  let saved!: Promise<unknown>;
  act(() => {
    saved = s.api.editor!.save();
  });
  await waitFor(() => expect(s.api.editor?.state.phase).toBe('saving'));
  remount(s);
  await act(async () => {
    expect(await s.api.selection.select('urn:one')).toBe(false);
  });
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  await act(async () => {
    held.resolve(new Response(null, { status: 202 }));
    await saved;
  });
  await reopen(s);
  expect(s.api.editor!.state.review?.kind).toBe('unconfirmed');
  expect(s.api.editor!.state.draft?.title).toBe('Keep me');
  expect(s.writes).toHaveLength(1);
});

it('another row or Context still asks, and an old selection command cannot reopen on a new target', async () => {
  const s = await setup(true);
  act(() => s.api.editor!.change({ title: 'Keep me' }));
  remount(s);
  const oldSelect = s.api.selection.select;
  let moved!: Promise<boolean>;
  act(() => {
    moved = oldSelect('urn:two');
  });
  await answerLeave(false);
  expect(await moved).toBe(false);
  act(() => {
    moved = s.api.app.selectContext(personal);
  });
  await answerLeave(false);
  expect(await moved).toBe(false);
  act(() => {
    moved = s.api.app.selectContext(personal);
  });
  await answerLeave(true);
  expect(await moved).toBe(true);
  await act(async () => {
    expect(await oldSelect('urn:one')).toBe(false);
  });
  await act(async () => {
    expect(await s.api.app.selectContext(work)).toBe(true);
  });
  await act(async () => {
    expect(await oldSelect('urn:one')).toBe(false);
  });
  await reopen(s);
  await waitFor(() => expect(s.api.editor?.state.phase).toBe('ready'));
  expect(s.api.editor!.state.draft?.title).toBe('One');
  expect(s.writes).toHaveLength(0);
});

it('another definition for the same subject discards the earlier editor and its guard', async () => {
  const s = await setup();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  act(() => s.api.editor!.change({ title: 'Changed' }));
  act(() => s.api.note(true));
  await waitFor(() => expect(s.api.editor?.state.phase).toBe('ready'));
  // Nothing is left to ask about: the discarded draft is gone.
  expect(await s.api.app.navigate(() => {})).toBe(true);
  // Back on the first definition, a fresh editor without that draft.
  act(() => s.api.note(false));
  await waitFor(() => expect(s.api.editor?.state.phase).toBe('ready'));
  expect(s.api.editor?.state.draft?.title).toBe('One');
});

it('custom definitions of one subject get editors of their own', async () => {
  const s = await setup();
  // Copies are custom definitions: each mapping only matches itself.
  const plain = { ...definition };
  const marked = {
    ...definition,
    read: (body: JsonLd) => ({ ...definition.read(body), title: 'Marked' }),
  };
  const seen: ResourceEditor<{ title: string }>[] = [];
  function Copy({ of }: { readonly of: typeof definition }) {
    const editor = useResourceEditor('urn:one', of);
    if (editor) seen.push(editor as never);
    return null;
  }
  s.render(
    <>
      <Copy of={plain as typeof definition} />
      <Copy of={marked as typeof definition} />
    </>,
  );
  await waitFor(() =>
    expect(seen.map((e) => e.state.draft?.title)).toContain('Marked'),
  );
  const editors = new Set(seen);
  expect(editors.size).toBe(2);
  expect([...editors].map((e) => e.state.draft?.title).sort()).toEqual([
    'Marked',
    'One',
  ]);
});
