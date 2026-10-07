/* global document, window, URLSearchParams, sessionStorage */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import {
  prepareWidgets,
  widgetData,
  checkWidgets,
} from './widget-consumer.mjs';

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'sempods-runtime-'));
let browser;
let server;
try {
  for (const name of ['client-sdk', 'app-sdk'])
    execFileSync('pnpm', ['pack', '--pack-destination', temp], {
      cwd: join(root, 'packages', name),
      stdio: 'pipe',
    });
  const dependencies = {};
  for (const name of await readdir(temp)) {
    if (!name.endsWith('.tgz')) continue;
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', join(temp, name), 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    dependencies[manifest.name] = 'file:' + join(temp, name);
  }
  const tools = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ).devDependencies;
  dependencies.react = tools.react;
  dependencies['react-dom'] = tools['react-dom'];
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies,
      devDependencies: {
        typescript: tools.typescript,
        '@types/react': tools['@types/react'],
        '@types/react-dom': tools['@types/react-dom'],
      },
    }),
  );
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: temp, stdio: 'pipe' },
  );
  await cp(
    join(root, 'tests/runtime-browser/consumer.ts'),
    join(temp, 'consumer.ts'),
  );
  await cp(
    join(root, 'tests/runtime-browser/preset.tsx'),
    join(temp, 'preset.tsx'),
  );
  await cp(
    join(root, 'tests/runtime-browser/overview.tsx'),
    join(temp, 'overview.tsx'),
  );
  await cp(
    join(root, 'examples/todo/recipes/pod-overview.tsx'),
    join(temp, 'pod-overview.tsx'),
  );
  await writeFile(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'Bundler',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        skipLibCheck: false,
        noEmit: true,
        jsx: 'react-jsx',
      },
      files: ['consumer.ts', 'preset.tsx', 'overview.tsx'],
    }),
  );
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    { cwd: temp, stdio: 'inherit' },
  );
  const bundle = await build({
    absWorkingDir: temp,
    entryPoints: ['consumer.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(bundle.metafile.inputs).every((path) => !path.includes(root)),
  );
  const presetBundle = await build({
    absWorkingDir: temp,
    entryPoints: ['preset.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(presetBundle.metafile.inputs).every(
      (path) => !path.includes(root),
    ),
  );
  const widgets = await prepareWidgets(root, temp);
  const overviewBundle = await build({
    absWorkingDir: temp,
    entryPoints: ['overview.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(overviewBundle.metafile.inputs).every(
      (path) => !path.includes(root),
    ),
  );
  const widgetFixture = widgetData();
  const clients = new Map();
  const codes = new Map();
  const grants = new Map();
  const traffic = [];
  const serverErrors = [];
  let registrations = 0;
  let exchanges = 0;
  let refreshes = 0;
  let overviewRefuse = false;
  let delayedOffline = false;
  let delayedScope = 'tasks';
  // The expiring Pod issues short-lived tokens and refuses them after expiry,
  // without a challenge ('none') or with `Bearer error="invalid_token"`.
  const expiringLifetime = 4;
  const accessExpiry = new Map();
  let expiringChallenge = 'none';
  let expiringRefusal = false;
  let expiredRejections = 0;
  // The overview recipe's editable note, read and written only inside its Context.
  let overviewNote = {
    '@id': 'urn:overview-note',
    '@type': ['urn:Note'],
    'urn:note:title': [{ '@value': 'First note' }],
  };
  let overviewNoteVersion = 1;
  let overviewNoteWrites = 0;
  let writeMode = 'normal';
  let writes = 0;
  let version = 1;
  let task = {
    '@id': 'urn:fixture-task',
    'https://schema.org/name': [
      { '@value': 'Original', '@language': 'en' },
      { '@value': 'Original DE', '@language': 'de' },
    ],
  };
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  function token(base, client, scope = 'tasks', lifetime = 3600) {
    const now = Math.floor(Date.now() / 1000);
    const issued =
      encode({ alg: 'RS256' }) +
      '.' +
      encode({
        iss: base,
        client_id: client,
        sub: base + '/person',
        iat: now,
        exp: now + lifetime,
        scope,
      }) +
      '.c2lnbmF0dXJl';
    accessExpiry.set(issued, (now + lifetime) * 1000);
    return issued;
  }
  server = createServer(async (req, res) => {
    try {
      const origin = 'http://' + req.headers.host;
      const url = new URL(req.url, origin);
      const name = url.pathname.split('/')[1];
      const base = origin + '/' + name;
      traffic.push({
        path: url.pathname,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      const json = (body, status = 200, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/app' || url.pathname === '/callback') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'ambient=owner; Path=/',
        });
        if (
          url.searchParams.get('identity') === 'overview' ||
          url.searchParams.get('identity') === 'expiring'
        ) {
          res.end(
            '<html><div id="app"></div><script type="module" src="/overview.js"></script></html>',
          );
          return;
        }
        if (url.searchParams.get('identity') === 'widgets') {
          res.end(
            '<html style="color-scheme: light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="' +
              (url.searchParams.has('duplicate')
                ? '/widgets-duplicate.js'
                : '/widgets.js') +
              '"></script></html>',
          );
          return;
        }
        if (
          url.searchParams.get('identity') === 'preset' ||
          url.searchParams.get('identity')?.startsWith('access-')
        ) {
          res.end(
            '<html style="color-scheme: light dark"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/preset.js"></script></html>',
          );
          return;
        }
        res.end(
          '<button id="alice">Alice</button><button id="bob">Bob</button><button id="login">Login</button><pre></pre><script type="module" src="/consumer.js"></script>',
        );
        return;
      }
      if (
        url.pathname === '/widgets.js' ||
        url.pathname === '/widgets-duplicate.js'
      ) {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(
          url.pathname === '/widgets.js' ? widgets.js : widgets.duplicateJs,
        );
        return;
      }
      if (url.pathname === '/preset.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(presetBundle.outputFiles[0].text);
        return;
      }
      if (url.pathname === '/overview.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(overviewBundle.outputFiles[0].text);
        return;
      }
      if (url.pathname === '/consumer.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(bundle.outputFiles[0].text);
        return;
      }
      // The delayed Pod answers discovery slowly, so its reader becomes
      // readable only after a delay, both after the callback and on restore.
      if (name === 'delayed' && url.pathname.includes('/.well-known/')) {
        if (delayedOffline) {
          res.writeHead(503);
          res.end();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (url.pathname.endsWith('/.well-known/oauth-protected-resource')) {
        json({
          resource: base,
          authorization_servers: [base],
          bearer_methods_supported: ['header'],
        });
        return;
      }
      if (url.pathname.endsWith('/.well-known/oauth-authorization-server')) {
        json({
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
        return;
      }
      if (url.pathname.endsWith('/authorize')) {
        const code = 'code-' + codes.size;
        codes.set(code, {
          base,
          client: url.searchParams.get('client_id'),
          challenge: url.searchParams.get('code_challenge'),
          redirect: url.searchParams.get('redirect_uri'),
        });
        const redirect = new URL(url.searchParams.get('redirect_uri'));
        redirect.searchParams.set('code', code);
        redirect.searchParams.set('iss', base);
        redirect.searchParams.set('state', url.searchParams.get('state'));
        res.writeHead(302, { location: redirect.href });
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      if (url.pathname.endsWith('/register')) {
        const metadata = JSON.parse(body);
        const clientId = 'dyn:' + ++registrations;
        clients.set(clientId, metadata);
        json({ ...metadata, client_id: clientId }, 201);
        return;
      }
      if (url.pathname.endsWith('/token')) {
        const params = new URLSearchParams(body);
        const client = params.get('client_id');
        assert.equal(req.headers.cookie, undefined);
        if (params.get('grant_type') === 'authorization_code') {
          const code = codes.get(params.get('code'));
          codes.delete(params.get('code'));
          assert.ok(code);
          assert.equal(code.base, base);
          assert.equal(code.client, client);
          assert.equal(params.get('redirect_uri'), code.redirect);
          assert.equal(
            createHash('sha256')
              .update(params.get('code_verifier'))
              .digest('base64url'),
            code.challenge,
          );
          exchanges++;
        } else {
          const previous = grants.get(params.get('refresh_token'));
          assert.deepEqual(previous, { base, client });
          grants.delete(params.get('refresh_token'));
          refreshes++;
          if (name === 'expiring-pod' && expiringRefusal) {
            json({ error: 'invalid_grant' }, 400);
            return;
          }
        }
        const rotated = 'refresh-' + (exchanges + refreshes);
        grants.set(rotated, { base, client });
        const expiring = name === 'expiring-pod';
        json({
          access_token: token(
            base,
            client,
            name === 'widgets-pod' || name === 'overview-pod' || expiring
              ? ''
              : name === 'delayed'
                ? delayedScope
                : 'tasks',
            expiring ? expiringLifetime : 3600,
          ),
          token_type: 'Bearer',
          refresh_token: rotated,
          ...(expiring ? { expires_in: expiringLifetime } : {}),
        });
        return;
      }
      if (widgetFixture.handle(req, url, body, json)) return;
      if (url.pathname.endsWith('/_system/contexts')) {
        assert.equal(req.headers.cookie, undefined);
        assert.ok(req.headers.authorization?.startsWith('Bearer '));
        json({
          '@id': base + '/_system/contexts',
          '@type': [
            'http://www.w3.org/ns/sparql-service-description#GraphCollection',
          ],
          ['http://www.w3.org/ns/sparql-service-description#namedGraph']: [
            { '@id': base + '/_system/contexts/work' },
            // The overview Pod's second Context holds a note in another Context.
            ...(name === 'overview-pod'
              ? [{ '@id': base + '/_system/contexts/notes' }]
              : []),
          ],
          ['https://schema.sempods.org/readableContext']: [
            { '@id': base + '/_system/contexts/work' },
            ...(name === 'overview-pod'
              ? [{ '@id': base + '/_system/contexts/notes' }]
              : []),
          ],
          ['https://schema.sempods.org/writableContext']: [
            { '@id': base + '/_system/contexts/work' },
          ],
        });
        return;
      }
      if (
        name === 'overview-pod' &&
        url.pathname.includes('/_system/resources/')
      ) {
        assert.equal(req.headers.cookie, undefined);
        assert.ok(req.headers.authorization?.startsWith('Bearer '));
        assert.equal(
          url.searchParams.get('context'),
          base + '/_system/contexts/work',
        );
        assert.equal(
          Buffer.from(url.pathname.split('/').at(-1), 'base64url').toString(),
          'urn:overview-note',
        );
        if (req.method === 'GET') {
          json(overviewNote, 200, { etag: `"n${overviewNoteVersion}"` });
          return;
        }
        assert.equal(req.method, 'PATCH');
        assert.equal(req.headers['if-match'], `"n${overviewNoteVersion}"`);
        assert.equal(
          req.headers['content-type'],
          'application/merge-patch+json',
        );
        overviewNote = { ...overviewNote, ...JSON.parse(body) };
        overviewNoteVersion++;
        overviewNoteWrites++;
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.includes('/_system/resources/')) {
        assert.equal(req.headers.cookie, undefined);
        assert.ok(req.headers.authorization?.startsWith('Bearer '));
        assert.equal(
          url.searchParams.get('context'),
          base + '/_system/contexts/work',
        );
        assert.equal(
          Buffer.from(url.pathname.split('/').at(-1), 'base64url').toString(),
          'urn:fixture-task',
        );
        if (req.method === 'GET') {
          json(task, 200, { etag: `"v${version}"` });
          return;
        }
        assert.equal(req.method, 'PATCH');
        writes++;
        if (writeMode === 'conflict') {
          task = {
            ...task,
            'https://schema.org/name': [
              { '@value': 'Changed by another writer', '@language': 'en' },
              { '@value': 'Original DE', '@language': 'de' },
            ],
          };
          version++;
          writeMode = 'normal';
        }
        if (req.headers['if-match'] !== `"v${version}"`) {
          json({}, 412);
          return;
        }
        assert.equal(
          req.headers['content-type'],
          'application/merge-patch+json',
        );
        task = { ...task, ...JSON.parse(body) };
        version++;
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname.endsWith('/sparql/query')) {
        assert.equal(req.method, 'POST');
        assert.equal(req.headers.cookie, undefined);
        assert.ok(req.headers.authorization?.startsWith('Bearer '));
        if (name === 'expiring-pod') {
          const presented = req.headers.authorization.slice('Bearer '.length);
          assert.ok(accessExpiry.has(presented));
          if (accessExpiry.get(presented) <= Date.now()) {
            expiredRejections++;
            json(
              {},
              401,
              expiringChallenge === 'bearer'
                ? { 'www-authenticate': 'Bearer error="invalid_token"' }
                : {},
            );
            return;
          }
        }
        if (name === 'overview-pod' || name === 'expiring-pod') {
          assert.equal(url.search, '');
          assert.equal(req.headers.accept, 'application/sparql-results+json');
          if (overviewRefuse) {
            overviewRefuse = false;
            json({}, 401, {
              'www-authenticate': 'Bearer error="invalid_token"',
            });
          } else
            json(
              {
                head: { vars: ['item', 'graph'] },
                results: {
                  bindings: [
                    {
                      item: { type: 'uri', value: 'urn:overview-note' },
                      graph: {
                        type: 'uri',
                        value: base + '/_system/contexts/work',
                      },
                    },
                    {
                      item: { type: 'uri', value: 'urn:second-note' },
                      graph: {
                        type: 'uri',
                        value: base + '/_system/contexts/notes',
                      },
                    },
                  ],
                },
              },
              200,
              { 'content-type': 'application/sparql-results+json' },
            );
          return;
        }
        if (url.search) {
          assert.equal(
            url.searchParams.get('default-graph-uri'),
            base + '/_system/contexts/work',
          );
          assert.equal(
            url.searchParams.get('named-graph-uri'),
            base + '/_system/contexts/work',
          );
        } else {
          assert.equal(url.searchParams.size, 0);
          if (req.headers.accept === 'application/sparql-results+json') {
            json(
              {
                head: { vars: ['task', 'unbound'] },
                results: {
                  bindings: [
                    { task: { type: 'uri', value: 'urn:fixture-task' } },
                  ],
                },
              },
              200,
              { 'content-type': 'application/sparql-results+json' },
            );
            return;
          }
        }
        if (refreshes === 0)
          json({}, 401, { 'www-authenticate': 'Bearer error="invalid_token"' });
        else json([{ '@id': 'urn:fixture-task' }]);
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (error) {
      serverErrors.push(error);
      res.writeHead(500);
      res.end(String(error));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  // Exercise the installed SDK without the newer browser signal combinator.
  await context.addInitScript(() => {
    delete globalThis.AbortSignal.any;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  const ready = () =>
    page.waitForFunction(() => document.body.dataset.ready === 'true');
  // Startup no longer waits for saved Pods; wait for their own restoration.
  const restored = () =>
    page.waitForFunction(() =>
      window.fixture.runtime
        .getSnapshot()
        .every((c) => c.session.kind !== 'restoring'),
    );
  await page.goto(origin + '/app?identity=dynamic');
  await ready();
  const login = async (name) => {
    await page.locator('#' + name).click();
    await page.waitForFunction(
      () =>
        window.fixture.runtime.getSnapshot().at(-1)?.session.kind ===
        'signed-out',
    );
    await Promise.all([
      page.waitForURL('**/callback?**'),
      page.locator('#login').click(),
    ]);
    await page.waitForURL('**/app?identity=dynamic');
    await ready();
  };
  await login('alice');
  assert.equal(exchanges, 1);
  const read = await page.evaluate(async () => {
    const r = window.fixture.runtime;
    return r
      .bind(r.getSnapshot()[0].id)
      .sparql.construct('CONSTRUCT {} WHERE {}');
  });
  assert.equal(read.kind, 'ok');
  assert.equal(refreshes, 1);
  const beforePodReads = traffic.length;
  const podReads = await page.evaluate(async () => {
    const runtime = window.fixture.runtime;
    const id = runtime.getSnapshot()[0].id;
    const reader = runtime.bindPod(id);
    return {
      access: reader.getSnapshot(),
      select: await reader.sparql.select(
        'SELECT ?task ?unbound WHERE { ?task ?p ?o }',
      ),
      construct: await reader.sparql.construct('CONSTRUCT {} WHERE {}'),
      cached: runtime.bindPod(id) === reader,
    };
  });
  assert.equal(podReads.cached, true);
  assert.equal(podReads.access.read, true);
  assert.deepEqual(podReads.select, {
    kind: 'ok',
    body: {
      variables: ['task', 'unbound'],
      rows: [{ task: { type: 'iri', value: 'urn:fixture-task' } }],
    },
  });
  assert.equal(podReads.construct.kind, 'ok');
  assert.equal(traffic.slice(beforePodReads).length, 2);
  assert.ok(
    traffic
      .slice(beforePodReads)
      .every((request) => request.path.endsWith('/_system/sparql/query')),
  );

  assert.deepEqual(
    await page.evaluate(() => window.fixture.editTask('Saved')),
    {
      outcome: { kind: 'saved' },
      review: null,
      desiredObserved: null,
    },
  );
  assert.ok(
    task['https://schema.org/name'].some(
      (term) => term['@language'] === 'de' && term['@value'] === 'Original DE',
    ),
  );
  writeMode = 'conflict';
  assert.deepEqual(
    await page.evaluate(() => window.fixture.editTask('Conflicting')),
    {
      outcome: { kind: 'review' },
      review: 'changed-on-pod',
      desiredObserved: null,
    },
  );
  // Apply the real request, then withhold its response from Fetch. A raw socket
  // close can trigger Chromium's own network retry and is not deterministic.
  const loseAnswer = async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const request = route.request();
    // Node forwarding retains the original request headers; route.fetch would
    // add the browser context's cookies even to a credentials: 'omit' request.
    const response = await fetch(request.url(), {
      method: request.method(),
      headers: request.headers(),
      body: request.postData(),
      redirect: 'error',
    });
    assert.equal(response.status, 204);
    await route.abort('failed');
  };
  await page.route('**/_system/resources/**', loseAnswer);
  assert.deepEqual(
    await page.evaluate(() => window.fixture.editTask('Unconfirmed')),
    {
      outcome: { kind: 'review' },
      review: 'unconfirmed',
      desiredObserved: true,
    },
  );
  await page.unroute('**/_system/resources/**', loseAnswer);
  assert.equal(writes, 3); // A lost answer never triggers an automatic write replay.
  await page.reload();
  await ready();
  assert.equal(exchanges, 1);
  // Hold Alice's restore across Bob's callback. Bob must finish without Alice.
  const aliceMetadata = origin + '/alice/.well-known/oauth-protected-resource';
  let heldRestore;
  await page.route(aliceMetadata, (route) => {
    heldRestore = route;
  });
  await login('bob');
  assert.ok(heldRestore);
  assert.deepEqual(
    await page.evaluate(() =>
      window.fixture.runtime
        .getSnapshot()
        .map((c) => [new URL(c.podUrl).pathname, c.session.kind])
        .sort(),
    ),
    [
      ['/alice', 'restoring'],
      ['/bob', 'active'],
    ],
  );
  assert.equal(
    await page.evaluate(() => window.fixture.report.interaction),
    'completed',
  );
  await page.unroute(aliceMetadata);
  await heldRestore.continue();
  await page.waitForFunction(() =>
    window.fixture.runtime
      .getSnapshot()
      .every((c) => c.session.kind === 'active'),
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.runtime
          .getSnapshot()
          .filter((c) => c.session.kind === 'active').length,
    ),
    2,
  );
  const busy = await context.newPage();
  await busy.goto(origin + '/app?identity=dynamic');
  await busy.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(
    await busy.evaluate(() => window.fixture.report.storage),
    'busy',
  );
  assert.deepEqual(
    await busy.evaluate(() => window.fixture.runtime.getSnapshot()),
    [],
  );
  // Handover: once the holding tab leaves (pagehide disposes its runtime and
  // releases the Web Lock), a reload of the waiting tab takes the durable
  // store over and restores both saved Pods from native IndexedDB.
  await page.goto('about:blank');
  let handedOver = false;
  for (let attempt = 0; attempt < 20 && !handedOver; attempt++) {
    await busy.reload();
    await busy.waitForFunction(() => document.body.dataset.ready === 'true');
    handedOver =
      (await busy.evaluate(() => window.fixture.report.storage)) === 'durable';
    if (!handedOver) await busy.waitForTimeout(100);
  }
  assert.ok(handedOver, 'The waiting tab never took the released lease over');
  await busy.waitForFunction(
    () =>
      window.fixture.runtime.getSnapshot().length === 2 &&
      window.fixture.runtime
        .getSnapshot()
        .every((c) => c.session.kind === 'active'),
  );
  await busy.close();
  // A deployment can narrow its allowed Pods without changing the durable namespace.
  await page.goto(origin + '/app?identity=dynamic');
  await ready();
  await restored();
  const bobId = await page.evaluate(
    () =>
      window.fixture.runtime
        .getSnapshot()
        .find((c) => c.podUrl.endsWith('/bob')).id,
  );
  await page.evaluate(() => sessionStorage.setItem('fixture-policy', 'one'));
  const beforeRestricted = traffic.length;
  await page.reload();
  await ready();
  await restored();
  assert.deepEqual(
    await page.evaluate(async (bobId) => {
      const r = window.fixture.runtime;
      const existing = r.getSnapshot()[0];
      let rejected = false;
      let bound = false;
      try {
        await r.connect(window.location.origin + '/bob');
      } catch {
        rejected = true;
      }
      try {
        r.bind(bobId);
        bound = true;
      } catch {
        /* Excluded IDs cannot bind. */
      }
      return {
        count: r.getSnapshot().length,
        pod: new URL(existing.podUrl).pathname,
        reused: (await r.connect()).id === existing.id,
        rejected,
        bound,
      };
    }, bobId),
    { count: 1, pod: '/alice', reused: true, rejected: true, bound: false },
  );
  assert.ok(
    traffic.slice(beforeRestricted).every((t) => !t.path.startsWith('/bob/')),
  );
  await page.evaluate(() => sessionStorage.setItem('fixture-policy', 'set'));
  await page.reload();
  await ready();
  await restored();
  assert.equal(
    await page.evaluate(() => window.fixture.runtime.getSnapshot().length),
    2,
  );
  assert.equal(
    await page.evaluate(async () => {
      try {
        await window.fixture.runtime.connect();
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await page.evaluate(() => sessionStorage.removeItem('fixture-policy'));
  await page.reload();
  await ready();
  await restored();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixture.runtime
          .getSnapshot()
          .filter((c) => c.session.kind === 'active').length,
    ),
    2,
  );
  // Narrow the next page while this runtime still owns a legitimate Bob attempt.
  const beforeForeignCallback = exchanges;
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.evaluate(async (bobId) => {
      sessionStorage.setItem('fixture-policy', 'one');
      await window.fixture.runtime.beginAuthorization(bobId);
    }, bobId),
  ]);
  await page.waitForURL('**/app?identity=dynamic');
  await ready();
  assert.equal(
    await page.evaluate(() => window.fixture.report.problem),
    'configuration',
  );
  assert.equal(exchanges, beforeForeignCallback);
  assert.equal(
    await page.evaluate(() => window.fixture.runtime.getSnapshot().length),
    1,
  );
  await page.evaluate(() => sessionStorage.removeItem('fixture-policy'));
  console.log(
    'Packed Pod policy: one/set/free configuration, exact default reuse, excluded restore/bind/connect, widening and rejected callback passed.',
  );
  const before = registrations;
  await page.goto(origin + '/app?identity=did');
  await ready();
  await page.locator('#alice').click();
  await page.waitForFunction(
    () => window.fixture.runtime.getSnapshot().length === 1,
  );
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.locator('#login').click(),
  ]);
  await page.waitForURL('**/app?identity=did');
  await ready();
  assert.equal(registrations, before);
  assert.equal(
    await page.evaluate(
      () => window.fixture.runtime.getSnapshot()[0].clientKind,
    ),
    'did-web',
  );
  await page.reload();
  await ready();
  await restored();
  assert.equal(
    await page.evaluate(
      () => window.fixture.runtime.getSnapshot()[0].session.kind,
    ),
    'active',
  );
  // Separate identity namespace: a real packed React app needs no Pod URL field
  // or context picker, while the same guard protects its draft during re-consent.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(origin + '/app?identity=preset');
  const presetSignIn = page.getByRole('button', {
    name: 'Sign in',
    exact: true,
  });
  await presetSignIn.waitFor();
  assert.equal(await page.getByLabel('Pod URL').count(), 0);
  const beforePreset = exchanges;
  await Promise.all([page.waitForURL('**/callback?**'), presetSignIn.click()]);
  await page.waitForURL('**/app?identity=preset');
  const presetDraft = page.getByLabel('Preset draft');
  await presetDraft.waitFor();
  assert.equal(exchanges, beforePreset + 1);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  assert.equal(
    await page.getByLabel('Selected context').textContent(),
    origin + '/alice/_system/contexts/work',
  );
  assert.equal(
    await page.getByLabel('Data context', { exact: true }).count(),
    0,
  );
  await page.getByRole('button', { name: 'Data access', exact: true }).click();
  await presetDraft.fill('Keep this draft');
  await page
    .getByRole('button', { name: 'Update access', exact: true })
    .click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await presetDraft.inputValue(), 'Keep this draft');
  assert.equal(exchanges, beforePreset + 1);
  await presetDraft.fill('');
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.getByRole('button', { name: 'Update access', exact: true }).click(),
  ]);
  await page.waitForURL('**/app?identity=preset');
  await presetDraft.waitFor();
  assert.equal(exchanges, beforePreset + 2);
  assert.equal(
    await page.getByLabel('Connections', { exact: true }).textContent(),
    '1',
  );
  await page.reload();
  await presetDraft.waitFor();
  assert.equal(
    await page.getByLabel('Selected context').textContent(),
    origin + '/alice/_system/contexts/work',
  );
  assert.equal(exchanges, beforePreset + 2);
  console.log(
    'Packed preset React app: one-click PKCE, exact context, guarded reauthorization, connection reuse and durable reload passed.',
  );
  assert.ok(
    traffic
      .filter(
        (t) =>
          t.path.includes('/.well-known/') ||
          t.path.endsWith('/token') ||
          t.path.endsWith('/register') ||
          t.path.endsWith('/_system/contexts') ||
          t.path.endsWith('/_system/sparql/query'),
      )
      .every((t) => t.cookie === undefined),
  );
  await checkWidgets(page, origin, widgetFixture);
  for (const mode of ['one', 'set', 'free']) {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.emulateMedia({ colorScheme: mode === 'set' ? 'dark' : 'light' });
    await page.goto(origin + '/app?identity=access-' + mode);
    await page.getByRole('heading', { name: 'Shopping', level: 1 }).waitFor();
    if (process.env.SEMPODS_UI_PREVIEW_DIR)
      await page.screenshot({
        path: join(
          process.env.SEMPODS_UI_PREVIEW_DIR,
          'login-' + mode + '.png',
        ),
      });
    if (mode === 'one') {
      assert.equal(await page.getByRole('textbox').count(), 0);
      assert.equal(await page.getByRole('combobox').count(), 0);
    } else if (mode === 'set') {
      await page.getByLabel('Your Pod').selectOption(origin + '/alice');
      assert.equal(await page.getByRole('textbox').count(), 0);
    } else await page.getByLabel('Your Pod').fill('  ' + origin + '/alice/  ');
    await page.getByRole('button', { name: 'Sign in', exact: true }).focus();
    await Promise.all([
      page.waitForURL('**/callback?**'),
      page.keyboard.press('Enter'),
    ]);
    await page.waitForURL('**/app?identity=access-' + mode);
    const picker = page.getByLabel('Data context', { exact: true });
    await picker.waitFor();
    assert.equal(await picker.inputValue(), '');
    await picker
      .getByRole('option', { name: 'work', exact: true })
      .waitFor({ state: 'attached' });
    await picker.focus();
    await picker.selectOption(origin + '/alice/_system/contexts/work');
    await page.getByLabel('Preset draft').waitFor();
    await page
      .getByRole('region', { name: 'Data access', exact: true })
      .waitFor({ state: 'hidden' });
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      'Data access',
    );
    await page
      .getByRole('button', { name: 'Data access', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Data access', level: 2 })
      .waitFor();
    await page
      .getByRole('button', { name: 'Check access', exact: true })
      .waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    if (process.env.SEMPODS_UI_PREVIEW_DIR)
      await page.screenshot({
        path: join(
          process.env.SEMPODS_UI_PREVIEW_DIR,
          'access-' + mode + '.png',
        ),
      });
  }
  console.log(
    'Packed AppAccess: one/set/free Pod UI, readable contexts, explicit keyboard sign-in, hidden usable controls, management, 320px light/dark passed.',
  );
  // One permitted Pod, Contexts on demand: until the Pod reader is readable
  // (callback, then restore), the surface shows only its loading status and
  // never the connection view with "Full addresses"; then it hides. Recovery
  // views (ended session, missing required scopes) still appear directly.
  const accessTrace = () => page.evaluate(() => window.accessTrace);
  const settled = (state) =>
    page.waitForFunction((last) => window.accessTrace.at(-1) === last, state);
  await page.goto(origin + '/app?identity=access-delayed');
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.waitForURL('**/app?identity=access-delayed');
  await settled('hidden');
  assert.deepEqual(await accessTrace(), ['loading', 'hidden']);
  await page.reload();
  await settled('hidden');
  assert.deepEqual(await accessTrace(), ['loading', 'hidden']);
  delayedOffline = true;
  await page.reload();
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
  assert.deepEqual(await accessTrace(), ['loading', 'connection']);
  delayedOffline = false;
  delayedScope = '';
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.waitForURL('**/app?identity=access-delayed');
  await page.getByText('Review required feature access: tasks.').waitFor();
  assert.deepEqual(await accessTrace(), ['loading', 'connection']);
  delayedScope = 'tasks';
  console.log(
    'Packed AppAccess, one Pod on demand: loading status only (no Full addresses) from callback and restore until the delayed Pod reader is readable, then hidden; ended session and missing required scopes show recovery directly passed.',
  );
  // The copyable recipe, installed archives and native browser storage: a Pod
  // overview loads/restores/renews without touching Context discovery.
  const beforeOverview = traffic.length;
  const contextTraffic = () =>
    traffic
      .slice(beforeOverview)
      .filter((r) => r.path.startsWith('/overview-pod/_system/contexts'));
  const podQueries = () =>
    traffic
      .slice(beforeOverview)
      .filter((r) => r.path === '/overview-pod/_system/sparql/query').length;
  await page.goto(origin + '/app?identity=overview');
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.waitForURL(origin + '/app?identity=overview');
  await page.getByText('urn:overview-note', { exact: false }).waitFor();
  assert.deepEqual(contextTraffic(), []);
  await page.reload();
  await page.getByText('urn:overview-note', { exact: false }).waitFor();
  assert.deepEqual(contextTraffic(), []);
  const beforeRenewal = podQueries();
  overviewRefuse = true;
  const renewed = page.waitForResponse(
    (r) => r.url().endsWith('/_system/sparql/query') && r.status() === 200,
  );
  await page.getByRole('button', { name: 'Reload overview' }).click();
  await renewed;
  await page.getByText('urn:overview-note', { exact: false }).waitFor();
  assert.equal(podQueries(), beforeRenewal + 2);
  assert.deepEqual(contextTraffic(), []);
  const beforeScoped = podQueries();
  await page.getByRole('button', { name: 'Create a note' }).click();
  await page
    .getByLabel('Data context')
    .selectOption(origin + '/overview-pod/_system/contexts/work');
  await page.getByLabel('New note').fill('Unfinished');
  assert.equal(
    contextTraffic().filter((r) => r.path.endsWith('/contexts')).length,
    1,
  );
  assert.equal(podQueries(), beforeScoped);
  await page.getByRole('button', { name: 'Data access', exact: true }).click();
  const revalidated = page.waitForResponse((r) =>
    r.url().endsWith('/_system/contexts'),
  );
  await page.getByRole('button', { name: 'Check access', exact: true }).click();
  await revalidated;
  assert.equal(await page.getByLabel('New note').inputValue(), 'Unfinished');
  assert.equal(podQueries(), beforeScoped);
  await page.reload();
  await page.getByText('urn:overview-note', { exact: false }).waitFor();
  const afterRestore = contextTraffic().length;
  assert.equal(
    contextTraffic().filter((r) => r.path.endsWith('/contexts')).length,
    2,
  );
  await page.getByRole('button', { name: 'Create a note' }).click();
  await page.getByLabel('New note').waitFor();
  assert.equal(
    contextTraffic().filter((r) => r.path.endsWith('/contexts')).length,
    3,
  );
  assert.ok(contextTraffic().length >= afterRestore + 1);
  // Editing an overview row: the Context comes from its GRAPH binding, the editor
  // reads the resource fresh in that Context and writes with its version.
  const beforeEdit = podQueries();
  await page.getByRole('button', { name: 'Edit urn:overview-note' }).click();
  const editRegion = page.getByRole('region', { name: 'Edit note' });
  const title = editRegion.getByLabel('Note title');
  await title.waitFor();
  assert.equal(await title.inputValue(), 'First note');
  await title.fill('Edited note');
  const patched = page.waitForResponse(
    (r) =>
      r.url().includes('/overview-pod/_system/resources/') &&
      r.request().method() === 'PATCH',
  );
  await editRegion.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await patched).status(), 204);
  assert.equal(overviewNoteWrites, 1);
  assert.deepEqual(overviewNote['urn:note:title'], [
    { '@value': 'Edited note' },
  ]);
  assert.equal(podQueries(), beforeEdit);
  // Closing the editor with an unsaved draft runs under the leave policy.
  await title.fill('Unsaved draft');
  await editRegion
    .getByRole('button', { name: 'Close editor', exact: true })
    .click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await title.inputValue(), 'Unsaved draft');
  await editRegion
    .getByRole('button', { name: 'Close editor', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Discard and continue', exact: true })
    .click();
  await editRegion.waitFor({ state: 'detached' });
  assert.equal(overviewNoteWrites, 1);
  // Editing a row in another Context while a draft exists in this one: declining
  // the Context change keeps the draft and leaves no empty editor behind.
  await page.getByLabel('New note').fill('Draft elsewhere');
  await page.getByRole('button', { name: 'Edit urn:second-note' }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  await editRegion.waitFor({ state: 'detached' });
  assert.equal(
    await page.getByLabel('New note').inputValue(),
    'Draft elsewhere',
  );
  // Choosing another Context elsewhere while a row is edited retires the editor
  // instead of selecting its old Context again.
  await page.getByRole('button', { name: 'Edit urn:overview-note' }).click();
  await editRegion.getByLabel('Note title').waitFor();
  await page.getByRole('button', { name: 'Data access', exact: true }).click();
  await page
    .getByLabel('Data context')
    .selectOption(origin + '/overview-pod/_system/contexts/notes');
  await page
    .getByRole('button', { name: 'Discard and continue', exact: true })
    .click();
  await editRegion.waitFor({ state: 'detached' });
  await page.waitForTimeout(200);
  assert.equal(
    await page.getByLabel('Data context').inputValue(),
    origin + '/overview-pod/_system/contexts/notes',
  );
  // Switching Pods retires an editor that belongs to the previous connection.
  await page.getByLabel('Your Pod').fill(origin + '/second-pod');
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.waitForURL(origin + '/app?identity=overview');
  const choosePod = async (name) => {
    const pods = page.getByLabel('Active pod');
    const value = await pods.evaluate(
      (select, wanted) =>
        [...select.options].find((o) => o.text.includes(wanted))?.value,
      name,
    );
    assert.ok(value, 'pod option ' + name);
    await pods.selectOption(value);
  };
  await page.getByRole('button', { name: 'Data access', exact: true }).click();
  await choosePod('overview-pod');
  await page.getByRole('button', { name: 'Edit urn:overview-note' }).click();
  await editRegion.getByLabel('Note title').waitFor();
  await choosePod('second-pod');
  await editRegion.waitFor({ state: 'detached' });
  await page.waitForTimeout(200);
  // The retired editor never demanded discovery from the newly active Pod.
  assert.deepEqual(
    traffic
      .slice(beforeOverview)
      .filter((r) => r.path.startsWith('/second-pod/_system/contexts')),
    [],
  );
  console.log(
    'Packed on-demand recipe: StrictMode login, catalogue-free overview/restore/401 recovery, explicit Context activation, deferred remembered selection, draft-preserving revalidation and Context-bound editing of an overview row (fresh read, If-Match, guarded close, declined Context change, external Context change, Pod switch) passed.',
  );
  // Short-lived tokens: the recipe renews an expired token before dispatch, so
  // a Pod refusing it with or without a Bearer challenge never sees it (#51).
  const expiringQueries = () =>
    traffic.filter((r) => r.path === '/expiring-pod/_system/sparql/query');
  const overviewLoaded = () =>
    page.getByText('urn:overview-note', { exact: false }).waitFor();
  await page.goto(origin + '/app?identity=expiring');
  await Promise.all([
    page.waitForURL('**/callback?**'),
    page.getByRole('button', { name: 'Sign in', exact: true }).click(),
  ]);
  await page.waitForURL(origin + '/app?identity=expiring');
  await overviewLoaded();
  let probes = 0;
  for (const mode of ['none', 'bearer']) {
    expiringChallenge = mode;
    const previous = expiringQueries().at(-1).authorization;
    // Every token issued so far, including one renewed early in the background,
    // has expired once this wait ends.
    await page.waitForTimeout(expiringLifetime * 1000 + 1000);
    const before = { refreshes };
    // The fixture really refuses the expired token in this mode.
    const probe = await fetch(origin + '/expiring-pod/_system/sparql/query', {
      method: 'POST',
      headers: { authorization: previous },
    });
    probes++;
    assert.equal(probe.status, 401);
    assert.equal(
      probe.headers.get('www-authenticate'),
      mode === 'bearer' ? 'Bearer error="invalid_token"' : null,
    );
    before.queries = expiringQueries().length;
    const answered = page.waitForResponse((r) =>
      r.url().endsWith('/expiring-pod/_system/sparql/query'),
    );
    await page.getByRole('button', { name: 'Reload overview' }).click();
    assert.equal((await answered).status(), 200);
    await overviewLoaded();
    assert.equal(refreshes, before.refreshes + 1);
    assert.equal(expiringQueries().length, before.queries + 1);
    assert.notEqual(expiringQueries().at(-1).authorization, previous);
    assert.equal(expiredRejections, probes);
  }
  // A refused renewal ends the session with a visible sign-in, without
  // sending the expired token; signing in again restores the overview.
  expiringRefusal = true;
  await page.waitForTimeout(expiringLifetime * 1000 + 1000);
  const beforeRefusal = expiringQueries().length;
  await page.getByRole('button', { name: 'Reload overview' }).click();
  const signInAgain = page.getByRole('button', {
    name: 'Sign in',
    exact: true,
  });
  await signInAgain.waitFor();
  assert.equal(expiringQueries().length, beforeRefusal);
  assert.equal(expiredRejections, probes);
  expiringRefusal = false;
  await Promise.all([page.waitForURL('**/callback?**'), signInAgain.click()]);
  await page.waitForURL(origin + '/app?identity=expiring');
  await overviewLoaded();
  assert.equal(expiredRejections, probes);
  console.log(
    'Packed short-lived tokens: renewal before dispatch for Pods refusing expired tokens with or without a challenge, no expired token sent, refused renewal ends in a visible sign-in and recovers passed.',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(serverErrors, []);
  console.log(
    'Packed runtime in Chromium: PKCE redirects, durable reload, two pods with independent callback/restore, reactive refresh, conditional editing/conflict/unknown outcome, did:web, native IndexedDB/Web Locks with two-tab lease handover and cookie omission passed (production client).',
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
