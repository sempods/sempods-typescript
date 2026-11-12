// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PodContextList } from '@sempods/app-sdk/react';
import { ContextSwitch } from './context-switch.js';

const api = vi.hoisted(() => ({
  list: {} as PodContextList,
  authorize: vi.fn(),
  canShare: true,
}));
vi.mock('@sempods/app-sdk/react', async (original) => ({
  ...(await original<object>()),
  usePodContexts: () => api.list,
  useContexts: () => ({ canShare: api.canShare }),
  useApp: () => ({ authorize: api.authorize }),
  useAppState: () => ({ signIn: 'required', activeId: 'alice' }),
}));
afterEach(cleanup);
beforeEach(() => {
  api.canShare = true;
  api.authorize.mockReset().mockResolvedValue(true);
  const pods = ['alice', 'bob'].map((id) => ({
    connectionId: id,
    podUrl: `https://one.example/${id}/`,
    name: id,
    label: id,
    status: 'ready' as const,
    retry: vi.fn().mockResolvedValue(undefined),
    choices: [
      {
        connectionId: id,
        podUrl: `https://one.example/${id}/`,
        podLabel: id,
        iri: `https://one.example/${id}/_system/contexts/shop`,
        contextIri: `https://one.example/${id}/_system/contexts/shop`,
        key: `${id}\nshop`,
        name: `Shopping · ${id}`,
        label: 'Shopping',
        writable: id === 'alice',
        selectable: true,
      },
    ],
  }));
  api.list = {
    pods,
    choices: pods.flatMap((p) => p.choices),
    selected: pods[0]!.choices[0]!,
    select: vi.fn().mockResolvedValue({ kind: 'selected' }),
  };
});
const show = () =>
  render(
    <ContextSwitch
      title="Groceries"
      label="List"
      icon={
        <svg>
          <title>Icon must be silent</title>
        </svg>
      }
    />,
  );
const press = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyUp(el, { key: 'Enter' });
  });
};
const open = async () => {
  await press(screen.getByRole('button', { name: 'List: Shopping · alice' }));
};

it('groups concise names, announces access, and selects by the pair of identities', async () => {
  show();
  await open();
  const rows = screen.getAllByRole('menuitemradio', { name: 'Shopping' });
  expect(rows.map((r) => r.getAttribute('aria-checked'))).toEqual([
    'true',
    'false',
  ]);
  expect(rows[1]!.getAttribute('aria-describedby')).toBeTruthy();
  expect(
    document.getElementById(rows[1]!.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('bob · Read only');
  expect(
    within(screen.getByRole('menu')).queryByText('Shopping · bob'),
  ).toBeNull();
  expect(screen.getByText('Read only', { selector: 'span' })).toBeTruthy();
  await press(rows[1]!);
  expect(api.list.select).toHaveBeenCalledWith(api.list.pods[1]!.choices[0]);
  expect(screen.queryByRole('menu')).toBeNull();
});

it.each(['blocked', 'unavailable', 'declined'] as const)(
  'reports %s without claiming a selection',
  async (kind) => {
    vi.mocked(api.list.select).mockResolvedValue(
      kind === 'unavailable' ? { kind, reason: 'catalogue' } : { kind },
    );
    show();
    await open();
    await press(screen.getAllByRole('menuitemradio')[1]!);
    if (kind === 'declined') expect(screen.queryByRole('alert')).toBeNull();
    else
      expect(screen.getByRole('alert').textContent).toMatch(
        kind === 'blocked' ? /Wait/ : /unavailable/,
      );
    expect(
      screen.getByRole('button', { name: 'List: Shopping · alice' }),
    ).toBeTruthy();
  },
);

it('keeps a failed Pod distinct from empty, disables its retained choices, and retries only it', async () => {
  const failed = {
    ...api.list.pods[1]!,
    status: 'failed' as const,
    choices: api.list.pods[1]!.choices.map((c) => ({
      ...c,
      selectable: false,
    })),
  };
  api.list = { ...api.list, pods: [api.list.pods[0]!, failed] };
  show();
  await open();
  expect(
    screen.getAllByRole('menuitemradio')[1]!.getAttribute('aria-disabled'),
  ).toBe('true');
  expect(screen.getByText('Contexts could not be loaded.')).toBeTruthy();
  await press(screen.getByRole('menuitem', { name: 'Try again: bob' }));
  expect(failed.retry).toHaveBeenCalledOnce();
  expect(api.list.pods[0]!.retry).not.toHaveBeenCalled();
  expect(screen.getByRole('menu')).toBeTruthy();
});

it('shows loading, empty, and signed-out Pods as different states', async () => {
  api.list = {
    ...api.list,
    pods: [
      { ...api.list.pods[0]!, status: 'loading', choices: [] },
      { ...api.list.pods[1]!, choices: [] },
      {
        ...api.list.pods[1]!,
        connectionId: 'ended',
        status: 'ended',
        choices: [],
      },
    ],
  };
  show();
  await open();
  for (const text of [
    'Loading contexts …',
    'No readable contexts shared.',
    'Sign in to use this Pod.',
  ])
    expect(screen.getByText(text)).toBeTruthy();
  await press(screen.getByRole('menuitem', { name: 'Sign in' }));
  expect(api.authorize).toHaveBeenCalledWith('ended');
});

it('localizes authorization errors through the SDK and allows another attempt', async () => {
  api.authorize.mockRejectedValueOnce(new Error('private diagnostics'));
  show();
  await open();
  await press(screen.getByRole('menuitem', { name: 'Share more contexts …' }));
  expect(screen.getByRole('alert').textContent).not.toContain(
    'private diagnostics',
  );
  await open();
  await press(screen.getByRole('menuitem', { name: 'Share more contexts …' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.authorize).toHaveBeenCalledTimes(2);
});
