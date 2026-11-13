// @vitest-environment jsdom
/**
 * AppAccess offers remembered Pods with one sign-in action and device-local
 * management (#237, #310).
 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
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
import { AppAccess, SempodsProvider } from './index.js';
import {
  fixture,
  jwt,
  pod,
  renewal,
  restart,
  restored,
  savedRecords,
  settleLease,
  storeWith,
  twoPods,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
} from '../runtime/types.js';

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

const texts = {
  en: {
    list: 'Pods on this device',
    signIn: 'Sign in',
    forget: 'Remove from this device',
    address: 'Pod address',
    ended: 'The session ended. Sign in again to continue.',
  },
  de: {
    list: 'Pods auf diesem Gerät',
    signIn: 'Anmelden',
    forget: 'Von diesem Gerät entfernen',
    address: 'Pod-Adresse',
    ended: 'Die Sitzung wurde beendet. Melde dich erneut an, um fortzufahren.',
  },
} as const;

/** Signed in, then `end`ed, then a fresh start as after a reload. */
async function remembered(
  end: 'sign-out' | 'session-end',
  overrides: Partial<BrowserRuntimeOptions> = {},
) {
  const f = fixture({ preferences: null, ...overrides });
  cleanups.push(() => f.runtime.dispose());
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  if (end === 'sign-out') await runtime.disconnect(id);
  else {
    await renewal(f, runtime, id, 'refused');
    // The ended session is retired in the background: wait until it is.
    await vi.waitFor(async () =>
      expect(
        (await savedRecords(f.factory)).find((r) => r.id === id)?.value,
      ).toMatchObject({ kind: 'disconnected' }),
    );
  }
  const next = await restart(f, runtime, (r) =>
    cleanups.push(() => r.dispose()),
  );
  return { f, runtime: next, id };
}
function show(runtime: BrowserRuntime, language: 'en' | 'de' = 'en') {
  render(
    <SempodsProvider runtime={runtime} language={language}>
      <AppAccess appName="Shopping" />
    </SempodsProvider>,
  );
}

it.each(['en', 'de'] as const)(
  'offers a remembered Pod with one sign-in and keeps another address secondary (%s)',
  async (language) => {
    const t = texts[language];
    const { f, runtime, id } = await remembered('sign-out');
    show(runtime, language);
    const signIn = await screen.findByRole('button', { name: t.signIn });
    expect(screen.getByText('pod.example/alice')).toBeTruthy();
    expect(screen.queryByText(t.ended)).toBeNull();
    expect(screen.getAllByRole('button', { name: t.signIn })).toHaveLength(1);
    expect(screen.queryByRole('textbox', { name: t.address })).toBeNull();
    expect(
      screen.getByRole('button', {
        name: language === 'en' ? 'Use another Pod' : 'Anderen Pod verwenden',
      }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Sign out|Abmelden/ }),
    ).toBeNull();
    const navigations = f.navigate.mock.calls.length;
    await act(async () => signIn.click());
    await waitFor(() =>
      expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
    );
    const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
    expect(authorization.href.startsWith(pod + '/_system/auth/authorize')).toBe(
      true,
    );
    expect(runtime.getSnapshot()).toMatchObject([
      { id, session: { kind: 'leaving' } },
    ]);
  },
);

it.each(['en', 'de'] as const)(
  'forgets a remembered Pod on this device (%s)',
  async (language) => {
    const t = texts[language];
    const { runtime } = await remembered('sign-out');
    show(runtime, language);
    const list = await screen.findByRole('list', { name: t.list });
    await act(async () =>
      within(list).getByRole('button', { name: t.forget }).click(),
    );
    await waitFor(() => expect(runtime.getSnapshot()).toEqual([]));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: t.address })).toBeTruthy(),
    );
    expect(screen.queryByRole('list', { name: t.list })).toBeNull();
  },
);

it.each(['en', 'de'] as const)(
  'notes that the session of a remembered Pod ended (%s)',
  async (language) => {
    const t = texts[language];
    const { runtime } = await remembered('session-end');
    expect(runtime.getSnapshot()[0]?.session).toMatchObject({
      kind: 'signed-out',
      problem: expect.any(String),
    });
    show(runtime, language);
    await screen.findByRole('list', { name: t.list });
    expect(screen.getByText(t.ended)).toBeTruthy();
  },
);

it('offers the remembered preset Pod once, without another default sign-in', async () => {
  const { runtime } = await remembered('sign-out', {
    preset: { podUrl: pod },
  });
  show(runtime);
  await screen.findByRole('button', { name: 'Sign in' });
  expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
  // The preset fixes the Pod: no address field.
  expect(screen.queryByRole('textbox')).toBeNull();
});

it('shows only the address field when the runtime does not remember Pods', async () => {
  const f = fixture({ preferences: null, rememberPods: false });
  cleanups.push(() => f.runtime.dispose());
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Shopping" open />
    </SempodsProvider>,
  );
  await act(async () =>
    (await screen.findByRole('button', { name: 'Sign out' })).click(),
  );
  await waitFor(() => expect(runtime.getSnapshot()).toEqual([]));
  expect(screen.queryByRole('list', { name: texts.en.list })).toBeNull();
  expect(screen.getByRole('textbox', { name: 'Pod address' })).toBeTruthy();
  expect(id).toBeTruthy();
});

it('keeps a remembered Pod reachable in management while another Pod restores', async () => {
  const bobUrl = 'https://pod.example/bob';
  const f = fixture({ preferences: null });
  cleanups.push(() => f.runtime.dispose());
  const alice = await f.login();
  cleanups.push(() => alice.runtime.dispose());
  // Bob signs in, then out: remembered beside Alice's saved session.
  const bob = await alice.runtime.connect(bobUrl);
  await alice.runtime.beginAuthorization(bob.id);
  alice.runtime.dispose();
  await settleLease();
  f.setToken(async (url) =>
    Response.json({
      access_token: jwt({ iss: url.split('/_system')[0] }),
      token_type: 'Bearer',
      refresh_token: 'fresh',
    }),
  );
  const back = f.returned();
  cleanups.push(() => back.dispose());
  expect(await back.initialize()).toMatchObject({ interaction: 'completed' });
  await restored(back);
  expect(await back.disconnect(bob.id)).toEqual({ kind: 'disconnected' });
  back.dispose();
  await settleLease();
  // Alice's discovery never settles on the next start.
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url, init) =>
    url === pod + '/.well-known/oauth-protected-resource'
      ? new Promise<Response>(() => {})
      : original(url, init),
  );
  const next = createBrowserRuntime({
    ...f.options,
    location: () => 'https://app.example/',
  });
  cleanups.push(() => next.dispose());
  await next.initialize();
  // A pending restore shows no sign-in screen; management reaches the others.
  render(
    <SempodsProvider runtime={next}>
      <AppAccess appName="Shopping" open onClose={() => {}} />
    </SempodsProvider>,
  );
  const list = await screen.findByRole('list', { name: texts.en.list });
  expect(
    Object.fromEntries(next.getSnapshot().map((c) => [c.id, c.session.kind])),
  ).toEqual({ [alice.id]: 'restoring', [bob.id]: 'signed-out' });
  expect(document.querySelector('[data-sempods-ui="gate"]')).toBeNull();
  expect(within(list).getByText('pod.example/bob')).toBeTruthy();
  const navigations = f.navigate.mock.calls.length;
  await act(async () =>
    within(list).getByRole('button', { name: 'Sign in' }).click(),
  );
  await waitFor(() =>
    expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
  );
  expect(f.navigate.mock.calls.at(-1)![0].startsWith(bobUrl + '/')).toBe(true);
});

it.each(['en', 'de'] as const)(
  'shows a Pod whose forgetting failed in the gate and retries forgetting it (%s)',
  async (language) => {
    const t = texts[language];
    const failedText =
      language === 'en'
        ? 'This Pod was not forgotten on this device. Try forgetting it again.'
        : 'Der Pod wurde auf diesem Gerät nicht vergessen. Versuche erneut, ihn zu vergessen.';
    let failing = false;
    const factory = new IDBFactory();
    const { runtime } = await remembered('sign-out', {
      openStore: storeWith(factory, (store) => ({
        remove: (...args) =>
          failing
            ? Promise.reject(new Error('private fixture detail'))
            : store.remove(...args),
      })),
    });
    show(runtime, language);
    const list = await screen.findByRole('list', { name: t.list });
    failing = true;
    await act(async () =>
      within(list).getByRole('button', { name: t.forget }).click(),
    );
    const gate = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    )!;
    await waitFor(() =>
      expect(gate.getAttribute('data-reason')).toBe('sign-out-failed'),
    );
    const alert = within(gate).getByRole('alert');
    expect(alert.textContent).toBe(failedText);
    expect(document.body.textContent).not.toMatch(
      /reload|neu laden|private fixture/i,
    );
    // No sign-in and no sign-out against the person's choice: only the retry.
    expect(within(gate).queryByRole('button', { name: t.signIn })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out|Abmelden/ })).toBe(
      null,
    );
    expect(within(gate).queryByRole('textbox')).toBeNull();
    const retry = within(gate).getByRole('button', {
      name: language === 'en' ? 'Try again' : 'Erneut versuchen',
    });
    failing = false;
    await act(async () => retry.click());
    await waitFor(() => expect(runtime.getSnapshot()).toEqual([]));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: t.list })).toBeNull(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
    // Forgetting the only Pod leaves the first sign-in.
    expect(screen.getByRole('textbox', { name: t.address })).toBeTruthy();
  },
);

it('names the active Pod in management beside a remembered one', async () => {
  const { f, runtime, other } = await twoPods((r) =>
    cleanups.push(() => r.dispose()),
  );
  expect(await runtime.disconnect(other.id)).toEqual({
    kind: 'disconnected',
  });
  const next = await restart(f, runtime, (r) =>
    cleanups.push(() => r.dispose()),
  );
  render(
    <SempodsProvider runtime={next}>
      <AppAccess appName="Shopping" open />
    </SempodsProvider>,
  );
  await screen.findByRole('button', { name: 'Sign out' });
  // No Pod selector for one signed-in Pod: its address names it instead.
  expect(screen.queryByLabelText('Active pod')).toBeNull();
  const region = screen.getByRole('region', { name: 'Pods & sharing' });
  const list = within(region).getByRole('list', { name: texts.en.list });
  const named = within(region)
    .getAllByText('pod.example/alice')
    .filter((element) => !list.contains(element));
  expect(named).toHaveLength(1);
  expect(within(list).getByText('pod.example/bob')).toBeTruthy();
});

it('chooses among remembered Pods without selecting or authorizing until the main action', async () => {
  const { f, runtime, other } = await twoPods((r) =>
    cleanups.push(() => r.dispose()),
  );
  for (const c of runtime.getSnapshot()) await runtime.disconnect(c.id);
  const next = await restart(f, runtime, (r) =>
    cleanups.push(() => r.dispose()),
  );
  show(next);
  const choices = await screen.findAllByRole('radio');
  expect(choices).toHaveLength(2);
  const before = f.navigate.mock.calls.length;
  const ids = next.getSnapshot().map((c) => c.id);
  await act(async () =>
    screen.getByRole('radio', { name: 'pod.example/bob' }).click(),
  );
  expect(f.navigate).toHaveBeenCalledTimes(before);
  expect(next.getSnapshot().every((c) => c.session.kind === 'signed-out')).toBe(
    true,
  );
  expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
  expect(screen.queryByRole('textbox')).toBeNull();
  await act(async () =>
    screen.getByRole('button', { name: 'Sign in' }).click(),
  );
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(before + 1));
  expect(next.getSnapshot().find((c) => c.id === other.id)?.session.kind).toBe(
    'leaving',
  );
  expect(next.getSnapshot().map((c) => c.id)).toEqual(ids);
});

it('opens another address on request and reuses a saved Pod entered there', async () => {
  const { f, runtime, id } = await remembered('sign-out');
  show(runtime);
  await act(async () =>
    (await screen.findByRole('button', { name: 'Use another Pod' })).click(),
  );
  const field = screen.getByRole('textbox', { name: 'Pod address' });
  fireEvent.change(field, { target: { value: '  pod.example/alice/  ' } });
  await act(async () => fireEvent.submit(field.closest('form')!));
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('leaving'),
  );
  expect(runtime.getSnapshot().map((c) => c.id)).toEqual([id]);
  expect(f.navigate.mock.calls.at(-1)![0]).toContain(
    pod + '/_system/auth/authorize',
  );
});

it.each(['gate', 'management'] as const)(
  'retries an inactive Pod removal instead of authorizing it from %s',
  async (surface) => {
    const { f, runtime, other } = await twoPods((r) =>
      cleanups.push(() => r.dispose()),
    );
    for (const c of runtime.getSnapshot()) await runtime.disconnect(c.id);
    let failing = true;
    const next = await restart(
      f,
      runtime,
      (r) => cleanups.push(() => r.dispose()),
      {
        preset: { podUrl: pod },
        openStore: storeWith(f.factory, (store) => ({
          remove: (...args) =>
            failing && args[0] === other.id
              ? Promise.reject(new Error('storage failure'))
              : store.remove(...args),
        })),
      },
    );
    render(
      <SempodsProvider runtime={next}>
        <AppAccess
          appName="Shopping"
          {...(surface === 'management'
            ? { open: true, onClose: () => {} }
            : {})}
        />
      </SempodsProvider>,
    );
    const view = await waitFor(() => {
      const element = document.querySelector<HTMLElement>(
        `[data-sempods-ui="${surface}"]`,
      );
      expect(element).toBeTruthy();
      return element!;
    });
    fireEvent.click(
      within(view).getByRole('radio', { name: 'pod.example/bob' }),
    );
    const record = within(view)
      .getByText('https://pod.example/bob', { selector: 'p' })
      .closest('li')!;
    const before = f.navigate.mock.calls.length;
    await act(async () =>
      within(record)
        .getByRole('button', { name: 'Remove from this device' })
        .click(),
    );
    await within(view).findByText(
      'This Pod was not forgotten on this device. Try forgetting it again.',
    );
    expect(
      within(view).queryByRole('button', { name: 'Sign in', exact: true }),
    ).toBeNull();
    expect(
      within(view).getByRole('button', { name: 'Try again' }),
    ).toBeTruthy();
    // Entering the same URL cannot bypass the retained removal intent either.
    fireEvent.click(
      within(view).getByRole('button', { name: 'Use another Pod' }),
    );
    fireEvent.change(within(view).getByRole('textbox'), {
      target: { value: 'pod.example/bob' },
    });
    expect(
      within(view).queryByRole('button', { name: 'Sign in', exact: true }),
    ).toBeNull();
    failing = false;
    await act(async () =>
      within(view).getByRole('button', { name: 'Try again' }).click(),
    );
    await waitFor(() =>
      expect(next.getSnapshot().some((c) => c.id === other.id)).toBe(false),
    );
    expect(f.navigate).toHaveBeenCalledTimes(before);
  },
);
