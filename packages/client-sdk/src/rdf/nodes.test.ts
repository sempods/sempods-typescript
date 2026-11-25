import { describe, expect, it } from 'vitest';
import { fromJsonLd } from './jsonld.js';
import { flatten } from './nodes.js';

describe('canonical flattened node objects', () => {
  it('puts a named graph under its name node, once per @id', () => {
    const body = {
      '@id': 'x:g',
      'x:label': 'G',
      '@graph': [{ '@id': 'x:s', 'x:p': 'v' }],
    };
    expect(
      flatten(
        fromJsonLd(body, 'https://pod.example/').quads,
        (id) => `_:${id}`,
      ),
    ).toEqual([
      {
        '@id': 'x:g',
        'x:label': [{ '@value': 'G' }],
        '@graph': [{ '@id': 'x:s', 'x:p': [{ '@value': 'v' }] }],
      },
    ]);
  });

  it('writes a graph without default-graph statements as its name and graph', () => {
    const body = [{ '@id': '_:g', '@graph': { '@id': 'x:s', '@type': 'x:T' } }];
    expect(
      flatten(
        fromJsonLd(body, 'https://pod.example/').quads,
        (id) => `_:${id}`,
      ),
    ).toEqual([
      { '@id': '_:bg', '@graph': [{ '@id': 'x:s', '@type': ['x:T'] }] },
    ]);
  });
});
