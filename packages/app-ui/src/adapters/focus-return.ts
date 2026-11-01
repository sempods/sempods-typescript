import { useEffect, useRef } from 'react';

/**
 * Returns the focus to an overlay's trigger once the overlay has closed and
 * gone, when it fell back to the page or to the enclosing dialog instead.
 * React Aria restores it itself, but inside a modal its restore can lose the
 * race against the modal's focus containment: the focus then lands on the
 * modal and the keyboard position is lost. A focus the person moved elsewhere
 * stays where it is. Attach the returned ref to the trigger.
 */
export function useFocusReturn<T extends HTMLElement>(open: boolean) {
  const trigger = useRef<T>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const closed = wasOpen.current && !open;
    wasOpen.current = open;
    if (!closed) return;
    // The overlay leaves after its exit animation; wait for it, at most 2s.
    const end = performance.now() + 2000;
    let frame = requestAnimationFrame(function check() {
      const element = trigger.current;
      const active = document.activeElement;
      if (!element?.isConnected || active === element) return;
      if (!active || active.contains(element)) {
        element.focus();
        return;
      }
      if (
        performance.now() < end &&
        active.closest(
          '[data-slot="popover-content"], [data-slot^="dropdown-menu"]',
        )
      )
        frame = requestAnimationFrame(check);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return trigger;
}
