// @vitest-environment jsdom
/**
 * Apps without sign-in, or with optional sign-in (#240): no gate while the
 * app reads public data without a token, signing in as an action prompt, an
 * address that opens a Pod instead of signing in, and no sign-in at all
 * under `signIn: 'none'`.
 */
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
import {
  catalogue,
  fixture,
  pod,
  without,
  work,
} from '../runtime/fixture.test.js';
import type { BrowserRuntimeOptions } from '../runtime/types.js';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
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

const gate = () =>
  document.querySelector<HTMLElement>('[data-sempods-ui="gate"]');
const prompts = () => [
  ...document.querySelectorAll<HTMLElement>('[data-sempods-ui="prompt"]'),
];
function start(overrides: Partial<BrowserRuntimeOptions>) {
  const f = fixture({ preferences: null, ...overrides });
  cleanups.push(() => f.runtime.dispose());
  // Only `work` is public; without a token the catalogue lists it read-only.
  f.setCatalogue(async () => catalogue([work], []));
  return f;
}
function Reading() {
  const { view } = useAppState();
  const access = view?.getSnapshot();
  return (
    <p data-testid="content">
      {view?.contextIri} {access?.read ? 'read' : ''}{' '}
      {access?.write ? 'write' : 'read-only'}
    </p>
  );
}

it('reads public data without a gate and offers signing in as a prompt', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Recipes" />
      <TargetScreen>
        <Reading />
      </TargetScreen>
    </SempodsProvider>,
  );
  // The chooser lists the public Context; choosing it opens the screen.
  const chooser = (await screen.findByLabelText(
    'Data context',
  )) as HTMLSelectElement;
  expect(gate()).toBeNull();
  await act(async () => {
    fireEvent.change(chooser, { target: { value: work } });
  });
  await waitFor(() =>
    expect(screen.getByTestId('content').textContent).toMatch(
      /read\s+read-only/,
    ),
  );
  const [prompt] = await waitFor(() => {
    const shown = prompts();
    expect(shown).toHaveLength(1);
    return shown;
  });
  expect(prompt!.dataset.reason).toBe('anonymous');
  expect(prompt!.textContent).toContain('You see this Pod’s public data.');
  expect(f.navigate).not.toHaveBeenCalled();
  await act(async () =>
    within(prompt!).getByRole('button', { name: 'Sign in' }).click(),
  );
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
});

it('opens a Pod by its address without signing in', async () => {
  const f = start({ signIn: 'optional' });
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Recipes" />
    </SempodsProvider>,
  );
  await waitFor(() => expect(gate()?.dataset.reason).toBe('no-connection'));
  fireEvent.change(within(gate()!).getByLabelText('Pod address'), {
    target: { value: 'pod.example/alice' },
  });
  await act(async () =>
    within(gate()!).getByRole('button', { name: 'Open' }).click(),
  );
  await waitFor(() => expect(gate()).toBeNull());
  expect(f.runtime.getSnapshot()).toMatchObject([
    { podUrl: pod, reading: 'anonymous' },
  ]);
  expect(f.navigate).not.toHaveBeenCalled();
});

it('offers no sign-in under none and explains read-only access in German', async () => {
  const f = start({
    signIn: 'none',
    preset: { podUrl: pod, contextIri: work },
    ...without('identity'),
  });
  render(
    <SempodsProvider runtime={f.runtime} locale="de-DE">
      <AppAccess appName="Rezepte" open />
      <TargetScreen>
        <Reading />
      </TargetScreen>
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(screen.getByTestId('content').textContent).toContain(work),
  );
  expect(gate()).toBeNull();
  expect(prompts()).toEqual([]);
  expect(screen.queryByRole('button', { name: 'Anmelden' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Abmelden' })).toBeNull();
  expect(f.navigate).not.toHaveBeenCalled();
});

it('shows the anonymous prompt in German', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  render(
    <SempodsProvider runtime={f.runtime} locale="de-DE">
      <AppAccess appName="Rezepte" />
    </SempodsProvider>,
  );
  const prompt = await waitFor(() => {
    const [shown] = prompts();
    expect(shown?.dataset.reason).toBe('anonymous');
    return shown!;
  });
  expect(prompt.textContent).toContain(
    'Du siehst die öffentlichen Daten dieses Pods.',
  );
  expect(within(prompt).getByRole('button', { name: 'Anmelden' })).toBeTruthy();
});

it('says when a Pod shares no public data', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  f.setCatalogue(async () => catalogue([], []));
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Recipes" />
      <TargetScreen>
        <Reading />
      </TargetScreen>
    </SempodsProvider>,
  );
  expect(
    await screen.findByText(
      'This Pod shares no public data. Sign in to see what you have access to.',
    ),
  ).toBeTruthy();
  expect(gate()).toBeNull();
});
