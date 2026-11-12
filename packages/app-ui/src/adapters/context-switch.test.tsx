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
  activeId: 'alice',
  signIn: 'required' as 'required' | 'none',
}));
vi.mock('@sempods/app-sdk/react', async (original) => ({
  ...(await original<object>()),
  usePodContexts: () => api.list,
  useContexts: () => ({ canShare: api.canShare }),
  useApp: () => ({ authorize: api.authorize }),
  useAppState: () => ({ signIn: api.signIn, activeId: api.activeId }),
}));
afterEach(cleanup);
beforeEach(() => {
  api.canShare = true;
  api.activeId = 'alice';
  api.signIn = 'required';
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
        contextLabel: 'Shopping',
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
  await press(screen.getByRole('button', { name: /^List:/ }));
};

it('groups concise names, announces access, and selects by the pair of identities', async () => {
  show();
  await open();
  const menu = within(screen.getByRole('menu'));
  expect(menu.getAllByRole('group')).toHaveLength(2);
  expect(menu.getByRole('group', { name: 'alice' })).toBeTruthy();
  expect(menu.getByRole('group', { name: 'bob' })).toBeTruthy();
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
  expect(screen.getByRole('group', { name: 'bob: Pod actions' })).toBeTruthy();
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
  await press(screen.getByRole('menuitem', { name: 'Sign in: bob' }));
  expect(api.authorize).toHaveBeenCalledWith('ended');
});

it('localizes authorization errors through the SDK and allows another attempt', async () => {
  api.authorize.mockRejectedValueOnce(new Error('private diagnostics'));
  show();
  await open();
  await press(
    screen.getByRole('menuitem', { name: 'Share more contexts …: alice' }),
  );
  expect(screen.getByRole('alert').textContent).not.toContain(
    'private diagnostics',
  );
  await open();
  await press(
    screen.getByRole('menuitem', { name: 'Share more contexts …: alice' }),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.authorize).toHaveBeenCalledTimes(2);
});

it('offers sharing directly on an empty inactive Pod without selecting it first', async () => {
  api.list = {
    ...api.list,
    pods: [api.list.pods[0]!, { ...api.list.pods[1]!, choices: [] }],
  };
  show();
  await open();
  const bob = within(screen.getByRole('group', { name: 'bob' }));
  expect(screen.getAllByRole('group')).toHaveLength(2);
  expect(bob.getByText('No readable contexts shared.')).toBeTruthy();
  await press(
    bob.getByRole('menuitem', { name: 'Share more contexts …: bob' }),
  );
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('bob');
  expect(api.list.select).not.toHaveBeenCalled();
});

it('offers one share action per empty Pod, with no duplicate active-Pod action', async () => {
  api.list = {
    ...api.list,
    selected: null,
    pods: api.list.pods.map((p) => ({ ...p, choices: [] })),
  };
  show();
  await open();
  expect(screen.getAllByRole('group')).toHaveLength(2);
  expect(
    screen.getAllByRole('menuitem', { name: /^Share more contexts/ }),
  ).toHaveLength(2);
  await press(
    screen.getByRole('menuitem', { name: 'Share more contexts …: alice' }),
  );
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('alice');
});

it('distinguishes sign-in actions for two ended Pods and retains one group each', async () => {
  api.canShare = false;
  api.list = {
    ...api.list,
    selected: null,
    pods: api.list.pods.map((p) => ({ ...p, status: 'ended', choices: [] })),
  };
  show();
  await open();
  expect(screen.getAllByRole('group')).toHaveLength(2);
  expect(screen.getByRole('menuitem', { name: 'Sign in: alice' })).toBeTruthy();
  await press(screen.getByRole('menuitem', { name: 'Sign in: bob' }));
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('bob');
});

it('offers no sharing or sign-in when signIn is none', async () => {
  api.canShare = false;
  api.signIn = 'none';
  api.list = {
    ...api.list,
    selected: null,
    pods: [
      { ...api.list.pods[0]!, choices: [] },
      { ...api.list.pods[1]!, status: 'ended', choices: [] },
    ],
  };
  show();
  await open();
  expect(
    screen.queryByRole('menuitem', { name: /^(Sign in:|Share more contexts)/ }),
  ).toBeNull();
});

it('updates the sharing target when the active Pod changes while the menu is open', async () => {
  const { rerender } = render(<ContextSwitch title="Groceries" label="List" />);
  await open();
  api.activeId = 'bob';
  api.list = { ...api.list, selected: api.list.pods[1]!.choices[0]! };
  rerender(<ContextSwitch title="Groceries" label="List" />);
  await press(
    screen.getByRole('menuitem', { name: 'Share more contexts …: bob' }),
  );
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('bob');
});

it('tells equal names within one Pod apart by a quieter qualifier, keeping it in accessible names', async () => {
  const [alice] = api.list.pods;
  const first = alice!.choices[0]!;
  const second = {
    ...first,
    iri: first.iri.replace('shop', 'shop-2'),
    contextIri: first.iri.replace('shop', 'shop-2'),
    key: 'alice\nshop-2',
    name: 'Shopping · shop-2',
    label: 'Shopping · shop-2',
    contextLabel: 'Shopping',
    qualifier: 'shop-2',
  };
  const both = [
    {
      ...first,
      name: 'Shopping · shop',
      label: 'Shopping · shop',
      qualifier: 'shop',
    },
    second,
  ];
  api.list = {
    ...api.list,
    pods: [{ ...alice!, choices: both }],
    choices: both,
    selected: second,
  };
  show();
  const trigger = screen.getByRole('button', {
    name: 'List: Shopping · shop-2 · alice',
  });
  expect(within(trigger).getByText('· shop-2').className).toContain(
    'text-muted-foreground',
  );
  await open();
  const rows = screen.getAllByRole('menuitemradio');
  // Each row is labelled by its whole unique label, the Pod only described.
  const labelText = (row: HTMLElement) =>
    document.getElementById(row.getAttribute('aria-labelledby')!)?.textContent;
  expect(rows.map(labelText)).toEqual(['Shopping · shop', 'Shopping · shop-2']);
  const chosen = rows[1]!;
  expect(chosen.getAttribute('aria-checked')).toBe('true');
  // The Pod stays in the description, not repeated in the row.
  expect(
    document.getElementById(chosen.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('alice · Read and write');
  await press(chosen);
  expect(api.list.select).toHaveBeenCalledWith(second);
});
