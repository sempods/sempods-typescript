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
}) {
  const [value, setValue] = useState('');
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
