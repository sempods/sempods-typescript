/**
 * The formatting actions of `MarkdownField`, as pure edits of the source: each
 * replaces one range and names the selection after it, so the field can apply
 * it through the browser's own text input and keep its undo history.
 */

/** The formatting actions the field's toolbar offers. */
export type MarkdownFormat =
  'heading' | 'bold' | 'italic' | 'bulletList' | 'numberedList' | 'link';

/** One replacement in the source and the selection after it. */
export interface MarkdownEdit {
  /** The replaced range, `[from, to)` in the current source. */
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  /** The selection in the new source. */
  readonly select: readonly [number, number];
}

const isSpace = (char: string | undefined) =>
  char !== undefined && /\s/.test(char);

/** The selection without whitespace at its edges, which markers exclude. */
function inward(source: string, start: number, end: number): [number, number] {
  while (start < end && isSpace(source[start])) start++;
  while (end > start && isSpace(source[end - 1])) end--;
  return [start, end];
}

/** The number of `*` that end `left` and start `right`, the smaller one. */
function stars(left: string, right: string): number {
  const before = /\**$/.exec(left)?.[0].length ?? 0;
  const after = /^\**/.exec(right)?.[0].length ?? 0;
  return Math.min(before, after);
}

/**
 * Whether `count` enclosing stars hold the emphasis: bold needs two, italic
 * an odd count (`*x*`, `***x***`); `**x**` is bold, not italic.
 */
const holds = (kind: 'bold' | 'italic', count: number) =>
  kind === 'bold' ? count >= 2 : count % 2 === 1;

/**
 * Bold (`**`) or italic (`*`) around the selection, or removed when the
 * selection is already inside it or includes its markers. An empty selection
 * inserts the pair with the caret between them.
 */
function emphasis(
  kind: 'bold' | 'italic',
  source: string,
  selStart: number,
  selEnd: number,
): MarkdownEdit {
  const n = kind === 'bold' ? 2 : 1;
  const [start, end] =
    selStart === selEnd ? [selStart, selEnd] : inward(source, selStart, selEnd);
  const inner = source.slice(start, end);
  // Markers just outside the selection: remove them.
  if (holds(kind, stars(source.slice(0, start), source.slice(end))))
    return {
      from: start - n,
      to: end + n,
      insert: inner,
      select: [start - n, end - n],
    };
  // Markers at the selection's edges: remove them, keep the rest selected.
  const edge = /^\*+/.exec(inner)?.[0].length ?? 0;
  if (
    inner.length >= 2 * n + 1 &&
    holds(kind, Math.min(edge, /\*+$/.exec(inner)?.[0].length ?? 0))
  ) {
    const content = inner.slice(n, inner.length - n);
    return {
      from: start,
      to: end,
      insert: content,
      select: [start, start + content.length],
    };
  }
  const mark = '*'.repeat(n);
  return {
    from: start,
    to: end,
    insert: mark + inner + mark,
    select: [start + n, start + n + inner.length],
  };
}

/** The lines the selection touches: a selection ending at a line start excludes that line. */
function lineRange(
  source: string,
  start: number,
  end: number,
): [number, number] {
  const last = end > start && source[end - 1] === '\n' ? end - 1 : end;
  const from = source.lastIndexOf('\n', start - 1) + 1;
  const next = source.indexOf('\n', last);
  return [from, next === -1 ? source.length : next];
}

const HEADING = /^(\s{0,3})#{1,6}(?:\s+|$)/;
const SECOND = /^(\s{0,3})##(?:\s+|$)/;
const BULLET = /^(\s*)[-*+]\s+/;
const NUMBERED = /^(\s*)\d{1,9}[.)]\s+/;

/**
 * A prefix on every non-empty line the selection touches (`## `, `- `,
 * `1. `), or removed from all of them when every one has it already. A list
 * replaces the other kind of list, a heading another level.
 */
function linePrefix(
  kind: 'heading' | 'bulletList' | 'numberedList',
  source: string,
  start: number,
  end: number,
): MarkdownEdit {
  const [from, to] = lineRange(source, start, end);
  const lines = source.slice(from, to).split('\n');
  const own = { heading: SECOND, bulletList: BULLET, numberedList: NUMBERED }[
    kind
  ];
  const filled = lines.filter((line) => line.trim() !== '');
  const remove = filled.length > 0 && filled.every((line) => own.test(line));
  // The prefix a line has now: a heading's, or either kind of list's.
  const existing = (line: string) =>
    kind === 'heading'
      ? HEADING.exec(line)
      : (BULLET.exec(line) ?? NUMBERED.exec(line));
  let number = 0;
  // Per line: the length of its old and of its new prefix.
  const prefixes: [number, number][] = [];
  const next = lines.map((line) => {
    // Empty lines between selected ones stay empty; a single empty line
    // takes the prefix, so a list or heading can start there.
    if (line.trim() === '' && lines.length > 1) {
      prefixes.push([0, 0]);
      return line;
    }
    const old = existing(line);
    const indent = old ? (old[1] ?? '') : (/^\s*/.exec(line)?.[0] ?? '');
    const oldLength = old ? old[0].length : indent.length;
    const prefix = remove
      ? ''
      : kind === 'heading'
        ? '## '
        : kind === 'bulletList'
          ? '- '
          : `${++number}. `;
    prefixes.push([oldLength, indent.length + prefix.length]);
    return indent + prefix + line.slice(oldLength);
  });
  const insert = next.join('\n');
  if (start === end) {
    const [oldLength, newLength] = prefixes[0]!;
    const offset = start - from;
    const caret =
      from + (offset <= oldLength ? newLength : offset - oldLength + newLength);
    return { from, to, insert, select: [caret, caret] };
  }
  return { from, to, insert, select: [from, from + insert.length] };
}

const URL_ONLY = /^https?:\/\/\S+$/i;

/**
 * A link around the selection: its text with `https://` selected for the
 * address, or, for a selected address, the address with the caret in the
 * empty text.
 */
function link(source: string, selStart: number, selEnd: number): MarkdownEdit {
  const [start, end] =
    selStart === selEnd ? [selStart, selEnd] : inward(source, selStart, selEnd);
  const inner = source.slice(start, end);
  if (inner === '' || URL_ONLY.test(inner)) {
    const insert = `[](${inner || 'https://'})`;
    return { from: start, to: end, insert, select: [start + 1, start + 1] };
  }
  const insert = `[${inner}](https://)`;
  const address = start + inner.length + 3;
  return {
    from: start,
    to: end,
    insert,
    select: [address, address + 'https://'.length],
  };
}

/**
 * The edit that one formatting action makes to `source` with the selection
 * `[start, end)`.
 */
export function formatMarkdown(
  kind: MarkdownFormat,
  source: string,
  start: number,
  end: number,
): MarkdownEdit {
  const [a, b] = start <= end ? [start, end] : [end, start];
  switch (kind) {
    case 'bold':
    case 'italic':
      return emphasis(kind, source, a, b);
    case 'link':
      return link(source, a, b);
    default:
      return linePrefix(kind, source, a, b);
  }
}
