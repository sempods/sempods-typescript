/* global URLSearchParams */
/**
 * Loopback fixture for the UI gate, not evidence from a deployed Kotlin pod:
 * serves the built gate app and a Pod at /alice on the same origin (OAuth
 * with PKCE, two contexts, list and conditional edit). Ported from the
 * template's spike #120 harness. Test endpoints: /__reset restores the seed,
 * /__store returns the stored bodies and versions as written.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const schema = 'https://schema.org/';
const xsd = 'http://www.w3.org/2001/XMLSchema#';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/**
 * Tasks in "work": two xsd:date start days, one zoned xsd:dateTime that must
 * survive unchanged, one without a date; and the first subject again in
 * "personal" with its own title.
 */
function seed(base) {
  const work = base + '/_system/contexts/work';
  const tasks = new Map();
  const titles = [
    ['Call the plumber about the kitchen tap', '2026-10-28'],
    ['Draft the club newsletter', ''],
    ['Book train tickets to Leipzig', '2026-10-30T09:30:00+02:00'],
    ['Return the library books', ''],
  ];
  titles.forEach(([title, planned], i) => {
    const iri = `${base}/tasks/${i + 1}`;
    tasks.set(work + '|' + iri, {
      context: work,
      version: 1,
      body: {
        '@id': iri,
        '@type': [schema + 'Action'],
        [schema + 'name']: [{ '@value': title }],
        [schema + 'actionStatus']: [
          { '@id': schema + 'PotentialActionStatus' },
        ],
        ...(planned
          ? {
              [schema + 'startDate']: [
                {
                  '@value': planned,
                  '@type': xsd + (planned.includes('T') ? 'dateTime' : 'date'),
                },
              ],
            }
          : {}),
      },
    });
  });
  const personal = base + '/_system/contexts/personal';
  const iri = `${base}/tasks/1`;
  tasks.set(personal + '|' + iri, {
    context: personal,
    version: 1,
    body: {
      '@id': iri,
      '@type': [schema + 'Action'],
      [schema + 'name']: [{ '@value': 'Call the plumber (personal copy)' }],
      [schema + 'actionStatus']: [{ '@id': schema + 'PotentialActionStatus' }],
    },
  });
  return tasks;
}

/** RFC 7396 merge patch, as the client sends it: `null` removes a member. */
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch))
    return patch;
  const result =
    target && typeof target === 'object' && !Array.isArray(target)
      ? { ...target }
      : {};
  for (const [key, value] of Object.entries(patch))
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  return result;
}

/** Starts the server for the built app in `dist`; resolves to its origin. */
export async function startPod(dist) {
  const codes = new Map();
  const files = new Map();
  let tasks;
  let version = 10;
  let registrations = 0;
  const server = createServer(async (req, res) => {
    const origin = 'http://' + req.headers.host;
    const url = new URL(req.url ?? '/', origin);
    const base = origin + '/alice';
    tasks ??= seed(base);
    const json = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/__reset') {
      tasks = seed(base);
      return json({ ok: true });
    }
    if (url.pathname === '/__store') return json([...tasks.values()]);
    if (!url.pathname.startsWith('/alice')) {
      // The app: a file of the build, otherwise its index (callback, routes).
      const file = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      const path = join(dist, extname(file) ? file : 'index.html');
      try {
        let body = files.get(path);
        if (!body) files.set(path, (body = await readFile(path)));
        res.writeHead(200, {
          'content-type': types[extname(path)] ?? 'application/octet-stream',
          // Built assets have content hashes in their names.
          'cache-control': file.startsWith('/assets/')
            ? 'max-age=31536000, immutable'
            : 'no-cache',
        });
        return res.end(body);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }
    if (url.pathname.endsWith('/.well-known/oauth-protected-resource'))
      return json({
        resource: base,
        authorization_servers: [base],
        bearer_methods_supported: ['header'],
      });
    if (url.pathname.endsWith('/.well-known/oauth-authorization-server'))
      return json({
        issuer: base,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: base + '/_system/auth/authorize',
        token_endpoint: base + '/_system/auth/token',
        registration_endpoint: base + '/_system/auth/register',
        jwks_uri: base + '/_system/auth/jwks.json',
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname.endsWith('/authorize')) {
      const code = 'code-' + codes.size + '-' + Date.now();
      codes.set(code, {
        client: url.searchParams.get('client_id') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
      });
      const redirect = new URL(url.searchParams.get('redirect_uri') ?? origin);
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', url.searchParams.get('state') ?? '');
      redirect.searchParams.set('iss', base);
      res.writeHead(302, { location: redirect.href });
      return res.end();
    }
    let body = '';
    try {
      for await (const chunk of req) body += chunk;
    } catch {
      // The page went away mid-request (a check leaving the document).
      return;
    }
    if (url.pathname.endsWith('/register'))
      return json(
        { ...JSON.parse(body), client_id: 'dyn:' + ++registrations },
        201,
      );
    if (url.pathname.endsWith('/token')) {
      const params = new URLSearchParams(body);
      const code = codes.get(params.get('code') ?? '');
      if (!code) return json({ error: 'invalid_grant' }, 400);
      const verifier = createHash('sha256')
        .update(params.get('code_verifier') ?? '')
        .digest('base64url');
      if (verifier !== code.challenge)
        return json({ error: 'invalid_grant' }, 400);
      const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
      const now = Math.floor(Date.now() / 1000);
      const token = `${enc({ alg: 'RS256' })}.${enc({ iss: base, client_id: code.client, sub: base + '/person', iat: now, exp: now + 3600, scope: '' })}.c2lnbmF0dXJl`;
      return json({
        access_token: token,
        token_type: 'Bearer',
        refresh_token: 'fixture-refresh',
      });
    }
    const contexts = ['work', 'personal'].map(
      (name) => base + '/_system/contexts/' + name,
    );
    if (url.pathname.endsWith('/_system/contexts')) {
      const refs = contexts.map((iri) => ({ '@id': iri }));
      return json({
        '@id': base + '/_system/contexts',
        '@type': [
          'http://www.w3.org/ns/sparql-service-description#GraphCollection',
        ],
        'http://www.w3.org/ns/sparql-service-description#namedGraph': refs,
        'https://schema.sempods.org/readableContext': refs,
        'https://schema.sempods.org/writableContext': refs,
      });
    }
    if (url.pathname.endsWith('/sparql/query')) {
      const target = url.searchParams.get('default-graph-uri');
      return json(
        [...tasks.values()]
          .filter((task) => task.context === target)
          .map((task) => task.body),
      );
    }
    if (url.pathname.includes('/_system/resources/')) {
      const iri = Buffer.from(
        url.pathname.split('/').at(-1) ?? '',
        'base64url',
      ).toString();
      const context = url.searchParams.get('context') ?? '';
      if (!contexts.includes(context)) return json({}, 400);
      const key = context + '|' + iri;
      const task = tasks.get(key);
      if (req.method === 'GET')
        return task
          ? json(task.body, 200, { etag: `"v${task.version}"` })
          : json({}, 404);
      if (req.method === 'PUT') {
        if (task) return json({}, 412);
        tasks.set(key, { context, body: JSON.parse(body), version: ++version });
        res.writeHead(201);
        return res.end();
      }
      if (!task) return json({}, 404);
      if (req.headers['if-match'] !== `"v${task.version}"`)
        return json({}, 412);
      if (req.method === 'PATCH')
        tasks.set(key, {
          ...task,
          body: mergePatch(task.body, JSON.parse(body)),
          version: ++version,
        });
      else if (req.method === 'DELETE') tasks.delete(key);
      else return json({}, 405);
      res.writeHead(204);
      return res.end();
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
