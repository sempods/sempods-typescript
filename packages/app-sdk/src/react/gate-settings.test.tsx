// @vitest-environment jsdom
/**
 * App settings in the access gate (#282): device-local choices such as
 * language and appearance stay reachable while the gate blocks, in a dialog
 * above it. The gate never hides for them, so the content behind it stays
 * covered and mounted, and nothing about sessions or data changes.
 */
import { webcrypto } from 'node:crypto';
import { useRef, useState } from 'react';
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
  fixture,
  renewal,
  restart,
  savedRecords,
  twoPods,
} from '../runtime/fixture.test.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  AccessGate,
  AppAccess,
  ContextAccess,
  SempodsProvider,
  TargetScreen,
  useApp,
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
const settingsDialog = () =>
  document.querySelector<HTMLElement>('[data-sempods-ui="settings"]');
async function findGate(reason: string) {
  return waitFor(() => {
    expect(gate()?.dataset.reason).toBe(reason);
    return gate()!;
  });
}
const writes = (f: ReturnType<typeof fixture>) =>
  f.fetch.mock.calls.filter(
    ([, init]) => (init?.method ?? 'GET').toUpperCase() !== 'GET',
  );

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

/** An app's own language and appearance choices, applied immediately. */
function Choices({
  language,
  setLanguage,
  appearance,
  setAppearance,
}: {
  language: 'en' | 'de';
  setLanguage: (value: 'en' | 'de') => void;
  appearance: 'light' | 'dark';
  setAppearance: (value: 'light' | 'dark') => void;
}) {
  return (
    <>
      <fieldset>
        <legend>Language</legend>
        {(['en', 'de'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="language"
              checked={language === value}
              onChange={() => setLanguage(value)}
            />
            {value === 'en' ? 'English' : 'Deutsch'}
          </label>
        ))}
      </fieldset>
      <fieldset>
        <legend>Appearance</legend>
        {(['light', 'dark'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="appearance"
              checked={appearance === value}
              onChange={() => setAppearance(value)}
            />
            {value}
          </label>
        ))}
      </fieldset>
    </>
  );
}

/** The provider's guarded actions, for a test to act as the app would. */
let app: ReturnType<typeof useApp>;
function Actions() {
  app = useApp();
  return null;
}

/** A host as Focus composes it: provider-level language, one runtime. */
function Host({ runtime }: { runtime: BrowserRuntime }) {
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  const [appearance, setAppearance] = useState<'light' | 'dark'>('light');
  const menu = useRef<HTMLButtonElement>(null);
  return (
    <div data-appearance={appearance}>
      <SempodsProvider runtime={runtime} language={language}>
        <button ref={menu}>Menu</button>
        <AppAccess
          appName="Focus"
          focusTarget={menu}
          settings={{
            label: language === 'en' ? 'Settings' : 'Einstellungen',
            content: (
              <Choices
                language={language}
                setLanguage={setLanguage}
                appearance={appearance}
                setAppearance={setAppearance}
              />
            ),
          }}
        />
        <TargetScreen>
          <Draft />
        </TargetScreen>
        <Actions />
      </SempodsProvider>
    </div>
  );
}

it('opens settings above a no-connection gate and keeps the gate', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(<Host runtime={f.runtime} />);
  const shown = await findGate('no-connection');
  const button = within(shown).getByRole('button', { name: 'Settings' });
  expect(button.getAttribute('aria-haspopup')).toBe('dialog');
  expect(button.getAttribute('type')).toBe('button');
  // The gate's initial focus stays on its sign-in view, not on the button.
  expect(document.activeElement).not.toBe(button);
  await act(async () => button.click());
  const dialog = screen.getByRole('dialog', { name: 'Settings' });
  expect(dialog).toBe(settingsDialog());
  expect(gate()).toBe(shown);
  expect(within(dialog).getByRole('radio', { name: 'English' })).toBeTruthy();
  // Close returns focus to the gate's button; the gate never left.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(settingsDialog()).toBeNull();
  expect(gate()).toBe(shown);
  expect(document.activeElement).toBe(button);
  // Escape (a close request) closes only the settings dialog.
  await act(async () => button.click());
  fireEvent(settingsDialog()!, new Event('cancel', { cancelable: true }));
  expect(settingsDialog()).toBeNull();
  expect(gate()).toBe(shown);
  // A click beside it, on the backdrop, closes it too.
  await act(async () => button.click());
  fireEvent.click(settingsDialog()!);
  expect(settingsDialog()).toBeNull();
  expect(gate()).toBe(shown);
  expect(writes(f)).toEqual([]);
});

it('switches language and appearance from the gate with one runtime initialization', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  const initialize = vi.spyOn(f.runtime, 'initialize');
  const view = render(<Host runtime={f.runtime} />);
  const shown = await findGate('no-connection');
  expect(within(shown).getByRole('button', { name: 'Sign in' })).toBeTruthy();
  await act(async () =>
    within(shown).getByRole('button', { name: 'Settings' }).click(),
  );
  const dialog = settingsDialog()!;
  await act(async () =>
    within(dialog).getByRole('radio', { name: 'Deutsch' }).click(),
  );
  await act(async () =>
    within(dialog).getByRole('radio', { name: 'dark' }).click(),
  );
  // The same gate and dialog re-render in the new language.
  expect(gate()).toBe(shown);
  expect(settingsDialog()).toBe(dialog);
  expect(within(shown).getByRole('button', { name: 'Anmelden' })).toBeTruthy();
  expect(
    within(dialog).getByRole('heading', { name: 'Einstellungen' }),
  ).toBeTruthy();
  expect(view.container.querySelector('[data-appearance="dark"]')).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }));
  expect(document.activeElement).toBe(
    within(shown).getByRole('button', { name: 'Einstellungen' }),
  );
  expect(initialize).toHaveBeenCalledTimes(1);
});

it('keeps a dirty editor behind the gate after session loss while settings change', async () => {
  const f = fixture({ preferences: null });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  const initialize = vi.spyOn(runtime, 'initialize');
  render(<Host runtime={runtime} />);
  const draft = (await screen.findByLabelText('Draft')) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved' } });
  await act(async () => {
    await renewal(f, runtime, id, 'refused');
  });
  const shown = await findGate('signed-out');
  const before = writes(f).length;
  await act(async () =>
    within(shown).getByRole('button', { name: 'Settings' }).click(),
  );
  await act(async () =>
    within(settingsDialog()!).getByRole('radio', { name: 'Deutsch' }).click(),
  );
  fireEvent(settingsDialog()!, new Event('cancel', { cancelable: true }));
  // The gate for this Pod is still there; the draft stays mounted behind it.
  expect(gate()).toBe(shown);
  expect(screen.getByLabelText('Draft')).toBe(draft);
  expect(draft.value).toBe('Unsaved');
  expect(within(shown).getByText('pod.example/alice')).toBeTruthy();
  // The provider initializes its runtime once; settings never again.
  expect(initialize).toHaveBeenCalledTimes(1);
  expect(writes(f)).toHaveLength(before);
});

it('offers settings beside a remembered Pod after a reload and forgets it without writes', async () => {
  const f = fixture({ preferences: null });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  await runtime.disconnect(id);
  await vi.waitFor(async () =>
    expect(
      (await savedRecords(f.factory)).find((r) => r.id === id)?.value,
    ).toMatchObject({ kind: 'disconnected' }),
  );
  const next = await restart(f, runtime, (r) =>
    cleanups.push(() => r.dispose()),
  );
  render(<Host runtime={next} />);
  const shown = await findGate('signed-out');
  const list = within(shown).getByRole('list', { name: 'Pods on this device' });
  await act(async () =>
    within(shown).getByRole('button', { name: 'Settings' }).click(),
  );
  fireEvent.click(
    within(settingsDialog()!).getByRole('button', { name: 'Close' }),
  );
  expect(gate()).toBe(shown);
  expect(within(shown).getByRole('list', { name: 'Pods on this device' })).toBe(
    list,
  );
  // Forget still works from the same gate, and sends nothing to the Pod.
  const before = writes(f).length;
  await act(async () =>
    within(list)
      .getByRole('button', { name: 'Remove from this device' })
      .click(),
  );
  await waitFor(() => expect(next.getSnapshot()).toEqual([]));
  expect(writes(f)).toHaveLength(before);
});

it('removes the dialog with the gate when the cause ends, focusing the focus target', async () => {
  const {
    f,
    runtime,
    other: bob,
  } = await twoPods((r) => cleanups.push(() => r.dispose()));
  const alice = runtime.getSnapshot().find((c) => c.id !== bob.id)!;
  render(<Host runtime={runtime} />);
  await waitFor(() => expect(runtime.getSnapshot()[0]).toBeTruthy());
  expect(gate()).toBeNull();
  // The session of the active Pod (Bob) ends: the gate blocks, Alice stays
  // signed in. (A sign-out would switch to Alice by itself.)
  await act(async () => {
    await renewal(f, runtime, bob.id, 'refused');
  });
  const shown = await findGate('signed-out');
  await act(async () =>
    within(shown).getByRole('button', { name: 'Settings' }).click(),
  );
  within(settingsDialog()!).getByRole('radio', { name: 'English' }).focus();
  // Switching to Alice ends the cause under the same provider.
  await act(async () => app.selectConnection(alice.id));
  await waitFor(() => expect(gate()).toBeNull());
  expect(settingsDialog()).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Menu' }),
  );
});

it('shows settings only in the gate', async () => {
  const f = fixture();
  const { runtime } = await f.login();
  cleanups.push(() => runtime.dispose());
  const settings = { label: 'Settings', content: <p>Choices</p> };
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Focus" settings={settings} open onClose={() => {}} />
      <ContextAccess appName="Focus" />
    </SempodsProvider>,
  );
  await screen.findByRole('dialog', { name: 'Pods & sharing' });
  expect(gate()).toBeNull();
  expect(screen.queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(screen.queryByText('Choices')).toBeNull();
});

it('shows no settings button without the prop', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AccessGate appName="Focus" />
    </SempodsProvider>,
  );
  const shown = await findGate('no-connection');
  expect(within(shown).queryByRole('button', { name: 'Settings' })).toBeNull();
  expect(settingsDialog()).toBeNull();
});
