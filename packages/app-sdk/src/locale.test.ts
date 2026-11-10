import { expect, it } from 'vitest';
import { SdkError } from '@sempods/client-sdk';
import {
  createFormatters,
  createLocale,
  englishMessages,
  germanMessages,
  resolveLocale,
  type SdkMessages,
} from './index.js';

it('resolves explicit, browser and unsupported language preferences deterministically', () => {
  expect(resolveLocale('de-ch', ['en-US'])).toEqual({
    locale: 'de-CH',
    language: 'de',
  });
  expect(resolveLocale(undefined, ['fr-CA', 'de-AT', 'en-US'])).toEqual({
    locale: 'de-AT',
    language: 'de',
  });
  expect(resolveLocale('fr-CA', ['de-DE'])).toEqual({
    locale: 'fr-CA',
    language: 'en',
  });
  expect(resolveLocale('not_a_locale', ['bad_tag', 'en-GB'])).toEqual({
    locale: 'en-GB',
    language: 'en',
  });
  expect(resolveLocale(undefined, ['bad_tag'])).toEqual({
    locale: 'en',
    language: 'en',
  });
});

it('formats regions and time zones explicitly without moving calendar dates', () => {
  const ch = createFormatters('de-CH', 'America/Los_Angeles');
  const de = createFormatters('de-DE', 'Europe/Berlin');
  // ICU/CLDR versions use either apostrophe for Swiss grouping.
  expect(ch.number(1234.5)).toMatch(/^1['’]234\.5$/);
  expect(de.number(1234.5)).toBe('1.234,5');
  expect(ch.dateOnly('2026-10-01')).toBe(de.dateOnly('2026-10-01'));
  expect(ch.dateTime('2026-10-01T00:30:00Z')).toContain('30.09.2026');
  expect(de.dateTime('2026-10-01T00:30:00Z')).toContain('01.10.2026');
  expect(de.list(['Lesen', 'Schreiben'])).toBe('Lesen und Schreiben');
});

it('shows Gregorian years below 1000 with four digits and leaves years before 0001 as stored (#258)', () => {
  const de = createFormatters('de-DE', 'Europe/Berlin');
  const en = createFormatters('en-US', 'America/New_York');
  expect(de.dateOnly('0050-03-01')).toBe('01.03.0050');
  expect(en.dateOnly('0099-12-31')).toBe('Dec 31, 0099');
  expect(de.dateOnly('0001-01-01')).toBe('01.01.0001');
  expect(de.dateOnly('1000-01-01')).toBe('01.01.1000');
  expect(de.dateOnly('9999-12-31')).toBe('31.12.9999');
  // The locale's own digits, not Latin ones.
  expect(createFormatters('ar-EG').dateOnly('0050-03-01')).toContain('٠٠٥٠');
  expect(createFormatters('ar-EG').dateOnly('0050-03-01')).not.toContain('50');
  // Other calendars keep their own years.
  expect(createFormatters('th-TH').dateOnly('0050-03-01')).toContain('593');
  expect(de.dateOnly('0000-01-01')).toBeUndefined();

  // The year of an instant is the year in the formatter's time zone.
  expect(de.dateTime('0050-03-01T12:00:00Z')).toMatch(/^01\.03\.0050, /);
  expect(en.dateTime('0099-12-31T12:00:00Z')).toMatch(/^Dec 31, 0099, /);
  expect(
    createFormatters('de-DE', 'UTC').dateTime('1000-01-01T00:30:00Z'),
  ).toBe('01.01.1000, 00:30');
  expect(en.dateTime('1000-01-01T00:30:00Z')).toMatch(/^Dec 31, 0999, /);
  expect(de.dateTime(new Date('2026-10-01T00:30:00Z'))).toBe(
    '01.10.2026, 02:30',
  );
  expect(de.dateTime('0000-06-01T00:00:00Z')).toBeUndefined();
  // Year 0001 in UTC, but still year 0000 (1 BCE) in New York.
  expect(en.dateTime('0001-01-01T00:00:00Z')).toBeUndefined();
  expect(createFormatters('en-US').dateTime('0001-01-01T00:00:00Z')).toMatch(
    /^Jan 1, 0001, /,
  );
  // A numbering-system extension is followed too.
  expect(createFormatters('de-DE-u-nu-deva').dateOnly('0050-03-01')).toBe(
    '०१.०३.००५०',
  );
  expect(de.dateTime('not a date')).toBeUndefined();
});

it('shows only stored forms the SDK classifies, and years up to 9999 (#268)', () => {
  const de = createFormatters('de-DE', 'Europe/Berlin');
  const utc = createFormatters('en-US', 'UTC');
  // The classifier owns lexical validity; formatting owns kind, zone and range.
  for (const stored of [
    '2026-10-05Z',
    '2026-10-05+02:00',
    '2026-02-30',
    '-0044-03-15',
    '10000-01-01',
    '2026-10-05T00:00:00Z',
  ])
    expect(de.dateOnly(stored)).toBeUndefined();
  expect(de.dateOnly('2024-02-29')).toBe('29.02.2024');
  // An instant: a zoned XSD date-time on a real day, not what Date parses.
  for (const stored of [
    '2026-10-29',
    '2026-10-29T10:00:00',
    '2026-02-30T10:00:00Z',
  ])
    expect(de.dateTime(stored)).toBeUndefined();
  expect(de.dateTime('2026-10-30T09:30:00.123456+02:00')).toBe(
    '30.10.2026, 08:30',
  );
  // 24:00:00 is the next midnight, read the same in every engine.
  expect(utc.dateTime('2026-12-31T24:00:00Z')).toBe('Jan 1, 2027, 12:00 AM');
  // The year in the formatter's zone decides, up to 9999.
  expect(utc.dateTime('9999-12-31T23:30:00Z')).toBe('Dec 31, 9999, 11:30 PM');
  expect(utc.dateTime('9999-12-31T23:30:00-01:00')).toBeUndefined();
  expect(
    createFormatters('en-US', 'America/New_York').dateTime(
      '9999-12-31T23:30:00-01:00',
    ),
  ).toBe('Dec 31, 9999, 7:30 PM');
  expect(utc.dateTime('10000-01-01T00:00:00Z')).toBeUndefined();
  expect(utc.dateTime(new Date(Date.UTC(10000, 0, 1)))).toBeUndefined();
  expect(utc.dateTime(new Date(Number.NaN))).toBeUndefined();
});

it('keeps translation, formatting and time zone independent and hides diagnostics', () => {
  const locale = createLocale({
    language: 'de',
    locale: 'en-US',
    direction: 'rtl',
    timeZone: 'Europe/Berlin',
    messages: { reviewAccess: 'Custom connect' },
  });
  expect(locale.language).toBe('de');
  expect(locale.direction).toBe('rtl');
  expect(locale.format.number(1234.5)).toBe('1,234.5');
  expect(locale.messages.reviewAccess).toBe('Custom connect');
  expect(locale.error(new Error('private diagnostic'))).not.toContain(
    'private diagnostic',
  );
  expect(
    locale.error(new SdkError({ code: 'invalid-pod-url' }, 'detail')),
  ).toBe('Gib eine gültige Pod-URL ein.');
});

it('keeps EN/DE message keys aligned and translates discovery outcomes', () => {
  expect(Object.keys(englishMessages).sort()).toEqual(
    Object.keys(germanMessages).sort(),
  );
  for (const problem of [
    'identity-mismatch',
    'invalid-metadata',
    'unsupported-flow',
    'http',
    'network',
    'cancelled',
  ] as const) {
    const failure = { code: 'discovery', stage: 'resource', problem } as const;
    expect(germanMessages.errors.discovery(failure)).toBeTruthy();
    expect(germanMessages.errors.discovery(failure)).not.toBe(
      englishMessages.errors.discovery(failure),
    );
  }
});

it('describes every failure code in both catalogs and lets apps override single codes', () => {
  const failures = [
    { code: 'invalid-pod-url' },
    { code: 'invalid-argument', argument: 'iri' },
    { code: 'catalogue' },
    { code: 'authentication' },
    { code: 'transport', problem: 'network' },
    { code: 'transport', problem: 'cancelled' },
    { code: 'http', status: 503 },
    { code: 'http', status: 400 },
    { code: 'response', problem: 'redirected' },
    { code: 'unexpected' },
  ] as const;
  for (const reason of failures) {
    const de = createLocale({ locale: 'de' }).error(new SdkError(reason, 'x'));
    const en = createLocale({ locale: 'en' }).error(new SdkError(reason, 'x'));
    expect(de).toBeTruthy();
    expect(de).not.toBe(en);
  }
  const custom = createLocale({
    locale: 'en',
    messages: { errors: { catalogue: () => 'Custom catalogue text.' } },
  });
  expect(custom.error(new SdkError({ code: 'catalogue' }, 'x'))).toBe(
    'Custom catalogue text.',
  );
  // Codes without an override keep the SDK text.
  expect(custom.error(new SdkError({ code: 'authentication' }, 'x'))).toBe(
    'Signing in to the pod failed. Connect again.',
  );
});

it.each(['en', 'de'] as const)(
  'describes HTTP 202 as unconfirmed in %s',
  (language) => {
    const locale = createLocale({ language });
    expect(
      locale.error(new SdkError({ code: 'http', status: 202 }, 'diagnostic')),
    ).toMatch(language === 'en' ? /unconfirmed/ : /bestätigt/);
    expect(Object.keys(locale.messages.controls).sort()).toEqual(
      Object.keys(englishMessages.controls).sort(),
    );
  },
);

it('keeps a complete 0.5.0 catalog source-compatible and fills keys added since', () => {
  // A catalog written against 0.5.0 lacks keys added in 0.6.0; it must still
  // type-check as the public SdkMessages and get the language default.
  const controls050 = Object.fromEntries(
    Object.entries(germanMessages.controls).filter(
      ([key]) => key !== 'confirmRemove' && key !== 'disconnectHint',
    ),
  ) as Omit<SdkMessages['controls'], 'confirmRemove' | 'disconnectHint'>;
  const complete: SdkMessages = { ...germanMessages, controls: controls050 };
  const locale = createLocale({
    language: 'de',
    messages: { ...complete, controls: complete.controls },
  });
  expect(locale.messages.controls.confirmRemove).toBe(
    germanMessages.controls.confirmRemove,
  );
  expect(locale.messages.controls.disconnectHint).toBe(
    germanMessages.controls.disconnectHint,
  );
});
