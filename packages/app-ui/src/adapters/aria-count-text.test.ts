import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { ariaCountText } from './aria-count-text.js';

// React Aria's own combo box strings and formatter, from the installed
// react-aria-components; neither is exported.
const fromHere = createRequire(import.meta.url);
const ariaDir = dirname(
  createRequire(fromHere.resolve('react-aria-components/package.json')).resolve(
    'react-aria/package.json',
  ),
);
const intl = join(ariaDir, 'dist/private/intl/combobox');

/** What this test uses of `@internationalized/string`, React Aria's own. */
interface Strings {
  LocalizedStringDictionary: new (strings: unknown) => unknown;
  LocalizedStringFormatter: new (
    locale: string,
    dictionary: unknown,
  ) => { format(key: string, variables: Record<string, number>): string };
}
const { LocalizedStringDictionary, LocalizedStringFormatter } = (await import(
  pathToFileURL(
    createRequire(join(ariaDir, 'package.json')).resolve(
      '@internationalized/string',
    ),
  ).href
)) as Strings;
const strings = (await import(
  pathToFileURL(join(ariaDir, 'dist/private/combobox/intlStrings.mjs')).href
)) as { default: unknown };
const dictionary = new LocalizedStringDictionary(strings.default);

const own = readdirSync(intl)
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => file.replace('.mjs', ''));
const fallback = ['fr-CA', 'pt', 'zh-HK', 'sr-Latn-RS', 'de-CH', 'sw-KE'];

it.each([...own, ...fallback])(
  'says the count as React Aria does in %s',
  (locale) => {
    const formatter = new LocalizedStringFormatter(locale, dictionary);
    for (const optionCount of [0, 1, 2, 3, 5, 11, 21, 22, 101, 1000, 12345])
      expect(ariaCountText(optionCount, locale)).toBe(
        formatter.format('countAnnouncement', { optionCount }),
      );
  },
);
