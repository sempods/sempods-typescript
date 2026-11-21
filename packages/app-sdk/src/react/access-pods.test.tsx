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
  within,
} from '@testing-library/react';
import { AppAccess, SempodsProvider, useDraftGuard } from './index.js';
import {
  catalogue,
  fixture,
  pod,
  restart,
  twoPods,
} from '../runtime/fixture.test.js';

const actionsName = /^(Actions for|Aktionen für) /;

/**
 * The ⋯ button of a Pod row in management: of the Pod named `pod`, else of
 * the only row that has one.
 */
export async function podActions(pod?: string) {
  return waitFor(() => {
    const all = screen
      .getAllByRole('button', { name: actionsName })
      .filter(
        (button) =>
          pod === undefined ||
          button.getAttribute('aria-label')!.replace(actionsName, '') === pod,
      );
    expect(all).toHaveLength(1);
    return all[0]!;
  });
}

/**
 * Opens a Pod row's actions (unless open) and returns the one named
 * `action`, for example "Sign out on this device".
 */
export async function podAction(action: string | RegExp, pod?: string) {
  const trigger = await podActions(pod);
  if (trigger.getAttribute('aria-expanded') !== 'true')
    fireEvent.click(trigger);
  const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
  return within(menu).getByRole('button', { name: action });
}

/** The names of a Pod row's actions, opening them. */
export async function podActionNames(pod?: string) {
  const trigger = await podActions(pod);
  if (trigger.getAttribute('aria-expanded') !== 'true')
    fireEvent.click(trigger);
  const menu = document.getElementById(trigger.getAttribute('aria-controls')!)!;
  return within(menu)
    .getAllByRole('button')
    .map((button) => button.textContent);
}

// Pods & sharing management grouped by Pod (#386): one row per Pod, its
// actions behind its own button, and connecting another Pod as a step.
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

const bob = 'https://pod.example/bob';
const club = bob + '/_system/contexts/club';
/** Alice and Bob signed in, Bob active, each Pod with its own catalogue. */
async function alicesAndBobs() {
  const pods = await twoPods((r) => cleanups.push(() => r.dispose()));
  pods.f.setCatalogue(async (url) =>
    url.startsWith(bob) ? catalogue([club], [], bob) : catalogue(),
  );
  return pods;
}
const catalogueReads = (
  f: { fetch: { mock: { calls: [string, ...unknown[]][] } } },
  base: string,
) =>
  f.fetch.mock.calls.filter(([url]) => url === base + '/_system/contexts')
    .length;
const row = (name: string) => screen.getByRole('group', { name });
const toggle = (element: HTMLElement) =>
  within(element).getAllByRole('button')[0]!;

it('marks the selected Pod, loads another Pod’s access when its row opens and switches only through the guarded action', async () => {
  const { f, runtime } = await alicesAndBobs();
  function Draft() {
    useDraftGuard(true, () => {});
    return null;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Draft />
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Pods & sharing' });
  // Bob is selected: his row is marked and open, Alice's names only her Pod.
  await waitFor(() =>
    expect(within(row('pod.example/bob')).getByText('Selected')).toBeTruthy(),
  );
  expect(toggle(row('pod.example/bob')).getAttribute('aria-expanded')).toBe(
    'true',
  );
  const alice = row('pod.example/alice');
  expect(toggle(alice).getAttribute('aria-expanded')).toBe('false');
  expect(within(alice).queryByText('Selected')).toBeNull();
  expect(within(dialog).queryByRole('combobox', { name: /pod/i })).toBeNull();
  // Opening Alice's row asks her Pod what this app may do there, once.
  const before = catalogueReads(f, pod);
  fireEvent.click(toggle(alice));
  const rights = await within(alice).findByRole('list', {
    name: 'Available to this app',
  });
  expect(
    within(rights)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['workCan edit', 'personalRead only']);
  expect(catalogueReads(f, pod)).toBe(before + 1);
  // Inspecting is not switching.
  expect(within(row('pod.example/bob')).getByText('Selected')).toBeTruthy();
  expect(await podActionNames('pod.example/alice')).toEqual([
    'Change sharing',
    'Use this Pod',
    'Sign out on this device',
  ]);
  expect(await podActionNames('pod.example/bob')).toEqual([
    'Change sharing',
    'Sign out on this device',
  ]);
  // Switching asks before leaving the draft.
  const use = await podAction('Use this Pod', 'pod.example/alice');
  fireEvent.click(use);
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(within(row('pod.example/bob')).getByText('Selected')).toBeTruthy();
  const again = await podAction('Use this Pod', 'pod.example/alice');
  await waitFor(() =>
    expect((again as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(again);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() =>
    expect(within(row('pod.example/alice')).getByText('Selected')).toBeTruthy(),
  );
});

it('shows a combined view without a selected Pod or a switch, with the app’s line', async () => {
  const { runtime } = await alicesAndBobs();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess
        appName="Tasks"
        open
        onClose={() => {}}
        podView="combined"
        podViewDescription="Tasks from all signed-in Pods"
      />
    </SempodsProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Pods & sharing' });
  expect(
    within(dialog).getByText('Tasks from all signed-in Pods'),
  ).toBeTruthy();
  for (const name of ['pod.example/alice', 'pod.example/bob']) {
    expect(within(row(name)).queryByText('Selected')).toBeNull();
    // Several Pods: each row closed until opened.
    expect(toggle(row(name)).getAttribute('aria-expanded')).toBe('false');
    expect(await podActionNames(name)).toEqual([
      'Change sharing',
      'Sign out on this device',
    ]);
  }
});

it('closes a Pod’s actions with Escape, not the dialog, and returns the focus', async () => {
  const f = fixture();
  const { runtime } = await f.login();
  cleanups.push(() => runtime.dispose());
  const onClose = vi.fn();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" open onClose={onClose} />
    </SempodsProvider>,
  );
  const trigger = await podActions();
  expect(trigger.getAttribute('aria-label')).toBe(
    'Actions for pod.example/alice',
  );
  fireEvent.click(trigger);
  const menu = screen.getByRole('group', {
    name: 'Actions for pod.example/alice',
  });
  expect(document.activeElement).toBe(within(menu).getAllByRole('button')[0]);
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(
    screen.queryByRole('group', { name: 'Actions for pod.example/alice' }),
  ).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(onClose).not.toHaveBeenCalled();
});

it.each(['en', 'de'] as const)(
  'connects another Pod in a step of the dialog and goes back to the list (%s)',
  async (language) => {
    const de = language === 'de';
    const f = fixture({ allowedPods: [pod, bob] });
    const { runtime } = await f.login();
    cleanups.push(() => runtime.dispose());
    const onClose = vi.fn();
    render(
      <SempodsProvider runtime={runtime} language={language}>
        <AppAccess appName="Tasks" open onClose={onClose} />
      </SempodsProvider>,
    );
    const title = de ? 'Pods & Freigaben' : 'Pods & sharing';
    const step = de ? 'Weiteren Pod verbinden' : 'Connect another Pod';
    const dialog = await screen.findByRole('dialog', { name: title });
    expect(
      within(dialog).getByText(de ? 'Ausgewählt' : 'Selected'),
    ).toBeTruthy();
    const add = within(dialog).getByRole('button', { name: step });
    fireEvent.click(add);
    // The step names itself, takes the focus and shows the sign-in's chooser
    // on Bob, the permitted Pod not connected yet.
    const heading = within(dialog).getByRole('heading', { name: step });
    expect(document.activeElement).toBe(heading);
    expect(screen.getByRole('dialog', { name: step })).toBe(dialog);
    const chooser = within(dialog).getByRole('combobox', {
      name: de ? 'Pod-Adresse' : 'Pod address',
    }) as HTMLInputElement;
    expect(chooser.value).toBe(bob);
    expect(
      within(dialog).queryByRole('group', { name: 'pod.example/alice' }),
    ).toBeNull();
    // Escape goes back to the list, not out of the dialog.
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
    expect(
      within(dialog).getByRole('group', { name: 'pod.example/alice' }),
    ).toBeTruthy();
    expect(document.activeElement?.textContent).toBe(step);
    // So does Back.
    fireEvent.click(within(dialog).getByRole('button', { name: step }));
    fireEvent.click(
      within(dialog).getByRole('button', { name: de ? 'Zurück' : 'Back' }),
    );
    expect(screen.getByRole('dialog', { name: title })).toBe(dialog);
    expect(document.activeElement?.textContent).toBe(step);
    expect(onClose).not.toHaveBeenCalled();
  },
);

it('tells Pods with the same name apart and names each one’s actions', async () => {
  const { runtime } = await alicesAndBobs();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess
        appName="Tasks"
        open
        onClose={() => {}}
        podNames={{ [pod]: 'Home', [bob]: 'Home' }}
      />
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  expect(row(`Home · ${pod}`)).toBeTruthy();
  expect(row(`Home · ${bob}`)).toBeTruthy();
  expect(await podActions(`Home · ${pod}`)).toBeTruthy();
  expect(await podActions(`Home · ${bob}`)).toBeTruthy();
});

it('marks an unreachable Pod and offers its retry while the other Pod stays usable', async () => {
  const { f, runtime } = await alicesAndBobs();
  const original = f.fetch.getMockImplementation()!;
  f.fetch.mockImplementation((url, init) =>
    url.startsWith(bob + '/.well-known')
      ? Promise.reject(new TypeError('offline'))
      : original(url, init),
  );
  const next = await restart(f, runtime, (r) =>
    cleanups.push(() => r.dispose()),
  );
  await waitFor(() =>
    expect(
      next.getSnapshot().find((entry) => entry.podUrl === bob)?.session,
    ).toMatchObject({ kind: 'ended', restorable: true }),
  );
  render(
    <SempodsProvider runtime={next}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  const unreachable = row('pod.example/bob');
  expect(within(unreachable).getByText('Unavailable')).toBeTruthy();
  expect(await podActionNames('pod.example/bob')).toEqual([
    'Try again',
    'Use this Pod',
    'Sign out on this device',
  ]);
  fireEvent.click(toggle(unreachable));
  expect(
    within(unreachable).getByText(
      'The Pod cannot be reached right now. You stay signed in; this app reconnects when the network is back.',
    ),
  ).toBeTruthy();
  expect(await podActionNames('pod.example/alice')).toContain(
    'Sign out on this device',
  );
  f.fetch.mockImplementation(original);
  const retry = await podAction('Try again', 'pod.example/bob');
  await act(async () => retry.click());
  await waitFor(() =>
    expect(
      next.getSnapshot().find((entry) => entry.podUrl === bob)?.session.kind,
    ).toBe('active'),
  );
});
