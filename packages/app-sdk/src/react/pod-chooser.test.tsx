// @vitest-environment jsdom
/**
 * `PodChooser` (#329): the sign-in's Pod chooser placed by a multi-Pod app
 * while signed in, to add or sign in to another Pod.
 */
import { webcrypto } from 'node:crypto';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { IDBObjectStore } from 'fake-indexeddb';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  catalogue,
  deferred,
  fixture,
  pod,
  settleLease,
  without,
  work,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type { BrowserRuntime } from '../runtime/types.js';
import { PodChooser, SempodsProvider, useDraftGuard } from './index.js';

const bob = 'https://pod.example/bob';
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

async function signedIn() {
  const f = fixture();
  const signed = await f.login();
  cleanups.push(() => signed.runtime.dispose());
  return { f, ...signed };
}
function show(runtime: BrowserRuntime, language: 'en' | 'de' = 'en') {
  render(
    <SempodsProvider runtime={runtime} language={language}>
      <PodChooser />
    </SempodsProvider>,
  );
  return screen.getByRole('group', {
    name: language === 'en' ? 'Connect another Pod' : 'Weiteren Pod verbinden',
  });
}
const field = (group: HTMLElement, name = 'Pod address') =>
  within(group).getByRole('combobox', { name }) as HTMLInputElement;
const action = (group: HTMLElement) =>
  within(group)
    .getAllByRole('button')
    .find((b) => b.classList.contains('sp-access-primary')) as
    HTMLButtonElement | undefined;
async function submit(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
  await act(async () => fireEvent.submit(input.closest('form')!));
}

it.each([
  ['en', 'Pod address', 'Sign in', 'What is a Pod?'],
  ['de', 'Pod-Adresse', 'Anmelden', 'Was ist ein Pod?'],
] as const)(
  'starts on a new address with the sign-in’s labels while signed in, and signs in to it (%s)',
  async (language, label, signIn, help) => {
    const { f, runtime, id } = await signedIn();
    const group = show(runtime, language);
    // Not the signed-in Pod: the prefix of a new address, not yet an action.
    const input = await waitFor(() => {
      const found = field(group, label);
      expect(found.disabled).toBe(false);
      return found;
    });
    expect(input.value).toBe('https://sempods.org/');
    expect(action(group)?.textContent).toBe(signIn);
    expect(action(group)?.disabled).toBe(true);
    // Help on request, as in the gate.
    expect(within(group).getByRole('button', { name: help })).toBeTruthy();
    // The gate's own clean-up of the typed address.
    await submit(input, ' pod.example/bob/ ');
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(2));
    expect(new URL(f.navigate.mock.calls[1]![0]).origin).toBe(
      'https://pod.example',
    );
    const pods = runtime.getSnapshot();
    expect(pods.map((c) => c.podUrl)).toEqual([pod, bob]);
    // The first Pod stays signed in.
    expect(pods.find((c) => c.id === id)?.session.kind).toBe('active');
  },
);

it('offers the saved Pods by keyboard and signs in to a chosen one again without adding it twice', async () => {
  const { f, runtime, id } = await signedIn();
  const group = show(runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  fireEvent.keyDown(input, { key: 'ArrowDown' });
  expect(input.getAttribute('aria-expanded')).toBe('true');
  const options = within(group).getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual([
    expect.stringContaining('pod.example/alice'),
  ]);
  // Saved Pods are managed from the same list, as in the gate.
  expect(within(group).getByText('Manage saved Pods')).toBeTruthy();
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(input.value).toBe(pod);
  // Already readable: asked for access again, not switched to or added.
  const button = action(group)!;
  expect(button.textContent).toBe('Change sharing');
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(2));
  expect(runtime.getSnapshot().map((c) => c.id)).toEqual([id]);
});

it('matches a typed address of a connected Pod instead of connecting it again', async () => {
  const { f, runtime, id } = await signedIn();
  const group = show(runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  fireEvent.change(input, { target: { value: 'pod.example/alice/' } });
  expect(action(group)?.textContent).toBe('Change sharing');
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(2));
  expect(runtime.getSnapshot().map((c) => c.id)).toEqual([id]);
});

it('keeps the action disabled and explained while that Pod restores', async () => {
  const { f, runtime: signed } = await signedIn();
  signed.dispose();
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
  const group = show(runtime);
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('restoring'),
  );
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  fireEvent.change(input, { target: { value: 'pod.example/alice' } });
  expect(action(group)?.disabled).toBe(true);
  expect(within(group).getByRole('status').textContent).toBe('Loading…');
  await act(async () => fireEvent.submit(input.closest('form')!));
  expect(f.navigate).toHaveBeenCalledTimes(1);
  // Another address stays available meanwhile.
  fireEvent.change(input, { target: { value: 'pod.example/bob' } });
  expect(action(group)?.disabled).toBe(false);
  await act(async () => discovery.resolve());
});

it('retries a failed sign-out of a typed Pod before anything else', async () => {
  const { runtime, id } = await signedIn();
  const group = show(runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  const write = vi
    .spyOn(IDBObjectStore.prototype, 'put')
    .mockImplementation(() => {
      throw new Error('private fixture storage detail');
    });
  await act(async () => {
    await runtime.disconnect(id);
  });
  expect(runtime.getSnapshot()[0]?.session).toMatchObject({
    kind: 'ended',
    saved: false,
  });
  fireEvent.change(input, { target: { value: 'pod.example/alice' } });
  const alerts = within(group).getAllByRole('alert');
  expect(alerts.map((a) => a.textContent)).toContain(
    'Sign-out was not saved on this device. Try signing out again.',
  );
  expect(action(group)?.textContent).toBe('Try again');
  write.mockRestore();
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('signed-out'),
  );
});

it('opens a Pod in place without sign-in pages and is ready for the next one', async () => {
  const f = fixture({ preferences: null, signIn: 'optional' });
  cleanups.push(() => f.runtime.dispose());
  f.setCatalogue(async () => catalogue([work], []));
  await f.runtime.initialize();
  await f.runtime.connect(pod);
  const group = show(f.runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  expect(action(group)?.textContent).toBe('Open');
  await submit(input, 'pod.example/bob');
  await waitFor(() =>
    expect(f.runtime.getSnapshot().map((c) => c.podUrl)).toEqual([pod, bob]),
  );
  expect(f.navigate).not.toHaveBeenCalled();
  await waitFor(() => expect(input.value).toBe('https://sempods.org/'));
});

it('renders nothing without sign-in, where no other Pod can be added', async () => {
  const f = fixture({
    preferences: null,
    signIn: 'none',
    preset: { podUrl: pod, contextIri: work },
    ...without('identity'),
  });
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <p>content</p>
      <PodChooser />
    </SempodsProvider>,
  );
  await screen.findByText('content');
  expect(screen.queryByRole('group')).toBeNull();
  expect(screen.queryByRole('combobox')).toBeNull();
});

it('starts a finite choice on a permitted Pod not connected yet', async () => {
  const f = fixture({ allowedPods: [pod, bob] });
  const signed = await f.login();
  cleanups.push(() => signed.runtime.dispose());
  const group = show(signed.runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  // The chooser is read-only and holds only the permitted Pods.
  expect(input.readOnly).toBe(true);
  expect(input.value).toBe(bob);
  expect(action(group)?.textContent).toBe('Sign in');
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(2));
  expect(signed.runtime.getSnapshot().map((c) => c.podUrl)).toEqual([pod, bob]);
});

it('stays on the submitted permitted Pod when its sign-in cannot be prepared', async () => {
  const charlie = 'https://pod.example/charlie';
  const f = fixture({ allowedPods: [pod, bob, charlie] });
  const signed = await f.login();
  cleanups.push(() => signed.runtime.dispose());
  const group = show(signed.runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  expect(input.value).toBe(bob);
  // Bob's connection exists before its preparation fails.
  const prepare = vi
    .spyOn(signed.runtime, 'beginAuthorization')
    .mockRejectedValueOnce(new Error('Could not prepare'));
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  await waitFor(() => expect(action(group)?.disabled).toBe(false));
  expect(signed.runtime.getSnapshot().map((c) => c.podUrl)).toEqual([pod, bob]);
  // The error and the retry belong to Bob, not to the next free Pod.
  expect(input.value).toBe(bob);
  expect(within(group).getAllByRole('alert').length).toBeGreaterThan(0);
  prepare.mockRestore();
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(2));
  expect(signed.runtime.getSnapshot().map((c) => c.podUrl)).toEqual([pod, bob]);
});

it('stays on the submitted permitted Pod when its guarded retry is cancelled', async () => {
  const charlie = 'https://pod.example/charlie';
  const f = fixture({ allowedPods: [pod, bob, charlie] });
  const signed = await f.login();
  cleanups.push(() => signed.runtime.dispose());
  function Draft() {
    const [value, setValue] = useState('');
    useDraftGuard(Boolean(value), () => setValue(''));
    return (
      <input
        aria-label="Draft"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  }
  render(
    <SempodsProvider runtime={signed.runtime}>
      <Draft />
      <PodChooser />
    </SempodsProvider>,
  );
  const group = screen.getByRole('group', { name: 'Connect another Pod' });
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  const prepare = vi
    .spyOn(signed.runtime, 'beginAuthorization')
    .mockRejectedValueOnce(new Error('Could not prepare'));
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(prepare).toHaveBeenCalledOnce());
  await waitFor(() => expect(action(group)?.disabled).toBe(false));
  expect(input.value).toBe(bob);
  // The retry asks before leaving the draft; declining it runs nothing.
  fireEvent.change(screen.getByLabelText('Draft'), {
    target: { value: 'Unfinished' },
  });
  await act(async () => fireEvent.submit(input.closest('form')!));
  fireEvent.click(await screen.findByText('Keep editing'));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await waitFor(() => expect(action(group)?.disabled).toBe(false));
  expect(prepare).toHaveBeenCalledOnce();
  expect(screen.getByDisplayValue('Unfinished')).toBeTruthy();
  expect(input.value).toBe(bob);
  prepare.mockRestore();
});

it('signs in to a Pod it already reads without a token, rather than only selecting it', async () => {
  const f = fixture({ preferences: null, signIn: 'optional' });
  cleanups.push(() => f.runtime.dispose());
  f.setCatalogue(async () => catalogue([work], []));
  await f.runtime.initialize();
  const connection = await f.runtime.connect(pod);
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.reading).toBe('anonymous'),
  );
  const group = show(f.runtime);
  const input = await waitFor(() => {
    const found = field(group);
    expect(found.disabled).toBe(false);
    return found;
  });
  fireEvent.change(input, { target: { value: 'pod.example/alice' } });
  expect(action(group)?.textContent).toBe('Sign in');
  await act(async () => fireEvent.submit(input.closest('form')!));
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  expect(f.runtime.getSnapshot().map((c) => c.id)).toEqual([connection.id]);
});
