// @vitest-environment jsdom
import { StrictMode, useRef, useState } from 'react';
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
  AppAccess,
  SempodsProvider,
  TargetScreen,
  useApp,
  useCreation,
  useAppState,
  useWorkflowAccess,
} from './index.js';
import {
  fixture,
  pod,
  work,
  catalogue,
  deferred,
  jwt,
  settleLease,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntime } from '../runtime/types.js';
import type { BoundPod } from '../runtime/view.js';
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

it.each([true, false])(
  'one permitted Pod may omit its address from the first sign-in (podNames=%s)',
  async (named) => {
    const f = fixture({ allowedPods: [pod] });
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime}>
        <AppAccess
          appName="Shopping"
          podAddress="hidden"
          {...(named ? { podNames: { [pod]: 'Personal' } } : {})}
        />
      </SempodsProvider>,
    );
    const button = await screen.findByRole('button', { name: 'Sign in' });
    const region = screen.getByRole('region', { name: 'Data access' });
    expect(region.textContent).not.toContain(pod.replace(/^https?:\/\//, ''));
    expect(screen.queryByText('Personal')).toEqual(
      named ? expect.anything() : null,
    );
    await act(async () => button.click());
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  },
);

it.each([
  ['several permitted Pods', { allowedPods: [pod, 'https://pod.example/bob'] }],
  ['an unrestricted preset', { preset: { podUrl: pod } }],
] as const)('keeps the Pod address with %s', async (_, options) => {
  const f = fixture(options);
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess
        appName="Shopping"
        podAddress="hidden"
        podNames={{ [pod]: 'Personal' }}
      />
    </SempodsProvider>,
  );
  await screen.findByRole('button', { name: 'Sign in' });
  if ('allowedPods' in options)
    fireEvent.change(screen.getByLabelText('Your Pod'), {
      target: { value: pod },
    });
  expect(screen.getByText(pod)).toBeTruthy();
});

it('keeps the Pod address in management with one permitted Pod', async () => {
  const f = fixture({ allowedPods: [pod] });
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess
        appName="Shopping"
        podAddress="hidden"
        podNames={{ [pod]: 'Personal' }}
        open
      />
    </SempodsProvider>,
  );
  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.getByText('Personal')).toBeTruthy();
  expect(screen.getByText(pod)).toBeTruthy();
});

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

it.each(['select', 'disconnect'] as const)(
  'a login_required callback names its cause on its own connection and clears after %s',
  async (action) => {
    const other = 'https://pod.example/bob';
    const f = fixture();
    const session = await f.login();
    const bob = await session.runtime.connect(other);
    await session.runtime.beginAuthorization(bob.id);
    session.runtime.dispose();
    await settleLease();
    const runtime = f.returned(
      undefined,
      'error=login_required&error_description=Visit+evil.example',
    );
    cleanups.push(() => runtime.dispose());
    render(
      <SempodsProvider runtime={runtime}>
        <AppAccess appName="Shopping" />
      </SempodsProvider>,
    );
    const message =
      'The pod asked you to sign in at its provider first. Sign in there, then try again.';
    expect((await screen.findByRole('alert')).textContent).toBe(message);
    // Shown once, on the failed connection, which never claims access or a draft.
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.queryByText(/draft/)).toBeNull();
    expect(screen.queryByText(/evil/)).toBeNull();
    expect(
      runtime.getSnapshot().find((c) => c.id === bob.id)?.session,
    ).toMatchObject({ kind: 'ended', problem: 'login-required' });
    const picker = screen.getByLabelText<HTMLSelectElement>('Active pod');
    expect(picker.value).toBe(bob.id);
    expect(f.count('/token')).toBe(1);
    if (action === 'select')
      await act(async () =>
        fireEvent.change(picker, { target: { value: session.id } }),
      );
    else
      await act(async () =>
        screen.getByRole('button', { name: 'Disconnect' }).click(),
      );
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(runtime.getSnapshot().some((c) => c.id === bob.id)).toBe(
      action === 'select',
    );
  },
);

it.each([
  ['en', 'interrupted', 'Sign in to use this pod.'],
  ['de', 'interrupted', 'Melde dich an, um diesen Pod zu nutzen.'],
  ['en', 'expired', 'Sign in to use this pod.'],
] as const)(
  'an abandoned first sign-in asks to sign in without claiming a kept draft (%s, %s)',
  async (language, problem, text) => {
    const f = fixture();
    await f.begin();
    f.runtime.dispose();
    await settleLease();
    // Reopened later than the attempt's ten-minute lifetime.
    if (problem === 'expired')
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 600_001);
    const runtime = createBrowserRuntime(f.options);
    cleanups.push(() => runtime.dispose());
    render(
      <SempodsProvider runtime={runtime} language={language}>
        <AppAccess appName="Shopping" />
      </SempodsProvider>,
    );
    expect(await screen.findByText(text)).toBeTruthy();
    expect(runtime.getSnapshot()[0]!.session).toMatchObject({
      kind: 'ended',
      problem,
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/draft|Entwurf/)).toBeNull();
  },
);

it('keeps the address of the one permitted Pod hidden when signing in again', async () => {
  const f = fixture({ allowedPods: [pod] });
  await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = createBrowserRuntime(f.options);
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" podAddress="hidden" />
    </SempodsProvider>,
  );
  expect(await screen.findByText('Sign in to use this pod.')).toBeTruthy();
  expect(runtime.getSnapshot()[0]!.session.kind).toBe('ended');
  expect(screen.queryByText(pod.replace(/^https?:\/\//, ''))).toBeNull();
  // Full addresses still exposes the destination.
  expect(screen.getByText(pod)).toBeTruthy();
});

it('numbers saved duplicates of the one permitted Pod instead of showing its hidden address', async () => {
  const f = fixture();
  await f.runtime.initialize();
  for (let i = 0; i < 2; i++)
    await f.runtime.beginAuthorization((await f.runtime.connect(pod)).id);
  f.runtime.dispose();
  await settleLease();
  const runtime = createBrowserRuntime({ ...f.options, allowedPods: [pod] });
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" podAddress="hidden" />
    </SempodsProvider>,
  );
  const picker = await screen.findByRole('combobox', { name: 'Active pod' });
  expect(
    within(picker)
      .getAllByRole('option')
      .slice(1)
      .map((option) => option.textContent),
  ).toEqual(['1', '2']);
  expect(screen.queryByText(pod.replace(/^https?:\/\//, ''))).toBeNull();
});

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

function Started() {
  const { startup } = useAppState();
  return <output data-testid="startup">{startup ? 'started' : ''}</output>;
}
function Validating({ mode }: { readonly mode: 'on-demand' | 'required' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(!open)}>Manage</button>
      <AppAccess appName="Shopping" open={open} />
      <Started />
      {mode === 'required' && (
        <TargetScreen>
          <p>Context screen</p>
        </TargetScreen>
      )}
    </>
  );
}
/** While a connection validates, the surface shows its heading and loading status only. */
function expectLoadingOnly() {
  const region = screen.getByRole('region', { name: 'Data access' });
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  expect(within(region).queryByText('Full addresses')).toBeNull();
  expect(within(region).queryAllByRole('button')).toHaveLength(0);
  expect(within(region).queryAllByRole('combobox')).toHaveLength(0);
}

it.each(['on-demand', 'required'] as const)(
  'shows only the loading status while a saved connection restores (%s)',
  async (mode) => {
    const f = fixture({ allowedPods: [pod], preferences: null });
    const signed = await f.login();
    signed.runtime.dispose();
    await settleLease();
    const discovery = deferred<void>();
    const runtime = createBrowserRuntime({
      ...f.options,
      fetch: async (url, init) => {
        if (url.endsWith('/.well-known/oauth-protected-resource'))
          await discovery.promise;
        return f.fetch(url, init);
      },
    });
    cleanups.push(() => runtime.dispose());
    render(
      <SempodsProvider runtime={runtime} contextSelection={mode}>
        <Validating mode={mode} />
      </SempodsProvider>,
    );
    await screen.findByText('started');
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
    expectLoadingOnly();
    // Explicit management still shows the connection, including its addresses.
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(screen.getByText('Full addresses')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expectLoadingOnly();
    await act(async () => discovery.resolve());
    if (mode === 'on-demand')
      await waitFor(() =>
        expect(
          screen.queryByRole('region', { name: 'Data access' }),
        ).toBeNull(),
      );
    // A Context still awaiting a choice is a decision: the chooser appears.
    else await screen.findByRole('combobox', { name: 'Data context' });
    expect(screen.queryByText('Loading…')).toBeNull();
  },
);

it('shows only the loading status between the callback and a readable Pod reader', async () => {
  const f = fixture({ allowedPods: [pod], preferences: null });
  await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  cleanups.push(() => runtime.dispose());
  // A signed-in reader that becomes readable only after a delay.
  let readable = false;
  const listeners = new Set<() => void>();
  const readers = new WeakMap<BoundPod, BoundPod>();
  const held = new WeakMap<object, ReturnType<BoundPod['getSnapshot']>>();
  const bindPod = runtime.bindPod;
  vi.spyOn(runtime, 'bindPod').mockImplementation((id) => {
    const inner = bindPod(id);
    let reader = readers.get(inner);
    if (!reader) {
      reader = {
        ...inner,
        getSnapshot() {
          const snapshot = inner.getSnapshot();
          if (readable) return snapshot;
          let pending = held.get(snapshot);
          if (!pending) {
            pending = Object.freeze({ ...snapshot, read: false });
            held.set(snapshot, pending);
          }
          return pending;
        },
        subscribe(listener) {
          listeners.add(listener);
          const stop = inner.subscribe(listener);
          return () => {
            listeners.delete(listener);
            stop();
          };
        },
      };
      readers.set(inner, reader);
    }
    return reader;
  });
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Validating mode="on-demand" />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
  expectLoadingOnly();
  act(() => {
    readable = true;
    listeners.forEach((listener) => listener());
  });
  expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull();
});

/** Every state the access surface passes through, recorded from its first render. */
function traceAccess() {
  const states: string[] = [];
  const observer = new MutationObserver(() => {
    const section = document.querySelector('[data-sempods-access]');
    if (!section) return;
    const state = section.hasAttribute('hidden')
      ? 'hidden'
      : section.textContent?.includes('Full addresses')
        ? 'connection'
        : section.querySelector('[role="status"]')?.textContent === 'Loading…'
          ? 'loading'
          : 'other';
    if (states.at(-1) !== state) states.push(state);
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
  cleanups.push(() => observer.disconnect());
  return states;
}

it.each([
  ['required', 'callback'],
  ['required', 'restore'],
  ['on-demand', 'callback'],
  ['on-demand', 'restore'],
] as const)(
  'shows only the loading status while a demanded catalogue loads (%s, %s)',
  async (mode, phase) => {
    const f = fixture({ preset: { podUrl: pod, contextIri: work } });
    let runtime: BrowserRuntime;
    if (phase === 'callback') {
      await f.begin();
      f.runtime.dispose();
      await settleLease();
      runtime = f.returned();
    } else {
      const signed = await f.login();
      signed.runtime.dispose();
      await settleLease();
      runtime = createBrowserRuntime(f.options);
    }
    cleanups.push(() => runtime.dispose());
    const answer = deferred<void>();
    f.setCatalogue(async () => {
      await answer.promise;
      return catalogue();
    });
    const states = traceAccess();
    render(
      <StrictMode>
        <SempodsProvider runtime={runtime} contextSelection={mode}>
          <AppAccess appName="Shopping" />
          <Started />
          <TargetScreen>
            <p>Context screen</p>
          </TargetScreen>
        </SempodsProvider>
      </StrictMode>,
    );
    await screen.findByText('started');
    await waitFor(() =>
      expect(runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
    );
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('active');
    expectLoadingOnly();
    await act(async () => answer.resolve());
    await screen.findByText('Context screen');
    expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull();
    // The preset Context settles the target: nothing for the person to decide.
    expect(states).toEqual(['loading', 'hidden']);
  },
);

it.each(['required', 'on-demand'] as const)(
  'ends a demanded catalogue load at the chooser or the failure view (%s)',
  async (mode) => {
    for (const outcome of ['choice', 'failure'] as const) {
      const f = fixture({ preferences: null });
      await f.begin();
      f.runtime.dispose();
      await settleLease();
      const runtime = f.returned();
      const answer = deferred<void>();
      f.setCatalogue(async () => {
        await answer.promise;
        return outcome === 'choice'
          ? catalogue()
          : new Response(null, { status: 503 });
      });
      const states = traceAccess();
      const view = render(
        <StrictMode>
          <SempodsProvider runtime={runtime} contextSelection={mode}>
            <AppAccess appName="Shopping" />
            <Started />
            <TargetScreen>
              <p>Context screen</p>
            </TargetScreen>
          </SempodsProvider>
        </StrictMode>,
      );
      await screen.findByText('started');
      await waitFor(() =>
        expect(runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
      );
      expectLoadingOnly();
      await act(async () => answer.resolve());
      if (outcome === 'choice')
        await screen.findByRole('combobox', { name: 'Data context' });
      else
        await screen.findByText(
          'Context catalogue unavailable. Access is unknown.',
        );
      expect(states, outcome).toEqual(['loading', 'connection']);
      // A reload the person starts keeps the connection view and its focus.
      const check = screen.getByRole('button', { name: 'Check access' });
      check.focus();
      const again = deferred<void>();
      f.setCatalogue(async () => {
        await again.promise;
        return catalogue();
      });
      fireEvent.click(check);
      await waitFor(() =>
        expect(runtime.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
      );
      expect(screen.getByRole('button', { name: 'Check access' })).toBe(check);
      expect(document.activeElement).toBe(check);
      await act(async () => again.resolve());
      await screen.findByRole('combobox', { name: 'Data context' });
      expect(states, outcome).toEqual(['loading', 'connection']);
      view.unmount();
      runtime.dispose();
      await settleLease();
    }
  },
);

it('loads the first catalogue again after the host replaces the runtime', async () => {
  const f = fixture({ preset: { podUrl: pod, contextIri: work } });
  const signed = await f.login();
  signed.runtime.dispose();
  await settleLease();
  const first = createBrowserRuntime(f.options);
  const ui = (runtime: BrowserRuntime) => (
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" />
      <TargetScreen>
        <p>Context screen</p>
      </TargetScreen>
    </SempodsProvider>
  );
  const view = render(ui(first));
  await screen.findByText('Context screen');
  first.dispose();
  await settleLease();
  const answer = deferred<void>();
  f.setCatalogue(async () => {
    await answer.promise;
    return catalogue();
  });
  const second = createBrowserRuntime(f.options);
  cleanups.push(() => second.dispose());
  const states = traceAccess();
  view.rerender(ui(second));
  await waitFor(() =>
    expect(second.getSnapshot()[0]?.catalogue.kind).toBe('loading'),
  );
  // The same connection ID restored by another runtime has not settled here.
  expect(second.getSnapshot()[0]?.id).toBe(signed.id);
  expect(second.getSnapshot()[0]?.session.kind).toBe('active');
  expectLoadingOnly();
  await act(async () => answer.resolve());
  await screen.findByText('Context screen');
  expect(states).not.toContain('connection');
});

/** Restarts [f]'s saved sessions with Pod discovery held (for [held] URLs) until the gate settles. */
async function restoring(
  f: ReturnType<typeof fixture>,
  runtime: BrowserRuntime,
  held: (url: string) => boolean = () => true,
) {
  runtime.dispose();
  await settleLease();
  const discovery = deferred<void>();
  const next = createBrowserRuntime({
    ...f.options,
    fetch: async (url, init) => {
      if (url.endsWith('/.well-known/oauth-protected-resource') && held(url))
        await discovery.promise;
      return f.fetch(url, init);
    },
  });
  cleanups.push(() => next.dispose());
  return { runtime: next, discovery };
}

/** Signs in to [pod] and then to [other]; both sessions are saved, [other] is active. */
async function bothSignedIn(f: ReturnType<typeof fixture>, other: string) {
  const signed = await f.login();
  const second = await signed.runtime.connect(other);
  await signed.runtime.beginAuthorization(second.id);
  signed.runtime.dispose();
  await settleLease();
  f.setToken(async () =>
    Response.json({
      access_token: jwt({ iss: other }),
      token_type: 'Bearer',
      refresh_token: 'other',
    }),
  );
  const runtime = f.returned();
  expect(await runtime.initialize()).toMatchObject({
    interaction: 'completed',
  });
  return { runtime, first: signed.id, second: second.id };
}

it('keeps the active-Pod selector mounted, focused and usable while a saved connection restores', async () => {
  const other = 'https://pod.example/bob';
  const f = fixture({ allowedPods: [pod, other], preferences: null });
  const both = await bothSignedIn(f, other);
  const { runtime, discovery } = await restoring(f, both.runtime);
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Validating mode="on-demand" />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  const region = screen.getByRole('region', { name: 'Data access' });
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  expect(within(region).queryByText('Full addresses')).toBeNull();
  const select = within(region).getByRole('combobox', {
    name: 'Active pod',
  }) as HTMLSelectElement;
  expect(select.disabled).toBe(false);
  const active = select.value;
  select.focus();
  // The restore fails and ends the session: the view changes, the selector stays.
  await act(async () => discovery.reject(new Error('offline')));
  await waitFor(() =>
    expect(
      runtime.getSnapshot().find((entry) => entry.id === active)?.session.kind,
    ).toBe('ended'),
  );
  expect(screen.getByText('Full addresses')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Active pod' })).toBe(select);
  expect(document.activeElement).toBe(select);
});

it('switches to another saved Pod from the selector while a restore is pending', async () => {
  const other = 'https://pod.example/bob';
  const f = fixture({ allowedPods: [pod, other], preferences: null });
  const both = await bothSignedIn(f, other);
  both.runtime.dispose();
  await settleLease();
  // Each Pod's restore waits for its own gate.
  const gates = new Map([pod, other].map((url) => [url, deferred<void>()]));
  const runtime = createBrowserRuntime({
    ...f.options,
    fetch: async (url, init) => {
      if (url.endsWith('/.well-known/oauth-protected-resource'))
        await gates.get(url.split('/.well-known')[0]!)!.promise;
      return f.fetch(url, init);
    },
  });
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <Validating mode="on-demand" />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  const region = screen.getByRole('region', { name: 'Data access' });
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  const select = within(region).getByRole('combobox', {
    name: 'Active pod',
  }) as HTMLSelectElement;
  // The active Pod's restore keeps hanging; the other one restores.
  const connections = runtime.getSnapshot();
  const target = connections.find((entry) => entry.id !== select.value)!;
  await act(async () => gates.get(target.podUrl)!.resolve());
  await waitFor(() =>
    expect(
      runtime.getSnapshot().find((entry) => entry.id === target.id)?.session
        .kind,
    ).toBe('active'),
  );
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  fireEvent.change(select, { target: { value: target.id } });
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull(),
  );
});

it('keeps the preset Pod sign-in and its failures while another saved Pod restores', async () => {
  const other = 'https://pod.example/bob';
  const f = fixture({ preset: { podUrl: other }, preferences: null });
  const signed = await f.login();
  // Only the saved Pod's restore hangs; signing in to the preset Pod proceeds.
  const { runtime } = await restoring(f, signed.runtime, (url) =>
    url.startsWith(pod),
  );
  function SelectSaved() {
    const app = useApp();
    return (
      <button onClick={() => void app.selectConnection(signed.id)}>
        Select saved
      </button>
    );
  }
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <SelectSaved />
      <Validating mode="on-demand" />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  // Startup prefers the preset Pod; the saved connection is active only on request.
  await act(async () =>
    screen.getByRole('button', { name: 'Select saved' }).click(),
  );
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
  const region = screen.getByRole('region', { name: 'Data access' });
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  expect(within(region).queryByText('Full addresses')).toBeNull();
  const signIn = within(region).getByRole('button', { name: 'Sign in' });
  f.fetch.mockRejectedValueOnce(new Error('offline'));
  await act(async () => signIn.click());
  expect(await within(region).findByRole('alert')).toBeTruthy();
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  expect(within(region).queryByText('Full addresses')).toBeNull();
});

it('replaces custom Connections with the loading status while a saved connection restores', async () => {
  const f = fixture({ allowedPods: [pod], preferences: null });
  const signed = await f.login();
  const { runtime, discovery } = await restoring(f, signed.runtime);
  function Replacement() {
    return <p>Custom connections</p>;
  }
  render(
    <SempodsProvider runtime={runtime} contextSelection="on-demand">
      <AppAccess appName="Shopping" components={{ Connections: Replacement }} />
      <Started />
    </SempodsProvider>,
  );
  await screen.findByText('started');
  const region = screen.getByRole('region', { name: 'Data access' });
  expect(within(region).getByRole('status').textContent).toBe('Loading…');
  expect(screen.queryByText('Custom connections')).toBeNull();
  await act(async () => discovery.resolve());
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Data access' })).toBeNull(),
  );
});

it.each(['missing scopes', 'ended session'] as const)(
  'shows the %s recovery view as soon as startup completes',
  async (kind) => {
    const f = fixture({
      allowedPods: [pod],
      preferences: null,
      scopes: { required: ['tasks'] },
    });
    await f.begin();
    f.runtime.dispose();
    await settleLease();
    let runtime: BrowserRuntime;
    // The fixture's default token grants no scopes, so `tasks` stays missing.
    if (kind === 'missing scopes') runtime = f.returned();
    else {
      f.setToken(async () =>
        Response.json({
          access_token: jwt({ scope: 'tasks' }),
          token_type: 'Bearer',
          refresh_token: 'refresh-private',
        }),
      );
      const callback = f.returned();
      await callback.initialize();
      callback.dispose();
      await settleLease();
      // Restoring the saved session fails, which ends it.
      runtime = createBrowserRuntime({
        ...f.options,
        fetch: async (url, init) => {
          if (url.endsWith('/.well-known/oauth-protected-resource'))
            throw new Error('offline');
          return f.fetch(url, init);
        },
      });
    }
    cleanups.push(() => runtime.dispose());
    render(
      <SempodsProvider runtime={runtime} contextSelection="on-demand">
        <Validating mode="on-demand" />
      </SempodsProvider>,
    );
    await screen.findByText('started');
    if (kind === 'missing scopes') {
      // Rendered in the same commit as the completed startup.
      expect(
        screen.getByText('Review required feature access: tasks.'),
      ).toBeTruthy();
      expect(
        screen.getByRole('button', { name: 'Update access' }),
      ).toBeTruthy();
    } else {
      await waitFor(() =>
        expect(runtime.getSnapshot()[0]?.session.kind).toBe('ended'),
      );
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    }
    expect(screen.queryByText('Loading…')).toBeNull();
  },
);
