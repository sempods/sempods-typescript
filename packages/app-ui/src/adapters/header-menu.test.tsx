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
const Icon = () => <svg data-testid="icon" />;

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
  expect(items.map((item) => item.textContent)).toEqual([
    'List',
    'View',
    'Pods & sharing',
    'Print',
  ]);
  const pods = screen.getByRole('menuitem', { name: 'Pods & sharing' });
  const icon = pods.querySelector('[data-testid=icon]')!;
  expect(icon.closest('[aria-hidden=true]')?.parentElement).toBe(pods);
  // Rows without an icon leave its column: the submenu and the plain action.
  expect(items.map((item) => item.hasAttribute('data-inset'))).toEqual([
    false,
    true,
    false,
    true,
  ]);
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
    expect(item.querySelector('[aria-hidden=true] svg')).toBeNull();
  }
});
