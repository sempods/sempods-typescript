// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { SdkLocaleProvider } from '@sempods/app-sdk/react';
import { MarkdownField, type MarkdownFieldProps } from './markdown-field.js';

afterEach(cleanup);

/** The field in a form as an app has it: the draft holds the source as typed. */
function Notes(
  props: Partial<MarkdownFieldProps> & {
    readonly initial?: string;
    readonly changed?: (value: string) => void;
  },
) {
  const { initial = '', changed, ...rest } = props;
  const [value, setValue] = useState(initial);
  return (
    <>
      <MarkdownField
        label="Notes"
        value={value}
        onChange={(source) => {
          changed?.(source);
          setValue(source);
        }}
        {...rest}
      />
      <output data-testid="draft">{JSON.stringify(value)}</output>
    </>
  );
}

const draft = () => JSON.parse(screen.getByTestId('draft').textContent ?? '');
const text = () => screen.getByRole<HTMLTextAreaElement>('textbox');
const button = (name: string) => screen.getByRole('button', { name });

it('opens populated text rendered, with a labelled edit action', () => {
  const changed = vi.fn();
  render(<Notes initial={'# Plan\n\nBuy **milk**'} changed={changed} />);
  expect(screen.getByRole('group', { name: 'Notes' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Plan' })).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(button('Edit text')).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
});

it('moves the focus into the text to edit and back to its action to preview', () => {
  const changed = vi.fn();
  const source = '  indented\n\nline with a hard break  \nnext';
  render(<Notes initial={source} changed={changed} />);
  const toggle = button('Edit text');
  fireEvent.click(toggle);
  expect(document.activeElement).toBe(text());
  expect(text().value).toBe(source);
  expect(toggle.getAttribute('aria-label')).toBe('Preview');
  fireEvent.click(toggle);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute('aria-label')).toBe('Edit text');
  // Switching back and forth leaves the draft as it was.
  for (let i = 0; i < 5; i++) fireEvent.click(toggle);
  expect(changed).not.toHaveBeenCalled();
  expect(draft()).toBe(source);
});

it('keeps the same text input across a preview, so undo survives it', () => {
  render(<Notes initial="Some text" />);
  const toggle = button('Edit text');
  fireEvent.click(toggle);
  const input = text();
  fireEvent.click(toggle);
  // Hidden while reading: neither shown nor reachable.
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(input.isConnected).toBe(true);
  expect(input.closest('[inert]')).not.toBeNull();
  fireEvent.click(toggle);
  expect(text()).toBe(input);
  expect(document.activeElement).toBe(input);
});

it('offers Add text for an empty field and starts writing there', () => {
  render(<Notes />);
  const add = button('Add text');
  expect(add.textContent).toBe('Add text');
  fireEvent.click(add);
  expect(document.activeElement).toBe(text());
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy();
});

it('starts writing when asked to', () => {
  render(<Notes defaultPresentation="write" placeholder="Details …" />);
  expect(text().getAttribute('aria-label')).toBe('Notes');
  expect(text().placeholder).toBe('Details …');
  expect(document.activeElement).not.toBe(text());
  const actions = screen
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
  expect(actions).toEqual([
    'Heading',
    'Bold',
    'Italic',
    'Bulleted list',
    'Numbered list',
    'Link',
    'Preview',
  ]);
});

it('shows read-only text without an action, and nothing without text', () => {
  const { rerender } = render(
    <MarkdownField
      label="Notes"
      value="Some *text*"
      onChange={() => {}}
      readOnly
    />,
  );
  expect(screen.queryByRole('button')).toBeNull();
  expect(screen.getByRole('group', { name: 'Notes' }).textContent).toContain(
    'Some text',
  );
  rerender(
    <MarkdownField label="Notes" value="  " onChange={() => {}} readOnly />,
  );
  expect(screen.queryByRole('group')).toBeNull();
});

it('passes the source as typed and shows the value it gets', () => {
  const changed = vi.fn();
  render(<Notes defaultPresentation="write" changed={changed} />);
  fireEvent.change(text(), { target: { value: '    ' } });
  expect(draft()).toBe('    ');
  fireEvent.change(text(), { target: { value: '    code\n' } });
  expect(draft()).toBe('    code\n');
  expect(changed.mock.calls.map(([v]) => v)).toEqual(['    ', '    code\n']);
});

it('shows exactly the value when the app replaces the draft', () => {
  const { rerender } = render(
    <MarkdownField
      label="Notes"
      value=""
      onChange={() => {}}
      defaultPresentation="write"
    />,
  );
  fireEvent.change(text(), { target: { value: '    ' } });
  // The app keeps no text for spaces, then loads another draft and clears it.
  expect(text().value).toBe('');
  for (const value of ['loaded', ''])
    rerender(
      <MarkdownField
        label="Notes"
        value={value}
        onChange={() => {}}
        defaultPresentation="write"
      />,
    );
  expect(text().value).toBe('');
});

it('disables an action whose effect the selection makes unpredictable', async () => {
  render(<Notes initial="Run `npm test` now" defaultPresentation="write" />);
  text().setSelectionRange(9, 13);
  fireEvent.select(text());
  await waitFor(() =>
    expect(button('Bold').hasAttribute('disabled')).toBe(true),
  );
  expect(button('Link').hasAttribute('disabled')).toBe(true);
  // The shortcut does nothing there either.
  fireEvent.keyDown(text(), { key: 'b', ctrlKey: true });
  expect(draft()).toBe('Run `npm test` now');
  text().setSelectionRange(0, 3);
  fireEvent.select(text());
  await waitFor(() =>
    expect(button('Bold').hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(button('Bold'));
  expect(draft()).toBe('**Run** `npm test` now');
});

it('keeps link addresses and code as the preview shows them', () => {
  const source = 'Get [data](https://example.org/a*b*c) and `**glob**` now';
  render(<Notes initial={source} />);
  const rendered = () => ({
    links: [...document.querySelectorAll('a')].map((a) => a.href),
    code: [...document.querySelectorAll('code')].map((c) => c.textContent),
  });
  const before = rendered();
  fireEvent.click(button('Edit text'));
  text().setSelectionRange(0, source.length);
  fireEvent.click(button('Italic'));
  fireEvent.click(button('Preview'));
  expect(draft()).toBe('*' + source + '*');
  expect(document.querySelector('em')).not.toBeNull();
  expect(rendered()).toEqual(before);
  expect(before.links).toEqual(['https://example.org/a*b*c']);
});

it('shows the preview beside the source only in a wide field', () => {
  render(<Notes initial="Some **text**" defaultPresentation="write" />);
  // jsdom lays nothing out: the field has no width.
  expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  cleanup();
  const width = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 800 } as DOMRect);
  try {
    render(<Notes initial="Some **text**" defaultPresentation="write" />);
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview.querySelector('strong')?.textContent).toBe('text');
    act(() => fireEvent.click(button('Preview')));
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  } finally {
    width.mockRestore();
  }
});

it('formats the selection from the toolbar and keeps it selected', () => {
  render(<Notes initial="Buy milk today" defaultPresentation="write" />);
  text().setSelectionRange(4, 8);
  fireEvent.click(button('Bold'));
  expect(draft()).toBe('Buy **milk** today');
  expect([text().selectionStart, text().selectionEnd]).toEqual([6, 10]);
  expect(document.activeElement).toBe(text());
  fireEvent.click(button('Bold'));
  expect(draft()).toBe('Buy milk today');
  text().setSelectionRange(0, 0);
  fireEvent.click(button('Bulleted list'));
  expect(draft()).toBe('- Buy milk today');
});

it('formats with Ctrl+B, I and K and leaves other keys to the input', () => {
  render(<Notes initial="a word" defaultPresentation="write" />);
  text().setSelectionRange(2, 6);
  fireEvent.keyDown(text(), { key: 'b', ctrlKey: true });
  expect(draft()).toBe('a **word**');
  fireEvent.keyDown(text(), { key: 'i', ctrlKey: true });
  expect(draft()).toBe('a ***word***');
  // Shift or Alt with the key, and Tab, are not the field's.
  for (const key of [
    { key: 'B', ctrlKey: true, shiftKey: true },
    { key: 'k', ctrlKey: true, altKey: true },
    { key: 'Tab' },
  ])
    expect(fireEvent.keyDown(text(), key)).toBe(true);
  expect(draft()).toBe('a ***word***');
  fireEvent.keyDown(text(), { key: 'k', ctrlKey: true });
  expect(draft()).toBe('a ***[word](https://)***');
});

it('names its actions in the provider language, and takes the app’s labels', () => {
  render(
    <SdkLocaleProvider locale="de-DE" timeZone="Europe/Berlin">
      <Notes initial="Text" labels={{ edit: 'Notiz bearbeiten' }} />
    </SdkLocaleProvider>,
  );
  fireEvent.click(button('Notiz bearbeiten'));
  expect(screen.getByRole('toolbar', { name: 'Formatierung' })).toBeTruthy();
  expect(button('Fett')).toBeTruthy();
  expect(button('Vorschau')).toBeTruthy();
});
