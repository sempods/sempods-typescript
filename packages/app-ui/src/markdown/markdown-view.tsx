import { useMemo, type ReactNode } from 'react';
import Markdown, { type Components, type ExtraProps } from 'react-markdown';
import { cn } from 'cn';

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
 * no second one.
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
  };
  visit(tree as TreeNode);
};
const remarkPlugins = [typedBreaks];

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
 * quotes, code and links that open on a press. Embedded HTML shows as its
 * text and images as their description, so displaying text from a Pod
 * neither runs nor fetches anything. It renders in the first paint, without
 * loading anything first.
 */
export function MarkdownView({
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
}
