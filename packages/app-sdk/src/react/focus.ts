import { useCallback, useRef, type FocusEvent } from 'react';

/**
 * Internal: whether focus is held inside an element, to return it once the
 * element hides or goes. Focus moving to another element ends the hold; a
 * blur to nothing or the body does not, as when a focused button disables
 * itself while its action runs.
 */
export function useFocusHold() {
  const held = useRef(false);
  const onFocusCapture = useCallback(() => {
    held.current = true;
  }, []);
  const onBlurCapture = useCallback((event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (
      next &&
      next !== event.currentTarget.ownerDocument.body &&
      !event.currentTarget.contains(next)
    )
      held.current = false;
  }, []);
  return { held, onFocusCapture, onBlurCapture };
}

/**
 * Internal: returns the focus to `target` from an effect's cleanup.
 *
 * React pauses its event system while it commits, and layout-effect cleanups
 * run within that commit: a focus moved there, by `focus()` or by a closing
 * native dialog, reaches no React `onFocus`. A React Aria button would then
 * hold the focus without knowing it, and show no ring after a keyboard's
 * Escape (#232). Call it after closing a native dialog: the focus moves once
 * the commit has ended, unless something else took it meanwhile. Where the
 * closing dialog left it (its opener, the body or, in WebKit, the enclosing
 * dialog) does not count, and neither does an element around `target`. If it
 * is on `target` already, it leaves and comes back, so that React sees it
 * arrive.
 */
export function returnFocusAfterCommit(target: HTMLElement): void {
  const document = target.ownerDocument;
  const left = document.activeElement;
  queueMicrotask(() => {
    if (!target.isConnected) return;
    const active = document.activeElement;
    if (active === target) target.blur();
    else if (
      active &&
      active !== left &&
      active !== document.body &&
      !active.contains(target)
    )
      return;
    target.focus();
  });
}
