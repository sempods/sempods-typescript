// @vitest-environment jsdom
/**
 * Apps without sign-in, or with optional sign-in (#240): no gate while the
 * app reads public data without a token, signing in as an action prompt, an
 * address that opens a Pod instead of signing in, and no sign-in at all
 * under `signIn: 'none'`.
 */
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
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
  renewal,
  without,
  work,
} from '../runtime/fixture.test.js';
import { createAppController } from '../authoring/app.js';
import type { BrowserRuntimeOptions } from '../runtime/types.js';
import {
  AppAccess,
  SempodsProvider,
  TargetScreen,
  useAppState,
  useDraftGuard,
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
  // Only the default Pod connects: no address to add another one.
  expect(screen.queryByLabelText('Pod-Adresse')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Öffnen' })).toBeNull();
  expect(f.navigate).not.toHaveBeenCalled();
});

it('lets the person forget a Pod they signed out of, while reading on', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  expect(await runtime.disconnect(id)).toEqual({ kind: 'disconnected' });
  expect(runtime.getSnapshot()[0]).toMatchObject({
    session: { kind: 'signed-out', problem: 'disconnected' },
    reading: 'anonymous',
  });
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Recipes" open />
    </SempodsProvider>,
  );
  const prompt = await waitFor(() => {
    const [shown] = prompts();
    expect(shown?.dataset.reason).toBe('anonymous');
    return shown!;
  });
  expect(within(prompt).getByRole('button', { name: 'Forget' })).toBeTruthy();
  // Management offers it too, and no sign-out without a session.
  const management = document.querySelector<HTMLElement>(
    '[data-sempods-access]:not([hidden])',
  )!;
  expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  await act(async () =>
    within(management).getByRole('button', { name: 'Forget' }).click(),
  );
  // Forgotten: the default Pod is listed again, never signed in to.
  await waitFor(() =>
    expect(runtime.getSnapshot()).toMatchObject([
      { session: { kind: 'signed-out' }, reading: 'anonymous' },
    ]),
  );
  expect(runtime.getSnapshot()[0]!.session).toEqual({ kind: 'signed-out' });
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

function Draft() {
  const [draft, setDraft] = useState('');
  useDraftGuard(draft !== '', () => setDraft(''));
  return (
    <input
      aria-label="Draft"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

it('keeps a draft when the session ends and the app reads on without a token', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Recipes" />
      <TargetScreen>
        <Draft />
        <Reading />
      </TargetScreen>
    </SempodsProvider>,
  );
  const draft = (await screen.findByLabelText('Draft')) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved work' } });
  const before = screen.getByTestId('content');
  await act(async () => {
    await renewal(f, runtime, id, 'refused');
  });
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]!.reading).toBe('anonymous'),
  );
  // Same-target access loss: the screen and its draft stay mounted.
  expect(screen.getByLabelText('Draft')).toBe(draft);
  expect(draft.value).toBe('Unsaved work');
  expect(screen.getByTestId('content')).toBe(before);
  // Once the draft is resolved, the view that reads without a token follows.
  fireEvent.change(draft, { target: { value: '' } });
  await waitFor(() =>
    expect(screen.getByTestId('content').textContent).toMatch(
      /read\s+read-only/,
    ),
  );
});

it('keeps the view for an unconfirmed write until it is resolved', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  const app = createAppController(runtime);
  app.start();
  cleanups.push(() => app.stop());
  await waitFor(() => expect(app.getSnapshot().view).not.toBeNull());
  const held = app.getSnapshot().view;
  let unconfirmed = true;
  const listeners = new Set<() => void>();
  app.register({
    dirty: () => false,
    blocked: () => false,
    unconfirmed: () => unconfirmed,
    discard: () => {},
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  await renewal(f, runtime, id, 'refused');
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]!.reading).toBe('anonymous'),
  );
  expect(app.getSnapshot().view).toBe(held);
  expect(held!.getSnapshot()).toMatchObject({ current: false, write: false });
  unconfirmed = false;
  listeners.forEach((listener) => listener());
  const next = app.getSnapshot().view;
  expect(next).not.toBe(held);
  expect(next!.getSnapshot()).toMatchObject({ current: true, write: false });
});

it('lists every Pod read without a token in the Pod selector', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  await f.runtime.initialize();
  await f.runtime.connect('https://pod.example/bob');
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Recipes" open />
    </SempodsProvider>,
  );
  const selector = (await screen.findByLabelText(
    'Active pod',
  )) as HTMLSelectElement;
  const options = [...selector.options].filter((o) => o.value);
  expect(options).toHaveLength(2);
  await act(async () => {
    fireEvent.change(selector, {
      target: { value: options.find((o) => o.value !== pod)!.value },
    });
  });
  // Choosing it does not sign in.
  expect(f.navigate).not.toHaveBeenCalled();
  expect(
    screen.queryByRole('list', { name: 'Pods on this device' }),
  ).toBeNull();
});
