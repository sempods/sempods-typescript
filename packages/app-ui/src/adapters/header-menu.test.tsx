// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
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
