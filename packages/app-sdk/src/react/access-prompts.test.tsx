// @vitest-environment jsdom
/**
 * Access prompts and the gate (#238): the gate keeps drafts, prompt actions
 * stay guarded and never run stale, the manual retry stays reachable, the
 * first sign-in completes in both modes, and a custom composition shows each
 * message once.
 */
import { webcrypto } from 'node:crypto';
import { useRef, useState, type CSSProperties, type RefObject } from 'react';
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
  callback,
  fixture,
  pod,
  renewal,
  restored,
  settleLease,
  twoPods,
} from '../runtime/fixture.test.js';
import { createBrowserRuntime } from '../runtime/runtime.js';
import type {
  BrowserRuntime,
  BrowserRuntimeOptions,
} from '../runtime/types.js';
import {
  AccessGate,
  AccessPrompt,
  AccessPrompts,
  AppAccess,
  ContextAccess,
  SempodsProvider,
  TargetScreen,
  useAccessPrompts,
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
const gate = () =>
  document.querySelector<HTMLElement>('[data-sempods-ui="gate"]');
const prompts = () => [
  ...document.querySelectorAll<HTMLElement>('[data-sempods-ui="prompt"]'),
];
async function findGate(reason: string) {
  return waitFor(() => {
    expect(gate()?.dataset.reason).toBe(reason);
    return gate()!;
  });
}

it('keeps a draft mounted behind the gate and asks before signing in leaves it', async () => {
  const f = fixture();
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
      <TargetScreen>
        <Draft />
      </TargetScreen>
    </SempodsProvider>,
  );
  const draft = (await screen.findByLabelText('Draft')) as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved' } });
  // The only session ends: its refresh is refused.
  await act(async () => {
    await renewal(f, runtime, id, 'refused');
  });
  const shown = await findGate('signed-out');
  expect(screen.getByLabelText('Draft')).toBe(draft);
  expect(draft.value).toBe('Unsaved');
  const navigations = f.navigate.mock.calls.length;
  const signIn = () => within(shown).getByRole('button', { name: 'Sign in' });
  await act(async () => signIn().click());
  // The leave confirmation opens above the gate; declining keeps both.
  await act(async () =>
    screen.getByRole('button', { name: 'Keep editing' }).click(),
  );
  expect(gate()).toBe(shown);
  expect(draft.value).toBe('Unsaved');
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  await act(async () => signIn().click());
  await act(async () =>
    screen.getByRole('button', { name: 'Discard and continue' }).click(),
  );
  await waitFor(() =>
    expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
  );
});

/**
 * Two Pods: the returning one (Bob) is active, Alice's session ends; an
 * action prompt for Alice.
 */
async function endedBeside() {
  const {
    f,
    runtime,
    other: bob,
  } = await twoPods((r) => cleanups.push(() => r.dispose()));
  const other = runtime.getSnapshot().find((c) => c.id !== bob.id)!;
  await renewal(f, runtime, other.id, 'refused');
  await waitFor(() =>
    expect(
      runtime.getSnapshot().find((c) => c.id === other.id)?.session.kind,
    ).toMatch(/ended|signed-out/),
  );
  return { f, runtime, other };
}

it('shows a non-active Pod whose session ended as a dismissible action prompt', async () => {
  const { runtime, other } = await endedBeside();
  let access!: ReturnType<typeof useAccessPrompts>;
  function Probe() {
    access = useAccessPrompts();
    return null;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
      <Probe />
    </SempodsProvider>,
  );
  await waitFor(() => expect(prompts()).toHaveLength(1));
  const [prompt] = prompts();
  expect(gate()).toBeNull();
  expect(prompt!.dataset).toMatchObject({
    reason: 'signed-out',
    severity: 'action',
  });
  expect(prompt!.getAttribute('role')).toBe('alert');
  expect(prompt!.textContent).toContain('pod.example/alice');
  expect(
    within(prompt!)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Sign in', 'Forget', 'OK']);
  expect(access.prompts[0]).toMatchObject({ connectionId: other.id });
  await act(async () =>
    within(prompt!).getByRole('button', { name: 'OK' }).click(),
  );
  expect(prompts()).toEqual([]);
  // Management still lists Bob.
  expect(runtime.getSnapshot().some((c) => c.id === other.id)).toBe(true);
});

it('runs nothing and discards nothing when a prompt goes stale during the leave confirmation', async () => {
  const { f, runtime, other } = await endedBeside();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
      <Draft />
    </SempodsProvider>,
  );
  await waitFor(() => expect(prompts()).toHaveLength(1));
  const draft = screen.getByLabelText('Draft') as HTMLInputElement;
  fireEvent.change(draft, { target: { value: 'Unsaved' } });
  const navigations = f.navigate.mock.calls.length;
  await act(async () =>
    within(prompts()[0]!).getByRole('button', { name: 'Sign in' }).click(),
  );
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  // The cause ends while the person is asked: Bob is forgotten elsewhere.
  await act(async () => {
    await runtime.forget(other.id);
  });
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(prompts()).toEqual([]);
  expect(draft.value).toBe('Unsaved');
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
});

it('keeps the manual retry of an unreachable active Pod reachable without an online event', async () => {
  const f = fixture({ preferences: null });
  const signed = await f.login();
  signed.runtime.dispose();
  await settleLease();
  let offline = true;
  const runtime = createBrowserRuntime({
    ...f.options,
    fetch: async (url, init) => {
      if (offline && url.endsWith('/.well-known/oauth-protected-resource'))
        throw new TypeError('offline');
      return f.fetch(url, init);
    },
  });
  cleanups.push(() => runtime.dispose());
  let access!: ReturnType<typeof useAccessPrompts>;
  function Probe() {
    access = useAccessPrompts();
    return null;
  }
  const ui = (key: number) => (
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" key={key} />
      <Probe />
    </SempodsProvider>
  );
  const view = render(ui(1));
  await waitFor(() =>
    expect(prompts().map((p) => p.dataset.reason)).toEqual(['unreachable']),
  );
  // Never a sign-in screen, and no way to dismiss it while it is active.
  expect(gate()).toBeNull();
  expect(
    within(prompts()[0]!)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Try again']);
  expect(access.dismiss(access.prompts[0]!.id)).toBe(false);
  // A remount of the presentation shows it again.
  view.rerender(ui(2));
  expect(prompts()).toHaveLength(1);
  // The Pod is back without the browser reporting `online`.
  offline = false;
  await act(async () =>
    within(prompts()[0]!).getByRole('button', { name: 'Try again' }).click(),
  );
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]?.session.kind).toBe('active'),
  );
  expect(prompts()).toEqual([]);
});

const bob = 'https://pod.example/bob';
it.each(
  (['multiple', 'single'] as const).flatMap((mode) =>
    (
      [
        ['unrestricted', {}],
        ['a preset', { preset: { podUrl: pod } }],
        ['one allowed Pod', { allowedPods: [pod] }],
        ['several allowed Pods', { allowedPods: [pod, bob] }],
      ] as const
    ).map(([name, options]) => [mode, name, options] as const),
  ),
)(
  'completes a first sign-in in mode %s with %s',
  async (mode, name, options) => {
    const f = fixture(options as Partial<BrowserRuntimeOptions>);
    cleanups.push(() => f.runtime.dispose());
    render(
      <SempodsProvider runtime={f.runtime}>
        <AppAccess appName="Tasks" mode={mode} />
      </SempodsProvider>,
    );
    const shown = await findGate('no-connection');
    let target = pod;
    if (name === 'unrestricted') {
      const input = within(shown).getByRole('textbox', { name: 'Pod address' });
      fireEvent.change(input, { target: { value: 'pod.example/alice' } });
      // Enter submits the form.
      await act(async () => fireEvent.submit(input.closest('form')!));
    } else if (name === 'several allowed Pods') {
      expect(within(shown).queryByRole('textbox')).toBeNull();
      const picker = within(shown).getByRole('combobox', {
        name: 'Pod address',
      });
      fireEvent.change(picker, { target: { value: bob } });
      target = bob;
      await act(async () => fireEvent.submit(picker.closest('form')!));
    } else {
      // The address is fixed: one sign-in, no field.
      expect(within(shown).queryByRole('textbox')).toBeNull();
      expect(within(shown).queryByRole('combobox')).toBeNull();
      await act(async () =>
        within(shown).getByRole('button', { name: 'Sign in' }).click(),
      );
    }
    await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
    expect(f.navigate.mock.calls[0]![0].startsWith(target + '/')).toBe(true);
  },
);

/** A saved session, then a callback that matches no stored attempt. */
async function unmatchedCallback() {
  const f = fixture();
  const signed = await f.login();
  signed.runtime.dispose();
  await settleLease();
  const runtime = createBrowserRuntime({
    ...f.options,
    location: () => `${callback}?code=fixture-code&state=unknown`,
  });
  cleanups.push(() => runtime.dispose());
  return { f, runtime };
}

it('offers only OK for a callback that matched no stored attempt', async () => {
  const { f, runtime } = await unmatchedCallback();
  const navigations = f.navigate.mock.calls.length;
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(prompts().map((p) => p.dataset.reason)).toEqual(['sign-in-failed']),
  );
  const [prompt] = prompts();
  expect(gate()).toBeNull();
  expect(
    within(prompt!)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['OK']);
  expect(prompt!.textContent).not.toBe('');
  await act(async () =>
    within(prompt!).getByRole('button', { name: 'OK' }).click(),
  );
  expect(prompts()).toEqual([]);
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
});

it('shows each message once in a custom composition with open management', async () => {
  const { runtime } = await unmatchedCallback();
  function Composed() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <AccessGate appName="Tasks" />
        <ContextAccess appName="Tasks" />
        <AccessPrompts />
        <AppAccess
          appName="Tasks"
          only="management"
          open={open}
          onClose={() => setOpen(false)}
        />
      </>
    );
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Composed />
    </SempodsProvider>,
  );
  await waitFor(() => expect(prompts()).toHaveLength(1));
  const text = prompts()[0]!.textContent!;
  expect(document.querySelectorAll('[data-sempods-ui="prompts"]')).toHaveLength(
    1,
  );
  expect(
    document.querySelectorAll('[data-sempods-ui="management"]'),
  ).toHaveLength(1);
  expect(gate()).toBeNull();
  // No second automatic composition: one connection view, in the dialog.
  expect(
    screen.getAllByRole('region', { name: 'Pods & sharing' }),
  ).toHaveLength(1);
  const occurrences = document.body.textContent!.split(
    text.replace('OK', ''),
  ).length;
  expect(occurrences - 1).toBe(1);
  // Closing management returns to the composition without access feedback twice.
  await act(async () => screen.getByRole('button', { name: 'Close' }).click());
  expect(document.querySelector('[data-sempods-ui="management"]')).toBeNull();
  expect(prompts()).toHaveLength(1);
});

/** A declined re-authorization that kept the session: an info prompt (#227). */
async function sharingUnchanged() {
  const f = fixture();
  const { runtime, id } = await f.login();
  await runtime.beginAuthorization(id);
  const authorization = new URL(f.navigate.mock.calls.at(-1)![0]);
  runtime.dispose();
  await settleLease();
  const next = createBrowserRuntime({
    ...f.options,
    location: () =>
      `${callback}?error=access_denied&state=${authorization.searchParams.get('state')}`,
  });
  cleanups.push(() => next.dispose());
  return { runtime: next };
}

it('hides an info prompt after about 6 seconds by dismissing it, pauses while hovered, and does not replay it', async () => {
  const { runtime } = await sharingUnchanged();
  const timers: { fn: () => void; id: unknown }[] = [];
  const realSet = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    const id = realSet(() => {}, 0);
    if (ms === 6000) timers.push({ fn, id });
    else return realSet(fn, ms);
    return id;
  }) as typeof setTimeout);
  const cleared = vi.spyOn(globalThis, 'clearTimeout');
  let state!: ReturnType<typeof useAppState>;
  function Probe() {
    state = useAppState();
    return null;
  }
  const ui = (key: number) => (
    <SempodsProvider runtime={runtime}>
      <AccessPrompts key={key} />
      <Probe />
    </SempodsProvider>
  );
  const view = render(ui(1));
  await waitFor(() =>
    expect(prompts().map((p) => p.dataset.reason)).toEqual([
      'sharing-unchanged',
    ]),
  );
  expect(prompts()[0]!.getAttribute('role')).toBe('status');
  await waitFor(() => expect(timers).toHaveLength(1));
  // Hovered, the timer stops; leaving starts a new one.
  const item = prompts()[0]!.closest('li')!;
  fireEvent.pointerEnter(item);
  expect(cleared).toHaveBeenCalledWith(timers[0]!.id);
  fireEvent.pointerLeave(item);
  await waitFor(() => expect(timers).toHaveLength(2));
  act(() => timers[1]!.fn());
  expect(prompts()).toEqual([]);
  expect(state.access.prompts).toEqual([]);
  expect(state.callbackNotice).toBe(false);
  // A remount does not replay it.
  view.rerender(ui(2));
  expect(prompts()).toEqual([]);
});

/** A dismissible info prompt beside a Back button (`focusTarget`) and a draft. */
async function promptWithBack(
  surface: 'app-access' | 'own' | 'own-untargeted',
) {
  const { runtime } = await sharingUnchanged();
  function OwnPrompts({
    back,
  }: {
    readonly back?: RefObject<HTMLButtonElement | null>;
  }) {
    const { prompts: shown } = useAccessPrompts();
    return shown.map((p) => (
      <AccessPrompt key={p.id} prompt={p} focusTarget={back} />
    ));
  }
  function App() {
    const back = useRef<HTMLButtonElement>(null);
    return (
      <SempodsProvider runtime={runtime}>
        <button ref={back}>Back</button>
        <input aria-label="Draft" />
        {surface === 'app-access' ? (
          <AppAccess appName="Tasks" focusTarget={back} />
        ) : (
          <OwnPrompts {...(surface === 'own' ? { back } : {})} />
        )}
      </SempodsProvider>
    );
  }
  render(<App />);
  await waitFor(() =>
    expect(prompts().map((p) => p.dataset.reason)).toEqual([
      'sharing-unchanged',
    ]),
  );
}

it.each([
  ['app-access', 'ok'],
  ['app-access', 'escape'],
  ['own', 'escape'],
] as const)(
  'returns focus to focusTarget when a focused prompt is dismissed (%s, %s)',
  async (surface, how) => {
    await promptWithBack(surface);
    const ok = within(prompts()[0]!).getByRole('button', { name: 'OK' });
    act(() => ok.focus());
    if (how === 'ok') await act(async () => ok.click());
    else fireEvent.keyDown(ok, { key: 'Escape' });
    await waitFor(() => expect(prompts()).toEqual([]));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Back' }),
    );
  },
);

it('moves no focus when an unfocused prompt goes', async () => {
  await promptWithBack('app-access');
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  act(() => draft.focus());
  fireEvent.keyDown(prompts()[0]!, { key: 'Escape' });
  await waitFor(() => expect(prompts()).toEqual([]));
  expect(document.activeElement).toBe(draft);
});

it('returns focus to where it came from without a focusTarget', async () => {
  await promptWithBack('own-untargeted');
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  act(() => draft.focus());
  const ok = within(prompts()[0]!).getByRole('button', { name: 'OK' });
  act(() => ok.focus());
  fireEvent.keyDown(ok, { key: 'Escape' });
  await waitFor(() => expect(prompts()).toEqual([]));
  expect(document.activeElement).toBe(draft);
});

it('returns focus after the focused button lost it to the body', async () => {
  // Browsers move focus to the body when a focused button disables itself
  // while its action runs; the prompt still held focus.
  await promptWithBack('app-access');
  const ok = within(prompts()[0]!).getByRole('button', { name: 'OK' });
  act(() => ok.focus());
  act(() => ok.blur());
  expect(document.activeElement).toBe(document.body);
  fireEvent.keyDown(prompts()[0]!, { key: 'Escape' });
  await waitFor(() => expect(prompts()).toEqual([]));
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Back' }),
  );
});

it('shows no prompt and no gate while startup settles and a saved session restores', async () => {
  const f = fixture({ preferences: null });
  const signed = await f.login();
  signed.runtime.dispose();
  await settleLease();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const runtime: BrowserRuntime = createBrowserRuntime({
    ...f.options,
    fetch: async (url, init) => {
      if (url.endsWith('/.well-known/oauth-protected-resource')) await held;
      return f.fetch(url, init);
    },
  });
  cleanups.push(() => runtime.dispose());
  let state!: ReturnType<typeof useAppState>;
  function Probe() {
    state = useAppState();
    return null;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
      <Probe />
    </SempodsProvider>,
  );
  await waitFor(() => expect(state.startup).toBeDefined());
  expect(runtime.getSnapshot()[0]?.session.kind).toBe('restoring');
  expect(state.access).toEqual({ pending: true, blocking: null, prompts: [] });
  expect(gate()).toBeNull();
  expect(screen.queryByText('Loading…')).toBeNull();
  await act(async () => release());
  await restored(runtime);
  expect(state.access.pending).toBe(false);
  expect(gate()).toBeNull();
});

it('shows one gate and one prompt stack for several AppAccess instances', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  const view = render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Tasks" />
      <dialog>
        <AppAccess appName="Tasks" />
      </dialog>
    </SempodsProvider>,
  );
  await findGate('no-connection');
  expect(document.querySelectorAll('[data-sempods-ui="gate"]')).toHaveLength(1);
  // The first instance holds them; unmounting it hands them to the other.
  view.rerender(
    <SempodsProvider runtime={f.runtime}>
      <dialog>
        <AppAccess appName="Tasks" />
      </dialog>
    </SempodsProvider>,
  );
  await findGate('no-connection');
  expect(document.querySelectorAll('[data-sempods-ui="gate"]')).toHaveLength(1);
});

it('keeps open management above a gate that opens after it', async () => {
  // jsdom has no top layer: record the modal order of showModal and close.
  const layer: HTMLDialogElement[] = [];
  const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
  Object.defineProperty(proto, 'showModal', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.setAttribute('open', '');
      layer.push(this);
    },
  });
  Object.defineProperty(proto, 'close', {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.removeAttribute('open');
      if (layer.includes(this)) layer.splice(layer.indexOf(this), 1);
    },
  });
  cleanups.push(() => {
    delete proto.showModal;
    delete proto.close;
  });
  const f = fixture();
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" open onClose={() => {}} />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(layer.map((d) => d.dataset.sempodsUi)).toEqual(['management']),
  );
  // The only session ends while management is open: the gate opens below it.
  await act(async () => {
    await renewal(f, runtime, id, 'refused');
  });
  await findGate('signed-out');
  expect(layer.map((d) => d.dataset.sempodsUi)).toEqual(['gate', 'management']);
});

it('applies AppAccess className and style to the gate', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess
        appName="Tasks"
        className="my-access"
        style={
          {
            '--sempods-bg': 'rgb(1, 2, 3)',
            maxWidth: '30rem',
          } as CSSProperties
        }
      />
    </SempodsProvider>,
  );
  const shown = await findGate('no-connection');
  const surface = shown.querySelector<HTMLElement>('[data-sempods-access]')!;
  expect(surface.classList.contains('my-access')).toBe(true);
  expect(surface.style.maxWidth).toBe('30rem');
  expect(surface.style.getPropertyValue('--sempods-bg')).toBe('rgb(1, 2, 3)');
  // Tokens also reach the layer itself; layout styles stay on the surface.
  expect(shown.style.getPropertyValue('--sempods-bg')).toBe('rgb(1, 2, 3)');
  expect(shown.style.maxWidth).toBe('');
});
