import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The TODO example's own registry packages, such as the public RDF recipe's
 * parsers. Consumers that type-check the examples install them beside the
 * packed SDKs. Workspace, file and link specs are left out, and so are tools
 * the root manifest pins, such as React, which each consumer pins itself.
 */
export async function examplePackages(root) {
  const read = async (path) =>
    JSON.parse(await readFile(join(root, path), 'utf8'));
  const tools = (await read('package.json')).devDependencies;
  const manifest = await read('examples/todo/package.json');
  const own = (deps = {}) =>
    Object.fromEntries(
      Object.entries(deps).filter(
        ([name, spec]) =>
          !Object.hasOwn(tools, name) && !/^(workspace|file|link):/.test(spec),
      ),
    );
  return {
    dependencies: own(manifest.dependencies),
    devDependencies: own(manifest.devDependencies),
  };
}
