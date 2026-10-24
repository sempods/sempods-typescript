import { describe, expect, it } from 'vitest';
import type { JsonLd } from '../results.js';
import { sameNode } from './terms.js';

const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
describe('RDF type comparison (#119)', () => {
  it.each([
    [
      { '@type': ['urn:A', 'urn:B'] },
      { [TYPE]: [{ '@id': 'urn:B' }, { '@id': 'urn:A' }] },
    ],
    [{ '@type': 'urn:A' }, { [TYPE]: [{ '@id': 'urn:A' }] }],
    [{ '@type': ['urn:A', 'urn:A'] }, { '@type': ['urn:A'] }],
    [
      { '@type': ['urn:A'], [TYPE]: [{ '@id': 'urn:A' }] },
      { '@type': ['urn:A'] },
    ],
    [{}, { '@type': [], [TYPE]: [] }],
  ] satisfies [JsonLd, JsonLd][])(
    'compares equivalent descriptions %j and %j',
    (a, b) => {
      expect(sameNode(a, b)).toBe(true);
      expect(sameNode(b, a)).toBe(true);
    },
  );
  it.each([
    { '@type': ['urn:B'] },
    { '@type': ['urn:A', 'urn:B'] },
    {},
    { [TYPE]: [{ '@value': 'urn:A' }] },
    { [TYPE]: [{ '@id': 'urn:A', 'urn:extension': [] }] },
    { [TYPE]: [{ '@id': '_:blank' }] },
    { '@type': [{ '@id': 'urn:A' }] },
    { '@type': ['not an IRI'] },
    { '@type': ['urn:A'], [TYPE]: [{ '@id': 'urn:B' }] },
  ] satisfies JsonLd[])(
    'keeps changed or unsupported types conservative: %j',
    (node) => {
      expect(sameNode({ '@type': ['urn:A'] }, node)).toBe(false);
      expect(sameNode(node, { '@type': ['urn:A'] })).toBe(false);
    },
  );
  it('keeps unknown predicates and language values in the comparison', () => {
    const a = {
      '@type': ['urn:A'],
      'urn:unknown': [{ '@value': 'alt', '@language': 'de' }],
    };
    const b = {
      [TYPE]: [{ '@id': 'urn:A' }],
      'urn:unknown': [{ '@value': 'neu', '@language': 'de' }],
    };
    expect(sameNode(a, b)).toBe(false);
    expect(sameNode(a, { [TYPE]: [{ '@id': 'urn:A' }] })).toBe(false);
  });
});
