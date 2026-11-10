import { describe, expect, it } from 'vitest';
import { classifyDate } from './dates.js';

const day = (year: number, month: number, d: number, timeZone?: string) => ({
  kind: 'day',
  year,
  month,
  day: d,
  ...(timeZone === undefined ? {} : { timeZone }),
});
const kind = (value: string) => classifyDate(value).kind;

describe('classifyDate: calendar days', () => {
  it('reads a real day with its parts, without a time zone', () => {
    expect(classifyDate('2026-10-29')).toStrictEqual(day(2026, 10, 29));
    expect(classifyDate('2026-12-31')).toStrictEqual(day(2026, 12, 31));
    expect(classifyDate('2026-01-01')).toStrictEqual(day(2026, 1, 1));
  });

  it('reports a stored time zone without applying it', () => {
    expect(classifyDate('2026-10-29Z')).toStrictEqual(day(2026, 10, 29, 'Z'));
    expect(classifyDate('2026-10-29+14:00')).toStrictEqual(
      day(2026, 10, 29, '+14:00'),
    );
    expect(classifyDate('2026-10-29-13:59')).toStrictEqual(
      day(2026, 10, 29, '-13:59'),
    );
  });

  it.each([
    '2026-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-06-31',
    '2026-09-31',
    '2026-11-31',
    '2026-00-10',
    '2026-13-01',
    '2026-10-00',
    '2026-10-32',
    '1900-02-29',
    '2100-02-29',
    '-0001-02-29',
    '-0100-02-29',
    '2026-02-30Z',
  ])('refuses %s, which names no real day', (value) => {
    expect(kind(value)).toBe('unsupported');
  });

  it.each([
    ['2024-02-29', 2024],
    ['2000-02-29', 2000],
    ['1600-02-29', 1600],
    ['0000-02-29', 0],
    ['-0004-02-29', -4],
    ['-0400-02-29', -400],
    ['12000-02-29', 12000],
  ])('accepts the leap day %s', (value, year) => {
    expect(classifyDate(value)).toStrictEqual(day(year, 2, 29));
  });

  it('reads years 0000, below 1000, above 9999 and negative years', () => {
    expect(classifyDate('0000-01-01')).toStrictEqual(day(0, 1, 1));
    expect(classifyDate('0001-01-01')).toStrictEqual(day(1, 1, 1));
    expect(classifyDate('0050-03-01')).toStrictEqual(day(50, 3, 1));
    expect(classifyDate('0999-12-31')).toStrictEqual(day(999, 12, 31));
    expect(classifyDate('9999-12-31')).toStrictEqual(day(9999, 12, 31));
    expect(classifyDate('10000-01-01')).toStrictEqual(day(10000, 1, 1));
    expect(classifyDate('123456-07-08')).toStrictEqual(day(123456, 7, 8));
    expect(classifyDate('-0044-03-15')).toStrictEqual(day(-44, 3, 15));
    expect(classifyDate('-12345-01-01')).toStrictEqual(day(-12345, 1, 1));
    // XSD 1.1 reads `-0000` as year 0, not as -0.
    const minusZero = classifyDate('-0000-01-01');
    expect(minusZero).toStrictEqual(day(0, 1, 1));
    expect(Object.is((minusZero as { year: number }).year, 0)).toBe(true);
  });

  it.each([
    '00050-03-01',
    '010000-01-01',
    '-00044-03-15',
    '050-03-01',
    '50-03-01',
    '+2026-10-29',
    '2026-10',
    '2026-1-29',
    '2026-10-9',
    '2026/10/29',
    ' 2026-10-29',
    '2026-10-29 ',
    '2026-10-29\n',
    '2026-10-29+99:99',
    '2026-10-29+14:01',
    '2026-10-29+1400',
    '2026-10-29z',
    '2026-10-29Tgarbage',
    '2026-10-29T',
    '',
  ])('refuses the lexical form %j', (value) => {
    expect(kind(value)).toBe('unsupported');
  });
});

describe('classifyDate: instants', () => {
  const at = (value: string) => {
    const result = classifyDate(value);
    if (result.kind !== 'instant') throw new Error(`${value}: ${result.kind}`);
    return result;
  };

  it('reads a zoned date-time with its written day and its instant', () => {
    expect(classifyDate('2026-10-30T09:30:00+02:00')).toStrictEqual({
      kind: 'instant',
      year: 2026,
      month: 10,
      day: 30,
      timeZone: '+02:00',
      epochMilliseconds: Date.UTC(2026, 9, 30, 7, 30),
    });
    expect(at('1970-01-01T00:00:00Z').epochMilliseconds).toBe(0);
    expect(at('2026-10-29T23:30:00-01:00').day).toBe(29);
    expect(at('2026-10-29T23:30:00-01:00').epochMilliseconds).toBe(
      Date.UTC(2026, 9, 30, 0, 30),
    );
  });

  it('requires a time zone and seconds', () => {
    expect(kind('2026-10-29T09:30:00')).toBe('unsupported');
    expect(kind('2026-10-29T09:30Z')).toBe('unsupported');
    expect(kind('2026-10-29T9:30:00Z')).toBe('unsupported');
    expect(kind('2026-10-29T09:30:00+14:01')).toBe('unsupported');
    expect(kind('2026-10-29t09:30:00Z')).toBe('unsupported');
    expect(kind('2026-10-29 09:30:00Z')).toBe('unsupported');
  });

  // Moved from field validation: these lexical cases belong to the classifier.
  it.each([
    '2026-10-05T09:30:00z',
    '2026-10-05T09:30:00+0200',
    '26-10-05T09:30:00Z',
    '02026-10-05T09:30:00Z',
    ' 2026-10-05T09:30:00Z',
    '2026-10-05T09:30:00Z ',
    '２０２６-10-05T09:30:00Z',
  ])('refuses the instant lexical form %j', (value) => {
    expect(kind(value)).toBe('unsupported');
  });

  it('agrees with Date on offsets from -14:00 to +14:00', () => {
    for (const zone of [
      'Z',
      '+00:00',
      '-00:00',
      '+14:00',
      '-14:00',
      '+05:45',
      '-09:30',
    ])
      expect(at(`2026-10-29T12:00:00${zone}`).epochMilliseconds).toBe(
        Date.parse(`2026-10-29T12:00:00${zone}`),
      );
  });

  it('reads 24:00:00 as the next midnight and keeps the written day', () => {
    const end = at('2026-12-31T24:00:00Z');
    expect(end.day).toBe(31);
    expect(end.epochMilliseconds).toBe(Date.UTC(2027, 0, 1));
    expect(at('2026-10-29T24:00:00.000+02:00').epochMilliseconds).toBe(
      Date.UTC(2026, 9, 29, 22),
    );
    expect(kind('2026-10-29T24:00:01Z')).toBe('unsupported');
    expect(kind('2026-10-29T24:01:00Z')).toBe('unsupported');
    expect(kind('2026-10-29T24:00:00.5Z')).toBe('unsupported');
    expect(kind('2026-10-29T25:00:00Z')).toBe('unsupported');
  });

  it('reads fractional seconds and drops digits after the milliseconds', () => {
    expect(at('2026-10-29T09:30:00.5Z').epochMilliseconds).toBe(
      Date.UTC(2026, 9, 29, 9, 30, 0, 500),
    );
    expect(at('2026-10-29T09:30:00.123456789Z').epochMilliseconds).toBe(
      Date.UTC(2026, 9, 29, 9, 30, 0, 123),
    );
    expect(kind('2026-10-29T09:30:00.Z')).toBe('unsupported');
    expect(kind('2026-10-29T09:30:60Z')).toBe('unsupported');
  });

  it('refuses a date-time on an impossible day', () => {
    expect(kind('2026-02-30T10:00:00Z')).toBe('unsupported');
    expect(kind('2026-02-29T10:00:00Z')).toBe('unsupported');
    expect(kind('2024-02-29T10:00:00Z')).toBe('instant');
  });

  it('computes instants outside the years Date.parse reads', () => {
    const early = new Date(0);
    early.setUTCFullYear(50, 2, 1);
    expect(at('0050-03-01T00:00:00Z').epochMilliseconds).toBe(early.valueOf());
    const zero = new Date(0);
    zero.setUTCFullYear(0, 0, 1);
    expect(at('0000-01-01T00:00:00Z').epochMilliseconds).toBe(zero.valueOf());
    expect(at('-0044-03-15T12:00:00Z').epochMilliseconds).toBe(
      Date.parse('-000044-03-15T12:00:00Z'),
    );
    expect(at('10000-01-01T00:00:00Z').epochMilliseconds).toBe(
      Date.parse('+010000-01-01T00:00:00Z'),
    );
    expect(at('10000-01-01T00:00:00Z').year).toBe(10000);
  });
});
