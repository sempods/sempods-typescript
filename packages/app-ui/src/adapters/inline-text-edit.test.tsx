// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  InlineTextEdit,
  type InlineTextEditProps,
} from './inline-text-edit.js';

afterEach(cleanup);

/** Lets the field's deferred focus decision run. */
const landed = () => act(() => new Promise((done) => setTimeout(done, 0)));

function Field(
  props: Partial<InlineTextEditProps> & {
    readonly onEnclosingKey?: () => void;
  },
) {
  const [value, setValue] = useState('Milk');
  const { onEnclosingKey, ...rest } = props;
  return (
    <div onKeyDown={onEnclosingKey}>
      <InlineTextEdit
        label="Rename: Milk"
        value={value}
        onChange={setValue}
        onSave={() => {}}
        onCancel={() => {}}
        onDismiss={() => {}}
        {...rest}
      />
      <button type="button">Outside</button>
    </div>
  );
}

it('keeps Escape from an enclosing dialog and cancels', () => {
  const onCancel = vi.fn();
  const onEnclosingKey = vi.fn();
  render(<Field onCancel={onCancel} onEnclosingKey={onEnclosingKey} />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onEnclosingKey).not.toHaveBeenCalled();
});

it('neither saves nor cancels while pending, nor saves while read-only', () => {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const { rerender } = render(
    <Field onSave={onSave} onCancel={onCancel} pending />,
  );
  const input = screen.getByRole('textbox');
  fireEvent.keyDown(input, { key: 'Enter' });
  fireEvent.keyDown(input, { key: 'Escape' });
  rerender(<Field onSave={onSave} onCancel={onCancel} readOnly />);
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(onSave).not.toHaveBeenCalled();
  expect(onCancel).not.toHaveBeenCalled();
});

it('does not dismiss when the window loses the focus', async () => {
  const onDismiss = vi.fn();
  render(<Field onDismiss={onDismiss} />);
  const input = screen.getByRole('textbox');
  expect(document.activeElement).toBe(input);
  // The window blurs: the element is told, but stays the active element.
  fireEvent.blur(input, { relatedTarget: null });
  await landed();
  expect(onDismiss).not.toHaveBeenCalled();
});

it('dismisses once for a press beside it and the focus that follows', async () => {
  const onDismiss = vi.fn();
  render(<Field onDismiss={onDismiss} />);
  const outside = screen.getByRole('button', { name: 'Outside' });
  fireEvent.pointerDown(outside);
  act(() => outside.focus());
  await landed();
  expect(onDismiss).toHaveBeenCalledOnce();
});

it('takes the focus back from a control that drops it', async () => {
  const onDismiss = vi.fn();
  render(<Field onDismiss={onDismiss} />);
  const cancel = screen.getByRole('button', { name: 'Cancel' });
  act(() => cancel.focus());
  // A focused control becomes disabled: the focus falls to the body.
  cancel.setAttribute('disabled', '');
  act(() => cancel.blur());
  await landed();
  expect(onDismiss).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('textbox'));
});

it('returns the focus only when it closes while holding it', async () => {
  const returnFocus = vi.fn();
  const { rerender } = render(<Field returnFocus={returnFocus} />);
  rerender(<button type="button">Trigger</button>);
  await landed();
  expect(returnFocus).toHaveBeenCalledOnce();

  rerender(<Field returnFocus={returnFocus} />);
  act(() => screen.getByRole('button', { name: 'Outside' }).focus());
  await landed();
  rerender(<button type="button">Trigger</button>);
  await landed();
  expect(returnFocus).toHaveBeenCalledOnce();
});

it('dismisses a departure during a pending write once it has settled', async () => {
  const onDismiss = vi.fn();
  const { rerender } = render(<Field onDismiss={onDismiss} pending />);
  act(() => screen.getByRole('button', { name: 'Outside' }).focus());
  await landed();
  expect(onDismiss).not.toHaveBeenCalled();
  rerender(<Field onDismiss={onDismiss} />);
  await landed();
  expect(onDismiss).toHaveBeenCalledOnce();
});
