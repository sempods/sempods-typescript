import { describe, expect, it } from 'vitest';
import { formatMarkdown, type MarkdownFormat } from './format.js';

/**
 * Applies one action to a source whose selection is marked with `[` and `]`
 * (or `|` for a caret) and returns the result marked the same way.
 */
function run(kind: MarkdownFormat, marked: string): string {
  const caret = marked.indexOf('|');
  const start = caret >= 0 ? caret : marked.indexOf('[');
  const end = caret >= 0 ? caret : marked.indexOf(']') - 1;
  const source = marked.replace(caret >= 0 ? '|' : /[[\]]/g, '');
  const edit = formatMarkdown(kind, source, start, end);
  const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
  const [a, b] = edit.select;
  return a === b
    ? next.slice(0, a) + '|' + next.slice(a)
    : next.slice(0, a) + '[' + next.slice(a, b) + ']' + next.slice(b);
}

describe('emphasis', () => {
  it('wraps the selection and removes the markers again', () => {
    expect(run('bold', 'a [word] b')).toBe('a **[word]** b');
    expect(run('bold', 'a **[word]** b')).toBe('a [word] b');
    expect(run('italic', 'a [word] b')).toBe('a *[word]* b');
    expect(run('italic', 'a *[word]* b')).toBe('a [word] b');
  });

  it('removes markers the selection includes', () => {
    expect(run('bold', 'a [**word**] b')).toBe('a [word] b');
    expect(run('italic', 'a [*word*] b')).toBe('a [word] b');
  });

  it('tells bold from italic', () => {
    expect(run('italic', '**[word]**')).toBe('***[word]***');
    expect(run('italic', '***[word]***')).toBe('**[word]**');
    expect(run('bold', '*[word]*')).toBe('***[word]***');
    expect(run('bold', '***[word]***')).toBe('*[word]*');
    expect(run('bold', '[***word***]')).toBe('[*word*]');
    expect(run('italic', '[***word***]')).toBe('[**word**]');
    expect(run('italic', '[**word**]')).toBe('*[**word**]*');
  });

  it('merges spans of its own into one around the selection', () => {
    expect(run('bold', '[**first** and **second**]')).toBe(
      '**[first and second]**',
    );
    expect(run('bold', '**[first** and **second]**')).toBe(
      '**[first and second]**',
    );
    expect(run('italic', '[*first* and *second*]')).toBe(
      '*[first and second]*',
    );
    expect(run('bold', '[**partly** bold]')).toBe('**[partly bold]**');
    // The other emphasis stays.
    expect(run('bold', '[*a* and **b**]')).toBe('**[*a* and b]**');
    expect(run('italic', '[***a*** and *b*]')).toBe('*[**a** and b]*');
  });

  it('applies to each selected line, after its prefix', () => {
    expect(run('bold', '[first\n\nsecond]')).toBe('[**first**\n\n**second**]');
    expect(run('bold', '[**first**\n\nsecond]')).toBe(
      '[**first**\n\n**second**]',
    );
    expect(run('bold', '[**first**\n\n**second**]')).toBe('[first\n\nsecond]');
    expect(run('italic', '[- one\n- two]')).toBe('[- *one*\n- *two*]');
    expect(run('bold', '[## Title]')).toBe('## **[Title]**');
    expect(run('bold', '> [quoted]')).toBe('> **[quoted]**');
  });

  it('keeps stars that are text', () => {
    expect(run('italic', '[2 * 3 = 6]')).toBe('*[2 * 3 = 6]*');
    expect(run('bold', '[match `**/*.ts` files]')).toBe(
      '**[match `**/*.ts` files]**',
    );
    expect(run('bold', '[a \\**b** c]')).toBe('**[a \\**b** c]**');
    expect(run('bold', '[**open only]')).toBe('**[**open only]**');
  });

  it('keeps whitespace at the edges of the selection outside the markers', () => {
    expect(run('bold', 'a[ word ]b')).toBe('a **[word]** b');
  });

  it('inserts a pair around the caret, and removes an empty pair', () => {
    expect(run('bold', 'a |b')).toBe('a **|**b');
    expect(run('bold', 'a **|**b')).toBe('a |b');
    expect(run('italic', '|')).toBe('*|*');
  });
});

describe('line prefixes', () => {
  it('adds and removes a heading on the caret line', () => {
    expect(run('heading', 'one\ntw|o\nthree')).toBe('one\n## tw|o\nthree');
    expect(run('heading', 'one\n## tw|o')).toBe('one\ntw|o');
    expect(run('heading', '# Ti|tle')).toBe('## Ti|tle');
    expect(run('heading', '|')).toBe('## |');
  });

  it('moves a caret inside the old prefix behind the new one', () => {
    expect(run('heading', '#|## Title')).toBe('## |Title');
  });

  it('lists every selected line and skips empty ones between them', () => {
    expect(run('bulletList', '[one\n\ntwo]')).toBe('[- one\n\n- two]');
    expect(run('numberedList', '[one\ntwo\nthree]')).toBe(
      '[1. one\n2. two\n3. three]',
    );
  });

  it('removes a list when every line has it, and switches the kind', () => {
    expect(run('bulletList', '[- one\n- two]')).toBe('[one\ntwo]');
    expect(run('numberedList', '[1. one\n2. two]')).toBe('[one\ntwo]');
    expect(run('numberedList', '[- one\n* two]')).toBe('[1. one\n2. two]');
    expect(run('bulletList', '[1. one\n- two]')).toBe('[- one\n- two]');
  });

  it('keeps the indentation of nested items', () => {
    expect(run('bulletList', '[one\n  two]')).toBe('[- one\n  - two]');
    expect(run('bulletList', '[- one\n  - two]')).toBe('[one\n  two]');
  });

  it('leaves the line after a selection that ends at its start', () => {
    expect(run('bulletList', '[one\n]two')).toBe('[- one]\ntwo');
  });

  it('takes the first line at the start of a source that begins with a line break', () => {
    expect(run('heading', '|\nfoo')).toBe('## |\nfoo');
    expect(run('bulletList', '|\nfoo')).toBe('- |\nfoo');
  });

  it('starts a list on an empty line', () => {
    expect(run('bulletList', 'one\n|')).toBe('one\n- |');
  });
});

describe('links', () => {
  it('links the selected text and selects the address to type', () => {
    expect(run('link', 'see [the docs] now')).toBe(
      'see [the docs]([https://]) now',
    );
  });

  it('puts the caret into the text of a selected address', () => {
    expect(run('link', '[https://example.org/a]')).toBe(
      '[|](https://example.org/a)',
    );
  });

  it('inserts an empty link at the caret', () => {
    expect(run('link', 'a |b')).toBe('a [|](https://)b');
  });
});

it('accepts a backward selection', () => {
  const edit = formatMarkdown('bold', 'a word b', 6, 2);
  expect(edit).toEqual({ from: 2, to: 6, insert: '**word**', select: [4, 8] });
});
