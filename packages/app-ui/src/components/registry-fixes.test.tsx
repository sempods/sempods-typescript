// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CalendarDate } from '@internationalized/date';
import { I18nProvider } from 'react-aria-components';
import { Calendar } from './calendar.js';
import { Select, SelectTrigger, SelectValue } from './select.js';

afterEach(cleanup);

it('keeps the children given to SelectValue', () => {
  render(
    <Select aria-label="Category">
      <SelectTrigger>
        <SelectValue>
          <span>Choose a category</span>
        </SelectValue>
      </SelectTrigger>
    </Select>,
  );
  expect(screen.getByText('Choose a category')).toBeTruthy();
});

it('heads each month of a dropdown calendar with its own month', () => {
  render(
    <I18nProvider locale="en-GB">
      <Calendar
        aria-label="Day"
        captionLayout="dropdown"
        numberOfMonths={2}
        defaultFocusedValue={new CalendarDate(2026, 10, 28)}
      />
    </I18nProvider>,
  );
  // One month picker (the first month), a heading for the second month.
  expect(document.querySelectorAll('[data-slot=select]')).toHaveLength(2);
  expect(screen.getByRole('heading', { name: /November 2026/ })).toBeTruthy();
});
