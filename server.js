// Tiny zero-dependency static file server for the host app.
// Spotify only accepts loopback redirect URIs on 127.0.0.1 (not "localhost").
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('./public/', import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 8888);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function resolvePath(urlPath) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://x').pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const file = normalize(join(ROOT, pathname));
  return file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) ? file : null;
}

export const server = createServer(async (req, res) => {
  const file = resolvePath(req.url ?? '/');
  if (!file || (req.method !== 'GET' && req.method !== 'HEAD')) {
    res.writeHead(file ? 405 : 400).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  server.listen(PORT, HOST, () => console.log(`Music Game host running at http://${HOST}:${PORT}/`));
}
