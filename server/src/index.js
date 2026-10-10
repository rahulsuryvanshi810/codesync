import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { RoomManager, ROOM_ID } from './rooms.js';
import { FilePersistence } from './persistence.js';
import { CodeRunner, RunnerError } from './runner.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readJson(req, limitBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new RunnerError('request body too large', 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new RunnerError('invalid JSON', 400)); }
    });
    req.on('error', reject);
  });
}

/** Per-IP fixed-window limit for /api/run, the one expensive endpoint. */
function createRunLimiter({ limit = 20, windowMs = 60_000 } = {}) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [ip, h] of hits) if (h.resetAt <= now) hits.delete(ip);
  }, windowMs);
  timer.unref();
  return {
    allow(ip) {
      const now = Date.now();
      let h = hits.get(ip);
      if (!h || h.resetAt <= now) {
        h = { count: 0, resetAt: now + windowMs };
        hits.set(ip, h);
      }
      h.count++;
      return h.count <= limit;
    },
    stop: () => clearInterval(timer),
  };
}

/**
 * HTTP + WebSocket server.
 *   WS   /ws/:room      CRDT sync and presence
 *   POST /api/run       execute code  { language, code, stdin? }
 *   GET  /api/health    liveness and room stats
 *   GET  /*             the built React client (single-page app fallback)
 */
export function createApp({
  dataDir = 'data',
  staticDir,
  persistence = new FilePersistence(dataDir),
  runner = new CodeRunner(),
  roomOptions = {},
  runLimit,
  heartbeatMs = 30_000,
} = {}) {
  const rooms = new RoomManager({ persistence, ...roomOptions });
  const runLimiter = createRunLimiter(runLimit);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  async function serveStatic(req, res, pathname) {
    if (!staticDir) return sendJson(res, 404, { error: 'not found' });
    const root = path.resolve(staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(pathname)}`);
    if (file !== root && !file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'forbidden' }); // path traversal
    let info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      file = path.join(root, 'index.html'); // SPA fallback: /r/abc is a client-side route
      info = await stat(file).catch(() => null);
      if (!info) return sendJson(res, 404, { error: 'client not built; run npm run build' });
    }
    const immutable = file.includes(`${path.sep}assets${path.sep}`); // Vite hashes these filenames
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, ...(await rooms.stats()), languages: runner.languages });
      }
      if (pathname === '/api/run') {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'use POST' });
        if (!runLimiter.allow(req.socket.remoteAddress)) {
          return sendJson(res, 429, { error: 'too many runs, slow down' });
        }
        const body = await readJson(req, 256 * 1024);
        return sendJson(res, 200, await runner.run(body));
      }
      if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
      return serveStatic(req, res, pathname);
    } catch (err) {
      if (err instanceof RunnerError) return sendJson(res, err.status, { error: err.message });
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const match = /^\/ws\/([^/]+)$/.exec(pathname);
    if (!match || !ROOM_ID.test(match[1])) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, match[1]));
  });

  async function onConnection(ws, roomName) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // The client starts its handshake as soon as the socket opens, possibly before
    // the room has loaded from disk. Buffer those first messages instead of dropping them.
    const early = [];
    const buffer = (data) => early.push(data);
    ws.on('message', buffer);
    const room = await rooms.get(roomName);
    ws.off('message', buffer);
    if (ws.readyState !== ws.OPEN || !room.join(ws)) return;
    for (const data of early) room.onMessage(ws, data);
  }

  // Heartbeat: detect half-open TCP connections (laptop lid closed, Wi-Fi dropped) and
  // terminate them so their cursors disappear for everyone else.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    server,
    rooms,
    listen(port = 3001, host = '0.0.0.0') {
      return new Promise((resolve) => server.listen(port, host, () => resolve(server.address())));
    },
    async close() {
      clearInterval(heartbeat);
      runLimiter.stop();
      await rooms.closeAll();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
