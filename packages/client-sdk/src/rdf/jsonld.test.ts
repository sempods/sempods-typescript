// Reader cases the W3C toRdf subset does not cover: where JSON-LD would
// read a form this reader cannot represent, it rejects instead of misreading.
import { describe, expect, it } from 'vitest';
import { fromJsonLd, JsonLdError } from './jsonld.js';

const base = 'https://pod.example/doc';
const p = 'https://ex/p';

function rejection(body: unknown): string | undefined {
  try {
    fromJsonLd(body, base);
    return undefined;
  } catch (error) {
    if (error instanceof JsonLdError) return error.code;
    throw error;
  }
}

describe('expanded JSON-LD the reader rejects', () => {
  it.each<[string, unknown, string]>([
    // JSON-LD 1.1 reads a set in a list as a nested list.
    [
      'a set in a list',
      { [p]: { '@list': [{ '@set': ['a', 'b'] }] } },
      'nested array',
    ],
    [
      'an empty set in a list',
      { [p]: { '@list': [{ '@set': [] }] } },
      'nested array',
    ],
    // A nested object's `@graph` would make the containing node a graph.
    [
      'a graph inside @nest',
      {
        '@id': `${base}#a`,
        '@nest': { '@graph': [{ '@id': `${base}#b`, [p]: 'v' }] },
      },
      'invalid @nest value',
    ],
    // JSON-LD checks these keywords before it drops a null value.
    [
      'a non-string language on a null value',
      { [p]: { '@value': null, '@language': 5 } },
      'invalid language-tagged string',
    ],
    [
      'an unknown direction on a null value',
      { [p]: { '@value': null, '@direction': 'up' } },
      'invalid base direction',
    ],
    [
      'a non-string type on a null value',
      { [p]: { '@value': null, '@type': 5 } },
      'invalid type value',
    ],
  ])('rejects %s', (_name, body, code) => {
    expect(rejection(body)).toBe(code);
  });

  it('still drops a null value with valid keywords', () => {
    expect(
      fromJsonLd({ [p]: { '@value': null, '@language': 'de' } }, base).quads,
    ).toEqual([]);
  });
});
