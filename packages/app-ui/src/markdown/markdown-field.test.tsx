// @vitest-environment jsdom
import { useEffect, useState } from 'react';
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
/** The rich editor, once it is loaded. */
const editor = () => screen.findByRole('textbox', {}, { timeout: 5000 });

// jsdom lays nothing out; ProseMirror measures the selection to scroll to it.
Range.prototype.getClientRects = () =>
  ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: [][Symbol.iterator],
  }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
document.elementFromPoint = () => null;

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
  // Code: written as Markdown, in the text input.
  const source = '    code\n\nline with a hard break  \nnext';
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
  render(<Notes initial="Run `npm test`" />);
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

it('offers Add text for an empty field and starts writing there', async () => {
  render(<Notes />);
  const add = button('Add text');
  expect(add.textContent).toBe('Add text');
  fireEvent.click(add);
  const input = await editor();
  await waitFor(() =>
    expect(input.contains(document.activeElement)).toBe(true),
  );
  expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeTruthy();
});

it('starts writing when asked to', async () => {
  render(<Notes defaultPresentation="write" placeholder="Details …" />);
  const input = await editor();
  expect(input.getAttribute('aria-label')).toBe('Notes');
  expect(
    input.querySelector('[data-placeholder]')?.getAttribute('data-placeholder'),
  ).toBe('Details …');
  expect(input.contains(document.activeElement)).toBe(false);
  const actions = screen
    .getAllByRole('button')
    .map((b) => b.getAttribute('aria-label'));
  expect(actions).toEqual([
    'Heading',
    'Subheading',
    'Bold',
    'Italic',
    'Strikethrough',
    'Bulleted list',
    'Numbered list',
    'Link',
    'Undo',
    'Redo',
    'Preview',
  ]);
});

it('writes text in its set formatted and reports it as Markdown', async () => {
  const changed = vi.fn();
  render(
    <Notes
      initial="Buy **milk**"
      defaultPresentation="write"
      changed={changed}
    />,
  );
  const input = await editor();
  expect(input.querySelector('strong')?.textContent).toBe('milk');
  expect(input.textContent).not.toContain('*');
  await waitFor(() =>
    expect(button('Undo').hasAttribute('disabled')).toBe(true),
  );
  fireEvent.click(button('Bulleted list'));
  expect(draft()).toBe('- Buy **milk**');
  expect(button('Bulleted list').getAttribute('aria-pressed')).toBe('true');
  await waitFor(() =>
    expect(button('Undo').hasAttribute('disabled')).toBe(false),
  );
  fireEvent.click(button('Undo'));
  expect(draft()).toBe('Buy **milk**');
  expect(changed.mock.calls.map(([v]) => v)).toEqual([
    '- Buy **milk**',
    'Buy **milk**',
  ]);
});

it('writes nothing for opening and switching, though it would write it differently', async () => {
  const changed = vi.fn();
  const source = '_a_ and __b__\nc';
  render(<Notes initial={source} changed={changed} />);
  fireEvent.click(button('Edit text'));
  await editor();
  for (let i = 0; i < 4; i++)
    fireEvent.click(
      screen.getByRole('button', { name: /^(Preview|Edit text)$/ }),
    );
  expect(changed).not.toHaveBeenCalled();
  expect(draft()).toBe(source);
});

it('takes a new value from the app into the editor, or to Markdown', async () => {
  const changed = vi.fn();
  const field = (value: string) => (
    <MarkdownField
      label="Notes"
      value={value}
      onChange={changed}
      defaultPresentation="write"
    />
  );
  const { rerender } = render(field('First'));
  const input = await editor();
  rerender(field('Other **text**'));
  await waitFor(() =>
    expect(input.querySelector('strong')?.textContent).toBe('text'),
  );
  // A text with code from now on: the text input, with a note why.
  rerender(field('Run `npm test`'));
  expect(text().value).toBe('Run `npm test`');
  expect(screen.getByText(/so you edit it as Markdown/)).toBeTruthy();
  expect(changed).not.toHaveBeenCalled();
});

it('sets a link from Ctrl+K without submitting the form around the field', async () => {
  const submit = vi.fn((event: { preventDefault(): void }) =>
    event.preventDefault(),
  );
  render(
    <form onSubmit={submit}>
      <Notes initial="Buy milk" defaultPresentation="write" />
    </form>,
  );
  const input = await editor();
  fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
  const address = screen.getByRole('textbox', { name: 'Link address' });
  expect(document.activeElement).toBe(address);
  expect(address.closest('form')).toBe(input.closest('form'));
  fireEvent.change(address, { target: { value: 'https://shop.example' } });
  fireEvent.keyDown(address, { key: 'Enter' });
  expect(submit).not.toHaveBeenCalled();
  expect(draft()).toBe('<https://shop.example>Buy milk');
  expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull();
});

it('decides the writer again for a value the app restores', async () => {
  const field = (value: string) => (
    <MarkdownField
      label="Notes"
      value={value}
      onChange={() => {}}
      defaultPresentation="write"
    />
  );
  const { rerender } = render(field('`x`'));
  fireEvent.change(text(), { target: { value: '`y`' } });
  rerender(field('`y`'));
  // Another draft, then the field's own last value again.
  rerender(field('plain'));
  expect((await editor()).textContent).toBe('plain');
  rerender(field('`y`'));
  expect(text().value).toBe('`y`');
});

it('leaves nothing to undo or link of a draft the app replaced', async () => {
  const changed = vi.fn();
  /** A draft the app keeps, and replaces with `replace` when it comes. */
  function Draft({ replace }: { readonly replace?: string }) {
    const [value, setValue] = useState('First');
    useEffect(() => {
      if (replace !== undefined) setValue(replace);
    }, [replace]);
    return (
      <MarkdownField
        label="Notes"
        value={value}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
        defaultPresentation="write"
      />
    );
  }
  const { rerender } = render(<Draft />);
  const input = await editor();
  fireEvent.click(button('Bulleted list'));
  expect(changed).toHaveBeenLastCalledWith('- First');
  await waitFor(() =>
    expect(button('Undo').hasAttribute('disabled')).toBe(false),
  );
  // An address half typed for this draft.
  fireEvent.keyDown(input, { key: 'k', ctrlKey: true });
  fireEvent.change(screen.getByRole('textbox', { name: 'Link address' }), {
    target: { value: 'https://old.example' },
  });
  // The app discards the draft and loads another text.
  rerender(<Draft replace="Other" />);
  await waitFor(() => expect(input.textContent).toBe('Other'));
  expect(screen.queryByRole('textbox', { name: 'Link address' })).toBeNull();
  await waitFor(() =>
    expect(button('Undo').hasAttribute('disabled')).toBe(true),
  );
  expect(changed).toHaveBeenCalledTimes(1);
});

it('edits a list item that starts with a list', async () => {
  render(<Notes initial={'-\n  1. x\n- y'} defaultPresentation="write" />);
  await editor();
  fireEvent.click(button('Bold'));
  fireEvent.click(button('Bulleted list'));
  expect(draft()).not.toBe('-\n  1. x\n- y');
});

it('shows a new placeholder in the editor', async () => {
  const field = (placeholder: string) => (
    <MarkdownField
      label="Notes"
      value=""
      onChange={() => {}}
      placeholder={placeholder}
      defaultPresentation="write"
    />
  );
  const { rerender } = render(field('Notes …'));
  const input = await editor();
  const shown = () =>
    input.querySelector('[data-placeholder]')?.getAttribute('data-placeholder');
  expect(shown()).toBe('Notes …');
  rerender(field('Notizen …'));
  await waitFor(() => expect(shown()).toBe('Notizen …'));
});

it('writes as Markdown a text it would not write back as it reads', () => {
  // A heading over two lines: written formatted, it would become one line.
  render(<Notes initial={'Title\nmore\n==='} defaultPresentation="write" />);
  expect(text().value).toBe('Title\nmore\n===');
});

it('starts writing Markdown with its actions for a text with code', () => {
  render(
    <Notes
      initial="Run `npm test`"
      defaultPresentation="write"
      placeholder="Details …"
    />,
  );
  expect(text().getAttribute('aria-label')).toBe('Notes');
  expect(text().placeholder).toBe('Details …');
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

it('passes the Markdown as typed and shows the value it gets', () => {
  const changed = vi.fn();
  render(<Notes initial="`x`" defaultPresentation="write" changed={changed} />);
  fireEvent.change(text(), { target: { value: '    ' } });
  expect(draft()).toBe('    ');
  fireEvent.change(text(), { target: { value: '    code\n' } });
  expect(draft()).toBe('    code\n');
  expect(changed.mock.calls.map(([v]) => v)).toEqual(['    ', '    code\n']);
});

it('shows exactly the value when the app replaces the Markdown', () => {
  const { rerender } = render(
    <MarkdownField
      label="Notes"
      value="`x`"
      onChange={() => {}}
      defaultPresentation="write"
    />,
  );
  fireEvent.change(text(), { target: { value: '    ' } });
  // The app keeps the text, then loads another draft and the first again.
  expect(text().value).toBe('`x`');
  for (const value of ['`loaded`', '`x`'])
    rerender(
      <MarkdownField
        label="Notes"
        value={value}
        onChange={() => {}}
        defaultPresentation="write"
      />,
    );
  expect(text().value).toBe('`x`');
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

it('shows the preview beside the Markdown only in a wide field', () => {
  render(<Notes initial="Some **text** `x`" defaultPresentation="write" />);
  // jsdom lays nothing out: the field has no width.
  expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  cleanup();
  const width = vi
    .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
    .mockReturnValue({ width: 800 } as DOMRect);
  try {
    render(<Notes initial="Some **text** `x`" defaultPresentation="write" />);
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(preview.querySelector('strong')?.textContent).toBe('text');
    act(() => fireEvent.click(button('Preview')));
    expect(screen.queryByRole('region', { name: 'Preview' })).toBeNull();
  } finally {
    width.mockRestore();
  }
});

it('formats the Markdown selection from the toolbar and keeps it selected', () => {
  render(<Notes initial="Buy milk today `x`" defaultPresentation="write" />);
  text().setSelectionRange(4, 8);
  fireEvent.click(button('Bold'));
  expect(draft()).toBe('Buy **milk** today `x`');
  expect([text().selectionStart, text().selectionEnd]).toEqual([6, 10]);
  expect(document.activeElement).toBe(text());
  fireEvent.click(button('Bold'));
  expect(draft()).toBe('Buy milk today `x`');
  text().setSelectionRange(0, 0);
  fireEvent.click(button('Bulleted list'));
  expect(draft()).toBe('- Buy milk today `x`');
});

it('formats Markdown with Ctrl+B, I and K and leaves other keys to the input', () => {
  render(<Notes initial="a word `x`" defaultPresentation="write" />);
  text().setSelectionRange(2, 6);
  fireEvent.keyDown(text(), { key: 'b', ctrlKey: true });
  expect(draft()).toBe('a **word** `x`');
  fireEvent.keyDown(text(), { key: 'i', ctrlKey: true });
  expect(draft()).toBe('a ***word*** `x`');
  // Shift or Alt with the key, and Tab, are not the field's.
  for (const key of [
    { key: 'B', ctrlKey: true, shiftKey: true },
    { key: 'k', ctrlKey: true, altKey: true },
    { key: 'Tab' },
  ])
    expect(fireEvent.keyDown(text(), key)).toBe(true);
  expect(draft()).toBe('a ***word*** `x`');
  fireEvent.keyDown(text(), { key: 'k', ctrlKey: true });
  expect(draft()).toBe('a ***[word](https://)*** `x`');
});

it('names its actions in the provider language, and takes the app’s labels', async () => {
  render(
    <SdkLocaleProvider locale="de-DE" timeZone="Europe/Berlin">
      <Notes initial="Text" labels={{ edit: 'Notiz bearbeiten' }} />
    </SdkLocaleProvider>,
  );
  fireEvent.click(button('Notiz bearbeiten'));
  expect(
    await screen.findByRole('toolbar', { name: 'Formatierung' }),
  ).toBeTruthy();
  expect(button('Durchgestrichen')).toBeTruthy();
  expect(button('Fett')).toBeTruthy();
  expect(button('Vorschau')).toBeTruthy();
});
