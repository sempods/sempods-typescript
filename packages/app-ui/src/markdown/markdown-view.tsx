import { memo, useMemo, type ReactNode } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import { cn } from 'cn';
import { strikethrough } from './parse.js';

/** Only these addresses become links; any other stays its text. */
const WEB = /^https?:\/\//i;

type Level = 1 | 2 | 3 | 4 | 5 | 6;

export interface MarkdownViewProps {
  /** The Markdown source as stored, for example a task's `schema:description`. */
  readonly source: string;
  /**
   * The heading level of a `#` heading; deeper ones follow, down to `h6`.
   * Default 3, below a dialog's or a screen's `h2`.
   */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
  readonly className?: string;
}

const block = 'my-3 first:mt-0 last:mb-0';

interface TreeNode {
  type: string;
  value?: string;
  children?: TreeNode[];
}

/**
 * A line break typed in a paragraph shows as one, as a hard break does: each
 * becomes a `<br>`, so a hard break, whose source ends the line too, adds
 * no second one. Spaces at a line's start, which Markdown keeps only when
 * written as `&#32;`, show as the indentation they are.
 */
const typedBreaks = () => (tree: unknown) => {
  const visit = (node: TreeNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): TreeNode[] => {
      visit(child);
      if (child.type !== 'text' || !child.value?.includes('\n')) return [child];
      return child.value
        .split('\n')
        .flatMap((line, i): TreeNode[] => [
          ...(i > 0 ? [{ type: 'break' }] : []),
          ...(line ? [{ type: 'text', value: line }] : []),
        ]);
    });
    if (LINES.has(node.type)) indent(node.children);
  };
  visit(tree as TreeNode);
};

/** Blocks whose text runs in lines. */
const LINES = new Set(['paragraph', 'heading', 'tableCell']);

/**
 * Leading spaces of each line as no-break spaces, which do not collapse. A
 * line starts with the block and after each break, also a break inside
 * emphasis or a link.
 */
function indent(children: TreeNode[], line = { start: true }) {
  for (const child of children) {
    if (child.type === 'break') line.start = true;
    else if (child.type === 'text') {
      if (line.start && child.value)
        child.value = child.value.replace(/^[ \t]+/, (space) =>
          space.replace(/ /g, '\u00a0').replace(/\t/g, '\u00a0'.repeat(4)),
        );
      if (child.value) line.start = false;
    } else if (child.children) indent(child.children, line);
    else line.start = false;
  }
}

const remarkPlugins = [strikethrough, typedBreaks];

function headings(base: number): Partial<Components> {
  const heading =
    (depth: number) =>
    ({ children }: { children?: ReactNode } & ExtraProps) => {
      const level = Math.min(6, base + depth - 1) as Level;
      const Tag = `h${level}` as const;
      return (
        <Tag className={cn(block, 'text-base leading-snug font-semibold')}>
          {children}
        </Tag>
      );
    };
  return {
    h1: heading(1),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
  };
}

/** The elements as the view draws them; none of them requests anything. */
const elements: Partial<Components> = {
  // Text from a Pod may come from any app: reading it fetches no media, so
  // an image shows only its description.
  img: ({ alt }) => (alt ? <span>{alt}</span> : null),
  // A web address opens on the person's press, in a new tab; any other
  // stays text.
  a: ({ href, children }) =>
    href && WEB.test(href) ? (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline underline-offset-2 hover:decoration-2"
      >
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  p: ({ children }) => <p className={block}>{children}</p>,
  ul: ({ children }) => (
    <ul className={cn(block, 'list-disc ps-6')}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className={cn(block, 'list-decimal ps-6')}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li className="my-1 [&>p]:my-1 [&>ol]:my-1 [&>ul]:my-1">{children}</li>
  ),
  blockquote: ({ children }) => (
    <blockquote className={cn(block, 'border-s-2 border-border ps-3')}>
      {children}
    </blockquote>
  ),
  pre: ({ children }) => (
    <pre
      className={cn(
        block,
        'rounded-md bg-muted p-2 font-mono text-sm whitespace-pre-wrap',
      )}
    >
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded-sm bg-muted px-1 font-mono text-[0.9em] in-[pre]:bg-transparent in-[pre]:p-0">
      {children}
    </code>
  ),
  hr: () => <hr className={cn(block, 'border-border')} />,
};

/**
 * Markdown as read-only content: paragraphs, headings, lists, emphasis,
 * strikethrough (`~~text~~`), quotes, code and links that open on a press.
 * Embedded HTML shows as its text and images as their description, so
 * displaying text from a Pod neither runs nor fetches anything. It renders
 * in the first paint, without loading anything first. It parses again only
 * for a new source or heading level, not when its parent renders again.
 */
export const MarkdownView = memo(function MarkdownView({
  source,
  headingLevel = 3,
  className,
}: MarkdownViewProps) {
  const components = useMemo(
    () => ({ ...elements, ...headings(headingLevel) }),
    [headingLevel],
  );
  return (
    <div
      data-slot="markdown-view"
      className={cn(
        'min-w-0 text-base leading-relaxed text-start wrap-anywhere',
        className,
      )}
    >
      <Markdown components={components} remarkPlugins={remarkPlugins}>
        {source}
      </Markdown>
    </div>
  );
});
