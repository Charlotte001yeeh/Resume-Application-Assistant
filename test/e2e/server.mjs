/* Static server for the local mock application pages (127.0.0.1, testing only) */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

export function startServer(dir, port = 0) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const rel = normalize(urlPath === '/' ? '/cn-form.html' : urlPath).replace(/^([/\\])+/, '');
      const file = join(dir, rel);
      if (!file.startsWith(dir) || !existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({ server, port: actual, baseUrl: `http://127.0.0.1:${actual}` });
    });
  });
}
