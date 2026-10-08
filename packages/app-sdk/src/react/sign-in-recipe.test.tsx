// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  KnownPodExample,
  KnownPodControls,
} from '../../../../examples/todo/recipes/sign-in.js';
import { RuntimeError, type StartupReport } from '@sempods/app-sdk';
import { SempodsProvider } from '@sempods/app-sdk/react';
import {
  fixture,
  pod,
  work,
  personal,
  catalogue,
  deferred,
} from '../runtime/fixture.test.js';
const dispose: (() => void)[] = [];
beforeEach(async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal(
    'ArrayBuffer',
    (await webcrypto.subtle.digest('SHA-256', new Uint8Array())).constructor,
  );
});
afterEach(() => {
  cleanup();
  dispose.splice(0).forEach((fn) => fn());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
/**
 * The target-bound note. Before startup settles there is no view yet (#80) and
 * the recipe shows a read-only placeholder inside a disabled fieldset.
 */
function liveNote() {
  return waitFor(() => {
    const input = screen.getByLabelText('Note') as HTMLInputElement;
    expect(input.closest('fieldset[disabled]')).toBeNull();
    return input;
  });
}
async function connected(f = fixture()) {
  const session = await f.login();
  dispose.push(() => session.runtime.dispose());
  return { ...f, ...session };
}
it.each(['busy', 'unavailable'] as const)(
  'distinguishes unresolved startup from %s and keeps sign-in blocked',
  async (storage) => {
    const f = fixture();
    dispose.push(() => f.runtime.dispose());
    const startup = deferred<StartupReport>();
    vi.spyOn(f.runtime, 'initialize').mockReturnValue(startup.promise);
    render(<KnownPodExample runtime={f.runtime} podUrl={pod} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () =>
      startup.resolve({ storage, interaction: 'none', unreadable: [] }),
    );
    expect(screen.queryByText('Loading…')).toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(
      storage === 'busy' ? /another tab/ : /storage/,
    );
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
it('reuses an existing connection after failed sign-in preparation and rapid clicks', async () => {
  const f = fixture();
  dispose.push(() => f.runtime.dispose());
  const connect = vi.spyOn(f.runtime, 'connect');
  const authorize = vi
    .spyOn(f.runtime, 'beginAuthorization')
    .mockRejectedValueOnce(new RuntimeError('network'));
  render(
    <SempodsProvider runtime={f.runtime}>
      <KnownPodControls podUrl={pod} />
      <KnownPodControls podUrl={pod} />
    </SempodsProvider>,
  );
  await waitFor(() =>
    expect(
      (
        screen.getAllByRole('button', {
          name: 'Sign in',
        })[0] as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0]!);
  fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[1]!);
  await screen.findByRole('alert');
  expect(connect).toHaveBeenCalledTimes(1);
  expect(f.runtime.getSnapshot()).toHaveLength(1);
  fireEvent.click(screen.getAllByRole('button', { name: 'Sign in' })[0]!);
  await waitFor(() => expect(f.navigate).toHaveBeenCalledTimes(1));
  expect(connect).toHaveBeenCalledTimes(1);
  expect(authorize).toHaveBeenCalledTimes(2);
});
it('lets the client reject a noncanonical configured URL before sending a request', async () => {
  const f = fixture();
  dispose.push(() => f.runtime.dispose());
  render(<KnownPodExample runtime={f.runtime} podUrl={pod + '/'} />);
  const button = screen.getByRole('button', { name: 'Sign in' });
  await waitFor(() =>
    expect((button as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(button);
  await screen.findByRole('alert');
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.runtime.getSnapshot()).toHaveLength(0);
});
it.each(['hidden', 'disabled', 'custom'] as const)(
  'keeps a dirty note through write/read loss, %s fallback and recovery',
  async (mode) => {
    const f = await connected();
    const mounted = render(
      <KnownPodExample
        runtime={f.runtime}
        podUrl={pod}
        fallback={
          mode === 'custom' ? { content: <p>Ask the host for access</p> } : mode
        }
      />,
    );
    const input = await liveNote();
    fireEvent.change(input, { target: { value: 'Unfinished' } });
    input.focus();
    f.setCatalogue(async () => catalogue([work, personal], []));
    await act(() => f.runtime.loadContexts(f.id));
    expect(input.value).toBe('Unfinished');
    expect(input.disabled).toBe(true);
    expect(input.closest('[hidden]')).toBeNull();
    f.setCatalogue(async () => catalogue([personal], []));
    await act(() => f.runtime.loadContexts(f.id));
    expect(input.value).toBe('Unfinished');
    expect(Boolean(input.closest('[hidden]'))).toBe(mode !== 'disabled');
    expect(input.closest('[inert]')).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      'Review access',
    );
    if (mode === 'custom')
      expect(screen.getByText('Ask the host for access')).toBeTruthy();
    f.setCatalogue(async () => catalogue());
    await act(() => f.runtime.loadContexts(f.id));
    expect(screen.getByLabelText('Note')).toBe(input);
    expect(input.closest('[hidden]')).toBeNull();
    mounted.rerender(
      <KnownPodExample runtime={f.runtime} podUrl={pod} language="de" />,
    );
    expect(screen.getByLabelText('Notiz')).toBe(input);
    expect(input.value).toBe('Unfinished');
  },
);
it('keeps an unconfirmed creation notice outside hidden content and guards sign-in', async () => {
  const f = await connected();
  f.setResource(async () => {
    throw new TypeError('lost answer');
  });
  render(<KnownPodExample runtime={f.runtime} podUrl={pod} />);
  fireEvent.change(await liveNote(), {
    target: { value: 'One captured note' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText(/The result is unconfirmed/);
  const writes = () =>
    f.fetch.mock.calls.filter(([, init]) => init?.method === 'PUT');
  expect(writes()).toHaveLength(1);
  f.setCatalogue(async () => catalogue([personal], []));
  await act(() => f.runtime.loadContexts(f.id));
  const notice = screen.getByText(/The result is unconfirmed/);
  expect(notice.closest('[hidden]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Update access' }));
  await screen.findByText(/A write is still unconfirmed/);
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe(
    'One captured note',
  );
  expect(writes()).toHaveLength(1);
});
it.each(['failed', 'cancelled'] as const)(
  'keeps an active target usable alongside a %s callback and failed catalogue refresh',
  async (interaction) => {
    const f = await connected();
    vi.spyOn(f.runtime, 'initialize').mockResolvedValue({
      storage: 'durable',
      interaction,
      problem: 'denied',
      unreadable: [],
    });
    render(<KnownPodExample runtime={f.runtime} podUrl={pod} />);
    const input = await liveNote();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: 'Still mine' } });
    f.setCatalogue(async () => {
      throw new TypeError('network');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() =>
      expect(f.runtime.getSnapshot()[0]?.catalogue.kind).toBe('failed'),
    );
    expect(input.value).toBe('Still mine');
    expect(input.closest('[hidden]')).toBeNull();
    expect(input.disabled).toBe(false);
  },
);
it('guards a context change and keeps one runtime alive after unmount', async () => {
  const f = await connected();
  const mounted = render(<KnownPodExample runtime={f.runtime} podUrl={pod} />);
  fireEvent.change(await liveNote(), {
    target: { value: 'Keep me' },
  });
  fireEvent.change(screen.getByRole('combobox'), {
    target: { value: personal },
  });
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(f.runtime.bind(f.id).contextIri).toBe(work);
  expect((screen.getByLabelText('Note') as HTMLInputElement).value).toBe(
    'Keep me',
  );
  mounted.unmount();
  expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active');
});
it.each(['required', 'optional'] as const)(
  'keeps %s missing scope evidence separate from authentication',
  async (kind) => {
    const f = await connected(fixture({ scopes: { [kind]: ['notes'] } }));
    render(<KnownPodExample runtime={f.runtime} podUrl={pod} />);
    const input = await liveNote();
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('active');
    expect(Boolean(input.closest('[hidden]'))).toBe(kind === 'required');
    expect(input.disabled).toBe(kind === 'required');
  },
);
it('keeps the target mounted during renewal and retains its draft when the session ends', async () => {
  const f = await connected();
  const token = deferred<Response>();
  f.setToken(async () => token.promise);
  f.setResource(
    async () =>
      new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer error="invalid_token"' },
      }),
  );
  render(<KnownPodExample runtime={f.runtime} podUrl={pod} />);
  const input = await liveNote();
  fireEvent.change(input, { target: { value: 'Still my draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('renewing'),
  );
  expect(input.closest('[hidden]')).toBeNull();
  const navigations = f.navigate.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Update access' }));
  expect(f.navigate).toHaveBeenCalledTimes(navigations);
  await act(async () =>
    token.resolve(Response.json({ error: 'invalid_grant' }, { status: 400 })),
  );
  await waitFor(() =>
    expect(f.runtime.getSnapshot()[0]?.session.kind).toBe('ended'),
  );
  expect(screen.getByLabelText('Note')).toBe(input);
  expect(input.value).toBe('Still my draft');
  expect(input.closest('[hidden]')).not.toBeNull();
});
it.each(['hidden', 'disabled', 'custom'] as const)(
  'offers %s presentation before any connection exists without starting login',
  async (mode) => {
    const f = fixture();
    dispose.push(() => f.runtime.dispose());
    render(
      <KnownPodExample
        runtime={f.runtime}
        podUrl={pod}
        fallback={
          mode === 'custom' ? { content: <p>Use sign in above</p> } : mode
        }
      />,
    );
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    const input = screen.getByLabelText('Note');
    expect(Boolean(input.closest('[hidden]'))).toBe(mode !== 'disabled');
    expect(input.closest('[inert]')).not.toBeNull();
    if (mode === 'custom')
      expect(screen.getByText('Use sign in above')).toBeTruthy();
    expect(f.fetch).not.toHaveBeenCalled();
  },
);
