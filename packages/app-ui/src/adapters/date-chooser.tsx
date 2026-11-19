import { useState } from 'react';
import { Dialog as AriaDialog } from 'react-aria-components';
import { useSdkLocale } from '@sempods/app-sdk/react';
import { classifyDate } from '@sempods/client-sdk/edit';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Popover, PopoverTrigger } from '../components/popover.js';
import { calendarDay } from './calendar-day.js';
import { DateChoiceBody, type DateChoicePreset } from './date-choice.js';
import { useAdapterTexts } from './texts.js';

export interface DateChooserProps {
  /** Shown above the trigger and in its accessible name. */
  readonly label: string;
  /**
   * The draft value of the SDK's `date` field: a calendar day such as
   * `2026-10-29` (an optional time zone is kept), with `orDateTime` also a
   * zoned date-time, or `null` when the optional field has no value.
   */
  readonly value: string | null;
  /** Receives the applied day as `YYYY-MM-DD`, or `null` when removed. */
  readonly onChange: (value: string | null) => void;
  /** Offers "Remove date" for a value of an optional field. */
  readonly optional?: boolean;
  readonly isDisabled?: boolean;
  /** Days that select and close in one activation (see `DateChoice`). */
  readonly presets?: readonly DateChoicePreset[];
  /** The earliest day as `YYYY-MM-DD` (see `DateChoice`). */
  readonly min?: string;
  /** Overrides the texts for no value, Apply, Remove date and typed entry. */
  readonly labels?: {
    readonly none?: string;
    readonly apply?: string;
    readonly remove?: string;
    readonly typed?: string;
  };
  readonly className?: string;
}

/**
 * Picks a calendar day without a time or time zone (`CalendarDate`), so the
 * stored day does not depend on the device's zone, in a popover that holds
 * a `DateChoice`. The calendar follows the SDK provider's locale (month
 * names, first weekday); days and month buttons are 44px targets. A custom
 * day takes effect only with Apply, a preset at once; Escape or a press
 * beside the chooser keeps the draft.
 */
export function DateChooser({
  label,
  value,
  onChange,
  optional = false,
  isDisabled,
  presets,
  min,
  labels,
  className,
}: DateChooserProps) {
  const t = useAdapterTexts();
  const { format } = useSdkLocale();
  const [open, setOpen] = useState(false);
  // Each opening starts a new choice from the draft, also one that
  // interrupts the popover's exit, which keeps the old choice mounted.
  const [opening, setOpening] = useState(0);
  // A stored zoned date-time starts the chooser at the day of its own offset;
  // it is replaced only when a day is applied.
  const day = calendarDay(value);
  const shown = value === null ? (labels?.none ?? t.noDate) : show(value);
  // A value that names no real day, or a date-time without a zone, is shown
  // as stored: `Date` would roll 30 February over to 2 March or read the
  // time in the device's zone. A day's own zone does not change the day.
  // Only a value the chooser opens on is formatted, so a written year
  // outside 0001–9999 stays as stored even where its instant falls inside.
  function show(stored: string): string {
    if (!day) return stored;
    const parts = classifyDate(stored);
    const formatted =
      parts.kind === 'instant'
        ? format.dateTime(stored)
        : format.dateOnly(day.toString());
    return formatted ?? stored;
  }
  const close = (next: string | null) => {
    onChange(next);
    setOpen(false);
  };
  return (
    <div className={cn('grid gap-1.5', className)}>
      <span>{label}</span>
      <PopoverTrigger
        isOpen={open}
        onOpenChange={(next) => {
          if (next) setOpening((n) => n + 1);
          setOpen(next);
        }}
      >
        <Button
          variant="outline"
          className="h-11 justify-between text-base font-normal"
          aria-label={`${label}: ${shown}`}
          isDisabled={isDisabled}
        >
          {shown}
        </Button>
        {/* React Aria limits the height to the screen; the calendar scrolls. */}
        <Popover
          placement="bottom start"
          className="w-auto overflow-y-auto p-2"
        >
          <AriaDialog aria-label={label} className="outline-none">
            {/* The actions stay at the popover's bottom edge while
                the calendar scrolls on a short screen, above the days
                (z-10). */}
            <DateChoiceBody
              key={opening}
              label={label}
              value={value}
              onChange={close}
              presets={presets}
              min={min}
              optional={optional}
              autoFocus
              labels={labels}
              actionsClassName="sticky -bottom-2 z-20 -mx-2 -mb-2 border-t bg-popover p-2"
            />
          </AriaDialog>
        </Popover>
      </PopoverTrigger>
    </div>
  );
}
