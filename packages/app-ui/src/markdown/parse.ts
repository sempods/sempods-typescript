import Markdown from 'react-markdown';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';

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
  readonly title?: string | null;
  readonly depth?: number;
  readonly ordered?: boolean | null;
  readonly start?: number | null;
}

/**
 * GitHub's strikethrough, `~~text~~`, on CommonMark: the one extension that
 * the view, the parser and the editor share. A single `~` stays text.
 */
export function strikethrough(this: { data(): unknown }) {
  const data = this.data() as Record<string, unknown[] | undefined>;
  (data.micromarkExtensions ??= []).push(
    gfmStrikethrough({ singleTilde: false }),
  );
  (data.fromMarkdownExtensions ??= []).push(gfmStrikethroughFromMarkdown());
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
    Markdown({ children: source, remarkPlugins: [strikethrough, capture] });
  } catch (caught) {
    if (caught instanceof Parsed) return caught.tree;
    throw caught;
  }
  throw new Error('The Markdown parser returned no tree.');
}
