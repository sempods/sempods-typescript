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

it('groups concise names, marks only read-only lists, and selects by the pair of identities', async () => {
  show();
  await open();
  const menu = within(screen.getByRole('menu'));
  // Selection only: no permanent sharing, address details or icon legend.
  expect(menu.getAllByRole('menuitemradio')).toHaveLength(2);
  expect(menu.queryAllByRole('menuitem')).toHaveLength(0);
  expect(screen.queryByRole('region')).toBeNull();
  expect(screen.queryByText(/address/i)).toBeNull();
  expect(screen.queryByText('Read and write')).toBeNull();
  expect(
    document.querySelector('svg.lucide-pencil, svg.lucide-eye'),
  ).toBeNull();
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
  // The visible mark is on bob's row only; the description already says it.
  const badge = screen.getByText('Read only', { selector: 'span' });
  expect(rows[1]!.contains(badge)).toBe(true);
  expect(badge.getAttribute('aria-hidden')).toBe('true');
  expect(screen.getAllByText('Read only', { selector: 'span' })).toHaveLength(
    1,
  );
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
  // Unavailable is distinct from read-only: the retained row keeps its mark
  // but cannot be chosen, and its description says why.
  const retained = screen.getAllByRole('menuitemradio')[1]!;
  expect(within(retained).getByText('Read only')).toBeTruthy();
  expect(
    document.getElementById(retained.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('bob · Read only · This context is currently unavailable.');
  expect(
    screen.queryByRole('menuitem', { name: /^Share contexts/ }),
  ).toBeNull();
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
  // Loading and signed-out are not empty grants: only bob offers sharing.
  expect(
    screen
      .getAllByRole('menuitem', { name: /^Share contexts/ })
      .map((item) => item.getAttribute('aria-label')),
  ).toEqual(['Share contexts …: bob']);
  await press(screen.getByRole('menuitem', { name: 'Sign in: bob' }));
  // Signing in may reuse the grant; only sharing asks for consent (#362).
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('ended');
});

it('offers retry, not sharing, for a restorable Pod without lists', async () => {
  api.list = {
    ...api.list,
    pods: [
      api.list.pods[0]!,
      {
        ...api.list.pods[1]!,
        status: 'restoring',
        restorable: true,
        choices: [],
      },
    ],
  };
  show();
  await open();
  expect(screen.getByText('Reconnecting …')).toBeTruthy();
  expect(
    screen.queryByRole('menuitem', { name: /^Share contexts/ }),
  ).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /^Sign in/ })).toBeNull();
  await press(screen.getByRole('menuitem', { name: 'Try again: bob' }));
  expect(api.list.pods[1]!.retry).toHaveBeenCalledOnce();
});

it('shows no read-only mark when every list is editable', async () => {
  api.list = {
    ...api.list,
    pods: api.list.pods.map((p) => ({
      ...p,
      choices: p.choices.map((c) => ({ ...c, writable: true })),
    })),
  };
  show();
  await open();
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
  expect(screen.queryByText('Read only')).toBeNull();
  expect(screen.queryByText('Read and write')).toBeNull();
});

it('localizes authorization errors through the SDK and allows another attempt', async () => {
  api.authorize.mockRejectedValueOnce(new Error('private diagnostics'));
  api.list = {
    ...api.list,
    selected: null,
    pods: [{ ...api.list.pods[0]!, choices: [] }],
  };
  show();
  await open();
  await press(
    screen.getByRole('menuitem', { name: 'Share contexts …: alice' }),
  );
  expect(screen.getByRole('alert').textContent).not.toContain(
    'private diagnostics',
  );
  await open();
  await press(
    screen.getByRole('menuitem', { name: 'Share contexts …: alice' }),
  );
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api.authorize).toHaveBeenCalledTimes(2);
  expect(api.authorize).toHaveBeenLastCalledWith('alice', {
    intent: 'change-sharing',
  });
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
  await press(bob.getByRole('menuitem', { name: 'Share contexts …: bob' }));
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('bob', {
    intent: 'change-sharing',
  });
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
    screen.getAllByRole('menuitem', { name: /^Share contexts/ }),
  ).toHaveLength(2);
  await press(
    screen.getByRole('menuitem', { name: 'Share contexts …: alice' }),
  );
  expect(api.authorize).toHaveBeenCalledExactlyOnceWith('alice', {
    intent: 'change-sharing',
  });
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
    screen.queryByRole('menuitem', { name: /^(Sign in:|Share contexts)/ }),
  ).toBeNull();
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

it("replaces every generic word for a Context with the app's own", async () => {
  const texts = {
    shareContexts: 'Share lists …',
    chooseContext: 'Choose a list',
    contextsLoading: 'Loading lists …',
    contextsFailed: 'Lists could not be loaded.',
    contextsEmpty: 'No readable lists shared.',
    switchUnavailable: 'This list is currently unavailable.',
    actionNotCompleted: 'Your current list is unchanged.',
    noPods: 'Connect a Pod to choose a list.',
  };
  const generic = /context/i;
  const switchWith = () =>
    render(<ContextSwitch title="Groceries" label="List" texts={texts} />);
  const words = () =>
    [document.body.textContent, ...visibleNames()].filter(Boolean).join('\n');
  const visibleNames = () =>
    [...document.querySelectorAll('[aria-label]')].map((el) =>
      el.getAttribute('aria-label'),
    );

  const failed = {
    ...api.list.pods[1]!,
    status: 'failed' as const,
    choices: api.list.pods[1]!.choices.map((c) => ({
      ...c,
      selectable: false,
    })),
  };
  api.authorize.mockResolvedValue(false);
  api.list = {
    ...api.list,
    selected: null,
    pods: [
      { ...api.list.pods[0]!, status: 'loading', choices: [] },
      failed,
      {
        ...api.list.pods[1]!,
        connectionId: 'empty',
        label: 'empty',
        choices: [],
      },
    ],
  };
  switchWith();
  expect(screen.getByText('Choose a list')).toBeTruthy();
  await open();
  for (const text of [
    'Loading lists …',
    'Lists could not be loaded.',
    'No readable lists shared.',
  ])
    expect(screen.getByText(text)).toBeTruthy();
  const retained = screen.getByRole('menuitemradio');
  expect(
    document.getElementById(retained.getAttribute('aria-describedby')!)
      ?.textContent,
  ).toBe('bob · Read only · This list is currently unavailable.');
  expect(words()).not.toMatch(generic);
  await press(screen.getByRole('menuitem', { name: 'Share lists …: empty' }));
  expect(screen.getByRole('alert').textContent).toBe(
    'Your current list is unchanged.',
  );
  cleanup();

  api.list = { ...api.list, pods: [] };
  switchWith();
  await open();
  expect(screen.getByText('Connect a Pod to choose a list.')).toBeTruthy();
  expect(words()).not.toMatch(generic);
});

it('keeps the default wording for messages an app leaves out', async () => {
  api.list = { ...api.list, selected: null, pods: [] };
  render(
    <ContextSwitch
      title="Groceries"
      label="List"
      texts={{ contextsEmpty: 'No readable lists shared.', noPods: undefined }}
    />,
  );
  expect(screen.getByText('Choose a context')).toBeTruthy();
  await open();
  expect(screen.getByText('Connect a Pod to choose a context.')).toBeTruthy();
});

it('shows the Pod under the list name only when there is a second Pod to choose', () => {
  const trigger = () => screen.getByRole('button', { name: /^List:/ });
  const { unmount } = show();
  // Two Pods: the trigger's second line names the selected one (the icon's
  // title is decorative, hidden from assistive technology).
  expect(trigger().textContent).toBe('Icon must be silentShoppingalice');
  unmount();
  api.list = {
    ...api.list,
    pods: [api.list.pods[0]!],
    choices: api.list.pods[0]!.choices,
  };
  show();
  // One Pod: only the list's name is shown; the accessible name keeps the Pod.
  expect(trigger().textContent).toBe('Icon must be silentShopping');
  expect(trigger().getAttribute('aria-label')).toBe('List: Shopping · alice');
});
