import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  EditorContent,
  useEditor,
  useEditorState,
  type ChainedCommands,
  type Editor,
  type JSONContent,
  type UseEditorOptions,
} from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import {
  BoldIcon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  Redo2Icon,
  StrikethroughIcon,
  Undo2Icon,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '../components/button.js';
import { Input } from '../components/input.js';
import { joinBlocks, serializeBlock, WEB, type DocNode } from './document.js';
import type { MarkdownFieldLabels } from './texts.js';
import { isCommand, ToolButton, ToolGroup } from './tools.js';

/**
 * The text as `MarkdownView` draws it, in a box like the kit's text input:
 * the same paragraphs, headings, lists and links.
 */
const CONTENT =
  'min-h-40 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-base leading-relaxed text-start wrap-anywhere transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 ' +
  '[&_p]:my-3 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 ' +
  '[&_h1]:my-3 [&_h2]:my-3 [&_h3]:my-3 [&_h4]:my-3 [&_h5]:my-3 [&_h6]:my-3 [&_:is(h1,h2,h3,h4,h5,h6)]:text-base [&_:is(h1,h2,h3,h4,h5,h6)]:leading-snug [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_:is(h1,h2,h3,h4,h5,h6):first-child]:mt-0 ' +
  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:ps-6 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:ps-6 [&_li]:my-1 [&_li>p]:my-1 [&_li_ul]:my-1 [&_li_ol]:my-1 ' +
  '[&_a]:underline [&_a]:underline-offset-2 ' +
  '[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-start [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]';

/**
 * The formatting actions in toolbar order: the node or mark each turns on,
 * and its toggle.
 */
const ACTIONS = [
  [
    'heading',
    Heading2Icon,
    'heading',
    { level: 2 },
    (c) => c.toggleHeading({ level: 2 }),
  ],
  [
    'subheading',
    Heading3Icon,
    'heading',
    { level: 3 },
    (c) => c.toggleHeading({ level: 3 }),
  ],
  ['bold', BoldIcon, 'bold', undefined, (c) => c.toggleBold()],
  ['italic', ItalicIcon, 'italic', undefined, (c) => c.toggleItalic()],
  [
    'strikethrough',
    StrikethroughIcon,
    'strike',
    undefined,
    (c) => c.toggleStrike(),
  ],
  [
    'bulletList',
    ListIcon,
    'bulletList',
    undefined,
    (c) => c.toggleBulletList(),
  ],
  [
    'numberedList',
    ListOrderedIcon,
    'orderedList',
    undefined,
    (c) => c.toggleOrderedList(),
  ],
] as const satisfies readonly (readonly [
  keyof MarkdownFieldLabels,
  LucideIcon,
  string,
  { readonly level: number } | undefined,
  (chain: ChainedCommands) => ChainedCommands,
])[];

/**
 * Each top-level block's Markdown, kept for the block it was written for:
 * ProseMirror's nodes never change, so a change writes only its block anew.
 */
const written = new WeakMap<ProseMirrorNode, (string | undefined)[]>();

/** The editor's document as standard Markdown. */
function markdownOf(doc: ProseMirrorNode): string {
  const blocks: { readonly type: string; readonly node: ProseMirrorNode }[] =
    [];
  doc.forEach((node) => blocks.push({ type: node.type.name, node }));
  return joinBlocks(blocks, ({ node }, other) => {
    const kept = written.get(node) ?? [];
    const slot = other ? 1 : 0;
    kept[slot] ??= serializeBlock(node.toJSON() as DocNode, other);
    written.set(node, kept);
    return kept[slot]!;
  });
}

export interface RichEditorProps {
  readonly label: string;
  /** The source; a new one from the app replaces the editor's text. */
  readonly value: string;
  /** The source as the editor's document, read by the field. */
  readonly doc: DocNode;
  readonly placeholder?: string;
  readonly texts: MarkdownFieldLabels;
  /** Where the toolbar goes: the field's top row. */
  readonly toolbar: HTMLElement | null;
  /** Every change the person makes, as Markdown. */
  readonly onChange: (value: string) => void;
  /** Moves the focus into the text, once the editor is there. */
  readonly onReady: (focus: () => void) => void;
}

/** The address of the link at the selection, set, changed or removed. */
function LinkRow({
  editor,
  texts,
  onClose,
}: {
  readonly editor: Editor;
  readonly texts: MarkdownFieldLabels;
  readonly onClose: () => void;
}) {
  const current = editor.getAttributes('link').href as string | undefined;
  const [address, setAddress] = useState(current ?? 'https://');
  const href = address.trim();
  const valid = WEB.test(href);
  const close = () => {
    editor.chain().focus().run();
    onClose();
  };
  const apply = () => {
    if (!valid) return;
    if (editor.state.selection.empty && !current)
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: href,
          marks: [{ type: 'link', attrs: { href } }],
        })
        .run();
    else
      editor
        .chain()
        .focus()
        .extendMarkRange('link')
        .setLink({ href })
        // Typing goes on after the link, not over it or into it.
        .command(({ tr }) => {
          tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
          return true;
        })
        .run();
    onClose();
  };
  // No form of its own: the field is often in one, such as an SDK editor's,
  // which Enter here must not submit.
  return (
    <div
      role="group"
      aria-label={texts.link}
      data-slot="markdown-link"
      className="flex flex-wrap items-center gap-2 rounded-lg bg-muted p-2"
    >
      <Input
        aria-label={texts.address}
        // Opened from the toolbar or Ctrl+K: the address is typed next.
        autoFocus
        type="url"
        inputMode="url"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        onFocus={(event) => event.target.select()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            apply();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}
        className="h-11 min-w-0 flex-1 basis-48"
      />
      <Button className="h-11" isDisabled={!valid} onPress={apply}>
        {texts.apply}
      </Button>
      {current && (
        <Button
          variant="outline"
          className="h-11"
          onPress={() => {
            editor.chain().focus().extendMarkRange('link').unsetLink().run();
            onClose();
          }}
        >
          {texts.removeLink}
        </Button>
      )}
    </div>
  );
}

/**
 * The field's writer for text in the editor's set: formatted as it reads,
 * written back as standard Markdown on every change the person makes.
 * Loaded on demand, so reading a text loads nothing of it.
 */
export default function RichEditor({
  label,
  value,
  doc,
  placeholder,
  texts,
  toolbar,
  onChange,
  onReady,
}: RichEditorProps) {
  // The source the editor's text stands for: the one it read, or wrote last.
  const shown = useRef(value);
  const report = useRef(onChange);
  report.current = onChange;
  const [linking, setLinking] = useState(false);
  const first = useRef(doc);
  // The same options on every render: new ones would update the editor.
  const options = useMemo<UseEditorOptions>(
    () => ({
      extensions: [
        StarterKit.configure({
          blockquote: false,
          code: false,
          codeBlock: false,
          horizontalRule: false,
          underline: false,
          // Nothing the person did not do: no paragraph added after a list.
          trailingNode: false,
          link: {
            openOnClick: false,
            // A typed address stays text, and typing at a link's end does
            // not extend it.
            autolink: false,
            linkOnPaste: true,
            markdownLinks: false,
            defaultProtocol: 'https',
            isAllowedUri: (url) => WEB.test(url),
          },
        }),
        Placeholder.configure({ placeholder: placeholder ?? '' }),
      ],
      content: first.current as JSONContent,
      editorProps: {
        attributes: {
          class: CONTENT,
          role: 'textbox',
          'aria-multiline': 'true',
          'aria-label': label,
          spellcheck: 'true',
        },
        handleKeyDown: (_, event) => {
          if (!isCommand(event) || event.key.toLowerCase() !== 'k')
            return false;
          event.preventDefault();
          // At once, so the address typed next goes into its input.
          flushSync(() => setLinking(true));
          return true;
        },
      },
      onUpdate: ({ editor: changed }) => {
        const next = markdownOf(changed.state.doc);
        if (next === shown.current) return;
        shown.current = next;
        report.current(next);
      },
    }),
    [label, placeholder],
  );
  const editor = useEditor(options);
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      active: ACTIONS.map(([, , name, attrs]) => e.isActive(name, attrs)),
      link: e.isActive('link'),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });

  // A new source from the app, such as a discarded draft, replaces the text
  // and its history: undo must not bring the earlier draft back. A preview
  // keeps both, as nothing new comes from the app.
  useEffect(() => {
    if (value === shown.current) return;
    shown.current = value;
    const { schema, plugins } = editor.state;
    editor.view.updateState(
      EditorState.create({ schema, plugins, doc: schema.nodeFromJSON(doc) }),
    );
    // A transaction that changes nothing, so the toolbar reads the new state.
    editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, value, doc]);
  // Ready once its view is there, which can be after this first effect.
  useEffect(() => {
    const ready = () => onReady(() => editor.chain().focus().run());
    if (editor.isInitialized) {
      ready();
      return;
    }
    editor.on('create', ready);
    return () => {
      editor.off('create', ready);
    };
  }, [editor, onReady]);

  const bar = (
    <ToolGroup label={texts.formatting}>
      {ACTIONS.map(([kind, Icon, , , toggle], i) => (
        <ToolButton
          key={kind}
          label={texts[kind]}
          Icon={Icon}
          pressed={state.active[i]}
          onPress={() => toggle(editor.chain().focus()).run()}
        />
      ))}
      <ToolButton
        label={texts.link}
        Icon={LinkIcon}
        pressed={state.link}
        onPress={() => setLinking((open) => !open)}
      />
      <ToolButton
        label={texts.undo}
        Icon={Undo2Icon}
        disabled={!state.undo}
        onPress={() => editor.chain().focus().undo().run()}
      />
      <ToolButton
        label={texts.redo}
        Icon={Redo2Icon}
        disabled={!state.redo}
        onPress={() => editor.chain().focus().redo().run()}
      />
    </ToolGroup>
  );
  return (
    <div className="grid min-w-0 gap-2">
      {toolbar && createPortal(bar, toolbar)}
      {linking && (
        <LinkRow
          editor={editor}
          texts={texts}
          onClose={() => setLinking(false)}
        />
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
