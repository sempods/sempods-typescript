// Measures Pod-wide SPARQL reads through @sempods/client-sdk against a real pod server
// (sempods-typescript#40).
//
// Usage (after `pnpm build`):
//   POD_READ_CREDENTIALS=path/to/credentials.json node scripts/measure-pod-reads.mjs \
//     [--clients seeder,reader] [--runs 5] [--warmup 1] [--timeout 30000] [--catalogue]
//
// The credentials file is local and never committed:
//   { "podUrl": "http://localhost:8090/perf10k",
//     "tokenEndpoint": "http://localhost:8090/perf10k/_system/auth/token",
//     "clients": { "<name>": { "clientId": "...", "secret": "..." } } }
// Each client is a sempods service client using client_credentials, wired into the SDK
// through its PodAuth seam; the pod decides what it may read. Queries run through
// pod.sparql.select()/construct(), which send no dataset parameters. --catalogue also
// measures pod.catalogue(), the complete catalogue that Pod reads must not need.
// Results go to test-results/pod-reads/ (git-ignored); tokens and secrets are never
// printed or written.
//
// The default query set assumes the vocabulary of the local `perf10k` seed (schema:Action
// tasks with schema:agent pointing to schema:Person entries in one people context).
// Override the people context with POD_READ_PEOPLE_CONTEXT.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { argv, env, exit, version as nodeVersion } from 'node:process';

const SCHEMA = 'PREFIX schema: <https://schema.org/>\n';

const { createPod } =
  await import('../packages/client-sdk/dist/index.js').catch(() =>
    fail('Build the SDK first: pnpm build'),
  );
const options = parseArgs(argv.slice(2));
const credentialsPath = env.POD_READ_CREDENTIALS;
if (!credentialsPath)
  fail('Set POD_READ_CREDENTIALS to the credentials JSON file.');
const credentials = JSON.parse(await readFile(credentialsPath, 'utf8'));
const podUrl = String(credentials.podUrl).replace(/\/$/, '');
const people =
  env.POD_READ_PEOPLE_CONTEXT ??
  `${podUrl}/_system/contexts/apps/seeder/people`;
const clientNames = options.clients ?? Object.keys(credentials.clients ?? {});
if (!clientNames.length) fail('No clients in the credentials file.');

const QUERIES = [
  {
    id: 'count-default',
    note: 'COUNT over the default graph (union of readable contexts)',
    text: `${SCHEMA}SELECT (COUNT(*) AS ?n) WHERE { ?s a schema:Action }`,
  },
  {
    id: 'count-graph',
    note: 'COUNT with GRAPH ?g (named-graph membership)',
    text: `${SCHEMA}SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s a schema:Action } }`,
  },
  {
    id: 'list-default',
    note: '1,000 tasks without provenance',
    text: `${SCHEMA}SELECT ?task ?name WHERE { ?task a schema:Action ; schema:name ?name } LIMIT 1000`,
  },
  {
    id: 'list-provenance',
    note: '1,000 tasks with their context (GRAPH ?g)',
    text: `${SCHEMA}SELECT ?task ?name ?g WHERE { GRAPH ?g { ?task a schema:Action ; schema:name ?name } } LIMIT 1000`,
  },
  {
    id: 'join-named-people',
    note: 'cross-context join, people context named in the query',
    text: `${SCHEMA}SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?t schema:agent ?p } GRAPH <${people}> { ?p schema:name ?name } }`,
  },
  {
    id: 'join-open-graphs',
    note: 'cross-context join over two open graph variables',
    text: `${SCHEMA}SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?t schema:agent ?p } GRAPH ?h { ?p schema:name ?name } }`,
  },
  {
    id: 'join-default',
    note: 'cross-context join over the default graph',
    text: `${SCHEMA}SELECT (COUNT(*) AS ?n) WHERE { ?t schema:agent ?p . ?p schema:name ?name }`,
  },
  {
    id: 'empty-projection',
    note: 'no match: head.vars must still list ?a ?b',
    expectVars: ['a', 'b'],
    text: 'SELECT ?a ?b WHERE { ?a <urn:sempods:measure:none> ?b }',
  },
  {
    id: 'construct-sample',
    note: 'CONSTRUCT of 100 task names as JSON-LD',
    construct: true,
    text: `${SCHEMA}CONSTRUCT { ?t schema:name ?n } WHERE { ?t a schema:Action ; schema:name ?n } LIMIT 100`,
  },
];

const started = new Date().toISOString();
const results = [];
for (const name of clientNames) {
  const client = credentials.clients?.[name];
  if (!client) fail(`Client "${name}" is not in the credentials file.`);
  const counters = { token: 0, pod: 0 };
  const pod = createPod(podUrl, {
    auth: clientCredentials(client, counters),
    fetch: (url, init) => {
      counters.pod++;
      return fetch(url, init);
    },
    ...(new URL(podUrl).protocol === 'http:'
      ? { development: 'loopback-http' }
      : {}),
  });
  if (options.catalogue)
    results.push(
      await measure(
        name,
        { id: 'catalogue', note: 'pod.catalogue() (complete, decoded)' },
        (signal) => catalogue(pod, signal),
        counters,
      ),
    );
  for (const query of QUERIES)
    results.push(
      await measure(
        name,
        query,
        (signal) => sparql(pod, query, signal),
        counters,
      ),
    );
  results.push({ client: name, tokenRequests: counters.token });
}

const evidence = {
  started,
  finished: new Date().toISOString(),
  via: '@sempods/client-sdk pod.sparql / pod.catalogue',
  pod: podUrl,
  serverRevision: env.POD_READ_SERVER_REVISION ?? null,
  sdkRevision: gitRevision(),
  node: nodeVersion,
  runs: options.runs,
  warmup: options.warmup,
  timeoutMs: options.timeout,
  queries: QUERIES.map(({ id, note, construct, text }) => ({
    id,
    note,
    form: construct ? 'construct' : 'select',
    text,
  })),
  results,
};
await mkdir('test-results/pod-reads', { recursive: true });
const file = `test-results/pod-reads/${started.replace(/[:.]/g, '-')}.json`;
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
printTable(results);
console.log(`\nEvidence: ${file}`);

/**
 * PodAuth for one service client: one immutable credential object per token, renewed
 * shortly before expiry or after a refused request; concurrent renewals share one call.
 */
function clientCredentials(client, counters) {
  const basic = Buffer.from(
    `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`,
  ).toString('base64');
  let current;
  let expires = 0;
  let pending;
  const issue = () =>
    (pending ??= (async () => {
      counters.token++;
      const response = await fetch(credentials.tokenEndpoint, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      if (!response.ok)
        throw new Error(`Token request failed with HTTP ${response.status}.`);
      const body = await response.json();
      current = Object.freeze({ authorization: `Bearer ${body.access_token}` });
      expires =
        performance.now() + (Number(body.expires_in ?? 600) - 60) * 1000;
    })().finally(() => {
      pending = undefined;
    }));
  return {
    async credential() {
      if (!current || performance.now() > expires) await issue();
      return current;
    },
    async renew(refused) {
      if (refused !== current) return current !== undefined;
      await issue().catch(() => {});
      return current !== refused;
    },
  };
}

async function sparql(pod, query, signal) {
  const result = query.construct
    ? await pod.sparql.construct(query.text, { signal })
    : await pod.sparql.select(query.text, { signal });
  if (result.kind !== 'ok') return { outcome: outcomeOf(result) };
  if (query.construct) return { outcome: 'ok', rows: result.body.length };
  const { variables, rows } = result.body;
  const value = rows[0]?.n?.value;
  return {
    outcome: 'ok',
    rows: rows.length,
    ...(value === undefined ? {} : { value: Number(value) }),
    ...(query.expectVars
      ? {
          vars: variables,
          headConforms:
            variables.length === query.expectVars.length &&
            query.expectVars.every((v) => variables.includes(v)),
        }
      : {}),
  };
}

async function catalogue(pod, signal) {
  const result = await pod.catalogue({ signal });
  return result.kind === 'ok'
    ? {
        outcome: 'ok',
        rows: result.body.length,
        readable: result.body.filter((c) => c.readable).length,
      }
    : { outcome: outcomeOf(result) };
}

/** Runs warm-up and measured samples; each sample times one SDK call to its decoded result. */
async function measure(client, query, call, counters) {
  const samples = [];
  for (let i = 0; i < options.warmup + options.runs; i++) {
    const controller = new globalThis.AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeout);
    const before = counters.pod;
    const begin = performance.now();
    let sample;
    try {
      sample = await call(controller.signal);
    } catch (error) {
      sample = { outcome: errorOf(error) };
    } finally {
      clearTimeout(timer);
    }
    sample.ms = performance.now() - begin;
    sample.requests = counters.pod - before;
    if (i >= options.warmup) samples.push(sample);
  }
  const times = samples.map((s) => s.ms).sort((a, b) => a - b);
  const pick = (q) =>
    times[Math.min(times.length - 1, Math.floor(q * times.length))];
  const outcomes = {};
  for (const s of samples) outcomes[s.outcome] = (outcomes[s.outcome] ?? 0) + 1;
  const last = samples.at(-1);
  return {
    client,
    query: query.id,
    note: query.note,
    outcomes,
    minMs: round(times[0]),
    medianMs: round(pick(0.5)),
    p95Ms: round(pick(0.95)),
    requestsPerCall: [...new Set(samples.map((s) => s.requests))],
    ...pickDefined(last, ['rows', 'readable', 'value', 'vars', 'headConforms']),
    samples: samples.map(({ outcome, ms, requests }) => ({
      outcome,
      ms: round(ms),
      requests,
    })),
  };
}

function outcomeOf(result) {
  return result.kind === 'refused' ? `refused ${result.status}` : result.kind;
}

/** SDK failures are reported by their stable reason, never by message text. */
function errorOf(error) {
  const reason = error?.name === 'SdkError' ? error.reason : undefined;
  if (!reason) return `error ${error?.name ?? 'unknown'}`;
  return [reason.code, reason.status, reason.problem].filter(Boolean).join(' ');
}

function printTable(rows) {
  console.log(
    '| client | query | outcome | median ms | p95 ms | requests | rows | value | note |',
  );
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    if (!r.query) {
      console.log(
        `| ${r.client} | (token requests) | | | | ${r.tokenRequests} | | | |`,
      );
      continue;
    }
    const outcome = Object.entries(r.outcomes)
      .map(([k, v]) => `${k} ×${v}`)
      .join(', ');
    const head =
      r.headConforms === undefined
        ? ''
        : ` — head.vars ${r.headConforms ? 'ok' : `wrong: ${JSON.stringify(r.vars)}`}`;
    const readable =
      r.readable === undefined ? '' : ` (${r.readable} readable)`;
    console.log(
      `| ${r.client} | ${r.query} | ${outcome} | ${r.medianMs} | ${r.p95Ms} | ${r.requestsPerCall.join('/')} | ${r.rows ?? ''}${readable} | ${r.value ?? ''} | ${r.note}${head} |`,
    );
  }
}

function parseArgs(args) {
  const parsed = {
    runs: 5,
    warmup: 1,
    timeout: 30000,
    catalogue: false,
    clients: undefined,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--catalogue') parsed.catalogue = true;
    else if (arg === '--clients')
      parsed.clients = args[++i]?.split(',').filter(Boolean);
    else if (arg === '--runs') parsed.runs = Number(args[++i]);
    else if (arg === '--warmup') parsed.warmup = Number(args[++i]);
    else if (arg === '--timeout') parsed.timeout = Number(args[++i]);
    else fail(`Unknown argument ${arg}.`);
  }
  if (!(parsed.runs >= 1) || !(parsed.warmup >= 0) || !(parsed.timeout > 0))
    fail('--runs must be >= 1, --warmup >= 0, --timeout > 0.');
  return parsed;
}

function pickDefined(object, keys) {
  return Object.fromEntries(
    keys.filter((k) => object?.[k] !== undefined).map((k) => [k, object[k]]),
  );
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function round(ms) {
  return ms === undefined ? undefined : Math.round(ms * 10) / 10;
}

function fail(message) {
  console.error(message);
  exit(1);
}
