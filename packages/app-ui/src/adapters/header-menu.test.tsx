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
