#!/usr/bin/env node
// Publishes the packed SDK tarballs in dependency order (client-sdk first).
// Resumable: a version that is already on the registry is skipped only when
// its published contents equal the local artifact byte for byte; any other
// difference or npm error stops the release.
//
// Usage: node scripts/publish-packages.mjs <tarball-directory>
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const directory = process.argv[2];
if (!directory) fail('Usage: publish-packages.mjs <tarball-directory>');
const order = ['client-sdk', 'app-sdk'];
const work = mkdtempSync(join(tmpdir(), 'sempods-publish-'));
try {
  for (const name of order) {
    const tarball = readdirSync(directory).find((file) =>
      new RegExp(`^sempods-${name}-\\d.*\\.tgz$`).test(file),
    );
    if (!tarball)
      fail(`No packed tarball for @sempods/${name} in ${directory}`);
    const local = join(directory, tarball);
    const manifest = JSON.parse(
      execFileSync('tar', ['-xOzf', local, 'package/package.json'], {
        encoding: 'utf8',
      }),
    );
    const spec = `${manifest.name}@${manifest.version}`;
    const view = spawnSync('npm', ['view', spec, 'version', '--json'], {
      encoding: 'utf8',
    });
    if (view.status === 0 && view.stdout.trim()) {
      // Already published (for example by an interrupted earlier run).
      const fetched = join(work, name);
      execFileSync('npm', ['pack', spec, '--pack-destination', work], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      const published = readdirSync(work).find(
        (file) => file.endsWith('.tgz') && file.includes(name),
      );
      if (!published || !sameContents(local, join(work, published), fetched))
        fail(`${spec} is already published with different contents.`);
      console.log(
        `${spec} is already published with identical contents; skipped.`,
      );
      continue;
    }
    // npm answers E404 for an unknown package or version (checked with npm 10);
    // some npm versions answer an unmatched version with empty output instead.
    // Any other answer is not "absent" and stops the release.
    const absent =
      (view.status === 0 && !view.stdout.trim()) ||
      /E404|404 Not Found/.test(`${view.stdout}${view.stderr}`);
    if (!absent)
      fail(`Could not check ${spec} on the registry:\n${view.stderr}`);
    const publish = spawnSync(
      'npm',
      ['publish', local, '--provenance', '--access', 'public'],
      { stdio: 'inherit' },
    );
    if (publish.status !== 0) fail(`Publishing ${spec} failed.`);
    console.log(`${spec} published.`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

/** Same file paths and bytes inside both archives (archive metadata ignored). */
function sameContents(a, b, scratch) {
  const files = (archive, into) => {
    rmSync(into, { recursive: true, force: true });
    execFileSync('mkdir', ['-p', into]);
    execFileSync('tar', ['-xzf', archive, '-C', into]);
    const result = new Map();
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else result.set(relative(into, path), readFileSync(path));
      }
    };
    walk(into);
    return result;
  };
  const left = files(a, `${scratch}-local`);
  const right = files(b, `${scratch}-published`);
  return (
    left.size === right.size &&
    [...left].every(([path, bytes]) => right.get(path)?.equals(bytes))
  );
}
function fail(message) {
  console.error(message);
  process.exit(1);
}
