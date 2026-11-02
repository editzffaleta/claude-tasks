#!/usr/bin/env node
// Painel web + API REST do quadro de tarefas. Por padrão escuta só em 127.0.0.1.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_URL, PORT, Store } from './db.js';
import { attachEngine, tick } from './engine.js';
import { syncDueInboxes } from './inbox.js';
import { closeMapServers, handleMapRoute } from './mapa.js';
import { HttpError, buildRoutes } from './routes.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const HOST = process.env.CLAUDE_TASKS_HOST || '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
// Protege contra DNS rebinding e contra outros sites chamando a API pelo navegador.
// Em rede: CLAUDE_TASKS_HOST=0.0.0.0 CLAUDE_TASKS_HOSTS=meumac.local:4317 (ou * atrás de um proxy).
const EXTRA_HOSTS = (process.env.CLAUDE_TASKS_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
const ANY_HOST = EXTRA_HOSTS.includes('*');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...EXTRA_HOSTS]);
const hostAllowed = (host) => ANY_HOST || ALLOWED_HOSTS.has(host);
const COOKIE = 'tk_session';
const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
};

const store = new Store();
attachEngine(store);

const secure = (req) => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
const cookieFlags = (req) => `Path=/; HttpOnly; SameSite=Lax${secure(req) ? '; Secure' : ''}`;
const setSession = (res, token) => res.setHeader('set-cookie', `${COOKIE}=${token}; Max-Age=${90 * 86400}; ${cookieFlags(res.req)}`);
const clearSession = (res) => res.setHeader('set-cookie', `${COOKIE}=; Max-Age=0; ${cookieFlags(res.req)}`);

const routes = buildRoutes({ store, setSession, clearSession });

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function json(res, status, body) {
  if (res.headersSent) return res.end();
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Corpo grande demais');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ---- tempo real: Server-Sent Events ----
// Um único laço confere a versão do banco (que muda com gravações de qualquer processo,
// inclusive do MCP) e avisa todas as abas abertas. O cliente recarrega o que precisa.

const clients = new Set();
let lastVersion = store.version();

function sse(client, event, data) {
  if (!client.res.writableEnded) client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function openStream(req, res, user) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, user, unread: store.unreadCount(user?.id) };
  clients.add(client);
  sse(client, 'hello', { version: store.version(), unread: client.unread });
  req.on('close', () => clients.delete(client));
}

function pump() {
  if (!clients.size) return;
  let version;
  try { version = store.version(); } catch { return; }
  const changed = version !== lastVersion;
  lastVersion = version;
  for (const client of clients) {
    try {
      if (changed) {
        sse(client, 'change', { version });
        const unread = store.unreadCount(client.user?.id);
        if (unread !== client.unread) sse(client, 'unread', { unread: (client.unread = unread) });
      }
      for (const command of store.takeUiCommands(client.user?.id)) sse(client, 'ui', command);
    } catch (e) {
      console.error('sse:', e.message);
    }
  }
  // takeUiCommands grava; não conta como mudança do quadro.
  lastVersion = store.version();
}

setInterval(pump, 700).unref();
setInterval(() => { for (const c of clients) if (!c.res.writableEnded) c.res.write(': ping\n\n'); }, 25000).unref();

// ---- API ----

async function api(req, res, url) {
  const cookies = parseCookies(req);
  const user = store.sessionUser(cookies[COOKIE]);

  if (url.pathname === '/api/events' && req.method === 'GET') {
    if (!user) throw new HttpError(401, store.hasUsers() ? 'Faça login' : 'Crie a conta de administrador');
    return openStream(req, res, user);
  }

  for (const [method, pattern, handler, opts = {}] of routes) {
    const match = req.method === method && url.pathname.match(pattern);
    if (!match) continue;
    if (req.method !== 'GET') {
      const origin = req.headers.origin?.replace(/^https?:\/\//, '');
      if (origin && !hostAllowed(origin) && origin !== req.headers.host) throw new HttpError(403, 'Origem não permitida');
      if (opts.raw && !origin) throw new HttpError(403, 'Origem ausente');
      if (!opts.raw && req.method !== 'DELETE' && !req.headers['content-type']?.includes('application/json')) {
        throw new HttpError(415, 'Use application/json');
      }
    }
    if (!opts.public && !user) throw new HttpError(401, store.hasUsers() ? 'Faça login' : 'Crie a conta de administrador');
    let body = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const raw = await readBody(req, opts.raw ? 26 * 1024 * 1024 : 1_000_000);
      if (opts.raw) body = raw;
      else {
        try { body = raw.length ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON inválido'); }
        if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON inválido');
      }
    }
    const result = await handler({ req, res, url, params: match.slice(1), body, user, cookies });
    if (result !== undefined) json(res, 200, result);
    else if (!res.headersSent && !res.writableEnded) res.end();
    return;
  }
  throw new HttpError(404, 'Rota não encontrada');
}

// ---- arquivos do painel ----

// Páginas sem extensão: link público (/s/<token>) e documentação da API (/api/docs).
const PAGES = [
  [/^\/s\/[\w-]+$/, 'share.html'],
  [/^\/docs\/api\/?$/, 'api-docs.html'],
];

async function staticFile(res, url) {
  const page = PAGES.find(([re]) => re.test(url.pathname))?.[1];
  const file = page || normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (file.startsWith('..') || !TYPES[extname(file)]) throw new HttpError(404, 'Não encontrado');
  const data = await readFile(join(PUBLIC, file)).catch(() => { throw new HttpError(404, 'Não encontrado'); });
  res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache', ...SECURITY_HEADERS });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    if (!hostAllowed(req.headers.host)) throw new HttpError(403, 'Host não permitido');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/docs') {
      res.writeHead(302, { location: '/docs/api' });
      return res.end();
    }
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else if (url.pathname.startsWith('/mapa/')) {
      // Mapa do código de um projeto (página e API própria, com o login do quadro).
      const user = store.sessionUser(parseCookies(req)[COOKIE]);
      const originAllowed = (origin) => hostAllowed(origin) || origin === req.headers.host;
      if (!(await handleMapRoute({ store, req, res, url, user, originAllowed }))) await staticFile(res, url);
    } else await staticFile(res, url);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    json(res, status, { error: e.message });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`A porta ${PORT} já está em uso. O painel provavelmente já está rodando em ${BOARD_URL}`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, HOST, () => console.log(`Quadro de tarefas em ${BOARD_URL}`));

// Avisos de prazo, automações por tempo, recorrências e caixas de entrada por e-mail.
const safeTick = () => {
  try { tick(store); } catch (e) { console.error('tick:', e); }
  syncDueInboxes(store).catch((e) => console.error('caixas de entrada:', e.message));
};
setTimeout(safeTick, 5000);
setInterval(safeTick, 60000);

function shutdown() {
  for (const c of clients) c.res.end();
  closeMapServers();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
