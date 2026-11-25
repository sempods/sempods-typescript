// Shared helpers of the RDF tests: N-Quads lines for quads and dataset
// comparison up to blank-node renaming. No tests here.
import type { JsonLd } from '../results.js';
import { jsonKey, lexical, RDF, XSD, type Quad, type Term } from './terms.js';

/** One N-Quads line per quad; lists must already be RDF collections. */
export function nquads(quads: readonly Quad[]): Set<string> {
  return new Set(
    quads.map(
      ({ s, p, o, g }) =>
        `${term(s)} <${p}> ${term(o)}${g === undefined ? '' : ` ${graph(g)}`} .`,
    ),
  );
}

function graph(name: string): string {
  return name.startsWith('_:') ? name : `<${name}>`;
}

function term(value: Term): string {
  switch (value.kind) {
    case 'iri':
      return `<${value.value}>`;
    case 'blank':
      return `_:${value.id}`;
    case 'literal':
      return literal(value.value);
    case 'list':
      throw new Error('A list term has no N-Quads form; lower it first.');
  }
}

/** A literal without `rdfDirection`: a base direction is not written. */
function literal(value: JsonLd): string {
  if (value['@type'] === '@json')
    return `${quoted(jsonKey(value['@value']))}^^<${RDF}JSON>`;
  const rdf = lexical(value);
  const text = quoted(String(rdf['@value']));
  const language = rdf['@language'];
  if (typeof language === 'string') return `${text}@${language}`;
  const type = rdf['@type'];
  return type === undefined || type === `${XSD}string`
    ? text
    : `${text}^^<${String(type)}>`;
}

function quoted(text: string): string {
  return `"${text.replace(/["\\\n\r]/g, (c) => ({ '\n': '\\n', '\r': '\\r' })[c] ?? `\\${c}`)}"`;
}

/** Equal up to blank-node renaming (few blank nodes: try each bijection). */
export function isomorphic(actual: Set<string>, nquads: string): boolean {
  const expected = nquads.split('\n').filter((line) => line.trim());
  const blanks = (lines: Iterable<string>) => [
    ...new Set([...lines].flatMap((line) => line.match(/_:\w+/g) ?? [])),
  ];
  const ours = blanks(actual);
  const theirs = blanks(expected);
  if (ours.length !== theirs.length || actual.size !== new Set(expected).size)
    return false;
  const permutations = (list: string[]): string[][] =>
    list.length <= 1
      ? [list]
      : list.flatMap((first, i) =>
          permutations([...list.slice(0, i), ...list.slice(i + 1)]).map(
            (rest) => [first, ...rest],
          ),
        );
  return permutations(theirs).some((order) => {
    const rename = new Map(ours.map((label, i) => [label, order[i]!]));
    return [...actual].every((line) =>
      expected.includes(line.replace(/_:\w+/g, (l) => rename.get(l)!)),
    );
  });
}
