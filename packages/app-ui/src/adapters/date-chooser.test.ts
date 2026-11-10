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
  // 24:00:00 keeps the written day.
  ['2026-10-29T24:00:00Z', '2026-10-29'],
  ['9999-12-31', '9999-12-31'],
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
  ['-0044-03-15'],
  // Year 0000 (1 BCE) is not moved to 0001.
  ['0000-01-01'],
  ['0000-06-01T12:00:00Z'],
  ['10000-01-01'],
  // Forms the SDK's date field refuses name no day either (#268).
  ['2026-10-29+99:99'],
  ['2026-10-29Tgarbage'],
  ['2026-10-29T09:30:00'],
  ['2026-02-30T09:30:00Z'],
])('%s names no day', (value) => {
  expect(calendarDay(value)).toBeNull();
});
