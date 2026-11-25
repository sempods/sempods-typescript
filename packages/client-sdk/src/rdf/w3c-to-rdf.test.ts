// The context-free toRdf cases of the W3C JSON-LD 1.1 API test suite
// (src/fixtures/w3c-to-rdf.json, with its source commit) through the SDK's
// internal JSON-LD reader. A positive case's dataset must equal the
// expected N-Quads up to blank-node renaming, both read directly and after
// a round trip through canonical node objects; a negative case must reject
// with the suite's error code.
//
// Not in the fixture: the 400 cases with an active @context (the reader
// rejects any context that is not inert), among them both generalized-RDF
// cases; expandContext (te077), rdfDirection (di09–di12) and JSON-LD 1.0
// mode (er32). Remote documents have their own manifest and are not read:
// the SDK takes a fetched body, never a document URL to load.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonLd } from '../results.js';
import { fromJsonLd, JsonLdError } from './jsonld.js';
import { isomorphic, nquads } from './nquads.helpers.test.js';
import { flatten } from './nodes.js';
import { lowerLists, type Subject } from './terms.js';

interface W3cCase {
  readonly id: string;
  readonly name: string;
  readonly kind: 'positive' | 'negative' | 'syntax';
  readonly base: string;
  readonly input: unknown;
  readonly expect?: string;
  readonly error?: string;
}
const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/w3c-to-rdf.json', import.meta.url), 'utf8'),
) as {
  readonly $source: {
    readonly total: number;
    readonly excluded: Readonly<Record<string, number | readonly string[]>>;
  };
  readonly cases: readonly W3cCase[];
};
const cases = fixture.cases.map((c) => [c.id, c] as const);

/**
 * Where the SDK rejects a document that JSON-LD 1.1 reads with a warning
 * or by dropping something: a Pod answer that carries data no statement
 * holds is malformed, not empty.
 */
const REJECTED: Readonly<Record<string, string>> = {
  '#te045': 'free-floating value',
  '#te046': 'free-floating value',
  '#twf05': 'ill-formed language tag',
};
/**
 * Absolute IRIs are taken as given, as Find always did (find.test.ts keeps
 * `x:a> x:p <x:b`): the statements JSON-LD drops for an IRI with a space
 * stay, and every other statement matches.
 */
const IRIS_AS_GIVEN = new Set(['#twf01', '#twf03', '#twf04', '#twf07']);

/** The dataset as N-Quads lines, with lists as RDF collections. */
function read(input: unknown, base: string): Set<string> {
  let fresh = 0;
  const blank = (): Subject => ({ kind: 'blank', id: `l${fresh++}` });
  return nquads(lowerLists(fromJsonLd(input, base).quads, blank));
}

function rejection(input: unknown, base: string): string | undefined {
  try {
    fromJsonLd(input, base);
    return undefined;
  } catch (error) {
    if (error instanceof JsonLdError) return error.code;
    throw error;
  }
}

describe('W3C JSON-LD toRdf, context-free cases', () => {
  it('covers the whole manifest: each case is read or excluded with a reason', () => {
    const excluded = Object.values(fixture.$source.excluded).reduce<number>(
      (sum, entry) => sum + (typeof entry === 'number' ? entry : entry.length),
      0,
    );
    expect(cases.length + excluded).toBe(fixture.$source.total);
    expect(cases.length).toBe(62);
  });

  it.each(
    cases.filter(
      ([id, c]) =>
        c.kind === 'positive' && !REJECTED[id] && !IRIS_AS_GIVEN.has(id),
    ),
  )('reads %s as the expected dataset', (_id, c) => {
    expect(isomorphic(read(c.input, c.base), c.expect!)).toBe(true);
  });

  it.each(
    cases.filter(
      ([id, c]) =>
        c.kind === 'positive' && !REJECTED[id] && !IRIS_AS_GIVEN.has(id),
    ),
  )('keeps the dataset of %s through canonical node objects', (_id, c) => {
    const { quads } = fromJsonLd(c.input, c.base);
    const nodes = flatten(quads, (id) => `_:${id}`);
    expect(isomorphic(read(nodes, c.base), c.expect!)).toBe(true);
  });

  it.each(cases.filter(([, c]) => c.kind === 'negative'))(
    'rejects %s with its error code',
    (_id, c) => {
      expect(rejection(c.input, c.base)).toBe(c.error);
    },
  );

  it.each(cases.filter(([, c]) => c.kind === 'syntax'))(
    'reads the literal of %s unchanged',
    (_id, c) => {
      const [node] = c.input as readonly JsonLd[];
      const [[predicate, [value]]] = Object.entries(node!).filter(
        ([key]) => key !== '@id',
      ) as [[string, JsonLd[]]];
      const { quads } = fromJsonLd(c.input, c.base);
      expect(quads).toEqual([
        {
          s: { kind: 'iri', value: node!['@id'] },
          p: predicate,
          o: { kind: 'literal', value },
          g: undefined,
        },
      ]);
    },
  );

  it.each(Object.entries(REJECTED))(
    'rejects %s, which JSON-LD reads, as %s',
    (id, code) => {
      const c = fixture.cases.find((entry) => entry.id === id)!;
      expect(rejection(c.input, c.base)).toBe(code);
    },
  );

  it.each([...IRIS_AS_GIVEN])(
    'keeps the statements of %s with an IRI as given',
    (id) => {
      const c = fixture.cases.find((entry) => entry.id === id)!;
      const lines = [...read(c.input, c.base)];
      const kept = lines.filter((line) => /<[^>]* [^>]*>/.test(line));
      expect(kept.length).toBeGreaterThan(0);
      expect(
        isomorphic(new Set(lines.filter((l) => !kept.includes(l))), c.expect!),
      ).toBe(true);
    },
  );
});
