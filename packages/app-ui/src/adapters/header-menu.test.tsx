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
  // Typeahead follows the label, not the icon.
  await act(async () => {
    fireEvent.keyDown(document.activeElement!, { key: 'p' });
  });
  expect(document.activeElement).toBe(pods);
  await act(async () => {
    fireEvent.keyDown(pods, { key: 'Enter' });
    fireEvent.keyUp(pods, { key: 'Enter' });
  });
  expect(manage).toHaveBeenCalledOnce();
});

it('renders text-only menus as before, without inset rows', async () => {
  render(
    <HeaderMenu
      label="Menu"
      items={[
        { label: 'View', choices: [] },
        { label: 'Print', onSelect: () => {} },
      ]}
    />,
  );
  await openMenu();
  for (const item of screen.getAllByRole('menuitem')) {
    expect(item.hasAttribute('data-inset')).toBe(false);
    expect(item.querySelector('span[aria-hidden=true]')).toBeNull();
  }
});

it('takes no icon on a submenu', () => {
  render(
    <HeaderMenu
      items={[
        // @ts-expect-error A submenu has no icon; it would show nowhere.
        { label: 'View', choices: [], icon: <Icon /> },
      ]}
    />,
  );
});
