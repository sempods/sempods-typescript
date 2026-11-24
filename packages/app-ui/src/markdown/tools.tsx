import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Toolbar } from 'react-aria-components';
import { Button } from '../components/button.js';

const apple = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/**
 * Whether a key press holds the command key alone: Command on Apple
 * systems, Ctrl elsewhere, without Shift or Alt.
 */
export const isCommand = (event: {
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}) =>
  !event.altKey &&
  !event.shiftKey &&
  (apple() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

/** The writers' toolbar: the arrow keys move along it. */
export function ToolGroup({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <Toolbar
      aria-label={label}
      className="flex min-w-0 flex-1 flex-wrap gap-0.5"
    >
      {children}
    </Toolbar>
  );
}

/**
 * A 44px toolbar action named by its label. A press keeps the focus, and
 * the on-screen keyboard, in the text.
 */
export function ToolButton({
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
