// @vitest-environment jsdom
import { createRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { HeaderMenu } from './header-menu.js';

afterEach(cleanup);

it('checks the choice by id when two choices share a label', async () => {
  render(
    <HeaderMenu
      label="Menu"
      items={[
        {
          label: 'Context',
          choices: [
            { id: 'pod-a', label: 'Work', checked: false, onSelect: () => {} },
            { id: 'pod-b', label: 'Work', checked: true, onSelect: () => {} },
          ],
        },
      ]}
    />,
  );
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu' }), {
      key: 'Enter',
    });
  });
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'Context' }), {
      key: 'ArrowRight',
    });
  });
  const checked = screen
    .getAllByRole('menuitemradio', { name: 'Work' })
    .map((item) => item.getAttribute('aria-checked'));
  expect(checked).toEqual(['false', 'true']);
});

it('passes its button through ref, which stays after an item closes the menu', async () => {
  const menu = createRef<HTMLButtonElement>();
  const manage = vi.fn();
  render(
    <HeaderMenu
      ref={menu}
      label="Menu"
      items={[{ label: 'Pods & sharing', onSelect: manage }]}
    />,
  );
  const button = screen.getByRole('button', { name: 'Menu' });
  expect(menu.current).toBe(button);
  await act(async () => {
    fireEvent.keyDown(button, { key: 'Enter' });
  });
  const item = screen.getByRole('menuitem', { name: 'Pods & sharing' });
  await act(async () => {
    fireEvent.keyDown(item, { key: 'Enter' });
    fireEvent.keyUp(item, { key: 'Enter' });
  });
  expect(manage).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  // A surface the item opened returns the focus here (AppAccess focusTarget).
  expect(menu.current).toBe(button);
  expect(button.isConnected).toBe(true);
});

const typeahead = async (key: string) => {
  // React Aria joins keys typed within a second into one search.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key });
  });
};
const openMenu = async () => {
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('button', { name: 'Menu' }), {
      key: 'Enter',
    });
  });
};
// An icon with a text of its own: only aria-hidden keeps it out of the name.
const Icon = () => (
  <svg data-testid="icon">
    <title>people</title>
  </svg>
);

it('keeps the label as the name of an action with a silent leading icon', async () => {
  const manage = vi.fn();
  render(
    <HeaderMenu
      label="Menu"
      items={[
        { label: 'List', onSelect: () => {}, icon: <Icon /> },
        { label: 'View', choices: [] },
        null,
        { label: 'Pods & sharing', onSelect: manage, icon: <Icon /> },
        { label: 'Print', onSelect: () => {} },
      ]}
    />,
  );
  await openMenu();
  const items = screen.getAllByRole('menuitem');
  // The icon's <title> is in the text, but not in any item's name.
  expect(items.map((item) => item.textContent)).toEqual([
    'peopleList',
    'View',
    'peoplePods & sharing',
    'Print',
  ]);
  const pods = screen.getByRole('menuitem', { name: 'Pods & sharing' });
  expect(screen.getByRole('menuitem', { name: 'List' })).toBe(items[0]);
  expect(screen.getByRole('menuitem', { name: 'View' })).toBe(items[1]);
  // Every row leads with a silent 16px box, filled or empty, so the labels
  // share one column in either reading direction; no row is inset.
  for (const item of items) {
    const box = item.firstElementChild!;
    expect(box.getAttribute('aria-hidden')).toBe('true');
    expect(box.className).toMatch(/\bsize-4\b/);
    expect(item.hasAttribute('data-inset')).toBe(false);
  }
  expect(pods.firstElementChild!.querySelector('[data-testid=icon]')).not.toBe(
    null,
  );
  expect(items[1]!.firstElementChild!.childNodes).toHaveLength(0);
  // The row's hit area stays 44px for every kind of row.
  for (const item of items) expect(item.className).toMatch(/\bmin-h-11\b/);
  // Typeahead follows the label, not the icon, also to the submenu.
  await typeahead('v');
  expect(document.activeElement).toBe(items[1]);
  await typeahead('p');
  expect(document.activeElement).toBe(pods);
  await act(async () => {
    fireEvent.keyDown(pods, { key: 'Enter' });
    fireEvent.keyUp(pods, { key: 'Enter' });
  });
  expect(manage).toHaveBeenCalledOnce();
});

it('renders text-only menus as before', async () => {
  render(
    <HeaderMenu
      label="Menu"
      items={[
        { label: 'Print', onSelect: () => {} },
        { label: 'View', choices: [] },
      ]}
    />,
  );
  await openMenu();
  const items = screen.getAllByRole('menuitem');
  expect(items.map((item) => item.textContent)).toEqual(['Print', 'View']);
  expect(screen.getByRole('menuitem', { name: 'Print' })).toBe(items[0]);
  expect(screen.getByRole('menuitem', { name: 'View' })).toBe(items[1]);
  for (const item of items) {
    expect(item.hasAttribute('data-inset')).toBe(false);
    expect(item.querySelector('span[aria-hidden=true]')).toBeNull();
  }
  // The submenu's label still leads typeahead without a plain-text child.
  await typeahead('v');
  expect(document.activeElement).toBe(items[1]);
});

it('takes no icon on a submenu', async () => {
  render(
    <HeaderMenu
      label="Menu"
      items={[
        // @ts-expect-error A submenu has no icon; it would show nowhere.
        { label: 'View', choices: [], icon: <Icon /> },
        { label: 'Print', onSelect: () => {} },
      ]}
    />,
  );
  await openMenu();
  // Passed anyway (untyped code), it neither shows nor shifts the labels.
  for (const item of screen.getAllByRole('menuitem'))
    expect(item.querySelector('span[aria-hidden=true]')).toBeNull();
});

const press = async (element: Element, key: string) => {
  await act(async () => {
    fireEvent.keyDown(element, { key });
    fireEvent.keyUp(element, { key });
  });
};

it('lists a section of choices in the menu, checked, and closes on a choice', async () => {
  const list = vi.fn();
  render(
    <HeaderMenu
      label="Menu"
      items={[
        {
          label: 'View',
          display: 'section',
          choices: [
            { label: 'Zen', checked: true, onSelect: () => {} },
            { label: 'List', checked: false, onSelect: list },
          ],
        },
        null,
        { label: 'Print', onSelect: () => {} },
      ]}
    />,
  );
  await openMenu();
  // No submenu: the group is named by its heading.
  expect(screen.queryByRole('menuitem', { name: 'View' })).toBeNull();
  const group = screen.getByRole('group', { name: 'View' });
  const choices = screen.getAllByRole('menuitemradio');
  expect(choices.map((c) => group.contains(c))).toEqual([true, true]);
  expect(choices.map((c) => c.getAttribute('aria-checked'))).toEqual([
    'true',
    'false',
  ]);
  for (const c of choices) expect(c.className).toMatch(/\bmin-h-11\b/);
  await press(screen.getByRole('menuitemradio', { name: 'List' }), 'Enter');
  expect(list).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});

it('keeps an unavailable choice visible, but neither a press nor arrow keys reach it', async () => {
  const work = vi.fn();
  const archive = vi.fn();
  render(
    <HeaderMenu
      label="Menu"
      items={[
        {
          label: 'List',
          display: 'section',
          choices: [
            {
              id: 'work',
              label: 'Work',
              description: 'Can change',
              checked: true,
              onSelect: work,
            },
            {
              id: 'archive',
              label: 'Archive',
              description: 'Not available',
              checked: false,
              disabled: true,
              onSelect: archive,
            },
            {
              id: 'home',
              label: 'Home',
              description: 'Can read',
              checked: false,
              onSelect: () => {},
            },
          ],
        },
        null,
        { label: 'Share', onSelect: () => {}, disabled: true },
        { label: 'Print', onSelect: () => {} },
      ]}
    />,
  );
  await openMenu();
  const unavailable = screen.getByRole('menuitemradio', { name: 'Archive' });
  expect(unavailable.getAttribute('aria-disabled')).toBe('true');
  // The label names the choice; the second line describes it.
  const home = screen.getByRole('menuitemradio', { name: 'Home' });
  const described = home.getAttribute('aria-describedby') ?? '';
  expect(
    described
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' '),
  ).toContain('Can read');
  // Arrow keys move from Work past Archive to Home, and past Share to Print.
  const work0 = screen.getByRole('menuitemradio', { name: 'Work' });
  await act(async () => work0.focus());
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  });
  expect(document.activeElement).toBe(home);
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
  });
  expect(document.activeElement).toBe(
    screen.getByRole('menuitem', { name: 'Print' }),
  );
  expect(
    screen
      .getByRole('menuitem', { name: 'Share' })
      .getAttribute('aria-disabled'),
  ).toBe('true');
  // A press on the unavailable choice does nothing and keeps the menu open.
  await act(async () => {
    fireEvent.click(unavailable);
  });
  await press(unavailable, 'Enter');
  expect(archive).not.toHaveBeenCalled();
  expect(screen.getByRole('menu')).toBeTruthy();
});

it('disables a choice in a submenu too', async () => {
  const archive = vi.fn();
  render(
    <HeaderMenu
      label="Menu"
      items={[
        {
          label: 'List',
          choices: [
            { label: 'Work', checked: true, onSelect: () => {} },
            {
              label: 'Archive',
              checked: false,
              disabled: true,
              onSelect: archive,
            },
          ],
        },
      ]}
    />,
  );
  await openMenu();
  await act(async () => {
    fireEvent.keyDown(screen.getByRole('menuitem', { name: 'List' }), {
      key: 'ArrowRight',
    });
  });
  const unavailable = screen.getByRole('menuitemradio', { name: 'Archive' });
  expect(unavailable.getAttribute('aria-disabled')).toBe('true');
  await press(unavailable, 'Enter');
  expect(archive).not.toHaveBeenCalled();
});

it('has a quiet ghost button with the same 44px target', () => {
  render(
    <>
      <HeaderMenu label="Row menu" icon="more" variant="ghost" items={[]} />
      <HeaderMenu label="Menu" items={[]} />
    </>,
  );
  const quiet = screen.getByRole('button', { name: 'Row menu' });
  const filled = screen.getByRole('button', { name: 'Menu' });
  expect(quiet.dataset.variant).toBe('ghost');
  expect(filled.dataset.variant).toBe('secondary');
  for (const button of [quiet, filled])
    expect(button.className).toMatch(/\bsize-11\b/);
});
