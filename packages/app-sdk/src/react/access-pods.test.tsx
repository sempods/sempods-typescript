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
import { fields, text } from '@sempods/client-sdk/edit';
import {
  AppAccess,
  SempodsProvider,
  useCreation,
  useDraftGuard,
} from './index.js';
import {
  catalogue,
  deferred,
  fixture,
  pod,
  restart,
  returnedSession,
  storeWith,
  twoPods,
  work,
} from '../runtime/fixture.test.js';
import {
  actionsName,
  podAction,
  podActionNames,
  podActions,
  podToggle,
} from './pod-actions.helpers.test.js';
import { englishMessages, germanMessages } from '../locale.js';

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

it('finds the Pod actions by the label of each shipped locale', () => {
  for (const messages of [englishMessages, germanMessages]) {
    const label = messages.podActions!('pod.example/alice');
    expect(label.replace(actionsName, '')).toBe('pod.example/alice');
  }
});

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
  expect(podToggle(row('pod.example/bob')).getAttribute('aria-expanded')).toBe(
    'true',
  );
  const alice = row('pod.example/alice');
  expect(podToggle(alice).getAttribute('aria-expanded')).toBe('false');
  expect(within(alice).queryByText('Selected')).toBeNull();
  expect(within(dialog).queryByRole('combobox', { name: /pod/i })).toBeNull();
  // Opening Alice's row asks her Pod what this app may do there, once.
  const before = catalogueReads(f, pod);
  fireEvent.click(podToggle(alice));
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
    expect(podToggle(row(name)).getAttribute('aria-expanded')).toBe('false');
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
  // Shift+Tab back to ⋯ keeps them open; Escape there closes only them.
  fireEvent.click(trigger);
  const first = within(
    screen.getByRole('group', { name: 'Actions for pod.example/alice' }),
  ).getAllByRole('button')[0]!;
  fireEvent.blur(first, { relatedTarget: trigger });
  trigger.focus();
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(fireEvent.keyDown(trigger, { key: 'Escape' })).toBe(false);
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(trigger);
  expect(onClose).not.toHaveBeenCalled();
});

it('closes a Pod’s actions opened by a pointer once the keyboard leaves them', async () => {
  const f = fixture();
  const { runtime } = await f.login();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  const trigger = await podActions();
  // A pointer opens them: its press ends before they open.
  fireEvent.pointerDown(trigger);
  fireEvent.pointerUp(trigger);
  fireEvent.click(trigger);
  const menu = screen.getByRole('group', {
    name: 'Actions for pod.example/alice',
  });
  // Tab from the last action to the next control.
  const last = within(menu).getAllByRole('button').at(-1)!;
  const next = screen.getByRole('button', { name: 'Connect another Pod' });
  fireEvent.blur(last, { relatedTarget: next });
  expect(
    screen.queryByRole('group', { name: 'Actions for pod.example/alice' }),
  ).toBeNull();
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
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

it.each(['required', 'on-demand'] as const)(
  'shows a preset’s fixed Context with what the app may do there (%s)',
  async (contextSelection) => {
    const f = await returnedSession(
      (r) => cleanups.push(() => r.dispose()),
      fixture({ preferences: null, preset: { podUrl: pod, contextIri: work } }),
    );
    render(
      <SempodsProvider runtime={f.runtime} contextSelection={contextSelection}>
        <AppAccess appName="Tasks" open onClose={() => {}} />
      </SempodsProvider>,
    );
    await screen.findByRole('dialog', { name: 'Pods & sharing' });
    const alice = await screen.findByRole('group', {
      name: 'pod.example/alice',
    });
    const fixed = await within(alice).findByText(/^Data context: /);
    await waitFor(() =>
      expect(fixed.textContent).toBe('Data context: work · Can edit'),
    );
    expect(screen.queryByRole('combobox', { name: 'Data context' })).toBeNull();
  },
);

it.each(['required', 'on-demand'] as const)(
  'names a missing preset Context, not an empty Pod (%s)',
  async (contextSelection) => {
    const missing = pod + '/_system/contexts/not-yet-granted';
    const f = await returnedSession(
      (r) => cleanups.push(() => r.dispose()),
      fixture({
        preferences: null,
        preset: { podUrl: pod, contextIri: missing },
      }),
    );
    f.setCatalogue(async () => catalogue([work], []));
    render(
      <SempodsProvider runtime={f.runtime} contextSelection={contextSelection}>
        <AppAccess appName="Tasks" open onClose={() => {}} />
      </SempodsProvider>,
    );
    const alice = await screen.findByRole('group', {
      name: 'pod.example/alice',
    });
    await waitFor(() =>
      expect(
        within(alice).getAllByText(
          'The configured context is not readable on this Pod.',
        ),
      ).toHaveLength(1),
    );
    expect(within(alice).queryByText(/^No readable contexts/)).toBeNull();
  },
);

it('focuses the Pod just opened once no other permitted Pod is left to connect', async () => {
  const f = fixture({ signIn: 'optional', allowedPods: [pod, bob] });
  const { runtime } = await f.login();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Pods & sharing' });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Connect another Pod' }),
  );
  // Bob's Pod opens without a redirect: back in the list, nothing to add.
  await act(async () =>
    within(dialog).getByRole('button', { name: 'Open' }).click(),
  );
  const bobs = await within(dialog).findByRole('group', {
    name: 'pod.example/bob',
  });
  expect(
    within(dialog).queryByRole('button', { name: 'Connect another Pod' }),
  ).toBeNull();
  expect(document.activeElement).toBe(podToggle(bobs));
});

it('signs out of another Pod keeping the selected Pod’s drafts, also in an explicit Context', async () => {
  const { f, runtime } = await alicesAndBobs();
  f.setCatalogue(async (url) =>
    url.startsWith(bob) ? catalogue([club], [club], bob) : catalogue(),
  );
  const task = fields(
    { title: text('urn:title', { language: null }) },
    { type: 'urn:Task' },
  );
  const discarded = vi.fn();
  function Drafts() {
    useDraftGuard(true, discarded);
    const creation = useCreation(task, {
      initial: { title: '' },
      collection: 'tasks',
      context: club,
    });
    return (
      <input
        aria-label="Title"
        disabled={!creation.canEdit}
        value={creation.draft.title}
        onChange={(e) => creation.change({ title: e.target.value })}
      />
    );
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Drafts />
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  const title = screen.getByLabelText('Title') as HTMLInputElement;
  await waitFor(() => expect(title.disabled).toBe(false));
  fireEvent.change(title, { target: { value: 'Club evening' } });
  const signOut = await podAction(
    'Sign out on this device',
    'pod.example/alice',
  );
  await act(async () => signOut.click());
  await waitFor(() =>
    expect(
      runtime.getSnapshot().find((entry) => entry.podUrl === pod)?.session.kind,
    ).toBe('signed-out'),
  );
  expect(screen.queryByRole('button', { name: 'Discard changes' })).toBeNull();
  expect(title.value).toBe('Club evening');
  expect(discarded).not.toHaveBeenCalled();
});

it('moves a focus lost with a removed Pod’s row to the list', async () => {
  const { runtime } = await alicesAndBobs();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  const signOut = await podAction(
    'Sign out on this device',
    'pod.example/alice',
  );
  await act(async () => signOut.click());
  // Her saved address is removed once she is signed out.
  await waitFor(() =>
    expect(
      runtime.getSnapshot().find((entry) => entry.podUrl === pod)?.session.kind,
    ).toBe('signed-out'),
  );
  const remove = await podAction(/^Remove/, 'pod.example/alice');
  await act(async () => remove.click());
  await waitFor(() =>
    expect(
      screen.queryByRole('group', { name: 'pod.example/alice' }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(podToggle(row('pod.example/bob'))),
  );
});

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
  fireEvent.click(podToggle(unreachable));
  expect(
    within(unreachable).getByText(
      'The Pod cannot be reached right now. You stay signed in; this app reconnects when the network is back.',
    ),
  ).toBeTruthy();
  expect(await podActionNames('pod.example/alice')).toContain(
    'Sign out on this device',
  );
  // While Bob's Pod is asked again, only Bob's actions wait.
  let answer = () => {};
  const reached = new Promise<void>((resolve) => (answer = resolve));
  f.fetch.mockImplementation(async (url, init) => {
    if (url.startsWith(bob + '/.well-known')) await reached;
    return original(url, init);
  });
  const retry = await podAction('Try again', 'pod.example/bob');
  await act(async () => retry.click());
  expect(
    (
      await podAction('Sign out on this device', 'pod.example/bob')
    ).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    (await podAction('Change sharing', 'pod.example/alice')).hasAttribute(
      'disabled',
    ),
  ).toBe(false);
  await act(async () => answer());
  await waitFor(() =>
    expect(
      next.getSnapshot().find((entry) => entry.podUrl === bob)?.session.kind,
    ).toBe('active'),
  );
});

it('shows a failed retry in its Pod’s row, apart from the other Pod', async () => {
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
  vi.spyOn(next, 'retryRestore').mockRejectedValue(new Error('offline'));
  render(
    <SempodsProvider runtime={next}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  const dialog = await screen.findByRole('dialog', { name: 'Pods & sharing' });
  const retry = await podAction('Try again', 'pod.example/bob');
  await act(async () => retry.click());
  await waitFor(() =>
    expect(within(row('pod.example/bob')).getByRole('alert')).toBeTruthy(),
  );
  expect(within(row('pod.example/alice')).queryByRole('alert')).toBeNull();
  // Not repeated at the end of the list, where it would name no Pod.
  expect(within(dialog).getAllByRole('alert')).toHaveLength(1);
});

it('leaves the focus alone when another Pod’s row goes', async () => {
  const { f, runtime } = await alicesAndBobs();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
      <button type="button">Outside</button>
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  // The person was last in Bob's row, then the focus was lost elsewhere.
  podToggle(row('pod.example/bob')).focus();
  (document.activeElement as HTMLElement).blur();
  expect(document.activeElement).toBe(document.body);
  // Alice's saved address is removed elsewhere.
  await act(async () => {
    await runtime.forget(f.id);
  });
  await waitFor(() =>
    expect(
      screen.queryByRole('group', { name: 'pod.example/alice' }),
    ).toBeNull(),
  );
  expect(document.activeElement).toBe(document.body);
});

it('closes a Pod’s actions once it has none left', async () => {
  const { f, runtime } = await alicesAndBobs();
  // Removing Alice's saved address waits until the test lets it finish.
  const held = deferred<void>();
  const next = await restart(
    f,
    runtime,
    (r) => cleanups.push(() => r.dispose()),
    {
      openStore: storeWith(f.factory, (store) => ({
        remove: async (...args) => {
          await held.promise;
          return store.remove(...args);
        },
      })),
    },
  );
  render(
    <SempodsProvider runtime={next}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  fireEvent.click(await podActions('pod.example/alice'));
  expect(document.querySelector('.sp-pod-menu')).not.toBeNull();
  // Removed elsewhere while its actions are open: until that is saved, the
  // Pod has no action left.
  let removal: Promise<unknown> | undefined;
  act(() => {
    removal = next.forget(f.id);
  });
  await waitFor(() =>
    expect(
      next.getSnapshot().find((entry) => entry.id === f.id)?.session,
    ).toMatchObject({ kind: 'ended', forget: true }),
  );
  expect(row('pod.example/alice')).toBeTruthy();
  await waitFor(() =>
    expect(document.querySelector('.sp-pod-menu')).toBeNull(),
  );
  await act(async () => {
    held.resolve();
    await removal;
  });
});
