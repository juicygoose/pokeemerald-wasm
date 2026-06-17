import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { createServer } from 'node:http';
import { Relay } from './relay.mjs';

const root = resolve(process.cwd());
const requestedPort = Number(process.env.PORT || 8000);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

function fileFor(url) {
  const pathname = new URL(url, `http://localhost:${requestedPort}`).pathname;
  const relative = pathname === '/' ? 'web/index.html' : pathname.slice(1);
  const file = resolve(root, normalize(relative));
  return file.startsWith(root) ? file : null;
}

const server = createServer((req, res) => {
  const file = fileFor(req.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': types.get(extname(file)) || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

// Netplay room relay shares the port via WebSocket upgrades (see web/relay.mjs).
new Relay({ log: (m) => console.log(`[relay] ${m}`) }).attach(server);

server.listen(requestedPort, function () {
  const { port } = this.address();
  console.log(`pokeemerald wasm server: http://localhost:${port} (ws relay on same port)`);
});
