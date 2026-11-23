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
    // Also inside a list item.
    expect(again('- parent\n  1. first\n  1) restarted')).toBe(
      '- parent\n  1. first\n  1) restarted',
    );
    expect(again('- parent\n  - a\n  * b')).toBe('- parent\n  - a\n  * b');
  });

  it('starts every list item with a paragraph, as the editor needs', () => {
    expect(fromMarkdown('-\n  1. x')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                { type: 'paragraph' },
                {
                  type: 'orderedList',
                  attrs: { start: 1 },
                  content: [
                    {
                      type: 'listItem',
                      content: [{ type: 'paragraph', content: [text('x')] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(again('-\n  1. x')).toBe('-\n  1. x');
    expect(again('- ## Title')).toBe('- ## Title');
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

  it('writes no markers around whitespace alone', () => {
    expect(toMarkdown(paragraph(text(' ', { type: 'bold' })))).toBe('');
    expect(
      toMarkdown(
        paragraph(text('a'), text('  ', { type: 'italic' }), text('b')),
      ),
    ).toBe('a  b');
  });

  it('leaves out emphasis whose markers would show, keeping the text', () => {
    // `a**.**c`: the stars could neither open nor close.
    const doc = paragraph(text('a'), text('.', { type: 'bold' }), text('c'));
    expect(toMarkdown(doc)).toBe('a.c');
    expect(
      toMarkdown(
        paragraph(text('a'), text('(b)', { type: 'strike' }), text('c')),
      ),
    ).toBe('a(b)c');
    // Next to spaces or inside words they flank, and stay.
    expect(
      toMarkdown(
        paragraph(text('a '), text('.', { type: 'bold' }), text(' c')),
      ),
    ).toBe('a **.** c');
    expect(
      toMarkdown(
        paragraph(text('a'), text('b', { type: 'italic' }), text('c')),
      ),
    ).toBe('a*b*c');
    // The parser reads an emoji by its UTF-16 units, as no punctuation:
    // around one, the markers flank as around a letter.
    const emoji = paragraph(text('a'), text('💰', { type: 'bold' }), text('b'));
    expect(toMarkdown(emoji)).toBe('a**💰**b');
    expect(fromMarkdown(toMarkdown(emoji))).toEqual(emoji);
  });

  it('keeps a `!` before a link text, not an image', () => {
    const doc = paragraph(
      text('see !'),
      text('page', { type: 'link', attrs: { href: 'https://example.org' } }),
    );
    expect(toMarkdown(doc)).toBe('see \\![page](https://example.org)');
    expect(fromMarkdown(toMarkdown(doc))).toEqual(doc);
    expect(again('\\![page](https://example.org)')).toBe(
      '\\![page](https://example.org)',
    );
  });

  it('keeps a character reference in a link address as it is', () => {
    for (const href of [
      'https://example.org/?x=1&copy;=2',
      'https://example.org/a(b)?x=1&amp;y',
    ])
      for (const label of ['page', href]) {
        const doc = paragraph(text(label, { type: 'link', attrs: { href } }));
        expect(fromMarkdown(toMarkdown(doc)), toMarkdown(doc)).toEqual(doc);
      }
    expect(again('[page](https://example.org/?x=1&amp;copy;=2)')).toBe(
      '[page](https://example.org/?x=1\\&copy;=2)',
    );
  });

  it('keeps hashes at the end of a heading', () => {
    expect(again('## Title \\#')).toBe('## Title \\#');
    expect(again('## \\#')).toBe('## \\#');
    expect(again('## C#')).toBe('## C#');
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

describe('any document', () => {
  // A small, seeded generator: the same documents on every run.
  let seed = 395;
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(items: readonly T[]) =>
    items[Math.floor(random() * items.length)]!;
  const CHARS = 'ab xy 12 *_~[]()!#&;<>`\\-+.=:/é💰';
  const HREFS = [
    'https://a.b/x',
    'https://a.b/?x=1&copy;=2',
    'https://a.b/(c)',
  ];
  const inline = (): DocNode[] =>
    Array.from({ length: 1 + Math.floor(random() * 5) }, () => {
      if (random() < 0.15) return hardBreak;
      const marks = [
        ...(['bold', 'italic', 'strike'] as const)
          .filter(() => random() < 0.3)
          .map((type) => ({ type })),
        ...(random() < 0.2
          ? [{ type: 'link', attrs: { href: pick(HREFS) } }]
          : []),
      ];
      const value = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        pick([...CHARS]),
      ).join('');
      return text(value, ...marks);
    });
  const list = (depth: number): DocNode => ({
    type: random() < 0.5 ? 'bulletList' : 'orderedList',
    content: Array.from({ length: 1 + Math.floor(random() * 3) }, () => ({
      type: 'listItem',
      content: [
        { type: 'paragraph', content: inline() },
        // Lists inside an item, sometimes two in a row.
        ...(depth < 2 && random() < 0.3
          ? Array.from({ length: 1 + Math.floor(random() * 2) }, () =>
              list(depth + 1),
            )
          : []),
      ],
    })),
  });
  const block = (): DocNode => {
    const kind = random();
    if (kind < 0.5) return { type: 'paragraph', content: inline() };
    if (kind < 0.7)
      return {
        type: 'heading',
        attrs: { level: 1 + Math.floor(random() * 6) },
        content: inline(),
      };
    return list(0);
  };
  /** Each character a reader sees, but whitespace, with its marks. */
  const shown = (node: DocNode): [string, string][] =>
    node.type === 'text'
      ? [...(node.text ?? '')]
          .filter((char) => /\S/.test(char))
          .map((char) => [
            char,
            (node.marks ?? [])
              .map((m) => m.type + (m.attrs?.href ?? ''))
              .sort()
              .join(' '),
          ])
      : (node.content ?? []).flatMap(shown);

  it('reads back its text, and no mark it did not have', () => {
    for (let i = 0; i < 500; i++) {
      const doc: DocNode = {
        type: 'doc',
        content: Array.from({ length: 1 + Math.floor(random() * 3) }, block),
      };
      const written = toMarkdown(doc);
      const back = fromMarkdown(written);
      expect(back, written).not.toBeNull();
      const before = shown(doc);
      const after = shown(back!);
      expect(after.map(([char]) => char).join(''), written).toBe(
        before.map(([char]) => char).join(''),
      );
      after.forEach(([, marks], j) => {
        const had = before[j]![1].split(' ');
        for (const mark of marks.split(' ').filter(Boolean))
          expect(had, written).toContain(mark);
      });
    }
  });
});
