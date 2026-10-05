import { createServer } from 'node:http';
import { build } from 'esbuild';
const port = Number(process.env.PORT ?? 5173);
const bundle = () =>
  build({
    entryPoints: ['examples/todo/src/main.tsx'],
    bundle: true,
    write: false,
    outdir: 'out',
    format: 'esm',
    sourcemap: 'inline',
  });
const server = createServer(async (req, res) => {
  try {
    const files = (await bundle()).outputFiles;
    if (req.url === '/app.js' || req.url === '/app.css') {
      const ext = req.url.endsWith('.css') ? '.css' : '.js';
      res.setHeader(
        'content-type',
        ext === '.css' ? 'text/css' : 'text/javascript',
      );
      res.end(files.find((f) => f.path.endsWith(ext))?.text);
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(
        '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>sempods TODO</title><link rel="stylesheet" href="/app.css"><div id="root"></div><script type="module" src="/app.js"></script></html>',
      );
    }
  } catch {
    res.writeHead(500);
    res.end('Build failed');
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`TODO: http://127.0.0.1:${port} (custom: /custom)`),
);
