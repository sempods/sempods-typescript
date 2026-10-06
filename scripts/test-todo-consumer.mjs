/* global getComputedStyle, window, document, URLSearchParams, navigator, caches */
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'sempods-todo-'));
const execute = promisify(execFile);
let server;
let browser;
try {
  for (const name of ['client-sdk', 'app-sdk'])
    execFileSync('pnpm', ['pack', '--pack-destination', temp], {
      cwd: join(root, 'packages', name),
      stdio: 'pipe',
    });
  const tools = JSON.parse(
    await readFile(join(root, 'package.json'), 'utf8'),
  ).devDependencies;
  const dependencies = { react: tools.react, 'react-dom': tools['react-dom'] };
  for (const name of await readdir(temp)) {
    if (!name.endsWith('.tgz')) continue;
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', join(temp, name), 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    dependencies[manifest.name] = 'file:' + join(temp, name);
  }
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
        '@types/node': tools['@types/node'],
      },
    }),
  );
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: temp, stdio: 'pipe' },
  );
  await cp(join(root, 'examples'), join(temp, 'examples'), {
    recursive: true,
    filter: (source) =>
      !source.includes('/node_modules') && !source.includes('/dist'),
  });
  await rm(join(temp, 'examples/tsconfig.json'));
  await cp(
    join(root, 'tests/todo-browser/customized.tsx'),
    join(temp, 'customized.tsx'),
  );
  await cp(
    join(root, 'tests/todo-browser/sign-in.tsx'),
    join(temp, 'sign-in.tsx'),
  );
  await cp(join(root, 'tests/todo-browser/pwa.tsx'), join(temp, 'pwa.tsx'));
  await cp(
    join(root, 'tests/todo-browser/baseline.tsx'),
    join(temp, 'baseline.tsx'),
  );
  await writeFile(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        jsx: 'react-jsx',
        types: ['node', 'react', 'react-dom'],
        lib: ['ES2022', 'DOM'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: [
        'examples/**/*.ts',
        'examples/**/*.tsx',
        'customized.tsx',
        'sign-in.tsx',
        'pwa.tsx',
        'baseline.tsx',
      ],
    }),
  );
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    { cwd: temp, stdio: 'inherit' },
  );
  const bundle = await build({
    absWorkingDir: temp,
    entryPoints: ['examples/todo/src/main.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    write: false,
    outdir: 'out',
    metafile: true,
  });
  assert.ok(
    Object.keys(bundle.metafile.inputs).every((path) => !path.includes(root)),
  );
  await build({
    absWorkingDir: temp,
    entryPoints: ['examples/node-script/src/main.ts'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile: join(temp, 'node.mjs'),
  });
  const js = bundle.outputFiles.find((f) => f.path.endsWith('.js')).text;
  const css = bundle.outputFiles.find((f) => f.path.endsWith('.css')).text;
  const customized = await build({
    absWorkingDir: temp,
    entryPoints: ['customized.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    write: false,
  });
  const signIn = await build({
    absWorkingDir: temp,
    entryPoints: ['sign-in.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(signIn.metafile.inputs).every((path) => !path.includes(root)),
  );
  const pwa = await build({
    absWorkingDir: temp,
    entryPoints: ['pwa.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    write: false,
    outdir: 'out',
    metafile: true,
  });
  assert.ok(
    Object.keys(pwa.metafile.inputs).every((path) => !path.includes(root)),
  );
  const baseline = await build({
    absWorkingDir: temp,
    entryPoints: ['baseline.tsx'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    write: false,
  });
  const pwaFile = (name) => readFile(join(temp, 'examples/todo/pwa', name));
  const worker = (await pwaFile('sw.js')).toString();
  // The installable variant replaces the plain TODO bundle at the same paths.
  let pwaMode = false;
  let workerVersion = 'v1';
  const codes = new Map();
  const tasks = new Map();
  const serverErrors = [];
  let writes = 0;
  let registrations = 0;
  let version = 0;
  let conflict = false;
  const schema = 'https://schema.org/';
  const token = (base, client) => {
    const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    return (
      enc({ alg: 'RS256' }) +
      '.' +
      enc({
        iss: base,
        client_id: client,
        sub: base + '/person',
        iat: now,
        exp: now + 3600,
        scope: '',
      }) +
      '.c2lnbmF0dXJl'
    );
  };
  server = createServer(async (req, res) => {
    try {
      const origin = 'http://' + req.headers.host;
      const url = new URL(req.url, origin);
      // A second copy of the PWA under /second/ shares this origin's caches.
      const second = pwaMode && url.pathname.startsWith('/second/');
      if (second) url.pathname = url.pathname.slice('/second'.length);
      const base = origin + '/alice';
      const json = (body, status = 200, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          ...headers,
        });
        res.end(JSON.stringify(body));
      };
      if (
        [
          '/',
          '/custom',
          '/legacy',
          '/baseline',
          '/baseline/callback',
          '/callback',
          '/customized',
          '/recipe',
          '/recipe/callback',
        ].includes(url.pathname)
      ) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(
          '<html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            (pwaMode
              ? '<link rel="manifest" href="/manifest.webmanifest">'
              : '') +
            (url.pathname.startsWith('/baseline')
              ? ''
              : '<link rel="stylesheet" href="/app.css">') +
            '<div id="root"></div><script type="module" src="' +
            (url.pathname.startsWith('/recipe')
              ? '/sign-in.js'
              : url.pathname.startsWith('/baseline')
                ? '/baseline.js'
                : url.pathname === '/customized'
                  ? '/customized.js'
                  : '/app.js') +
            '"></script></html>',
        );
        return;
      }
      if (url.pathname === '/baseline.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(baseline.outputFiles[0].text);
        return;
      }
      if (url.pathname === '/sign-in.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(signIn.outputFiles[0].text);
        return;
      }
      if (url.pathname === '/customized.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(customized.outputFiles[0].text);
        return;
      }
      if (url.pathname === '/app.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(
          pwaMode
            ? pwa.outputFiles.find((f) => f.path.endsWith('.js')).text
            : js,
        );
        return;
      }
      if (url.pathname === '/app.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        res.end(
          pwaMode
            ? pwa.outputFiles.find((f) => f.path.endsWith('.css')).text
            : css,
        );
        return;
      }
      if (pwaMode && url.pathname === '/sw.js') {
        res.writeHead(200, {
          'content-type': 'text/javascript',
          'cache-control': 'no-cache',
        });
        res.end(
          worker.replace(
            "const VERSION = 'v1';",
            `const VERSION = '${second ? 'v1' : workerVersion}';`,
          ),
        );
        return;
      }
      if (pwaMode && url.pathname === '/manifest.webmanifest') {
        res.writeHead(200, { 'content-type': 'application/manifest+json' });
        res.end(await pwaFile('manifest.webmanifest'));
        return;
      }
      if (pwaMode && /^\/icon-(192|512)\.png$/.test(url.pathname)) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(await pwaFile(url.pathname.slice(1)));
        return;
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
        const code = 'code-' + codes.size;
        codes.set(code, {
          client: url.searchParams.get('client_id'),
          challenge: url.searchParams.get('code_challenge'),
        });
        const redirect = new URL(url.searchParams.get('redirect_uri'));
        for (const [k, v] of [
          ['code', code],
          ['state', url.searchParams.get('state')],
          ['iss', base],
        ])
          redirect.searchParams.set(k, v);
        res.writeHead(302, { location: redirect.href });
        res.end();
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      if (url.pathname.endsWith('/register'))
        return json(
          { ...JSON.parse(body), client_id: 'dyn:' + ++registrations },
          201,
        );
      if (url.pathname.endsWith('/token')) {
        const params = new URLSearchParams(body);
        const code = codes.get(params.get('code'));
        assert.ok(code);
        codes.delete(params.get('code'));
        assert.equal(
          createHash('sha256')
            .update(params.get('code_verifier'))
            .digest('base64url'),
          code.challenge,
        );
        return json({
          access_token: token(base, code.client),
          token_type: 'Bearer',
          refresh_token: 'fixture-refresh',
        });
      }
      if (url.pathname.startsWith('/alice/_system/')) {
        assert.equal(req.headers.cookie, undefined);
        assert.ok(req.headers.authorization?.startsWith('Bearer '));
      }
      const contexts = ['work', 'personal'].map(
        (s) => base + '/_system/contexts/' + s,
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
        assert.equal(url.searchParams.get('named-graph-uri'), target);
        return json(
          [...tasks.values()]
            .filter((t) => t.context === target)
            .map((t) => t.body),
        );
      }
      if (url.pathname.includes('/_system/resources/')) {
        const iri = Buffer.from(
          url.pathname.split('/').at(-1),
          'base64url',
        ).toString();
        const context = url.searchParams.get('context');
        assert.ok(contexts.includes(context));
        const key = context + '|' + iri;
        let task = tasks.get(key);
        if (req.method === 'GET')
          return task
            ? json(task.body, 200, { etag: `"v${task.version}"` })
            : json({}, 404);
        writes++;
        if (req.method === 'PUT') {
          assert.equal(req.headers['if-none-match'], '*');
          if (task) return json({}, 412);
          tasks.set(key, {
            context,
            body: JSON.parse(body),
            version: ++version,
          });
          res.writeHead(201);
          res.end();
          return;
        }
        if (!task) return json({}, 404);
        if (conflict) {
          conflict = false;
          task = {
            ...task,
            body: {
              ...task.body,
              [schema + 'name']: [{ '@value': 'Other writer' }],
            },
            version: ++version,
          };
          tasks.set(key, task);
        }
        if (req.headers['if-match'] !== `"v${task.version}"`)
          return json({}, 412);
        if (req.method === 'PATCH')
          tasks.set(key, {
            ...task,
            body: { ...task.body, ...JSON.parse(body) },
            version: ++version,
          });
        else {
          assert.equal(req.method, 'DELETE');
          tasks.delete(key);
        }
        res.writeHead(204);
        res.end();
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
  const pod = origin + '/alice';
  const work = pod + '/_system/contexts/work';
  const personal = pod + '/_system/contexts/personal';
  browser = await chromium.launch({ headless: true });
  // The documented default is the actual shell-free TODO, installed from tarballs.
  for (const language of ['en', 'de']) {
    tasks.clear();
    const context = await browser.newContext({
      viewport: { width: 320, height: 740 },
      colorScheme: language === 'de' ? 'dark' : 'light',
    });
    const page = await context.newPage();
    await page.goto(origin + '/');
    if (language === 'de')
      await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
    await page
      .getByLabel(language === 'de' ? 'Dein Pod' : 'Your Pod', { exact: true })
      .fill(pod);
    await page
      .getByRole('button', {
        name: language === 'de' ? 'Anmelden' : 'Sign in',
        exact: true,
      })
      .click();
    // Redirect initializes the example's default language again.
    await page.getByLabel('Data context', { exact: true }).selectOption(work);
    const input = page.getByLabel('Task', { exact: true }).first();
    await input.fill('Shell-free task');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page
      .getByRole('button', { name: 'Shell-free task', exact: true })
      .waitFor();
    await page
      .getByRole('region', { name: 'Data access', exact: true })
      .waitFor({ state: 'hidden' });
    await input.fill('Keep this draft');
    await page
      .getByRole('button', { name: 'Data access', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Update access', exact: true })
      .click();
    await page.getByRole('alertdialog').waitFor();
    await page
      .getByRole('button', { name: 'Keep editing', exact: true })
      .click();
    assert.equal(await input.inputValue(), 'Keep this draft');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await context.close();
  }
  console.log(
    'Packed default TODO: EN/DE login, 320px light/dark, explicit context, creation and guarded management with retained draft passed.',
  );
  for (const appearance of ['light', 'dark']) {
    tasks.clear();
    const context = await browser.newContext({
      viewport: { width: appearance === 'light' ? 320 : 375, height: 800 },
      colorScheme: appearance,
    });
    const page = await context.newPage();
    await page.route('**/alice/_system/contexts/*', (route) => {
      const iri = route.request().url();
      return route.fulfill({
        json: {
          '@id': iri,
          '@type': [
            'http://www.w3.org/ns/sparql-service-description#NamedGraph',
          ],
          'http://www.w3.org/ns/sparql-service-description#name': [
            { '@id': iri },
          ],
          'https://schema.sempods.org/public': [{ '@value': false }],
          'http://www.w3.org/2000/01/rdf-schema#label': [{ '@value': 'Tasks' }],
        },
      });
    });
    await page.goto(origin + '/baseline');
    assert.equal(await page.locator('link[rel=stylesheet]').count(), 0);
    await page.getByLabel('Your Pod').fill(pod);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page
      .getByRole('option', { name: 'Tasks · ' + work, exact: true })
      .waitFor();
    await page
      .getByRole('option', { name: 'Tasks · ' + personal, exact: true })
      .waitFor();
    await page.getByLabel('Data context', { exact: true }).selectOption(work);
    await page
      .getByRole('region', { name: 'Data access', exact: true })
      .waitFor({ state: 'hidden' });
    await page.getByLabel('Task', { exact: true }).first().fill('SDK baseline');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page
      .getByRole('button', { name: 'SDK baseline', exact: true })
      .click();
    const editor = page.locator('[data-sempods-ui="editor"]');
    await editor.waitFor();
    const save = editor.getByRole('button', { name: 'Save', exact: true });
    const field = editor.getByLabel('Task', { exact: true });
    await field.fill('Unfinished baseline');
    await page.keyboard.press('Tab'); // Checkbox.
    await page.keyboard.press('Tab'); // Save.
    assert.equal(
      await save.evaluate((button) => button === document.activeElement),
      true,
    );
    assert.ok(
      await save.evaluate(
        (button) => getComputedStyle(button).outlineStyle !== 'none',
      ),
    );
    for (const control of [
      save,
      field,
      page.getByRole('button', { name: 'Check current version', exact: true }),
      page.getByRole('button', { name: 'Data access', exact: true }),
    ]) {
      const box = await control.boundingBox();
      assert.ok(box.height >= 44);
    }
    const expectedText =
      appearance === 'light' ? 'rgb(32, 41, 35)' : 'rgb(232, 238, 233)';
    assert.equal(
      await editor.evaluate((element) => getComputedStyle(element).color),
      expectedText,
    );
    // One inherited token styles both shell management and standalone editor controls.
    await page.evaluate(() =>
      document.documentElement.style.setProperty('--sempods-accent', '#654321'),
    );
    assert.equal(
      await save.evaluate((button) => getComputedStyle(button).color),
      'rgb(101, 67, 33)',
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'Data access', exact: true })
        .evaluate((button) => getComputedStyle(button).color),
      'rgb(101, 67, 33)',
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'Check current version', exact: true })
        .evaluate((button) => getComputedStyle(button).color),
      'rgb(101, 67, 33)',
    );
    // App-owned list controls retain browser appearance; the shell does not style descendants globally.
    assert.notEqual(
      await page
        .getByRole('button', { name: 'SDK baseline', exact: true })
        .evaluate((button) => getComputedStyle(button).color),
      'rgb(101, 67, 33)',
    );
    await page
      .getByRole('button', { name: 'Data access', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Update access', exact: true })
      .click();
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await field.inputValue(), 'Unfinished baseline');
    await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
    await editor
      .getByRole('button', { name: 'Speichern', exact: true })
      .waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.evaluate(() =>
      document.documentElement.style.removeProperty('--sempods-accent'),
    );
    if (process.env.SEMPODS_UI_PREVIEW_DIR)
      await page.screenshot({
        path: join(
          process.env.SEMPODS_UI_PREVIEW_DIR,
          'sdk-baseline-' + appearance + '.png',
        ),
        fullPage: true,
      });
    await context.close();
  }
  console.log(
    'Packed SDK baseline without a stylesheet: AppShell, editor, inherited tokens, app-content isolation, EN/DE, 320/375px light/dark, touch targets, focus and guarded drafts passed.',
  );
  for (const custom of [false, true]) {
    tasks.clear();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => {
      errors.push(e);
      console.error('Browser error:', e.message);
    });
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(origin + (custom ? '/custom' : '/legacy'));
    await page.getByLabel(custom ? 'Pod URL' : 'Your Pod').fill(pod);
    await page
      .getByRole('button', {
        name: custom ? 'Connect' : 'Sign in',
        exact: true,
      })
      .click();
    await page.getByLabel('Data context').selectOption(work);
    await page.getByText('No tasks yet.', { exact: true }).waitFor();
    if (!custom)
      await page
        .getByRole('button', { name: 'Data access', exact: true })
        .click();
    // New drafts cannot start while connect awaits discovery/registration.
    let releaseDiscovery;
    const discoveryStarted = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
    let heldDiscovery;
    const holdDiscovery = (route) => {
      heldDiscovery = route;
      releaseDiscovery();
    };
    await page.route('**/.well-known/oauth-protected-resource', holdDiscovery);
    await page.getByLabel(custom ? 'Pod URL' : 'Your Pod').fill(pod);
    await page
      .getByRole('button', {
        name: custom ? 'Connect' : 'Sign in',
        exact: true,
      })
      .click();
    await discoveryStarted;
    const newDraft = page.getByLabel('Task', { exact: true }).first();
    assert.equal(
      await newDraft.evaluate((input) => Boolean(input.closest('[inert]'))),
      true,
    );
    await newDraft.evaluate((input) => input.focus());
    await page.keyboard.type('Must not become a draft');
    assert.equal(await newDraft.inputValue(), '');
    await page.unroute(
      '**/.well-known/oauth-protected-resource',
      holdDiscovery,
    );
    await heldDiscovery.abort('failed');
    await page.waitForFunction(() => !document.querySelector('[inert]'));
    const add = async (title) => {
      await page.getByLabel('Task', { exact: true }).first().fill(title);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      await page.getByRole('button', { name: title, exact: true }).waitFor();
    };
    await newDraft.fill('   ');
    assert.equal(
      await page.getByRole('button', { name: 'Add', exact: true }).isDisabled(),
      true,
    );
    await newDraft.fill('  First  ');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('button', { name: 'First', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await page.getByRole('button', { name: 'Complete', exact: true }).waitFor();
    await page.getByRole('button', { name: 'First', exact: true }).click();
    const draft = page.getByLabel('Task', { exact: true }).nth(1);
    await draft.fill('Renamed');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Renamed', exact: true }).waitFor();
    await draft.fill('Draft retained');
    await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
    assert.equal(
      await page.getByLabel('Aufgabe', { exact: true }).last().inputValue(),
      'Draft retained',
    );
    await page.getByLabel('Datenkontext').selectOption(personal);
    await page.getByRole('alertdialog').waitFor();
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      'Weiter bearbeiten',
    );
    await page.keyboard.press('Escape');
    assert.equal(await page.getByLabel('Datenkontext').inputValue(), work);
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page
      .getByRole('button', { name: 'Discard changes', exact: true })
      .click();
    conflict = true;
    await draft.fill('Mine');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'The pod has changed' })
      .waitFor();
    assert.equal(await draft.inputValue(), 'Mine');
    await page
      .getByRole('button', { name: 'Continue with my changes', exact: true })
      .click();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('button', { name: 'Mine', exact: true }).waitFor();
    // Dispatch through the real client, apply on the fixture, then hide the answer.
    let loseMethod = 'PATCH';
    const loseAnswer = async (route) => {
      const r = route.request();
      if (r.method() !== loseMethod) return route.continue();
      const response = await fetch(r.url(), {
        method: r.method(),
        headers: r.headers(),
        body: r.postData(),
        redirect: 'error',
      });
      assert.ok(
        response.ok,
        `${r.method()} lost-answer fixture returned ${response.status}`,
      );
      await route.abort('failed');
    };
    await page.route('**/_system/resources/**', loseAnswer);
    const before = writes;
    await draft.fill('Unknown');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'unconfirmed' }).waitFor();
    assert.equal(writes, before + 1);
    await page.unroute('**/_system/resources/**', loseAnswer);
    await page
      .getByRole('button', { name: 'Discard changes', exact: true })
      .click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByText('No tasks yet.', { exact: true }).waitFor();
    await add('Existing row');
    // C1: observing absence preserves the draft for an explicit same-IRI retry.
    const createAttempts = [];
    const observeCreate = (request) => {
      if (request.method() === 'PUT') createAttempts.push(request.url());
    };
    page.on('request', observeCreate);
    const absentCreation = async (route) => {
      if (route.request().method() === 'PUT')
        await route.fulfill({ status: 202 });
      else await route.continue();
    };
    await page.route('**/_system/resources/**', absentCreation);
    await newDraft.fill('Retry captured task');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'unconfirmed' }).waitFor();
    await page.unroute('**/_system/resources/**', absentCreation);
    await page
      .getByRole('button', { name: 'Check current version', exact: true })
      .click();
    await page
      .getByText('This resource is not currently present on the pod.', {
        exact: true,
      })
      .waitFor();
    await page
      .getByRole('button', { name: 'I have checked the pod', exact: true })
      .click();
    assert.equal(await newDraft.inputValue(), 'Retry captured task');
    assert.equal(await newDraft.isDisabled(), true);
    assert.equal(createAttempts.length, 1);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page
      .getByRole('button', { name: 'Retry captured task', exact: true })
      .waitFor();
    assert.equal(createAttempts.length, 2);
    assert.equal(createAttempts[1], createAttempts[0]);
    assert.equal(await newDraft.inputValue(), '');
    page.off('request', observeCreate);
    await page
      .getByRole('button', { name: 'Retry captured task', exact: true })
      .click();
    await page.getByLabel('Task', { exact: true }).nth(1).waitFor();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page
      .getByRole('button', { name: 'Retry captured task', exact: true })
      .waitFor({ state: 'detached' });
    // An uncertain creation cannot be submitted twice, even after same-view navigation.
    loseMethod = 'PUT';
    await page.route('**/_system/resources/**', loseAnswer);
    await page
      .getByLabel('Task', { exact: true })
      .first()
      .fill('Maybe created');
    const beforeCreate = writes;
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'unconfirmed' }).waitFor();
    assert.equal(writes, beforeCreate + 1);
    assert.equal(
      await page.getByLabel('Task', { exact: true }).first().isDisabled(),
      true,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Add', exact: true }).isDisabled(),
      true,
    );
    await page
      .getByRole('button', { name: 'Existing row', exact: true })
      .click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(
      await page.getByRole('button', { name: 'Add', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByRole('button', { name: 'I have checked the pod', exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page.getByLabel('Task', { exact: true }).first().inputValue(),
      'Maybe created',
    );
    assert.equal(writes, beforeCreate + 1);
    await page.unroute('**/_system/resources/**', loseAnswer);
    await page
      .getByRole('button', { name: 'Check current version', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Maybe created', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'I have checked the pod', exact: true })
      .click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page
      .getByRole('button', { name: 'Existing row', exact: true })
      .waitFor({ state: 'detached' });
    await page
      .getByRole('button', { name: 'Maybe created', exact: true })
      .click();
    await page.getByLabel('Task', { exact: true }).nth(1).fill('Leave me');
    await page.getByLabel('Data context').selectOption(personal);
    await page
      .getByRole('button', { name: 'Discard and continue', exact: true })
      .click();
    await page.getByText('No tasks yet.', { exact: true }).waitFor();
    await page.getByLabel('Data context').selectOption(work);
    await page
      .getByRole('button', { name: 'Maybe created', exact: true })
      .waitFor();
    assert.equal(
      await page
        .locator('input')
        .evaluateAll((nodes) => nodes.some((n) => n.value === 'Leave me')),
      false,
    );
    // A row mutation's acknowledgement must not discard a separate creation draft.
    await page
      .getByLabel('Task', { exact: true })
      .first()
      .fill('Keep this new title');
    loseMethod = 'PATCH';
    await page.route('**/_system/resources/**', loseAnswer);
    await page.getByRole('button', { name: 'Complete', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'unconfirmed' }).waitFor();
    await page.unroute('**/_system/resources/**', loseAnswer);
    await page
      .getByRole('button', { name: 'Check current version', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'I have checked the pod', exact: true })
      .click();
    assert.equal(
      await page.getByLabel('Task', { exact: true }).first().inputValue(),
      'Keep this new title',
    );
    await page.getByLabel('Task', { exact: true }).first().fill('');
    // A lost deletion answer stays uncertain even when a subsequent read finds absence.
    await page
      .getByRole('button', { name: 'Maybe created', exact: true })
      .click();
    await page.getByLabel('Task', { exact: true }).nth(1).waitFor();
    loseMethod = 'DELETE';
    await page.route('**/_system/resources/**', loseAnswer);
    const beforeDelete = writes;
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'unconfirmed' }).waitFor();
    assert.equal(writes, beforeDelete + 1);
    await page.unroute('**/_system/resources/**', loseAnswer);
    await page
      .getByRole('button', { name: 'Check current version', exact: true })
      .click();
    await page.getByRole('alert').filter({ hasText: 'unconfirmed' }).waitFor();
    await page
      .getByRole('button', { name: 'I have checked the pod', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Check again', exact: true })
      .last()
      .click();
    await page.getByText('No tasks yet.', { exact: true }).waitFor();
    await add('After unknown deletion');
    // Creation drafts use the same keyboard-accessible leave confirmation.
    await page.getByLabel('Task', { exact: true }).first().fill('Uncreated');
    await page
      .getByRole('button', { name: 'After unknown deletion', exact: true })
      .click();
    assert.equal(await page.getByRole('alertdialog').count(), 0);
    assert.equal(
      await page.getByLabel('Task', { exact: true }).first().inputValue(),
      'Uncreated',
    );
    await page.getByLabel('Data context').selectOption(personal);
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Tab');
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent),
      'Discard and continue',
    );
    await page.keyboard.press('Escape');
    assert.ok(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    );
    await page.screenshot({
      path: join(
        tmpdir(),
        'issue18-todo-' + (custom ? 'custom' : 'standard') + '.png',
      ),
      fullPage: true,
    });
    const busy = await context.newPage();
    await busy.goto(origin + (custom ? '/custom' : '/legacy'));
    await busy.getByRole('alert').filter({ hasText: 'another tab' }).waitFor();
    await busy.getByRole('button', { name: 'Deutsch', exact: true }).click();
    await busy.getByRole('alert').filter({ hasText: 'anderen Tab' }).waitFor();
    await busy.close();
    // A reload keeps the session and reselects the last chosen context from
    // localStorage while it is still readable; no new login, no new choice.
    await page.reload();
    await page
      .getByRole('button', { name: 'After unknown deletion', exact: true })
      .waitFor();
    await page.goto(origin + '/customized');
    await page
      .getByRole('button', { name: 'Data access', exact: true })
      .click();
    await page.getByRole('button', { name: 'Use work', exact: true }).click();
    await page.getByLabel('Custom draft').fill('Untouched');
    await page.getByText('Store my task', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'German', exact: true }).click();
    await page.getByText('Aufgabe ablegen', { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('Custom draft').inputValue(),
      'Untouched',
    );
    await page
      .getByRole('button', { name: 'Use personal', exact: true })
      .click();
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('output').textContent(), 'work');
    assert.deepEqual(errors, []);
    await context.close();
    const unavailable = await browser.newContext();
    await unavailable.addInitScript(() =>
      Object.defineProperty(globalThis, 'indexedDB', {
        value: undefined,
        configurable: true,
      }),
    );
    const failed = await unavailable.newPage();
    await failed.goto(origin + (custom ? '/custom' : '/legacy'));
    await failed
      .getByRole('alert')
      .filter({ hasText: 'storage could not be opened' })
      .waitFor();
    assert.equal(
      await failed
        .getByRole('button', { name: 'Connect', exact: true })
        .count(),
      0,
    );
    await failed.getByRole('button', { name: 'Deutsch', exact: true }).click();
    await failed
      .getByRole('alert')
      .filter({ hasText: 'Sitzungsspeicher' })
      .waitFor();
    await unavailable.close();
  }
  // The separate known-Pod recipe uses the same packed SDK and real PKCE fixture.
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin
        ? route.continue()
        : route.abort(),
    );
    await page.goto(origin + '/recipe');
    assert.equal(await page.getByLabel('Pod URL').count(), 0);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Data context').selectOption(work);
    await page.getByLabel('Note', { exact: true }).fill('Keep this note');
    // While signed in, the same action is labelled as updating access.
    assert.equal(
      await page.getByRole('button', { name: 'Sign in', exact: true }).count(),
      0,
    );
    await page
      .getByRole('button', { name: 'Update access', exact: true })
      .click();
    await page.getByRole('alertdialog').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(
      await page.getByLabel('Note', { exact: true }).inputValue(),
      'Keep this note',
    );
    await page.getByRole('button', { name: 'EN/DE' }).click();
    assert.equal(
      await page.getByLabel('Notiz', { exact: true }).inputValue(),
      'Keep this note',
    );
    await page.getByRole('button', { name: 'EN/DE' }).click();
    // Lose read access while focus is in the content. Recovery stays outside it.
    await page.route('**/alice/_system/contexts', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body['https://schema.sempods.org/readableContext'] = [];
      body['https://schema.sempods.org/writableContext'] = [];
      body['http://www.w3.org/ns/sparql-service-description#namedGraph'] = [];
      await route.fulfill({ response, json: body });
    });
    await page
      .getByRole('button', { name: 'Check again', exact: true })
      .click();
    await page.getByLabel('Note', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(
      await page.getByLabel('Note', { exact: true }).inputValue(),
      'Keep this note',
    );
    await page.getByLabel('Fallback', { exact: true }).selectOption('disabled');
    await page
      .getByLabel('Note', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(
      await page.getByLabel('Note', { exact: true }).isDisabled(),
      true,
    );
    await page.getByLabel('Fallback', { exact: true }).selectOption('custom');
    await page.getByText('Contact the host for access.').waitFor();
    await page.unroute('**/alice/_system/contexts');
    await page
      .getByRole('button', { name: 'Check again', exact: true })
      .click();
    await page
      .getByLabel('Note', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(
      await page.getByLabel('Note', { exact: true }).inputValue(),
      'Keep this note',
    );
    const beforeWrites = writes;
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Created.', { exact: true }).waitFor();
    assert.equal(writes, beforeWrites + 1);
    assert.equal(
      await page.getByLabel('Connections', { exact: true }).textContent(),
      '1',
    );
    await page
      .getByRole('button', { name: 'Update access', exact: true })
      .click();
    // Re-authorization returns to the remembered, still readable context.
    await page
      .getByLabel('Note', { exact: true })
      .waitFor({ state: 'visible' });
    assert.equal(await page.getByLabel('Data context').inputValue(), work);
    assert.equal(
      await page.getByLabel('Connections', { exact: true }).textContent(),
      '1',
    );
    const second = await context.newPage();
    await second.goto(origin + '/recipe');
    await second
      .getByRole('alert')
      .filter({ hasText: 'another tab' })
      .waitFor();
    assert.equal(
      await second
        .getByRole('button', { name: 'Sign in', exact: true })
        .isDisabled(),
      true,
    );
    await second.close();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      'Packed known-Pod recipe: PKCE callback, explicit context, reauthorization to the remembered context, draft guards, EN/DE, hidden/disabled/custom access recovery and busy-tab feedback passed.',
    );
  }
  // The TODO app as an installable PWA with the recipe's service worker. The
  // Pod shares this origin, the hardest case for a worker's request filter.
  {
    pwaMode = true;
    tasks.clear();
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e));
    const seen = [];
    context.on('response', (r) => {
      const url = new URL(r.url());
      seen.push({
        path: url.pathname,
        query: url.search,
        sw: r.fromServiceWorker(),
      });
    });
    await page.goto(origin + '/');
    assert.ok(
      await page.evaluate(() =>
        navigator.serviceWorker.ready.then((r) => Boolean(r.active)),
      ),
    );
    // A worker never claims an open page; the next navigation is controlled.
    assert.equal(
      await page.evaluate(() => navigator.serviceWorker.controller),
      null,
    );
    await page.reload();
    assert.ok(
      await page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    );
    assert.equal(
      await page.evaluate(async () => {
        const manifest = document.querySelector('link[rel=manifest]');
        const body = await (await fetch(manifest.href)).json();
        return [
          body.id,
          body.display,
          body.start_url,
          body.scope,
          body.icons.length,
        ].join();
      }),
      '/,standalone,./,./,2',
    );
    seen.length = 0;
    await page.getByLabel('Your Pod').fill(pod);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByLabel('Data context').selectOption(work);
    await page.getByText('No tasks yet.', { exact: true }).waitFor();
    await page.getByLabel('Task', { exact: true }).first().fill('Installed');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page
      .getByRole('button', { name: 'Installed', exact: true })
      .waitFor();
    // Shell files come from the worker; Pod, OAuth and callback never do.
    assert.ok(seen.some((r) => r.path === '/app.js' && r.sw));
    const passing = seen.filter(
      (r) => r.path.startsWith('/alice') || r.path === '/callback',
    );
    assert.ok(passing.some((r) => r.path === '/callback' && r.query));
    assert.ok(passing.some((r) => r.path.includes('/_system/resources/')));
    assert.deepEqual(
      passing.filter((r) => r.sw),
      [],
    );
    const cached = () =>
      page.evaluate(async () => {
        const entries = [];
        for (const name of await caches.keys())
          for (const request of await (await caches.open(name)).keys()) {
            const url = new URL(request.url);
            entries.push(name + ' ' + url.pathname + url.search);
          }
        return entries.sort();
      });
    const shell = (base, version) =>
      [
        '',
        'app.css',
        'app.js',
        'icon-192.png',
        'icon-512.png',
        'manifest.webmanifest',
      ].map((path) => `sempods-shell:${base}:${version} ${base}${path}`);
    // A second app on this origin, under /second/: its own scope and caches.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) =>
          navigator.serviceWorker.register('/second/sw.js').then((r) => {
            const worker = r.installing ?? r.waiting;
            if (!worker) return resolve();
            worker.addEventListener('statechange', () => {
              if (worker.state === 'activated') resolve();
              if (worker.state === 'redundant') reject(new Error('redundant'));
            });
          }, reject),
        ),
    );
    assert.deepEqual(
      await cached(),
      [...shell('/', 'v1'), ...shell('/second/', 'v1')].sort(),
    );
    // Offline restoration reports its network failure but retains the stored session.
    // Coming back online below restores it without another authorization.
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('heading', { name: 'TODO', level: 1 }).waitFor();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.getByLabel('Your Pod', { exact: true }).count(), 0);
    assert.equal(
      await page
        .getByText('Full addresses')
        .locator('..')
        .textContent()
        .then((text) => text.includes(pod)),
      true,
    );
    await context.setOffline(false);
    await page.reload();
    await page
      .getByRole('button', { name: 'Installed', exact: true })
      .waitFor();
    // An update is announced but never reloads over a draft.
    await page
      .getByLabel('Task', { exact: true })
      .first()
      .fill('Unsaved draft');
    await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
    workerVersion = 'v2';
    await page.evaluate(() =>
      navigator.serviceWorker.getRegistration().then((r) => r.update()),
    );
    const germanUpdate = page.getByRole('status').filter({
      hasText: 'Eine neue Version ist bereit.',
    });
    const englishUpdate = page.getByRole('status').filter({
      hasText: 'A new version is ready.',
    });
    await germanUpdate.waitFor();
    assert.equal(await englishUpdate.count(), 0);
    assert.equal(
      await page.getByLabel('Aufgabe', { exact: true }).first().inputValue(),
      'Unsaved draft',
    );
    // The already-visible notice follows the app's language without a remount
    // or worker takeover; the creation draft survives both changes.
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await englishUpdate.waitFor();
    assert.equal(await germanUpdate.count(), 0);
    assert.equal(
      await page.getByLabel('Task', { exact: true }).first().inputValue(),
      'Unsaved draft',
    );
    await page.getByRole('button', { name: 'Deutsch', exact: true }).click();
    await germanUpdate.waitFor();
    assert.equal(await englishUpdate.count(), 0);
    assert.equal(
      await page.getByLabel('Aufgabe', { exact: true }).first().inputValue(),
      'Unsaved draft',
    );
    assert.deepEqual(
      await cached(),
      [
        ...shell('/', 'v1'),
        ...shell('/', 'v2'),
        ...shell('/second/', 'v1'),
      ].sort(),
    );
    // Once every window is closed, the next start uses the new version. Only
    // this app's old shell is removed; the other app's shell and the session
    // stay.
    await page.close();
    const next = await context.newPage();
    next.on('pageerror', (e) => errors.push(e));
    await next.goto(origin + '/');
    await next.waitForFunction(
      async () =>
        (await caches.keys()).sort().join() ===
        'sempods-shell:/:v2,sempods-shell:/second/:v1',
    );
    assert.deepEqual(
      await next.evaluate(async () => {
        const entries = [];
        for (const name of await caches.keys())
          for (const request of await (await caches.open(name)).keys()) {
            const url = new URL(request.url);
            entries.push(name + ' ' + url.pathname + url.search);
          }
        return entries.sort();
      }),
      [...shell('/', 'v2'), ...shell('/second/', 'v1')].sort(),
    );
    await next
      .getByRole('region', { name: 'Data access', exact: true })
      .waitFor({ state: 'hidden' });
    await next
      .getByRole('button', { name: 'Installed', exact: true })
      .waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    pwaMode = false;
    console.log(
      'Packed PWA recipe: manifest, controlled shell, same-origin Pod/OAuth/callback untouched by the worker, install-time-only cache, offline start without logout, waiting update follows EN/DE without reload or draft loss, two apps on one origin keep separate shells.',
    );
  }
  // The same domain mapper and edit helpers also work without app-sdk, React or browser storage.
  tasks.clear();
  const node = async (args) =>
    (
      await execute(
        process.execPath,
        [join(temp, 'node.mjs'), pod, work, ...args],
        { env: { ...process.env, SEMPODS_TOKEN: token(pod, 'node-fixture') } },
      )
    ).stdout;
  const created = await node(['create', 'Node task']);
  assert.match(created, /created/);
  const iri = created.split(' ')[0];
  assert.equal(JSON.parse(await node(['list']))[0].title, 'Node task');
  assert.match(await node(['rename', iri, 'Renamed in Node']), /saved/);
  assert.match(await node(['complete', iri]), /saved/);
  assert.equal(JSON.parse(await node(['list']))[0].done, true);
  assert.match(await node(['reopen', iri]), /saved/);
  assert.match(await node(['delete', iri]), /removed/);
  assert.deepEqual(JSON.parse(await node(['list'])), []);
  assert.deepEqual(serverErrors, []);
  console.log(
    'Packed TODO: standard/custom UI, EN/DE, CRUD, conflict/unknown save/create/delete, custom message/picker, draft guards, A-B-A, keyboard/mobile, second-tab notice, reload with remembered context; shared Node CRUD passed.',
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
