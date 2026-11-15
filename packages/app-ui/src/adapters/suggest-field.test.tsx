// @vitest-environment jsdom
import { createRef, useState, type Ref } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { SuggestField, type Suggestion } from './suggest-field.js';

afterEach(cleanup);

const alice: Suggestion = {
  id: 'https://pod.example/alice#me',
  label: 'Alice',
  detail: 'https://pod.example/alice#me',
  source: 'Work',
};
const bob: Suggestion = {
  id: 'https://pod.example/bob#me',
  label: 'Bob',
  detail: 'https://pod.example/bob#me',
};

function Field(props: {
  readonly items?: readonly Suggestion[];
  readonly loading?: boolean;
  readonly failed?: 'some' | 'all';
  readonly onSelect?: (item: Suggestion) => void;
  readonly onSubmit?: (value: string) => void;
  /** Whether the field suggests, or which text it suggests for. */
  readonly suggest?: boolean | ((value: string) => boolean);
  readonly inputRef?: Ref<HTMLInputElement>;
}) {
  const [value, setValue] = useState('');
  const suggest =
    typeof props.suggest === 'function' ? props.suggest(value) : props.suggest;
  return (
    <SuggestField
      label="Address or search"
      value={value}
      onChange={setValue}
      items={props.items ?? []}
      loading={props.loading}
      failed={props.failed}
      onSelect={props.onSelect ?? (() => {})}
      onSubmit={props.onSubmit}
      suggest={suggest}
      ref={props.inputRef}
    />
  );
}

const input = () => screen.getByRole('combobox', { name: 'Address or search' });

async function type(text: string) {
  await act(async () => {
    input().focus();
    fireEvent.change(input(), { target: { value: text } });
  });
}

async function key(name: string, init: Record<string, unknown> = {}) {
  await act(async () => {
    fireEvent.keyDown(input(), { key: name, ...init });
  });
}

const active = () => {
  const id = input().getAttribute('aria-activedescendant');
  return id ? document.getElementById(id)?.textContent : undefined;
};

it('chooses the active suggestion with Enter, not the typed text', async () => {
  const onSelect = vi.fn();
  const onSubmit = vi.fn();
  render(
    <Field items={[alice, bob]} onSelect={onSelect} onSubmit={onSubmit} />,
  );
  await type('al');
  expect(screen.getAllByRole('option')).toHaveLength(2);
  await key('ArrowDown');
  expect(active()).toContain('Alice');
  await key('Enter');
  expect(onSelect).toHaveBeenCalledWith(alice);
  expect(onSubmit).not.toHaveBeenCalled();
});

it('submits the typed text with Enter when no suggestion is active', async () => {
  const onSelect = vi.fn();
  const onSubmit = vi.fn();
  render(<Field items={[alice]} onSelect={onSelect} onSubmit={onSubmit} />);
  await type('  https://pod.example/carol  ');
  await key('Enter');
  expect(onSubmit).toHaveBeenCalledWith('https://pod.example/carol');
  expect(onSelect).not.toHaveBeenCalled();
});

it('does not submit while an input method composes text', async () => {
  const onSubmit = vi.fn();
  render(<Field onSubmit={onSubmit} />);
  await type('にほ');
  await key('Enter', { isComposing: true });
  await key('Enter', { keyCode: 229 });
  expect(onSubmit).not.toHaveBeenCalled();
});

it('keeps the active suggestion when the results reorder', async () => {
  const { rerender } = render(<Field items={[alice, bob]} />);
  await type('a');
  await key('ArrowDown');
  await key('ArrowDown');
  expect(active()).toContain('Bob');
  await act(async () => {
    rerender(<Field items={[bob, alice]} />);
  });
  expect(active()).toContain('Bob');
});

it('announces a running, an empty, a partial and a failed search', async () => {
  const { rerender } = render(<Field loading />);
  const status = () => screen.getByRole('status').textContent;
  expect(status()).toBe('');
  await type('x');
  expect(status()).toBe('Searching …');
  await act(async () => {
    rerender(<Field />);
  });
  expect(status()).toBe('No suggestions.');
  await act(async () => {
    rerender(<Field items={[alice]} loading failed="some" />);
  });
  expect(status()).toBe(
    '1 suggestion. Searching for more … Some sources could not be searched.',
  );
  await act(async () => {
    rerender(<Field failed="all" />);
  });
  expect(status()).toBe('The search failed.');
});

it('shows the exact value and the source with the label', async () => {
  render(<Field items={[alice]} />);
  await type('a');
  const option = screen.getByRole('option');
  expect(option.textContent).toContain('https://pod.example/alice#me');
  expect(option.textContent).toContain('Work');
  expect(option.getAttribute('aria-labelledby')).toBeTruthy();
});

it('calls the latest onSelect for suggestions it keeps across a rerender', async () => {
  const first = vi.fn();
  const latest = vi.fn();
  const items = [alice, bob];
  const { rerender } = render(<Field items={items} onSelect={first} />);
  await type('al');
  // The same suggestion objects, a new handler with the app's newer state.
  rerender(<Field items={items} onSelect={latest} />);
  await key('ArrowDown');
  await key('Enter');
  expect(latest).toHaveBeenCalledWith(alice);
  expect(first).not.toHaveBeenCalled();
});

/** As an address bar decides: no search for an address or one character. */
const searchable = (value: string) =>
  !URL.canParse(value.trim()) && value.trim().length >= 2;

it('neither suggests nor announces for text the app does not search', async () => {
  const onSubmit = vi.fn();
  render(<Field suggest={searchable} onSubmit={onSubmit} />);
  const status = () => screen.getByRole('status').textContent;
  const field = input();
  await type('https://pod.example/carol');
  await key('ArrowDown');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(field.getAttribute('aria-expanded')).toBe('false');
  expect(status()).toBe('');
  await key('Enter', { isComposing: true });
  expect(onSubmit).not.toHaveBeenCalled();
  await key('Enter');
  expect(onSubmit).toHaveBeenCalledWith('https://pod.example/carol');
  await type('c');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(status()).toBe('');
  // A searchable text suggests again, in the same input.
  await type('ca');
  expect(screen.getByRole('listbox')).toBeTruthy();
  expect(status()).toBe('No suggestions.');
  expect(input()).toBe(field);
  expect(document.activeElement).toBe(field);
});

it('ignores loading and failed searches while it does not suggest', async () => {
  const { rerender } = render(
    <Field suggest={false} items={[alice]} loading failed="some" />,
  );
  await type('al');
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('');
  await act(async () => {
    rerender(<Field suggest={false} failed="all" />);
  });
  expect(screen.getByRole('status').textContent).toBe('');
});

it('opens and closes the suggestions as the field starts and stops suggesting', async () => {
  const onSelect = vi.fn();
  const { rerender } = render(
    <Field suggest={false} items={[alice]} onSelect={onSelect} />,
  );
  const field = input();
  await type('al');
  expect(screen.queryByRole('listbox')).toBeNull();
  // The app's search starts for the typed text without another key.
  await act(async () => {
    rerender(<Field items={[alice]} onSelect={onSelect} />);
  });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  expect(screen.getByRole('status').textContent).toBe('1 suggestion.');
  await act(async () => {
    rerender(<Field suggest={false} items={[alice]} onSelect={onSelect} />);
  });
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(screen.getByRole('status').textContent).toBe('');
  await act(async () => {
    rerender(<Field items={[alice]} onSelect={onSelect} />);
  });
  await key('ArrowDown');
  await key('Enter');
  expect(onSelect).toHaveBeenCalledWith(alice);
  expect(input()).toBe(field);
});

it('gives the app its input through ref, to focus and select it', async () => {
  const ref = createRef<HTMLInputElement>();
  render(<Field inputRef={ref} />);
  await type('https://pod.example/carol');
  expect(ref.current).toBe(input());
  act(() => {
    ref.current?.blur();
    ref.current?.focus();
    ref.current?.select();
  });
  expect(document.activeElement).toBe(input());
  expect(ref.current?.selectionStart).toBe(0);
  expect(ref.current?.selectionEnd).toBe('https://pod.example/carol'.length);
});
