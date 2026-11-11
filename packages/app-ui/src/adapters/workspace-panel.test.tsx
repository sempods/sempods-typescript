// @vitest-environment jsdom
import { createRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { WorkspacePanel } from './workspace-panel.js';

afterEach(cleanup);

function Workspace({
  autoFocus,
  onRequestClose,
}: {
  readonly autoFocus?: boolean;
  readonly onRequestClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <canvas aria-label="Graph" tabIndex={0} />
      <button onClick={() => setOpen((o) => !o)}>Filters</button>
      <WorkspacePanel
        title="Filters"
        open={open}
        autoFocus={autoFocus}
        onRequestClose={() => {
          onRequestClose?.();
          setOpen(false);
        }}
      >
        <label>
          <input type="checkbox" /> Tasks
        </label>
      </WorkspacePanel>
    </>
  );
}

const toggle = () => screen.getByRole('button', { name: 'Filters' });
const region = () => screen.queryByRole('region', { name: 'Filters' });

async function press(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
}

it('is a named region that takes the focus and gives it back on Close', async () => {
  render(<Workspace />);
  expect(region()).toBeNull();
  toggle().focus();
  await press(toggle());
  expect(region()).not.toBeNull();
  expect(document.activeElement).toBe(region());
  expect(region()!.querySelector('h2')!.textContent).toBe('Filters');
  await press(screen.getByRole('button', { name: 'Close' }));
  expect(region()).toBeNull();
  expect(document.activeElement).toBe(toggle());
});

it('closes on Escape inside it, not outside it', async () => {
  const closed = vi.fn();
  render(<Workspace onRequestClose={closed} />);
  toggle().focus();
  await press(toggle());
  const canvas = screen.getByLabelText('Graph');
  // Focus in the workspace: Escape belongs to it.
  canvas.focus();
  await act(async () => {
    fireEvent.keyDown(canvas, { key: 'Escape' });
  });
  expect(closed).not.toHaveBeenCalled();
  expect(region()).not.toBeNull();
  const box = screen.getByRole('checkbox', { name: 'Tasks' });
  box.focus();
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Escape' });
  });
  expect(closed).toHaveBeenCalledTimes(1);
  expect(region()).toBeNull();
  expect(document.activeElement).toBe(toggle());
});

it('leaves an Escape that something inside handled, or an IME composition', async () => {
  const closed = vi.fn();
  render(<Workspace onRequestClose={closed} />);
  toggle().focus();
  await press(toggle());
  const box = screen.getByRole('checkbox', { name: 'Tasks' });
  box.addEventListener('keydown', (event) => event.preventDefault());
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Escape' });
  });
  await act(async () => {
    fireEvent.keyDown(region()!, { key: 'Escape', isComposing: true });
  });
  expect(closed).not.toHaveBeenCalled();
});

it('keeps focus the person moved to the workspace when it closes', async () => {
  render(<Workspace />);
  toggle().focus();
  await press(toggle());
  const canvas = screen.getByLabelText('Graph');
  canvas.focus();
  // Closed from outside (a click in jsdom moves no focus).
  await press(toggle());
  expect(region()).toBeNull();
  expect(document.activeElement).toBe(canvas);
});

it('stays where the focus is without autoFocus', async () => {
  render(<Workspace autoFocus={false} />);
  toggle().focus();
  await press(toggle());
  expect(region()).not.toBeNull();
  expect(document.activeElement).toBe(toggle());
});

it('returns the focus to focusTarget and takes another close label', async () => {
  const target = createRef<HTMLButtonElement>();
  function Panel() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button ref={target}>Toolbar</button>
        <WorkspacePanel
          title="Details"
          open={open}
          closeLabel="Hide details"
          focusTarget={target}
          headingLevel={3}
          side="start"
          onRequestClose={() => setOpen(false)}
        >
          <p>Text</p>
        </WorkspacePanel>
      </>
    );
  }
  render(<Panel />);
  const details = screen.getByRole('region', { name: 'Details' });
  expect(details.dataset.side).toBe('start');
  expect(details.querySelector('h3')).not.toBeNull();
  await press(screen.getByRole('button', { name: 'Hide details' }));
  expect(screen.queryByRole('region', { name: 'Details' })).toBeNull();
  expect(document.activeElement).toBe(target.current);
});
