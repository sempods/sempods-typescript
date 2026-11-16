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
import { Checkbox } from './checkbox.js';

afterEach(cleanup);

function Row({ onChange }: { readonly onChange?: (done: boolean) => void }) {
  const [done, setDone] = useState(false);
  return (
    <Checkbox
      aria-label="Done: Buy milk"
      isSelected={done}
      onChange={(next) => {
        setDone(next);
        onChange?.(next);
      }}
    />
  );
}

it('is named by aria-label and ticks with a press and with Space', async () => {
  const changes = vi.fn();
  render(<Row onChange={changes} />);
  const box = screen.getByRole('checkbox', { name: 'Done: Buy milk' });
  expect((box as HTMLInputElement).checked).toBe(false);
  fireEvent.click(box);
  expect((box as HTMLInputElement).checked).toBe(true);
  await act(async () => {
    fireEvent.keyDown(box, { key: ' ' });
    fireEvent.keyUp(box, { key: ' ' });
    fireEvent.click(box);
  });
  expect(changes.mock.calls.map(([next]) => next)).toEqual([true, false]);
});

it('shows a check mark only while selected, and a dash while indeterminate', () => {
  const { rerender } = render(<Checkbox aria-label="Done" isSelected />);
  const slot = () =>
    document.querySelector('[data-slot="checkbox-indicator"]')!;
  expect(slot().querySelector('svg')).not.toBeNull();
  expect(slot().querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  rerender(<Checkbox aria-label="Done" isSelected={false} />);
  expect(slot().querySelector('svg')).toBeNull();
  rerender(<Checkbox aria-label="Done" isIndeterminate />);
  expect(slot().querySelector('svg')).not.toBeNull();
  expect(
    (screen.getByRole('checkbox', { name: 'Done' }) as HTMLInputElement)
      .indeterminate,
  ).toBe(true);
});

// A press on a disabled box is checked in the browser (UI gate `checkbox`);
// jsdom dispatches clicks on disabled inputs.
it('is disabled for assistive technology and styling', () => {
  render(<Checkbox aria-label="Done" isDisabled isSelected />);
  const box = screen.getByRole('checkbox', { name: 'Done' });
  expect((box as HTMLInputElement).disabled).toBe(true);
  expect(
    box.closest('[data-slot="checkbox"]')!.hasAttribute('data-disabled'),
  ).toBe(true);
});

it('can be named by visible text beside it', () => {
  render(
    <>
      <Checkbox aria-labelledby="remember" />
      <span id="remember">Remember this device</span>
    </>,
  );
  expect(
    screen.getByRole('checkbox', { name: 'Remember this device' }),
  ).toBeTruthy();
});
