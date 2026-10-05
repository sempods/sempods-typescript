// @vitest-environment jsdom
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
import {
  fixture,
  pod,
  work,
  personal,
  settleLease,
  catalogue,
} from '../runtime/fixture.test.js';
import {
  AppShell,
  SempodsProvider,
  ConnectionControls,
  AccessNotice,
  useApp,
  useAppState,
} from './index.js';
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
  'offers one preset sign-in with no URL input and preserves failure feedback (%s)',
  async (language) => {
    const f = fixture({ preset: { podUrl: pod } });
    cleanups.push(() => f.runtime.dispose());
    const mounted = render(
      <SempodsProvider runtime={f.runtime} language={language}>
        <AppShell mode="single">{null}</AppShell>
      </SempodsProvider>,
    );
    const button = await screen.findByRole('button', {
      name: language === 'en' ? 'Sign in' : 'Anmelden',
    });
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(f.fetch).not.toHaveBeenCalled();
    // Two copies consume the same controller and cannot launch two authorization flows.
    mounted.rerender(
      <SempodsProvider runtime={f.runtime} language={language}>
        <ConnectionControls />
        <ConnectionControls />
      </SempodsProvider>,
    );
    const buttons = screen.getAllByRole('button', {
      name: button.textContent!,
    });
    f.fetch.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
    });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(f.runtime.getSnapshot()).toHaveLength(0);
    await act(async () => {
      buttons[0]!.click();
      buttons[1]!.click();
    });
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
    expect(f.runtime.getSnapshot()).toHaveLength(1);
  },
);

it('shows configured-context absence without offering another context, and recovers using catalogue facts', async () => {
  const missing = pod + '/_system/contexts/not-yet-granted';
  const f = fixture({ preset: { podUrl: pod, contextIri: missing } });
  const { connection } = await f.begin();
  f.runtime.dispose();
  await settleLease();
  const runtime = f.returned();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppShell>{null}</AppShell>
    </SempodsProvider>,
  );
  await screen.findByText(
    'The configured context is not readable on this Pod.',
  );
  expect(screen.queryByLabelText('Data context')).toBeNull();
  expect(runtime.getSnapshot()[0]!.selectedContext).toBeNull();
  expect(screen.getByRole('button', { name: 'Update access' })).toBeTruthy();
  f.setCatalogue(async () => catalogue([missing], []));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
  });
  await screen.findByText('You can read this context, but cannot change it.');
  expect(runtime.bind(connection.id).contextIri).toBe(missing);
});

function Custom() {
  const app = useApp();
  const { preset, connections } = useAppState();
  return (
    <>
      <p>{preset?.podUrl}</p>
      <button onClick={() => void app.connect()}>Custom sign-in</button>
      <output>{connections.length}</output>
      <AccessNotice />
    </>
  );
}
it('exposes the same preset and guarded default action without AppShell', async () => {
  const f = fixture({ preset: { podUrl: pod, contextIri: work } });
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <Custom />
    </SempodsProvider>,
  );
  await waitFor(() => expect(screen.getByText(pod)).toBeTruthy());
  await act(async () => {
    await f.runtime.initialize();
  });
  await act(async () =>
    fireEvent.click(screen.getByRole('button', { name: 'Custom sign-in' })),
  );
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  expect(f.runtime.getSnapshot()).toHaveLength(1);
});

it('retains explicit context choice for a preset without an exact context', async () => {
  const f = fixture({ preset: { podUrl: pod } });
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  render(
    <SempodsProvider runtime={session.runtime}>
      <AppShell mode="single">{null}</AppShell>
    </SempodsProvider>,
  );
  const select = await screen.findByLabelText('Data context');
  fireEvent.change(select, { target: { value: personal } });
  await waitFor(() =>
    expect(session.runtime.bind(session.id).contextIri).toBe(personal),
  );
  expect(screen.queryByRole('textbox')).toBeNull();
});
