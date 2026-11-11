import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { XIcon } from 'lucide-react';
import { useSdkLocale } from '@sempods/app-sdk/react';
import { cn } from 'cn';
import { Button } from '../components/button.js';

export interface WorkspacePanelProps {
  /** The heading; it also names the panel's region. */
  readonly title: ReactNode;
  /** The panel shows while `open` is true. */
  readonly open: boolean;
  /**
   * Close and Escape, while the focus is in the panel, ask to close; the
   * panel closes only when `open` turns false. A press beside the panel is
   * none: the workspace behind it stays usable.
   */
  readonly onRequestClose: () => void;
  /** Defaults to the SDK's "Close" text. */
  readonly closeLabel?: string;
  /** Controls in the heading, before Close (for example a `HeaderMenu`). */
  readonly actions?: ReactNode;
  /**
   * The edge it floats at from 640px: `end` (default) or `start`, in the
   * reading direction. Below 640px it sits at the bottom, the full width.
   */
  readonly side?: 'start' | 'end';
  /** The heading's level; defaults to 2. */
  readonly headingLevel?: 2 | 3;
  /**
   * Whether opening moves the focus into the panel (default `true`). Turn it
   * off for a panel that follows a selection in the workspace, so the focus
   * stays where the person works.
   */
  readonly autoFocus?: boolean;
  /**
   * Where the focus returns when the panel closes with the focus in it.
   * Defaults to the element that had the focus when it opened.
   */
  readonly focusTarget?: RefObject<HTMLElement | null>;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A nonmodal panel over a workspace, such as filters or details beside a
 * canvas: a named region with a heading and Close, without a backdrop, a
 * focus trap or a press beside it that closes it. It floats over the
 * workspace instead of taking its space, so the workspace keeps its size and
 * stays mounted. Its content scrolls inside it; the heading stays.
 */
export function WorkspacePanel({
  title,
  open,
  onRequestClose,
  closeLabel,
  actions,
  side = 'end',
  headingLevel = 2,
  autoFocus = true,
  focusTarget,
  className,
  children,
}: WorkspacePanelProps) {
  const { messages } = useSdkLocale();
  const headingId = useId();
  const panel = useRef<HTMLElement>(null);
  // The element that had the focus when the panel opened.
  const opener = useRef<HTMLElement | null>(null);
  // The panel stays mounted for one commit after `open` turns false, so the
  // focus can leave it for its opener before it goes.
  const [mounted, setMounted] = useState(open);
  if (open && !mounted) setMounted(true);

  // Only the opening moves the focus, not a later render while open.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    if (!open) return;
    const active = document.activeElement;
    opener.current =
      active instanceof HTMLElement && active !== document.body ? active : null;
    if (autoFocus) panel.current?.focus({ preventScroll: true });
  }, [open, autoFocus]);

  useLayoutEffect(() => {
    if (open || !mounted) return;
    // Focus in the panel returns to its opener; focus the person moved to
    // the workspace stays there.
    if (panel.current?.contains(document.activeElement)) {
      const target = focusTarget?.current ?? opener.current;
      if (target?.isConnected) target.focus({ preventScroll: true });
    }
    opener.current = null;
    setMounted(false);
  }, [open, mounted, focusTarget]);

  if (!mounted) return null;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing
    )
      return;
    // A menu, popover or question it opened closes on its own: those are
    // outside the panel's element, or a dialog inside it.
    const target = event.target as Element;
    if (!panel.current?.contains(target) || target.closest('dialog')) return;
    event.preventDefault();
    onRequestClose();
  };

  return (
    <section
      ref={panel}
      aria-labelledby={headingId}
      tabIndex={-1}
      data-sempods-ui="workspace-panel"
      data-side={side}
      onKeyDown={onKeyDown}
      className={cn(
        // Below SDK dialogs, confirmations and prompts, above the workspace.
        'fixed z-40 flex flex-col text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none',
        // Solid unless the blur keeps the text readable over the workspace;
        // solid again for reduced transparency and more contrast.
        'bg-popover supports-backdrop-filter:bg-popover/90 supports-backdrop-filter:backdrop-blur-md contrast-more:bg-popover contrast-more:backdrop-blur-none forced-colors:border [@media(prefers-reduced-transparency:reduce)]:bg-popover [@media(prefers-reduced-transparency:reduce)]:backdrop-blur-none',
        // Phones: the full width at the bottom, up to 70% of the height, so
        // the workspace stays visible above it.
        'max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[70dvh] max-sm:rounded-t-xl',
        // From 640px: floating at one edge, clear of the safe-area insets
        // (a phone in landscape), as high as its content needs.
        'sm:top-[calc(1rem_+_env(safe-area-inset-top))] sm:max-h-[calc(100dvh_-_2rem_-_env(safe-area-inset-top)_-_env(safe-area-inset-bottom))] sm:w-[min(22rem,calc(100vw_-_2rem))] sm:rounded-xl',
        side === 'end'
          ? 'sm:ltr:right-[calc(1rem_+_env(safe-area-inset-right))] sm:rtl:left-[calc(1rem_+_env(safe-area-inset-left))]'
          : 'sm:ltr:left-[calc(1rem_+_env(safe-area-inset-left))] sm:rtl:right-[calc(1rem_+_env(safe-area-inset-right))]',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b py-1 pr-1 pl-4 max-sm:pr-[calc(0.25rem_+_env(safe-area-inset-right))] max-sm:pl-[calc(1rem_+_env(safe-area-inset-left))]">
        <Heading id={headingId} className="flex-1 text-base font-medium">
          {title}
        </Heading>
        {actions}
        <Button
          variant="ghost"
          size="icon-lg"
          className="size-11"
          aria-label={closeLabel ?? messages.controls.close}
          onPress={onRequestClose}
        >
          <XIcon />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 max-sm:pr-[calc(1rem_+_env(safe-area-inset-right))] max-sm:pb-[calc(1rem_+_env(safe-area-inset-bottom))] max-sm:pl-[calc(1rem_+_env(safe-area-inset-left))]">
        {children}
      </div>
    </section>
  );
}
