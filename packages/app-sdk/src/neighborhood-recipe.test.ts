/**
 * The React-free neighborhood recipe (#292): its queries evaluated by the
 * Oxigraph SPARQL engine, then decoded by the SDK's SELECT decoder.
 * Oxigraph is not a Pod; no real Pod answered.
 */
import { describe, expect, it } from 'vitest';
import { anonymous, createPod, type SelectResult } from '@sempods/client-sdk';
import { createRequire } from 'node:module';
import {
  MAX_EXAMPLES,
  MAX_KINDS,
  PAGE_SIZE,
  examplesQuery,
  hiddenIn,
  kindsOf,
  kindsQuery,
  neighborhood,
  pageOf,
  pageQuery,
  sampleInput,
  sampleOf,
  type Area,
  type Direction,
  type Page,
  type Sample,
  type SampleInput,
  type Statement,
} from '../../../examples/todo/recipes/neighborhood.js';

/**
 * Oxigraph 0.5.13 ships declarations that fail `skipLibCheck: false`
 * (`UInt8Array`), so the test loads it with the few members it uses.
 */
interface OxigraphStore {
  load(input: string, options: { readonly format: string }): void;
  query(query: string, options: { readonly results_format: string }): unknown;
}
const { Store } = createRequire(import.meta.url)('oxigraph') as {
  readonly Store: new () => OxigraphStore;
};

const alice = 'https://pod.example/alice';
const bob = 'https://pod.example/bob';
const ada = 'https://people.example/ada';
const ctx = (pod: string, name: string) => `${pod}/_system/contexts/${name}`;
const g = (pod: string, name: string) => `<${ctx(pod, name)}>`;
const P = 'urn:p:';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** A store per Pod: each query runs on Oxigraph and is decoded as a Pod answer. */
function engine(pod: string, nquads: readonly string[]) {
  const store = new Store();
  store.load(nquads.join('\n'), { format: 'application/n-quads' });
  const queries: string[] = [];
  const client = createPod(pod, {
    auth: anonymous(),
    fetch: async (_url, init) => {
      const query = String(init?.body);
      queries.push(query);
      const json = store.query(query, {
        results_format: 'application/sparql-results+json',
      });
      if (typeof json !== 'string') throw new Error('Expected SPARQL JSON');
      return new Response(json, {
        headers: { 'content-type': 'application/sparql-results+json' },
      });
    },
  });
  async function select(query: string): Promise<SelectResult> {
    const answer = await client.sparql.select(query);
    if (answer.kind !== 'ok') throw new Error(answer.kind);
    return answer.body;
  }
  return {
    queries,
    select,
    page: async (root: string, direction: Direction, index = 0) =>
      pageOf(
        await select(pageQuery(root, direction, index * PAGE_SIZE)),
        pod,
        direction,
      ),
    /** Both sample queries, as `sampleRead` sends them. */
    async sample(input: SampleInput): Promise<Sample> {
      const found = kindsOf(await select(kindsQuery(input)), input);
      if (found.kinds.length === 0) return { ...found, statements: [] };
      return sampleOf(
        await select(examplesQuery(input, found.kinds)),
        pod,
        input,
        found,
      );
    },
  };
}

/** `count` incoming statements of one dense kind, sorting first. */
const dense = (count: number, pod = alice, context = 'people') =>
  Array.from(
    { length: count },
    (_, i) =>
      `<https://people.example/f${String(i).padStart(3, '0')}> <${P}a-follows> <${ada}> ${g(pod, context)} .`,
  );
const brief = (statement: Statement) => [
  statement.direction,
  statement.predicate,
  statement.other.type === 'unsupported' ? undefined : statement.other.value,
  statement.context,
];
const kindsIn = (statements: readonly Statement[]) => [
  ...new Set(statements.map((statement) => statement.predicate)),
];

describe('queries', () => {
  const input: SampleInput = {
    root: ada,
    direction: 'in',
    shown: [`${P}a-follows`],
    hidden: [ctx(alice, 'private')],
  };

  it('bounds every query and filters hidden Contexts before the limits', () => {
    expect(pageQuery(ada, 'out', 100)).toContain(
      `LIMIT ${PAGE_SIZE + 1} OFFSET 100`,
    );
    const kinds = kindsQuery(input);
    expect(kinds).toContain(`?other ?p <${ada}>`);
    expect(kinds).toContain(`FILTER(?g NOT IN (<${ctx(alice, 'private')}>))`);
    expect(kinds).toContain(`FILTER(?p NOT IN (<${P}a-follows>))`);
    expect(kinds).toContain(`LIMIT ${MAX_KINDS + 1}`);
    const many = Array.from({ length: 40 }, (_, i) => `${P}k${i}`);
    const examples = examplesQuery(input, many);
    // One limited subquery per kind, at most MAX_KINDS of them.
    expect(examples.match(/VALUES \?p/g)).toHaveLength(MAX_KINDS);
    expect(
      examples.match(new RegExp(`LIMIT ${MAX_EXAMPLES}\\b`, 'g')),
    ).toHaveLength(MAX_KINDS);
    expect(examples.match(/FILTER\(\?g NOT IN/g)).toHaveLength(MAX_KINDS);
    expect(examples).toContain(`LIMIT ${MAX_KINDS * MAX_EXAMPLES}`);
  });

  it('refuses a root, kind or Context that would break the query', () => {
    for (const bad of [
      'ada',
      'https://x.example/a b',
      'urn:a>',
      'urn:a\u0000',
    ]) {
      expect(() => pageQuery(bad, 'out', 0)).toThrow();
      expect(() => kindsQuery({ ...input, root: bad })).toThrow();
      expect(() => kindsQuery({ ...input, hidden: [bad] })).toThrow();
      expect(() => examplesQuery(input, [bad])).toThrow();
    }
    expect(() => pageQuery(ada, 'out', -1)).toThrow();
    expect(() => pageQuery(ada, 'out', 0.5)).toThrow();
  });
});

describe('a dense first page', () => {
  const data = [
    ...dense(60),
    // Other kinds in a Context that sorts after the dense ones.
    `<https://people.example/bo> <${P}likes> <${ada}> ${g(alice, 'z-notes')} .`,
    `_:x <${P}mentions> <${ada}> ${g(alice, 'z-notes')} .`,
    ...Array.from(
      { length: 55 },
      (_, i) => `<${ada}> <${P}a-tag> "t${i}" ${g(alice, 'tags')} .`,
    ),
    `<${ada}> <${P}name> "Ada"@en ${g(alice, 'z-notes')} .`,
    `<${ada}> <${P}born> "1815-12-10"^^<${XSD}date> ${g(alice, 'z-notes')} .`,
  ];

  it('shows one kind, and the sample adds the other kinds of both directions', async () => {
    const pod = engine(alice, data);
    const result: Statement[] = [];
    for (const direction of ['in', 'out'] as const) {
      const first = await pod.page(ada, direction);
      expect(first.truncated).toBe(true);
      expect(first.statements).toHaveLength(PAGE_SIZE);
      expect(kindsIn(first.statements)).toEqual([
        direction === 'in' ? `${P}a-follows` : `${P}a-tag`,
      ]);
      const input = sampleInput(ada, direction, first, [])!;
      const sample = await pod.sample(input);
      const shown = neighborhood([{ pages: [first], sample }], []);
      expect(shown.statements).toEqual(first.statements);
      result.push(...shown.examples);
    }
    expect(result.map(brief)).toEqual([
      ['in', `${P}likes`, 'https://people.example/bo', ctx(alice, 'z-notes')],
      // The engine names blank nodes itself.
      ['in', `${P}mentions`, expect.any(String), ctx(alice, 'z-notes')],
      ['out', `${P}born`, '1815-12-10', ctx(alice, 'z-notes')],
      ['out', `${P}name`, 'Ada', ctx(alice, 'z-notes')],
    ]);
    // Exact terms, as received.
    expect(result.map((statement) => statement.other)).toEqual([
      { type: 'iri', value: 'https://people.example/bo' },
      { type: 'blank', value: expect.any(String) },
      { type: 'literal', value: '1815-12-10', datatype: `${XSD}date` },
      { type: 'literal', value: 'Ada', language: 'en' },
    ]);
    // Two pages and two sample queries per direction, nothing else.
    expect(pod.queries).toHaveLength(6);
  });

  it('reads no sample for a complete first page, and one query without missing kinds', async () => {
    const pod = engine(alice, dense(10));
    const first = await pod.page(ada, 'in');
    expect(first.truncated).toBe(false);
    expect(sampleInput(ada, 'in', first, [])).toBeUndefined();
    const full = await pod.page(ada, 'out');
    expect(full.statements).toEqual([]);
    const cut = engine(alice, dense(60));
    const input = sampleInput(ada, 'in', await cut.page(ada, 'in'), [])!;
    expect(await cut.sample(input)).toEqual({
      kinds: [],
      moreKinds: false,
      statements: [],
    });
    expect(cut.queries).toHaveLength(2);
  });
});

describe('bounds', () => {
  it('caps kinds and examples, however many the Pod has', async () => {
    const pod = engine(alice, [
      ...dense(60),
      ...Array.from({ length: 40 }, (_, k) =>
        Array.from(
          { length: 10 },
          (_, i) =>
            `<https://people.example/s${i}> <${P}k${String(k).padStart(2, '0')}> <${ada}> ${g(alice, 'many')} .`,
        ),
      ).flat(),
    ]);
    const input = sampleInput(ada, 'in', await pod.page(ada, 'in'), [])!;
    const kinds = await pod.select(kindsQuery(input));
    expect(kinds.rows).toHaveLength(MAX_KINDS + 1);
    const found = kindsOf(kinds, input);
    expect(found.kinds).toHaveLength(MAX_KINDS);
    expect(found.moreKinds).toBe(true);
    const examples = await pod.select(examplesQuery(input, found.kinds));
    expect(examples.rows).toHaveLength(MAX_KINDS * MAX_EXAMPLES);
    const sample = sampleOf(examples, alice, input, found);
    for (const kind of found.kinds)
      expect(
        sample.statements.filter((s) => s.predicate === kind),
      ).toHaveLength(MAX_EXAMPLES);
  });

  it('keeps its caps when a Pod ignores the filters and limits', async () => {
    const input: SampleInput = {
      root: ada,
      direction: 'in',
      shown: [`${P}a-follows`],
      hidden: [ctx(alice, 'private')],
    };
    const pod = engine(alice, [
      ...Array.from(
        { length: 30 },
        (_, i) =>
          `<https://people.example/s${i}> <${P}likes> <${ada}> ${g(alice, 'notes')} .`,
      ),
      `<https://people.example/h> <${P}likes> <${ada}> ${g(alice, 'private')} .`,
      `<https://people.example/u> <${P}a-follows> <${ada}> ${g(alice, 'notes')} .`,
    ]);
    // Everything, as a Pod without the filters would answer.
    const all = await pod.select(
      `SELECT ?g ?p ?other WHERE { GRAPH ?g { ?other ?p <${ada}> } } ORDER BY ?g ?p ?other`,
    );
    const found = kindsOf(all, input);
    expect(found.kinds).toEqual([`${P}likes`]);
    const sample = sampleOf(all, alice, input, found);
    expect(sample.statements).toHaveLength(MAX_EXAMPLES);
    expect(sample.statements.map((s) => s.context)).not.toContain(
      ctx(alice, 'private'),
    );
  });
});

describe('hidden Contexts', () => {
  it('never use up the kind or example limits', async () => {
    const hidden: Area[] = [{ pod: alice, context: ctx(alice, 'a-hidden') }];
    const pod = engine(alice, [
      ...dense(60),
      // Twenty kinds in a hidden Context, sorting before the visible ones.
      ...Array.from(
        { length: 20 },
        (_, k) =>
          `<https://people.example/h> <${P}b${String(k).padStart(2, '0')}> <${ada}> ${g(alice, 'a-hidden')} .`,
      ),
      // A visible kind whose first statements, by Context, are hidden.
      ...Array.from(
        { length: 5 },
        (_, i) =>
          `<https://people.example/h${i}> <${P}likes> <${ada}> ${g(alice, 'a-hidden')} .`,
      ),
      `<https://people.example/bo> <${P}likes> <${ada}> ${g(alice, 'z-visible')} .`,
      `<https://people.example/cy> <${P}cites> <${ada}> ${g(alice, 'z-visible')} .`,
    ]);
    const first = await pod.page(ada, 'in');
    const input = sampleInput(ada, 'in', first, hiddenIn(hidden, alice))!;
    expect(input.hidden).toEqual([ctx(alice, 'a-hidden')]);
    const sample = await pod.sample(input);
    expect(sample.kinds).toEqual([`${P}cites`, `${P}likes`]);
    expect(sample.moreKinds).toBe(false);
    expect(sample.statements.map(brief)).toEqual([
      ['in', `${P}cites`, 'https://people.example/cy', ctx(alice, 'z-visible')],
      ['in', `${P}likes`, 'https://people.example/bo', ctx(alice, 'z-visible')],
    ]);
  });

  it('do not count as shown: a kind only a hidden Context has on the page is sampled', async () => {
    const hidden: Area[] = [{ pod: alice, context: ctx(alice, 'people') }];
    const pod = engine(alice, [
      ...dense(60, alice, 'people'),
      `<https://people.example/v> <${P}a-follows> <${ada}> ${g(alice, 'visible')} .`,
    ]);
    const first = await pod.page(ada, 'in');
    const input = sampleInput(ada, 'in', first, hiddenIn(hidden, alice))!;
    expect(input.shown).toEqual([]);
    const sample = await pod.sample(input);
    const shown = neighborhood([{ pages: [first], sample }], hidden);
    // The hidden page shows nothing; the visible statement comes as example.
    expect(shown.statements).toEqual([]);
    expect(shown.examples.map(brief)).toEqual([
      [
        'in',
        `${P}a-follows`,
        'https://people.example/v',
        ctx(alice, 'visible'),
      ],
    ]);
  });
});

describe('later pages', () => {
  // The dense kind fills page one; `z-other` starts on page two.
  const data = [
    ...dense(70),
    ...Array.from(
      { length: 4 },
      (_, i) =>
        `<https://people.example/o${i}> <${P}z-other> <${ada}> ${g(alice, 'people')} .`,
    ),
    `_:only <${P}z-blank> <${ada}> ${g(alice, 'people')} .`,
  ];

  it('replace examples they hold, and complete pages replace the sample', async () => {
    const pod = engine(alice, data);
    const first = await pod.page(ada, 'in');
    const sample = await pod.sample(sampleInput(ada, 'in', first, [])!);
    expect(sample.kinds).toEqual([`${P}z-blank`, `${P}z-other`]);
    expect(
      neighborhood([{ pages: [first], sample }], []).examples,
    ).toHaveLength(1 + MAX_EXAMPLES);
    // A page that has not answered yet keeps the examples.
    expect(
      neighborhood([{ pages: [first, undefined], sample }], []).examples,
    ).toHaveLength(1 + MAX_EXAMPLES);
    const second = await pod.page(ada, 'in', 1);
    expect(second.truncated).toBe(false);
    const shown = neighborhood([{ pages: [first, second], sample }], []);
    // Each statement once; the blank node's examples go with the sample.
    expect(shown.statements).toHaveLength(75);
    expect(new Set(shown.statements.map((s) => s.key)).size).toBe(75);
    expect(shown.examples).toEqual([]);
    // No further query: a later page never starts a sample.
    expect(sampleInput(ada, 'in', first, [])).toEqual(
      sampleInput(ada, 'in', first, []),
    );
  });

  it('drop examples that a cut later page holds, except blank nodes', async () => {
    const pod = engine(alice, [
      ...data,
      ...dense(60).map((quad) => quad.replace('a-follows', 'zz-later')),
    ]);
    const first = await pod.page(ada, 'in');
    const sample = await pod.sample(sampleInput(ada, 'in', first, [])!);
    const second = await pod.page(ada, 'in', 1);
    expect(second.truncated).toBe(true);
    const shown = neighborhood([{ pages: [first, second], sample }], []);
    // Page two holds z-other and the first zz-later statements: their
    // examples are now ordinary statements, each once.
    expect(kindsIn(sample.statements)).toEqual([
      `${P}z-blank`,
      `${P}z-other`,
      `${P}zz-later`,
    ]);
    const keys = new Set(shown.statements.map((s) => s.key));
    expect(sample.statements.filter((s) => keys.has(s.key))).toHaveLength(
      2 * MAX_EXAMPLES,
    );
    // A blank node is local to its read: its example stays until the pages
    // of its source are complete.
    expect(shown.examples.map(brief)).toEqual([
      ['in', `${P}z-blank`, expect.any(String), ctx(alice, 'people')],
    ]);
  });
});

describe('several Pods and Contexts', () => {
  it('keeps the Pod, Context and direction of each statement apart', async () => {
    const quad = (pod: string, context: string) =>
      `<https://people.example/bo> <${P}likes> <${ada}> ${g(pod, context)} .`;
    const a = engine(alice, [...dense(60), quad(alice, 'x'), quad(alice, 'y')]);
    const b = engine(bob, [...dense(60, bob), quad(bob, 'x')]);
    const sources = [];
    for (const pod of [a, b]) {
      const first = await pod.page(ada, 'in');
      sources.push({
        pages: [first],
        sample: await pod.sample(sampleInput(ada, 'in', first, [])!),
      });
    }
    const shown = neighborhood(sources, []);
    expect(shown.statements).toHaveLength(2 * PAGE_SIZE);
    expect(shown.examples.map((s) => [s.pod, s.context])).toEqual([
      [alice, ctx(alice, 'x')],
      [alice, ctx(alice, 'y')],
      [bob, ctx(bob, 'x')],
    ]);
    // Hiding one Context of one Pod hides nothing else.
    const hidden = neighborhood(sources, [
      { pod: alice, context: ctx(alice, 'x') },
    ]);
    expect(hidden.examples.map((s) => [s.pod, s.context])).toEqual([
      [alice, ctx(alice, 'y')],
      [bob, ctx(bob, 'x')],
    ]);
  });

  it('keeps blank nodes of two reads apart, and one statement on two pages once', async () => {
    const pod = engine(alice, [`_:b <${P}likes> <${ada}> ${g(alice, 'x')} .`]);
    const once = await pod.page(ada, 'in');
    const again = await pod.page(ada, 'in');
    expect(once.statements[0]!.key).not.toBe(again.statements[0]!.key);
    const iri = engine(alice, [
      `<https://people.example/bo> <${P}likes> <${ada}> ${g(alice, 'x')} .`,
    ]);
    const pages: Page[] = [
      await iri.page(ada, 'in'),
      await iri.page(ada, 'in'),
    ];
    expect(neighborhood([{ pages }], []).statements).toHaveLength(1);
  });
});

describe('guide', () => {
  it('shows only code that the type-checked recipe contains verbatim', async () => {
    const { readFile } = await import('node:fs/promises');
    const read = (path: string) =>
      readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
    const guide = await read('docs/neighborhood.md');
    const recipe =
      (await read('examples/todo/recipes/neighborhood.ts')) +
      (await read('examples/todo/recipes/neighborhood-view.tsx'));
    const blocks = [...guide.matchAll(/```tsx?\n([\s\S]*?)```/g)].map(
      (match) => match[1]!,
    );
    expect(blocks.length).toBeGreaterThan(0);
    // Formatting may indent a fragment differently; the code is the same.
    const flat = (code: string) => code.replace(/^[ \t]+/gm, '');
    for (const block of blocks) expect(flat(recipe)).toContain(flat(block));
  });
});
