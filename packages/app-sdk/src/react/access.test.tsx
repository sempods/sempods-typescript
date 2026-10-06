// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
  useCreation,
  useAppState,
  useWorkflowAccess,
} from './index.js';
import {
  fixture,
  pod,
  work,
  catalogue,
  settleLease,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
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

it.each(['en', 'de'] as const)(
  'one permitted Pod needs only explicit sign-in, supports an optional icon and retries (%s)',
  async (language) => {
    const f = fixture({ allowedPods: [pod] });
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime} language={language}>
        <AppAccess
          appName="Shopping"
          icon={<img src="/app.png" alt="" />}
          podNames={{ [pod]: 'Personal' }}
        />
      </SempodsProvider>,
    );
    const button = await screen.findByRole('button', {
      name: language === 'en' ? 'Sign in' : 'Anmelden',
    });
    expect(
      screen.getByRole('heading', { name: 'Shopping', level: 1 }),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText('Personal')).toBeTruthy();
    expect(screen.getByText(pod)).toBeTruthy();
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    f.fetch.mockRejectedValueOnce(new Error('offline'));
    await act(async () => button.click());
    expect(await screen.findByRole('alert')).toBeTruthy();
    await act(async () => button.click());
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  },
);

it('offers only the permitted finite choices, disambiguates names and does not sign in on selection', async () => {
  const other = 'https://pod.example/bob';
  const f = fixture({ allowedPods: [pod, other] });
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess
        appName="Shopping"
        podNames={{ [pod]: 'My Pod', [other]: 'My Pod' }}
      />
    </SempodsProvider>,
  );
  const picker = await screen.findByLabelText('Your Pod');
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(
    screen.getByRole('option', { name: `My Pod · ${other}` }),
  ).toBeTruthy();
  fireEvent.change(picker, { target: { value: other } });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
  await act(async () =>
    screen.getByRole('button', { name: 'Sign in' }).click(),
  );
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  expect(f.runtime.getSnapshot()[0]!.podUrl).toBe(other);
});

it('keeps an unrestricted preset a default and offers another Pod in explicit management', async () => {
  const f = fixture({ preset: { podUrl: pod } });
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <Host />
    </SempodsProvider>,
  );
  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.queryByRole('textbox', { name: 'Your Pod' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  const input = screen.getByRole('textbox', { name: 'Your Pod' });
  fireEvent.change(input, { target: { value: 'https://pod.example/bob' } });
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  expect(f.runtime.getSnapshot()[0]!.podUrl).toBe('https://pod.example/bob');
});

it.each([
  'pod.example/alice',
  'pod.example/alice/',
  '  https://pod.example/alice/ \n',
])('cleans up pasted Pod input in presentation: %s', async (value) => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Shopping" />
    </SempodsProvider>,
  );
  const input = await screen.findByLabelText('Your Pod');
  fireEvent.change(input, { target: { value } });
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  expect(f.runtime.getSnapshot()[0]!.podUrl).toBe(pod);
});

it.each([
  'pod.example/alice?/',
  'pod.example/alice#/',
  'pod.example/alice//',
  'pod.example/al ice/',
  'https://user@pod.example/alice/',
  'pod.example/notes/../alice/',
])('keeps ambiguous Pod input rejected before requests: %s', async (value) => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Shopping" />
    </SempodsProvider>,
  );
  const input = await screen.findByLabelText('Your Pod');
  fireEvent.change(input, { target: { value } });
  await act(async () => fireEvent.submit(input.closest('form')!));
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.navigate).not.toHaveBeenCalled();
});

const fieldsForDraft = fields({ title: text('urn:title', { language: null }) });
function Draft() {
  const creation = useCreation(fieldsForDraft, {
    initial: { title: '' },
    collection: 'tasks',
  });
  const access = useWorkflowAccess();
  return (
    <input
      aria-label="Draft"
      value={creation.draft.title}
      disabled={!access.write || !creation.canEdit}
      onChange={(e) => creation.change({ title: e.target.value })}
    />
  );
}
function Host() {
  const { view } = useAppState();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      {view && <h1>My tasks</h1>}
      <button ref={button} onClick={() => setOpen(!open)}>
        Manage
      </button>
      <AppAccess
        appName="Shopping"
        open={open}
        focusTarget={button}
        style={{ display: 'grid' }}
      />
      <TargetScreen>
        <Draft />
      </TargetScreen>
    </>
  );
}
it('hides usable/read-only access, keeps drafts through read loss, and guards explicit management', async () => {
  const f = fixture();
  const logged = await f.login();
  cleanups.push(() => logged.runtime.dispose());
  render(
    <SempodsProvider runtime={logged.runtime}>
      <Host />
    </SempodsProvider>,
  );
  const draft = await screen.findByLabelText('Draft');
  fireEvent.change(draft, { target: { value: 'Keep this' } });
  expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull();
  const surface = document.querySelector('[data-sempods-access]')!;
  expect(getComputedStyle(surface).display).toBe('none');
  f.setCatalogue(async () => new Response(null, { status: 503 }));
  await act(async () => {
    await expect(logged.runtime.loadContexts(logged.id)).rejects.toThrow();
  });
  expect(screen.getByRole('region', { name: 'Data access' })).toBeTruthy();
  expect(getComputedStyle(surface).display).toBe('grid');
  expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  expect(
    screen.getByRole('heading', { level: 2, name: 'Data access' }),
  ).toBeTruthy();
  expect(
    screen.getByText('Context catalogue unavailable. Access is unknown.'),
  ).toBeTruthy();
  expect(screen.getByLabelText('Draft')).toBe(draft);
  f.setCatalogue(async () => catalogue([work], []));
  await act(async () => {
    await logged.runtime.loadContexts(logged.id);
  });
  expect((draft as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull();
  f.setCatalogue(async () => catalogue([], []));
  await act(async () => {
    await logged.runtime.loadContexts(logged.id);
  });
  expect(screen.getByRole('region', { name: 'Data access' })).toBeTruthy();
  expect(screen.getByLabelText('Draft')).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe('Keep this');
  f.setCatalogue(async () => catalogue());
  await act(async () =>
    screen.getByRole('button', { name: 'Check access' }).click(),
  );
  expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  expect(
    screen.getByRole('heading', { level: 2, name: 'Data access' }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Update access' }));
  expect(await screen.findByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect((draft as HTMLInputElement).value).toBe('Keep this');
});

it('keeps the current target and draft when sign-in preparation for a known other Pod fails', async () => {
  const other = 'https://pod.example/bob';
  const f = fixture({ allowedPods: [pod, other] });
  const logged = await f.login();
  cleanups.push(() => logged.runtime.dispose());
  await logged.runtime.connect(other);
  render(
    <SempodsProvider runtime={logged.runtime}>
      <Host />
    </SempodsProvider>,
  );
  const draft = await screen.findByLabelText('Draft');
  fireEvent.change(draft, { target: { value: 'Keep this on Alice' } });
  fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
  fireEvent.change(screen.getByLabelText('Your Pod'), {
    target: { value: other },
  });
  const navigations = f.navigate.mock.calls.length;
  f.fetch.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Discard and continue' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Draft')).toBe(draft);
  expect((draft as HTMLInputElement).value).toBe('Keep this on Alice');
  expect((screen.getByLabelText('Active pod') as HTMLSelectElement).value).toBe(
    logged.id,
  );
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect(logged.runtime.getSnapshot()).toHaveLength(2);
});

it('distinguishes failed catalogue, empty catalogue and exact unavailable target', async () => {
  const missing = pod + '/_system/contexts/missing';
  const f = fixture({ preset: { podUrl: pod, contextIri: missing } });
  await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" />
    </SempodsProvider>,
  );
  await screen.findByText(
    'The configured context is not readable on this Pod.',
  );
  expect(screen.queryByLabelText('Data context')).toBeNull();
  f.setCatalogue(async () => new Response(null, { status: 503 }));
  await act(async () =>
    screen.getByRole('button', { name: 'Check access' }).click(),
  );
  await screen.findByText('Context catalogue unavailable. Access is unknown.');
  expect(
    screen.queryByText('No readable contexts. Review access on this pod.'),
  ).toBeNull();
});

it('shows readable context names and full identities without selecting one automatically', async () => {
  const f = fixture();
  await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" />
    </SempodsProvider>,
  );
  const option = await screen.findByRole('option', { name: 'work' });
  expect((option as HTMLOptionElement).value).toBe(work);
  expect(
    (screen.getByLabelText('Data context') as HTMLSelectElement).value,
  ).toBe('');
  expect(screen.getByText(pod)).toBeTruthy();
});

it.each(['busy', 'unavailable'] as const)(
  'shows startup %s without a misleading sign-in action',
  async (storage) => {
    const f = fixture(
      storage === 'busy'
        ? {
            locks: {
              request: async (_n, _o, fn) => {
                await fn(null);
              },
            },
          }
        : {
            openStore: async () => {
              throw Error('unavailable');
            },
          },
    );
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime}>
        <AppAccess appName="Shopping" />
      </SempodsProvider>,
    );
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  },
);

it('preserves cancelled callback feedback and supports custom connection replacement', async () => {
  const f = fixture();
  const { authorization } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = createBrowserRuntime({
    ...f.options,
    location: () =>
      'https://app.example/oauth/callback?error=access_denied&state=' +
      authorization.searchParams.get('state'),
  });
  cleanups.push(() => runtime.dispose());
  function Replacement() {
    const state = useAppState();
    return <p>Custom {state.connections.length}</p>;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" components={{ Connections: Replacement }} />
    </SempodsProvider>,
  );
  expect(await screen.findByText('Sign-in was cancelled.')).toBeTruthy();
  expect(screen.getByText('Custom 1')).toBeTruthy();
});

it.each([
  { restricted: false, manage: false },
  { restricted: false, manage: true },
  { restricted: true, manage: false },
  { restricted: true, manage: true },
])(
  'single mode hides another preset Pod (restricted=$restricted, management=$manage)',
  async ({ restricted, manage }) => {
    const other = 'https://pod.example/bob';
    const f = fixture({
      preset: { podUrl: other },
      ...(restricted ? { allowedPods: [pod, other] } : {}),
    });
    const session = await f.login();
    cleanups.push(() => session.runtime.dispose());
    if (!manage) {
      f.setCatalogue(async () => new Response(null, { status: 503 }));
      await expect(session.runtime.loadContexts(session.id)).rejects.toThrow();
    }
    const ui = (mode: 'single' | 'multiple') => (
      <SempodsProvider runtime={session.runtime}>
        <AppAccess appName="Shopping" mode={mode} open={manage} />
      </SempodsProvider>
    );
    const mounted = render(ui('single'));
    await screen.findByRole('button', { name: 'Check access' });
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByLabelText('Your Pod')).toBeNull();
    expect(screen.getByRole('button', { name: 'Update access' })).toBeTruthy();
    mounted.rerender(ui('multiple'));
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    if (manage) {
      mounted.rerender(ui('single'));
      await act(async () =>
        screen.getByRole('button', { name: 'Disconnect' }).click(),
      );
      // Without a connection, single mode still permits the configured first sign-in.
      expect(
        await screen.findByRole('button', { name: 'Sign in' }),
      ).toBeTruthy();
    }
  },
);
