import { describe, expect, it } from 'vitest';
import { formatMarkdown, type MarkdownFormat } from './format.js';

/**
 * Applies one action to a source whose selection is marked with `[` and `]`,
 * or with `«` and `»` where the source has brackets (or `|` for a caret),
 * and returns the result marked the same way, or `null` without an edit.
 */
function run(kind: MarkdownFormat, marked: string): string | null {
  const [open, close] = marked.includes('«') ? ['«', '»'] : ['[', ']'];
  const caret = marked.indexOf('|');
  const start = caret >= 0 ? caret : marked.indexOf(open);
  const end = caret >= 0 ? caret : marked.indexOf(close) - 1;
  // Without the marks, cut out at their offsets.
  const source =
    caret >= 0
      ? marked.slice(0, caret) + marked.slice(caret + 1)
      : marked.slice(0, start) +
        marked.slice(start + 1, end + 1) +
        marked.slice(end + 2);
  const edit = formatMarkdown(kind, source, start, end);
  if (!edit) return null;
  const next = source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
  const [a, b] = edit.select;
  return a === b
    ? next.slice(0, a) + '|' + next.slice(a)
    : next.slice(0, a) + open + next.slice(a, b) + close + next.slice(b);
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

  it('keeps a paragraph or list item over soft line breaks as one span', () => {
    expect(run('bold', '[**hello\nworld**]')).toBe('[hello\nworld]');
    expect(run('italic', '[*hello\nworld*]')).toBe('[hello\nworld]');
    expect(run('bold', '[hello\nworld]')).toBe('**[hello\nworld]**');
    expect(run('bold', '[- one\n  more\n- two]')).toBe(
      '[- **one\n  more**\n- **two**]',
    );
    expect(run('bold', '[## Title\ntext]')).toBe('[## **Title**\n**text**]');
  });

  it('grows a selection that crosses a span over all of it', () => {
    expect(run('bold', '**hel[lo** world]')).toBe('**[hello world]**');
    expect(run('bold', '[say **hel]lo**')).toBe('**[say hello]**');
    expect(run('italic', '*hel[lo* world]')).toBe('*[hello world]*');
  });

  it('takes the emphasis off the span a caret is in', () => {
    expect(run('bold', '**hel|lo** world')).toBe('hel|lo world');
    expect(run('bold', '**hello|** world')).toBe('hello| world');
    expect(run('italic', 'a *b|c* d')).toBe('a b|c d');
    expect(run('italic', '***a|b***')).toBe('**a|b**');
    expect(run('bold', 'plain |text')).toBe('plain **|**text');
  });

  it('takes the emphasis off the whole span a selection lies in', () => {
    expect(run('bold', '**[hello] world**')).toBe('[hello] world');
    expect(run('bold', '**say [hello] world**')).toBe('say [hello] world');
    expect(run('italic', '*say [hi] there*')).toBe('say [hi] there');
    // The other emphasis stays.
    expect(run('italic', '***[a] b***')).toBe('**[a] b**');
    // Over the paragraph's lines, and with either marker, as the preview
    // shows it.
    expect(run('bold', '**hello\n[world]**')).toBe('hello\n[world]');
    expect(run('bold', '__[hello]__')).toBe('[hello]');
    expect(run('italic', 'a _[b]_ c')).toBe('a [b] c');
  });

  it('keeps stars that are text', () => {
    expect(run('italic', '[2 * 3 = 6]')).toBe('*[2 * 3 = 6]*');
    expect(run('bold', '[match `**/*.ts` files]')).toBe(
      '**[match `**/*.ts` files]**',
    );
    // Markers around it would pair with the stars after the escaped one:
    // not offered.
    expect(run('bold', '[a \\**b** c]')).toBeNull();
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

describe('code and addresses', () => {
  it('keeps the stars of a link address and of code', () => {
    expect(
      run('italic', '«Download [data](https://example.org/a*b*c) now»'),
    ).toBe('*«Download [data](https://example.org/a*b*c) now»*');
    expect(run('bold', '[a `**glob**` b]')).toBe('**[a `**glob**` b]**');
  });

  it('offers nothing inside code or a link address', () => {
    expect(run('bold', '`**[glob]**`')).toBeNull();
    expect(run('bold', '`co|de`')).toBeNull();
    expect(run('italic', '[data](https://example.org/«a*b»*c)')).toBeNull();
    expect(
      run('link', 'see [the docs](https://exam«ple.org) and» more'),
    ).toBeNull();
    expect(run('heading', '```\nco|de\n```')).toBeNull();
    expect(run('bulletList', '    co|de')).toBeNull();
  });

  it('formats the prose around a code block and leaves the block', () => {
    expect(run('bold', '[intro\n\n```\n**code**\n```\n\nafter]')).toBe(
      '[**intro**\n\n```\n**code**\n```\n\n**after**]',
    );
    expect(run('bold', '[intro\n\n    code]')).toBe('**[intro]**\n\n    code');
    expect(run('bold', '```\n[code]\n```')).toBeNull();
  });

  it('offers nothing that cuts into a link or code', () => {
    expect(run('bold', 'see [the «docs](https://example.org) now»')).toBeNull();
    expect(run('bold', 'run `np«m test` now»')).toBeNull();
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

  it('escapes a bracket of the text without its partner', () => {
    // Called directly: the helper's selection marks are brackets.
    const label = (text: string) => {
      const edit = formatMarkdown('link', text, 0, text.length)!;
      return [edit.insert, edit.insert.slice(...edit.select)];
    };
    expect(label('price [USD')).toEqual([
      '[price \\[USD](https://)',
      'https://',
    ]);
    expect(label('a ] b')).toEqual(['[a \\] b](https://)', 'https://']);
    expect(label('see [note] here')).toEqual([
      '[see [note] here](https://)',
      'https://',
    ]);
    expect(label('a \\[ b')).toEqual(['[a \\[ b](https://)', 'https://']);
    // Offsets count UTF-16 units, as an emoji before the bracket has two.
    expect(label('💰 price [USD')).toEqual([
      '[💰 price \\[USD](https://)',
      'https://',
    ]);
    // A backslash at the end must not escape the closing bracket.
    expect(label('C:\\folder\\')).toEqual([
      '[C:\\folder\\\\](https://)',
      'https://',
    ]);
    expect(label('ends \\\\')).toEqual(['[ends \\\\](https://)', 'https://']);
  });

  it('keeps a selected address whole that holds parentheses', () => {
    expect(run('link', '[https://example.org/a)b]')).toBe(
      '[|](<https://example.org/a)b>)',
    );
    expect(run('link', '[https://example.org/a<b\\c]')).toBe(
      '[|](<https://example.org/a\\<b\\\\c>)',
    );
  });

  it('links only the first paragraph of the selection', () => {
    expect(run('link', '[one\nline\n\nnext]')).toBe(
      '[one\nline]([https://])\n\nnext',
    );
    // A list item or heading ends a paragraph without a blank line.
    expect(run('link', '[- one\n- two]')).toBe('- [one]([https://])\n- two');
    expect(run('link', '[## Title\ntext]')).toBe(
      '## [Title]([https://])\ntext',
    );
  });

  it('never nests a link', () => {
    expect(run('link', '«see [docs](https://example.org)»')).toBeNull();
    expect(run('link', '«[docs](https://example.org/a)»')).toBeNull();
    expect(run('link', '[d|ocs](https://example.org/a)')).toBeNull();
  });

  it('inserts an empty link at the caret', () => {
    expect(run('link', 'a |b')).toBe('a [|](https://)b');
  });
});

it('accepts a backward selection', () => {
  const edit = formatMarkdown('bold', 'a word b', 6, 2);
  expect(edit).toEqual({ from: 2, to: 6, insert: '**word**', select: [4, 8] });
});
