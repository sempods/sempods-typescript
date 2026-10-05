import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { checkDocs } from './check-docs.mjs';

function fixture(t, files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sempods-doc-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  for (const [name, text] of Object.entries({
    'README.md': '# Start\n[Agents](AGENTS.md)\n[Guide](guide.md#repeat-1)\n',
    'AGENTS.md': '# Agents\n[Start](README.md)\n',
    'guide.md': '# Repeat\n# Repeat\n',
    ...files,
  })) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

test('valid GFM anchors, references, images, encoded paths and skill files; ignore code and remote URLs', (t) => {
  const root = fixture(t, {
    'guide.md':
      '# Repeat\n# Repeat\n[Section][s]\n\n[s]: <nested/space name.md#über-code>\n\n![image](image.svg)\n[Skill](.agents/skills/demo/SKILL.md)\n`[not a link](missing.md)`\n```md\n[example](missing.md)\n```\n[Remote](https://example.invalid/no-network)\n[Encoded](nested/space%20name.md)\n',
    'nested/space name.md': '# Über `code`\n',
    '.agents/skills/demo/SKILL.md':
      '---\nname: demo\ndescription: Example\n---\n# Demo\n[Guide](../../../guide.md)\n',
    'image.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '.gitignore': 'node_modules/\n',
    'node_modules/ignored/README.md': '[Missing](missing.md)',
  });
  assert.deepEqual(checkDocs(root), []);
});

test('a missing cross-file anchor fails even when the file exists', (t) => {
  const root = fixture(t, { 'guide.md': '# Different\n' });
  assert.match(checkDocs(root).join('\n'), /heading/i);
});

test('broken skill targets, reference definitions and images fail', (t) => {
  const root = fixture(t, {
    'guide.md':
      '# Repeat\n# Repeat\n[Skill](.claude/skills/demo/SKILL.md)\n![Missing](lost.png)\n[Use][ref]\n\n[ref]: absent.md\n',
    '.claude/skills/demo/SKILL.md':
      '# Demo\n[Procedure](../../../missing.md)\n',
  });
  const errors = checkDocs(root).join('\n');
  for (const name of ['lost.png', 'absent.md', 'missing.md'])
    assert.ok(errors.includes(name), errors);
});

test('an isolated documentation cycle fails navigation despite valid links', (t) => {
  const root = fixture(t, {
    'island.md': '[Other](other.md)\n',
    'other.md': '[Island](island.md)\n',
  });
  const errors = checkDocs(root).join('\n');
  assert.match(errors, /island.md: unreachable from README.md/);
  assert.match(errors, /other.md: unreachable from AGENTS.md/);
});

test('an unused reference definition is not a navigation edge', (t) => {
  const root = fixture(t, {
    'guide.md': '# Repeat\n# Repeat\n\n[unused]: island.md\n',
    'island.md': '# Island\n',
  });
  assert.match(checkDocs(root).join('\n'), /island.md: unreachable/);
});

test('an unstaged tracked deletion passes after its incoming link is removed', (t) => {
  const root = fixture(t);
  execFileSync('git', ['add', '.'], { cwd: root });
  rmSync(join(root, 'guide.md'));
  writeFileSync(join(root, 'README.md'), '# Start\n[Agents](AGENTS.md)\n');
  assert.deepEqual(checkDocs(root), []);
});

test('an unstaged tracked rename uses the new file and updated incoming link', (t) => {
  const root = fixture(t);
  execFileSync('git', ['add', '.'], { cwd: root });
  renameSync(join(root, 'guide.md'), join(root, 'renamed.md'));
  writeFileSync(
    join(root, 'README.md'),
    '# Start\n[Agents](AGENTS.md)\n[Guide](renamed.md#repeat-1)\n',
  );
  assert.deepEqual(checkDocs(root), []);
});

test('a deleted tracked target still fails when its incoming link remains', (t) => {
  const root = fixture(t);
  execFileSync('git', ['add', '.'], { cwd: root });
  rmSync(join(root, 'guide.md'));
  assert.match(checkDocs(root).join('\n'), /Cannot find file `guide.md/);
});

test('deleting a required entry still reports missing navigation', (t) => {
  const root = fixture(t);
  execFileSync('git', ['add', '.'], { cwd: root });
  rmSync(join(root, 'AGENTS.md'));
  assert.match(
    checkDocs(root).join('\n'),
    /Missing navigation entry AGENTS.md/,
  );
});

for (const revision of ['v0.2.0', 'v0.1.0', 'main']) {
  test(`package README links must match the package version: ${revision}`, (t) => {
    const root = fixture(t, {
      'guide.md': '# Repeat\n# Repeat\n[Package](packages/app-sdk/README.md)\n',
      'packages/app-sdk/package.json': JSON.stringify({
        name: '@sempods/app-sdk',
        version: '0.2.0',
      }),
      'packages/app-sdk/README.md': `# Package\n[Direct](https://github.com/sempods/sempods-typescript/blob/${revision}/docs/browser-runtime.md)\n[Reference][docs]\n\n[docs]: https://github.com/sempods/sempods-typescript/tree/${revision}/examples/todo\n\n[External](https://github.com/example/other/blob/main/README.md)\n`,
    });
    const errors = checkDocs(root);
    if (revision === 'v0.2.0') assert.deepEqual(errors, []);
    else {
      assert.equal(errors.length, 2);
      assert.ok(
        errors.every((error) =>
          error.includes('repository link must use v0.2.0'),
        ),
      );
    }
  });
}
