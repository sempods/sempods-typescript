import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  checkReference,
  referenceFiles,
  selfContainedTsconfig,
  writeReference,
} from './package-docs.mjs';

const PINNED = 'https://github.com/sempods/sempods-typescript';
let root;

function file(path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sempods-package-docs-'));
  file('packages/app-sdk/package.json', '{ "version": "9.9.9" }\n');
  file('README.md', '# SDK\n\n## Status\n');
  file('AGENTS.md', '# Contributors\n');
  file('docs/agents/release.md', '# Release\n');
  file('docs/contributing.md', '# Contributing\n');
  file('docs/vision.md', '# Vision\n');
  file(
    'docs/ai-app-builder.md',
    [
      '# Entry',
      '',
      '[quickstart](quickstart.md#run-it) [rules](../AGENTS.md)',
      '[release](agents/release.md) [contributing](contributing.md)',
      '[example](../examples/demo/src/app.tsx) [status](../README.md#status)',
      '',
      '```md',
      '[not a link](../AGENTS.md)',
      '```',
      '',
    ].join('\n'),
  );
  file(
    'docs/quickstart.md',
    '# Quickstart\n\n## Run it\n\n[entry](ai-app-builder.md)\n',
  );
  file('examples/demo/src/app.tsx', "import './domain.ts';\n");
  file('examples/demo/src/domain.ts', 'export {};\n');
  file(
    'examples/demo/README.md',
    '# Demo\n\n[guide](../../docs/quickstart.md)\n',
  );
  file('examples/other/README.md', '# Not linked\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the shipped reference', () => {
  it('follows local links from the entry and leaves contributor instructions out', () => {
    assert.deepEqual(referenceFiles(root), [
      'docs/ai-app-builder.md',
      'docs/quickstart.md',
      'examples/demo/README.md',
      'examples/demo/src/app.tsx',
      'examples/demo/src/domain.ts',
    ]);
  });

  it('keeps shipped links local and pins the rest to the release tag', () => {
    file('packages/app-sdk/docs/stale.md', '# Stale\n');
    writeReference(root);
    const pkg = join(root, 'packages/app-sdk');
    assert.equal(existsSync(join(pkg, 'docs/stale.md')), false);
    const entry = readFileSync(join(pkg, 'docs/ai-app-builder.md'), 'utf8');
    assert.match(entry, /\[quickstart\]\(quickstart\.md#run-it\)/);
    assert.match(entry, /\[example\]\(\.\.\/examples\/demo\/src\/app\.tsx\)/);
    assert.ok(entry.includes(`[rules](${PINNED}/blob/v9.9.9/AGENTS.md)`));
    assert.ok(
      entry.includes(`[release](${PINNED}/blob/v9.9.9/docs/agents/release.md)`),
    );
    assert.ok(
      entry.includes(
        `[contributing](${PINNED}/blob/v9.9.9/docs/contributing.md)`,
      ),
    );
    assert.ok(
      entry.includes(`[status](${PINNED}/blob/v9.9.9/README.md#status)`),
    );
    // Code blocks are text, not links.
    assert.ok(entry.includes('[not a link](../AGENTS.md)'));
    assert.deepEqual(checkReference(pkg), []);
  });
});

describe('shipped TypeScript configs', () => {
  it('merge their base config instead of extending a file outside the package', () => {
    file(
      'tsconfig.base.json',
      '{ "compilerOptions": { "strict": true, "target": "ES2020" } }\n',
    );
    file(
      'examples/tsconfig.json',
      '{ "extends": "../tsconfig.base.json", "compilerOptions": { "target": "ES2022" }, "include": ["**/*.ts"] }\n',
    );
    assert.deepEqual(selfContainedTsconfig(root, 'examples/tsconfig.json'), {
      compilerOptions: { strict: true, target: 'ES2022' },
      include: ['**/*.ts'],
    });
  });
});

describe('checking an extracted reference', () => {
  let pkg;
  beforeEach(() => {
    writeReference(root);
    pkg = join(root, 'packages/app-sdk');
  });

  it('reports a missing entry', () => {
    rmSync(join(pkg, 'docs/ai-app-builder.md'));
    assert.ok(
      checkReference(pkg).some((e) =>
        e.includes('Missing docs/ai-app-builder.md'),
      ),
    );
  });

  it('reports a missing linked document', () => {
    rmSync(join(pkg, 'docs/quickstart.md'));
    assert.notDeepEqual(checkReference(pkg), []);
  });

  it('reports a broken anchor', () => {
    writeFileSync(
      join(pkg, 'docs/quickstart.md'),
      '# Quickstart\n\n[entry](ai-app-builder.md)\n',
    );
    assert.notDeepEqual(checkReference(pkg), []);
  });

  it('reports a link that leaves the package', () => {
    writeFileSync(
      join(pkg, 'docs/quickstart.md'),
      '# Quickstart\n\n## Run it\n\n[outside](../../README.md)\n',
    );
    assert.ok(
      checkReference(pkg).some((e) => e.includes('leaves the package')),
    );
  });

  it('reports shipped contributor instructions', () => {
    mkdirSync(join(pkg, 'docs/agents'));
    writeFileSync(join(pkg, 'docs/agents/release.md'), '# Release\n');
    assert.ok(
      checkReference(pkg).some((e) => e.includes('contributor instructions')),
    );
  });
});
