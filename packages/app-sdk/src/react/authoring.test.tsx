// @vitest-environment jsdom
import { useState } from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  fixture,
  catalogue,
  personal,
  work,
  deferred,
  callback,
  settleLease,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntime, StartupReport } from '../index.js';
import {
  SempodsProvider,
  AppAccess,
  ResourceEditor,
  useApp,
  useAppState,
  useResourceEditor,
  useFieldUpdate,
  useDraftGuard,
  UpdateNotice,
  CallbackNotice,
  TargetScreen,
} from './index.js';
import { TestShell } from './shell.test.js';
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
  cleanups.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const definition = fields({ title: text('urn:name', { language: null }) });
function Form() {
  const editor = useResourceEditor('urn:item', definition);
  return (
    <ResourceEditor editor={editor}>
      {(draft, change) => (
        <input
          aria-label="Title"
          value={draft.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      )}
    </ResourceEditor>
  );
}
function Picker() {
  const app = useApp();
  return (
    <button onClick={() => void app.selectContext(personal)}>
      Custom picker
    </button>
  );
}
async function connected(f = fixture()) {
  const session = await f.login();
  f.setResource(async () =>
    Response.json(
      { '@id': 'urn:item', 'urn:name': [{ '@value': 'Original' }] },
      { headers: { etag: '"v1"' } },
    ),
  );
  cleanups.push(() => session.runtime.dispose());
  return { ...f, ...session };
}
it('keeps a dirty editor across locale, equivalent props, write/read loss and recovery', async () => {
  const f = await connected();
  const ui = (language: 'en' | 'de') => (
    <SempodsProvider
      runtime={f.runtime}
      language={language}
      messages={{ controls: { save: language === 'en' ? 'Store' : 'Ablegen' } }}
    >
      <TestShell>
        <Form />
      </TestShell>
    </SempodsProvider>
  );
  const mounted = render(ui('en'));
  await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Mine' },
  });
  mounted.rerender(ui('de'));
  expect(screen.getByDisplayValue('Mine')).toBeTruthy();
  expect(screen.getByText('Ablegen')).toBeTruthy();
  await act(() => f.runtime.loadContexts(f.id));
  expect(screen.getByDisplayValue('Mine')).toBeTruthy();
  f.setCatalogue(async () => catalogue([work, personal], []));
  await act(() => f.runtime.loadContexts(f.id));
  expect((screen.getByText('Ablegen') as HTMLButtonElement).disabled).toBe(
    true,
  );
  f.setCatalogue(async () => catalogue([personal], []));
  await act(() => f.runtime.loadContexts(f.id));
  expect(screen.getByDisplayValue('Mine')).toBeTruthy();
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  await screen.findByRole('alert');
  expect(screen.getByDisplayValue('Mine')).toBeTruthy();
});
it('replacement picker uses guarded actions and confirmation restores focus on cancellation', async () => {
  const f = await connected();
  render(
    <SempodsProvider runtime={f.runtime}>
      <TestShell components={{ Connections: Picker }}>
        <Form />
      </TestShell>
    </SempodsProvider>,
  );
  await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Unfinished' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Pods & sharing' }));
  const picker = screen.getByText('Custom picker');
  picker.focus();
  fireEvent.click(picker);
  const dialog = await screen.findByRole('alertdialog');
  expect(document.activeElement?.textContent).toBe('Keep editing');
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(document.activeElement).toBe(picker);
  expect(f.runtime.bind(f.id).contextIri).toBe(work);
  fireEvent.click(picker);
  fireEvent.click(await screen.findByText('Discard and continue'));
  await waitFor(() => expect(f.runtime.bind(f.id).contextIri).toBe(personal));
  await waitFor(() =>
    expect(screen.queryByDisplayValue('Unfinished')).toBeNull(),
  );
});
it('guards an app-owned creation draft', async () => {
  const f = await connected();
  function Creation() {
    const [value, setValue] = useState('');
    useDraftGuard(Boolean(value), () => setValue(''));
    return (
      <input
        aria-label="New task"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <Picker />
      <Creation />
    </SempodsProvider>,
  );
  fireEvent.change(screen.getByLabelText('New task'), {
    target: { value: 'New' },
  });
  fireEvent.click(screen.getByText('Custom picker'));
  await screen.findByRole('alertdialog');
  expect(f.runtime.bind(f.id).contextIri).toBe(work);
});
it('renders loading before startup and a localized busy notice without mounting screens', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  const gate = deferred<StartupReport>();
  vi.spyOn(f.runtime, 'initialize').mockReturnValue(gate.promise);
  const mounted = render(
    <SempodsProvider runtime={f.runtime}>
      <TestShell>
        <p>Tasks mounted</p>
      </TestShell>
    </SempodsProvider>,
  );
  expect(screen.queryByText('Tasks mounted')).toBeNull();
  expect(screen.getByText('Loading…')).toBeTruthy();
  await act(async () =>
    gate.resolve({ storage: 'busy', interaction: 'none', unreadable: [] }),
  );
  expect(screen.getByRole('alert').textContent).toMatch(/another tab/i);
  expect(screen.queryByText('Tasks mounted')).toBeNull();
  mounted.rerender(
    <SempodsProvider runtime={f.runtime} language="de">
      <TestShell>
        <p>Tasks mounted</p>
      </TestShell>
    </SempodsProvider>,
  );
  expect(screen.getByRole('alert').textContent).toMatch(/Tab/);
});
it.each(['en', 'de'] as const)(
  'unknown mutation feedback stays uncertain in %s',
  (language) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider
        runtime={f.runtime as BrowserRuntime}
        language={language}
      >
        <UpdateNotice outcome={{ kind: 'unconfirmed' }} />
      </SempodsProvider>,
    );
    expect(screen.getByRole('status').textContent).toMatch(
      language === 'en' ? /unconfirmed/i : /bestätigt/i,
    );
  },
);

it('requires a successful comparison and explicit acknowledgement of uncertain changes', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  const check = vi.fn(async () => false);
  const acknowledge = vi.fn();
  render(
    <SempodsProvider runtime={f.runtime}>
      <UpdateNotice
        outcome={{ kind: 'unconfirmed' }}
        onCheck={check}
        onAcknowledge={acknowledge}
      />
    </SempodsProvider>,
  );
  const button = screen.getByText(
    'I have checked the pod',
  ) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(screen.getByText('Check current version'));
  await waitFor(() => expect(check).toHaveBeenCalledOnce());
  expect(button.disabled).toBe(true);
  check.mockResolvedValue(true);
  fireEvent.click(screen.getByText('Check current version'));
  await waitFor(() => expect(button.disabled).toBe(false));
  expect(acknowledge).not.toHaveBeenCalled();
  fireEvent.click(button);
  expect(acknowledge).toHaveBeenCalledOnce();
});

it.each(['en', 'de'] as const)(
  'blocks the standard composition when session storage is unavailable (%s)',
  async (language) => {
    const f = fixture({
      openStore: async () => {
        throw new Error('fixture storage failure');
      },
    });
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime} language={language}>
        <TestShell>
          <p>Tasks mounted</p>
        </TestShell>
      </SempodsProvider>,
    );
    const message = await screen.findByRole('alert');
    expect(message.textContent).toMatch(
      language === 'en' ? /storage could not be opened/ : /Sitzungsspeicher/,
    );
    expect(screen.queryByText('Tasks mounted')).toBeNull();
    // No sign-in can start without durable storage.
    expect(
      screen.queryByRole('button', {
        name: language === 'en' ? 'Sign in' : 'Anmelden',
      }),
    ).toBeNull();
  },
);

it('keeps an uncertain creation and unrelated draft after confirmed same-view row navigation', async () => {
  const f = await connected();
  f.setResource(async () => new Response(null, { status: 202 }));
  function Rows() {
    const mutation = useFieldUpdate(definition);
    const app = useApp();
    const [row, setRow] = useState('A');
    const [title, setTitle] = useState('New task');
    const [rowDraft, setRowDraft] = useState('Row draft');
    useDraftGuard(Boolean(title), () => setTitle(''));
    useDraftGuard(Boolean(rowDraft), () => setRowDraft(''), 'local');
    return (
      <>
        <button
          onClick={() =>
            void mutation.create('urn:new', {
              '@id': 'urn:new',
              'urn:name': [{ '@value': 'New' }],
            })
          }
        >
          Create
        </button>
        <button onClick={() => void app.navigate(() => setRow('B'))}>
          Other row
        </button>
        <p>{row}</p>
        <p>{title}</p>
        <p>{rowDraft}</p>
        <p>{mutation.outcome?.kind ?? 'No outcome'}</p>
        <UpdateNotice
          outcome={mutation.outcome}
          onCheck={async () => true}
          onAcknowledge={mutation.acknowledge}
        />
      </>
    );
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <Rows />
    </SempodsProvider>,
  );
  // The view exists once startup has settled (#80).
  await act(async () => {});
  fireEvent.click(screen.getByText('Create'));
  await screen.findByText('unconfirmed');
  fireEvent.click(screen.getByText('Other row'));
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByText('Discard and continue'));
  await screen.findByText('B');
  expect(screen.getByText('unconfirmed')).toBeTruthy();
  expect(screen.getByText('New task')).toBeTruthy();
  expect(screen.queryByText('Row draft')).toBeNull();
  expect(
    (screen.getByText('I have checked the pod') as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByText('Check current version'));
  await waitFor(() =>
    expect(
      (screen.getByText('I have checked the pod') as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByText('I have checked the pod'));
  await screen.findByText('No outcome');
  expect(screen.getByText('New task')).toBeTruthy();
});

it.each(['success', 'failure'] as const)(
  'ignores a superseded comparison %s while the current outcome is being checked',
  async (settlement) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    const oldCheck = deferred<boolean>();
    const currentCheck = deferred<boolean>();
    const check = vi
      .fn<() => Promise<boolean>>()
      .mockReturnValueOnce(oldCheck.promise)
      .mockReturnValueOnce(currentCheck.promise);
    const acknowledge = vi.fn();
    const first = { kind: 'unconfirmed' as const };
    const second = { kind: 'unconfirmed' as const };
    const ui = (outcome: typeof first | null) => (
      <SempodsProvider runtime={f.runtime}>
        <UpdateNotice
          outcome={outcome}
          onCheck={check}
          onAcknowledge={acknowledge}
        />
      </SempodsProvider>
    );
    const mounted = render(ui(first));
    fireEvent.click(screen.getByText('Check current version'));
    // Discard the first operation, then show a second uncertain operation.
    mounted.rerender(ui(null));
    mounted.rerender(ui(second));
    const compare = screen.getByText(
      'Check current version',
    ) as HTMLButtonElement;
    const confirm = screen.getByText(
      'I have checked the pod',
    ) as HTMLButtonElement;
    expect(compare.disabled).toBe(false);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(compare);
    await act(async () => {
      if (settlement === 'success') oldCheck.resolve(true);
      else oldCheck.reject(new Error('Old comparison failed'));
    });
    expect(compare.disabled).toBe(true);
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(acknowledge).not.toHaveBeenCalled();
    await act(async () => currentCheck.resolve(true));
    expect(compare.disabled).toBe(false);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(acknowledge).toHaveBeenCalledOnce();
  },
);

it.each([
  ['Save', 'Discard changes'],
  ['Save', 'Continue with my changes'],
  ['Delete', 'Discard changes'],
  ['Delete', 'Continue with my changes'],
])(
  'clears %s review feedback after %s',
  async (operation, recovery) => {
    const f = await connected();
    render(
      <SempodsProvider runtime={f.runtime}>
        <Form />
      </SempodsProvider>,
    );
    await screen.findByDisplayValue('Original');
    fireEvent.change(screen.getByLabelText('Title'), {
      target: { value: 'Mine' },
    });
    const request = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH' || init?.method === 'DELETE')
        return new Response(null, { status: 412 });
      return Response.json(
        { '@id': 'urn:item', 'urn:name': [{ '@value': 'Theirs' }] },
        { headers: { etag: '"v2"' } },
      );
    });
    f.setResource(request);
    // A background refresh briefly disables saving and deleting (the editor
    // is reading); act only once the control is enabled.
    const enabled = async (button: HTMLElement) => {
      await waitFor(() =>
        expect((button as HTMLButtonElement).disabled).toBe(false),
      );
      return button;
    };
    fireEvent.click(
      await enabled(screen.getByRole('button', { name: operation })),
    );
    // Delete asks first; the confirmation replaces the action row.
    if (operation === 'Delete')
      fireEvent.click(
        await enabled(
          within(screen.getByRole('alertdialog', asked)).getByRole('button', {
            name: 'Delete',
          }),
        ),
      );
    // The write left: a lost click would otherwise surface only as a missing alert.
    await waitFor(() =>
      expect(
        request.mock.calls.some(
          ([, init]) => init?.method === 'PATCH' || init?.method === 'DELETE',
        ),
      ).toBe(true),
    );
    const changed = 'The pod has changed. Compare before continuing.';
    // The first case runs the review path cold (about five times slower than the
    // others locally); loaded CI runners have needed more than five seconds.
    await screen.findByRole('alert', {}, { timeout: 12_000 });
    expect(screen.getByText(changed)).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByText(recovery) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByText(recovery));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(changed)).toBeNull();
    expect(
      screen.getByDisplayValue(
        recovery === 'Discard changes' ? 'Theirs' : 'Mine',
      ),
    ).toBeTruthy();
    expect(
      request.mock.calls.filter(
        ([, init]) => init?.method === 'PATCH' || init?.method === 'DELETE',
      ),
    ).toHaveLength(1);
    // The alert wait above may take up to twelve seconds; the test needs room
    // beyond it, or a loaded runner hits the test timeout first.
  },
  20_000,
);

const asked = { name: 'Delete this from the pod? This cannot be undone.' };
/** Records conditional DELETEs; reads answer the current version. */
function deletions(f: Awaited<ReturnType<typeof connected>>) {
  const pod = { value: 'Original', version: 1 };
  const deletes: (string | null)[] = [];
  let answer: () => Promise<Response> = async () =>
    new Response(null, { status: 204 });
  f.setResource(async (_url, init) => {
    if (init?.method === 'DELETE') {
      deletes.push(new Headers(init.headers).get('if-match'));
      return answer();
    }
    return Response.json(
      { '@id': 'urn:item', 'urn:name': [{ '@value': pod.value }] },
      { headers: { etag: `"v${pod.version}"` } },
    );
  });
  return {
    pod,
    deletes,
    answer: (next: () => Promise<Response>) => void (answer = next),
  };
}
let shownEditor: { refresh(): Promise<void> } | null = null;
function SubjectForm({ subject }: { readonly subject: string }) {
  const editor = useResourceEditor(subject, definition);
  shownEditor = editor;
  return (
    <ResourceEditor editor={editor}>
      {(draft, change) => (
        <input
          aria-label="Title"
          value={draft.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      )}
    </ResourceEditor>
  );
}

it.each([
  [
    'en',
    {
      remove: 'Delete',
      cancel: 'Cancel',
      ask: 'Delete this from the pod? This cannot be undone.',
      removed: 'Deleted.',
    },
  ],
  [
    'de',
    {
      remove: 'Löschen',
      cancel: 'Abbrechen',
      ask: 'Vom Pod löschen? Das lässt sich nicht rückgängig machen.',
      removed: 'Gelöscht.',
    },
  ],
] as const)(
  'asks in the editor before deleting; cancel and Escape keep the draft (%s)',
  async (language, text) => {
    const f = await connected();
    const { deletes } = deletions(f);
    render(
      <SempodsProvider runtime={f.runtime} language={language}>
        <Form />
      </SempodsProvider>,
    );
    await screen.findByDisplayValue('Original');
    const remove = screen.getByRole('button', { name: text.remove });
    fireEvent.click(remove);
    const ask = screen.getByRole('alertdialog', { name: text.ask });
    const cancel = within(ask).getByRole('button', { name: text.cancel });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(screen.queryByRole('alertdialog', { name: text.ask })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: text.remove }),
    );
    fireEvent.click(screen.getByRole('button', { name: text.remove }));
    fireEvent.keyDown(screen.getByRole('alertdialog', { name: text.ask }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('alertdialog', { name: text.ask })).toBeNull();
    expect(screen.getByDisplayValue('Original')).toBeTruthy();
    await act(async () => {});
    expect(deletes).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: text.remove }));
    const confirm = within(
      screen.getByRole('alertdialog', { name: text.ask }),
    ).getByRole('button', { name: text.remove });
    fireEvent.click(confirm);
    // A second press reaches no confirmation and sends nothing more.
    fireEvent.click(confirm);
    await screen.findByText(text.removed);
    expect(deletes).toEqual(['"v1"']);
  },
);

it('withdraws the delete question for an edit, a newer version and lost write access', async () => {
  const f = await connected();
  const { pod, deletes } = deletions(f);
  render(
    <SempodsProvider runtime={f.runtime}>
      <SubjectForm subject="urn:item" />
    </SempodsProvider>,
  );
  await screen.findByDisplayValue('Original');
  const ask = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  // An edit while asked: the question is about the shown state only.
  ask();
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Typed' },
  });
  expect(screen.queryByRole('alertdialog', asked)).toBeNull();
  fireEvent.click(screen.getByText('Discard changes'));
  // A newer version adopted while asked withdraws the question; the next
  // confirmation deletes that version.
  ask();
  pod.value = 'Newer';
  pod.version = 2;
  await act(() => shownEditor!.refresh());
  await screen.findByDisplayValue('Newer');
  expect(screen.queryByRole('alertdialog', asked)).toBeNull();
  // Lost write access withdraws it and disables Delete.
  ask();
  f.setCatalogue(async () => catalogue([work], []));
  await act(() => f.runtime.loadContexts(f.id));
  expect(screen.queryByRole('alertdialog', asked)).toBeNull();
  expect(
    (screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(deletes).toEqual([]);
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  ask();
  fireEvent.click(
    within(screen.getByRole('alertdialog', asked)).getByRole('button', {
      name: 'Delete',
    }),
  );
  await screen.findByText('Deleted.');
  expect(deletes).toEqual(['"v2"']);
});

it('withdraws the delete question when the editor moves to another subject', async () => {
  const f = await connected();
  const { deletes } = deletions(f);
  const ui = (subject: string) => (
    <SempodsProvider runtime={f.runtime}>
      <SubjectForm subject={subject} />
    </SempodsProvider>
  );
  const mounted = render(ui('urn:item'));
  await screen.findByDisplayValue('Original');
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('alertdialog', asked)).toBeTruthy();
  mounted.rerender(ui('urn:other'));
  await screen.findByDisplayValue('Original');
  expect(screen.queryByRole('alertdialog', asked)).toBeNull();
  expect(deletes).toEqual([]);
});

it.each([
  [
    'changed on the pod (412)',
    412,
    'The pod has changed. Compare before continuing.',
  ],
  ['missing (404)', 404, null],
  [
    'lost',
    'lost',
    'The result is unconfirmed. Check the pod before deciding; nothing is retried automatically.',
  ],
] as const)(
  'a confirmed delete that is %s is neither reported as deleted nor retried',
  async (_case, status, alert) => {
    const f = await connected();
    const { deletes, answer } = deletions(f);
    answer(async () => {
      if (status === 'lost') throw new TypeError('connection lost');
      return new Response(null, { status });
    });
    render(
      <SempodsProvider runtime={f.runtime}>
        <Form />
      </SempodsProvider>,
    );
    await screen.findByDisplayValue('Original');
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(
      within(screen.getByRole('alertdialog', asked)).getByRole('button', {
        name: 'Delete',
      }),
    );
    await waitFor(() => expect(deletes).toEqual(['"v1"']));
    if (alert) expect(await screen.findByText(alert)).toBeTruthy();
    else
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Check again' }),
        ).toBeTruthy(),
      );
    await act(async () => {});
    expect(screen.queryByText('Deleted.')).toBeNull();
    expect(deletes).toEqual(['"v1"']);
  },
);

it('retires saved feedback through a newer draft, access recovery and review', async () => {
  const f = await connected();
  let value = 'Original';
  f.setResource(async (_url, init) => {
    if (init?.method === 'PATCH') {
      value = 'Saved draft';
      return new Response(null, { status: 204 });
    }
    return Response.json(
      { '@id': 'urn:item', 'urn:name': [{ '@value': value }] },
      { headers: { etag: '"v2"' } },
    );
  });
  render(
    <SempodsProvider runtime={f.runtime}>
      <Form />
    </SempodsProvider>,
  );
  await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Saved draft' },
  });
  fireEvent.click(screen.getByText('Save'));
  await screen.findByText('Saved.');
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'New draft' },
  });
  expect(screen.queryByText('Saved.')).toBeNull();
  value = 'Changed elsewhere';
  f.setCatalogue(async () => catalogue([personal], []));
  await act(() => f.runtime.loadContexts(f.id));
  f.setCatalogue(async () => catalogue());
  await act(() => f.runtime.loadContexts(f.id));
  await screen.findByRole('alert');
  await waitFor(() =>
    expect(
      (screen.getByText('Continue with my changes') as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByText('Continue with my changes'));
  expect(screen.getByDisplayValue('New draft')).toBeTruthy();
  expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(false);
  expect(screen.queryByText('Saved.')).toBeNull();
  fireEvent.click(screen.getByText('Discard changes'));
  expect(screen.queryByText('Saved.')).toBeNull();
});

it('does not report a newer draft as saved when it was typed during a slow save', async () => {
  const f = await connected();
  const saving = deferred<Response>();
  let value = 'Original';
  f.setResource(async (_url, init) => {
    if (init?.method === 'PATCH') return saving.promise;
    return Response.json(
      { '@id': 'urn:item', 'urn:name': [{ '@value': value }] },
      { headers: { etag: '"v2"' } },
    );
  });
  render(
    <SempodsProvider runtime={f.runtime}>
      <Form />
    </SempodsProvider>,
  );
  await screen.findByDisplayValue('Original');
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Submitted' },
  });
  fireEvent.click(screen.getByText('Save'));
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Newer draft' },
  });
  value = 'Submitted';
  await act(async () => saving.resolve(new Response(null, { status: 204 })));
  await waitFor(() =>
    expect((screen.getByText('Save') as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect(screen.getByDisplayValue('Newer draft')).toBeTruthy();
  expect(screen.queryByText('Saved.')).toBeNull();
  fireEvent.click(screen.getByText('Discard changes'));
  expect(screen.getByDisplayValue('Submitted')).toBeTruthy();
  expect(screen.queryByText('Saved.')).toBeNull();
});

it.each(['en', 'de'] as const)(
  'names an unconfirmed write when leaving its target (%s)',
  async (language) => {
    const f = await connected();
    f.setResource(async () => new Response(null, { status: 202 }));
    function Creation() {
      const mutation = useFieldUpdate(definition);
      return (
        <>
          <button
            onClick={() =>
              void mutation.create('urn:new', { '@id': 'urn:new' })
            }
          >
            Create
          </button>
          <p>{mutation.outcome?.kind}</p>
        </>
      );
    }
    render(
      <SempodsProvider runtime={f.runtime} language={language}>
        <Creation />
        <Picker />
      </SempodsProvider>,
    );
    // The view exists once startup has settled (#80).
    await act(async () => {});
    fireEvent.click(screen.getByText('Create'));
    await screen.findByText('unconfirmed');
    fireEvent.click(screen.getByText('Custom picker'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toMatch(
      language === 'en'
        ? /write is still unconfirmed/
        : /Schreibaktion ist noch unbestätigt/,
    );
  },
);

it.each(['connect', 'authorize'] as const)(
  'makes provider content inert throughout %s preparation and restores it after failure',
  async (operation) => {
    const f = await connected();
    const preparing = deferred<void>();
    vi.spyOn(f.runtime, 'beginAuthorization').mockReturnValue(
      preparing.promise,
    );
    function Actions() {
      const app = useApp();
      const [value, setValue] = useState('');
      useDraftGuard(Boolean(value), () => setValue(''));
      return (
        <>
          <input
            aria-label="New draft"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <button
            onClick={() =>
              void (
                operation === 'connect'
                  ? app.connect('https://pod.example/alice')
                  : app.authorize(f.id)
              ).catch(() => {})
            }
          >
            Navigate
          </button>
        </>
      );
    }
    vi.spyOn(f.runtime, 'connect').mockResolvedValue(
      f.runtime.getSnapshot()[0]!,
    );
    render(
      <SempodsProvider runtime={f.runtime}>
        <Actions />
      </SempodsProvider>,
    );
    const input = screen.getByLabelText('New draft');
    expect(input.closest('[inert]')).toBeNull();
    fireEvent.click(screen.getByText('Navigate'));
    expect(input.closest('[inert]')).not.toBeNull();
    await waitFor(() =>
      expect(f.runtime.beginAuthorization).toHaveBeenCalledOnce(),
    );
    await act(async () => preparing.reject(new Error('Could not prepare')));
    expect(input.closest('[inert]')).toBeNull();
  },
);

it.each([
  [
    'en',
    'access_denied',
    'cancelled',
    'No access was granted: the sign-in was cancelled or declined at the Pod. Sign in again to choose what to share.',
  ],
  [
    'de',
    'access_denied',
    'cancelled',
    'Es wurde kein Zugriff erteilt: Die Anmeldung wurde beim Pod abgebrochen oder abgelehnt. Melde dich erneut an, um eine Freigabe zu wählen.',
  ],
  [
    'en',
    'login_required',
    'failed',
    'The pod asked you to sign in at its provider first. Sign in there, then try again.',
  ],
  [
    'de',
    'login_required',
    'failed',
    'Der Pod verlangt, dass du dich zuerst bei seinem Anbieter anmeldest. Melde dich dort an und versuche es dann erneut.',
  ],
  ['en', 'refused-exchange', 'failed', 'Sign-in failed. Try again.'],
  // An unknown attempt has no protocol cause: the generic text remains.
  ['en', 'unknown-state', 'failed', 'The operation could not be completed.'],
] as const)(
  'presents a real %s callback (%s) with its cause',
  async (language, kind, interaction, text) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    const { authorization } = await f.begin();
    f.runtime.dispose();
    await settleLease();
    const state =
      kind === 'unknown-state'
        ? 'x'.repeat(43)
        : authorization.searchParams.get('state');
    if (kind === 'refused-exchange')
      f.setToken(async () =>
        Response.json({ error: 'invalid_grant' }, { status: 400 }),
      );
    const returned = createBrowserRuntime({
      ...f.options,
      location: () =>
        kind === 'access_denied' || kind === 'login_required'
          ? `${callback}?error=${kind}&state=${state}`
          : `${callback}?code=fixture-code&state=${state}`,
    });
    cleanups.push(() => returned.dispose());
    render(
      <SempodsProvider runtime={returned} language={language}>
        <TestShell>
          <p>Tasks mounted</p>
        </TestShell>
      </SempodsProvider>,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    expect((await returned.initialize()).interaction).toBe(interaction);
    // Recovery stays available next to the message.
    expect(screen.getByText('Tasks mounted')).toBeTruthy();
  },
);

it('names why connecting failed instead of a generic failure', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <TestShell>
        <p>Tasks mounted</p>
      </TestShell>
    </SempodsProvider>,
  );
  await screen.findByText('Tasks mounted');
  f.fetch.mockRejectedValue(new TypeError('offline'));
  fireEvent.change(screen.getByLabelText('Pod address'), {
    target: { value: 'https://pod.example/carol' },
  });
  fireEvent.submit(screen.getByLabelText('Pod address').closest('form')!);
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The pod’s connection information could not be loaded. Try again.',
  );
});

it.each([
  [
    'en',
    'No access was granted: the sign-in was cancelled or declined at the Pod. Sign in again to choose what to share.',
  ],
  [
    'de',
    'Es wurde kein Zugriff erteilt: Die Anmeldung wurde beim Pod abgebrochen oder abgelehnt. Melde dich erneut an, um eine Freigabe zu wählen.',
  ],
] as const)(
  'a custom layout places CallbackNotice next to working recovery controls (%s)',
  async (language, text) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    const { authorization } = await f.begin();
    f.runtime.dispose();
    await settleLease();
    const returned = createBrowserRuntime({
      ...f.options,
      location: () =>
        `${callback}?error=access_denied&state=${authorization.searchParams.get('state')}`,
    });
    cleanups.push(() => returned.dispose());
    // A custom layout without AppAccess: its own recovery control.
    function Recovery() {
      const app = useApp();
      const { activeId } = useAppState();
      return (
        <button onClick={() => void app.authorize(activeId!)}>
          {language === 'en' ? 'Sign in' : 'Anmelden'}
        </button>
      );
    }
    render(
      <SempodsProvider runtime={returned} language={language}>
        <main>
          <CallbackNotice />
          <Recovery />
        </main>
      </SempodsProvider>,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(text);
    // The person can sign in again right there.
    const navigations = f.navigate.mock.calls.length;
    fireEvent.click(
      screen.getByRole('button', {
        name: language === 'en' ? 'Sign in' : 'Anmelden',
      }),
    );
    await waitFor(() =>
      expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
    );
  },
);

it.each([
  ['en', 'Yes', 'No'],
  ['de', 'Ja', 'Nein'],
] as const)(
  'comparisons show field labels and localized values (%s)',
  (language, yes, no) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime} language={language}>
        <UpdateNotice
          outcome={{ kind: 'changed-on-pod', current: undefined }}
          current={{ title: 'Buy milk', done: true, note: null }}
          labels={{ title: 'Task', done: 'Done' }}
        />
        <UpdateNotice
          outcome={{ kind: 'unconfirmed' }}
          current={{ title: '', done: false }}
        />
      </SempodsProvider>,
    );
    const [labelled, plain] = screen.getAllByRole('region');
    expect(
      [...labelled!.querySelectorAll('dt, dd')].map((e) => e.textContent),
    ).toEqual(['Task', 'Buy milk', 'Done', yes, 'note', '—']);
    // Without labels the field key remains; empty text shows a dash.
    expect(
      [...plain!.querySelectorAll('dt, dd')].map((e) => e.textContent),
    ).toEqual(['title', '—', 'done', no]);
  },
);

it.each([
  ['en-US', ['1.0001', '1.0002', '0.0004', '1,234.5', '1e-7', '42']],
  ['de-DE', ['1,0001', '1,0002', '0,0004', '1.234,5', '1e-7', '42']],
] as const)(
  'comparisons never round distinct numbers to the same text (%s)',
  (locale, expected) => {
    const f = fixture();
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime} locale={locale}>
        <UpdateNotice
          outcome={{ kind: 'changed-on-pod', current: undefined }}
          current={{
            a: 1.0001,
            b: 1.0002,
            c: 0.0004,
            d: 1234.5,
            e: 1e-7,
            f: 42,
          }}
        />
      </SempodsProvider>,
    );
    expect(
      [...screen.getByRole('region').querySelectorAll('dd')].map(
        (e) => e.textContent,
      ),
    ).toEqual(expected);
  },
);

it('shows the no-contexts message when the Pod grants no readable context', async () => {
  const f = fixture();
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  f.setCatalogue(async () => catalogue([], []));
  render(
    <SempodsProvider runtime={session.runtime}>
      <AppAccess appName="Tasks" open />
    </SempodsProvider>,
  );
  await act(async () => {
    await session.runtime.loadContexts(session.id);
  });
  expect(
    await screen.findByText('No readable contexts. Review access on this pod.'),
  ).toBeTruthy();
  expect(
    (screen.getByLabelText('Data context') as HTMLSelectElement).disabled,
  ).toBe(true);
});

it.each(['access', 'connections'] as const)(
  '%s shows the selected late label, disambiguates fallback duplicates and retains target/draft through cached reload',
  async (kind) => {
    const source = fixture();
    const pending = deferred<void>();
    let labels: Record<string, string> = {
      [work]: '  personal\u202e  ',
      [personal]: 'Team',
    };
    source.setDescriptions(async (url) => {
      await pending.promise;
      return Response.json({
        '@id': url,
        '@type': ['http://www.w3.org/ns/sparql-service-description#NamedGraph'],
        'http://www.w3.org/ns/sparql-service-description#name': [
          { '@id': url },
        ],
        'https://schema.sempods.org/public': [{ '@value': false }],
        ...(labels[url]
          ? {
              'http://www.w3.org/2000/01/rdf-schema#label': [
                { '@value': labels[url] },
              ],
            }
          : {}),
      });
    });
    const f = await connected(source);
    render(
      <SempodsProvider runtime={f.runtime}>
        {kind === 'access' ? (
          <AppAccess appName="Notes" open />
        ) : (
          <AppAccess appName="Tasks" open />
        )}
        <Form />
      </SempodsProvider>,
    );
    await screen.findByDisplayValue('Original');
    const field = screen.getByLabelText('Title');
    fireEvent.change(field, { target: { value: 'Unsaved' } });
    await act(() => f.runtime.loadContexts(f.id));
    await screen.findByRole('option', { name: 'work' });
    await act(async () => pending.resolve());
    const option = await screen.findByRole('option', {
      name: `personal · ${work}`,
    });
    expect((option as HTMLOptionElement).value).toBe(work);
    expect(
      screen.getByRole('option', { name: `personal · ${personal}` }),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText('Data context') as HTMLSelectElement).value,
    ).toBe(work);
    expect(screen.getByLabelText('Title')).toBe(field);
    expect((field as HTMLInputElement).value).toBe('Unsaved');
    const details = screen.getByText('Full addresses').closest('details')!;
    expect(details.textContent).toContain(work);
    expect(details.textContent).toContain(personal);
    labels = { [work]: 'Arbeit' };
    await act(() => f.runtime.loadContexts(f.id));
    // Unchanged catalogue authority reuses the selected label; no sweep or refresh.
    expect(
      (
        screen.getByRole('option', {
          name: `personal · ${work}`,
        }) as HTMLOptionElement
      ).value,
    ).toBe(work);
    expect(f.count('/_system/contexts/personal')).toBe(0);
    expect(f.count('/_system/contexts/work')).toBe(1);
    expect(screen.getByLabelText('Title')).toBe(field);
    expect((field as HTMLInputElement).value).toBe('Unsaved');
  },
);

it('shows no Context screen while a returning sign-in is still being redeemed', async () => {
  const f = await connected();
  const report = await f.runtime.initialize();
  const startup = deferred<StartupReport>();
  vi.spyOn(f.runtime, 'initialize').mockReturnValue(startup.promise);
  render(
    <SempodsProvider runtime={f.runtime}>
      <TargetScreen>
        <input aria-label="Draft" />
      </TargetScreen>
    </SempodsProvider>,
  );
  await act(async () => {});
  // The restored connection has a selected Context, but no draft can start yet.
  expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(work);
  expect(screen.queryByLabelText('Draft')).toBeNull();
  await act(async () => startup.resolve(report));
  expect(await screen.findByLabelText('Draft')).toBeTruthy();
});

it('keeps a connection-scoped app draft through a Context selection without asking', async () => {
  const f = await connected();
  const discard = vi.fn();
  function Draft() {
    const app = useApp();
    useDraftGuard(true, discard, 'connection');
    return (
      <button onClick={() => void app.selectContext(personal)}>
        Select personal
      </button>
    );
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <Draft />
    </SempodsProvider>,
  );
  await act(async () => {});
  fireEvent.click(screen.getByText('Select personal'));
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.selectedContext).toBe(personal),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(discard).not.toHaveBeenCalled();
});

it('keeps the delete question through a view notification that leaves access unchanged', async () => {
  const f = await connected();
  const { deletes } = deletions(f);
  render(
    <SempodsProvider runtime={f.runtime}>
      <Form />
    </SempodsProvider>,
  );
  await screen.findByDisplayValue('Original');
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  const ask = screen.getByRole('alertdialog', asked);
  // An unchanged catalogue reload notifies the view without changing access.
  await act(async () => {
    await f.runtime.loadContexts(f.id);
  });
  expect(screen.getByRole('alertdialog', asked)).toBe(ask);
  fireEvent.click(within(ask).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(deletes).toEqual(['"v1"']));
});
