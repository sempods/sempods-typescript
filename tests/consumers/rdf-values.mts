import assert from 'node:assert/strict';
import { createLocale } from '@sempods/app-sdk';
import { anonymous, createPod } from '@sempods/client-sdk';
// The React-free RDF value recipe, copied from the installed package.
import { commonVocabulary, describeValue } from './rdf-values.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const pod = createPod('https://pod.example/alice', {
  auth: anonymous(),
  fetch: async () =>
    new Response(
      JSON.stringify({
        head: { vars: ['value'] },
        results: {
          bindings: [
            {
              value: {
                type: 'literal',
                value: '2026-10-05T23:30:00Z',
                datatype: `${XSD}dateTime`,
              },
            },
            { value: { type: 'literal', value: 'https://example.org/a?x' } },
          ],
        },
      }),
      { headers: { 'content-type': 'application/sparql-results+json' } },
    ),
});
const answer = await pod.sparql.select('SELECT ?value WHERE { ?s ?p ?value }');
if (answer.kind !== 'ok') throw new Error(answer.kind);
const [instant, link] = answer.body.rows.map((row) => row['value']!);
const show = (timeZone: string, term: typeof instant) => {
  const { format, language } = createLocale({ locale: 'de-DE', timeZone });
  return describeValue(term!, {
    format,
    language,
    vocabulary: commonVocabulary,
    texts: { blank: 'Knoten', unsupported: 'Nicht unterstützt' },
  });
};
assert.equal(show('Europe/Berlin', instant).text, '06.10.2026, 01:30');
assert.equal(show('America/New_York', instant).text, '05.10.2026, 19:30');
assert.deepEqual(show('UTC', link), {
  text: 'example.org/a',
  exact: '"https://example.org/a?x"',
  address: {
    href: 'https://example.org/a?x',
    host: 'example.org',
    path: '/a',
  },
});
console.log(
  'Packed RDF value recipe: dates in explicit zones, exact terms, web address.',
);
