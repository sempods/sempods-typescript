import { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor,
  type JSONContent,
} from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
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
import { Toolbar } from 'react-aria-components';
import { Button } from '../components/button.js';
import { Input } from '../components/input.js';
import { fromMarkdown, toMarkdown, type DocNode } from './document.js';
import type { MarkdownFieldLabels } from './texts.js';

const WEB = /^https?:\/\/\S+$/i;

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

type Kind =
  | 'heading'
  | 'subheading'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'bulletList'
  | 'numberedList';

/** The formatting actions in toolbar order: whether each is on, and its toggle. */
const ACTIONS: readonly (readonly [
  Kind,
  LucideIcon,
  (editor: Editor) => boolean,
  (editor: Editor) => void,
])[] = [
  [
    'heading',
    Heading2Icon,
    (e) => e.isActive('heading', { level: 2 }),
    (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
  ],
  [
    'subheading',
    Heading3Icon,
    (e) => e.isActive('heading', { level: 3 }),
    (e) => e.chain().focus().toggleHeading({ level: 3 }).run(),
  ],
  [
    'bold',
    BoldIcon,
    (e) => e.isActive('bold'),
    (e) => e.chain().focus().toggleBold().run(),
  ],
  [
    'italic',
    ItalicIcon,
    (e) => e.isActive('italic'),
    (e) => e.chain().focus().toggleItalic().run(),
  ],
  [
    'strikethrough',
    StrikethroughIcon,
    (e) => e.isActive('strike'),
    (e) => e.chain().focus().toggleStrike().run(),
  ],
  [
    'bulletList',
    ListIcon,
    (e) => e.isActive('bulletList'),
    (e) => e.chain().focus().toggleBulletList().run(),
  ],
  [
    'numberedList',
    ListOrderedIcon,
    (e) => e.isActive('orderedList'),
    (e) => e.chain().focus().toggleOrderedList().run(),
  ],
];

export interface RichEditorProps {
  readonly label: string;
  /** The source; a new one from the app replaces the editor's text. */
  readonly value: string;
  readonly placeholder?: string;
  readonly texts: MarkdownFieldLabels;
  /** Where the toolbar goes: the field's top row. */
  readonly toolbar: HTMLElement | null;
  /** Every change the person makes, as Markdown. */
  readonly onChange: (value: string) => void;
  /** Moves the focus into the text, once the editor is there. */
  readonly onReady: (focus: () => void) => void;
}

function ToolButton({
  label,
  Icon,
  pressed,
  disabled,
  onPress,
}: {
  readonly label: string;
  readonly Icon: LucideIcon;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Button
      variant="ghost"
      className={
        pressed
          ? 'size-11 bg-accent text-foreground hover:text-foreground'
          : 'size-11 text-muted-foreground hover:text-foreground'
      }
      aria-label={label}
      aria-pressed={pressed}
      isDisabled={disabled}
      preventFocusOnPress
      onPress={onPress}
    >
      <span aria-hidden="true" className="contents">
        <Icon />
      </span>
    </Button>
  );
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
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        underline: false,
        // Nothing the person did not do: no paragraph added after a list.
        trailingNode: false,
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: {
          openOnClick: false,
          // A typed address stays text, and typing at a link's end does not
          // extend it.
          autolink: false,
          linkOnPaste: true,
          markdownLinks: false,
          defaultProtocol: 'https',
          isAllowedUri: (url) => WEB.test(url),
        },
      }),
      Placeholder.configure({ placeholder: placeholder ?? '' }),
    ],
    content: (fromMarkdown(value) ?? { type: 'doc' }) as JSONContent,
    editorProps: {
      attributes: {
        class: CONTENT,
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        spellcheck: 'true',
      },
      handleKeyDown: (_, event) => {
        const command =
          (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey;
        if (!command || event.key.toLowerCase() !== 'k') return false;
        event.preventDefault();
        // At once, so the address typed next goes into its input.
        flushSync(() => setLinking(true));
        return true;
      },
    },
    onUpdate: ({ editor: changed }) => {
      const next = toMarkdown(changed.getJSON() as DocNode);
      if (next === shown.current) return;
      shown.current = next;
      report.current(next);
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      active: ACTIONS.map(([, , isActive]) => isActive(e)),
      link: e.isActive('link'),
      undo: e.can().undo(),
      redo: e.can().redo(),
    }),
  });

  // A new source from the app, such as a discarded draft, replaces the text.
  useEffect(() => {
    if (value === shown.current) return;
    const doc = fromMarkdown(value);
    if (!doc) return;
    shown.current = value;
    editor
      .chain()
      .setContent(doc as JSONContent, { emitUpdate: false })
      .run();
  }, [editor, value]);
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
    <Toolbar
      aria-label={texts.formatting}
      className="flex min-w-0 flex-1 flex-wrap gap-0.5"
    >
      {ACTIONS.map(([kind, Icon, , run], i) => (
        <ToolButton
          key={kind}
          label={texts[kind]}
          Icon={Icon}
          pressed={state.active[i]}
          onPress={() => run(editor)}
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
    </Toolbar>
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
