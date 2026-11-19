import { useState } from 'react';
import type { CalendarDate } from '@internationalized/date';
import {
  FieldError,
  I18nProvider,
  Label,
  TextField,
} from 'react-aria-components';
import { useSdkLocale } from '@sempods/app-sdk/react';
import { cn } from 'cn';
import { Button } from '../components/button.js';
import { Calendar } from '../components/calendar.js';
import { Input } from '../components/input.js';
import { calendarDay } from './calendar-day.js';
import { useAdapterTexts } from './texts.js';

/** A choice that selects its day in one activation, such as "Tomorrow". */
export interface DateChoicePreset {
  /** The app's own localized label. */
  readonly label: string;
  /** The day it selects, as `YYYY-MM-DD`; the app computes it. */
  readonly day: string;
}

export interface DateChoiceProps {
  /** Names the choice, its calendar and its typed entry. */
  readonly label: string;
  /**
   * The selected day as `YYYY-MM-DD` (a stored value of the SDK's `date`
   * field also works: an optional time zone is kept, a zoned date-time names
   * the day of its own offset), or `null` for none.
   */
  readonly value: string | null;
  /**
   * Receives a preset's day at once, a custom day as `YYYY-MM-DD` on Apply,
   * or `null` from "Remove date". The caller decides when to write it.
   */
  readonly onChange: (value: string | null) => void;
  /** Days that select in one activation, in the order given. */
  readonly presets?: readonly DateChoicePreset[];
  /**
   * The earliest day as `YYYY-MM-DD`: earlier calendar days and presets are
   * disabled, and an earlier typed day is marked invalid.
   */
  readonly min?: string;
  /** Offers "Remove date" while there is a value. */
  readonly optional?: boolean;
  /** Moves the focus to the calendar's selected (or today's) day on mount. */
  readonly autoFocus?: boolean;
  /** Overrides the adapter texts. */
  readonly labels?: {
    readonly apply?: string;
    readonly remove?: string;
    /** The typed entry's label. */
    readonly typed?: string;
  };
  readonly className?: string;
}

/** Why a typed day cannot be applied, if it cannot. */
export type TypedDayError = 'format' | 'min';

/**
 * Reads a typed day: exactly `YYYY-MM-DD`, a day that exists and not before
 * `min`. Nothing is corrected: `2026-02-30` stays invalid rather than
 * becoming 2 March, and a day before `min` stays that day.
 */
export function readTypedDay(
  text: string,
  min?: CalendarDate | null,
): { readonly day: CalendarDate | null; readonly error?: TypedDayError } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return { day: null, error: 'format' };
  const day = calendarDay(text);
  if (!day) return { day: null, error: 'format' };
  if (min && day.compare(min) < 0) return { day, error: 'min' };
  return { day };
}

/** The draft of a custom day: the entry's text and what it names. */
interface Draft {
  readonly text: string;
  readonly day: CalendarDate | null;
  readonly error?: TypedDayError;
}

function draftOf(value: string | null, min: CalendarDate | null): Draft {
  const day = calendarDay(value);
  if (!day) return { text: '', day: null };
  return { text: day.toString(), ...readTypedDay(day.toString(), min) };
}

/**
 * The calendar-day choice without a trigger: an app places it in its own
 * dialog, such as a `ScreenDialog`; `DateChooser` shows the same choice in
 * its popover. Presets select in one activation. A custom day, from the
 * calendar or typed as `YYYY-MM-DD`, takes effect only with Apply. Days are
 * `CalendarDate` values without time or zone; the calendar follows the SDK
 * provider's locale, and every target is 44px.
 */
export function DateChoice(props: DateChoiceProps) {
  return <DateChoiceBody {...props} />;
}

/** `DateChoice` with `DateChooser`'s own placement of the actions. */
export function DateChoiceBody({
  label,
  value,
  onChange,
  presets = [],
  min,
  optional = false,
  autoFocus,
  labels,
  className,
  actionsClassName,
}: DateChoiceProps & { readonly actionsClassName?: string }) {
  const t = useAdapterTexts();
  const { locale, format } = useSdkLocale();
  const minDay = calendarDay(min ?? null);
  // A new value or minimum from the caller, such as a preset's day, starts
  // a new draft; until then the draft is the person's own.
  const [basis, setBasis] = useState({ value, min });
  const [draft, setDraft] = useState(() => draftOf(value, minDay));
  const [focused, setFocused] = useState<CalendarDate | undefined>(
    () => draft.day ?? undefined,
  );
  if (basis.value !== value || basis.min !== min) {
    const next = draftOf(value, minDay);
    setBasis({ value, min });
    setDraft(next);
    if (next.day) setFocused(next.day);
  }
  const type = (text: string) => {
    const read = text === '' ? { day: null } : readTypedDay(text, minDay);
    setDraft({ text, ...read });
    if (read.day) setFocused(read.day);
  };
  const pick = (day: CalendarDate) => {
    setDraft({ text: day.toString(), day });
    setFocused(day);
  };
  const applicable = draft.day && !draft.error ? draft.day : null;
  const message =
    draft.error === 'min' && min
      ? t.dayFrom.replace('{day}', format.dateOnly(min) ?? min)
      : t.dayFormat;
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('grid min-w-0 gap-3', className)}
    >
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {presets.map((preset, i) => {
            const day = calendarDay(preset.day);
            const enabled = !!day && !(minDay && day.compare(minDay) < 0);
            return (
              <Button
                key={`${i}:${preset.label}`}
                variant="outline"
                className="h-auto min-h-11 flex-auto px-3 text-base whitespace-normal"
                isDisabled={!enabled}
                onPress={() => {
                  if (!day) return;
                  // The preset's day replaces the draft also when it is
                  // already the value, so Apply cannot send an older one.
                  pick(day);
                  onChange(day.toString());
                }}
              >
                {preset.label}
              </Button>
            );
          })}
        </div>
      )}
      {/* React Aria reads the browser's locale unless told otherwise. */}
      <I18nProvider locale={locale}>
        <Calendar
          aria-label={label}
          autoFocus={autoFocus}
          value={applicable}
          onChange={pick}
          focusedValue={focused}
          onFocusChange={setFocused}
          minValue={minDay ?? undefined}
          className="justify-self-center bg-transparent p-0 [--cell-size:--spacing(11)]"
        />
      </I18nProvider>
      <TextField
        value={draft.text}
        onChange={type}
        isInvalid={!!draft.error}
        className="grid gap-1.5"
      >
        <Label>{labels?.typed ?? t.typedDay}</Label>
        <Input
          className="h-11 text-base md:text-base"
          autoComplete="off"
          spellCheck={false}
        />
        <FieldError className="text-sm text-destructive">{message}</FieldError>
      </TextField>
      <div className={cn('flex gap-2', actionsClassName)}>
        {optional && value !== null && (
          <Button
            variant="ghost"
            className="h-11 flex-1"
            onPress={() => onChange(null)}
          >
            {labels?.remove ?? t.removeDate}
          </Button>
        )}
        <Button
          className="h-11 flex-1"
          isDisabled={!applicable}
          onPress={() => {
            if (applicable) onChange(applicable.toString());
          }}
        >
          {labels?.apply ?? t.apply}
        </Button>
      </div>
    </div>
  );
}
