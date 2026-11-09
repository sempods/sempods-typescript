import { expect, it } from 'vitest';
import { calendarDay } from './date-chooser.js';

it.each([
  ['2026-10-29', '2026-10-29'],
  // A calendar day with a time zone names the same day.
  ['2026-10-29Z', '2026-10-29'],
  ['2026-10-29+14:00', '2026-10-29'],
  // A zoned date-time starts at the day of its own offset, not the device's.
  ['2026-10-30T09:30:00+02:00', '2026-10-30'],
  ['2026-10-30T23:30:00-11:00', '2026-10-30'],
  ['2024-02-29', '2024-02-29'],
  ['0050-03-01', '0050-03-01'],
  ['0001-01-01', '0001-01-01'],
])('%s names the day %s', (value, day) => {
  expect(calendarDay(value)?.toString()).toBe(day);
});

it.each([
  [null],
  [''],
  ['2026-02-29'],
  ['2026-13-01'],
  ['2026-04-31'],
  ['26-10-29'],
  ['12026-10-29'],
  ['-0044-03-15'],
  // Year 0000 (1 BCE) is not moved to 0001.
  ['0000-01-01'],
  ['0000-06-01T12:00:00Z'],
  ['2026-10-29x'],
])('%s names no day', (value) => {
  expect(calendarDay(value)).toBeNull();
});
