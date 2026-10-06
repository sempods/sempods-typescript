import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

// Importing a package must not start discovery or open browser facilities.
const originalFetch = globalThis.fetch;
let requests = 0;
globalThis.fetch = (...args) => {
  requests += 1;
  return originalFetch(...args);
};
const { bearer, createPod, decodeCatalogue } =
  await import('@sempods/client-sdk');
const { discoverPod, prepareAuthorization } =
  await import('@sempods/client-sdk/oauth');
const {
  createResourceEditor,
  dateTime,
  fields,
  listSubjects,
  newSubjectIri,
  text,
} = await import('@sempods/client-sdk/edit');
const { createLocale } = await import('@sempods/app-sdk');
assert.equal(requests, 0);
assert.equal(
  createLocale({ locale: 'de-DE' }).format.number(1234.5),
  '1.234,5',
);
assert.equal(
  decodeCatalogue(
    {
      '@id': 'https://pod.example/alice/_system/contexts',
      '@type': [
        'http://www.w3.org/ns/sparql-service-description#GraphCollection',
      ],
    },
    'https://pod.example/alice',
  ).length,
  0,
);

function noDomTypes() {
  // @ts-expect-error This consumer has Node types only, no DOM library.
  return window.document;
}
void noDomTypes;
const routes: string[] = [];
const server = createServer((req, res) => {
  assert.equal(req.headers.cookie, undefined);
  routes.push(`${req.method} ${(req.url ?? '').split('?')[0]}`);
  const pod = `http://${req.headers.host}/alice`;
  const task = `${pod}/tasks/1`;
  const resourcePath = `/alice/_system/resources/${Buffer.from(task, 'utf8').toString('base64url')}`;
  if ((req.url ?? '').startsWith(resourcePath)) {
    // Data requests carry the bearer; discovery requests never do.
    assert.equal(req.headers.authorization, 'Bearer node-token');
    assert.equal(
      new URL(req.url ?? '', pod).searchParams.get('context'),
      `${pod}/_system/contexts/tasks`,
    );
    if (req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'application/ld+json',
        etag: '"v1"',
      });
      res.end(JSON.stringify({ '@id': task }));
    } else {
      res.writeHead(req.headers['if-match'] === '"v1"' ? 204 : 412);
      res.end();
    }
    return;
  }
  assert.equal(req.headers.authorization, undefined);
  const resource = {
    resource: pod,
    authorization_servers: [pod],
    bearer_methods_supported: ['header'],
  };
  const authorization = {
    issuer: pod,
    authorization_endpoint: `${pod}/authorize`,
    token_endpoint: `${pod}/token`,
    registration_endpoint: `${pod}/register`,
    jwks_uri: `${pod}/jwks`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
  const body =
    req.url === '/alice/.well-known/oauth-protected-resource'
      ? resource
      : req.url === '/alice/.well-known/oauth-authorization-server'
        ? authorization
        : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const pod = `http://127.0.0.1:${address.port}/alice`;
  const discovery = await discoverPod(pod, { development: 'loopback-http' });
  assert.equal(discovery.issuer, pod);
  assert.equal(discovery.endpoints.token, `${pod}/token`);
  assert.equal(discovery.scopes.resource, null);
  assert.equal(discovery.supportsRefreshToken, false);
  assert.equal(requests, 2);
  const authorization = await prepareAuthorization(
    {
      pod: discovery,
      client: {
        kind: 'did-web',
        clientId: 'did:web:app.example',
        podUrl: pod,
        issuer: pod,
        redirectUri: 'https://app.example/callback',
      },
      scopes: ['tasks'],
    },
    { development: 'loopback-http' },
  );
  assert.equal(new URL(authorization.url).searchParams.get('scope'), 'tasks');
  assert.equal('connectionId' in authorization.attempt, false);
  assert.equal('expiresAt' in authorization.attempt, false);
  assert.equal(requests, 2); // Preparation is portable computation, without browser/storage/I/O.

  const tasks = createPod(pod, {
    auth: bearer('node-token'),
    development: 'loopback-http',
  }).context(`${pod}/_system/contexts/tasks`);
  const read = await tasks.subjects.get(`${pod}/tasks/1`);
  assert.ok(read.kind === 'ok');
  assert.equal(read.etag, '"v1"');
  assert.deepEqual(
    await tasks.subjects.patch(
      `${pod}/tasks/1`,
      { 'https://schema.org/name': [{ '@value': 'Done' }] },
      { ifMatch: read.etag },
    ),
    { kind: 'applied', status: 204 },
  );
  assert.deepEqual(
    await tasks.subjects.patch(`${pod}/tasks/1`, {}, { ifMatch: '"old"' }),
    { kind: 'precondition-failed' },
  );
  // The packed edit entry opens the same resource through the client view.
  const editor = createResourceEditor(
    tasks,
    `${pod}/tasks/1`,
    fields({ title: text('https://schema.org/name', { language: null }) }),
  );
  await editor.loaded;
  assert.equal(editor.state.phase, 'ready');
  assert.equal(typeof listSubjects, 'function');
  assert.match(
    newSubjectIri(tasks, 'tasks'),
    /^http:\/\/127\.0\.0\.1:\d+\/alice\/tasks\//,
  );
  assert.deepEqual(editor.state.draft, { title: '' });
  editor.dispose();
  // Typed literals through the packed declarations: optional reads as null.
  const timed = fields({
    end: dateTime('https://schema.org/endTime', { optional: true }),
  });
  const end: string | null = timed.read({}).end;
  assert.equal(end, null);
  assert.equal(timed.valid?.({ end: '2026-10-05T09:30' }), false);
  assert.deepEqual(timed.patch({}, { end: '2026-10-05T09:30:00+02:00' }), {
    'https://schema.org/endTime': [
      {
        '@value': '2026-10-05T09:30:00+02:00',
        '@type': 'http://www.w3.org/2001/XMLSchema#dateTime',
      },
    ],
  });
  assert.equal(routes.length, 6);
  assert.deepEqual(routes.slice(0, 2), [
    'GET /alice/.well-known/oauth-protected-resource',
    'GET /alice/.well-known/oauth-authorization-server',
  ]);
} finally {
  globalThis.fetch = originalFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
console.log(
  'Packed Node ESM, Node-only declarations, loopback discovery, a conditional read/write and the edit entry passed.',
);
