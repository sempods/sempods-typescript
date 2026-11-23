import {
  lazy,
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
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
  type LucideIcon,
} from 'lucide-react';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Textarea } from '../components/textarea.js';
import { fromMarkdown, toMarkdown, type DocNode } from './document.js';
import { applyEdit, formatMarkdown, type MarkdownFormat } from './format.js';
import { MarkdownView, type MarkdownViewProps } from './markdown-view.js';
import type { RichEditorProps } from './rich-editor.js';
import { useMarkdownTexts, type MarkdownFieldLabels } from './texts.js';
import { isCommand, ToolButton, ToolGroup } from './tools.js';

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
   * Every change the person makes. Written formatted, the text arrives as
   * standard Markdown, the whole text written one way from the first change;
   * written as Markdown, it arrives exactly as typed, neither trimmed nor
   * normalized, though the browser's text input reports its line endings as
   * `\n`, including on untouched lines. Opening, switching the presentation
   * and leaving never call it.
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

/** The toolbar's actions in order, each named by its text of the same key. */
const actions = [
  ['heading', Heading2Icon],
  ['bold', BoldIcon],
  ['italic', ItalicIcon],
  ['bulletList', ListIcon],
  ['numberedList', ListOrderedIcon],
  ['link', LinkIcon],
] as const satisfies readonly (readonly [MarkdownFormat, LucideIcon])[];
const kinds = actions.map(([kind]) => kind);

/** The writer for text in its set, loaded once the field may need it. */
const loadRichEditor = () => import('./rich-editor.js');

/** Where the writer cannot load, as offline: the field writes Markdown. */
function Unavailable({
  onUnavailable,
}: {
  readonly onUnavailable: () => void;
}) {
  useEffect(onUnavailable, [onUnavailable]);
  return null;
}
const RichEditor = lazy<ComponentType<RichEditorProps>>(() =>
  loadRichEditor().catch(() => ({ default: Unavailable })),
);

/** The field's width from which the preview stands beside the source. */
const WIDE_REM = 42;

/**
 * The rich editor's document for `value`, or `null` when the text holds
 * more than it edits, or something it would not write back as it reads.
 */
function writable(value: string): DocNode | null {
  const doc = fromMarkdown(value);
  if (!doc) return null;
  const again = fromMarkdown(toMarkdown(doc));
  return JSON.stringify(again) === JSON.stringify(doc) ? doc : null;
}

/**
 * A Markdown text, controlled by the app: rendered for reading, and written
 * as it reads. Text of paragraphs, headings, bold, italic, strikethrough,
 * web links and lists is written formatted, without Markdown's characters,
 * and reported as standard Markdown; a toolbar and Ctrl or Command + B, I
 * and K format the selection. A text with anything else, such as code or a
 * quote from another app, is written as Markdown source with a preview, so
 * nothing in it is lost. One action at the field's top end switches between
 * reading and writing, so it stays in place: editing moves the focus into
 * the text, preview back to that action. The containing editor owns
 * validation, save, cancel and conflicts.
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
  const root = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const filled = value.trim() !== '';
  const preview = useDeferredValue(value);
  // Whether the field is wide enough for the preview beside the source.
  const [wide, setWide] = useState(false);
  // The actions the selection does not allow, checked once it rests.
  const [unavailable, setUnavailable] = useState<readonly MarkdownFormat[]>([]);
  const check = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Where the focus goes after a switch the person made.
  const moved = useRef<'text' | 'toggle' | null>(null);
  // Whether the text is written formatted, and the value that holds for: the
  // field's own last change, or the app's value it was decided for. Any
  // other value from the app is decided again.
  const [syntax, setSyntax] = useState<{
    readonly value: string;
    /** The rich editor's document, or `null` for the Markdown writer. */
    readonly doc: DocNode | null;
  } | null>(null);
  if (written && syntax?.value !== value)
    setSyntax({ value, doc: writable(value) });
  const doc = syntax?.doc ?? null;
  // Whether the rich writer failed to load: the Markdown writer stands in.
  const [failed, setFailed] = useState(false);
  const rich = doc !== null && !failed;
  // The rich editor's focus, once it is there, and a focus asked for before.
  const focusRich = useRef<(() => void) | null>(null);
  const focusWaits = useRef(false);
  const onRichReady = useCallback((focus: () => void) => {
    focusRich.current = focus;
    if (!focusWaits.current) return;
    focusWaits.current = false;
    focus();
  }, []);
  const onRichUnavailable = useCallback(() => {
    // A focus that waited for the rich writer goes to the text input.
    if (focusWaits.current) moved.current = 'text';
    focusWaits.current = false;
    setFailed(true);
  }, []);
  // Where the rich editor's toolbar goes.
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  // The selection after an edit that the browser could not apply itself.
  const pending = useRef<readonly [number, number] | null>(null);

  useLayoutEffect(() => {
    const target = moved.current;
    moved.current = null;
    if (target === 'toggle') toggle.current?.focus();
    if (target !== 'text') return;
    if (!rich) textarea.current?.focus();
    else if (focusRich.current) focusRich.current();
    else focusWaits.current = true;
  }, [writing, rich]);
  // Loaded after the first paint, so pressing Edit text finds it there.
  useEffect(() => {
    if (readOnly) return;
    const load = () => void loadRichEditor().catch(() => {});
    if (typeof requestIdleCallback === 'undefined') {
      const timer = setTimeout(load, 1000);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(load);
    return () => cancelIdleCallback(idle);
  }, [readOnly]);
  useLayoutEffect(() => {
    const selection = pending.current;
    if (!selection || !textarea.current) return;
    pending.current = null;
    textarea.current.setSelectionRange(selection[0], selection[1]);
  }, [value]);
  useLayoutEffect(() => {
    const field = root.current;
    // Only the Markdown writer shows a preview beside it.
    if (!writing || rich || !field) return;
    const measure = () => {
      const rem =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setWide(field.getBoundingClientRect().width >= WIDE_REM * rem);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(field);
    return () => observer.disconnect();
  }, [writing, rich]);

  // Reads the source again once the selection rests, not on every key.
  const recheck = () => {
    clearTimeout(check.current);
    check.current = setTimeout(() => {
      const input = textarea.current;
      if (!input) return;
      const next = kinds.filter(
        (kind) =>
          !formatMarkdown(
            kind,
            input.value,
            input.selectionStart,
            input.selectionEnd,
          ),
      );
      setUnavailable((now) => (now.join() === next.join() ? now : next));
    }, 150);
  };
  useEffect(() => {
    if (writing && !rich) recheck();
  }, [value, writing, rich]);
  useEffect(() => () => clearTimeout(check.current), []);

  const emit = (next: string) => {
    setSyntax((now) => now && { ...now, value: next });
    onChange(next);
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
    if (!edit) return;
    const next = applyEdit(source, edit);
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
    if (event.nativeEvent.isComposing || !isCommand(event)) return;
    const kind = shortcuts[event.key.toLowerCase()];
    if (!kind) return;
    event.preventDefault();
    format(kind);
  };
  const switchTo = (next: MarkdownPresentation) => {
    moved.current = next === 'write' ? 'text' : 'toggle';
    setPresentation(next);
  };

  if (readOnly && !filled) return null;
  // The preview stands beside the source.
  const beside = writing && wide && !rich;
  const switchLabel = writing ? t.preview : filled ? t.edit : t.addText;
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      data-slot="markdown-field"
      data-presentation={writing ? 'write' : 'read'}
      className={cn('grid min-w-0', className)}
    >
      <div className="flex min-h-11 items-start gap-1">
        {writing && rich ? (
          <div ref={setSlot} className="flex min-w-0 flex-1" />
        ) : writing ? (
          <ToolGroup label={t.formatting}>
            {actions.map(([kind, Icon]) => (
              <ToolButton
                key={kind}
                label={t[kind]}
                Icon={Icon}
                disabled={unavailable.includes(kind)}
                onPress={() => format(kind)}
              />
            ))}
          </ToolGroup>
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
          while reading, so the browser keeps its undo history across a
          preview. Hiding changes no display, position or overflow, which
          makes Firefox rebuild the input and drop that history: its row
          collapses to 0fr, invisible and inert. */}
      {written && (
        <div
          inert={!writing}
          style={{
            display: 'grid',
            gridTemplateRows: writing ? '1fr' : '0fr',
            marginTop: writing ? '0.5rem' : 0,
            visibility: writing ? 'visible' : 'hidden',
          }}
        >
          {/* Room for the focus ring, which the clip would cut. */}
          <div
            style={{
              minHeight: 0,
              overflow: 'hidden',
              padding: '0.25rem',
              margin: '-0.25rem',
            }}
          >
            {rich ? (
              <Suspense
                fallback={
                  <div
                    aria-busy="true"
                    className="min-h-40 rounded-lg border border-input px-2.5 py-2"
                  >
                    <MarkdownView source={value} headingLevel={headingLevel} />
                  </div>
                }
              >
                <RichEditor
                  label={label}
                  value={value}
                  doc={doc}
                  placeholder={placeholder}
                  texts={t}
                  toolbar={slot}
                  onChange={emit}
                  onReady={onRichReady}
                  onUnavailable={onRichUnavailable}
                />
              </Suspense>
            ) : (
              <div className="grid min-w-0 gap-2">
                <p className="text-sm text-muted-foreground">
                  {t.markdownOnly}
                </p>
                <div
                  className="grid min-w-0 gap-4"
                  style={
                    beside
                      ? { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }
                      : undefined
                  }
                >
                  <Textarea
                    ref={textarea}
                    aria-label={label}
                    placeholder={placeholder}
                    value={value}
                    spellCheck
                    onChange={(event) => emit(event.target.value)}
                    onSelect={recheck}
                    onKeyDown={onKeyDown}
                    className="min-h-40 text-base leading-relaxed md:text-base"
                  />
                  {/* Wide: the preview beside the source, as it is typed;
                      only there, so a narrow field parses nothing while
                      typing. */}
                  {beside && (
                    <div
                      role="region"
                      aria-label={t.preview}
                      className="min-w-0 px-1"
                    >
                      <MarkdownView
                        source={preview}
                        headingLevel={headingLevel}
                      />
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {!writing && filled && (
        <MarkdownView
          source={value}
          headingLevel={headingLevel}
          className="mt-2"
        />
      )}
    </div>
  );
}
