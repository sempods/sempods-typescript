import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { discoveryDocument, resourceAnswer } from './consumer-fixture.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = await mkdtemp(join(tmpdir(), 'sempods-consumers-'));
const tools = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
).devDependencies;
const run = (command, args, cwd) =>
  execFileSync(command, args, { cwd, stdio: 'inherit' });
const json = (path, value) => writeFile(path, JSON.stringify(value, null, 2));
let browser;
let server;
try {
  for (const name of ['client-sdk', 'app-sdk']) {
    run(
      'pnpm',
      ['pack', '--pack-destination', temp],
      join(root, 'packages', name),
    );
  }
  const archives = (await readdir(temp)).filter((name) =>
    name.endsWith('.tgz'),
  );
  assert.equal(archives.length, 2);
  const tarballs = {};
  for (const name of archives) {
    const path = join(temp, name);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOf', path, 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    tarballs[manifest.name] = `file:${path}`;
    const contents = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
      .trim()
      .split('\n');
    assert.ok(
      contents.every((file) =>
        /^package\/(dist\/.+\.(js|d\.ts)|README\.md|PROVENANCE\.md|LICENSE|NOTICE|package\.json)$/.test(
          file,
        ),
      ),
      'Unexpected packed file',
    );
    for (const required of ['package/LICENSE', 'package/NOTICE'])
      assert.ok(contents.includes(required), `Missing ${required}`);
    assert.equal(manifest.license, 'Apache-2.0');
    if (manifest.name === '@sempods/app-sdk') {
      assert.equal(
        manifest.dependencies['@sempods/client-sdk'],
        JSON.parse(
          await readFile(
            join(root, 'packages/client-sdk/package.json'),
            'utf8',
          ),
        ).version,
      );
      assert.equal(manifest.peerDependenciesMeta.react.optional, true);
    }
  }
  async function consumer(name, react) {
    const path = join(temp, name);
    await mkdir(path);
    const devDependencies = { typescript: tools.typescript };
    if (name === 'plain') devDependencies['@types/node'] = tools['@types/node'];
    if (react)
      Object.assign(devDependencies, {
        react: tools.react,
        'react-dom': tools['react-dom'],
        '@types/react': tools['@types/react'],
        '@types/react-dom': tools['@types/react-dom'],
      });
    await json(join(path, 'package.json'), {
      name: `packed-${name}-consumer`,
      private: true,
      type: 'module',
      dependencies: tarballs,
      devDependencies,
    });
    // Outside the workspace; npm's file dependencies install both tarballs together.
    run(
      'npm',
      ['install', '--ignore-scripts', '--no-audit', '--no-fund'],
      path,
    );
    for (const pkg of ['client-sdk', 'app-sdk']) {
      const installed = join(path, 'node_modules/@sempods', pkg);
      assert.equal((await lstat(installed)).isSymbolicLink(), false);
      assert.ok(
        (await realpath(installed)).startsWith(`${await realpath(path)}/`),
      );
    }
    if (!react)
      for (const pkg of ['react', '@types/react']) {
        await assert.rejects(lstat(join(path, 'node_modules', pkg)), {
          code: 'ENOENT',
        });
      }
    return path;
  }
  const plain = await consumer('plain', false);
  const withReact = await consumer('react', true);
  const strict = {
    target: 'ES2022',
    strict: true,
    skipLibCheck: false,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
  };
  await cp(join(root, 'tests/consumers/node.mts'), join(plain, 'node.mts'));
  await json(join(plain, 'tsconfig.node.json'), {
    compilerOptions: {
      ...strict,
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2022'],
      types: ['node'],
      outDir: 'out',
    },
    files: ['node.mts'],
  });
  run(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.node.json'],
    plain,
  );
  run(process.execPath, ['out/node.mjs'], plain);

  // The ordinary browser consumer deliberately uses OAuth and app-sdk too.
  // Inspect a separate root-only graph, retaining all exports and imports.
  await cp(
    join(root, 'tests/consumers/client-root.ts'),
    join(plain, 'client-root.ts'),
  );
  const rootBundle = await build({
    absWorkingDir: plain,
    entryPoints: ['client-root.ts'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    treeShaking: false,
    write: false,
    metafile: true,
  });
  const rootInputs = Object.keys(rootBundle.metafile.inputs).map((input) =>
    input.replaceAll('\\', '/'),
  );
  assert.ok(
    rootInputs.includes('node_modules/@sempods/client-sdk/dist/index.js'),
  );
  assert.ok(
    rootInputs.every((input) => !input.includes(root)),
    'Root bundle used workspace source',
  );
  assert.deepEqual(
    rootInputs.filter(
      (input) =>
        /(?:^|\/)node_modules\/(?:oauth4webapi|react(?:-dom)?|@sempods\/app-sdk)(?:\/|$)/.test(
          input,
        ) ||
        /\/@sempods\/client-sdk\/dist\/(?:oauth|sessions|runtime|react)\//.test(
          input,
        ),
    ),
    [],
    'Client root imported OAuth, React or browser session facilities',
  );
  await writeFile(
    join(plain, 'client-root.mjs'),
    rootBundle.outputFiles[0].text,
  );
  run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const touched = [];
    function refuse(name) { touched.push(name); throw new Error('Import touched ' + name); }
    globalThis.fetch = () => refuse('fetch');
    for (const name of [
      'window', 'document', 'navigator', 'localStorage', 'sessionStorage',
      'indexedDB', 'location', 'history', 'XMLHttpRequest', 'WebSocket', 'EventSource',
    ])
      Object.defineProperty(globalThis, name, { get() { return refuse(name); } });
    const client = await import('./client-root.mjs');
    assert.deepEqual(touched, [], 'Client root used request/browser facilities on import');
    assert.equal(typeof client.createPod, 'function');
    assert.equal(typeof client.bearer, 'function');
    assert.equal(typeof client.decodeCatalogue, 'function');
  `,
    ],
    plain,
  );
  console.log(
    'Packed client root: no OAuth/React/app runtime imports; no requests or browser facilities on import.',
  );

  const assets = new Map();
  for (const [path, file, react] of [
    [plain, 'browser.ts', false],
    [withReact, 'react.tsx', true],
  ]) {
    await cp(join(root, 'tests/consumers', file), join(path, file));
    await json(join(path, 'tsconfig.browser.json'), {
      compilerOptions: {
        ...strict,
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: [],
        noEmit: true,
        ...(react ? { jsx: 'react-jsx' } : {}),
      },
      files: [file],
    });
    run(
      process.execPath,
      ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.browser.json'],
      path,
    );
    const result = await build({
      absWorkingDir: path,
      entryPoints: [file],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      jsx: 'automatic',
      write: false,
      metafile: true,
    });
    assert.ok(result.outputFiles[0]);
    assert.ok(
      Object.keys(result.metafile.inputs).every(
        (input) => !input.includes(root),
      ),
      'Bundle used workspace source',
    );
    assets.set(react ? '/react.js' : '/browser.js', result.outputFiles[0].text);
  }
  // The quickstart's code blocks, verbatim, as a Vite react-ts app would compile
  // them: a renamed export or changed option breaks this check, not a reader.
  const guide = await readFile(join(root, 'docs/quickstart.md'), 'utf8');
  const block = (lang) =>
    guide.match(new RegExp('```' + lang + '\\n([\\s\\S]*?)```'))?.[1];
  const quickstart = join(withReact, 'quickstart');
  await mkdir(quickstart);
  for (const [file, source] of [
    ['tasks.ts', block('ts')],
    ['App.tsx', block('tsx')],
  ]) {
    assert.ok(
      source?.includes('@sempods/'),
      `quickstart ${file} block missing`,
    );
    await writeFile(join(quickstart, file), source);
  }
  await writeFile(
    join(quickstart, 'main.tsx'),
    "import { StrictMode } from 'react';\n" +
      "import { createRoot } from 'react-dom/client';\n" +
      "import App from './App.tsx';\n" +
      "createRoot(document.getElementById('app')!).render(\n" +
      '  <StrictMode>\n    <App />\n  </StrictMode>,\n);\n',
  );
  // The part of Vite's client types the quickstart uses.
  await writeFile(
    join(quickstart, 'vite-env.d.ts'),
    'interface ImportMeta {\n  readonly hot?: { dispose(callback: () => void): void };\n}\n',
  );
  // Compiler options of the create-vite react-ts template (tsconfig.app.json).
  await json(join(quickstart, 'tsconfig.json'), {
    compilerOptions: {
      target: 'ES2023',
      lib: ['ES2023', 'DOM', 'DOM.Iterable'],
      module: 'ESNext',
      types: [],
      skipLibCheck: true,
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      verbatimModuleSyntax: true,
      moduleDetection: 'force',
      noEmit: true,
      jsx: 'react-jsx',
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      erasableSyntaxOnly: true,
      noFallthroughCasesInSwitch: true,
      noUncheckedSideEffectImports: true,
    },
    include: ['.'],
  });
  run(
    process.execPath,
    ['../node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    quickstart,
  );
  const quickstartBundle = await build({
    absWorkingDir: quickstart,
    entryPoints: ['main.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    write: false,
    metafile: true,
  });
  assert.ok(
    Object.keys(quickstartBundle.metafile.inputs).every(
      (input) => !input.includes(root),
    ),
    'Quickstart bundle used workspace source',
  );
  assets.set('/quickstart.js', quickstartBundle.outputFiles[0].text);
  const requests = [];
  server = createServer((req, res) => {
    const path = req.url ?? '';
    const origin = `http://${req.headers.host}`;
    const resource = resourceAnswer(origin, req.method, path, req.headers);
    if (resource) {
      requests.push({
        path,
        method: req.method,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      res.writeHead(resource.status, resource.headers ?? {});
      res.end(resource.body ?? '');
      return;
    }
    const metadata = discoveryDocument(origin, path);
    if (metadata) {
      requests.push({
        path,
        method: req.method,
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(metadata));
    } else if (assets.has(path)) {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(assets.get(path));
    } else if (path === '/plain' || path === '/react') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        `<div id="app"></div><script type="module" src="${path === '/react' ? '/react.js' : '/browser.js'}"></script>`,
      );
    } else if (path === '/quickstart') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<div id="app"></div><script type="module" src="/quickstart.js"></script>',
      );
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error));
  // Tests are entirely loopback: no SDK call may hit the registry or a real Pod.
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(`${origin}/plain`);
  await page.waitForFunction(() => document.body.dataset.ready === 'true');
  assert.equal(
    await page.locator('body').innerText(),
    `Zugriff prüfen | 1.234,5 | ${origin}/alice | 0 | ok | applied | ready`,
  );
  assert.deepEqual(
    requests.map((req) => req.path.split('?')[0]),
    [
      '/alice/.well-known/oauth-protected-resource',
      '/alice/.well-known/oauth-authorization-server',
      requests[2]?.path.split('?')[0],
      requests[2]?.path.split('?')[0],
      requests[2]?.path.split('?')[0],
    ],
  );
  assert.ok(requests[2]?.path.startsWith('/alice/_system/resources/'));
  assert.deepEqual(
    requests.slice(2).map((req) => req.method),
    ['GET', 'PATCH', 'GET'],
  );
  // Ambient cookies are never sent; the bearer goes only to data requests.
  assert.ok(requests.every((req) => req.cookie === undefined));
  assert.ok(
    requests.slice(0, 2).every((req) => req.authorization === undefined),
  );
  assert.ok(
    requests
      .slice(2)
      .every((req) => req.authorization === 'Bearer consumer-token'),
  );
  await page.goto(`${origin}/react`);
  await page.getByText('Review access', { exact: true }).waitFor();
  await page.getByLabel('draft').fill('Unfinished');
  await page.getByRole('button', { name: 'Deutsch' }).click();
  await page.getByText('Zugriff prüfen', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('draft').inputValue(), 'Unfinished');
  assert.equal(await page.locator('output').innerText(), '1.234,5');
  // The quickstart app starts and offers its first step.
  await page.goto(`${origin}/quickstart`);
  await page.getByText('My tasks', { exact: true }).waitFor();
  await page.getByLabel('Pod URL').waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Connect', exact: true }).count(),
    1,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Packed DOM-only browser discovery, the edit entry, React provider/draft preservation and the verbatim quickstart app passed in Chromium.',
  );
} finally {
  await browser?.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  await rm(temp, { recursive: true, force: true });
}
