import { CalendarDate } from '@internationalized/date';
import { classifyDate } from '@sempods/client-sdk/edit';

/**
 * The calendar day a stored value names (a day, or the day a zoned date-time
 * names in its own offset), or `null` when it names none or one outside the
 * years 0001–9999 that `CalendarDate` holds.
 */
export function calendarDay(value: string | null): CalendarDate | null {
  if (value === null) return null;
  const parts = classifyDate(value);
  return parts.kind !== 'unsupported' && parts.year >= 1 && parts.year <= 9999
    ? new CalendarDate(parts.year, parts.month, parts.day)
    : null;
}
