/* Tiny static server for reviewing the UI prototypes (zero dependencies).
 * Usage: node scripts/serve-mock.mjs [port]
 * Serves docs/mockups/ (no cache) and prints the exact URLs.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const DIR = join(ROOT, 'docs', 'mockups');
const PORT = Number(process.argv[2] || 8899);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? '/index.html' : urlPath;
    const target = join(DIR, normalize(rel).replace(/^([/\\])+/, ''));
    if (!target.startsWith(DIR)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
      return;
    }
    const data = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(data);
  } catch (e) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end(String(e && e.message));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`listening: http://127.0.0.1:${PORT}/`);
  console.log(`v1 prototype: http://127.0.0.1:${PORT}/fab-ui-review.html`);
  console.log(`v2 prototype: http://127.0.0.1:${PORT}/fab-ui-review-v2.html`);
});
