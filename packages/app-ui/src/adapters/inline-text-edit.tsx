import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { useSdkLocale } from '@sempods/app-sdk/react';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Input } from '../components/input.js';

/**
 * A key that belongs to an input method's composition: `isComposing`, or
 * keyCode 229, which some input methods report for their confirming key.
 */
const composing = (event: KeyboardEvent) =>
  event.nativeEvent.isComposing || event.keyCode === 229;

export interface InlineTextEditProps {
  /** The input's accessible name in the app's language, e.g. `Rename: Milk`. */
  readonly label: string;
  /** The draft, owned by the app. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /**
   * Enter in the input or Save. Validate and write here; the field stays
   * open until the app closes it. Not called while `pending` or `readOnly`.
   */
  readonly onSave: () => void;
  /**
   * Escape or Cancel: the person ends editing without saving. Not called
   * while `pending`.
   */
  readonly onCancel: () => void;
  /**
   * The focus or a press left the field and its controls (a press beside
   * it, Tab past it): close it without saving, and keep or drop the draft
   * as the app decides. While `pending`, it is called once the write has
   * settled, if the focus is still outside then.
   */
  readonly onDismiss: () => void;
  /**
   * Called after the field unmounted while it held the focus, once the
   * app's render is committed: focus the trigger here. A field closed after
   * the focus left it, also during a slow save, does not call it.
   */
  readonly returnFocus?: () => void;
  /**
   * A write of this value is in flight: the input is read-only, Save shows
   * that it is pending, Cancel is unavailable, and leaving does not dismiss.
   */
  readonly pending?: boolean;
  /**
   * The value cannot be written now, for example without write access or
   * while the row's last write needs a check: the input is read-only and
   * Save unavailable; Cancel and dismissal stay.
   */
  readonly readOnly?: boolean;
  /** The app's validation message: marks the input invalid and describes it. */
  readonly error?: string;
  /** Defaults to the SDK's "Save" text. */
  readonly saveLabel?: string;
  /** Defaults to the SDK's "Cancel" text. */
  readonly cancelLabel?: string;
  /**
   * Shown below the input, as part of the field, for example the row's
   * `UpdateNotice`: moving to its controls keeps the field open.
   */
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * One text value edited in place, for example a list item's name: an input
 * with Save and Cancel, controlled by the app. It focuses and selects the
 * value when it mounts, or once a closing menu that opened it hands the
 * focus back. Moving between its own controls keeps it open;
 * leaving it asks the app to dismiss. The app owns the trigger, the draft,
 * validation, the write and what a dismissal keeps.
 */
export function InlineTextEdit({
  label,
  value,
  onChange,
  onSave,
  onCancel,
  onDismiss,
  returnFocus,
  pending = false,
  readOnly = false,
  error,
  saveLabel,
  cancelLabel,
  children,
  className,
}: InlineTextEditProps) {
  const { messages } = useSdkLocale();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const errorId = useId();
  // The latest props for the document listener and the deferred checks.
  const latest = useRef({ onDismiss, returnFocus, pending });
  useLayoutEffect(() => {
    latest.current = { onDismiss, returnFocus, pending };
  });
  // Asked once per stay: a press beside it and the focus that follows it
  // are one dismissal. The focus coming back starts a new stay.
  const dismissed = useRef(false);
  // The person left during a pending write: dismiss once it has settled.
  const left = useRef(false);
  const leave = () => {
    if (dismissed.current) return;
    if (latest.current.pending) {
      left.current = true;
      return;
    }
    dismissed.current = true;
    latest.current.onDismiss();
  };
  const inside = (node: unknown) =>
    node instanceof Node && Boolean(root.current?.contains(node));

  useLayoutEffect(() => {
    const claim = () => {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    };
    claim();
    const field = root.current;
    // Opened from a menu, the menu keeps the focus until it has closed and
    // then gives it back to its button: take it then, unless the person
    // acts first. A focus that never comes back leaves it after 5s, room
    // for an exit animation that a slow engine stretches.
    const late = !field?.contains(document.activeElement);
    const stop = () => {
      document.removeEventListener('focusin', takeOver, true);
      document.removeEventListener('pointerdown', stop, true);
      document.removeEventListener('keydown', stop, true);
      clearTimeout(expiry);
    };
    const takeOver = (event: FocusEvent) => {
      if (field?.contains(event.target as Node)) return stop();
      stop();
      claim();
    };
    const expiry = late ? setTimeout(stop, 5000) : undefined;
    if (late) {
      document.addEventListener('focusin', takeOver, true);
      document.addEventListener('pointerdown', stop, true);
      document.addEventListener('keydown', stop, true);
    }
    return () => {
      stop();
      // Still in place here: the field's nodes leave after this cleanup.
      // A field still in the page was not closed (StrictMode replays its
      // effects), so it keeps the focus.
      if (field?.contains(document.activeElement))
        queueMicrotask(() => {
          if (!field.isConnected) latest.current.returnFocus?.();
        });
    };
  }, []);

  // A press beside the field. On touch devices a tap on text that takes no
  // focus does not move the focus, so the focus alone would not tell.
  useEffect(() => {
    const press = (event: PointerEvent) => {
      if (event.target === document.documentElement) return; // a scrollbar
      if (!inside(event.target)) leave();
    };
    document.addEventListener('pointerdown', press, true);
    // `leave` and `inside` read refs only, so the first ones stay current.
    return () => document.removeEventListener('pointerdown', press, true);
  }, []);

  // A departure that came during the write is settled now.
  useEffect(() => {
    if (pending || !left.current) return;
    left.current = false;
    if (!inside(document.activeElement)) leave();
  }, [pending]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onBlur = (event: ReactFocusEvent) => {
    if (inside(event.relatedTarget)) return;
    clearTimeout(timer.current);
    // Decided once the focus has landed. The window losing the focus keeps
    // the active element here. A focus dropped on the body is no departure:
    // a control that became disabled or left the page drops it, and so may
    // a press on the field's own plain button (the notice's), which takes
    // no focus in WebKit. A press beside the field is told by its own
    // listener; Tab moves the focus to another element.
    timer.current = setTimeout(() => {
      const active = document.activeElement;
      if (inside(active)) return;
      if (!active || active === document.body) {
        input.current?.focus({ preventScroll: true });
        return;
      }
      leave();
    });
  };
  const onFocus = () => {
    clearTimeout(timer.current);
    dismissed.current = false;
    left.current = false;
  };

  const save = () => {
    if (!pending && !readOnly) onSave();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // An input method's Escape ends its composition, not the edit.
    if (event.key !== 'Escape' || composing(event)) return;
    // Escape ends this edit only, never an enclosing dialog, also while a
    // write is pending and the edit cannot end.
    event.stopPropagation();
    event.preventDefault();
    if (!pending) onCancel();
  };

  return (
    <div
      ref={root}
      // A press on its text keeps the focus inside, so it is no departure.
      tabIndex={-1}
      data-sempods-ui="inline-text-edit"
      aria-busy={pending || undefined}
      className={cn(
        'flex min-w-0 flex-wrap items-center gap-2 outline-none',
        className,
      )}
      onBlur={onBlur}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
    >
      <Input
        ref={input}
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || composing(event)) return;
          event.preventDefault();
          save();
        }}
        readOnly={pending || readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        enterKeyHint="done"
        className="h-11 min-w-[min(100%,12rem)] flex-1 basis-48"
      />
      <span className="ms-auto flex gap-2">
        <Button
          className="h-11 px-4"
          isPending={pending}
          isDisabled={readOnly && !pending}
          onPress={save}
        >
          {pending && (
            <LoaderCircleIcon aria-hidden="true" className="animate-spin" />
          )}
          {saveLabel ?? messages.controls.save}
        </Button>
        <Button
          variant="outline"
          className="h-11 px-4"
          isDisabled={pending}
          onPress={onCancel}
        >
          {cancelLabel ?? messages.controls.cancel}
        </Button>
      </span>
      {error && (
        <p
          id={errorId}
          role="alert"
          className="basis-full text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {children && <div className="min-w-0 basis-full">{children}</div>}
    </div>
  );
}
