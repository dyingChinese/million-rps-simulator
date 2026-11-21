/**
 * server.js — HTTP 服务（主线程）
 *
 * 职责：
 *   - 在 Worker 线程里跑模拟引擎（绝不阻塞 HTTP / 流式推送）
 *   - 对外提供：静态前端、配置、状态、控制指令、二进制快照流
 *   - 慢客户端丢帧（写缓冲超过 8MB 时跳过该帧），避免内存膨胀
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB_ROOT = resolve(HERE, '../../web');
const WORKER_URL = new URL('../worker/sim-worker.js', import.meta.url);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 启动服务。
 * @param {object} [options]
 * @param {number} [options.port=8080]
 * @param {string} [options.host='127.0.0.1']
 * @param {object} [options.configPatch] 传给引擎的配置补丁
 * @param {boolean} [options.autostart=true]
 * @returns {Promise<{server: import('node:http').Server, worker: Worker, close: () => Promise<void>, url: string}>}
 */
export async function startServer(options = {}) {
  const port = options.port ?? 8080;
  const host = options.host ?? '127.0.0.1';
  const configPatch = options.configPatch ?? {};
  const autostart = options.autostart !== false;

  const worker = new Worker(WORKER_URL, {
    workerData: { configPatch, autostart },
    stdout: false,
    stderr: false,
  });

  let latestFrame = null;
  let latestStatus = { round: 0, status: 'starting', aliveCount: 0, rps: 0, seq: 0 };
  let cachedConfig = null;
  /** @type {Set<import('node:http').ServerResponse>} */
  const streamClients = new Set();
  const pendingControls = new Map();
  const pendingFrames = new Map();
  let controlSeq = 0;
  let viewersSent = -1;
  let closed = false;

  let resolveConfig;
  const configReady = new Promise((res) => (resolveConfig = res));

  // ── Worker 消息处理 ──
  worker.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'config': {
        cachedConfig = msg.config;
        resolveConfig(msg.config);
        break;
      }
      case 'status': {
        latestStatus = msg.data;
        break;
      }
      case 'frame': {
        latestFrame = new Uint8Array(msg.buffer);
        broadcastFrame(latestFrame);
        break;
      }
      case 'frameSingle': {
        const pending = pendingFrames.get(msg.id);
        if (pending) {
          pendingFrames.delete(msg.id);
          clearTimeout(pending.timer);
          pending.resolve(new Uint8Array(msg.buffer));
        }
        break;
      }
      case 'controlResult': {
        const pending = pendingControls.get(msg.id);
        if (pending) {
          pendingControls.delete(msg.id);
          clearTimeout(pending.timer);
          pending.resolve(msg.result);
        }
        break;
      }
      case 'error': {
        console.error('[sim-worker]', msg.message);
        break;
      }
      default:
        break;
    }
  });
  worker.on('error', (err) => console.error('[sim-worker] 线程异常:', err));
  worker.on('exit', (code) => {
    if (!closed && code !== 0) console.error(`[sim-worker] 线程退出 code=${code}`);
  });

  function broadcastFrame(frame) {
    for (const res of streamClients) {
      if (res.destroyed || res.writableEnded) {
        streamClients.delete(res);
        continue;
      }
      // 慢客户端：写缓冲积压超过 8MB 就跳过这一帧
      if (res.writableLength > 8 * 1024 * 1024) continue;
      try {
        res.write(frame);
      } catch {
        streamClients.delete(res);
      }
    }
    updateViewers();
  }

  function updateViewers() {
    const n = streamClients.size;
    if (n === viewersSent) return;
    viewersSent = n;
    worker.postMessage({ type: 'viewers', count: n });
  }

  /** 发送控制指令给 Worker 并等待结果 */
  function sendControl(payload, timeoutMs = 60_000) {
    return new Promise((resolvePromise) => {
      const id = ++controlSeq;
      const timer = setTimeout(() => {
        pendingControls.delete(id);
        resolvePromise({ ok: false, error: '引擎响应超时' });
      }, timeoutMs);
      pendingControls.set(id, { resolve: resolvePromise, timer });
      worker.postMessage({ type: 'control', id, payload });
    });
  }

  /** 取一帧快照（优先缓存；没有则向 Worker 请求） */
  async function getFrame() {
    if (latestFrame) return latestFrame;
    return new Promise((resolvePromise) => {
      const id = ++controlSeq;
      const timer = setTimeout(() => {
        pendingFrames.delete(id);
        resolvePromise(null);
      }, 60_000);
      pendingFrames.set(id, { resolve: resolvePromise, timer });
      worker.postMessage({ type: 'control', id, payload: { action: 'snapshot' } });
    });
  }

  // ── HTTP 服务 ──
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const pathname = url.pathname;

      if (pathname === '/api/stream' && req.method === 'GET') {
        handleStream(req, res);
        return;
      }
      if (pathname === '/api/config' && req.method === 'GET') {
        await configReady;
        const { PRESETS } = await import('../core/config.js');
        const presets = {};
        for (const [k, v] of Object.entries(PRESETS)) presets[k] = { label: v.label };
        return sendJson(res, 200, {
          ok: true,
          config: cachedConfig,
          presets,
          classNames: ['底层', '中层', '上层', '顶层'],
          talentNames: ['无', '幸运儿', '节俭者', '生育达人', '学习天才', '负债抗性'],
          classColors: ['#5b6b8c', '#3fa7d6', '#f5b942', '#ff5d73'],
          talentColors: ['#7f8c9b', '#f7d343', '#42d392', '#ff9f43', '#5b8cff', '#c56cf0'],
          version: 1,
        });
      }
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...latestStatus, frameBytes: latestFrame ? latestFrame.length : 0 });
      }
      if (pathname === '/api/frame' && req.method === 'GET') {
        const frame = await getFrame();
        if (!frame) return sendJson(res, 503, { ok: false, error: '帧尚未就绪' });
        latestFrame = frame; // 供后续 /api/stream 首帧复用
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': frame.length,
          'Cache-Control': 'no-cache, no-transform',
        });
        res.end(frame);
        return;
      }
      if (pathname === '/api/control' && req.method === 'POST') {
        const body = await readJsonBody(req, 2 * 1024 * 1024);
        if (!body || typeof body !== 'object' || !body.action) {
          return sendJson(res, 400, { ok: false, error: '缺少 action 字段' });
        }
        const result = await sendControl(body);
        return sendJson(res, 200, result);
      }
      if (pathname.startsWith('/api/')) {
        return sendJson(res, 404, { ok: false, error: '未知接口' });
      }

      // 静态文件
      let rel = pathname === '/' ? '/index.html' : pathname;
      try {
        rel = decodeURIComponent(rel);
      } catch {
        /* 非法转义按原样处理 */
      }
      const filePath = normalize(join(WEB_ROOT, rel));
      if (!filePath.startsWith(WEB_ROOT + sep) && filePath !== WEB_ROOT) {
        res.writeHead(403).end('forbidden');
        return;
      }
      try {
        const buf = await readFile(filePath);
        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      }
    } catch (err) {
      try {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: err && err.message });
        else res.end();
      } catch {
        /* 忽略 */
      }
    }
  });

  /** 二进制快照流 */
  function handleStream(req, res) {
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    streamClients.add(res);
    if (latestFrame) {
      try {
        res.write(latestFrame);
      } catch {
        /* 忽略 */
      }
    } else {
      // 兜底：暂停/结束状态下 worker 不会主动推帧（或从未广播过），这里主动取一帧
      getFrame()
        .then((frame) => {
          if (frame && !res.destroyed && !res.writableEnded) {
            latestFrame = frame;
            try {
              res.write(frame);
            } catch {
              /* 忽略 */
            }
          }
        })
        .catch(() => {});
    }
    updateViewers();
    const cleanup = () => {
      if (streamClients.delete(res)) updateViewers();
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  }

  async function readJsonBody(req, limit) {
    return new Promise((resolvePromise, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch (err) {
          reject(new Error('JSON 解析失败: ' + err.message));
        }
      });
      req.on('error', reject);
    });
  }

  await configReady;
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolvePromise());
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host}:${actualPort}`;

  const close = () =>
    new Promise((resolvePromise) => {
      if (closed) return resolvePromise();
      closed = true;
      for (const res of streamClients) {
        try {
          res.end();
        } catch {
          /* 忽略 */
        }
      }
      streamClients.clear();
      try {
        worker.postMessage({ type: 'shutdown' });
      } catch {
        /* 忽略 */
      }
      worker.terminate().catch(() => {});
      server.close(() => resolvePromise());
      setTimeout(resolvePromise, 1500);
    });

  return { server, worker, close, url, getStatus: () => latestStatus, getConfig: () => cachedConfig };
}
