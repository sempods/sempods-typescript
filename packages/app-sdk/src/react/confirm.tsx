import {
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import { returnFocusAfterCommit } from './focus.js';
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
      // Not into a dialog that closed first, as the gate around its
      // settings does: the gate's own focus return stands.
      if (back && !back.closest('dialog:not([open])'))
        returnFocusAfterCommit(back);
    };
  }, [ref, open, returnFocus, initialFocus]);
}

/**
 * Internal: marks an SDK modal as part of the top layer for overlay libraries
 * that make everything outside their own overlay `inert` (React Aria's `Modal`
 * and `Popover`, as the UI kit's `Dialog` uses them). They leave such an
 * element and its ancestors alone, so no SDK modal sits below an `[inert]`
 * ancestor: the HTML spec exempts a modal `<dialog>` from it, but test tools
 * such as Playwright 1.65 do not (#264). The background stays inert anyway,
 * blocked by the modal `<dialog>` itself.
 */
export const topLayer = { 'data-react-aria-top-layer': '' } as const;

/**
 * Internal: a lasting place for SDK modals that may open while an app overlay
 * is already open. Such a library marks the page `inert` once, when its
 * overlay opens, and spares only top-layer elements that exist by then, so the
 * slot has to be in the page before the modal mounts into it. It renders no
 * box of its own and keeps the DOM ancestors, so inherited `--sempods-*` tokens
 * and `color-scheme` still apply.
 */
export function TopLayerSlot({ children }: { readonly children: ReactNode }) {
  return (
    <div {...topLayer} style={{ display: 'contents' }}>
      {children}
    </div>
  );
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
      {...topLayer}
      className="sp-sdk-dialog"
      onCancel={(e) => {
        // Escape and other close requests keep everything, as Cancel does.
        e.preventDefault();
        onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // The answer to this question only: an enclosing app dialog that
          // closes on Escape must not close with it.
          e.preventDefault();
          e.stopPropagation();
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
        {/* Inside an app's form, neither answer submits it. */}
        <button ref={stay} type="button" onClick={onCancel}>
          {cancel}
        </button>
        <button type="button" className="sp-sdk-primary" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </dialog>
  );
}
