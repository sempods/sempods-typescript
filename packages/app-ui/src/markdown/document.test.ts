import { describe, expect, it } from 'vitest';
import { fromMarkdown, toMarkdown, type DocNode } from './document.js';

/** The source as the editor writes it back after reading it. */
const again = (source: string) => {
  const doc = fromMarkdown(source);
  return doc && toMarkdown(doc);
};

const paragraph = (...content: DocNode[]): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content }],
});
const text = (value: string, ...marks: DocNode['marks'] & object): DocNode => ({
  type: 'text',
  text: value,
  ...(marks.length > 0 ? { marks } : {}),
});
const hardBreak: DocNode = { type: 'hardBreak' };

describe('reading and writing back', () => {
  it('keeps a text in the editor set as it is', () => {
    for (const source of [
      '## Before the visit\n\nCall Mr **Albers** before noon and ask for the *spare part*.',
      '- one\n- two\n  - nested\n- three',
      '3. three\n4. four',
      '1. Point\n\n   A paragraph in the point\n2. two',
      '~~gone~~ and ***both*** and **bold *italic* bold**',
      'A [link](https://example.org/a) in text',
      'Word**bold**word',
      '# H1\n\n###### H6',
      'Ends with a backslash \\\\',
      '',
    ])
      expect(again(source)).toBe(source);
  });

  it('writes line breaks, emphasis and lists one way', () => {
    expect(again('First line\nsecond line')).toBe('First line\\\nsecond line');
    expect(again('Hard break  \nnext')).toBe('Hard break\\\nnext');
    expect(again('_italic_ and __bold__')).toBe('*italic* and **bold**');
    expect(again('* a\n* b')).toBe('- a\n- b');
    expect(again('- a\n\n- b')).toBe('- a\n- b');
    expect(again('**[bold link](https://a.b)**')).toBe(
      '[**bold link**](https://a.b)',
    );
  });

  it('keeps two lists in a row apart', () => {
    expect(again('- a\n\n\n* b')).toBe('- a\n\n* b');
    expect(again('1. a\n\n\n1) b')).toBe('1. a\n\n1) b');
  });

  it('writes an address that is its own text as an autolink', () => {
    expect(again('<https://example.org>')).toBe('<https://example.org>');
    expect(again('[https://example.org](https://example.org)')).toBe(
      '<https://example.org>',
    );
    expect(again('[a_(b)](https://example.org/a_(b))')).toBe(
      '[a\\_(b)](<https://example.org/a_(b)>)',
    );
  });

  it('leaves a text with anything else to the source editor', () => {
    for (const source of [
      '```\ncode\n```',
      '    code',
      'Run `npm test`',
      '> quoted',
      '![photo](x.png)',
      '<b>html</b>',
      '---',
      '[ref]\n\n[ref]: https://a.b',
      '[mail](mailto:a@b.c)',
      '[titled](https://a.b "title")',
      '[relative](/path)',
    ])
      expect(fromMarkdown(source), source).toBeNull();
  });
});

describe('text that looks like Markdown', () => {
  it('stays text at the start of a line', () => {
    for (const typed of [
      '# Note',
      '1. Point',
      '2) two',
      '- dash',
      '+ plus',
      '> quote',
      '---',
      '===',
      '    four spaces',
      '```',
      '[a]: https://x',
    ]) {
      const doc = paragraph(text('Title'), hardBreak, text(typed));
      const back = fromMarkdown(toMarkdown(doc));
      expect(back, typed).toEqual(
        paragraph(text('Title'), hardBreak, text(typed.trimStart())),
      );
    }
  });

  it('stays text within a line', () => {
    for (const typed of [
      '*not bold* and _not italic_',
      'a_b_c and 2 * 3',
      '~~not struck~~',
      '[x](https://y) and <div>x</div>',
      'C:\\Path\\',
      '&amp; stays five characters, & one',
      '`not code`',
    ]) {
      const written = toMarkdown(paragraph(text(typed)));
      expect(fromMarkdown(written), written).toEqual(paragraph(text(typed)));
    }
  });

  it('escapes only what needs it', () => {
    expect(toMarkdown(paragraph(text('Tom & Jerry > all, 50% off!')))).toBe(
      'Tom & Jerry > all, 50% off!',
    );
  });
});

describe('marks', () => {
  it('keeps whitespace at the edges of a mark outside its markers', () => {
    expect(
      toMarkdown(
        paragraph(text('a '), text('bold ', { type: 'bold' }), text('word')),
      ),
    ).toBe('a **bold** word');
  });

  it('reads back marks that overlap and touch', () => {
    for (const doc of [
      paragraph(
        text('a', { type: 'bold' }),
        text('b', { type: 'bold' }, { type: 'italic' }),
        text('c', { type: 'italic' }),
      ),
      paragraph(text('a', { type: 'italic' }), text('b', { type: 'bold' })),
      paragraph(text('a', { type: 'bold' }), text('b', { type: 'strike' })),
      paragraph(
        text('x '),
        text('link ', { type: 'link', attrs: { href: 'https://a.b' } }),
        text(
          'bold',
          { type: 'link', attrs: { href: 'https://a.b' } },
          { type: 'bold' },
        ),
        text(' y'),
      ),
    ])
      expect(fromMarkdown(toMarkdown(doc)), toMarkdown(doc)).toEqual(doc);
  });

  it('writes a break in a heading as a space', () => {
    expect(
      toMarkdown({
        type: 'doc',
        content: [
          {
            type: 'heading',
            attrs: { level: 2 },
            content: [text('a'), hardBreak, text('b')],
          },
        ],
      }),
    ).toBe('## a b');
  });

  it('drops a break at the end of a paragraph and empty paragraphs', () => {
    expect(
      toMarkdown({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [text('a'), hardBreak] },
          { type: 'paragraph' },
          { type: 'paragraph', content: [text('b')] },
        ],
      }),
    ).toBe('a\n\nb');
  });
});
