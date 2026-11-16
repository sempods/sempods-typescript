import { createServer } from 'node:http';
import { build } from 'esbuild';
import { todoCss } from './todo-css.mjs';
const port = Number(process.env.PORT ?? 5173);
// The stylesheet goes through Tailwind (todo-css.mjs), not into the bundle.
const bundle = () =>
  build({
    entryPoints: ['examples/todo/src/main.tsx'],
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'esm',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    sourcemap: 'inline',
  });
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/app.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end((await bundle()).outputFiles[0].text);
    } else if (req.url === '/app.css') {
      res.setHeader('content-type', 'text/css');
      res.end(await todoCss(process.cwd()));
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" data-sempods-theme media="(prefers-color-scheme: light)" content="#f7f9f7"><meta name="theme-color" data-sempods-theme media="(prefers-color-scheme: dark)" content="#131b18"><title>sempods TODO</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>',
      );
    }
  } catch {
    res.writeHead(500);
    res.end('Build failed');
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`TODO: http://127.0.0.1:${port}`),
);
