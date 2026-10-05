import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { remark } from 'remark';
import frontmatter from 'remark-frontmatter';
import gfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

const here = dirname(fileURLToPath(import.meta.url));
const parser = remark().use(frontmatter).use(gfm);

// Inventory the working tree: include untracked additions and skip unstaged deletions.
// Passing every Markdown file to one CLI invocation enables cross-file anchors.
export function checkDocs(root) {
  const files = [
    ...new Set(
      execFileSync(
        'git',
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        { cwd: root, encoding: 'utf8' },
      ).split('\0'),
    ),
  ]
    .filter((file) => /\.md$/i.test(file) && existsSync(resolve(root, file)))
    .sort();
  if (!files.length) return ['No Markdown files found'];
  const result = spawnSync(
    process.execPath,
    [
      resolve(here, '../node_modules/remark-cli/cli.js'),
      '--rc-path',
      resolve(here, '../.remarkrc.json'),
      '--no-ignore',
      '--frail',
      '--quiet',
      '--no-stdout',
      '--no-color',
      '--',
      ...files,
    ],
    { cwd: root, encoding: 'utf8' },
  );
  const errors = [];
  if (result.error || result.status !== 0) {
    errors.push(
      result.error?.message ||
        result.stderr ||
        result.stdout ||
        `Markdown validation exited with ${result.status}`,
    );
  }

  const graph = new Map();
  const inventory = new Set(files.map((file) => resolve(root, file)));
  for (const file of files) {
    const absolute = resolve(root, file);
    const tree = parser.parse(readFileSync(absolute, 'utf8'));
    const packageVersion = /^packages\/[^/]+\/README\.md$/.test(file)
      ? JSON.parse(
          readFileSync(resolve(dirname(absolute), 'package.json'), 'utf8'),
        ).version
      : undefined;
    const definitions = new Map();
    visit(tree, 'definition', (node) => {
      if (!definitions.has(node.identifier))
        definitions.set(node.identifier, node.url);
    });
    const edges = new Set();
    visit(tree, (node) => {
      const url =
        node.type === 'link'
          ? node.url
          : node.type === 'linkReference'
            ? definitions.get(node.identifier)
            : undefined;
      if (!url) return;
      // npm readers need repository docs pinned to the package they are installing.
      // Compare revisions locally; a release tag may not exist during preparation.
      const repositoryLink = url.match(
        /^https:\/\/github\.com\/sempods\/sempods-typescript\/(?:blob|tree)\/([^/]+)\//,
      );
      if (
        packageVersion &&
        repositoryLink &&
        repositoryLink[1] !== `v${packageVersion}`
      ) {
        errors.push(
          `${file}: repository link must use v${packageVersion}: ${url}`,
        );
      }
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url)) return;
      let target;
      try {
        const path = decodeURIComponent(url.split(/[?#]/, 1)[0]);
        target = path
          ? resolve(
              url.startsWith('/') ? root : dirname(absolute),
              path.replace(/^\//, ''),
            )
          : absolute;
      } catch {
        return; // The link validator owns malformed-link diagnostics.
      }
      if (inventory.has(target)) edges.add(target);
    });
    graph.set(absolute, edges);
  }
  for (const entry of ['README.md', 'AGENTS.md']) {
    const start = resolve(root, entry);
    if (!inventory.has(start)) {
      errors.push(`Missing navigation entry ${entry}`);
      continue;
    }
    const reached = new Set();
    const pending = [start];
    while (pending.length) {
      const next = pending.pop();
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(...(graph.get(next) ?? []));
    }
    for (const file of files) {
      if (!reached.has(resolve(root, file)))
        errors.push(`${file}: unreachable from ${entry}`);
    }
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const errors = checkDocs(resolve(here, '..'));
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(
      'Local Markdown links, anchors and README/AGENTS navigation passed.',
    );
  }
}
