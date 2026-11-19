// @vitest-environment jsdom
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CalendarDate } from '@internationalized/date';
import { SdkLocaleProvider } from '@sempods/app-sdk/react';
import {
  DateChoice,
  readTypedDay,
  type DateChoiceProps,
} from './date-choice.js';

afterEach(cleanup);

describe('readTypedDay', () => {
  const min = new CalendarDate(2026, 11, 20);
  it.each([
    ['2026-11-20', '2026-11-20'],
    ['2026-12-01', '2026-12-01'],
    ['2028-02-29', '2028-02-29'],
  ])('reads %s', (text, day) => {
    const read = readTypedDay(text, min);
    expect(read.error).toBeUndefined();
    expect(read.day?.toString()).toBe(day);
  });

  it.each([
    // Not rolled over to 2 March or 1 May.
    ['2026-02-30'],
    ['2026-04-31'],
    ['2027-02-29'],
    ['2026-13-01'],
    ['0000-01-01'],
    // Only exactly YYYY-MM-DD: no zone, no time, no short forms.
    ['2026-12-01Z'],
    ['2026-12-01T00:00:00Z'],
    ['2026-12-1'],
    ['20261201'],
    [' 2026-12-01'],
    ['tomorrow'],
  ])('refuses %s', (text) => {
    expect(readTypedDay(text, min)).toEqual({ day: null, error: 'format' });
  });

  it('keeps a day before the minimum as that day and marks it', () => {
    const read = readTypedDay('2026-11-19', min);
    expect(read.error).toBe('min');
    expect(read.day?.toString()).toBe('2026-11-19');
    expect(readTypedDay('2026-11-19')).toEqual({ day: read.day });
  });
});

const presets = [
  { label: 'Heute', day: '2026-11-19' },
  { label: 'Morgen', day: '2026-11-20' },
  { label: 'Nächste Woche', day: '2026-11-26' },
];

function renderChoice(props: Partial<DateChoiceProps> = {}) {
  const onChange = vi.fn();
  render(
    <SdkLocaleProvider locale="de-DE" timeZone="Europe/Berlin">
      <DateChoice
        label="Nicht heute"
        value={null}
        onChange={onChange}
        {...props}
      />
    </SdkLocaleProvider>,
  );
  return onChange;
}

const typed = () => screen.getByRole('textbox', { name: 'Tag (JJJJ-MM-TT)' });
const type = (text: string) =>
  fireEvent.change(typed(), { target: { value: text } });

it('selects a preset in one activation', () => {
  const onChange = renderChoice({ presets });
  fireEvent.click(screen.getByRole('button', { name: 'Morgen' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-11-20');
});

it('disables a preset before the minimum and keeps it visible', () => {
  const onChange = renderChoice({ presets, min: '2026-11-20' });
  const today = screen.getByRole('button', { name: 'Heute' });
  expect(today.hasAttribute('disabled')).toBe(true);
  fireEvent.click(today);
  expect(onChange).not.toHaveBeenCalled();
  expect(
    screen.getByRole('button', { name: 'Morgen' }).hasAttribute('disabled'),
  ).toBe(false);
});

it('applies a typed day only with Apply', () => {
  const onChange = renderChoice();
  const apply = screen.getByRole('button', { name: 'Übernehmen' });
  expect(apply.hasAttribute('disabled')).toBe(true);
  type('2026-12-24');
  expect(onChange).not.toHaveBeenCalled();
  expect(apply.hasAttribute('disabled')).toBe(false);
  expect(typed().getAttribute('aria-invalid')).toBeNull();
  // The calendar shows the typed day.
  expect(
    screen
      .getByRole('gridcell', { selected: true })
      .textContent?.includes('24'),
  ).toBe(true);
  fireEvent.click(apply);
  expect(onChange).toHaveBeenCalledExactlyOnceWith('2026-12-24');
});

it('marks a day that does not exist and disables Apply', () => {
  const onChange = renderChoice({ value: '2026-11-25' });
  type('2026-02-30');
  expect(typed().getAttribute('aria-invalid')).toBe('true');
  const message = 'Gib einen Tag ein, den es gibt, als JJJJ-MM-TT.';
  expect(screen.getByText(message)).toBeTruthy();
  expect(typed().getAttribute('aria-describedby')).toContain(
    screen.getByText(message).id,
  );
  expect(
    screen.getByRole('button', { name: 'Übernehmen' }).hasAttribute('disabled'),
  ).toBe(true);
  // Nothing corrected the entry.
  expect((typed() as HTMLInputElement).value).toBe('2026-02-30');
  expect(onChange).not.toHaveBeenCalled();
});

it('marks a typed day before the minimum with the localized minimum', () => {
  renderChoice({ min: '2026-11-20' });
  type('2026-11-19');
  expect(typed().getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Wähle 20.11.2026 oder später.')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Übernehmen' }).hasAttribute('disabled'),
  ).toBe(true);
  type('2026-11-20');
  expect(typed().getAttribute('aria-invalid')).toBeNull();
});

it('writes the picked calendar day into the entry', () => {
  const onChange = renderChoice({ value: '2026-11-25' });
  expect((typed() as HTMLInputElement).value).toBe('2026-11-25');
  const cell = screen
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-label')?.includes('27. November 2026'));
  expect(cell).toBeTruthy();
  fireEvent.click(cell!);
  expect((typed() as HTMLInputElement).value).toBe('2026-11-27');
  expect(onChange).not.toHaveBeenCalled();
});

it('disables calendar days before the minimum', () => {
  renderChoice({ value: '2026-11-25', min: '2026-11-20' });
  const day = (n: number) =>
    screen
      .getAllByRole('button')
      .find((b) =>
        b.getAttribute('aria-label')?.includes(`${n}. November 2026`),
      )!;
  expect(day(19).getAttribute('aria-disabled')).toBe('true');
  expect(day(20).getAttribute('aria-disabled')).toBeNull();
});

it('offers Remove date only for a value of an optional choice', () => {
  const onChange = renderChoice({ value: '2026-11-25', optional: true });
  fireEvent.click(screen.getByRole('button', { name: 'Datum entfernen' }));
  expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  cleanup();
  renderChoice({ value: null, optional: true });
  expect(screen.queryByRole('button', { name: 'Datum entfernen' })).toBeNull();
  cleanup();
  renderChoice({ value: '2026-11-25' });
  expect(screen.queryByRole('button', { name: 'Datum entfernen' })).toBeNull();
});

it('starts a new draft when the caller selects another day', () => {
  function Controlled() {
    const [value, setValue] = useState<string | null>('2026-11-25');
    return (
      <SdkLocaleProvider locale="de-DE">
        <DateChoice
          label="Nicht heute"
          value={value}
          onChange={setValue}
          presets={presets}
        />
        <output>{value}</output>
      </SdkLocaleProvider>
    );
  }
  render(<Controlled />);
  type('2026-02-30');
  fireEvent.click(screen.getByRole('button', { name: 'Nächste Woche' }));
  expect(screen.getByRole('status').textContent).toBe('2026-11-26');
  expect((typed() as HTMLInputElement).value).toBe('2026-11-26');
  expect(typed().getAttribute('aria-invalid')).toBeNull();
});

it('opens a stored value without a day with an empty entry', () => {
  renderChoice({ value: '2026-02-30' });
  expect((typed() as HTMLInputElement).value).toBe('');
  expect(typed().getAttribute('aria-invalid')).toBeNull();
  expect(screen.queryByRole('gridcell', { selected: true })).toBeNull();
});

it('starts a zoned date-time at the day of its own offset', () => {
  renderChoice({ value: '2026-10-30T23:30:00-11:00' });
  expect((typed() as HTMLInputElement).value).toBe('2026-10-30');
});

it('names its group, calendar and entry in English', () => {
  render(
    <SdkLocaleProvider locale="en-GB">
      <DateChoice label="Not today" value={null} onChange={() => {}} />
    </SdkLocaleProvider>,
  );
  expect(screen.getByRole('group', { name: 'Not today' })).toBeTruthy();
  expect(
    screen.getByRole('textbox', { name: 'Day (YYYY-MM-DD)' }),
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
});
