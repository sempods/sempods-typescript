/**
 * The formatting actions of `MarkdownField`, as pure edits of the source: each
 * replaces one range and names the selection after it, so the field can apply
 * it through the browser's own text input and keep its undo history.
 *
 * An action reads the source with the parser that renders it, so it agrees
 * with the preview on what is emphasis, a link or code, and changes only
 * markers it adds or removes. Where its effect is not predictable, such as a
 * selection that cuts into code or a link's address, it is not offered: the
 * edit is `null`. Every edit is checked by parsing its result: text, code
 * and addresses stay as they were.
 */
import { parseMarkdown, type MarkdownNode } from './parse.js';

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

const begin = (node: MarkdownNode) => node.position?.start.offset ?? 0;
const finish = (node: MarkdownNode) => node.position?.end.offset ?? 0;

/**
 * The last source parsed whole, and the signatures of its regions that the
 * checks read: the field asks for every action on the same source.
 */
let last: {
  readonly source: string;
  readonly tree: MarkdownNode;
  readonly regions: Map<string, Signature>;
} | null = null;
function parsed(source: string) {
  if (last?.source !== source)
    last = { source, tree: parseMarkdown(source), regions: new Map() };
  return last;
}
const tree = (source: string) => parsed(source).tree;

/** `source` with `edit` applied. */
export const applyEdit = (source: string, edit: MarkdownEdit) =>
  source.slice(0, edit.from) + edit.insert + source.slice(edit.to);

/** Inline nodes whose source the field never cuts into. */
const ATOMIC = new Set([
  'inlineCode',
  'html',
  'image',
  'imageReference',
  'break',
  'footnoteReference',
]);
const LINKS = new Set(['link', 'linkReference']);
/** Blocks that hold inline text: emphasis and links apply in them only. */
const TEXT_BLOCKS = new Set(['paragraph', 'heading', 'tableCell']);

/** Every node below `node`, in source order. */
function* below(node: MarkdownNode): Generator<MarkdownNode> {
  for (const child of node.children ?? []) {
    yield child;
    yield* below(child);
  }
}

/**
 * The blocks of inline text that `[start, end)` touches, in source order; a
 * caret touches the one it is in or at the edge of.
 */
function textBlocks(
  root: MarkdownNode,
  start: number,
  end: number,
): MarkdownNode[] {
  const found: MarkdownNode[] = [];
  const touches = (node: MarkdownNode) =>
    start === end
      ? begin(node) <= start && start <= finish(node)
      : begin(node) < end && start < finish(node);
  const visit = (node: MarkdownNode) => {
    for (const child of node.children ?? []) {
      if (!touches(child)) continue;
      if (TEXT_BLOCKS.has(child.type)) found.push(child);
      else visit(child);
    }
  };
  visit(root);
  return found;
}

/** The inline content of a block: after a heading's `#`, before its end. */
function content(block: MarkdownNode): [number, number] | null {
  const children = block.children ?? [];
  if (children.length === 0) return null;
  return [begin(children[0]!), finish(children[children.length - 1]!)];
}

const lineStart = (source: string, at: number) =>
  at === 0 ? 0 : source.lastIndexOf('\n', at - 1) + 1;

/**
 * `[start, end)` without whitespace at its edges, and without the quote
 * markers that continue a paragraph's lines inside a quote.
 */
function inward(source: string, start: number, end: number): [number, number] {
  const prefixOnly = (from: number, to: number) =>
    /^[ \t>]*$/.test(source.slice(from, to));
  for (;;) {
    while (start < end && /\s/.test(source[start]!)) start++;
    if (
      start < end &&
      source[start] === '>' &&
      prefixOnly(lineStart(source, start), start)
    )
      start++;
    else break;
  }
  for (;;) {
    while (end > start && /\s/.test(source[end - 1]!)) end--;
    const line = lineStart(source, end);
    if (line > start && end > line && prefixOnly(line, end)) end = line;
    else break;
  }
  return [start, end];
}

/** How a range relates to the inline nodes of its block. */
interface Reading {
  /** Nodes of the asked type that enclose the range, the innermost last. */
  readonly enclosing: MarkdownNode[];
  /** Nodes of the asked type inside the range. */
  readonly inside: MarkdownNode[];
}

/**
 * How `[start, end)` lies in `block`'s inline nodes, or `null` when an
 * action of `type` there would not be predictable: the range cuts into code,
 * HTML or an image, lies in a marker or a link's address, or partly covers a
 * node other than text; for a link, a link around or inside it as well. A
 * caret at a node's edge is outside it.
 */
function read(
  block: MarkdownNode,
  start: number,
  end: number,
  type: string,
): Reading | null {
  const nests = !LINKS.has(type);
  const caret = start === end;
  const enclosing: MarkdownNode[] = [];
  const inside: MarkdownNode[] = [];
  for (const node of below(block)) {
    const [from, to] = [begin(node), finish(node)];
    if (to <= start || from >= (caret ? start : end)) continue;
    if (from <= start && end <= to) {
      if (node.type === 'text') continue;
      if (ATOMIC.has(node.type) || (!nests && LINKS.has(node.type)))
        return null;
      const inner = content(node);
      const whole = from === start && to === end;
      if (!whole && (!inner || start < inner[0] || end > inner[1])) return null;
      if (node.type === type) enclosing.push(node);
      continue;
    }
    if (!caret && start <= from && to <= end) {
      if (!nests && LINKS.has(node.type)) return null;
      if (node.type === type) inside.push(node);
      continue;
    }
    if (node.type !== 'text') return null;
  }
  return { enclosing, inside };
}

/**
 * The stretches of inline text that `[start, end)` selects, one per block
 * and in source order, without whitespace or line prefixes at their edges.
 */
function* stretches(
  source: string,
  root: MarkdownNode,
  start: number,
  end: number,
): Generator<[MarkdownNode, number, number]> {
  for (const block of textBlocks(root, start, end)) {
    const inner = content(block);
    if (!inner) continue;
    const [a, b] = inward(
      source,
      Math.max(start, inner[0]),
      Math.min(end, inner[1]),
    );
    if (a < b) yield [block, a, b];
  }
}

/** A replacement of `remove` characters at `at`. */
interface Op {
  readonly at: number;
  readonly remove: number;
  readonly insert: string;
}

/** The ops applied to `source` as one edit, which they all lie in. */
function combine(
  source: string,
  ops: readonly Op[],
): Omit<MarkdownEdit, 'select'> {
  const sorted = [...ops].sort((a, b) => a.at - b.at || a.remove - b.remove);
  const from = sorted[0]!.at;
  let insert = '';
  let cursor = from;
  for (const op of sorted) {
    insert += source.slice(cursor, op.at) + op.insert;
    cursor = op.at + op.remove;
  }
  return { from, to: cursor, insert };
}

/**
 * Where `at` is after the ops: text inserted at `at` lies before it with
 * `after`, behind it without.
 */
function moved(ops: readonly Op[], at: number, after: boolean): number {
  let shift = 0;
  for (const op of ops) {
    const end = op.at + op.remove;
    if (op.remove > 0 ? at >= end : at > op.at || (after && at === op.at))
      shift += op.insert.length - op.remove;
    else if (op.at < at && at < end) shift += op.at - at;
  }
  return at + shift;
}

type Emphasis = 'strong' | 'emphasis';

const MARK: Readonly<Record<Emphasis, string>> = {
  strong: '**',
  emphasis: '*',
};

/** The ops that take the markers off an emphasis span. */
function unwrap(span: MarkdownNode, type: Emphasis): Op[] {
  const n = MARK[type].length;
  return [
    { at: begin(span), remove: n, insert: '' },
    { at: finish(span) - n, remove: n, insert: '' },
  ];
}

/** What one block's part of an emphasis action does. */
interface Part {
  readonly ops: Op[];
  readonly removes: boolean;
  /** The part's range, which has the emphasis afterwards, or no longer. */
  readonly range: readonly [number, number];
}

/** Whether all of the range's text lies in the spans, as in `***a***`. */
function allIn(
  block: MarkdownNode,
  [start, end]: readonly [number, number],
  spans: readonly MarkdownNode[],
): boolean {
  for (const node of below(block))
    if (
      node.type === 'text' &&
      finish(node) > start &&
      begin(node) < end &&
      !spans.some(
        (span) => begin(span) <= begin(node) && finish(node) <= finish(span),
      )
    )
      return false;
  return true;
}

/**
 * Bold or italic on `[start, end)` within one block, also at a caret:
 * removed from the span that encloses it (as the preview shows it, whether
 * marked with `*` or `_`) or from the spans that hold all its text, or added
 * around it, spans of the same kind inside it merged into one. A range that
 * partly covers such a span grows over all of it.
 */
function emphasisPart(
  type: Emphasis,
  block: MarkdownNode,
  start: number,
  end: number,
): Part | null {
  for (let grown = start < end; grown;) {
    grown = false;
    for (const node of below(block)) {
      if (node.type !== type) continue;
      const [from, to] = [begin(node), finish(node)];
      const partly =
        from < end &&
        start < to &&
        (from < start || to > end) &&
        !(from <= start && end <= to);
      if (!partly) continue;
      [start, end] = [Math.min(start, from), Math.max(end, to)];
      grown = true;
    }
  }
  const reading = read(block, start, end, type);
  if (!reading) return null;
  const range = [start, end] as const;
  const span = reading.enclosing[reading.enclosing.length - 1];
  if (span) return { ops: unwrap(span, type), removes: true, range };
  const unmark = reading.inside.flatMap((node) => unwrap(node, type));
  if (reading.inside.length > 0 && allIn(block, range, reading.inside))
    return { ops: unmark, removes: true, range };
  const mark = MARK[type];
  const ops = [
    { at: start, remove: 0, insert: mark },
    ...unmark,
    { at: end, remove: 0, insert: mark },
  ];
  return { ops, removes: false, range };
}

/**
 * Bold or italic on the selection. Emphasis cannot cross a block, so it
 * applies to each selected paragraph, list item or heading on its own, after
 * its list marker, heading or quote, and leaves code blocks out: removed from
 * all of them when every one has it already, otherwise added where it is
 * missing. A caret inside a span removes it, elsewhere a pair of markers is
 * inserted around it, or removed again.
 */
function emphasis(
  type: Emphasis,
  source: string,
  start: number,
  end: number,
): MarkdownEdit | null {
  const root = tree(source);
  if (start === end) {
    const block = textBlocks(root, start, end)[0];
    const part = block ? emphasisPart(type, block, start, end) : undefined;
    if (part === null) return null;
    if (part?.removes) {
      const at = moved(part.ops, start, true);
      return checked(
        root,
        source,
        { ...combine(source, part.ops), select: [at, at] },
        [{ range: [at, at], type, has: false }],
      );
    }
    const mark = MARK[type];
    const n = mark.length;
    const pair =
      source.slice(start - n, start) === mark &&
      source.slice(start, start + n) === mark;
    const edit: MarkdownEdit = pair
      ? {
          from: start - n,
          to: start + n,
          insert: '',
          select: [start - n, start - n],
        }
      : {
          from: start,
          to: start,
          insert: mark + mark,
          select: [start + n, start + n],
        };
    return checked(root, source, edit, [], { text: false });
  }
  const parts: Part[] = [];
  for (const [block, a, b] of stretches(source, root, start, end)) {
    const part = emphasisPart(type, block, a, b);
    if (!part) return null;
    parts.push(part);
  }
  if (parts.length === 0) return null;
  const removing = parts.every((part) => part.removes);
  const applied = parts.filter((part) => part.removes === removing);
  const ops = applied.flatMap((part) => part.ops);
  const targets = applied.map((part) => ({
    range: [
      moved(ops, part.range[0], true),
      moved(ops, part.range[1], false),
    ] as const,
    type,
    has: !removing,
  }));
  return checked(
    root,
    source,
    {
      ...combine(source, ops),
      select:
        parts.length === 1
          ? targets[0]!.range
          : [moved(ops, start, false), moved(ops, end, true)],
    },
    targets,
  );
}

/** The lines the selection touches: a selection ending at a line start excludes that line. */
function lineRange(
  source: string,
  start: number,
  end: number,
): [number, number] {
  const last = end > start && source[end - 1] === '\n' ? end - 1 : end;
  const from = lineStart(source, start);
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
 * An address as a link destination: in angle brackets, with `<`, `>` and
 * `\\` escaped, when it holds characters that would end or change a plain
 * one, such as an unbalanced `)`.
 */
const destination = (address: string) =>
  /[()<>\\]/.test(address)
    ? '<' + address.replace(/[<>\\]/g, '\\$&') + '>'
    : address;

/**
 * Text as a link's label: a `[` or `]` without its partner would end the
 * label early or move its start, and a backslash at its end would escape
 * the closing `]`, so they are escaped; pairs and escaped ones stay.
 */
function label(text: string): string {
  const open: number[] = [];
  const unmatched = new Set<number>();
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '[') open.push(i);
    else if (text[i] === ']') {
      if (open.length > 0) open.pop();
      else unmatched.add(i);
    }
  }
  for (const i of open) unmatched.add(i);
  // UTF-16 offsets, as found above: an emoji before a bracket counts two.
  let result = '';
  for (let i = 0; i < text.length; i++)
    result += unmatched.has(i) ? '\\' + text[i] : text[i];
  // An odd run of backslashes at the end would escape the closing `]`.
  const trailing = /\\*$/.exec(text)![0].length;
  return trailing % 2 === 1 ? result + '\\' : result;
}

/**
 * A link around the selection's first stretch of inline text, which leaves
 * a block's marker and the blocks after it alone: its text with `https://`
 * selected for the address, or, for a selected address, the address with the
 * caret in the empty text. A link cannot hold another or cut into code, so
 * a selection that would is not linked.
 */
function link(source: string, start: number, end: number): MarkdownEdit | null {
  const root = tree(source);
  if (start === end) {
    const block = textBlocks(root, start, end)[0];
    if (block && !read(block, start, end, 'link')) return null;
    const edit: MarkdownEdit = {
      from: start,
      to: end,
      insert: '[](https://)',
      select: [start + 1, start + 1],
    };
    return checked(root, source, edit, [], {
      text: false,
      link: { at: start, url: 'https://' },
    });
  }
  for (const [block, a, b] of stretches(source, root, start, end)) {
    if (!read(block, a, b, 'link')) return null;
    const text = source.slice(a, b);
    if (URL_ONLY.test(text)) {
      const edit: MarkdownEdit = {
        from: a,
        to: b,
        insert: `[](${destination(text)})`,
        select: [a + 1, a + 1],
      };
      return checked(root, source, edit, [], { link: { at: a, url: text } });
    }
    const name = label(text);
    const address = a + name.length + 3;
    const edit: MarkdownEdit = {
      from: a,
      to: b,
      insert: `[${name}](https://)`,
      select: [address, address + 'https://'.length],
    };
    return checked(root, source, edit, [], {
      link: { at: a, url: 'https://' },
    });
  }
  return null;
}

/** A node of `type` that an edit must have put around a range, or taken off. */
interface Target {
  readonly range: readonly [number, number];
  readonly type: string;
  readonly has: boolean;
}

/** What else the check of an edit expects. */
interface Expect {
  /** Whether the text stays the same; not for inserted markers. */
  readonly text?: boolean;
  /** The link the edit adds, by its start and address. */
  readonly link?: { readonly at: number; readonly url: string };
}

/**
 * The top-level blocks around `[from, to)`, as whole lines: an edit there
 * changes how they parse, but not the blocks before or after them.
 */
function region(
  root: MarkdownNode,
  source: string,
  from: number,
  to: number,
): [number, number] {
  let lo = 0;
  let hi = source.length;
  for (const child of root.children ?? []) {
    if (begin(child) <= from) lo = begin(child);
    if (finish(child) >= to) {
      hi = finish(child);
      break;
    }
  }
  const next = source.indexOf('\n', Math.max(hi, to));
  return [
    lineStart(source, Math.min(lo, from)),
    next === -1 ? source.length : next,
  ];
}

/**
 * What a reader gets from a tree besides its formatting: its text without
 * whitespace, and its code, HTML and addresses in order. The link `added`
 * is left out of them, its address counted as text if it has none.
 */
interface Signature {
  readonly text: string;
  readonly marks: string;
  readonly found: boolean;
}

function signature(
  root: MarkdownNode,
  added?: { readonly at: number; readonly url: string },
): Signature {
  let text = '';
  const marks: string[] = [];
  let found = false;
  for (const node of below(root)) {
    if (node.type === 'text') text += node.value;
    else if (['inlineCode', 'code', 'html'].includes(node.type))
      marks.push(`${node.type} ${node.value}`);
    if (node.url === undefined) continue;
    if (
      added &&
      !found &&
      node.type === 'link' &&
      begin(node) === added.at &&
      node.url === added.url
    ) {
      found = true;
      if (!node.children?.length) text += node.url;
    } else marks.push(`${node.type} ${node.url}`);
  }
  return { text: text.replace(/\s+/g, ''), marks: marks.join('\n'), found };
}

/**
 * Whether a node of `type` in `node`'s tree covers `[a, b)`, or holds the
 * caret `a` inside it; only nodes around the range are visited.
 */
function covers(
  node: MarkdownNode,
  type: string,
  a: number,
  b: number,
): boolean {
  for (const child of node.children ?? []) {
    const [from, to] = [begin(child), finish(child)];
    if (a < b ? from > a || b > to : from >= a || a >= to) continue;
    if (child.type === type || covers(child, type, a, b)) return true;
  }
  return false;
}

/**
 * `edit`, if parsing its result shows what it means to do: the targets have
 * their emphasis, or no longer, the added link is there, and the text, code,
 * HTML and addresses stay as they were; otherwise `null`. Only the blocks
 * around the edit are parsed again.
 */
function checked(
  root: MarkdownNode,
  source: string,
  edit: MarkdownEdit,
  targets: readonly Target[],
  expect: Expect = {},
): MarkdownEdit | null {
  const next = applyEdit(source, edit);
  const delta = edit.insert.length - (edit.to - edit.from);
  const [lo, hi] = region(root, source, edit.from, edit.to);
  const { regions } = parsed(source);
  const key = `${lo}:${hi}`;
  const before =
    regions.get(key) ??
    signature(
      lo === 0 && hi === source.length
        ? root
        : parseMarkdown(source.slice(lo, hi)),
    );
  regions.set(key, before);
  const result = parseMarkdown(next.slice(lo, hi + delta));
  const added = expect.link && {
    at: expect.link.at - lo,
    url: expect.link.url,
  };
  const after = signature(result, added);
  if (added && !after.found) return null;
  if (before.marks !== after.marks) return null;
  if (expect.text !== false && before.text !== after.text) return null;
  for (const target of targets) {
    const [a, b] = [target.range[0] - lo, target.range[1] - lo];
    if (covers(result, target.type, a, b) !== target.has) return null;
  }
  return edit;
}

/**
 * The edit that one formatting action makes to `source` with the selection
 * `[start, end)`, or `null` where its effect would not be predictable.
 */
export function formatMarkdown(
  kind: MarkdownFormat,
  source: string,
  start: number,
  end: number,
): MarkdownEdit | null {
  const [a, b] = start <= end ? [start, end] : [end, start];
  switch (kind) {
    case 'bold':
      return emphasis('strong', source, a, b);
    case 'italic':
      return emphasis('emphasis', source, a, b);
    case 'link':
      return link(source, a, b);
    default:
      return checked(tree(source), source, linePrefix(kind, source, a, b), []);
  }
}
