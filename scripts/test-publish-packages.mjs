#!/usr/bin/env node
// Regressions for scripts/publish-packages.mjs against a fake `npm` registry:
// a fresh release, an interrupted release that resumes, a conflicting
// existing version and a failing publication. Nothing is sent to npm.
import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  'publish-packages.mjs',
);
const work = mkdtempSync(join(tmpdir(), 'publish-test-'));
try {
  // Two small tarballs shaped like the packed SDKs.
  const pack = (name, content, into) => {
    const root = join(work, 'src', `${name}-${content}`, 'package');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: `@sempods/${name}`, version: '0.1.0' }),
    );
    writeFileSync(join(root, 'index.js'), `export const v = '${content}';\n`);
    mkdirSync(into, { recursive: true });
    const file = join(into, `sempods-${name}-0.1.0.tgz`);
    execFileSync('tar', ['-czf', file, '-C', dirname(root), 'package']);
    return file;
  };
  const local = join(work, 'local');
  pack('client-sdk', 'a', local);
  pack('app-sdk', 'a', local);

  // Fake registry: a directory of published tarballs plus a call log.
  const registry = join(work, 'registry');
  mkdirSync(registry);
  const bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'npm'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const [command, target, ...rest] = process.argv.slice(2);
const registry = process.env.FAKE_REGISTRY;
fs.appendFileSync(path.join(registry, 'calls.log'), [command, path.basename(target)].join(' ') + '\\n');
const file = (spec) => path.join(registry, spec.replace('@sempods/', 'sempods-').replace('@', '-') + '.tgz');
if (command === 'view' && process.env.FAIL_VIEW) {
  console.error('npm error code ETIMEDOUT'); process.exit(1);
}
if (command === 'view') {
  if (fs.existsSync(file(target))) { console.log('"0.1.0"'); process.exit(0); }
  // Some npm versions answer an unmatched version with empty output.
  if (process.env.KNOWN_PACKAGE) process.exit(0);
  console.error('npm error code E404'); process.exit(1);
}
if (command === 'pack') {
  const into = rest[rest.indexOf('--pack-destination') + 1];
  fs.copyFileSync(file(target), path.join(into, path.basename(file(target))));
  process.exit(0);
}
if (command === 'publish') {
  if (process.env.FAIL_PUBLISH && target.includes(process.env.FAIL_PUBLISH)) process.exit(1);
  fs.copyFileSync(target, path.join(registry, path.basename(target)));
  process.exit(0);
}
process.exit(2);
`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const run = (env = {}) =>
    spawnSync('node', [script, local], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        FAKE_REGISTRY: registry,
        ...env,
      },
    });
  const calls = () =>
    readFileSync(join(registry, 'calls.log'), 'utf8').trim().split('\n');
  const reset = () => {
    rmSync(registry, { recursive: true, force: true });
    mkdirSync(registry);
  };

  // 1. An interrupted release: client published, app publication fails.
  let result = run({ FAIL_PUBLISH: 'app-sdk' });
  assert.equal(result.status, 1, result.stdout);
  assert.deepEqual(calls(), [
    'view client-sdk@0.1.0',
    'publish sempods-client-sdk-0.1.0.tgz',
    'view app-sdk@0.1.0',
    'publish sempods-app-sdk-0.1.0.tgz',
  ]);

  // 2. Rerunning resumes: the identical client is verified and skipped.
  rmSync(join(registry, 'calls.log'));
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /client-sdk@0\.1\.0 is already published with identical contents/,
  );
  assert.match(result.stdout, /app-sdk@0\.1\.0 published/);
  assert.ok(!calls().includes('publish sempods-client-sdk-0.1.0.tgz'));

  // 3. A different artifact under the same version is never skipped.
  reset();
  cpSync(
    pack('client-sdk', 'b', join(work, 'other')),
    join(registry, 'sempods-client-sdk-0.1.0.tgz'),
  );
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /already published with different contents/);
  assert.ok(!calls().some((c) => c.startsWith('publish')));

  // 4. A fresh release publishes both, client first.
  reset();
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    calls().filter((c) => c.startsWith('publish')),
    [
      'publish sempods-client-sdk-0.1.0.tgz',
      'publish sempods-app-sdk-0.1.0.tgz',
    ],
  );
  // 5. An empty answer (unmatched version) also counts as not yet published.
  reset();
  result = run({ KNOWN_PACKAGE: '1' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(calls().filter((c) => c.startsWith('publish')).length, 2);

  // 6. A registry error other than "not found" never leads to a publication.
  reset();
  result = run({ FAIL_VIEW: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Could not check/);
  assert.ok(!calls().some((c) => c.startsWith('publish')));
  console.log('Publish script regressions passed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
