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

const WEB = /^https?:\/\/\S+$/i;
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

/** Text with the characters escaped that could begin or end Markdown in a line. */
const escapeText = (text: string) =>
  text
    .replace(/[\\`*_~[\]<]/g, '\\$&')
    // `&amp;` typed as text stays those five characters.
    .replace(/&(?=#?[0-9A-Za-z]+;)/g, '\\&');

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

const destination = (href: string) =>
  /[\s()<>\\]/.test(href) ? '<' + href.replace(/[<>\\]/g, '\\$&') + '>' : href;

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
  const before = side(out[start - 1]);
  const after = side(out[end]);
  return opens
    ? after !== 'space' && (after !== 'punctuation' || before !== 'other')
    : before !== 'space' && (before !== 'punctuation' || after !== 'other');
}

/** A delimiter run written for a mark, and the nodes the mark spans. */
interface Run {
  readonly at: number;
  readonly length: number;
  readonly opens: boolean;
  readonly type: string;
  readonly from: number;
  readonly to: number;
}

/**
 * Inline content as Markdown. In a heading, which is one line, a break is a
 * space. Emphasis whose markers would not flank its text, as around a `.`
 * between letters, is left out rather than written as stars that show.
 */
function serializeInline(
  content: readonly DocNode[] = [],
  heading = false,
): string {
  let out = '';
  const open: DocMark[] = [];
  // The node each open mark began at, and the last node written.
  const began: number[] = [];
  let last = -1;
  const runs: Run[] = [];
  // Markers next to whitespace would neither open nor close: the whitespace
  // moves outside them.
  const closeTo = (depth: number) => {
    const space = /[ \t]*$/.exec(out)![0];
    out = out.slice(0, out.length - space.length);
    while (open.length > depth) {
      const mark = open.pop()!;
      const from = began.pop()!;
      if (mark.type === 'link') {
        out += `](${destination(mark.attrs?.href ?? '')})`;
        continue;
      }
      const delimiter = DELIMITER[mark.type]!;
      runs.push({
        at: out.length,
        length: delimiter.length,
        opens: false,
        type: mark.type,
        from,
        to: last,
      });
      out += delimiter;
    }
    out += space;
  };
  let lineStart = true;
  for (const [index, node] of content.entries()) {
    if (node.type === 'hardBreak') {
      closeTo(0);
      out = out.replace(/[ \t]+$/, '');
      // A break at the end of a block is not one.
      if (index < content.length - 1) out += heading ? ' ' : '\\\n';
      lineStart = !heading;
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
      !/[<>]/.test(href) &&
      !open.some((mark) => sameMark(mark, marks[0]!)) &&
      !sameMark(marks[0]!, content[index + 1]?.marks?.[0] ?? { type: '' })
    ) {
      closeTo(0);
      out += `<${href}>`;
      lineStart = false;
      last = index;
      continue;
    }
    let keep = 0;
    while (
      keep < open.length &&
      keep < marks.length &&
      sameMark(open[keep]!, marks[keep]!)
    )
      keep++;
    closeTo(keep);
    let text = escapeText(node.text ?? '');
    if (lineStart) text = escapeLineStart(text);
    // Whitespace alone takes no marks of its own: `** **` would be a rule.
    if (keep < marks.length && /\S/.test(text)) {
      const lead = /^[ \t]*/.exec(text)![0];
      out += lead;
      text = text.slice(lead.length);
      for (const mark of marks.slice(keep)) {
        if (mark.type === 'link') {
          // A `!` before it would make the link an image.
          if (/(^|[^\\])(\\\\)*!$/.test(out)) out = out.slice(0, -1) + '\\!';
          out += '[';
        } else {
          runs.push({
            at: out.length,
            length: DELIMITER[mark.type]!.length,
            opens: true,
            type: mark.type,
            from: index,
            to: index,
          });
          out += DELIMITER[mark.type];
        }
        open.push(mark);
        began.push(index);
      }
    }
    out += text;
    lineStart = false;
    last = index;
  }
  closeTo(0);
  out = out.replace(/[ \t]+$/, '');
  const failed = runs.find(
    (run) => !flanks(out, run.at, run.length, run.opens),
  );
  if (!failed) return out;
  // The mark that cannot be written leaves the nodes it spans.
  const span = failed.opens
    ? runs.find(
        (run) =>
          !run.opens && run.type === failed.type && run.from === failed.from,
      )
    : failed;
  const [from, to] = [span?.from ?? failed.from, span?.to ?? failed.to];
  return serializeInline(
    content.map((node, i) =>
      i < from || i > to || !node.marks
        ? node
        : { ...node, marks: node.marks.filter((m) => m.type !== failed.type) },
    ),
    heading,
  );
}

/** Lines after the first indented by `by`, as a list item's content is. */
const indent = (text: string, by: number) =>
  text.replace(/\n(?=[^\n])/g, '\n' + ' '.repeat(by));

/** A block as Markdown; `other` marks a list right after one of its kind. */
function serializeBlock(node: DocNode, other = false): string {
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
          // stays tight; paragraphs are apart.
          const body = (item.content ?? [])
            .map(
              (child, j) =>
                (j === 0 ? '' : /List$/.test(child.type) ? '\n' : '\n\n') +
                serializeBlock(child),
            )
            .join('');
          return (marker + indent(body, marker.length)).replace(/[ \t]+$/, '');
        })
        .join('\n');
    }
    default:
      throw new Error(`The editor holds an unknown node: ${node.type}.`);
  }
}

/** The editor's document as standard Markdown. */
export function toMarkdown(doc: DocNode): string {
  const out: string[] = [];
  let previous: string | undefined;
  let other = false;
  for (const node of doc.content ?? []) {
    other = previous === node.type && /List$/.test(node.type) && !other;
    const text = serializeBlock(node, other);
    // An empty paragraph adds nothing, nor separates two lists.
    if (text === '') continue;
    out.push(text);
    previous = node.type;
  }
  return out.join('\n\n');
}
