// 128bit Tracker server: REST API + the pixel web app, zero dependencies.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db/index.js';
import { createEventBus } from './domain/events.js';
import { createDispatcher } from './domain/webhooks.js';
import { createAuth, requireScope } from './api/auth.js';
import { buildRoutes } from './api/routes.js';
import { HttpError } from './api/errors.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const MAX_BODY = 32 * 1024 * 1024; // full imports/backups can be large

export function createApp({ db = openDb(), fetchImpl, password, secret, corsOrigins = (process.env.TRACKER_CORS_ORIGINS ?? '').split(',').filter(Boolean) } = {}) {
  const notify = createDispatcher(db, { fetchImpl });
  const events = createEventBus(db, { onCommit: notify });
  const ctx = { db, events, notify };
  const auth = createAuth(db, { password, secret });
  const router = buildRoutes(ctx, auth);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const origin = req.headers.origin;
    // CORS is only for allow-listed origins (e.g. the 128bitplay web app) using API keys.
    if (origin && corsOrigins.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();

    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

    try {
      const { route, params, pathMatched } = router.match(req.method, url.pathname);
      if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method not allowed' : 'no such endpoint');
      const principal = auth.identify(req);
      if (route.scope) requireScope(principal, route.scope);
      const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readJson(req) : undefined;
      const out = await route.handler({
        params,
        query: Object.fromEntries(url.searchParams),
        body,
        principal,
        setHeader: (k, v) => res.setHeader(k, v),
      });
      const [status, payload] = Array.isArray(out) && typeof out[0] === 'number' ? out : [200, out];
      send(res, status, payload);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'internal error' });
    }
  });

  return { server, ctx };
}

function send(res, status, payload) {
  if (status === 204 || payload === undefined) return void res.writeHead(status === 200 ? 204 : status).end();
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!size) return undefined;
  if (!(req.headers['content-type'] ?? '').includes('application/json')) throw new HttpError(415, 'send application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel.split(/[/\\]/).includes('..')) return void res.writeHead(400).end();
  const file = join(PUBLIC_DIR, rel || 'index.html');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    // SPA fallback for client-side routes like /library
    if (extname(rel)) return void res.writeHead(404).end('not found');
    res.writeHead(200, { 'content-type': MIME['.html'] }).end(await readFile(join(PUBLIC_DIR, 'index.html')));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 8128);
  const host = process.env.HOST ?? '127.0.0.1';
  const { server, ctx } = createApp();
  server.listen(port, host, () => {
    console.log(`🎮 128bit Tracker on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    if (!process.env.TRACKER_PASSWORD && host !== '127.0.0.1' && host !== 'localhost') {
      console.warn('⚠  Listening beyond loopback without TRACKER_PASSWORD — the web UI will refuse non-local users. Set TRACKER_PASSWORD to log in remotely.');
    }
  });
  const stop = async () => {
    server.close();
    await ctx.events.flush();
    ctx.db.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
