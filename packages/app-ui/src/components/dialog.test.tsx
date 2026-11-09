// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { SdkLocaleProvider } from '@sempods/app-sdk/react';
import { Dialog, DialogFooter, DialogTitle } from '../index.js';

afterEach(cleanup);

function Compact({
  closeLabel,
  onOpenChange = () => {},
  shouldCloseOnInteractOutside,
}: {
  readonly closeLabel?: string;
  readonly onOpenChange?: (open: boolean) => void;
  readonly shouldCloseOnInteractOutside?: (element: Element) => boolean;
}) {
  return (
    <Dialog
      isOpen
      onOpenChange={onOpenChange}
      closeLabel={closeLabel}
      shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
    >
      <DialogTitle>Rename</DialogTitle>
      <DialogFooter showCloseButton closeLabel={closeLabel} />
    </Dialog>
  );
}

/** A press beside the dialog, as React Aria listens for it. */
async function pressOutside(element: Element) {
  await act(async () => {
    fireEvent.pointerDown(element, { button: 0, pointerId: 1 });
    fireEvent.mouseDown(element, { button: 0 });
    fireEvent.pointerUp(element, { button: 0, pointerId: 1 });
    fireEvent.mouseUp(element, { button: 0 });
    fireEvent.click(element, { button: 0 });
  });
}

it('names its close buttons with the SDK text, also without a provider', () => {
  render(<Compact />);
  const dialog = screen.getByRole('dialog', { name: 'Rename' });
  expect(
    [...dialog.querySelectorAll('[data-slot=dialog-close]')].map(
      (button) => button.textContent,
    ),
  ).toEqual(['Close', 'Close']);
});

it('names its close buttons in the provider language', () => {
  render(
    <SdkLocaleProvider language="de">
      <Compact />
    </SdkLocaleProvider>,
  );
  expect(screen.getAllByRole('button', { name: 'Schließen' })).toHaveLength(2);
});

it('takes the close label it is given', () => {
  render(
    <SdkLocaleProvider language="de">
      <Compact closeLabel="Fertig" />
    </SdkLocaleProvider>,
  );
  expect(screen.getAllByRole('button', { name: 'Fertig' })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'Schließen' })).toBeNull();
});

it('closes on a press beside it unless the app filter keeps it', async () => {
  const outside = document.body.appendChild(document.createElement('p'));
  const closed = vi.fn();
  const { unmount } = render(<Compact onOpenChange={closed} />);
  await pressOutside(outside);
  expect(closed).toHaveBeenCalledWith(false);
  unmount();

  const kept = vi.fn();
  const filter = vi.fn((element: Element) => element !== outside);
  render(<Compact onOpenChange={kept} shouldCloseOnInteractOutside={filter} />);
  await pressOutside(outside);
  expect(filter).toHaveBeenCalledWith(outside);
  expect(kept).not.toHaveBeenCalled();
  outside.remove();
});
