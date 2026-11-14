// @vitest-environment jsdom
/**
 * Apps without sign-in, or with optional sign-in (#240): no gate while the
 * app reads public data without a token, signing in as an action prompt, an
 * address that opens a Pod instead of signing in, and no sign-in at all
 * under `signIn: 'none'`.
 */
import { webcrypto } from 'node:crypto';
import { Activity, useState } from 'react';
import { fields, text } from '@sempods/client-sdk/edit';
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
  deferred,
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
  useContexts,
  useCreation,
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
  // Signing in is offered once, in the prompt; the chooser does not repeat it.
  await waitFor(() => expect(prompts()).toHaveLength(1));
  expect(screen.getAllByRole('button', { name: 'Sign in' })).toHaveLength(1);
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
    within(management)
      .getByRole('button', { name: 'Remove from this device' })
      .click(),
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

const task = fields(
  { title: text('urn:title', { language: null }) },
  { type: 'urn:Task' },
);
function ExplicitCreation() {
  const creation = useCreation(task, {
    initial: { title: '' },
    iri: 'urn:item',
    context: work,
  });
  return (
    <>
      <input
        aria-label="Title"
        disabled={!creation.canEdit}
        value={creation.draft.title}
        onChange={(event) => creation.change({ title: event.target.value })}
      />
      <button type="button" onClick={() => void creation.create()}>
        Create
      </button>
      <button type="button" onClick={() => creation.change({ title: '' })}>
        Clear
      </button>
      <output data-testid="creation">
        {[creation.busy ? 'busy' : '', creation.outcome?.kind ?? '']
          .filter(Boolean)
          .join(' ')}
      </output>
    </>
  );
}
/**
 * Signed in under `optional` with `work` writable (read-only without a
 * token), a creation form for `work` mounted beside `AppAccess` and a title
 * typed into it. Creations are answered by `answer`.
 */
async function explicitDraft(
  answer: () => Promise<Response> | Response,
  host: 'plain' | 'unmount' | 'activity' = 'plain',
) {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  f.setCatalogue(async (_url, init) =>
    new Headers(init?.headers).get('authorization')
      ? catalogue([work], [work])
      : catalogue([work], []),
  );
  f.setResource(async (_url, init) =>
    init?.method === 'PUT' ? answer() : new Response(null, { status: 404 }),
  );
  const session = await f.login();
  cleanups.push(() => session.runtime.dispose());
  let toggle!: (show: boolean) => void;
  function Host() {
    const [show, setShow] = useState(true);
    toggle = setShow;
    if (host === 'activity')
      return (
        <Activity mode={show ? 'visible' : 'hidden'}>
          <ExplicitCreation />
        </Activity>
      );
    return show ? <ExplicitCreation /> : null;
  }
  render(
    <SempodsProvider runtime={session.runtime}>
      <AppAccess appName="Recipes" />
      <Host />
    </SempodsProvider>,
  );
  const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
  // Change it once the form can edit: changing inside `waitFor` would
  // re-run on every DOM mutation the ignored change causes.
  await waitFor(() => expect(title.disabled).toBe(false));
  fireEvent.change(title, { target: { value: 'Unsaved task' } });
  await waitFor(() => expect(title.value).toBe('Unsaved task'));
  const state = () => screen.getByTestId('creation').textContent;
  /** Ends the session: a refused renewal, after which it reads without a token. */
  async function endSession() {
    await act(async () => {
      await renewal(f, session.runtime, session.id, 'refused');
    });
    await waitFor(() =>
      expect(session.runtime.getSnapshot()[0]!.reading).toBe('anonymous'),
    );
    await act(async () => {});
  }
  return {
    ...f,
    ...session,
    title,
    state,
    endSession,
    show: (visible: boolean) => act(() => toggle(visible)),
  };
}

it('keeps an unsent explicit-Context draft, editable, when the session ends', async () => {
  const f = await explicitDraft(() => new Response(null, { status: 201 }));
  await f.endSession();
  // Same-target access loss: the form keeps its draft and can still clear it.
  expect(screen.getByLabelText('Title')).toBe(f.title);
  expect(f.title.value).toBe('Unsaved task');
  await act(async () => screen.getByRole('button', { name: 'Clear' }).click());
  await waitFor(() => expect(f.title.value).toBe(''));
});

it('keeps an unconfirmed explicit-Context creation when the session ends', async () => {
  // An answer that is not a confirmed creation: the outcome is unconfirmed.
  const f = await explicitDraft(() => new Response(null, { status: 202 }));
  await act(async () => screen.getByRole('button', { name: 'Create' }).click());
  await waitFor(() => expect(f.state()).toBe('unconfirmed'));
  expect(f.title.disabled).toBe(true);
  await f.endSession();
  expect(f.state()).toBe('unconfirmed');
  expect(f.title.value).toBe('Unsaved task');
});

it('keeps an explicit-Context creation in flight when the session ends', async () => {
  const held = deferred<Response>();
  const f = await explicitDraft(() => held.promise);
  await act(async () => screen.getByRole('button', { name: 'Create' }).click());
  await waitFor(() => expect(f.state()).toBe('busy'));
  await f.endSession();
  expect(f.state()).toBe('busy');
  await act(async () => held.resolve(new Response(null, { status: 202 })));
  await waitFor(() => expect(f.state()).toBe('unconfirmed'));
  expect(f.title.value).toBe('Unsaved task');
});

it('releases the selected view when only an explicit-Context form holds work', async () => {
  const f = start({ signIn: 'optional', preset: { podUrl: pod } });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  const app = createAppController(runtime);
  app.start();
  cleanups.push(() => app.stop());
  await waitFor(() => expect(app.getSnapshot().view).not.toBeNull());
  const before = app.getSnapshot().view;
  // A draft of a creation in an explicit Context keeps its own binding.
  app.register({
    scope: 'explicit',
    dirty: () => true,
    blocked: () => false,
    discard: () => {},
  });
  await renewal(f, runtime, id, 'refused');
  await waitFor(() =>
    expect(runtime.getSnapshot()[0]!.reading).toBe('anonymous'),
  );
  const after = app.getSnapshot().view;
  expect(after).not.toBe(before);
  expect(after!.getSnapshot()).toMatchObject({ current: true, write: false });
});

function Sharing() {
  const { canShare } = useContexts();
  return <output data-testid="share">{String(canShare)}</output>;
}

it('offers sharing only where the app signs in', async () => {
  for (const signIn of ['optional', 'none'] as const) {
    const f = start({
      signIn,
      preset: { podUrl: pod },
      ...(signIn === 'none' ? without('identity') : {}),
    });
    render(
      <SempodsProvider runtime={f.runtime}>
        <Sharing />
      </SempodsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('share').textContent).toBe(
        String(signIn === 'optional'),
      ),
    );
    cleanup();
  }
});

it.each(['unmount', 'activity'] as const)(
  'keeps an unconfirmed explicit-Context creation while its form is away (%s) as the session ends',
  async (host) => {
    const f = await explicitDraft(
      () => new Response(null, { status: 202 }),
      host,
    );
    await act(async () =>
      screen.getByRole('button', { name: 'Create' }).click(),
    );
    await waitFor(() => expect(f.state()).toBe('unconfirmed'));
    // The controller owns the captured creation, not the form.
    f.show(false);
    await f.endSession();
    f.show(true);
    const title = (await screen.findByLabelText('Title')) as HTMLInputElement;
    await waitFor(() => expect(f.state()).toBe('unconfirmed'));
    expect(title.disabled).toBe(true);
    expect(title.value).toBe('Unsaved task');
  },
);

it('opens a signed-in Pod by its address without signing in again', async () => {
  const f = start({
    signIn: 'optional',
    allowedPods: [pod, 'https://pod.example/bob'],
  });
  const { runtime, id } = await f.login();
  cleanups.push(() => runtime.dispose());
  await runtime.connect('https://pod.example/bob');
  const navigations = f.navigate.mock.calls.length;
  render(
    <SempodsProvider runtime={runtime}>
      <AppAccess appName="Recipes" open />
    </SempodsProvider>,
  );
  // Management's Pod chooser opens the signed-in Pod again.
  const chooser = (await screen.findByLabelText(
    'Pod address',
  )) as HTMLSelectElement;
  fireEvent.change(chooser, { target: { value: pod } });
  const open = screen.getByRole('button', {
    name: 'Open',
  }) as HTMLButtonElement;
  await act(async () => open.click());
  // The action has ended once the controls are enabled again.
  await waitFor(() => expect(open.disabled).toBe(false));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  expect(runtime.getSnapshot().find((c) => c.id === id)).toMatchObject({
    session: { kind: 'active' },
    reading: 'session',
  });
});
