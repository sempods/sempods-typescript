// @vitest-environment jsdom
/** `RemoveButton` asks with `ResourceEditor`'s dialog before it removes. */
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { RemoveButton } from './index.js';

afterEach(cleanup);
const question = 'Delete this from the pod? This cannot be undone.';

it('removes once, and only from the dialog', () => {
  const onRemove = vi.fn();
  render(<RemoveButton label="Delete: Milk" onRemove={onRemove} />);
  const button = screen.getByRole('button', { name: 'Delete: Milk' });
  // Cancel keeps everything.
  fireEvent.click(button);
  fireEvent.click(
    within(screen.getByRole('alertdialog', { name: question })).getByRole(
      'button',
      { name: 'Cancel' },
    ),
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(onRemove).not.toHaveBeenCalled();
  // The dialog's Delete removes, and the question is gone.
  fireEvent.click(button);
  const dialog = screen.getByRole('alertdialog', { name: question });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('withdraws the question when it becomes disabled, for good', () => {
  const onRemove = vi.fn();
  const view = render(<RemoveButton onRemove={onRemove} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  view.rerender(<RemoveButton disabled onRemove={onRemove} />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  view.rerender(<RemoveButton onRemove={onRemove} />);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(onRemove).not.toHaveBeenCalled();
});

it('never submits an enclosing form', () => {
  const onSubmit = vi.fn((e: { preventDefault: () => void }) =>
    e.preventDefault(),
  );
  const onRemove = vi.fn();
  render(
    <form onSubmit={onSubmit}>
      <RemoveButton onRemove={onRemove} />
    </form>,
  );
  const button = screen.getByRole('button', { name: 'Delete' });
  fireEvent.click(button);
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Cancel',
    }),
  );
  fireEvent.click(button);
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    }),
  );
  expect(onRemove).toHaveBeenCalledTimes(1);
  expect(onSubmit).not.toHaveBeenCalled();
});
