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
   * close (a press in an SDK confirmation is none); the dialog closes only
   * when `open` turns false. Run the SDK's guarded close here
   * (`editor.close()`, then leave the route).
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
 * A routed screen as a modal: full screen below 640px wide or 480px high,
 * otherwise up to 42rem wide. Content scrolls inside it; the heading stays,
 * except below 320px high (a phone in landscape with its keyboard open),
 * where it scrolls with the content. Full screen, the heading and the
 * content keep clear of the device's safe-area insets.
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
      showCloseButton={false}
      // Full screen also on a short screen: a wide phone in landscape would
      // otherwise get a centred box without room to scroll once its
      // keyboard leaves about 150px (#314). Below 320px the heading
      // scrolls with the content: Chromium scrolls a focused field to the
      // top of the viewport, which a standing heading would cover. The
      // bare sm:max-w-2xl replaces Dialog's sm:max-w-sm; the arbitrary
      // variants sort after it.
      className={cn(
        'flex flex-col gap-0 p-0 sm:max-w-2xl [@media(width<40rem),(height<30rem)]:inset-0 [@media(width<40rem),(height<30rem)]:h-dvh [@media(width<40rem),(height<30rem)]:max-w-none [@media(width<40rem),(height<30rem)]:translate-0 [@media(width<40rem),(height<30rem)]:rounded-none [@media(width>=40rem)_and_(height>=30rem)]:max-h-[min(48rem,calc(100dvh-4rem))] [&>[data-slot=dialog]]:flex [&>[data-slot=dialog]]:min-h-0 [&>[data-slot=dialog]]:flex-1 [&>[data-slot=dialog]]:flex-col [@media(height<20rem)]:overflow-y-auto [@media(height<20rem)]:[&>[data-slot=dialog]]:min-h-auto',
        className,
      )}
    >
      {/* Full screen, the ordinary padding starts at the device's safe
          area (viewport-fit=cover): below a notch, beside it in landscape,
          above the home indicator. Without insets env() is 0. */}
      <header className="flex items-center gap-2 border-b px-4 py-2 [@media(width<40rem),(height<30rem)]:pt-[calc(0.5rem_+_env(safe-area-inset-top))] [@media(width<40rem),(height<30rem)]:pr-[calc(1rem_+_env(safe-area-inset-right))] [@media(width<40rem),(height<30rem)]:pl-[calc(1rem_+_env(safe-area-inset-left))]">
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
      <div className="min-h-0 flex-1 overflow-y-auto p-4 [@media(height<20rem)]:min-h-auto [@media(height<20rem)]:overflow-visible [@media(width<40rem),(height<30rem)]:pr-[calc(1rem_+_env(safe-area-inset-right))] [@media(width<40rem),(height<30rem)]:pb-[calc(1rem_+_env(safe-area-inset-bottom))] [@media(width<40rem),(height<30rem)]:pl-[calc(1rem_+_env(safe-area-inset-left))] [@media(width>=40rem)_and_(height>=30rem)]:p-6">
        {children}
      </div>
    </Dialog>
  );
}
