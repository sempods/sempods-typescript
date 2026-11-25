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

describe('expanded JSON-LD the reader reads as expansion does', () => {
  const s = { kind: 'iri', value: `${base}#s` } as const;
  const quads = (value: unknown) =>
    fromJsonLd({ '@id': `${base}#s`, [p]: value }, base).quads;
  const literal = (value: Record<string, unknown>) => ({
    s,
    p,
    o: { kind: 'literal', value },
    g: undefined,
  });

  it('resolves a relative datatype against the document URL', () => {
    expect(quads({ '@value': 'red', '@type': '#Color' })).toEqual([
      literal({ '@value': 'red', '@type': `${base}#Color` }),
    ]);
  });

  it.each<[string, unknown, string]>([
    [
      'a blank-node datatype',
      { '@value': 'red', '@type': '_:Color' },
      'invalid typed value',
    ],
    [
      'a relative datatype with a space',
      { '@value': 'red', '@type': 'my Color' },
      'invalid typed value',
    ],
    [
      'a property on a value object',
      { '@value': 'red', 'x:p': 'v' },
      'invalid value object',
    ],
    [
      '@id on a list',
      { '@list': [], '@id': 'x:l' },
      'invalid set or list object',
    ],
    [
      'a property on a set',
      { '@set': ['a'], 'x:p': 'v' },
      'invalid set or list object',
    ],
  ])('still rejects %s', (_name, value, code) => {
    expect(rejection({ '@id': `${base}#s`, [p]: value })).toBe(code);
  });

  it.each<[string, unknown, unknown]>([
    [
      'a list',
      { '@list': ['red'], note: 'memo' },
      {
        kind: 'list',
        items: [{ kind: 'literal', value: { '@value': 'red' } }],
        id: 1,
      },
    ],
    [
      'a value object',
      { '@value': 'red', note: 'memo', '@future': 1 },
      { kind: 'literal', value: { '@value': 'red' } },
    ],
    [
      'a set',
      { '@set': ['red'], note: 'memo' },
      { kind: 'literal', value: { '@value': 'red' } },
    ],
  ])(
    'drops unmapped keys of %s before checking its shape',
    (_name, value, o) => {
      expect(quads(value)).toEqual([{ s, p, o, g: undefined }]);
    },
  );

  it('ignores a keyword-like key in a reverse map beside a reverse link', () => {
    const body = {
      '@id': `${base}#s`,
      '@reverse': { '@future': [], [p]: { '@id': `${base}#o` } },
    };
    expect(fromJsonLd(body, base).quads).toEqual([
      { s: { kind: 'iri', value: `${base}#o` }, p, o: s, g: undefined },
    ]);
  });

  it.each([
    ['on the node', { '@id': `${base}#s`, '@index': 4, [p]: 'red' }],
    ['in @nest', { '@id': `${base}#s`, '@nest': { '@index': 4, [p]: 'red' } }],
  ])('rejects a non-string @index %s', (_name, body) => {
    expect(rejection(body)).toBe('invalid @index value');
  });

  it('reads the empty list and rdf:nil as one statement', () => {
    const nil = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil';
    expect(quads([{ '@list': [] }, { '@id': nil }])).toHaveLength(1);
    expect(quads([{ '@id': nil }, { '@list': [] }])).toHaveLength(1);
  });
});
