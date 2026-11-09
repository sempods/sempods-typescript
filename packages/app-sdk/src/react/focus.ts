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
