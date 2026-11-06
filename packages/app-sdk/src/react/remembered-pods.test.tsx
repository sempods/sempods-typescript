// @vitest-environment jsdom
/**
 * AppAccess lists remembered Pods (#237) above the address field, each with
 * its own sign-in and a way to forget it on this device.
 */
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
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
    forget: 'Forget',
    address: 'Pod address',
    ended: 'The session ended. Sign in again to continue.',
  },
  de: {
    list: 'Pods auf diesem Gerät',
    signIn: 'Anmelden',
    forget: 'Vergessen',
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
  'lists a remembered Pod above the address field and signs in to it (%s)',
  async (language) => {
    const t = texts[language];
    const { f, runtime, id } = await remembered('sign-out');
    show(runtime, language);
    const list = await screen.findByRole('list', { name: t.list });
    const item = within(list).getByRole('listitem');
    expect(within(item).getByText('pod.example/alice')).toBeTruthy();
    // A sign-out is not an ended session: no note.
    expect(within(item).queryByText(t.ended)).toBeNull();
    const signIn = within(item).getByRole('button', { name: t.signIn });
    expect(
      document.getElementById(signIn.getAttribute('aria-describedby')!)
        ?.textContent,
    ).toBe('pod.example/alice');
    // The address field follows the list, for another Pod.
    const input = screen.getByRole('textbox', { name: t.address });
    expect(
      list.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Sign out|Abmelden/ })).toBe(
      null,
    );
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
    const list = await screen.findByRole('list', { name: t.list });
    expect(within(list).getByText(t.ended)).toBeTruthy();
  },
);

it('offers the remembered preset Pod once, without another default sign-in', async () => {
  const { runtime } = await remembered('sign-out', {
    preset: { podUrl: pod },
  });
  show(runtime);
  const list = await screen.findByRole('list', { name: texts.en.list });
  expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
  expect(within(list).getByRole('button', { name: 'Sign in' })).toBeTruthy();
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

it('keeps a remembered Pod reachable while another Pod restores', async () => {
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
  show(next);
  await screen.findByRole('status');
  expect(
    Object.fromEntries(next.getSnapshot().map((c) => [c.id, c.session.kind])),
  ).toEqual({ [alice.id]: 'restoring', [bob.id]: 'signed-out' });
  expect(screen.getByRole('status').textContent).toBe('Loading…');
  const list = screen.getByRole('list', { name: texts.en.list });
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
  'keeps a Pod whose forgetting failed in the list and retries Forget (%s)',
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
    const alert = await within(list).findByRole('alert');
    expect(alert.textContent).toBe(failedText);
    expect(document.body.textContent).not.toMatch(
      /reload|neu laden|private fixture/i,
    );
    // No sign-in and no sign-out against the person's choice: only Forget.
    expect(within(list).queryByRole('button', { name: t.signIn })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sign out|Abmelden/ })).toBe(
      null,
    );
    const retry = within(list).getByRole('button', { name: t.forget });
    expect(retry.getAttribute('aria-describedby')).toContain(alert.id);
    failing = false;
    await act(async () => retry.click());
    await waitFor(() => expect(runtime.getSnapshot()).toEqual([]));
    await waitFor(() =>
      expect(screen.queryByRole('list', { name: t.list })).toBeNull(),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  },
);
