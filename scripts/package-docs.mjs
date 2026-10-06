// The app-author reference shipped inside @sempods/app-sdk: the AI entry
// (docs/ai-app-builder.md) and every guide and example it reaches through local
// links, copied from the maintained sources at build time. SDK contributor
// instructions are left out; links to anything not shipped point to the same
// file at this release's tag. The copy is generated, never edited by hand.
//
//   node scripts/package-docs.mjs            write packages/app-sdk/{docs,examples}
//   node scripts/package-docs.mjs --check D  validate an extracted package in D
import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { remark } from 'remark';
import frontmatter from 'remark-frontmatter';
import gfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

export const ENTRY = 'docs/ai-app-builder.md';
export const SHIPPED_ROOTS = ['docs', 'examples'];
const REPOSITORY = 'https://github.com/sempods/sempods-typescript';
// SDK contributor and maintainer instructions are not app-author guidance.
const EXCLUDED = [
  /^docs\/agents\//,
  /(^|\/)(AGENTS|CLAUDE)\.md$/,
  /^docs\/contributing\.md$/,
  /^docs\/development\.md$/,
];
const here = dirname(fileURLToPath(import.meta.url));
const parser = remark().use(frontmatter).use(gfm);

const isExcluded = (path) => EXCLUDED.some((pattern) => pattern.test(path));
const isMarkdown = (path) => /\.md$/i.test(path);
const isExternal = (url) => /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(url);

/** Relative link and image URLs of a Markdown source, with their offsets. */
function relativeLinks(source) {
  const tree = parser.parse(source);
  const links = [];
  visit(tree, (node) => {
    if (!['link', 'image', 'definition'].includes(node.type)) return;
    if (!node.url || isExternal(node.url)) return;
    const { start, end } = node.position;
    const slice = source.slice(start.offset, end.offset);
    const at = slice.lastIndexOf(node.url);
    if (at < 0)
      throw new Error(`Cannot locate link ${node.url} in its Markdown source`);
    links.push({ url: node.url, offset: start.offset + at });
  });
  return links;
}

/** Repository path and fragment of a relative link in `file`, or undefined. */
function target(file, url) {
  const [path, ...fragment] = url.split('#');
  const resolved = posix.normalize(
    posix.join(posix.dirname(file), decodeURIComponent(path)),
  );
  if (resolved.startsWith('../') || resolved === '..') return undefined;
  return {
    path: resolved.replace(/\/$/, ''),
    fragment: fragment.length ? `#${fragment.join('#')}` : '',
  };
}

function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

/** The files to ship, as repository paths: the entry and what it reaches. */
export function referenceFiles(root) {
  const tracked = trackedFiles(root);
  const shippable = (path) =>
    SHIPPED_ROOTS.some((dir) => path.startsWith(`${dir}/`)) &&
    !isExcluded(path);
  const below = (dir) => tracked.filter((file) => file.startsWith(`${dir}/`));
  if (!tracked.includes(ENTRY)) throw new Error(`Missing ${ENTRY}`);
  const shipped = new Set();
  const pending = [ENTRY];
  const add = (path) => {
    if (shipped.has(path) || !shippable(path)) return;
    shipped.add(path);
    if (isMarkdown(path)) pending.push(path);
  };
  while (pending.length) {
    const file = pending.pop();
    shipped.add(file);
    for (const { url } of relativeLinks(
      readFileSync(join(root, file), 'utf8'),
    )) {
      const link = target(file, url);
      if (!link || !shippable(link.path)) continue;
      // A linked example ships whole, so its sources still compile together.
      const example = link.path.match(/^examples\/[^/]+/)?.[0];
      if (example && tracked.some((file) => file.startsWith(`${example}/`))) {
        for (const file of below(example)) add(file);
        if (tracked.includes('examples/tsconfig.json'))
          add('examples/tsconfig.json');
      } else if (tracked.includes(link.path)) add(link.path);
      else for (const file of below(link.path)) add(file);
    }
  }
  return [...shipped].sort();
}

/**
 * Points every relative link that leaves the shipped set to the same path at
 * the release tag; links within the shipped set stay relative.
 */
export function pinLinks(source, file, shipped, version) {
  const exists = (path) =>
    shipped.has(path) || [...shipped].some((f) => f.startsWith(`${path}/`));
  let result = source;
  for (const { url, offset } of relativeLinks(source).reverse()) {
    const link = target(file, url);
    if (link && exists(link.path)) continue;
    const path = link?.path ?? '';
    const kind = !path || !/\.[a-z\d]+$/i.test(path) ? 'tree' : 'blob';
    const pinned = `${REPOSITORY}/${kind}/v${version}/${path}${link?.fragment ?? ''}`;
    result =
      result.slice(0, offset) + pinned + result.slice(offset + url.length);
  }
  return result;
}

/** Writes the reference into the app-sdk package directory. */
export function writeReference(root) {
  const pkg = join(root, 'packages', 'app-sdk');
  const { version } = JSON.parse(
    readFileSync(join(pkg, 'package.json'), 'utf8'),
  );
  const files = referenceFiles(root);
  const shipped = new Set(files);
  for (const dir of SHIPPED_ROOTS)
    rmSync(join(pkg, dir), { recursive: true, force: true });
  for (const file of files) {
    const to = join(pkg, file);
    mkdirSync(dirname(to), { recursive: true });
    if (isMarkdown(file))
      writeFileSync(
        to,
        pinLinks(
          readFileSync(join(root, file), 'utf8'),
          file,
          shipped,
          version,
        ),
      );
    else copyFileSync(join(root, file), to);
  }
  return files;
}

function walk(dir, base = dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? walk(path, base)
      : [relative(base, path).split(sep).join('/')];
  });
}

/**
 * Problems of an extracted package's reference: the entry is present, no
 * contributor instructions are shipped, and every local link and anchor
 * resolves inside the package.
 */
export function checkReference(dir) {
  const errors = [];
  if (!existsSync(join(dir, ENTRY))) errors.push(`Missing ${ENTRY}`);
  const files = SHIPPED_ROOTS.flatMap((root) =>
    existsSync(join(dir, root))
      ? walk(join(dir, root)).map((f) => `${root}/${f}`)
      : [],
  );
  for (const file of files)
    if (isExcluded(file))
      errors.push(`${file}: contributor instructions are not shipped`);
  const markdown = files.filter(isMarkdown);
  for (const file of markdown)
    for (const { url } of relativeLinks(readFileSync(join(dir, file), 'utf8')))
      if (!target(file, url))
        errors.push(`${file}: local link leaves the package: ${url}`);
  if (markdown.length) {
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
        ...markdown,
      ],
      { cwd: dir, encoding: 'utf8' },
    );
    if (result.error || result.status !== 0)
      errors.push(
        result.error?.message ||
          result.stderr ||
          result.stdout ||
          `Markdown validation exited with ${result.status}`,
      );
  }
  return errors;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv[2] === '--check') {
    const errors = checkReference(resolve(process.argv[3] ?? '.'));
    if (errors.length) {
      console.error(errors.join('\n'));
      process.exitCode = 1;
    } else
      console.log('Packaged app-author reference: entry and links passed.');
  } else {
    const files = writeReference(resolve(here, '..'));
    console.log(`Packaged app-author reference: ${files.length} files.`);
  }
}
