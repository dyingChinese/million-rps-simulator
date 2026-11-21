/**
 * scripts/serve-web.js — 仅用于前端开发的极简静态服务器（无依赖）
 * 用法: node scripts/serve-web.js [--port 8090]
 * 生产运行请用 `npm start`（真实模拟服务器）。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, normalize, sep } from 'node:path';

const WEB_ROOT = resolve(process.cwd(), 'web');
const args = process.argv.slice(2);
const portIdx = args.indexOf('--port');
const PORT = Number(portIdx >= 0 ? args[portIdx + 1] : process.env.PORT || 8090);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = normalize(join(WEB_ROOT, pathname));
    if (!filePath.startsWith(WEB_ROOT + sep) && filePath !== WEB_ROOT) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  }
});

server.listen(PORT, () => {
  console.log(`[serve-web] 静态前端服务: http://127.0.0.1:${PORT}/  (根目录: ${WEB_ROOT})`);
  console.log(`[serve-web] mock 模式:  http://127.0.0.1:${PORT}/?mock=1`);
});
