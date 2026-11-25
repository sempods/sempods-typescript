// The shared Find acceptance cases (sempods-spec#147, examples/find/responses.yaml)
// through `Pod.find` and `Pod.findFlat`: each case's request is the body sent,
// and the decoded answer, observations included, is the case's N-Quads dataset.
import { describe, expect, it } from 'vitest';
import type {
  FindGraph,
  FindObservation,
  FlatFindGraph,
  JsonLd,
} from './index.js';
import {
  answering,
  bodyRejected,
  FIND_RESULT,
  findCases,
  ok,
  optionsOf,
  sent,
} from './find.helpers.test.js';
import { RDF_TYPE } from './iri.js';
import { isomorphic } from './rdf/nquads.helpers.test.js';

const cases = findCases();
const fixtures = Object.fromEntries(cases);
const base = 'https://pod.example';
const A = `${base}/_system/contexts/A`;
const B = `${base}/_system/contexts/B`;
const hit = `${base}/articles/42`;
const XSD_INTEGER = 'http://www.w3.org/2001/XMLSchema#integer';

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
describe('shared Find acceptance cases', () => {
  it.each(cases.filter(([, c]) => c.grouped))(
    'decodes %s grouped through Pod.find',
    async (_name, c) => {
      const { fetch, pod } = answering(c.grouped!.jsonld);
      const body = await ok(pod.find(c.request.text, optionsOf(c.request)));
      expect(sent(fetch)).toEqual({ ...c.request, include_contexts: true });
      expect(isomorphic(dataset(body), c.grouped!.nquads)).toBe(true);
      // No observation label reaches the pod data.
      expect(JSON.stringify(body.map((g) => g.nodes))).not.toMatch(/"_:/);
    },
  );

  it.each(cases)('decodes %s flat through Pod.findFlat', async (_name, c) => {
    const { fetch, pod } = answering(c.flat.jsonld);
    const body = await ok(pod.findFlat(c.request.text, optionsOf(c.request)));
    expect(sent(fetch)).toEqual(c.request);
    expect(isomorphic(dataset([body]), c.flat.nquads)).toBe(true);
    expect(JSON.stringify(body.nodes)).not.toMatch(/"_:/);
  });

  it.each(cases.filter(([, c]) => c.grouped && c.grouped.nquads.trim()))(
    'keeps the representations apart for %s',
    async (_name, c) => {
      await expect(
        answering(c.grouped!.jsonld).pod.findFlat(c.request.text),
      ).rejects.toMatchObject(bodyRejected);
      await expect(
        answering(c.flat.jsonld).pod.find(c.request.text),
      ).rejects.toMatchObject(bodyRejected);
    },
  );

  it.each(cases.filter(([, c]) => c.invalid))(
    'rejects the invalid form of %s in both forms (case 8)',
    async (_name, c) => {
      for (const read of ['find', 'findFlat'] as const)
        await expect(
          answering(c.invalid!.jsonld).pod[read](c.request.text),
        ).rejects.toMatchObject(bodyRejected);
    },
  );
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
      id: expect.stringMatching(/^_:a[0-9a-f]+-/),
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
        id: expect.stringMatching(/^_:a[0-9a-f]+-/),
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
    const { id: firstId, ...firstRest } = first!.observations[0]!;
    const { id: secondId, ...secondRest } = second!.observations[0]!;
    expect(secondRest).toEqual(firstRest);
    // The Pod's label `_:m` is not kept: each answer has its own.
    expect(secondId).not.toBe(firstId);
    expect(firstId).not.toBe('_:m');
  });
});
