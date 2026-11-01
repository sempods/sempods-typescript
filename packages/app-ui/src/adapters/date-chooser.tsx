import { useState } from 'react';
import { CalendarDate } from '@internationalized/date';
import { Dialog as AriaDialog, I18nProvider } from 'react-aria-components';
import { useSdkLocale } from '@sempods/app-sdk/react';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Calendar } from '../components/calendar.js';
import { Popover, PopoverTrigger } from '../components/popover.js';
import { useFocusReturn } from './focus-return.js';
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
  /** Overrides the texts for no value, Apply and Remove date. */
  readonly labels?: {
    readonly none?: string;
    readonly apply?: string;
    readonly remove?: string;
  };
  readonly className?: string;
}

/**
 * Picks a calendar day without a time or time zone (`CalendarDate`), so the
 * stored day does not depend on the device's zone. The calendar follows the
 * SDK provider's locale (month names, first weekday); days and month buttons
 * are 44px targets. A choice takes effect only with Apply; Escape or a press
 * beside the chooser keeps the draft.
 */
export function DateChooser({
  label,
  value,
  onChange,
  optional = false,
  isDisabled,
  labels,
  className,
}: DateChooserProps) {
  const t = useAdapterTexts();
  const { locale, format } = useSdkLocale();
  const [open, setOpen] = useState(false);
  const trigger = useFocusReturn<HTMLButtonElement>(open);
  // A stored zoned date-time starts the chooser at the day of its own offset;
  // it is replaced only when a day is applied.
  const day = calendarDay(value);
  const [picked, setPicked] = useState<CalendarDate | null>(day);
  const shown = value === null ? (labels?.none ?? t.noDate) : show(value);
  function show(stored: string): string {
    try {
      return day && !stored.includes('T')
        ? format.dateOnly(day.toString())
        : format.dateTime(stored);
    } catch {
      return stored;
    }
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
          setOpen(next);
          if (next) setPicked(day);
        }}
      >
        <Button
          ref={trigger}
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
            {/* React Aria reads the browser's locale unless told otherwise. */}
            <I18nProvider locale={locale}>
              <Calendar
                aria-label={label}
                autoFocus
                value={picked}
                onChange={setPicked}
                className="[--cell-size:--spacing(11)]"
              />
            </I18nProvider>
            {/* The actions stay at the popover's bottom edge while the
                calendar scrolls on a short screen, above the days (z-10). */}
            <div className="sticky -bottom-2 z-20 -mx-2 -mb-2 flex gap-2 border-t bg-popover p-2">
              {optional && value !== null && (
                <Button
                  variant="ghost"
                  className="h-11 flex-1"
                  onPress={() => close(null)}
                >
                  {labels?.remove ?? t.removeDate}
                </Button>
              )}
              <Button
                className="h-11 flex-1"
                isDisabled={!picked}
                onPress={() => {
                  if (picked) close(picked.toString());
                }}
              >
                {labels?.apply ?? t.apply}
              </Button>
            </div>
          </AriaDialog>
        </Popover>
      </PopoverTrigger>
    </div>
  );
}

/** The calendar day a stored value names, or `null` when it names none. */
export function calendarDay(value: string | null): CalendarDate | null {
  const match = value?.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|T|Z|[+-])/);
  if (!match) return null;
  const [year, month, day] = [match[1], match[2], match[3]].map(Number) as [
    number,
    number,
    number,
  ];
  const date = new CalendarDate(year, month, day);
  // CalendarDate constrains an impossible day (31 February) instead of failing.
  return date.month === month && date.day === day ? date : null;
}
