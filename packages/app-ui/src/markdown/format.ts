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

type Emphasis = 'bold' | 'italic';

/** A run of stars that can mark `kind`, and the run it pairs with. */
interface Marker {
  readonly at: number;
  readonly open: boolean;
  readonly close: boolean;
  mate: number;
}

/** The ranges of code spans, whose stars are text. */
function codeSpans(text: string): [number, number][] {
  const ticks = [...text.matchAll(/`+/g)];
  const spans: [number, number][] = [];
  for (let i = 0; i < ticks.length; i++) {
    const open = ticks[i]!;
    const j = ticks.findIndex(
      (tick, k) => k > i && tick[0].length === open[0].length,
    );
    if (j < 0) continue;
    const close = ticks[j]!;
    spans.push([open.index, close.index + close[0].length]);
    i = j;
  }
  return spans;
}

/**
 * The star runs in `text` that can mark `kind`, paired as emphasis pairs:
 * a run opens before text and closes after it, as CommonMark's flanking
 * rule has it in short. Stars in code spans, escaped stars and stars
 * between spaces, such as `2 * 3`, are text and never paired.
 */
function markers(kind: Emphasis, text: string): Marker[] {
  const code = codeSpans(text);
  const found: Marker[] = [];
  for (const run of text.matchAll(/\*+/g)) {
    const at = run.index;
    if (text[at - 1] === '\\' || !holds(kind, run[0].length)) continue;
    if (code.some(([from, to]) => at >= from && at < to)) continue;
    const before = text[at - 1];
    const after = text[at + run[0].length];
    found.push({
      at,
      open: after !== undefined && !isSpace(after),
      close: before !== undefined && !isSpace(before),
      mate: -1,
    });
  }
  const stack: number[] = [];
  found.forEach((marker, i) => {
    if (marker.close && stack.length > 0) {
      const j = stack.pop()!;
      marker.mate = j;
      found[j]!.mate = i;
    } else if (marker.open) stack.push(i);
  });
  return found;
}

/**
 * `text` without the `kind` markers of every paired run, except those at
 * the given positions; unpaired stars stay as they are. A run loses the
 * stars of `kind` only, so `***x***` keeps the other emphasis.
 */
function unmark(
  kind: Emphasis,
  text: string,
  found: readonly Marker[],
  keep: readonly number[] = [],
): string {
  const n = kind === 'bold' ? 2 : 1;
  let result = '';
  let from = 0;
  for (const marker of found) {
    if (marker.mate < 0 || keep.includes(marker.at)) continue;
    result += text.slice(from, marker.at);
    from = marker.at + n;
  }
  return result + text.slice(from);
}

/**
 * Bold (`**`) or italic (`*`) around the selection, or removed when the
 * selection is already inside it or includes its markers. A selection that
 * holds spans of its own (`**a** and **b**`) is no one span: their markers
 * are merged into one pair around the whole selection. Stars that are text
 * stay. An empty selection inserts the pair with the caret between them.
 */
function emphasis(
  kind: Emphasis,
  source: string,
  selStart: number,
  selEnd: number,
): MarkdownEdit {
  const n = kind === 'bold' ? 2 : 1;
  const mark = '*'.repeat(n);
  const [start, end] =
    selStart === selEnd ? [selStart, selEnd] : inward(source, selStart, selEnd);
  const inner = source.slice(start, end);
  // Markers just outside the selection: as if they were part of it.
  if (holds(kind, stars(source.slice(0, start), source.slice(end)))) {
    const marked = mark + inner + mark;
    const found = markers(kind, marked);
    const last = found.length - 1;
    // They enclose one span, or nothing yet: remove them.
    if (
      inner === '' ||
      (found[0]?.at === 0 && found[0].mate === last && last > 0)
    )
      return {
        from: start - n,
        to: end + n,
        insert: inner,
        select: [start - n, end - n],
      };
    // Spans of the selection's own join the enclosing one.
    const plain = unmark(kind, marked, found, [0, marked.length - n]).slice(
      n,
      -n,
    );
    return {
      from: start,
      to: end,
      insert: plain,
      select: [start, start + plain.length],
    };
  }
  const found = markers(kind, inner);
  const last = found.length - 1;
  // Markers at the selection's edges that enclose one span: remove them,
  // keep the rest selected.
  if (
    last > 0 &&
    found[0]!.at === 0 &&
    found[0]!.mate === last &&
    found[last]!.at + n === inner.length
  ) {
    const content = unmark(
      kind,
      inner,
      found,
      found.slice(1, last).map((m) => m.at),
    );
    return {
      from: start,
      to: end,
      insert: content,
      select: [start, start + content.length],
    };
  }
  const plain = unmark(kind, inner, found);
  return {
    from: start,
    to: end,
    insert: mark + plain + mark,
    select: [start + n, start + n + plain.length],
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
