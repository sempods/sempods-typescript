import assert from 'node:assert/strict';
import { anonymous, createPod } from '@sempods/client-sdk';
// The React-free resource card recipe, copied from the installed package.
import {
  cardQuery,
  exampleRules,
  previewCandidates,
  resourceCards,
  sourceFacts,
} from './resource-cards.js';

const S = 'https://schema.org/';
const ada = 'https://people.example/ada';
const photo = 'https://people.example/ada/photo';
const context = 'https://pod.example/alice/_system/contexts/people';
const statement = (s: string, p: string, o: string) => ({
  s: { type: 'uri', value: s },
  p: { type: 'uri', value: p },
  o: { type: 'uri', value: o },
  g: { type: 'uri', value: context },
});
const pod = createPod('https://pod.example/alice', {
  auth: anonymous(),
  fetch: async () =>
    new Response(
      JSON.stringify({
        head: { vars: ['s', 'p', 'o', 'g'] },
        results: {
          bindings: [
            statement(ada, `${S}image`, photo),
            statement(photo, `${S}contentUrl`, 'https://img.example/a.jpg'),
            statement(photo, `${S}thumbnailUrl`, 'https://img.example/s.jpg'),
            statement(ada, `${S}image`, 'https://127.0.0.1/a.jpg'),
          ],
        },
      }),
      { headers: { 'content-type': 'application/sparql-results+json' } },
    ),
});
const answer = await pod.sparql.select(cardQuery(ada, exampleRules));
if (answer.kind !== 'ok') throw new Error(answer.kind);
const facts = sourceFacts(
  answer.body,
  ada,
  'https://pod.example/alice',
  exampleRules,
);
const card = resourceCards([ada], [facts], exampleRules).get(ada);
assert.ok(card);
assert.equal(card.rule, 'resource');
assert.equal(card.refused, 1);
assert.deepEqual(previewCandidates(card.images), [
  'https://img.example/s.jpg',
  'https://img.example/a.jpg',
]);
assert.deepEqual(
  card.images[0]?.variants[0]?.evidence.map((e) => e.context),
  [context, context],
);
console.log(
  'Packed resource card recipe: declared paths, variants, evidence, address guard.',
);
