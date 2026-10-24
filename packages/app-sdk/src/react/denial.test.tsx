// @vitest-environment jsdom
/** Denied consent: neutral EN/DE wording and exactly one next step (#99). */
import { webcrypto } from 'node:crypto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { callback, fixture, settleLease } from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { useState } from 'react';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
  useApp,
  useAppState,
  useDraftGuard,
} from './index.js';

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
const text = {
  en: {
    region: 'Pods & sharing',
    cancelled:
      'No access was granted: the sign-in was cancelled or declined at the Pod. Sign in again to choose what to share.',
    unchanged:
      'Sharing was not changed: the consent was cancelled or declined at the Pod. This app keeps the access it had.',
    signIn: 'Sign in',
    change: 'Change sharing',
    loginRequired:
      'The pod asked you to sign in at its provider first. Sign in there, then try again.',
  },
  de: {
    region: 'Pods & Freigaben',
    cancelled:
      'Es wurde kein Zugriff erteilt: Die Anmeldung wurde beim Pod abgebrochen oder abgelehnt. Melde dich erneut an, um eine Freigabe zu wählen.',
    unchanged:
      'Die Freigabe wurde nicht geändert: Die Zustimmung wurde beim Pod abgebrochen oder abgelehnt. Diese App behält ihren bisherigen Zugriff.',
    signIn: 'Anmelden',
    change: 'Freigabe ändern',
    loginRequired:
      'Der Pod verlangt, dass du dich zuerst bei seinem Anbieter anmeldest. Melde dich dort an und versuche es dann erneut.',
  },
} as const;
// Provider prose is never shown or interpreted, whatever it says.
const descriptions = {
  missing: '',
  nothing: '&error_description=no+scopes+selected',
  localized: '&error_description=Vom+Benutzer+abgebrochen',
  malicious: '&error_description=%3Cimg+src%3Dx+onerror%3Dalert(1)%3E',
} as const;

/** A runtime returning to the callback with `answer` for a first sign-in or a re-authorization. */
async function returning(kind: 'first' | 'again', answer: string) {
  const f = fixture();
  runtimes.push(f.runtime);
  let authorization: URL;
  if (kind === 'first') {
    authorization = (await f.begin()).authorization;
    f.runtime.dispose();
  } else {
    const { runtime, id } = await f.login();
    runtimes.push(runtime);
    await runtime.beginAuthorization(id);
    authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
    runtime.dispose();
  }
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () =>
      `${callback}?${answer}&state=${authorization.searchParams.get('state')}`,
  });
  runtimes.push(next);
  return { f, runtime: next };
}
function show(runtime: BrowserRuntime, language: 'en' | 'de') {
  render(
    <SempodsProvider runtime={runtime} language={language}>
      <AppAccess appName="Shopping" />
      <TargetScreen>
        <p>My list</p>
      </TargetScreen>
    </SempodsProvider>,
  );
}

it.each(
  (['en', 'de'] as const).flatMap((language) =>
    Object.entries(descriptions).map(
      ([name, query]) => [language, name, query] as const,
    ),
  ),
)(
  'a first sign-in denial (%s, %s description) says no access was granted and offers only Sign in',
  async (language, _name, query) => {
    const t = text[language];
    const { runtime } = await returning('first', `error=access_denied${query}`);
    show(runtime, language);
    const region = await screen.findByRole('region', { name: t.region });
    expect((await within(region).findByRole('alert')).textContent).toBe(
      t.cancelled,
    );
    const primary = region.querySelectorAll('.sp-access-primary');
    expect([...primary].map((button) => button.textContent)).toEqual([
      t.signIn,
    ]);
    expect(within(region).queryByRole('button', { name: t.change })).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /scopes|Benutzer|onerror|<img/,
    );
    expect(document.querySelector('img')).toBeNull();
  },
);

it.each(
  (['en', 'de'] as const).flatMap((language) =>
    Object.entries(descriptions).map(
      ([name, query]) => [language, name, query] as const,
    ),
  ),
)(
  'a declined re-authorization (%s, %s description) says sharing is unchanged and offers only Change sharing',
  async (language, _name, query) => {
    const t = text[language];
    const { f, runtime } = await returning(
      'again',
      `error=access_denied${query}`,
    );
    show(runtime, language);
    const region = await screen.findByRole('region', { name: t.region });
    await waitFor(() =>
      expect(within(region).getByRole('status').textContent).toBe(t.unchanged),
    );
    expect(within(region).queryByRole('alert')).toBeNull();
    // The list stays; the one action is to try changing the sharing again.
    expect(await screen.findByText('My list')).toBeTruthy();
    expect(
      within(region)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual([t.change]);
    expect(document.body.textContent).not.toMatch(
      /scopes|Benutzer|onerror|<img/,
    );
    const navigations = f.navigate.mock.calls.length;
    await act(async () =>
      within(region).getByRole('button', { name: t.change }).click(),
    );
    await waitFor(() =>
      expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
    );
  },
);

it.each(['en', 'de'] as const)(
  'another provider answer during re-authorization names its cause and offers Sign in (%s)',
  async (language) => {
    const t = text[language];
    const { runtime } = await returning(
      'again',
      'error=login_required&error_description=You+are+not+signed+in',
    );
    show(runtime, language);
    const region = await screen.findByRole('region', { name: t.region });
    expect((await within(region).findByRole('alert')).textContent).toBe(
      t.loginRequired,
    );
    const primary = region.querySelectorAll('.sp-access-primary');
    expect([...primary].map((button) => button.textContent)).toEqual([
      t.signIn,
    ]);
    expect(within(region).queryByRole('button', { name: t.change })).toBeNull();
    expect(document.body.textContent).not.toContain('You are not signed in');
  },
);

it('keeps Change sharing and shows the failure when preparing it again fails', async () => {
  const t = text.en;
  const { f, runtime } = await returning('again', 'error=access_denied');
  show(runtime, 'en');
  const region = await screen.findByRole('region', { name: t.region });
  await waitFor(() =>
    expect(within(region).getByRole('status').textContent).toBe(t.unchanged),
  );
  await screen.findByText('My list');
  const change = () => within(region).getByRole('button', { name: t.change });
  const navigations = f.navigate.mock.calls.length;
  // Discovery for the new attempt fails, as when offline.
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) throw new TypeError('offline');
    return original(url, init);
  });
  await act(async () => change().click());
  await waitFor(() => expect(within(region).getByRole('alert')).toBeTruthy());
  expect(region.hidden).toBe(false);
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  f.fetch.mockImplementation(original);
  // The session still works; the same one action tries again.
  await act(async () =>
    within(region).getByRole('button', { name: t.change }).click(),
  );
  await waitFor(() =>
    expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
  );
});

it('keeps the failed retry and its action when the leave prompt is declined', async () => {
  const t = text.en;
  const { f, runtime } = await returning('again', 'error=access_denied');
  function Draft() {
    const [draft, setDraft] = useState('');
    useDraftGuard(draft !== '', () => setDraft(''));
    return (
      <input
        aria-label="Draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }
  render(
    <SempodsProvider runtime={runtime} language="en">
      <AppAccess appName="Shopping" />
      <TargetScreen>
        <Draft />
      </TargetScreen>
    </SempodsProvider>,
  );
  const region = await screen.findByRole('region', { name: t.region });
  await waitFor(() =>
    expect(within(region).getByRole('status').textContent).toBe(t.unchanged),
  );
  const change = () => within(region).getByRole('button', { name: t.change });
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) throw new TypeError('offline');
    return original(url, init);
  });
  await act(async () => change().click());
  await waitFor(() => expect(within(region).getByRole('alert')).toBeTruthy());
  f.fetch.mockImplementation(original);
  const draft = await screen.findByLabelText('Draft');
  fireEvent.change(draft, { target: { value: 'Unsaved' } });
  const navigations = f.navigate.mock.calls.length;
  await act(async () => change().click());
  await act(async () =>
    screen.getByRole('button', { name: 'Keep editing' }).click(),
  );
  // Nothing happened: the failure and the one action are still offered.
  expect(region.hidden).toBe(false);
  expect(within(region).getByRole('alert')).toBeTruthy();
  expect(change()).toBeTruthy();
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect((draft as HTMLInputElement).value).toBe('Unsaved');
});

it('keeps Change sharing when preparation fails after the leave prompt was confirmed', async () => {
  const t = text.en;
  const { f, runtime } = await returning('again', 'error=access_denied');
  function Draft() {
    const [draft, setDraft] = useState('');
    useDraftGuard(draft !== '', () => setDraft(''));
    return (
      <input
        aria-label="Draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
    );
  }
  render(
    <SempodsProvider runtime={runtime} language="en">
      <AppAccess appName="Shopping" />
      <TargetScreen>
        <Draft />
      </TargetScreen>
    </SempodsProvider>,
  );
  const region = await screen.findByRole('region', { name: t.region });
  await waitFor(() =>
    expect(within(region).getByRole('status').textContent).toBe(t.unchanged),
  );
  const change = () => within(region).getByRole('button', { name: t.change });
  fireEvent.change(await screen.findByLabelText('Draft'), {
    target: { value: 'Unsaved' },
  });
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) throw new TypeError('offline');
    return original(url, init);
  });
  const navigations = f.navigate.mock.calls.length;
  await act(async () => change().click());
  await act(async () =>
    screen.getByRole('button', { name: 'Discard and continue' }).click(),
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect(region.hidden).toBe(false);
  // The draft was kept, as nothing left: the retry asks again.
  expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe(
    'Unsaved',
  );
  f.fetch.mockImplementation(original);
  await act(async () => change().click());
  await act(async () =>
    screen.getByRole('button', { name: 'Discard and continue' }).click(),
  );
  await waitFor(() =>
    expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
  );
});

it('drops the offer and its failure once another connection was active', async () => {
  const t = text.en;
  const { f, runtime } = await returning('again', 'error=access_denied');
  let app!: ReturnType<typeof useApp>;
  let activeId: string | null = null;
  function Probe() {
    app = useApp();
    activeId = useAppState().activeId;
    return null;
  }
  render(
    <SempodsProvider runtime={runtime} language="en">
      <AppAccess appName="Shopping" />
      <Probe />
      <TargetScreen>
        <p>My list</p>
      </TargetScreen>
    </SempodsProvider>,
  );
  const region = await screen.findByRole('region', { name: t.region });
  await waitFor(() =>
    expect(within(region).getByRole('status').textContent).toBe(t.unchanged),
  );
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation(async (url, init) => {
    if (url.includes('/.well-known/')) throw new TypeError('offline');
    return original(url, init);
  });
  await act(async () =>
    within(region).getByRole('button', { name: t.change }).click(),
  );
  await waitFor(() => expect(within(region).getByRole('alert')).toBeTruthy());
  f.fetch.mockImplementation(original);
  const first = activeId!;
  const other = await act(() => runtime.connect('https://pod.example/bob'));
  await act(async () => {
    await app.selectConnection(other.id);
  });
  await act(async () => {
    await app.selectConnection(first);
  });
  await waitFor(() => expect(region.hidden).toBe(true));
  expect(within(region).queryByRole('button', { name: t.change })).toBeNull();
  expect(within(region).queryByRole('alert')).toBeNull();
});
