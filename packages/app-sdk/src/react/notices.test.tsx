// @vitest-environment jsdom
/**
 * The shared notification host (#385): app notices by key beside the access
 * prompts, one announcement per event, bounded and coalesced, guarded
 * actions, timers that pause, the gate before sign-in, a covering modal, and
 * `AppAccess` unchanged without the host.
 */
import { webcrypto } from 'node:crypto';
import { useRef, useState, type ReactNode } from 'react';
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
import { fixture, renewal, twoPods } from '../runtime/fixture.test.js';
import type { BrowserRuntime } from '../runtime/types.js';
import {
  AppAccess,
  Notices,
  SempodsProvider,
  useApp,
  useNotice,
  useNotices,
  type Notice,
  type NoticeActions,
  type NoticeProps,
  type NoticeView,
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

const host = () =>
  document.querySelector<HTMLElement>(
    '[data-sempods-ui="notices"]:not([data-placement])',
  )!;
const items = (root: ParentNode = host()) => [
  ...root.querySelectorAll<HTMLElement>('li'),
];
const texts = (root?: ParentNode) =>
  items(root).map((item) => item.textContent);
/** What the live regions of `root` announced, in order. */
const announced = (root: ParentNode = host()) =>
  [...root.querySelectorAll('.sp-notices-live p')].map((p) => p.textContent);

async function signedIn() {
  const f = fixture();
  const { runtime } = await f.login();
  cleanups.push(() => runtime.dispose());
  return runtime;
}

let actions!: NoticeActions;
function Publisher() {
  actions = useNotices();
  return null;
}
function App({
  runtime,
  children,
  limit,
}: {
  readonly runtime: BrowserRuntime;
  readonly children?: ReactNode;
  readonly limit?: number;
}) {
  return (
    <SempodsProvider runtime={runtime}>
      <Notices limit={limit} />
      <Publisher />
      {children}
    </SempodsProvider>
  );
}

/** Captures the 6 second notice timers; others run as usual. */
function briefTimers() {
  const timers: { fn: () => void; ms: number; id: unknown; live: boolean }[] =
    [];
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
    fn: () => void,
    ms?: number,
  ) => {
    if (ms === 6000 || ms === 1500) {
      const id = realSet(() => {}, 0);
      timers.push({ fn, ms, id, live: true });
      return id;
    }
    return realSet(fn, ms);
  }) as typeof setTimeout);
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((id: unknown) => {
    for (const timer of timers) if (timer.id === id) timer.live = false;
    realClear(id as ReturnType<typeof setTimeout>);
  }) as typeof clearTimeout);
  return timers;
}
/** The brief timers still running. */
const running = (timers: ReturnType<typeof briefTimers>) =>
  timers.filter((timer) => timer.live);

it('shows, updates, coalesces and dismisses a notice by key, announcing each event once', async () => {
  const runtime = await signedIn();
  render(<App runtime={runtime} />);
  act(() => actions.show({ key: 'batch', text: 'Three items bought.' }));
  expect(texts()).toEqual(['Three items bought.OK']);
  // The visible notice has no live role: the host announces it once.
  expect(items()[0]!.querySelector('[role]')).toBeNull();
  expect(announced()).toEqual(['Three items bought.']);
  // An identical repeat coalesces: one entry, no second announcement.
  act(() => actions.show({ key: 'batch', text: 'Three items bought.' }));
  expect(items()).toHaveLength(1);
  expect(announced()).toEqual(['Three items bought.']);
  // A changed one updates in place and is announced.
  act(() =>
    actions.show({ key: 'batch', title: 'Done', text: 'Four items bought.' }),
  );
  expect(texts()).toEqual(['DoneFour items bought.OK']);
  expect(announced()).toEqual([
    'Three items bought.',
    'Done. Four items bought.',
  ]);
  // Each addition is read alone: the regions are not atomic.
  for (const region of host().querySelectorAll('.sp-notices-live'))
    expect([
      region.getAttribute('aria-atomic'),
      region.getAttribute('aria-relevant'),
    ]).toEqual(['false', 'additions']);
  act(() => expect(actions.dismiss('batch')).toBe(true));
  expect(items()).toEqual([]);
  expect(actions.dismiss('batch')).toBe(false);
  // A new event after dismissal shows it again.
  act(() => actions.show({ key: 'batch', text: 'Four items bought.' }));
  expect(items()).toHaveLength(1);
});

it('keeps severity apart from acknowledgement: brief info hides, warnings, errors and actions wait', async () => {
  const runtime = await signedIn();
  const timers = briefTimers();
  render(<App runtime={runtime} />);
  act(() => {
    actions.show({ key: 'info', text: 'Saved list.' });
    actions.show({ key: 'warning', text: 'Slow Pod.', severity: 'warning' });
    actions.show({ key: 'error', text: 'Pod failed.', severity: 'error' });
    actions.show({
      key: 'undo',
      text: 'Removed.',
      action: { label: 'Undo', run: () => {} },
    });
    actions.show({
      key: 'short-error',
      text: 'Copied with errors.',
      severity: 'error',
      duration: 1500,
    });
  });
  // Over the limit of 3, the waiting ones go first.
  expect(items().map((item) => item.dataset.severity)).toEqual([
    'warning',
    'error',
    'info',
  ]);
  act(() => actions.dismiss('warning'));
  act(() => actions.dismiss('error'));
  // Only the brief ones have timers: the info and the overridden error.
  await waitFor(() =>
    expect(timers.map((t) => t.ms).sort()).toEqual([1500, 6000]),
  );
  // An error announces assertively, the rest politely.
  expect(
    [...host().querySelectorAll('[role="alert"] p')].map((p) => p.textContent),
  ).toEqual(['Pod failed.', 'Copied with errors.']);
  act(() => timers.forEach((timer) => timer.fn()));
  expect(texts()).toEqual(['Removed.UndoOK']);
});

it('pauses a brief notice while hovered or focused, restarts it on a repeat, and dismisses the focused one with Escape', async () => {
  const runtime = await signedIn();
  const timers = briefTimers();
  render(
    <App runtime={runtime}>
      <button>Back</button>
    </App>,
  );
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  await waitFor(() => expect(timers).toHaveLength(1));
  const item = items()[0]!;
  // Hovered, the timer stops; leaving starts a new one.
  fireEvent.pointerEnter(item);
  expect(running(timers)).toEqual([]);
  fireEvent.pointerLeave(item);
  await waitFor(() => expect(running(timers)).toHaveLength(1));
  // A repeat replaces the running timer.
  const before = running(timers)[0];
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  await waitFor(() => expect(running(timers)).toHaveLength(1));
  expect(running(timers)[0]).not.toBe(before);
  // Focused, the timer stops too, and none starts while it stays.
  const ok = within(item).getByRole('button', { name: 'OK' });
  const back = screen.getByRole('button', { name: 'Back' });
  act(() => back.focus());
  act(() => ok.focus());
  expect(running(timers)).toEqual([]);
  const count = timers.length;
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  expect(timers).toHaveLength(count);
  fireEvent.keyDown(ok, { key: 'Escape' });
  expect(items()).toEqual([]);
  // The focus returns where it came from; nothing took it on appearing.
  await waitFor(() => expect(document.activeElement).toBe(back));
});

it('runs an action once under the guards, shows its failure, and dismissing never runs it', async () => {
  const runtime = await signedIn();
  let release!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        release = () =>
          run.mock.calls.length === 1 ? reject(new Error('nope')) : resolve();
      }),
  );
  render(<App runtime={runtime} />);
  act(() =>
    actions.show({
      key: 'retry',
      text: 'Not copied.',
      severity: 'error',
      action: { label: 'Copy again', run },
    }),
  );
  const button = () => screen.getByRole('button', { name: 'Copy again' });
  await act(async () => button().click());
  expect(button()).toHaveProperty('disabled', true);
  await act(async () => button().click());
  expect(run).toHaveBeenCalledTimes(1);
  await act(async () => release());
  expect(within(items()[0]!).getByRole('alert').textContent).toBeTruthy();
  await act(async () => button().click());
  await act(async () => release());
  expect(run).toHaveBeenCalledTimes(2);
  // A shown notice retires once its action resolves.
  expect(items()).toEqual([]);
  act(() =>
    actions.show({
      key: 'write',
      text: 'Not confirmed.',
      severity: 'warning',
      action: { label: 'Check again', run },
    }),
  );
  await act(async () => screen.getByRole('button', { name: 'OK' }).click());
  expect(items()).toEqual([]);
  expect(run).toHaveBeenCalledTimes(2);
});

/** Repeated failures of one Pod, as an app reports them. */
function PodWarning({
  pod,
  failures,
}: {
  readonly pod: string;
  readonly failures: number;
}) {
  useNotice(
    failures > 0
      ? {
          key: `pod-unreachable:${pod}`,
          severity: 'warning',
          text:
            failures === 1
              ? `${pod} cannot be reached.`
              : `${pod} cannot be reached (${failures} attempts).`,
        }
      : null,
  );
  return null;
}

it('updates one warning for repeated Pod failures, keeps it dismissed while it lasts, and retires it when the Pod recovers', async () => {
  const runtime = await signedIn();
  const ui = (failures: number, mounted = true) => (
    <App runtime={runtime}>
      {mounted && <PodWarning pod="pod.example/alice" failures={failures} />}
    </App>
  );
  const view = render(ui(1));
  await waitFor(() =>
    expect(texts()).toEqual(['pod.example/alice cannot be reached.OK']),
  );
  view.rerender(ui(2));
  view.rerender(ui(3));
  expect(texts()).toEqual([
    'pod.example/alice cannot be reached (3 attempts).OK',
  ]);
  // One entry and one announcement for the whole burst.
  expect(announced()).toEqual(['pod.example/alice cannot be reached.']);
  // Dismissed, it stays hidden while the failures go on.
  await act(async () => screen.getByRole('button', { name: 'OK' }).click());
  view.rerender(ui(4));
  expect(items()).toEqual([]);
  // The Pod recovers: the warning retires; a new failure is a new warning.
  view.rerender(ui(0));
  view.rerender(ui(1));
  await waitFor(() => expect(items()).toHaveLength(1));
  expect(announced()).toHaveLength(2);
  // Unmounting its holder retires it as well.
  view.rerender(ui(1, false));
  await waitFor(() => expect(items()).toEqual([]));
});

it('updates a held notice in place without a new announcement when its language changes', async () => {
  const runtime = await signedIn();
  function Update({ text }: { readonly text: string }) {
    useNotice({ key: 'app-update', text });
    return null;
  }
  const view = render(
    <App runtime={runtime}>
      <Update text="A new version is ready." />
    </App>,
  );
  await waitFor(() => expect(texts()).toEqual(['A new version is ready.OK']));
  view.rerender(
    <App runtime={runtime}>
      <Update text="Eine neue Version ist bereit." />
    </App>,
  );
  expect(texts()).toEqual(['Eine neue Version ist bereit.OK']);
  expect(announced()).toEqual(['A new version is ready.']);
});

it('shows an app notice inside the sign-in gate before sign-in and announces it once there', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  function Update() {
    useNotice({
      key: 'app-update',
      text: 'A new version is ready.',
      duration: 'until-dismissed',
    });
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Tasks" />
      <Notices />
      <Update />
    </SempodsProvider>,
  );
  const gate = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    );
    expect(element?.dataset.reason).toBe('no-connection');
    return element!;
  });
  const inGate = await waitFor(() => {
    const element = gate.querySelector<HTMLElement>(
      '[data-sempods-ui="notices"][data-placement="gate"]',
    );
    expect(texts(element!)).toEqual(['A new version is ready.OK']);
    return element!;
  });
  // The stack outside waits below the modal gate.
  expect(items()).toEqual([]);
  await waitFor(() =>
    expect(announced(inGate)).toEqual(['A new version is ready.']),
  );
  expect(announced()).toEqual([]);
  // The gate's own sign-in stays the focus; the notice took nothing.
  expect(inGate.contains(document.activeElement)).toBe(false);
});

it('waits while an app modal covers the page and shows the notice once it closes', async () => {
  const runtime = await signedIn();
  function Modal() {
    const [open, setOpen] = useState(true);
    return open ? (
      <div role="dialog" aria-modal="true">
        <button onClick={() => setOpen(false)}>Close</button>
      </div>
    ) : null;
  }
  render(
    <App runtime={runtime}>
      <Modal />
    </App>,
  );
  act(() => actions.show({ key: 'info', text: 'Saved.', severity: 'error' }));
  await waitFor(() => expect(host()).toBeTruthy());
  expect(items()).toEqual([]);
  expect(announced()).toEqual([]);
  await act(async () => screen.getByRole('button', { name: 'Close' }).click());
  await waitFor(() => expect(texts()).toEqual(['Saved.OK']));
  // Announced in the commit after it shows, once.
  await waitFor(() => expect(announced()).toEqual(['Saved.']));
});

it('places the stack above an avoided composer', async () => {
  const runtime = await signedIn();
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  render(
    <App runtime={runtime}>
      <form data-sempods-notices-avoid="">
        <input aria-label="New item" />
      </form>
    </App>,
  );
  const composer = document.querySelector('form')!;
  vi.spyOn(composer, 'getBoundingClientRect').mockReturnValue({
    top: 728,
    bottom: 800,
    height: 72,
    left: 0,
    right: 375,
    width: 375,
    x: 0,
    y: 728,
    toJSON: () => ({}),
  });
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  act(() => window.dispatchEvent(new Event('resize')));
  await waitFor(() =>
    expect(host().style.getPropertyValue('--sp-notices-avoid')).toBe('72px'),
  );
});

it('renders through a replacement renderer while the host keeps the guards and dismissal', async () => {
  const runtime = await signedIn();
  const run = vi.fn();
  function Toast({ notice }: NoticeProps) {
    return (
      <div data-custom={notice.severity}>
        <strong>{notice.title}</strong> {notice.text}
        {notice.actions.map((action) => (
          <button key={action.label} onClick={action.run}>
            {action.label}
          </button>
        ))}
        {notice.dismiss && (
          <button onClick={notice.dismiss}>{notice.dismissLabel}</button>
        )}
      </div>
    );
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Notices components={{ Notice: Toast }} />
      <Publisher />
    </SempodsProvider>,
  );
  const notice: Notice = {
    key: 'custom',
    title: 'Sync',
    text: 'Paused.',
    severity: 'warning',
    action: { label: 'Resume', run },
  };
  act(() => actions.show(notice));
  expect(document.querySelector('[data-custom="warning"]')).toBeTruthy();
  await act(async () => screen.getByRole('button', { name: 'Resume' }).click());
  expect(run).toHaveBeenCalledTimes(1);
  act(() => actions.show(notice));
  const ok = screen.getByRole('button', { name: 'OK' });
  act(() => ok.focus());
  fireEvent.keyDown(ok, { key: 'Escape' });
  expect(document.querySelector('[data-custom]')).toBeNull();
});

/** Two Pods: Alice's session ends beside the active Bob. */
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
  return { runtime };
}

it('takes over the access prompts of AppAccess once mounted, showing each once beside app notices', async () => {
  const { runtime } = await endedBeside();
  const ui = (notices: boolean) => (
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
      {notices && <Notices />}
      <Publisher />
    </SempodsProvider>
  );
  const view = render(ui(false));
  // Without the host, AppAccess shows its own stack as before.
  const stack = () =>
    document.querySelector<HTMLElement>('[data-sempods-ui="prompts"]')!;
  await waitFor(() =>
    expect(stack().querySelectorAll('[data-sempods-ui="prompt"]')).toHaveLength(
      1,
    ),
  );
  expect(
    stack().querySelector('[data-sempods-ui="prompt"]')!.getAttribute('role'),
  ).toBe('alert');
  view.rerender(ui(true));
  await waitFor(() => expect(items()).toHaveLength(1));
  expect(stack().hidden).toBe(true);
  expect(document.querySelectorAll('[data-sempods-ui="prompt"]')).toHaveLength(
    1,
  );
  const prompt = items()[0]!.querySelector<HTMLElement>(
    '[data-sempods-ui="prompt"]',
  )!;
  expect(prompt.dataset.reason).toBe('signed-out');
  expect(prompt.getAttribute('role')).toBeNull();
  expect(
    within(prompt)
      .getAllByRole('button')
      .map((b) => b.textContent),
  ).toEqual(['Sign in', 'Forget', 'OK']);
  await waitFor(() => expect(announced()).toHaveLength(1));
  expect(announced()[0]).toContain('pod.example/alice');
  // An app notice joins the same stack after it.
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  expect(items().map((item) => item.dataset.source)).toEqual(['access', 'app']);
  await act(async () =>
    within(prompt).getByRole('button', { name: 'OK' }).click(),
  );
  expect(items().map((item) => item.dataset.source)).toEqual(['app']);
});

it('keeps a notice its own action showed again, and settles only the event it ran for', async () => {
  const runtime = await signedIn();
  render(<App runtime={runtime} />);
  act(() =>
    actions.show({
      key: 'copy',
      text: 'Three items not copied.',
      severity: 'error',
      action: {
        label: 'Copy again',
        run: () =>
          actions.show({
            key: 'copy',
            text: 'Two items still not copied.',
            severity: 'error',
          }),
      },
    }),
  );
  await act(async () =>
    screen.getByRole('button', { name: 'Copy again' }).click(),
  );
  expect(texts()).toEqual(['Two items still not copied.OK']);
});

it('keeps a notice its own action showed again identically, as a retry that fails the same way', async () => {
  const runtime = await signedIn();
  render(<App runtime={runtime} />);
  const failed: Notice = {
    key: 'copy',
    text: 'Three items not copied.',
    severity: 'error',
    action: { label: 'Copy again', run: () => actions.show(failed) },
  };
  act(() => actions.show(failed));
  await act(async () =>
    screen.getByRole('button', { name: 'Copy again' }).click(),
  );
  expect(texts()).toEqual(['Three items not copied.Copy againOK']);
});

it('runs an action once also when its notice remounts while it runs, and guards a renderer that ignores disabled', async () => {
  const runtime = await signedIn();
  let release!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  function Eager({ notice }: NoticeProps) {
    // Presses twice and never looks at `disabled`.
    return notice.actions.map((action) => (
      <button
        key={action.label}
        onClick={() => {
          action.run();
          action.run();
        }}
      >
        {action.label}
      </button>
    ));
  }
  function Modal({ open }: { readonly open: boolean }) {
    return open ? <div role="dialog" aria-modal="true" /> : null;
  }
  const ui = (open: boolean) => (
    <SempodsProvider runtime={runtime}>
      <Notices components={{ Notice: Eager }} />
      <Publisher />
      <Modal open={open} />
    </SempodsProvider>
  );
  const view = render(ui(false));
  act(() =>
    actions.show({
      key: 'sync',
      text: 'Not synchronised.',
      severity: 'error',
      action: { label: 'Synchronise', run },
    }),
  );
  await act(async () =>
    screen.getByRole('button', { name: 'Synchronise' }).click(),
  );
  expect(run).toHaveBeenCalledTimes(1);
  // A modal covers it and goes: the notice remounts while its action runs.
  view.rerender(ui(true));
  await waitFor(() => expect(items()).toEqual([]));
  view.rerender(ui(false));
  await waitFor(() => expect(items()).toHaveLength(1));
  await act(async () =>
    screen.getByRole('button', { name: 'Synchronise' }).click(),
  );
  expect(run).toHaveBeenCalledTimes(1);
  await act(async () => release());
  expect(items()).toEqual([]);
});

it('leaves the access prompts to AppAccess with accessPrompts={false}', async () => {
  const { runtime } = await endedBeside();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
      <Notices accessPrompts={false} />
      <Publisher />
    </SempodsProvider>,
  );
  const stack = () =>
    document.querySelector<HTMLElement>('[data-sempods-ui="prompts"]')!;
  await waitFor(() =>
    expect(stack().querySelectorAll('[data-sempods-ui="prompt"]')).toHaveLength(
      1,
    ),
  );
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  expect(items().map((item) => item.dataset.source)).toEqual(['app']);
  expect(document.querySelectorAll('[data-sempods-ui="prompt"]')).toHaveLength(
    1,
  );
  // Both stacks sit at the bottom: the host keeps above the prompts.
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(800);
  vi.spyOn(stack(), 'getBoundingClientRect').mockReturnValue({
    top: 640,
    bottom: 784,
    height: 144,
    left: 16,
    right: 359,
    width: 343,
    x: 16,
    y: 640,
    toJSON: () => ({}),
  });
  act(() => window.dispatchEvent(new Event('resize')));
  await waitFor(() =>
    expect(host().style.getPropertyValue('--sp-notices-avoid')).toBe('160px'),
  );
});

it('restarts the timer for a changed event, but not for an update in place', async () => {
  const runtime = await signedIn();
  const timers = briefTimers();
  function Held({ text }: { readonly text: string }) {
    useNotice({ key: 'held', text });
    return null;
  }
  const ui = (text: string) => (
    <App runtime={runtime}>
      <Held text={text} />
    </App>
  );
  const view = render(ui('Synchronised.'));
  act(() => actions.show({ key: 'shown', text: 'Copied.' }));
  await waitFor(() => expect(running(timers)).toHaveLength(2));
  const [held, shown] = running(timers);
  // A changed `show` is a new event with a full duration of its own.
  act(() => actions.show({ key: 'shown', text: 'Copied twice.' }));
  await waitFor(() => expect(running(timers)).toHaveLength(2));
  expect(running(timers)).toContain(held);
  expect(running(timers)).not.toContain(shown);
  // A held notice's text changes (a language): its timer runs on.
  const before = running(timers);
  view.rerender(ui('Synchronisiert.'));
  expect(texts()).toContain('Synchronisiert.OK');
  expect(running(timers)).toEqual(before);
});

it('shows an action failure that arrives while its notice was covered by a modal', async () => {
  const runtime = await signedIn();
  let fail!: (cause: unknown) => void;
  const run = vi.fn(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  function Modal({ open }: { readonly open: boolean }) {
    return open ? <div role="dialog" aria-modal="true" /> : null;
  }
  const ui = (open: boolean) => (
    <App runtime={runtime}>
      <Modal open={open} />
    </App>
  );
  const view = render(ui(false));
  act(() =>
    actions.show({
      key: 'sync',
      text: 'Not synchronised.',
      severity: 'error',
      action: { label: 'Synchronise', run },
    }),
  );
  await act(async () =>
    screen.getByRole('button', { name: 'Synchronise' }).click(),
  );
  view.rerender(ui(true));
  await waitFor(() => expect(items()).toEqual([]));
  await act(async () => fail(new Error('offline')));
  view.rerender(ui(false));
  await waitFor(() => expect(items()).toHaveLength(1));
  expect(within(items()[0]!).getByRole('alert').textContent).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Synchronise' })).toHaveProperty(
    'disabled',
    false,
  );
});

it('waits inside the gate while the app settings above it are open', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess
        appName="Tasks"
        settings={{ label: 'Settings', content: <p>Language</p> }}
      />
      <Notices />
      <Publisher />
    </SempodsProvider>,
  );
  const gate = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    );
    expect(element?.dataset.reason).toBe('no-connection');
    return element!;
  });
  const inGate = () =>
    gate.querySelector<HTMLElement>(
      '[data-sempods-ui="notices"][data-placement="gate"]',
    )!;
  await act(async () =>
    within(gate).getByRole('button', { name: 'Settings' }).click(),
  );
  await waitFor(() =>
    expect(gate.querySelector('dialog[data-sempods-ui="settings"]')).not.toBe(
      null,
    ),
  );
  // The host measures what covers it in the next frame.
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(items(inGate())).toEqual([]);
  expect(announced(inGate())).toEqual([]);
  // The settings close: the notice shows and is announced once.
  const settings = gate.querySelector<HTMLElement>(
    'dialog[data-sempods-ui="settings"]',
  )!;
  await act(async () =>
    within(settings).getAllByRole('button').at(-1)!.click(),
  );
  await waitFor(() => expect(texts(inGate())).toEqual(['Saved.OK']));
  await waitFor(() => expect(announced(inGate())).toEqual(['Saved.']));
});

it('shows notices inside a gate that opened above an app modal (#264)', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  function Update() {
    useNotice({
      key: 'app-update',
      text: 'A new version is ready.',
      duration: 'until-dismissed',
    });
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      {/* The app's own modals, open before the gate: an overlay library's
          and a native dialog (open stands for showModal in jsdom). */}
      <div role="dialog" aria-modal="true">
        <input aria-label="Draft" />
      </div>
      <dialog open aria-label="Earlier dialog" />
      <AppAccess appName="Tasks" />
      <Notices />
      <Update />
    </SempodsProvider>,
  );
  const gate = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    );
    expect(element?.dataset.reason).toBe('no-connection');
    return element!;
  });
  await waitFor(() =>
    expect(
      texts(
        gate.querySelector(
          '[data-sempods-ui="notices"][data-placement="gate"]',
        )!,
      ),
    ).toEqual(['A new version is ready.OK']),
  );
});

it('announces a notice published together with a modal only once the modal closes', async () => {
  const runtime = await signedIn();
  let setOpen!: (open: boolean) => void;
  function Modal() {
    const [open, set] = useState(false);
    setOpen = set;
    return open ? <div role="dialog" aria-modal="true" /> : null;
  }
  render(
    <App runtime={runtime}>
      <Modal />
    </App>,
  );
  // One event opens the modal and publishes the notice.
  act(() => {
    setOpen(true);
    actions.show({ key: 'sync', text: 'Not synchronised.', severity: 'error' });
  });
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(items()).toEqual([]);
  expect(announced()).toEqual([]);
  act(() => setOpen(false));
  await waitFor(() => expect(texts()).toEqual(['Not synchronised.OK']));
  await waitFor(() => expect(announced()).toEqual(['Not synchronised.']));
});

it('drops the failure of an action whose notice was dismissed before it failed', async () => {
  const runtime = await signedIn();
  let fail!: (cause: unknown) => void;
  render(<App runtime={runtime} />);
  act(() =>
    actions.show({
      key: 'copy',
      text: 'Not copied.',
      severity: 'error',
      action: {
        label: 'Copy again',
        run: () =>
          new Promise<void>((_, reject) => {
            fail = reject;
          }),
      },
    }),
  );
  await act(async () =>
    screen.getByRole('button', { name: 'Copy again' }).click(),
  );
  await act(async () => screen.getByRole('button', { name: 'OK' }).click());
  expect(items()).toEqual([]);
  await act(async () => fail(new Error('offline')));
  // A later notice under the same key starts clean.
  act(() => actions.show({ key: 'copy', text: 'Copied.' }));
  expect(texts()).toEqual(['Copied.OK']);
  expect(within(items()[0]!).queryByRole('alert')).toBeNull();
});

it('waits inside the gate while an app dialog opened after the gate is open', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  let setOpen!: (open: boolean) => void;
  function AppDialog() {
    const [open, set] = useState(false);
    setOpen = set;
    // jsdom has no top layer: an open dialog stands for `showModal()`.
    return open ? <dialog open aria-label="App dialog" /> : null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Tasks" />
      <Notices />
      <Publisher />
      <AppDialog />
    </SempodsProvider>,
  );
  const gate = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    );
    expect(element?.dataset.reason).toBe('no-connection');
    return element!;
  });
  const inGate = () =>
    gate.querySelector<HTMLElement>(
      '[data-sempods-ui="notices"][data-placement="gate"]',
    )!;
  await waitFor(() => expect(inGate()).not.toBeNull());
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  act(() => setOpen(true));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(items(inGate())).toEqual([]);
  expect(announced(inGate())).toEqual([]);
  act(() => setOpen(false));
  await waitFor(() => expect(texts(inGate())).toEqual(['Saved.OK']));
  await waitFor(() => expect(announced(inGate())).toEqual(['Saved.']));
});

it('ignores a dialog kept mounted while hidden, and shows a waiting notice once one is hidden', async () => {
  const runtime = await signedIn();
  let setHidden!: (hidden: boolean) => void;
  function Kept() {
    const [hidden, set] = useState(false);
    setHidden = set;
    return <div role="dialog" aria-modal="true" hidden={hidden} />;
  }
  render(
    <App runtime={runtime}>
      <Kept />
    </App>,
  );
  act(() =>
    actions.show({ key: 'sync', text: 'Not synced.', severity: 'error' }),
  );
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(items()).toEqual([]);
  expect(announced()).toEqual([]);
  // Closed by `hidden`, still mounted: the notice shows and is announced once.
  act(() => setHidden(true));
  await waitFor(() => expect(texts()).toEqual(['Not synced.OK']));
  await waitFor(() => expect(announced()).toEqual(['Not synced.']));
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  // The polite region comes first; the error is not read again.
  await waitFor(() => expect(announced()).toEqual(['Saved.', 'Not synced.']));
});

it('keeps the stack and its avoided zones within a visual viewport smaller than the layout viewport', async () => {
  const runtime = await signedIn();
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(812);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(375);
  // A pinch zoom to 2×, or a keyboard that resizes only the visual viewport.
  const visual = Object.assign(new EventTarget(), {
    height: 406,
    width: 187.5,
    offsetTop: 0,
    offsetLeft: 0,
  });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: visual,
  });
  cleanups.push(() => {
    delete (window as { visualViewport?: unknown }).visualViewport;
  });
  render(
    <App runtime={runtime}>
      <form data-sempods-notices-avoid="">
        <input aria-label="New item" />
      </form>
    </App>,
  );
  // The app keeps its composer at the visible bottom.
  const composer = document.querySelector('form')!;
  const at = (top: number) => ({
    top,
    bottom: top + 60,
    height: 60,
    left: 0,
    right: 375,
    width: 375,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  const box = vi
    .spyOn(composer, 'getBoundingClientRect')
    .mockReturnValue(at(346));
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  // The app moved its composer when the visual viewport changed.
  act(() => visual.dispatchEvent(new Event('resize')));
  const vars = () =>
    [
      '--sp-notices-below',
      '--sp-notices-room',
      '--sp-notices-left',
      '--sp-notices-right',
      '--sp-notices-avoid',
    ].map((name) => host().style.getPropertyValue(name));
  await waitFor(() =>
    expect(vars()).toEqual(['406px', '243px', '', '187px', '466px']),
  );
  // Panned right and down within the layout viewport, less of it is hidden
  // below and on the right, more on the left.
  Object.assign(visual, { offsetTop: 300, offsetLeft: 100 });
  box.mockReturnValue(at(646));
  act(() => visual.dispatchEvent(new Event('scroll')));
  await waitFor(() =>
    expect(vars()).toEqual(['106px', '243px', '100px', '87px', '166px']),
  );
  // Zoomed further (2.5×), below half of the layout viewport: the composer
  // at the visible bottom is still avoided.
  Object.assign(visual, {
    height: 325,
    width: 150,
    offsetTop: 0,
    offsetLeft: 0,
  });
  box.mockReturnValue(at(265));
  act(() => visual.dispatchEvent(new Event('resize')));
  await waitFor(() =>
    expect(vars()).toEqual(['487px', '195px', '', '225px', '547px']),
  );
  Object.assign(visual, { height: 812, width: 375 });
  box.mockReturnValue(at(752));
  act(() => visual.dispatchEvent(new Event('resize')));
  await waitFor(() => expect(vars()).toEqual(['', '', '', '', '60px']));
});

it('checks the guards again when a renderer calls an action it kept from an earlier render', async () => {
  const runtime = await signedIn();
  const run = vi.fn();
  let kept: (() => void) | undefined;
  let app!: ReturnType<typeof useApp>;
  function Keeper({ notice }: NoticeProps) {
    // Keeps the first callback, as a renderer awaiting its own confirmation.
    kept ??= notice.actions[0]?.run;
    return null;
  }
  function Controls() {
    app = useApp();
    return null;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Notices components={{ Notice: Keeper }} />
      <Publisher />
      <Controls />
    </SempodsProvider>,
  );
  act(() =>
    actions.show({
      key: 'sync',
      text: 'Not synchronised.',
      severity: 'error',
      action: { label: 'Synchronise', run },
    }),
  );
  await waitFor(() => expect(kept).toBeTypeOf('function'));
  let finish!: () => void;
  let navigation!: Promise<boolean>;
  act(() => {
    navigation = app.navigate(
      () => new Promise<void>((done) => (finish = done)),
    );
  });
  await act(async () => kept!());
  expect(run).not.toHaveBeenCalled();
  await act(async () => {
    finish();
    await navigation;
  });
  await act(async () => kept!());
  expect(run).toHaveBeenCalledTimes(1);
});

it('keeps a late failure of a replaced event off its replacement, also across a remount', async () => {
  const runtime = await signedIn();
  const fails: ((cause: unknown) => void)[] = [];
  const run = () =>
    new Promise<void>((_, reject) => {
      fails.push(reject);
    });
  function Modal({ open }: { readonly open: boolean }) {
    return open ? <div role="dialog" aria-modal="true" /> : null;
  }
  const ui = (open: boolean) => (
    <App runtime={runtime}>
      <Modal open={open} />
    </App>
  );
  const view = render(ui(false));
  const failing: Notice = {
    key: 'sync',
    text: 'Not synchronised.',
    severity: 'error',
    action: { label: 'Synchronise', run },
  };
  act(() => actions.show(failing));
  await act(async () =>
    screen.getByRole('button', { name: 'Synchronise' }).click(),
  );
  // Replaced while its retry runs: the old rejection stays off it.
  act(() => actions.show({ key: 'sync', text: 'Synchronised.' }));
  await act(async () => fails[0]!(new Error('offline')));
  expect(texts()).toEqual(['Synchronised.OK']);
  expect(within(items()[0]!).queryByRole('alert')).toBeNull();
  // A failure of the event that shows stays with it across a remount.
  act(() => actions.show(failing));
  await act(async () =>
    screen.getByRole('button', { name: 'Synchronise' }).click(),
  );
  await act(async () => fails[1]!(new Error('offline')));
  expect(within(items()[0]!).getByRole('alert').textContent).toBeTruthy();
  view.rerender(ui(true));
  await waitFor(() => expect(items()).toEqual([]));
  view.rerender(ui(false));
  await waitFor(() => expect(items()).toHaveLength(1));
  expect(within(items()[0]!).getByRole('alert').textContent).toBeTruthy();
  // A changed `show` is a new notice: the earlier failure no longer applies.
  act(() => actions.show({ ...failing, text: 'Still not synchronised.' }));
  expect(within(items()[0]!).queryByRole('alert')).toBeNull();
});

it('never runs the action of a notice that replaced the one a renderer asked about', async () => {
  const runtime = await signedIn();
  const restoreA = vi.fn();
  const restoreB = vi.fn();
  let kept: (() => void) | undefined;
  function Confirming({ notice }: NoticeProps) {
    // Keeps the callback while it asks the person to confirm.
    kept ??= notice.actions[0]?.run;
    return <p>{notice.text}</p>;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Notices components={{ Notice: Confirming }} />
      <Publisher />
    </SempodsProvider>,
  );
  const undo = (text: string, run: () => void): Notice => ({
    key: 'undo',
    text,
    action: { label: 'Restore', run },
  });
  act(() => actions.show(undo('A deleted.', restoreA)));
  await waitFor(() => expect(kept).toBeTypeOf('function'));
  // The same event with a new closure: the latest one runs.
  const latestA = vi.fn();
  act(() => actions.show(undo('A deleted.', latestA)));
  // Replaced before the person answers: confirming A runs nothing.
  act(() => actions.show(undo('B deleted.', restoreB)));
  await act(async () => kept!());
  expect(restoreA).not.toHaveBeenCalled();
  expect(latestA).not.toHaveBeenCalled();
  expect(restoreB).not.toHaveBeenCalled();
  expect(texts()).toEqual(['B deleted.']);
  // Within the event it was kept for, the latest closure runs.
  kept = undefined;
  act(() => actions.dismiss('undo'));
  act(() => actions.show(undo('A deleted.', restoreA)));
  await waitFor(() => expect(kept).toBeTypeOf('function'));
  act(() => actions.show(undo('A deleted.', latestA)));
  await act(async () => kept!());
  expect(restoreA).not.toHaveBeenCalled();
  expect(latestA).toHaveBeenCalledTimes(1);
  expect(restoreB).not.toHaveBeenCalled();
});

it('shows a waiting notice once a covering dialog closes through its styles', async () => {
  const runtime = await signedIn();
  render(<App runtime={runtime} />);
  const closes = {
    display: (dialog: HTMLElement) => (dialog.style.display = 'none'),
    visibility: (dialog: HTMLElement) => (dialog.style.visibility = 'hidden'),
  };
  for (const [key, close] of Object.entries(closes)) {
    // The app's own dialog, kept mounted and closed through a style.
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    act(() => document.body.append(dialog));
    act(() => actions.show({ key, text: `Not synced (${key}).` }));
    await act(async () => new Promise((done) => setTimeout(done, 50)));
    expect(items()).toEqual([]);
    expect(announced()).not.toContain(`Not synced (${key}).`);
    act(() => void close(dialog));
    // No resize or observed mutation: the host looks again by itself.
    await waitFor(() => expect(texts()).toEqual([`Not synced (${key}).OK`]));
    await waitFor(() =>
      expect(
        announced().filter((text) => text === `Not synced (${key}).`),
      ).toHaveLength(1),
    );
    act(() => void actions.dismiss(key));
    dialog.remove();
  }
});

it('waits once a dialog kept hidden through its styles opens, before a brief notice can expire unseen', async () => {
  const runtime = await signedIn();
  const timers = briefTimers();
  render(<App runtime={runtime} />);
  // The app's own dialog, kept mounted and hidden through a style.
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.style.display = 'none';
  act(() => document.body.append(dialog));
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  await waitFor(() => expect(texts()).toEqual(['Saved.OK']));
  await waitFor(() => expect(announced()).toEqual(['Saved.']));
  // Every measurement the append scheduled has run.
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  // Opened through its style alone: the stack waits and its timer stops.
  act(() => void (dialog.style.display = ''));
  await waitFor(() => expect(items()).toEqual([]));
  expect(running(timers)).toEqual([]);
  dialog.remove();
});

it('binds a kept dismiss and action to the event they were shown for, while it shows undismissed', async () => {
  const runtime = await signedIn();
  const retry = vi.fn();
  let kept: NoticeView | undefined;
  function Keeper({ notice }: NoticeProps) {
    // Keeps its first view, as for an exit animation or a confirmation.
    kept ??= notice;
    return <p>{notice.text}</p>;
  }
  let setHeld!: (held: boolean) => void;
  function Held() {
    const [held, set] = useState(false);
    setHeld = set;
    useNotice(
      held
        ? {
            key: 'pod',
            text: 'Pod unreachable.',
            severity: 'warning',
            action: { label: 'Retry', run: retry },
          }
        : null,
    );
    return null;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Notices components={{ Notice: Keeper }} />
      <Publisher />
      <Held />
    </SempodsProvider>,
  );
  act(() =>
    actions.show({ key: 'sync', text: 'A failed.', severity: 'error' }),
  );
  await waitFor(() => expect(kept?.text).toBe('A failed.'));
  // Replaced under the same key: A's dismiss leaves B.
  act(() =>
    actions.show({ key: 'sync', text: 'B failed.', severity: 'error' }),
  );
  act(() => kept!.dismiss!());
  expect(texts()).toEqual(['B failed.']);
  act(() => void actions.dismiss('sync'));
  // A held notice, dismissed: its kept action no longer runs.
  kept = undefined;
  act(() => setHeld(true));
  await waitFor(() => expect(kept?.text).toBe('Pod unreachable.'));
  act(() => kept!.dismiss!());
  expect(items()).toEqual([]);
  await act(async () => kept!.actions[0]!.run());
  expect(retry).not.toHaveBeenCalled();
});

it('moves the stack when an avoided zone moves through its styles', async () => {
  const runtime = await signedIn();
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(812);
  render(
    <App runtime={runtime}>
      <form data-sempods-notices-avoid="" style={{ bottom: 0 }}>
        <input aria-label="New item" />
      </form>
    </App>,
  );
  const composer = document.querySelector('form')!;
  const at = (top: number) => ({
    top,
    bottom: top + 64,
    height: 64,
    left: 0,
    right: 375,
    width: 375,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
  const box = vi
    .spyOn(composer, 'getBoundingClientRect')
    .mockReturnValue(at(748));
  act(() => actions.show({ key: 'info', text: 'Saved.' }));
  act(() => window.dispatchEvent(new Event('resize')));
  const avoid = () => host().style.getPropertyValue('--sp-notices-avoid');
  await waitFor(() => expect(avoid()).toBe('64px'));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  // Moved up without resizing, by its style alone.
  box.mockReturnValue(at(668));
  act(() => void (composer.style.bottom = '80px'));
  await waitFor(() => expect(avoid()).toBe('144px'));
});

it('keeps the page avoided zones out of the gate stack, and polls nothing while nothing waits', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(375);
  let setReady!: (ready: boolean) => void;
  function Update() {
    const [ready, set] = useState(false);
    setReady = set;
    useNotice(
      ready
        ? {
            key: 'app-update',
            text: 'A new version is ready.',
            duration: 'until-dismissed',
          }
        : null,
    );
    return null;
  }
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Tasks" />
      <Notices />
      <Update />
      <form data-sempods-notices-avoid="">
        <input aria-label="New item" />
      </form>
    </SempodsProvider>,
  );
  // A tall composer behind the gate.
  vi.spyOn(
    document.querySelector('form')!,
    'getBoundingClientRect',
  ).mockReturnValue({
    top: 45,
    bottom: 375,
    height: 330,
    left: 0,
    right: 667,
    width: 667,
    x: 0,
    y: 45,
    toJSON: () => ({}),
  });
  const gate = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    );
    expect(element?.dataset.reason).toBe('no-connection');
    return element!;
  });
  await act(async () => new Promise((done) => setTimeout(done, 100)));
  // The gate is open and nothing waits: no host looks each frame.
  const queries = vi.spyOn(document, 'querySelectorAll');
  await act(async () => new Promise((done) => setTimeout(done, 200)));
  expect(queries.mock.calls.length).toBeLessThan(4);
  queries.mockRestore();
  act(() => setReady(true));
  const inGate = await waitFor(() => {
    const element = gate.querySelector<HTMLElement>(
      '[data-sempods-ui="notices"][data-placement="gate"]',
    );
    expect(texts(element!)).toEqual(['A new version is ready.OK']);
    return element!;
  });
  act(() => window.dispatchEvent(new Event('resize')));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(inGate.style.getPropertyValue('--sp-notices-room')).toBe('');
  expect(inGate.style.getPropertyValue('--sp-notices-avoid')).toBe('');
});

it('looks again each frame while a notice waits under a modal, also for one that arrived after it', async () => {
  const runtime = await signedIn();
  render(<App runtime={runtime} />);
  const sheet = document.createElement('style');
  const dialog = document.createElement('div');
  dialog.id = 'filters';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  act(() => {
    document.head.append(sheet);
    document.body.append(dialog);
  });
  // The modal covers the page while nothing waits: no host polls.
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(items()).toEqual([]);
  // Closed by a stylesheet rule, which no observer reports.
  act(() => sheet.sheet!.insertRule('#filters { display: none; }'));
  await waitFor(() => expect(texts()).toEqual(['Saved.OK']));
  dialog.remove();
  sheet.remove();
});

it('waits inside the gate while an overlay inside it, native or not, covers its notices', async () => {
  const f = fixture();
  cleanups.push(() => f.runtime.dispose());
  render(
    <SempodsProvider runtime={f.runtime}>
      <AppAccess appName="Tasks" />
      <Notices />
      <Publisher />
    </SempodsProvider>,
  );
  const gate = await waitFor(() => {
    const element = document.querySelector<HTMLElement>(
      '[data-sempods-ui="gate"]',
    );
    expect(element?.dataset.reason).toBe('no-connection');
    return element!;
  });
  const inGate = () =>
    gate.querySelector<HTMLElement>(
      '[data-sempods-ui="notices"][data-placement="gate"]',
    )!;
  await waitFor(() => expect(inGate()).not.toBeNull());
  // A custom Connections renderer opens its own overlay in the gate.
  const overlay = document.createElement('div');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  act(() => gate.append(overlay));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  await act(async () => new Promise((done) => setTimeout(done, 50)));
  expect(items(inGate())).toEqual([]);
  expect(announced(inGate())).toEqual([]);
  act(() => overlay.remove());
  await waitFor(() => expect(texts(inGate())).toEqual(['Saved.OK']));
  await waitFor(() => expect(announced(inGate())).toEqual(['Saved.']));
  // An overlay library hides the gate's other content instead.
  act(() => inGate().setAttribute('aria-hidden', 'true'));
  await waitFor(() => expect(items(inGate())).toEqual([]));
  act(() => inGate().removeAttribute('aria-hidden'));
  await waitFor(() => expect(texts(inGate())).toEqual(['Saved.OK']));
});

it("returns focus from an access prompt to AppAccess's focusTarget when the host has none", async () => {
  const { runtime } = await endedBeside();
  function Shell() {
    const main = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={main}>Main</button>
        <AppAccess appName="Tasks" focusTarget={main} />
        <Notices />
      </>
    );
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Shell />
    </SempodsProvider>,
  );
  await waitFor(() => expect(items()).toHaveLength(1));
  const ok = within(items()[0]!).getByRole('button', { name: 'OK' });
  act(() => ok.focus());
  await act(async () => fireEvent.keyDown(ok, { key: 'Escape' }));
  await waitFor(() => expect(items()).toEqual([]));
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Main'));
});

it('keeps at least one notice for a limit below one, and the default for no number', async () => {
  const runtime = await signedIn();
  const view = render(<App runtime={runtime} limit={-2} />);
  for (const key of ['a', 'b', 'c'])
    act(() => actions.show({ key, text: key, severity: 'error' }));
  expect(items()).toHaveLength(1);
  view.rerender(<App runtime={runtime} limit={Number.NaN} />);
  expect(items()).toHaveLength(3);
});

it('reports in the console once when notices are published without a host', async () => {
  const runtime = await signedIn();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  function Update() {
    useNotice({ key: 'app-update', text: 'A new version is ready.' });
    return null;
  }
  render(
    <SempodsProvider runtime={runtime}>
      <Update />
      <Publisher />
    </SempodsProvider>,
  );
  const reports = () =>
    warn.mock.calls.filter(([message]) =>
      String(message).includes('<Notices />'),
    ).length;
  const before = reports();
  await act(async () => new Promise((done) => setTimeout(done, 2100)));
  expect(reports()).toBeGreaterThan(before);
  // Once per provider: more notices report nothing more.
  const once = reports();
  act(() => actions.show({ key: 'saved', text: 'Saved.' }));
  await act(async () => new Promise((done) => setTimeout(done, 2100)));
  expect(reports()).toBe(once);
});
