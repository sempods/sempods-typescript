// @vitest-environment jsdom
/**
 * Which controls change sharing (#362): each one labelled "Change sharing" or
 * sharing more Contexts asks the Pod for its consent page; a sign-in, also
 * the app's own `authorize(id)`, may reuse the grant.
 */
import { useState } from 'react';
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
import {
  AppAccess,
  SempodsProvider,
  useApp,
  useAppState,
  useContexts,
  useDraftGuard,
} from './index.js';
import { createAppController, runAccessAction } from '../authoring/app.js';
import {
  catalogue,
  fixture,
  pod,
  settleLease,
  work,
} from '../runtime/fixture.test.js';
import type { BrowserRuntime } from '../runtime/types.js';

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
const prompt = (f: ReturnType<typeof fixture>) =>
  new URL(f.navigate.mock.calls.at(-1)![0]).searchParams.get('prompt');
async function leaves(f: ReturnType<typeof fixture>, navigations: number) {
  await waitFor(() =>
    expect(f.navigate).toHaveBeenCalledTimes(navigations + 1),
  );
}

function Custom() {
  const app = useApp();
  const { activeId } = useAppState();
  const lists = useContexts();
  return (
    <>
      <button onClick={() => void app.authorize(activeId!)}>Sign in</button>
      <button
        onClick={() =>
          void app.authorize(activeId!, { intent: 'change-sharing' })
        }
      >
        Share another list
      </button>
      <button disabled={!lists.canShare} onClick={() => void lists.share()}>
        Share more lists
      </button>
    </>
  );
}

it.each([
  ['Sign in', null],
  ['Share another list', 'consent'],
  ['Share more lists', 'consent'],
] as const)(
  'asks for consent from a custom control only when it changes sharing (%s)',
  async (name, expected) => {
    const f = fixture();
    const logged = await f.login();
    cleanups.push(() => logged.runtime.dispose());
    render(
      <SempodsProvider runtime={logged.runtime}>
        <Custom />
      </SempodsProvider>,
    );
    const button = await waitFor(() => {
      const found = screen.getByRole<HTMLButtonElement>('button', { name });
      expect(found.disabled).toBe(false);
      return found;
    });
    const navigations = f.navigate.mock.calls.length;
    fireEvent.click(button);
    await leaves(f, navigations);
    expect(prompt(f)).toBe(expected);
  },
);

async function missingScopes() {
  const f = fixture({
    allowedPods: [pod],
    preferences: null,
    scopes: { required: ['tasks'] },
  });
  await f.begin();
  f.runtime.dispose();
  await settleLease();
  // The fixture's default token grants no scopes, so `tasks` stays missing.
  const runtime: BrowserRuntime = f.returned();
  cleanups.push(() => runtime.dispose());
  return { f, runtime };
}

it('asks for consent when the gate offers to grant missing required scopes', async () => {
  const { f, runtime } = await missingScopes();
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Tasks" />
    </SempodsProvider>,
  );
  await screen.findByText('Review required feature access: tasks.');
  const navigations = f.navigate.mock.calls.length;
  await act(async () =>
    fireEvent.click(
      await screen.findByRole('button', { name: 'Change sharing' }),
    ),
  );
  await leaves(f, navigations);
  expect(prompt(f)).toBe('consent');
});

it("asks for consent from a missing-scopes prompt's action", async () => {
  const { f, runtime } = await missingScopes();
  const app = createAppController(runtime);
  cleanups.push(app.subscribe(() => {}));
  app.start();
  cleanups.push(() => app.stop());
  const blocking = await waitFor(() => {
    const found = app.getSnapshot().access.blocking;
    expect(found?.reason).toBe('missing-scopes');
    return found!;
  });
  const navigations = f.navigate.mock.calls.length;
  expect(await runAccessAction(app, blocking, 'sign-in')).toBe(true);
  await leaves(f, navigations);
  expect(prompt(f)).toBe('consent');
});

it("signs in to a signed-out Pod from the gate's Sign in without asking for consent", async () => {
  const f = fixture();
  const logged = await f.login();
  cleanups.push(() => logged.runtime.dispose());
  await act(async () => {
    await logged.runtime.disconnect(logged.id);
  });
  render(
    <SempodsProvider runtime={logged.runtime}>
      <AppAccess appName="Tasks" />
    </SempodsProvider>,
  );
  const navigations = f.navigate.mock.calls.length;
  await act(async () =>
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' })),
  );
  await leaves(f, navigations);
  expect(prompt(f)).toBeNull();
});

it.each(['saved Pod', 'Pod read without a token'] as const)(
  "signs in from management's Sign in for a %s without asking for consent",
  async (kind) => {
    let f: ReturnType<typeof fixture>;
    let runtime: BrowserRuntime;
    if (kind === 'saved Pod') {
      // Signed in to Alice; Bob is listed on this device, never signed in.
      f = fixture({ allowedPods: [pod, 'https://pod.example/bob'] });
      const logged = await f.login();
      runtime = logged.runtime;
      await runtime.connect('https://pod.example/bob');
    } else {
      // The active Pod reads without a token; management offers Sign in.
      f = fixture({
        preferences: null,
        signIn: 'optional',
        preset: { podUrl: pod },
      });
      f.setCatalogue(async () => catalogue([work], []));
      runtime = f.runtime;
    }
    cleanups.push(() => runtime.dispose());
    render(
      <SempodsProvider runtime={runtime}>
        <AppAccess appName="Tasks" open />
      </SempodsProvider>,
    );
    const area = await screen.findByRole('region', { name: 'Pods & sharing' });
    const button = await waitFor(() => {
      const scope =
        kind === 'saved Pod'
          ? within(area).getByRole('list', { name: 'Pods on this device' })
          : area;
      const found = within(scope).getByRole<HTMLButtonElement>('button', {
        name: 'Sign in',
      });
      expect(found.disabled).toBe(false);
      return found;
    });
    const navigations = f.navigate.mock.calls.length;
    await act(async () => fireEvent.click(button));
    await leaves(f, navigations);
    expect(prompt(f)).toBeNull();
  },
);

it('resolves share() to false instead of rejecting; shareProblem tells a failure from a declined question (#380)', async () => {
  const f = fixture();
  const logged = await f.login();
  cleanups.push(() => logged.runtime.dispose());
  const outcomes: boolean[] = [];
  function Menu() {
    const lists = useContexts();
    const [dirty, setDirty] = useState(false);
    useDraftGuard(dirty, () => setDirty(false));
    return (
      <>
        <button onClick={() => setDirty(true)}>Edit</button>
        <button onClick={() => setDirty(false)}>Save</button>
        <button
          disabled={!lists.canShare}
          // No catch: share() never rejects.
          onClick={() => void lists.share().then((ok) => outcomes.push(ok))}
        >
          Share more lists
        </button>
        <output aria-label="problem">{lists.shareProblem ?? ''}</output>
      </>
    );
  }
  render(
    <SempodsProvider runtime={logged.runtime}>
      <Menu />
    </SempodsProvider>,
  );
  const share = await waitFor(() => {
    const found = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Share more lists',
    });
    expect(found.disabled).toBe(false);
    return found;
  });
  const problem = () => screen.getByLabelText('problem').textContent;
  const navigations = f.navigate.mock.calls.length;
  // Declined: the leave question keeps the draft; nothing failed.
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
  fireEvent.click(share);
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }));
  await waitFor(() => expect(outcomes).toEqual([false]));
  expect(problem()).toBe('');
  // The Pod's discovery does not answer: a failure before the Pod.
  f.fetch.mockRejectedValue(new TypeError('Failed to fetch'));
  // After a confirmed leave question, the SDK's confirmation reports it.
  fireEvent.click(share);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Discard and continue' }),
  );
  await waitFor(() => expect(outcomes).toEqual([false, false]));
  expect((await screen.findByRole('alert')).textContent).toBe(
    'The operation could not be completed.',
  );
  expect(problem()).toBe('');
  // The draft stays, since nothing left. Without a question, shareProblem reports it.
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  fireEvent.click(share);
  await waitFor(() => expect(outcomes).toEqual([false, false, false]));
  await waitFor(() => expect(problem()).not.toBe(''));
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
});
