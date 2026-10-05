import { expect, it } from 'vitest';
import { SdkError } from '@sempods/client-sdk';
import {
  createFormatters,
  createLocale,
  englishMessages,
  germanMessages,
  resolveLocale,
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
  expect(() => de.dateOnly('2026-02-30')).toThrow(RangeError);
  expect(() => de.dateOnly('2026-10-01T00:00:00Z')).toThrow(RangeError);
  expect(de.list(['Lesen', 'Schreiben'])).toBe('Lesen und Schreiben');
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
