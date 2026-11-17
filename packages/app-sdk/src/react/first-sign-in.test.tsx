// @vitest-environment jsdom
/** The silent first sign-in and the Pod's own sign-in link in the access UI (#373). */
import { webcrypto } from 'node:crypto';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  callback,
  fixture,
  memoryStorage,
  pod,
  settleLease,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { AppAccess, SempodsProvider, TargetScreen } from './index.js';

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
    link: 'Sign in at your Pod',
    signIn: 'Sign in',
    loginRequired:
      'The pod asked you to sign in at its provider first. Sign in there, then try again.',
  },
  de: {
    region: 'Pods & Freigaben',
    link: 'Bei deinem Pod anmelden',
    signIn: 'Anmelden',
    loginRequired:
      'Der Pod verlangt, dass du dich zuerst bei seinem Anbieter anmeldest. Melde dich dort an und versuche es dann erneut.',
  },
} as const;
const login = '&error_uri=https%3A%2F%2Fpod.example%2Flogin';

/** The runtime opened by the Pod's `answer` to a silent or a clicked first sign-in. */
async function answered(kind: 'silent' | 'click', answer: string) {
  const f = fixture({
    preset: { podUrl: pod },
    preferences: null,
    ...(kind === 'silent'
      ? {
          identity: {
            kind: 'did-web',
            clientId: 'did:web:app.example',
            redirectUri: callback,
          },
          firstSignIn: 'silent' as const,
          tabStorage: memoryStorage(),
        }
      : {}),
  });
  runtimes.push(f.runtime);
  if (kind === 'silent') await f.runtime.initialize();
  else await f.begin();
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  f.runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () =>
      `${callback}?${answer}&state=${authorization.searchParams.get('state')}`,
  });
  runtimes.push(next);
  return next;
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

it.each(['en', 'de'] as const)(
  'a Pod that needs the person shows the sign-in screen with its link, not an error (%s)',
  async (language) => {
    const t = text[language];
    const runtime = await answered(
      'silent',
      `error=login_required&error_description=Visit+evil.example${login}`,
    );
    show(runtime, language);
    const region = await screen.findByRole('region', { name: t.region });
    const link = await within(region).findByRole('link', { name: t.link });
    expect(link.getAttribute('href')).toBe('https://pod.example/login');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // Signing in stays the main action; nothing failed.
    const primary = region.querySelectorAll('.sp-access-primary');
    expect([...primary].map((button) => button.textContent)).toEqual([
      t.signIn,
    ]);
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(document.body.textContent).not.toContain(t.loginRequired);
    expect(document.body.textContent).not.toContain('evil');
  },
);

// Which error_uri survives is the client's decision (authorization.test.ts).
it('shows no link when the Pod gave none', async () => {
  const runtime = await answered('silent', 'error=login_required');
  show(runtime, 'en');
  const region = await screen.findByRole('region', { name: text.en.region });
  await within(region).findByRole('button', { name: text.en.signIn });
  expect(within(region).queryByRole('link')).toBeNull();
});

it('a clicked sign-in that the Pod answers with login_required names the cause and offers its link', async () => {
  const runtime = await answered('click', `error=login_required${login}`);
  show(runtime, 'en');
  const region = await screen.findByRole('region', { name: text.en.region });
  expect((await within(region).findByRole('alert')).textContent).toBe(
    text.en.loginRequired,
  );
  expect(
    within(region)
      .getByRole('link', { name: text.en.link })
      .getAttribute('href'),
  ).toBe('https://pod.example/login');
});
