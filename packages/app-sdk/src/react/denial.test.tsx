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
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
  useApp,
  useAppState,
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
  'a declined re-authorization (%s, %s description) says sharing is unchanged in one dismissible info prompt',
  async (language, _name, query) => {
    const t = text[language];
    const { runtime } = await returning('again', `error=access_denied${query}`);
    show(runtime, language);
    const prompt = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-sempods-ui="prompt"][data-reason="sharing-unchanged"]',
      );
      expect(found).toBeTruthy();
      return found!;
    });
    expect(prompt.getAttribute('role')).toBe('status');
    expect(prompt.textContent).toContain(t.unchanged);
    // The list stays; the person only acknowledges.
    expect(await screen.findByText('My list')).toBeTruthy();
    expect(
      within(prompt)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['OK']);
    expect(document.querySelector('[data-sempods-ui="gate"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(
      /scopes|Benutzer|onerror|<img/,
    );
  },
);

it.each(['ok', 'escape'] as const)(
  'dismissing the unchanged sharing (%s) retires it, and a reload of the list does not reopen it (#227)',
  async (how) => {
    const { runtime } = await returning('again', 'error=access_denied');
    let app!: ReturnType<typeof useApp>;
    let state!: ReturnType<typeof useAppState>;
    function Probe() {
      app = useApp();
      state = useAppState();
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
    const prompt = await waitFor(() => {
      const found = document.querySelector<HTMLElement>(
        '[data-sempods-ui="prompt"][data-reason="sharing-unchanged"]',
      );
      expect(found).toBeTruthy();
      return found!;
    });
    const ok = within(prompt).getByRole('button', { name: 'OK' });
    if (how === 'ok') await act(async () => ok.click());
    else
      await act(async () => {
        ok.focus();
        fireEvent.keyDown(ok, { key: 'Escape' });
      });
    await waitFor(() =>
      expect(document.querySelector('[data-sempods-ui="prompt"]')).toBeNull(),
    );
    expect(state.callbackNotice).toBe(false);
    // Reading the list (the catalogue) again does not bring it back.
    await act(async () => {
      await app.refreshContexts(state.activeId!);
    });
    expect(document.querySelector('[data-sempods-ui="prompt"]')).toBeNull();
    expect(state.access.prompts).toEqual([]);
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
