import {
  useDeferredValue,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  BoldIcon,
  EyeIcon,
  Heading2Icon,
  ItalicIcon,
  LinkIcon,
  ListIcon,
  ListOrderedIcon,
  PencilIcon,
} from 'lucide-react';
import { Toolbar } from 'react-aria-components';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Textarea } from '../components/textarea.js';
import { formatMarkdown, type MarkdownFormat } from './format.js';
import { MarkdownView, type MarkdownViewProps } from './markdown-view.js';
import { useMarkdownTexts, type MarkdownFieldLabels } from './texts.js';

/** How the field shows its text: rendered, or as source to write in. */
export type MarkdownPresentation = 'read' | 'write';

export interface MarkdownFieldProps {
  /**
   * The field's accessible name in the app's language, e.g. `Notes`: it
   * names the field's group and its text input.
   */
  readonly label: string;
  /** The Markdown source, owned by the app; `''` for none. */
  readonly value: string;
  /**
   * Every change the person makes, with the source exactly as typed: the
   * field neither trims nor normalizes it. Opening, switching the
   * presentation and leaving never call it.
   */
  readonly onChange: (value: string) => void;
  /**
   * How the field starts: `read` (default) shows the rendered text with an
   * edit action, or only **Add text** while there is none; `write` starts
   * with the text input.
   */
  readonly defaultPresentation?: MarkdownPresentation;
  /**
   * Shows the rendered text only, without an edit action; with no text the
   * field renders nothing.
   */
  readonly readOnly?: boolean;
  /** The text input's placeholder while it is empty. */
  readonly placeholder?: string;
  /** The heading level of a `#` heading in the rendered text. */
  readonly headingLevel?: MarkdownViewProps['headingLevel'];
  /** Replaces the field's own texts, which follow the SDK provider's language. */
  readonly labels?: Partial<MarkdownFieldLabels>;
  readonly className?: string;
}

/** The keys of the formatting shortcuts, with Ctrl, or Command on Apple systems. */
const shortcuts: Readonly<Record<string, MarkdownFormat>> = {
  b: 'bold',
  i: 'italic',
  k: 'link',
};

const apple = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * A Markdown text, controlled by the app: rendered for reading, and written
 * as source with a preview. Writing offers formatting actions that act on
 * the selection (heading, bold, italic, lists, link), with Ctrl or Command
 * + B, I and K; Tab leaves the text input for the next control. One action
 * at the field's top end switches between reading and writing, so it stays
 * in place: editing moves the focus into the text, preview back to that
 * action. A wide field shows the preview beside the source as it is typed.
 * The containing editor owns validation, save, cancel and conflicts.
 */
export function MarkdownField({
  label,
  value,
  onChange,
  defaultPresentation = 'read',
  readOnly = false,
  placeholder,
  headingLevel,
  labels,
  className,
}: MarkdownFieldProps) {
  const t = { ...useMarkdownTexts(), ...labels };
  const [presentation, setPresentation] =
    useState<MarkdownPresentation>(defaultPresentation);
  const writing = presentation === 'write' && !readOnly;
  // Whether the person has written here: from then on the text input stays.
  const [written, setWritten] = useState(writing);
  if (writing && !written) setWritten(true);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  // Whitespace typed while the app's draft holds no text, as an optional
  // field without text keeps it: shown as typed, so the first indented line
  // of a code block can be written.
  const [blank, setBlank] = useState('');
  const shown = value === '' ? blank : value;
  const filled = shown.trim() !== '';
  const preview = useDeferredValue(shown);
  // Where the focus goes after a switch the person made.
  const moved = useRef<'text' | 'toggle' | null>(null);
  // The selection after an edit that the browser could not apply itself.
  const pending = useRef<readonly [number, number] | null>(null);

  useLayoutEffect(() => {
    const target = moved.current;
    moved.current = null;
    if (target === 'text') textarea.current?.focus();
    else if (target === 'toggle') toggle.current?.focus();
  }, [writing]);
  useLayoutEffect(() => {
    const selection = pending.current;
    if (!selection || !textarea.current) return;
    pending.current = null;
    textarea.current.setSelectionRange(selection[0], selection[1]);
  }, [shown]);

  const emit = (source: string) => {
    setBlank(source.trim() === '' ? source : '');
    onChange(source);
  };
  const format = (kind: MarkdownFormat) => {
    const input = textarea.current;
    if (!input) return;
    const source = input.value;
    const edit = formatMarkdown(
      kind,
      source,
      input.selectionStart,
      input.selectionEnd,
    );
    const next =
      source.slice(0, edit.from) + edit.insert + source.slice(edit.to);
    input.focus();
    input.setSelectionRange(edit.from, edit.to);
    // The browser's own text input keeps the edit in its undo history and
    // reaches onChange as typing does.
    try {
      document.execCommand(
        edit.insert === '' ? 'delete' : 'insertText',
        false,
        edit.insert,
      );
    } catch {
      // Not supported: the fallback below applies the edit.
    }
    if (input.value === next) {
      input.setSelectionRange(edit.select[0], edit.select[1]);
      return;
    }
    if (input.value !== source) return;
    pending.current = edit.select;
    emit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.shiftKey) return;
    const command = apple()
      ? event.metaKey && !event.ctrlKey
      : event.ctrlKey && !event.metaKey;
    const kind = command ? shortcuts[event.key.toLowerCase()] : undefined;
    if (!kind) return;
    event.preventDefault();
    format(kind);
  };
  const switchTo = (next: MarkdownPresentation) => {
    moved.current = next === 'write' ? 'text' : 'toggle';
    setPresentation(next);
  };

  if (readOnly && !filled) return null;
  const actions: [MarkdownFormat, string, ReactNode][] = [
    ['heading', t.heading, <Heading2Icon key="heading" />],
    ['bold', t.bold, <BoldIcon key="bold" />],
    ['italic', t.italic, <ItalicIcon key="italic" />],
    ['bulletList', t.bulletList, <ListIcon key="bulletList" />],
    ['numberedList', t.numberedList, <ListOrderedIcon key="numberedList" />],
    ['link', t.link, <LinkIcon key="link" />],
  ];
  const switchLabel = writing ? t.preview : filled ? t.edit : t.addText;
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="markdown-field"
      data-presentation={writing ? 'write' : 'read'}
      className={cn('@container grid min-w-0 gap-2', className)}
    >
      <div className="flex min-h-11 items-start gap-1">
        {writing ? (
          <Toolbar
            aria-label={t.formatting}
            className="flex min-w-0 flex-1 flex-wrap gap-0.5"
          >
            {actions.map(([kind, name, icon]) => (
              <Button
                key={kind}
                variant="ghost"
                className="size-11 text-muted-foreground hover:text-foreground"
                aria-label={name}
                preventFocusOnPress
                onPress={() => format(kind)}
              >
                <span aria-hidden="true" className="contents">
                  {icon}
                </span>
              </Button>
            ))}
          </Toolbar>
        ) : (
          <span className="flex-1" />
        )}
        {!readOnly && (
          <Button
            ref={toggle}
            variant="ghost"
            className={cn(
              'h-11 text-muted-foreground hover:text-foreground',
              writing || filled ? 'w-11' : 'px-3',
            )}
            aria-label={writing || filled ? switchLabel : undefined}
            onPress={() => switchTo(writing ? 'read' : 'write')}
          >
            <span aria-hidden="true" className="contents">
              {writing ? <EyeIcon /> : <PencilIcon />}
            </span>
            {!writing && !filled && t.addText}
          </Button>
        )}
      </div>
      {/* Once written in, the text input stays mounted and is only hidden
          while reading: the browser keeps its undo history across a preview. */}
      {written && (
        <div
          hidden={!writing}
          className={cn(
            'min-w-0 gap-4 @2xl:grid-cols-2',
            writing ? 'grid' : 'hidden',
          )}
        >
          <Textarea
            ref={textarea}
            aria-label={label}
            placeholder={placeholder}
            value={shown}
            spellCheck
            onChange={(event) => emit(event.target.value)}
            onKeyDown={onKeyDown}
            className="min-h-40 text-base leading-relaxed md:text-base"
          />
          {/* Wide: the preview beside the source, as it is typed. */}
          {writing && (
            <div
              role="region"
              aria-label={t.preview}
              className="hidden min-w-0 px-1 @2xl:block"
            >
              <MarkdownView source={preview} headingLevel={headingLevel} />
            </div>
          )}
        </div>
      )}
      {!writing && filled && (
        <MarkdownView source={shown} headingLevel={headingLevel} />
      )}
    </div>
  );
}
