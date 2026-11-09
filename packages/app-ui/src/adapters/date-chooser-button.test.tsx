// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SdkLocaleProvider } from '@sempods/app-sdk/react';
import { DateChooser } from './date-chooser.js';

afterEach(cleanup);

/** The button text for a stored value, in German and Berlin time. */
function shown(value: string | null): string {
  render(
    <SdkLocaleProvider locale="de-DE" timeZone="Europe/Berlin">
      <DateChooser label="Start" value={value} onChange={() => {}} optional />
    </SdkLocaleProvider>,
  );
  return screen.getByRole('button', { name: /^Start: / }).textContent ?? '';
}

it.each([
  ['2026-10-29', '29.10.2026'],
  ['2026-10-29Z', '29.10.2026'],
  ['2026-10-29+14:00', '29.10.2026'],
  // A zoned date-time is shown in the provider's zone.
  ['2026-10-30T09:30:00+02:00', '30.10.2026, 08:30'],
  ['2026-10-30T09:30:00Z', '30.10.2026, 10:30'],
  ['2026-10-30T09:30:00.250-01:00', '30.10.2026, 11:30'],
  ['2026-10-30T24:00:00Z', '31.10.2026, 01:00'],
])('shows %s as %s', (value, text) => {
  expect(shown(value)).toBe(text);
});

it.each([
  // Not rolled over to 2 March or 1 May.
  ['2026-02-30'],
  ['2026-04-31'],
  ['2026-02-29'],
  ['2026-02-30T09:30:00Z'],
  // Without a zone, the time would be read in the device's zone.
  ['2026-10-30T09:30:00'],
  // Without seconds, which the SDK's date field rejects.
  ['2026-10-30T09:30+02:00'],
  // A year the formatters cannot show reliably.
  ['12026-10-29'],
  ['-0001-10-29'],
  ['2026-10'],
  ['tomorrow'],
])('shows %s as stored', (value) => {
  expect(shown(value)).toBe(value);
});

it('shows no value with its label', () => {
  expect(shown(null)).toBe('Kein Datum');
});
