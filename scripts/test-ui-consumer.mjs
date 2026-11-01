// The UI gate for @sempods/app-ui: packs client-sdk, app-sdk and app-ui,
// installs the tarballs in a fresh directory outside the workspace, compiles
// the reference screen in tests/ui-browser against the packed declarations,
// builds it with Vite and Tailwind CSS 4 (no @source line, no optimizeDeps
// hint) and runs the checks of scripts/ui-checks.mjs against a loopback Pod
// in each browser: Chromium and WebKit, plus Firefox on Linux.
//
// Usage: node scripts/test-ui-consumer.mjs [--browsers=chromium,webkit,firefox]
//        [--only=gate,roundtrip,interaction,integration,contrast]
//        [--evidence=<directory for JSON results>] [--keep]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { startPod } from './ui-pod.mjs';
import { suites } from './ui-checks.mjs';

const args = process.argv.slice(2);
const option = (name) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const engines = { chromium, webkit, firefox };
// Firefox does not launch in every macOS sandbox; CI runs it on Linux.
const browsers = (
  option('browsers') ??
  (process.platform === 'linux' ? 'chromium,webkit,firefox' : 'chromium,webkit')
).split(',');
const only = option('only')?.split(',');
const evidence = option('evidence');
for (const name of browsers)
  assert.ok(engines[name], `Unknown browser ${name}`);

const root = process.cwd();
const temp = await mkdtemp(join(tmpdir(), 'sempods-ui-'));
const pods = [];
try {
  for (const name of ['client-sdk', 'app-sdk', 'app-ui'])
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
    if (manifest.name === '@sempods/app-ui') {
      // The packed peer range names the SDK's minor; workspace: is resolved.
      assert.equal(
        manifest.peerDependencies['@sempods/app-sdk'],
        '~' + manifest.version,
      );
      assert.ok(!JSON.stringify(manifest).includes('workspace:'));
      const files = execFileSync('tar', ['-tf', join(temp, name)], {
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean);
      assert.ok(files.includes('package/styles.css'));
      assert.ok(files.includes('package/dist/index.js'));
      assert.ok(files.includes('package/dist/index.d.ts'));
      assert.deepEqual(
        files.filter(
          (f) =>
            !/^package\/(dist\/.+\.(js|d\.ts)|styles\.css|README\.md|PROVENANCE\.md|LICENSE|NOTICE|package\.json)$/.test(
              f,
            ),
        ),
        [],
        'unexpected files in the app-ui tarball',
      );
    }
  }
  await writeFile(
    join(temp, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      dependencies,
      devDependencies: {
        typescript: tools.typescript,
        vite: tools.vite,
        tailwindcss: tools.tailwindcss,
        '@tailwindcss/vite': tools['@tailwindcss/vite'],
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
  const app = join(temp, 'app');
  await cp(join(root, 'tests/ui-browser'), app, { recursive: true });
  // The installed README's examples: its TSX compiles with the app below, and
  // its stylesheet is the one the reference screen uses.
  const readme = await readFile(
    join(temp, 'node_modules/@sempods/app-ui/README.md'),
    'utf8',
  );
  const blocks = (lang) =>
    [
      ...readme.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g')),
    ].map((m) => m[1]);
  const examples = blocks('tsx');
  assert.ok(examples.length > 0, 'the README has no TSX example');
  for (const [i, example] of examples.entries())
    await writeFile(join(app, `readme-${i}.tsx`), example);
  const documentedCss = blocks('css')
    .find((block) => block.includes("@import '@sempods/app-ui/styles.css'"))
    ?.split('\n')
    .filter((line) => line && !line.startsWith('/*'));
  assert.ok(documentedCss, 'the README has no stylesheet setup');
  const appCss = (await readFile(join(app, 'index.css'), 'utf8')).split('\n');
  assert.deepEqual(
    appCss.filter((line) => documentedCss.includes(line)),
    documentedCss,
    'the reference screen does not use the documented stylesheet setup',
  );
  // A strict app compiles against the packed declarations, React Aria's
  // included (skipLibCheck stays off).
  await writeFile(
    join(temp, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'ESNext',
        moduleResolution: 'bundler',
        target: 'ES2022',
        jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['vite/client'],
        strict: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['app/**/*.tsx'],
    }),
  );
  execFileSync(join(temp, 'node_modules/.bin/tsc'), ['-p', temp], {
    cwd: temp,
    stdio: 'inherit',
  });
  // The app's Vite config has only the Tailwind plugin: no optimizeDeps and
  // no alias; the app's CSS has no @source line for the package.
  await writeFile(
    join(temp, 'vite.config.mjs'),
    `import tailwindcss from '@tailwindcss/vite';
export default { root: 'app', plugins: [tailwindcss()], build: { outDir: 'dist', emptyOutDir: true }, logLevel: 'error' };
`,
  );
  assert.doesNotMatch(
    await readFile(join(app, 'index.css'), 'utf8'),
    /^\s*@source/m,
  );
  execFileSync(join(temp, 'node_modules/.bin/vite'), ['build'], {
    cwd: temp,
    stdio: 'inherit',
  });
  const dist = join(app, 'dist');
  const css = (
    await Promise.all(
      (await readdir(join(dist, 'assets')))
        .filter((f) => f.endsWith('.css'))
        .map((f) => readFile(join(dist, 'assets', f), 'utf8')),
    )
  ).join('\n');
  // Classes that only the package's built JavaScript uses reached the CSS.
  for (const candidate of [
    'max-sm\\:h-dvh',
    '--cell-size',
    'bg-action',
    'data-exiting\\:animate-out',
  ])
    assert.ok(css.includes(candidate), `built CSS lacks ${candidate}`);

  if (args.includes('--keep')) {
    // Debugging: keep the built app and a Pod running until interrupted.
    const pod = await startPod(dist);
    pods.push(pod);
    console.log(
      `UI gate on ${pod.origin}, built app in ${dist}; Ctrl+C stops.`,
    );
    await new Promise(() => {});
  }
  const failures = [];
  const report = {};
  // Browsers run side by side, each against its own Pod (the checks reset it).
  await Promise.all(
    browsers.map(async (name) => {
      const pod = await startPod(dist);
      pods.push(pod);
      const browser = await engines[name].launch();
      const label = `${name} ${browser.version()}`;
      report[label] = {};
      try {
        for (const [suite, run] of Object.entries(suites)) {
          if (only && !only.includes(suite)) continue;
          const results = await run({
            browser,
            origin: pod.origin,
            engine: name,
          });
          report[label][suite] = results;
          for (const r of results) {
            const line = `${label} ${suite} ${r.pass ? '✓' : '✗'} ${r.id}${r.timezoneId ? ' ' + r.timezoneId : ''}`;
            console.log(r.pass ? line : `${line} ${JSON.stringify(r)}`);
            if (!r.pass) failures.push(line);
          }
        }
      } finally {
        await browser.close();
      }
    }),
  );
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, 'ui-gate.json'),
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  assert.deepEqual(failures, [], `${failures.length} UI checks failed`);
  const count = Object.values(report)
    .flatMap((s) => Object.values(s))
    .flat().length;
  console.log(`UI gate: ${count} checks passed in ${browsers.join(', ')}`);
} finally {
  await Promise.all(pods.map((pod) => pod.close()));
  await rm(temp, { recursive: true, force: true });
}
