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

it('confirms the action it asked about, not a newer one', () => {
  const asked = vi.fn();
  const newer = vi.fn();
  const view = render(<RemoveButton onRemove={asked} />);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
  // The row read again meanwhile: its callback now holds a newer snapshot.
  view.rerender(<RemoveButton onRemove={newer} />);
  fireEvent.click(
    within(screen.getByRole('alertdialog')).getByRole('button', {
      name: 'Delete',
    }),
  );
  expect(asked).toHaveBeenCalledTimes(1);
  expect(newer).not.toHaveBeenCalled();
});

it('is a named trash icon by default; children replace it', () => {
  const view = render(<RemoveButton onRemove={() => {}} />);
  const icon = screen.getByRole('button', { name: 'Delete' });
  expect(icon.title).toBe('Delete');
  expect(icon.querySelector('svg')).toBeTruthy();
  view.rerender(<RemoveButton label="Delete: Milk" onRemove={() => {}} />);
  expect(screen.getByRole('button', { name: 'Delete: Milk' }).title).toBe(
    'Delete: Milk',
  );
  // No content, null included, still means the named icon.
  view.rerender(<RemoveButton onRemove={() => {}}>{null}</RemoveButton>);
  expect(screen.getByRole('button', { name: 'Delete' }).title).toBe('Delete');
  view.rerender(<RemoveButton onRemove={() => {}}>Remove it</RemoveButton>);
  const text = screen.getByRole('button', { name: 'Remove it' });
  expect(text.hasAttribute('title')).toBe(false);
  expect(text.querySelector('svg')).toBeNull();
});
