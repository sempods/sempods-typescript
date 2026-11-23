/**
 * Markdown as the rich editor's document and back, for the small set it
 * edits: paragraphs, headings, bold, italic, strikethrough, web links,
 * bulleted and numbered lists and line breaks. The source is read with the
 * parser that `MarkdownView` renders with, so the editor shows what the view
 * shows; a text with anything else, such as code, a quote, an image or HTML,
 * is not read at all and stays with the source editor, so nothing is lost.
 *
 * Written back, the document is standard Markdown: CommonMark with GitHub's
 * `~~strikethrough~~`. Text that looks like Markdown, such as `*` or a `1.`
 * at a line's start, is escaped, so it stays text.
 */
import { parseMarkdown, type MarkdownNode } from './parse.js';

/** A mark of the editor's document. */
export interface DocMark {
  readonly type: string;
  readonly attrs?: { readonly href?: string };
}

/** A node of the editor's document, as Tiptap's JSON has it. */
export interface DocNode {
  readonly type: string;
  readonly attrs?: { readonly level?: number; readonly start?: number };
  readonly content?: readonly DocNode[];
  readonly text?: string;
  readonly marks?: readonly DocMark[];
}

class Unsupported extends Error {}

/** An address the field links: `http:` or `https:`, without spaces. */
export const WEB = /^https?:\/\/\S+$/i;
const MARKS: Readonly<Record<string, string>> = {
  strong: 'bold',
  emphasis: 'italic',
  delete: 'strike',
};

function inline(
  nodes: readonly MarkdownNode[] = [],
  marks: readonly DocMark[] = [],
): DocNode[] {
  const out: DocNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text')
      (node.value ?? '').split(/\r?\n/).forEach((line, i) => {
        if (i > 0) out.push({ type: 'hardBreak' });
        if (line)
          out.push({
            type: 'text',
            text: line,
            ...(marks.length > 0 ? { marks } : {}),
          });
      });
    else if (node.type === 'break') out.push({ type: 'hardBreak' });
    else if (MARKS[node.type])
      out.push(
        ...inline(node.children, [...marks, { type: MARKS[node.type]! }]),
      );
    else if (
      node.type === 'link' &&
      WEB.test(node.url ?? '') &&
      !node.title &&
      !marks.some((mark) => mark.type === 'link')
    )
      out.push(
        ...inline(node.children, [
          ...marks,
          { type: 'link', attrs: { href: node.url! } },
        ]),
      );
    else throw new Unsupported(node.type);
  }
  return out;
}

function block(node: MarkdownNode): DocNode {
  switch (node.type) {
    case 'paragraph':
      return { type: 'paragraph', content: inline(node.children) };
    case 'heading':
      return {
        type: 'heading',
        attrs: { level: node.depth ?? 1 },
        content: inline(node.children),
      };
    case 'list':
      return {
        type: node.ordered ? 'orderedList' : 'bulletList',
        ...(node.ordered ? { attrs: { start: node.start ?? 1 } } : {}),
        content: (node.children ?? []).map((item) => {
          const content = (item.children ?? []).map(block);
          // An empty item still holds a paragraph in the editor.
          return {
            type: 'listItem',
            content: content.length > 0 ? content : [{ type: 'paragraph' }],
          };
        }),
      };
    default:
      throw new Unsupported(node.type);
  }
}

/**
 * The editor's document for `source`, or `null` when the text holds
 * anything beyond the editor's set: code, a quote, an image, HTML, a rule,
 * a reference link, a link with a title or to anything but a web address.
 */
export function fromMarkdown(source: string): DocNode | null {
  try {
    const content = (parseMarkdown(source).children ?? []).map(block);
    return {
      type: 'doc',
      content: content.length > 0 ? content : [{ type: 'paragraph' }],
    };
  } catch (error) {
    if (error instanceof Unsupported) return null;
    throw error;
  }
}

/** An `&` that would start a character reference, which Markdown decodes. */
const REFERENCE = /&(?=#?[0-9A-Za-z]+;)/g;

/** Text with the characters escaped that could begin or end Markdown in a line. */
const escapeText = (text: string) =>
  // `&amp;` typed as text stays those five characters.
  text.replace(/[\\`*_~[\]<]/g, '\\$&').replace(REFERENCE, '\\&');

/**
 * A line's start without what the parser would read as a block of its own:
 * a heading, a list, a quote, a rule or a heading's underline, or an
 * indented code block.
 */
const escapeLineStart = (line: string) =>
  line
    .replace(/^[ \t]+/, '')
    .replace(/^(#{1,6})(?=[ \t]|$)/, '\\$1')
    .replace(/^([-+])(?=[ \t]|$)/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=[ \t]|$)/, '$1\\$2')
    .replace(/^(=+|-+)([ \t]*)$/, '\\$1$2')
    .replace(/^>/, '\\>');

/** The order in which marks nest: a link outermost. */
const ORDER = ['link', 'bold', 'italic', 'strike'];
const DELIMITER: Readonly<Record<string, string>> = {
  bold: '**',
  italic: '*',
  strike: '~~',
};

const sameMark = (a: DocMark, b: DocMark) =>
  a.type === b.type && (a.type !== 'link' || a.attrs?.href === b.attrs?.href);

/**
 * An address as a link destination: in angle brackets where it holds
 * characters that would end a plain one, and with an `&` escaped where it
 * would start a character reference, so it reads back as it was.
 */
export const destination = (href: string) =>
  (/[\s()<>\\]/.test(href)
    ? '<' + href.replace(/[<>\\]/g, '\\$&') + '>'
    : href
  ).replace(REFERENCE, '\\&');

/** The length of the spaces and tabs that end `text`. */
function trailingSpace(text: string) {
  let at = text.length;
  while (at > 0 && (text[at - 1] === ' ' || text[at - 1] === '\t')) at--;
  return text.length - at;
}

/** Whether `text` ends with a character no backslash escapes. */
function endsUnescaped(text: string, char: string) {
  if (!text.endsWith(char)) return false;
  let at = text.length - 1;
  while (at > 0 && text[at - 1] === '\\') at--;
  return (text.length - 1 - at) % 2 === 0;
}

/** How a character next to a delimiter run counts for CommonMark. */
const side = (char: string | undefined) =>
  !char || /\s/.test(char)
    ? 'space'
    : /[\p{P}\p{S}]/u.test(char)
      ? 'punctuation'
      : 'other';

/**
 * Whether the delimiter run at `[at, at + length)` of `out` opens or
 * closes emphasis as meant: CommonMark's flanking rules, which GitHub's
 * strikethrough follows as well.
 */
function flanks(out: string, at: number, length: number, opens: boolean) {
  const char = out[at]!;
  let start = at;
  while (start > 0 && out[start - 1] === char && out[start - 2] !== '\\')
    start--;
  let end = at + length;
  while (out[end] === char) end++;
  // By UTF-16 unit, as the parser reads: half an emoji is no punctuation.
  const before = side(out[start - 1]);
  const after = side(out[end]);
  return opens
    ? after !== 'space' && (after !== 'punctuation' || before !== 'other')
    : before !== 'space' && (before !== 'punctuation' || after !== 'other');
}

/** Emphasis written over nodes `[from, to]`, and where its markers are. */
interface Span {
  readonly type: string;
  readonly from: number;
  readonly to: number;
  readonly open: number;
  readonly close: number;
  readonly length: number;
}

/** Each character a reader sees, but whitespace, with its marks. */
function visible(nodes: readonly DocNode[] = []): string {
  let out = '';
  for (const node of nodes) {
    if (node.type !== 'text') {
      out += visible(node.content);
      continue;
    }
    const marks = (node.marks ?? [])
      .map((mark) => mark.type + (mark.attrs?.href ?? ''))
      .sort()
      .join(' ');
    for (const char of node.text ?? '')
      if (/\S/.test(char)) out += `${char}\u0000${marks}\u0001`;
  }
  return out;
}

/** Text next to text with the same marks as one, as the editor keeps it. */
function merged(content: readonly DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const node of content) {
    const previous = out[out.length - 1];
    const marks = node.marks ?? [];
    if (
      previous?.type === 'text' &&
      node.type === 'text' &&
      (previous.marks ?? []).length === marks.length &&
      marks.every((mark) =>
        (previous.marks ?? []).some((other) => sameMark(mark, other)),
      )
    )
      out[out.length - 1] = {
        ...previous,
        text: (previous.text ?? '') + (node.text ?? ''),
      };
    else out.push(node);
  }
  return out;
}

/** The content without bold, italic and strikethrough; links stay. */
const plain = (content: readonly DocNode[]) =>
  content.map((node) =>
    node.marks
      ? { ...node, marks: node.marks.filter((m) => m.type === 'link') }
      : node,
  );

/**
 * Inline content as Markdown. In a heading, which is one line, a break is a
 * space. Emphasis whose markers would not flank its text, as around a `.`
 * between letters, is left out rather than written as stars that show; so
 * is all emphasis of a block where markers meet and would pair otherwise,
 * which reading the block back shows.
 */
function serializeInline(
  nodes: readonly DocNode[] = [],
  heading = false,
): string {
  const content = merged(nodes);
  let out = '';
  // The open marks, outermost first: where each began, and its marker.
  const open: { mark: DocMark; from: number; at: number }[] = [];
  let last = -1;
  const spans: Span[] = [];
  // Markers next to whitespace would neither open nor close: the whitespace
  // moves outside them.
  const closeTo = (depth: number) => {
    const space = out.slice(out.length - trailingSpace(out));
    out = out.slice(0, out.length - space.length);
    while (open.length > depth) {
      const { mark, from, at } = open.pop()!;
      if (mark.type === 'link') {
        out += `](${destination(mark.attrs?.href ?? '')})`;
        continue;
      }
      const delimiter = DELIMITER[mark.type]!;
      spans.push({
        type: mark.type,
        from,
        to: last,
        open: at,
        close: out.length,
        length: delimiter.length,
      });
      out += delimiter;
    }
    out += space;
  };
  for (const [index, node] of content.entries()) {
    if (node.type === 'hardBreak') {
      // A break on a line with nothing yet is a `\` that shows.
      if (out === '' || out.endsWith('\n')) continue;
      closeTo(0);
      out = out.slice(0, out.length - trailingSpace(out));
      out += heading ? ' ' : '\\\n';
      continue;
    }
    const marks = [...(node.marks ?? [])].sort(
      (a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type),
    );
    // A link whose text is its address, alone, as `<address>`.
    const href = marks.length === 1 && marks[0]!.attrs?.href;
    if (
      href &&
      node.text === href &&
      // An autolink takes no escapes.
      !/[<>\\]/.test(href) &&
      href.search(REFERENCE) === -1 &&
      !open.some(({ mark }) => sameMark(mark, marks[0]!)) &&
      !sameMark(marks[0]!, content[index + 1]?.marks?.[0] ?? { type: '' })
    ) {
      closeTo(0);
      out += `<${href}>`;
      last = index;
      continue;
    }
    let keep = 0;
    while (
      keep < open.length &&
      keep < marks.length &&
      sameMark(open[keep]!.mark, marks[keep]!)
    )
      keep++;
    closeTo(keep);
    let text = escapeText(node.text ?? '');
    // Nothing written on the line yet: it would start a block there.
    if (out === '' || (!heading && out.endsWith('\n')))
      text = escapeLineStart(text);
    // Whitespace alone takes no marks of its own: `** **` would be a rule.
    if (keep < marks.length && /\S/.test(text)) {
      const lead = /^[ \t]*/.exec(text)![0];
      out += lead;
      text = text.slice(lead.length);
      for (const mark of marks.slice(keep)) {
        // A `!` before a link would make it an image.
        if (mark.type === 'link' && endsUnescaped(out, '!'))
          out = out.slice(0, -1) + '\\!';
        open.push({ mark, from: index, at: out.length });
        out += mark.type === 'link' ? '[' : DELIMITER[mark.type];
      }
    }
    out += text;
    last = index;
  }
  closeTo(0);
  out = out.slice(0, out.length - trailingSpace(out));
  // A break at the end of a block is not one, also before whitespace alone.
  while (out.endsWith('\\\n')) {
    out = out.slice(0, -2);
    out = out.slice(0, out.length - trailingSpace(out));
  }
  const failed = spans.filter(
    (span) =>
      !flanks(out, span.open, span.length, true) ||
      !flanks(out, span.close, span.length, false),
  );
  if (failed.length === 0) {
    // Markers that meet, as `***` or `*~~`, can pair otherwise than meant.
    if (
      spans.length === 0 ||
      !/[*~]{3,}|\*~|~\*/.test(out) ||
      visible(fromMarkdown(out)?.content) === visible(content)
    )
      return out;
    return serializeInline(plain(content), heading);
  }
  // Marks that cannot be written leave the nodes they span, all at once.
  return serializeInline(
    content.map((node, i) => {
      const drop = failed
        .filter((span) => span.from <= i && i <= span.to)
        .map((span) => span.type);
      return drop.length === 0 || !node.marks
        ? node
        : { ...node, marks: node.marks.filter((m) => !drop.includes(m.type)) };
    }),
    heading,
  );
}

/** Lines after the first indented by `by`, as a list item's content is. */
const indent = (text: string, by: number) =>
  text.replace(/\n(?=[^\n])/g, '\n' + ' '.repeat(by));

/** A block as Markdown; `other` marks a list right after one of its kind. */
export function serializeBlock(node: DocNode, other = false): string {
  switch (node.type) {
    case 'paragraph':
      return serializeInline(node.content);
    case 'heading': {
      // Hashes at its end would close the heading, and disappear.
      const text = serializeInline(node.content, true).replace(
        /(^|[ \t])(#+)([ \t]*)$/,
        '$1\\$2$3',
      );
      return '#'.repeat(node.attrs?.level ?? 2) + (text ? ' ' + text : '');
    }
    case 'bulletList':
    case 'orderedList': {
      // A list right after one of its kind takes the other marker, so the
      // two stay two lists.
      const start = node.attrs?.start ?? 1;
      return (node.content ?? [])
        .map((item, i) => {
          const marker =
            node.type === 'bulletList'
              ? other
                ? '* '
                : '- '
              : `${start + i}${other ? ')' : '.'} `;
          // A nested list follows its item's text directly, so the list
          // stays tight; paragraphs are apart. Two lists in a row keep
          // apart as at the top.
          let previous: string | undefined;
          let nested = false;
          let body = '';
          for (const child of item.content ?? []) {
            const list = /List$/.test(child.type);
            nested = previous === child.type && list && !nested;
            const written = serializeBlock(child, nested);
            // An empty paragraph adds nothing.
            if (written === '') continue;
            // A list interrupts its item's text only if it starts at 1 with
            // an item that has text; any other needs a blank line.
            const tight =
              list &&
              (previous !== 'paragraph' ||
                ((child.attrs?.start ?? 1) === 1 &&
                  /^(?:[-*]|\d+[.)]) \S/.test(written)));
            // An item that starts with a list has its marker alone above it.
            body +=
              (body === '' ? (list ? '\n' : '') : tight ? '\n' : '\n\n') +
              written;
            previous = child.type;
          }
          return (marker + indent(body, marker.length)).replace(/[ \t]+$/, '');
        })
        .join('\n');
    }
    default:
      throw new Error(`The editor holds an unknown node: ${node.type}.`);
  }
}

/**
 * Top-level blocks as Markdown, each written by `write`: a list right after
 * one of its kind takes the other marker, so the two stay two lists, and an
 * empty paragraph adds nothing.
 */
export function joinBlocks<Block extends { readonly type: string }>(
  blocks: Iterable<Block>,
  write: (block: Block, other: boolean) => string,
): string {
  const out: string[] = [];
  let previous: string | undefined;
  let other = false;
  for (const block of blocks) {
    other = previous === block.type && /List$/.test(block.type) && !other;
    const text = write(block, other);
    if (text === '') continue;
    out.push(text);
    previous = block.type;
  }
  return out.join('\n\n');
}

/** The editor's document as standard Markdown. */
export const toMarkdown = (doc: DocNode) =>
  joinBlocks(doc.content ?? [], serializeBlock);
