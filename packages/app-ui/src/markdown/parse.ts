import Markdown from 'react-markdown';

/** A node of the Markdown syntax tree (mdast), as far as the field reads it. */
export interface MarkdownNode {
  readonly type: string;
  readonly position?: {
    readonly start: { readonly offset?: number };
    readonly end: { readonly offset?: number };
  };
  readonly children?: readonly MarkdownNode[];
  readonly value?: string;
  readonly url?: string;
}

/** Carries the tree out of the processor, which stops there. */
class Parsed {
  constructor(readonly tree: MarkdownNode) {}
}

const capture = () => (tree: unknown) => {
  throw new Parsed(tree as MarkdownNode);
};

/**
 * The syntax tree of `source`, with source offsets, from the parser that
 * `MarkdownView` renders with, so an edit and the rendered text agree on
 * what is emphasis, a link or code. The processor stops right after
 * parsing: nothing is rendered.
 */
export function parseMarkdown(source: string): MarkdownNode {
  try {
    Markdown({ children: source, remarkPlugins: [capture] });
  } catch (caught) {
    if (caught instanceof Parsed) return caught.tree;
    throw caught;
  }
  throw new Error('The Markdown parser returned no tree.');
}
