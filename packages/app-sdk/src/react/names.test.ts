import { expect, it } from 'vitest';
import { contextName, podLabel, podName } from './names.js';

it.each([
  ['https://one.example/', undefined, 'one.example'],
  ['https://one.example/alice/', undefined, 'one.example/alice'],
  ['https://one.example/alice', undefined, 'one.example/alice'],
  ['http://localhost:1234/alice/', '', 'localhost:1234/alice'],
  ['https://one.example/', 'Privat/', 'Privat/'],
  [
    'https://one.example/',
    'Familie – 夏の買い物'.repeat(8),
    'Familie – 夏の買い物'.repeat(8),
  ],
])('formats only the URL fallback (%s, %s)', (url, configured, expected) => {
  const names = configured === undefined ? undefined : { [url]: configured };
  expect(podLabel(url, names)).toBe(expected);
  // The existing standalone name contract is unchanged.
  expect(podName(url, names)).toBe(
    configured || url.replace(/^https?:\/\//, ''),
  );
});

it('keeps real context labels ending in a slash and decodes missing labels', () => {
  const iri =
    'https://one.example/_system/contexts/%E8%B2%B7%E3%81%84%E7%89%A9';
  expect(contextName(iri)).toBe('買い物');
  expect(contextName(iri, { [iri]: 'Shopping/' })).toBe('Shopping/');
});
