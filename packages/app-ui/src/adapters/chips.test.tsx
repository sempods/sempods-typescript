// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import type { Key } from 'react-aria-components';
import { Chip, ChipGroup } from './chips.js';
import { ActionGroup, ActionLink } from './action-button.js';

afterEach(cleanup);

function Filter({ mode }: { readonly mode: 'single' | 'multiple' }) {
  const [selected, setSelected] = useState(new Set<Key>(['open']));
  return (
    <ChipGroup
      label="Filter"
      selectionMode={mode}
      selectedKeys={selected}
      onSelectionChange={setSelected}
    >
      <Chip id="open">Open</Chip>
      <Chip id="done">Done</Chip>
    </ChipGroup>
  );
}

const marks = () =>
  document.querySelectorAll('[data-slot=toggle-group-item] svg');

it('marks selected chips in a multiple selection', async () => {
  render(<Filter mode="multiple" />);
  expect(screen.getByRole('toolbar', { name: 'Filter' })).toBeTruthy();
  const done = screen.getByRole('button', { name: 'Done' });
  expect(done.getAttribute('aria-pressed')).toBe('false');
  expect(marks()).toHaveLength(1);
  await act(async () => {
    fireEvent.click(done);
  });
  expect(done.getAttribute('aria-pressed')).toBe('true');
  expect(marks()).toHaveLength(2);
});

it('marks the one chosen chip in a single selection', async () => {
  render(<Filter mode="single" />);
  expect(screen.getByRole('radiogroup', { name: 'Filter' })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'Done' }));
  });
  const checked = screen
    .getAllByRole('radio')
    .map((chip) => chip.getAttribute('aria-checked'));
  expect(checked).toEqual(['false', 'true']);
  expect(marks()).toHaveLength(1);
});

it('groups actions under a name and keeps links real', () => {
  render(
    <ActionGroup label="Task actions">
      <ActionLink variant="secondary" href="/tasks/1/postpone">
        Not today
      </ActionLink>
    </ActionGroup>,
  );
  const link = screen.getByRole('link', { name: 'Not today' });
  expect(link.getAttribute('href')).toBe('/tasks/1/postpone');
  expect(link.dataset.shape).toBe('pill');
  expect(screen.getByRole('group', { name: 'Task actions' })).toBeTruthy();
});
