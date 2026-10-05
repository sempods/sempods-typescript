/* global document, window */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, lstat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';

/** Build and install a real widget archive beside the already packed SDKs. */
export async function prepareWidgets(root, temp) {
  const source = join(temp, 'widget-source');
  await cp(join(root, 'examples/todo'), source, {
    recursive: true,
    filter: (p) => !p.includes('/node_modules') && !p.includes('/dist'),
  });
  const library = join(temp, 'widget-package');
  await mkdir(join(library, 'dist'), { recursive: true });
  await cp(join(source, 'widgets/package.json'), join(library, 'package.json'));
  const bundle = await build({
    absWorkingDir: source,
    entryPoints: ['widgets/index.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    packages: 'external',
    outfile: join(library, 'dist/index.js'),
    metafile: true,
  });
  assert.ok(
    Object.keys(bundle.metafile.inputs).every(
      (p) => !p.includes('node_modules') && !p.includes(root),
    ),
  );
  const imports =
    bundle.metafile.outputs[Object.keys(bundle.metafile.outputs)[0]].imports;
  assert.ok(
    imports.some((i) => i.path === '@sempods/app-sdk/react' && i.external),
  );
  assert.ok(imports.some((i) => i.path === 'react/jsx-runtime' && i.external));
  await writeFile(
    join(source, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        jsx: 'react-jsx',
        strict: true,
        exactOptionalPropertyTypes: true,
        declaration: true,
        emitDeclarationOnly: true,
        outDir: 'declarations',
      },
      files: ['widgets/index.tsx'],
    }),
  );
  execFileSync(
    process.execPath,
    [
      join(temp, 'node_modules/typescript/bin/tsc'),
      '-p',
      join(source, 'tsconfig.json'),
    ],
    { stdio: 'inherit' },
  );
  await cp(
    join(source, 'declarations/widgets/index.d.ts'),
    join(library, 'dist/index.d.ts'),
  );
  const packed = JSON.parse(
    execFileSync('npm', ['pack', '--json', '--pack-destination', temp], {
      cwd: library,
      encoding: 'utf8',
    }),
  )[0];
  assert.deepEqual(packed.files.map((f) => f.path).sort(), [
    'dist/index.d.ts',
    'dist/index.js',
    'package.json',
  ]);
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      join(temp, packed.filename),
    ],
    { cwd: temp, stdio: 'pipe' },
  );
  const installed = join(temp, 'node_modules/@sempods/example-widgets');
  assert.equal((await lstat(installed)).isSymbolicLink(), false);
  await assert.rejects(
    lstat(join(installed, 'node_modules/@sempods/app-sdk')),
    { code: 'ENOENT' },
  );
  // Importing a widget is pure: no runtime, storage, login, worker or navigation.
  execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import assert from 'node:assert/strict';
    const touched = [];
    for (const name of ['window', 'document', 'location', 'localStorage', 'indexedDB', 'fetch'])
      Object.defineProperty(globalThis, name, { get() { touched.push(name); throw new Error(name); } });
    // Dependencies may inspect the user agent; they must not acquire a lock or worker.
    const navigator = { userAgent: 'widget-import-test' };
    for (const name of ['locks', 'serviceWorker'])
      Object.defineProperty(navigator, name, { get() { touched.push(name); throw new Error(name); } });
    Object.defineProperty(globalThis, 'navigator', { value: navigator });
    const widgets = await import('@sempods/example-widgets');
    assert.deepEqual(Object.keys(widgets).sort(), ['QuickAddWidget', 'TaskListWidget']);
    assert.deepEqual(touched, []);
  `,
    ],
    { cwd: temp, stdio: 'inherit' },
  );
  await cp(
    join(root, 'tests/runtime-browser/widgets.tsx'),
    join(temp, 'widgets.tsx'),
  );
  await writeFile(
    join(temp, 'tsconfig.widgets.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        lib: ['ES2022', 'DOM'],
        jsx: 'react-jsx',
        strict: true,
        noEmit: true,
      },
      files: ['widgets.tsx'],
    }),
  );
  execFileSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.widgets.json'],
    { cwd: temp, stdio: 'inherit' },
  );
  const options = {
    absWorkingDir: temp,
    entryPoints: ['widgets.tsx'],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    jsx: 'automatic',
    write: false,
    metafile: true,
  };
  const host = await build(options);
  const inputs = Object.keys(host.metafile.inputs);
  assert.ok(
    inputs.every((p) => !p.includes(root) && !p.includes('widget-source')),
  );
  assert.equal(
    inputs.filter((p) => p.endsWith('/app-sdk/dist/react/app.js')).length,
    1,
  );
  assert.equal(
    inputs.filter((p) => p === 'node_modules/react/index.js').length,
    1,
  );
  // Deliberately broken packaging: the widget resolves a second SDK context.
  await cp(
    join(temp, 'node_modules/@sempods/app-sdk'),
    join(temp, 'duplicate-sdk'),
    { recursive: true },
  );
  const duplicate = await build({
    ...options,
    plugins: [
      {
        name: 'duplicate-widget-sdk',
        setup(b) {
          b.onResolve({ filter: /^@sempods\/app-sdk\/react$/ }, (args) =>
            args.importer.includes('/example-widgets/')
              ? { path: join(temp, 'duplicate-sdk/dist/react/index.js') }
              : undefined,
          );
        },
      },
    ],
  });
  return {
    js: host.outputFiles[0].text,
    duplicateJs: duplicate.outputFiles[0].text,
  };
}

/** Data endpoints only; the runtime harness supplies real redirect/PKCE flow. */
export function widgetData() {
  const tasks = new Map();
  let readable = true;
  let writable = true;
  let writes = 0;
  return {
    access(read, write) {
      readable = read;
      writable = write;
    },
    get writes() {
      return writes;
    },
    handle(req, url, body, json) {
      if (
        !url.pathname.startsWith('/widgets-pod/_system/') ||
        url.pathname.includes('/auth/')
      )
        return false;
      const context = url.origin + '/widgets-pod/_system/contexts/work';
      assert.equal(req.headers.cookie, undefined);
      assert.ok(req.headers.authorization?.startsWith('Bearer '));
      if (url.pathname.endsWith('/contexts')) {
        const refs = [{ '@id': context }];
        json({
          '@id': url.origin + '/widgets-pod/_system/contexts',
          '@type': [
            'http://www.w3.org/ns/sparql-service-description#GraphCollection',
          ],
          'http://www.w3.org/ns/sparql-service-description#namedGraph': readable
            ? refs
            : [],
          'https://schema.sempods.org/readableContext': readable ? refs : [],
          'https://schema.sempods.org/writableContext': writable ? refs : [],
        });
      } else if (url.pathname.endsWith('/sparql/query')) {
        assert.equal(url.searchParams.get('default-graph-uri'), context);
        assert.equal(url.searchParams.get('named-graph-uri'), context);
        json(readable ? [...tasks.values()] : {}, readable ? 200 : 403);
      } else if (url.pathname.includes('/resources/')) {
        assert.equal(url.searchParams.get('context'), context);
        const iri = Buffer.from(
          url.pathname.split('/').at(-1),
          'base64url',
        ).toString();
        if (req.method === 'PUT') {
          assert.equal(req.headers['if-none-match'], '*');
          if (!writable) json({}, 403);
          else if (tasks.has(iri)) json({}, 412);
          else {
            writes++;
            tasks.set(iri, JSON.parse(body));
            json({}, 201, { etag: '"v1"' });
          }
        } else {
          assert.equal(req.method, 'GET');
          json(
            readable && tasks.has(iri) ? tasks.get(iri) : {},
            !readable ? 403 : tasks.has(iri) ? 200 : 404,
            { etag: '"v1"' },
          );
        }
      } else return false;
      return true;
    },
  };
}

export async function checkWidgets(page, origin, data) {
  await page.goto(origin + '/app?identity=widgets');
  const input = page.getByLabel('New task', { exact: true });
  await page.getByRole('heading', { name: 'My dashboard' }).waitFor();
  assert.equal(await input.isVisible(), false);
  await page.getByLabel('Fallback', { exact: true }).selectOption('disabled');
  assert.equal(await input.isVisible(), true);
  assert.equal(await input.isDisabled(), true);
  await page.getByLabel('Fallback', { exact: true }).selectOption('custom');
  assert.equal(
    await page.getByText('Ask the host for access.', { exact: true }).count(),
    2,
  );
  assert.equal(await input.isVisible(), false);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL('**/app?identity=widgets');
  await input.waitFor({ timeout: 5000 }).catch(async (cause) => {
    throw new Error(
      'Widget startup: ' + (await page.locator('body').innerText()),
      { cause },
    );
  });
  assert.equal(
    await page.getByLabel('Connections', { exact: true }).textContent(),
    '1',
  );
  await input.fill('From the add widget');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'From the add widget' })
    .waitFor();
  assert.equal(data.writes, 1);
  await input.fill('Keep this draft');
  await page.getByRole('button', { name: 'EN/DE', exact: true }).click();
  assert.equal(
    await page.getByLabel('Neue Aufgabe', { exact: true }).inputValue(),
    'Keep this draft',
  );
  await page.getByRole('heading', { name: 'Aufgaben', exact: true }).waitFor();
  await page.getByRole('button', { name: 'EN/DE', exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await page.getByRole('button', { name: 'Toggle list widget' }).click();
  assert.equal(await input.inputValue(), 'Keep this draft');
  await page.getByRole('button', { name: 'Toggle list widget' }).click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'From the add widget' })
    .waitFor();
  await page
    .getByRole('button', { name: 'Update access', exact: true })
    .click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await input.inputValue(), 'Keep this draft');
  const refresh = () =>
    page.getByRole('button', { name: 'Check again', exact: true }).click();
  data.access(true, false);
  await refresh();
  await page.waitForFunction(
    () => document.querySelector('input')?.disabled === true,
  );
  assert.equal(await input.inputValue(), 'Keep this draft');
  assert.equal(await page.getByRole('listitem').count(), 1);
  data.access(false, false);
  await refresh();
  await input.waitFor({ state: 'hidden' });
  assert.equal(await input.inputValue(), 'Keep this draft');
  data.access(true, true);
  await refresh();
  await input.waitFor({ state: 'visible' });
  // The host's sign-in action cannot leave while a sibling widget is writing.
  let releaseWrite;
  const dispatched = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  const holdWrite = async (route) => {
    if (route.request().method() === 'PUT') releaseWrite(route);
    else await route.continue();
  };
  await page.route('**/widgets-pod/_system/resources/**', holdWrite);
  await input.fill('Pending widget task');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const heldWrite = await dispatched;
  // Programmatic click deliberately bypasses inert hit testing; the action must guard too.
  await page
    .getByRole('button', { name: 'Update access', exact: true })
    .evaluate((button) => button.click());
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal(new URL(page.url()).pathname, '/app');
  assert.equal(await input.inputValue(), 'Pending widget task');
  await heldWrite.continue();
  await page.unroute('**/widgets-pod/_system/resources/**', holdWrite);
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Pending widget task' })
    .waitFor();
  assert.equal(data.writes, 2);
  await input.fill('Unconfirmed widget task');
  const lost = async (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    const req = route.request();
    const response = await fetch(req.url(), {
      method: 'PUT',
      headers: req.headers(),
      body: req.postData(),
      redirect: 'error',
    });
    assert.equal(response.status, 201);
    await route.abort('failed');
  };
  await page.route('**/widgets-pod/_system/resources/**', lost);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page
    .getByRole('button', { name: 'Check current version', exact: true })
    .waitFor();
  await page.unroute('**/widgets-pod/_system/resources/**', lost);
  await page
    .getByRole('button', { name: 'Update access', exact: true })
    .click();
  await page.getByRole('alertdialog').waitFor();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await input.inputValue(), 'Unconfirmed widget task');
  data.access(false, false);
  await refresh();
  await input.waitFor({ state: 'hidden' });
  assert.equal(
    await page
      .getByRole('button', { name: 'Check current version', exact: true })
      .isVisible(),
    true,
  );
  assert.equal(data.writes, 3);
  data.access(true, true);
  await refresh();
  await input.waitFor();
  await page
    .getByRole('button', { name: 'Check current version', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'I have checked the pod', exact: true })
    .click();
  assert.equal(data.writes, 3);
  // Clean host remount retains the session and does not create a second runtime.
  await page.evaluate(() => window.widgetHost.unmount());
  await page
    .getByRole('heading', { name: 'My dashboard' })
    .waitFor({ state: 'hidden' });
  await page.evaluate(() => window.widgetHost.remount());
  await input.waitFor();
  assert.equal(
    await page.getByLabel('Connections', { exact: true }).textContent(),
    '1',
  );
  const runtimeAfterRemount = await page.evaluate(
    async () => (await window.widgetHost.runtime.initialize()).storage,
  );
  assert.equal(runtimeAfterRemount, 'durable');
  // Explicit host disposal releases its native lease while the page stays open.
  await page.evaluate(() => window.widgetHost.dispose());
  const next = await page.context().newPage();
  await next.goto(origin + '/app?identity=widgets');
  await next.getByLabel('New task', { exact: true }).waitFor();
  await next.close();
  const duplicate = await page.context().newPage();
  const failure = duplicate.waitForEvent('pageerror');
  await duplicate.goto(origin + '/app?identity=widgets&duplicate=1');
  assert.match((await failure).message, /SempodsProvider is required/);
  await duplicate.close();
  console.log(
    'Packed widgets: shared SDK/React, pure import, one host runtime, cross-widget list refresh, guarded sign-in, access/draft/unknown-write recovery, remount, native disposal and duplicate-SDK rejection passed.',
  );
}
