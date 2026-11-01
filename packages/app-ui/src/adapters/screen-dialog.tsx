import type { ReactNode } from 'react';
import { XIcon } from 'lucide-react';
import { Heading } from 'react-aria-components';
import { useSdkLocale } from '@sempods/app-sdk/react';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Dialog } from '../components/dialog.js';

export interface ScreenDialogProps {
  /** The heading; it also names the dialog. */
  readonly title: ReactNode;
  /** Usually derived from the route, for example a resource in the address. */
  readonly open: boolean;
  /**
   * Escape, the heading's Close button or a press beside the dialog ask to
   * close; the dialog closes only when `open` turns false. Run the SDK's
   * guarded close here (`editor.close()`, then leave the route).
   */
  readonly onRequestClose: () => void;
  /** Defaults to the SDK's "Close" text. */
  readonly closeLabel?: string;
  /** Controls in the heading, before Close (for example a `HeaderMenu`). */
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}

/**
 * A routed screen as a modal: full screen below 640px, up to 42rem wide
 * above. Content scrolls inside it; the heading stays.
 */
export function ScreenDialog({
  title,
  open,
  onRequestClose,
  closeLabel,
  actions,
  className,
  children,
}: ScreenDialogProps) {
  const { messages } = useSdkLocale();
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(next) => {
        if (!next) onRequestClose();
      }}
      // SDK confirmations are native top-layer <dialog> elements outside this
      // modal's DOM: a press in them is not a press beside the dialog.
      shouldCloseOnInteractOutside={(element) => !element.closest('dialog')}
      showCloseButton={false}
      className={cn(
        'flex flex-col gap-0 p-0 max-sm:inset-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-0 max-sm:rounded-none sm:max-h-[min(48rem,calc(100dvh-4rem))] sm:max-w-2xl [&>[data-slot=dialog]]:flex [&>[data-slot=dialog]]:min-h-0 [&>[data-slot=dialog]]:flex-1 [&>[data-slot=dialog]]:flex-col',
        className,
      )}
    >
      <header className="flex items-center gap-2 border-b px-4 py-2">
        <Heading slot="title" className="flex-1 text-lg font-medium">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {children}
      </div>
    </Dialog>
  );
}
