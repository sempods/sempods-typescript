// The shared Find acceptance cases (sempods-spec#147, examples/find/responses.yaml)
// through `Pod.find` and `Pod.findFlat`: each case's request is the body sent,
// and the decoded answer, observations included, is the case's N-Quads dataset.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  bearer,
  createPod,
  type FindGraph,
  type FindObservation,
  type FindOptions,
  type FlatFindGraph,
  type JsonLd,
  type PodFetch,
} from './index.js';

interface Representation {
  readonly jsonld: unknown;
  readonly nquads: string;
}
interface Case {
  readonly case?: number;
  readonly request: {
    readonly text: string;
    readonly type?: readonly string[];
    readonly contexts?: readonly string[];
    readonly limit?: number;
  };
  readonly grouped?: Representation;
  readonly flat: Representation;
  readonly invalid?: { readonly jsonld: unknown };
}

const fixtures = JSON.parse(
  readFileSync(
    new URL('./fixtures/find-responses.json', import.meta.url),
    'utf8',
  ),
) as Record<string, Case> & { $source: unknown };
const cases = Object.entries(fixtures).filter(
  (entry): entry is [string, Case] => entry[0] !== '$source',
);
const base = 'https://pod.example';
const A = `${base}/_system/contexts/A`;
const B = `${base}/_system/contexts/B`;
const hit = `${base}/articles/42`;
const FIND_RESULT = 'https://schema.sempods.org/findResult';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

function answering(body: unknown) {
  const fetch = vi.fn<PodFetch>(async () => Response.json(body));
  return { fetch, pod: createPod(base, { auth: bearer('test'), fetch }) };
}
const sent = (fetch: ReturnType<typeof vi.fn<PodFetch>>) =>
  JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as unknown;
const optionsOf = ({
  type,
  contexts,
  limit,
}: Case['request']): FindOptions => ({
  ...(type ? { types: type } : {}),
  ...(contexts ? { contexts } : {}),
  ...(limit === undefined ? {} : { limit }),
});
async function ok<T>(answer: Promise<{ kind: string; body?: T }>): Promise<T> {
  const result = await answer;
  if (result.kind !== 'ok') throw new Error(result.kind);
  return result.body as T;
}

/** N-Quads for the fixtures' expanded JSON-LD terms. */
function term(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  const node = value as JsonLd;
  if (typeof node['@id'] === 'string')
    return node['@id'].startsWith('_:') ? node['@id'] : `<${node['@id']}>`;
  const lexical = node['@value'];
  if (typeof lexical === 'number')
    return `${JSON.stringify(String(lexical))}^^<${XSD_INTEGER}>`;
  if (typeof node['@type'] === 'string')
    return `${JSON.stringify(lexical)}^^<${node['@type']}>`;
  return JSON.stringify(lexical);
}
function quads(
  subject: string,
  node: JsonLd,
  context: string | undefined,
): string[] {
  const graph = context === undefined ? '' : ` <${context}>`;
  return Object.entries(node).flatMap(([key, values]) => {
    if (key === '@id') return [];
    const predicate = key === '@type' ? RDF_TYPE : key;
    return (Array.isArray(values) ? values : [values]).map(
      (value) =>
        `${subject} <${predicate}> ${key === '@type' ? `<${String(value)}>` : term(value)}${graph} .`,
    );
  });
}
/** The dataset an answer stands for, observations as fresh blank nodes. */
function dataset(
  groups: readonly (Pick<FindGraph, 'nodes' | 'observations'> & {
    readonly context?: string;
  })[],
): Set<string> {
  const labels = new Map<FindObservation, string>();
  const out = new Set<string>();
  for (const { context, nodes, observations } of groups) {
    for (const node of nodes)
      quads(`<${String(node['@id'])}>`, node, context).forEach((q) =>
        out.add(q),
      );
    for (const o of observations)
      if (!labels.has(o)) labels.set(o, `_:o${labels.size}`);
  }
  for (const [o, label] of labels) {
    for (const { hit, context } of o.links)
      out.add(
        `<${hit}> <${FIND_RESULT}> ${label}${context ? ` <${context}>` : ''} .`,
      );
    for (const { context, node } of o.details)
      quads(label, node, context).forEach((q) => out.add(q));
  }
  return out;
}
/** Equal up to blank-node renaming (few blank nodes: try each bijection). */
function isomorphic(actual: Set<string>, nquads: string): boolean {
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

describe('shared Find acceptance cases', () => {
  it.each(cases.filter(([, c]) => c.grouped))(
    'decodes %s grouped through Pod.find',
    async (_name, c) => {
      const { fetch, pod } = answering(c.grouped!.jsonld);
      const body = await ok(pod.find(c.request.text, optionsOf(c.request)));
      expect(sent(fetch)).toEqual({ ...c.request, include_contexts: true });
      expect(isomorphic(dataset(body), c.grouped!.nquads)).toBe(true);
      // No response-local label reaches the app as a resource or an id.
      expect(JSON.stringify(body)).not.toMatch(/"_:/);
    },
  );

  it.each(cases)('decodes %s flat through Pod.findFlat', async (_name, c) => {
    const { fetch, pod } = answering(c.flat.jsonld);
    const body = await ok(pod.findFlat(c.request.text, optionsOf(c.request)));
    expect(sent(fetch)).toEqual(c.request);
    expect(isomorphic(dataset([body]), c.flat.nquads)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/"_:/);
  });

  it.each(cases.filter(([, c]) => c.grouped && c.grouped.nquads.trim()))(
    'keeps the representations apart for %s',
    async (_name, c) => {
      await expect(
        answering(c.grouped!.jsonld).pod.findFlat(c.request.text),
      ).rejects.toMatchObject({
        reason: { code: 'response', problem: 'body' },
      });
      await expect(
        answering(c.flat.jsonld).pod.find(c.request.text),
      ).rejects.toMatchObject({
        reason: { code: 'response', problem: 'body' },
      });
    },
  );

  it('rejects an anonymous group, also one holding only an observation (case 8)', async () => {
    const c = fixtures['anonymous-group']!;
    for (const read of ['find', 'findFlat'] as const)
      await expect(
        answering(c.invalid!.jsonld).pod[read](c.request.text),
      ).rejects.toMatchObject({
        reason: { code: 'response', problem: 'body' },
      });
  });
});

describe('observations in the shared cases', () => {
  const grouped = (name: string) =>
    ok<readonly FindGraph[]>(
      answering(fixtures[name]!.grouped!.jsonld).pod.find('x'),
    );
  const flat = (name: string) =>
    ok<FlatFindGraph>(answering(fixtures[name]!.flat.jsonld).pod.findFlat('x'));

  it('keeps a hit reported by a bare link as a node without facts (case 2)', async () => {
    const [group] = await grouped('bare');
    const observation = group!.observations[0]!;
    expect(group).toEqual({
      context: A,
      nodes: [{ '@id': hit }],
      observations: [observation],
    });
    expect(observation).toEqual({
      links: [{ hit, context: A }],
      details: [],
      text: [],
      position: [],
      engine: [],
    });
    expect((await flat('bare')).observations[0]!.links).toEqual([{ hit }]);
  });

  it('types the excerpt where the match was placed, apart from the pod data (case 3)', async () => {
    const [inA, inB] = await grouped('known-match');
    expect(inA).toEqual({
      context: A,
      nodes: [{ '@id': hit, '@type': ['https://schema.org/Article'] }],
      observations: [],
    });
    expect(inB!.nodes).toEqual([
      {
        '@id': hit,
        'https://schema.org/description': [{ '@value': 'Harbour lantern' }],
      },
    ]);
    expect(inB!.observations).toEqual([
      {
        links: [{ hit, context: B }],
        details: [
          {
            context: B,
            node: {
              'https://schema.org/text': [{ '@value': 'Harbour lantern' }],
            },
          },
        ],
        text: ['Harbour lantern'],
        position: [],
        engine: [],
      },
    ]);
  });

  it.each(['repeated', 'split'])(
    'resolves one observation %s across groups (case 4)',
    async (name) => {
      const [inA, inB] = await grouped(name);
      expect(inA!.observations).toHaveLength(1);
      expect(inB!.observations[0]).toBe(inA!.observations[0]);
      const observation = inA!.observations[0]!;
      expect(observation.text).toEqual(['Harbour lantern']);
      expect(observation.details.map((d) => d.context)).toEqual([B]);
      expect(observation.links.map((l) => l.context)).toEqual(
        name === 'repeated' ? [A, B] : [A],
      );
      // Split details leave no resource behind in their group.
      expect(inB!.nodes).toEqual(name === 'split' ? [] : [{ '@id': hit }]);
    },
  );

  it('keeps independent observations of one hit at limit 1 (case 5)', async () => {
    const answer = await flat('independent');
    expect(answer.nodes).toEqual([{ '@id': hit }]);
    expect(answer.observations.map((o) => [o.links, o.position])).toEqual([
      [[{ hit }], [2]],
      [[{ hit }], [7]],
    ]);
    const [inA, inB] = await grouped('independent');
    expect(inA!.observations.map((o) => o.position)).toEqual([[2]]);
    expect(inB!.observations.map((o) => o.position)).toEqual([[7]]);
  });

  it('leaves a stored sps:findResult in its source Context (case 7)', async () => {
    const [inA, inB] = await grouped('stored-vocabulary');
    expect(inA).toEqual({
      context: A,
      nodes: [
        { '@id': hit, [FIND_RESULT]: [{ '@id': `${base}/notes/saved` }] },
      ],
      observations: [],
    });
    expect(inB!.observations).toEqual([]);
    expect((await flat('stored-vocabulary')).observations).toEqual([]);
  });

  it('isolates observations between answers that reuse a label', async () => {
    const { pod } = answering(fixtures['bare']!.grouped!.jsonld);
    const [first] = await ok(pod.find('x'));
    const [second] = await ok(pod.find('x'));
    expect(second!.observations[0]).toEqual(first!.observations[0]);
    expect(second!.observations[0]).not.toBe(first!.observations[0]);
  });
});
