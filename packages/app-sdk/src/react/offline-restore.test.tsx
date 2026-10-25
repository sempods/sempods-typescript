// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AccessNotice, AppAccess, SempodsProvider } from './index.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { fixture, restored, settleLease } from '../runtime/fixture.test.js';

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
  vi.unstubAllGlobals();
});

/** A signed-in session restarted while its Pod is offline. */
async function offlineStart() {
  const f = fixture({ preferences: null });
  const { runtime } = await f.login();
  runtime.dispose();
  await settleLease();
  const original = f.fetch.getMockImplementation()!;
  const net = { down: true };
  f.fetch.mockImplementation(async (url, init) => {
    if (net.down && url.includes('/.well-known/'))
      throw new TypeError('Failed to fetch');
    return original(url, init);
  });
  const next = createBrowserRuntime(f.options);
  runtimes.push(next);
  return { f, runtime: next, net };
}
const text = {
  en: {
    unreachable:
      'The Pod cannot be reached right now. You stay signed in; this app reconnects when the network is back.',
    retry: 'Try again',
    signIn: 'Sign in',
  },
  de: {
    unreachable:
      'Der Pod ist gerade nicht erreichbar. Du bleibst angemeldet; die App verbindet sich wieder, sobald das Netz zurück ist.',
    retry: 'Erneut versuchen',
    signIn: 'Anmelden',
  },
} as const;

it.each([
  ['access', 'en'],
  ['access', 'de'],
  ['notice', 'en'],
  ['notice', 'de'],
] as const)(
  'offers Try again instead of Sign in when the Pod is unreachable at startup (%s, %s)',
  async (surface, language) => {
    const t = text[language];
    const { f, runtime, net } = await offlineStart();
    render(
      <SempodsProvider runtime={runtime} language={language}>
        <AppAccess appName="Tasks" />
        {/* A custom layout's notice names the same cause. */}
        {surface === 'notice' && <AccessNotice />}
      </SempodsProvider>,
    );
    await act(() => restored(runtime));
    const retry = await screen.findByRole('button', { name: t.retry });
    expect(screen.getAllByText(t.unreachable).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: t.signIn })).toBeNull();
    net.down = false;
    const navigations = f.navigate.mock.calls.length;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(runtime.getSnapshot()[0]?.session.kind).toBe('active'),
    );
    expect(screen.queryByText(t.unreachable)).toBeNull();
    // Retrying restores the saved session; it never starts a sign-in.
    expect(f.navigate).toHaveBeenCalledTimes(navigations);
  },
);
