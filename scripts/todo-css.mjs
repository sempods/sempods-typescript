// The TODO example's stylesheet, compiled as the apps template does: Vite
// with the Tailwind CSS 4 plugin, no @source line and no other options. The
// JavaScript stays an esbuild bundle that leaves the CSS import out.
import { join } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import { build } from 'vite';

/** Builds `examples/todo/src/style.css` below `root` and returns the CSS text. */
export async function todoCss(root) {
  const output = await build({
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [tailwindcss()],
    build: {
      write: false,
      rollupOptions: { input: join(root, 'examples/todo/src/style.css') },
    },
  });
  const css = [output]
    .flat()
    .flatMap((result) => result.output)
    .find((file) => file.fileName.endsWith('.css'));
  if (!css) throw new Error('The TODO stylesheet was not built');
  return String(css.source);
}
