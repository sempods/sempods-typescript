// Regenerates packages/client-sdk/src/fixtures/w3c-to-rdf.json from a local
// checkout of https://github.com/w3c/json-ld-api (tests/ is enough):
//   node scripts/vendor-w3c-to-rdf.mjs <path-to-json-ld-api> && pnpm format
// Copy the notice in w3c-to-rdf.NOTICE.md forward with the new commit.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const repo = process.argv[2];
if (!repo)
  throw new Error('Usage: vendor-w3c-to-rdf.mjs <json-ld-api checkout>');
const out = new URL(
  '../packages/client-sdk/src/fixtures/w3c-to-rdf.json',
  import.meta.url,
);
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const tests = join(repo, 'tests');
const manifest = JSON.parse(
  readFileSync(join(tests, 'toRdf-manifest.jsonld'), 'utf8'),
);

const inert = (context) =>
  context === null ||
  (typeof context === 'object' &&
    !Array.isArray(context) &&
    Object.keys(context).length === 0) ||
  (Array.isArray(context) && context.every(inert));
const active = (value) =>
  Array.isArray(value)
    ? value.some(active)
    : typeof value === 'object' && value !== null
      ? ('@context' in value && !inert(value['@context'])) ||
        Object.values(value).some(active)
      : false;
const OPTIONS = {
  expandContext: 'expandContext supplies a context',
  rdfDirection:
    'rdfDirection is a non-default toRdf option the SDK does not offer',
  produceGeneralizedRdf: 'generalized RDF is not RDF the SDK hands out',
};

const cases = [];
const excluded = { 'active context': 0 };
for (const test of manifest.sequence) {
  const text = readFileSync(join(tests, test.input), 'utf8');
  const option = test.option ?? {};
  if (active(JSON.parse(text))) {
    excluded['active context'] += 1;
    continue;
  }
  const reason =
    option.specVersion === 'json-ld-1.0'
      ? 'JSON-LD 1.0 processing mode'
      : Object.entries(OPTIONS).find(([key]) => key in option)?.[1];
  if (reason) {
    (excluded[reason] ??= []).push(test['@id']);
    continue;
  }
  const type = test['@type'];
  const kind = type.includes('jld:NegativeEvaluationTest')
    ? 'negative'
    : type.includes('jld:PositiveSyntaxTest')
      ? 'syntax'
      : 'positive';
  cases.push({
    id: test['@id'],
    name: test.name,
    kind,
    base: option.base ?? `${manifest.baseIri}${test.input}`,
    input: text,
    ...(kind === 'positive'
      ? { expect: readFileSync(join(tests, test.expect), 'utf8') }
      : {}),
    ...(kind === 'negative' ? { error: test.expectErrorCode } : {}),
  });
}

const fixture = {
  $source: {
    repository: 'https://github.com/w3c/json-ld-api',
    commit,
    path: 'tests/toRdf-manifest.jsonld',
    license: 'W3C Test Suite License (2008 version), see the notice',
    notice: 'w3c-to-rdf.NOTICE.md',
    note: "Selection: every case of the manifest whose input has no @context other than null, {} or a list of them, and that needs no expandContext, rdfDirection or JSON-LD 1.0 option. Each input is the original file's text and each expected output the original N-Quads, both unchanged; base is the manifest's baseIri plus the input path, or the case's base option. Regenerate with scripts/vendor-w3c-to-rdf.mjs rather than edit.",
    total: manifest.sequence.length,
    excluded,
  },
  cases,
};
writeFileSync(out, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${cases.length} cases from ${commit}`);
