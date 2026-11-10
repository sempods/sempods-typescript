/**
 * What a stored `xsd:date` or `xsd:dateTime` lexical form names: a calendar
 * day, an instant with its time zone, or neither. The `date` and `dateTime`
 * fields accept exactly the `day` and `instant` forms; display helpers decide
 * which of them they can show.
 */
export type StoredDate =
  | {
      /** An `xsd:date` on a real day of the Gregorian calendar. */
      readonly kind: 'day';
      /**
       * The astronomical year as written: 0 is 1 BCE, -44 is 45 BCE. Beyond
       * 15 digits it is rounded.
       */
      readonly year: number;
      /** 1 to 12. */
      readonly month: number;
      /** A real day of that month, leap years included. */
      readonly day: number;
      /**
       * `Z` or `±hh:mm` as stored, if any. It is reported, never applied: the
       * day is the same in every zone.
       */
      readonly timeZone?: string;
    }
  | {
      /** An `xsd:dateTime` with its required time zone, on a real day. */
      readonly kind: 'instant';
      /** The day as written, in its own offset; `T24:00:00` keeps it. */
      readonly year: number;
      readonly month: number;
      readonly day: number;
      /** `Z` or `±hh:mm`, as stored. */
      readonly timeZone: string;
      /**
       * Milliseconds since 1970-01-01T00:00:00Z. `24:00:00` is the next
       * midnight; digits after the milliseconds are dropped. Beyond years
       * ±275760 it lies outside what a `Date` holds.
       */
      readonly epochMilliseconds: number;
    }
  | {
      /** Neither: show it as stored. */
      readonly kind: 'unsupported';
    };

/**
 * XSD 1.1 `date` and `dateTime` lexical forms. A date may carry a time zone;
 * a date-time must, so that it names one instant. The pattern checks the
 * ranges of each part; the day of the month is checked below.
 */
const LEXICAL =
  /^(-?)(\d*(\d{4}))-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(?:T(?:([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d+))?|(24):00:00(?:\.0+)?))?(Z|([+-])(?:(0\d|1[0-3]):([0-5]\d)|(14):(00)))?$/;
const DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const UNSUPPORTED: StoredDate = Object.freeze({ kind: 'unsupported' });

/**
 * Classifies a stored lexical form without `Date`, which rolls 30 February
 * over to 2 March and reads a time without a zone in the device's zone. It
 * knows no datatype and no display range: the caller checks that an
 * `xsd:date` literal is a `day` and an `xsd:dateTime` an `instant`.
 */
export function classifyDate(value: string): StoredDate {
  const match = LEXICAL.exec(value);
  if (!match) return UNSUPPORTED;
  const [, sign, digits, last4, mm, dd, h, min, s, fraction, h24, zone] = match;
  // A year of more than four digits has no leading zero.
  if (digits!.length > 4 && digits![0] === '0') return UNSUPPORTED;
  const month = Number(mm);
  const day = Number(dd);
  if (day > DAYS[month - 1]! || (month === 2 && day === 29 && !leap(last4!)))
    return UNSUPPORTED;
  // `|| 0` turns the -0 of `-0000` into 0.
  const year = Number(`${sign}${digits}`) || 0;
  const timed = h !== undefined || h24 !== undefined;
  if (!timed)
    return zone === undefined
      ? { kind: 'day', year, month, day }
      : { kind: 'day', year, month, day, timeZone: zone };
  if (zone === undefined) return UNSUPPORTED;
  const offsetMinutes =
    zone === 'Z'
      ? 0
      : (match[12] === '-' ? -1 : 1) *
        (Number(match[13] ?? match[15]) * 60 + Number(match[14] ?? match[16]));
  const milliseconds = Number(((fraction ?? '') + '000').slice(0, 3));
  const time =
    h24 === undefined
      ? ((Number(h) * 60 + Number(min)) * 60 + Number(s)) * 1000 + milliseconds
      : 86_400_000;
  return {
    kind: 'instant',
    year,
    month,
    day,
    timeZone: zone,
    epochMilliseconds:
      daysFromEpoch(year, month, day) * 86_400_000 +
      time -
      offsetMinutes * 60_000,
  };
}

/** 10000 is a multiple of 400: the last four digits decide a leap year. */
function leap(last4: string): boolean {
  const year = Number(last4);
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * Days from 1970-01-01 to a proleptic Gregorian day, for any year (after
 * Howard Hinnant's `days_from_civil`).
 */
function daysFromEpoch(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yearOfEra = y - era * 400;
  const dayOfYear =
    Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}
