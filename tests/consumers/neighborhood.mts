import assert from 'node:assert/strict';
import { anonymous, createPod } from '@sempods/client-sdk';
// The React-free neighborhood recipe, copied from the installed package.
import {
  MAX_EXAMPLES,
  PAGE_SIZE,
  examplesQuery,
  predicatesOf,
  predicatesQuery,
  neighborhood,
  pageOf,
  pageQuery,
  sampleInput,
  sampleOf,
} from './neighborhood.js';

const alice = 'https://pod.example/alice';
const ada = 'https://people.example/ada';
const context = `${alice}/_system/contexts/people`;
const row = (p: string, other: string) => ({
  g: { type: 'uri', value: context },
  p: { type: 'uri', value: p },
  other: { type: 'uri', value: other },
});
// A dense first page of one kind; the sample finds another.
const answers: Record<string, unknown[]> = {
  page: Array.from({ length: PAGE_SIZE + 1 }, (_, i) =>
    row('urn:p:follows', `https://people.example/f${i}`),
  ),
  kinds: [{ p: { type: 'uri', value: 'urn:p:likes' } }],
  examples: Array.from({ length: 5 }, (_, i) =>
    row('urn:p:likes', `https://people.example/l${i}`),
  ),
};
const pod = createPod(alice, {
  auth: anonymous(),
  fetch: async (_url, init) => {
    const query = String(init?.body);
    const kind = query.includes('VALUES ?p')
      ? 'examples'
      : query.startsWith('SELECT DISTINCT ?p ')
        ? 'kinds'
        : 'page';
    return new Response(
      JSON.stringify({
        head: { vars: ['g', 'p', 'other'] },
        results: { bindings: answers[kind] },
      }),
      { headers: { 'content-type': 'application/sparql-results+json' } },
    );
  },
});
async function select(query: string) {
  const answer = await pod.sparql.select(query);
  if (answer.kind !== 'ok') throw new Error(answer.kind);
  return answer.body;
}
const first = pageOf(await select(pageQuery(ada, 'in', 0)), alice, 'in');
assert.equal(first.truncated, true);
const input = sampleInput(ada, 'in', first, []);
assert.ok(input);
assert.deepEqual(input.shown, ['urn:p:follows']);
const found = predicatesOf(await select(predicatesQuery(input)), input);
const sample = sampleOf(
  await select(examplesQuery(input, found.predicates)),
  alice,
  input,
  found,
);
// The Pod answered five; the recipe keeps its cap.
assert.equal(sample.statements.length, MAX_EXAMPLES);
const shown = neighborhood([{ pages: [first], sample }], []);
assert.equal(shown.statements.length, PAGE_SIZE);
assert.deepEqual(
  shown.examples.map((s) => [s.direction, s.predicate, s.context]),
  Array.from({ length: MAX_EXAMPLES }, () => ['in', 'urn:p:likes', context]),
);
console.log('Packed neighborhood recipe: pages, bounded sample, provenance.');
