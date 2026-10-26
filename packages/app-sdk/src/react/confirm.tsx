import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { SdkStyles } from './styles.js';

/**
 * Internal: shows `ref` as a native modal dialog in the browser's top layer
 * while `open`, focuses `initialFocus`, and returns the focus on closing to
 * `returnFocus` or to the element focused before. Without top-layer support
 * (jsdom) the dialog still shows in place.
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  returnFocus?: RefObject<HTMLElement | null>,
  initialFocus?: RefObject<HTMLElement | null>,
) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const back =
      returnFocus?.current ??
      (element.ownerDocument.activeElement as HTMLElement | null);
    if (typeof element.showModal === 'function') {
      if (!element.open) element.showModal();
    } else element.setAttribute('open', '');
    initialFocus?.current?.focus();
    return () => {
      if (typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
      back?.focus();
    };
  }, [ref, open, returnFocus, initialFocus]);
}

/**
 * Internal: a native modal dialog in the browser's top layer. It stays visible
 * and operable above an app's own `showModal()` dialog, while the content
 * behind it (including that dialog) is inert. Cancel has the focus, Escape
 * cancels, Tab stays between the two buttons, and closing returns the focus.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirm,
  cancel,
  onConfirm,
  onCancel,
  ui,
  returnFocus,
}: {
  readonly open: boolean;
  readonly title?: string;
  readonly children: ReactNode;
  readonly confirm: string;
  readonly cancel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** `data-sempods-ui` value, for host styles and tests. */
  readonly ui: string;
  /** Focus after closing; otherwise the element focused when it opened. */
  readonly returnFocus?: RefObject<HTMLElement | null>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const label = useId();
  useModalDialog(dialog, open, returnFocus, stay);
  if (!open) return null;
  return (
    <dialog
      ref={dialog}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={label}
      data-sempods-ui={ui}
      className="sp-sdk-dialog"
      onCancel={(e) => {
        // Escape and other close requests keep everything, as Cancel does.
        e.preventDefault();
        onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          const buttons = e.currentTarget.querySelectorAll('button');
          const target = e.target === buttons[0] ? buttons[1] : buttons[0];
          target?.focus();
        }
      }}
    >
      <SdkStyles />
      {title ? <h2 id={label}>{title}</h2> : null}
      {title ? children : <div id={label}>{children}</div>}
      <div className="sp-sdk-actions">
        <button ref={stay} onClick={onCancel}>
          {cancel}
        </button>
        <button className="sp-sdk-primary" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
