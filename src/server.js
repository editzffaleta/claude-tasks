#!/usr/bin/env node
// Painel web + API REST do quadro de tarefas. Por padrão escuta só em 127.0.0.1.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BOARD_URL, PORT, Store, cleanId, cleanText, today } from './db.js';
import { attachEngine, tick } from './engine.js';
import { DEFAULT_SETTINGS } from './store/insights.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(SRC, '..', 'public');
const HOST = process.env.CLAUDE_TASKS_HOST || '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};
// Protege contra DNS rebinding e contra outros sites chamando a API pelo navegador.
// Para usar em rede: CLAUDE_TASKS_HOST=0.0.0.0 CLAUDE_TASKS_HOSTS=meumac.local:4317
const ALLOWED_HOSTS = new Set([
  `localhost:${PORT}`, `127.0.0.1:${PORT}`,
  ...(process.env.CLAUDE_TASKS_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
]);
const COOKIE = 'tk_session';
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime']);
const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync)
  || 'claude';

const store = new Store();
attachEngine(store);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const id = (value) => {
  try { return cleanId(value); } catch { throw new HttpError(400, 'id inválido'); }
};

const actorOf = (user) => (user ? { author: 'user', user_id: user.id } : { author: 'você' });

function requireAdmin(user) {
  if (user && user.role !== 'admin') throw new HttpError(403, 'Só administradores podem fazer isso');
}

function boardState(url, user) {
  const project_id = url.searchParams.get('project') ? id(url.searchParams.get('project')) : undefined;
  const include_archived = url.searchParams.get('archived') === '1';
  const since = new Date(Date.now() - 60 * 86400000).toISOString();
  const tasks = store.listTasks({ project_id, status: 'all', done_since: since, include_archived, limit: 5000 });
  return {
    version: store.version(),
    projects: store.listProjects(),
    tasks,
    dependencies: store.allDependencies(tasks.map((t) => t.id)),
    users: store.listUsers(),
    columns: project_id ? store.columns(project_id) : null,
    sprints: project_id ? store.sprints(project_id) : [],
    timers: store.runningTimers(user?.id),
    unread: store.unreadCount(user?.id),
    today: today(),
  };
}

// [método, padrão, handler, opções]. public: sem login. raw: corpo binário (upload).
const routes = [
  // ---- autenticação ----
  ['GET', /^\/api\/auth\/me$/, ({ user }) => ({
    user, setup: !store.hasUsers(), unread: store.unreadCount(user?.id),
  }), { public: true }],

  ['POST', /^\/api\/auth\/setup$/, ({ body, res }) => {
    if (store.hasUsers()) throw new HttpError(409, 'A conta de administrador já foi criada');
    const user = store.createUser({ ...body, role: 'admin' });
    // Notificações antigas (do modo sem contas) passam para o administrador.
    store.db.prepare('UPDATE notifications SET user_id = ? WHERE user_id IS NULL').run(user.id);
    setSession(res, store.createSession(user.id));
    return { user };
  }, { public: true }],

  ['POST', /^\/api\/auth\/login$/, ({ body, res }) => {
    const user = store.verifyLogin(body.email, body.password);
    setSession(res, store.createSession(user.id));
    return { user };
  }, { public: true }],

  ['POST', /^\/api\/auth\/logout$/, ({ req, res }) => {
    store.deleteSession(cookies(req)[COOKIE]);
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
    return { ok: true };
  }, { public: true }],

  ['GET', /^\/api\/invites\/([\w-]+)$/, ({ params }) => {
    const inv = store.validInvite(params[0]);
    return { email: inv.email, role: inv.role };
  }, { public: true }],

  ['POST', /^\/api\/invites\/([\w-]+)\/accept$/, ({ params, body, res }) => {
    const user = store.acceptInvite(params[0], body);
    setSession(res, store.createSession(user.id));
    return { user };
  }, { public: true }],

  // ---- quadro ----
  ['GET', /^\/api\/version$/, ({ user }) => ({ version: store.version(), unread: store.unreadCount(user?.id) })],
  ['GET', /^\/api\/state$/, ({ url, user }) => boardState(url, user)],

  ['GET', /^\/api\/tasks\/(\d+)$/, ({ params }) => {
    const task = store.taskWithNotes(id(params[0]));
    if (!task) throw new HttpError(404, 'Tarefa não encontrada');
    task.assignees = store.assigneesOf(task.id);
    task.sprints = store.sprints(task.project_id);
    return task;
  }],

  ['POST', /^\/api\/tasks$/, ({ body, user }) => {
    const project = body.project_id ? store.project(id(body.project_id)) : store.resolveProject({ project: body.project_name });
    if (!project) throw new HttpError(400, 'Escolha um projeto');
    return store.addTask(project.id, body, actorOf(user)).task;
  }],

  ['PATCH', /^\/api\/tasks\/(\d+)$/, ({ params, body, user }) => store.updateTask(id(params[0]), body, actorOf(user))],

  ['DELETE', /^\/api\/tasks\/(\d+)$/, ({ params }) => {
    store.deleteTask(id(params[0]));
    return { ok: true };
  }],

  ['POST', /^\/api\/tasks\/(\d+)\/notes$/, ({ params, body, user }) => {
    store.addNote(id(params[0]), body.body, actorOf(user));
    return { ok: true };
  }],

  ['POST', /^\/api\/tasks\/(\d+)\/blockers$/, ({ params, body }) => {
    store.addBlocker(id(params[0]), id(body.blocked_by));
    return { ok: true };
  }],

  ['DELETE', /^\/api\/tasks\/(\d+)\/blockers\/(\d+)$/, ({ params }) => {
    store.removeBlocker(id(params[0]), id(params[1]));
    return { ok: true };
  }],

  // ---- tempo ----
  ['POST', /^\/api\/tasks\/(\d+)\/timer$/, ({ params, body, user }) => {
    if (body.action === 'stop') store.stopTaskTimers(id(params[0]), actorOf(user));
    else store.startTimer(id(params[0]), actorOf(user));
    return { timers: store.runningTimers(user?.id) };
  }],

  ['POST', /^\/api\/tasks\/(\d+)\/time$/, ({ params, body, user }) => {
    store.logTime(id(params[0]), body, actorOf(user));
    return { ok: true };
  }],

  ['DELETE', /^\/api\/time\/(\d+)$/, ({ params }) => {
    store.deleteTimeEntry(id(params[0]));
    return { ok: true };
  }],

  // ---- anexos ----
  ['POST', /^\/api\/tasks\/(\d+)\/attachments$/, ({ params, body, req, user }) => {
    const name = decodeURIComponent(req.headers['x-filename'] || 'arquivo');
    const mime = req.headers['content-type']?.split(';')[0] || undefined;
    return store.addAttachment(id(params[0]), { name, data: body, mime: mime === 'application/octet-stream' ? undefined : mime }, actorOf(user));
  }, { raw: true }],

  ['GET', /^\/api\/attachments\/(\d+)$/, ({ params, res }) => {
    const row = store.attachment(id(params[0]));
    if (!row) throw new HttpError(404, 'Anexo não encontrado');
    const inline = INLINE_TYPES.has(row.mime);
    res.writeHead(200, {
      'content-type': row.mime,
      'content-length': row.size,
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'private, max-age=86400',
    });
    createReadStream(store.attachmentPath(row)).on('error', () => res.end()).pipe(res);
    return undefined;
  }],

  ['DELETE', /^\/api\/attachments\/(\d+)$/, ({ params }) => {
    store.deleteAttachment(id(params[0]));
    return { ok: true };
  }],

  // ---- projetos, colunas e sprints ----
  ['POST', /^\/api\/projects$/, ({ body }) => store.createProject(body.name, null, body)],
  ['PATCH', /^\/api\/projects\/(\d+)$/, ({ params, body }) => store.updateProject(id(params[0]), body)],
  ['DELETE', /^\/api\/projects\/(\d+)$/, ({ params, user }) => {
    requireAdmin(user);
    store.deleteProject(id(params[0]));
    return { ok: true };
  }],

  ['GET', /^\/api\/projects\/(\d+)\/columns$/, ({ params }) => store.columns(id(params[0]))],
  ['POST', /^\/api\/projects\/(\d+)\/columns$/, ({ params, body }) => store.createColumn(id(params[0]), body)],
  ['PATCH', /^\/api\/columns\/(\d+)$/, ({ params, body }) => store.updateColumn(id(params[0]), body)],
  ['DELETE', /^\/api\/columns\/(\d+)$/, ({ params }) => {
    store.deleteColumn(id(params[0]));
    return { ok: true };
  }],

  ['GET', /^\/api\/projects\/(\d+)\/sprints$/, ({ params }) => store.sprints(id(params[0]))],
  ['POST', /^\/api\/projects\/(\d+)\/sprints$/, ({ params, body }) => store.createSprint(id(params[0]), body)],
  ['PATCH', /^\/api\/sprints\/(\d+)$/, ({ params, body }) => store.updateSprint(id(params[0]), body)],
  ['POST', /^\/api\/sprints\/(\d+)\/start$/, ({ params }) => store.startSprint(id(params[0]))],
  ['POST', /^\/api\/sprints\/(\d+)\/complete$/, ({ params, body }) => store.completeSprint(id(params[0]), body)],
  ['DELETE', /^\/api\/sprints\/(\d+)$/, ({ params }) => {
    store.deleteSprint(id(params[0]));
    return { ok: true };
  }],

  // ---- dashboard ----
  ['GET', /^\/api\/stats$/, ({ url }) => store.stats({ project_id: url.searchParams.get('project') ? id(url.searchParams.get('project')) : undefined })],

  // ---- automações ----
  ['GET', /^\/api\/automations$/, () => store.listAutomations()],
  ['POST', /^\/api\/automations$/, ({ body, user }) => { requireAdmin(user); return store.createAutomation(body); }],
  ['PATCH', /^\/api\/automations\/(\d+)$/, ({ params, body, user }) => { requireAdmin(user); return store.updateAutomation(id(params[0]), body); }],
  ['DELETE', /^\/api\/automations\/(\d+)$/, ({ params, user }) => {
    requireAdmin(user);
    store.deleteAutomation(id(params[0]));
    return { ok: true };
  }],

  // ---- equipe ----
  ['GET', /^\/api\/users$/, () => store.listUsers()],
  ['PATCH', /^\/api\/users\/(\d+)$/, ({ params, body, user }) => store.updateUser(id(params[0]), body, user)],
  ['DELETE', /^\/api\/users\/(\d+)$/, ({ params, user }) => {
    if (user && id(params[0]) === user.id) throw new HttpError(400, 'Você não pode remover a própria conta');
    store.deleteUser(id(params[0]), user);
    return { ok: true };
  }],
  ['GET', /^\/api\/invites$/, ({ user }) => { requireAdmin(user); return store.listInvites(); }],
  ['POST', /^\/api\/invites$/, ({ body, user }) => store.createInvite(body, user)],
  ['DELETE', /^\/api\/invites\/([\w-]+)$/, ({ params, user }) => {
    store.revokeInvite(params[0], user);
    return { ok: true };
  }],

  // ---- notificações e configurações ----
  ['GET', /^\/api\/notifications$/, ({ user }) => ({ items: store.notifications(user?.id), unread: store.unreadCount(user?.id) })],
  ['POST', /^\/api\/notifications\/read$/, ({ body, user }) => {
    store.markRead(user?.id, body.ids === 'all' ? 'all' : body.ids || []);
    return { unread: store.unreadCount(user?.id) };
  }],
  ['GET', /^\/api\/settings$/, () => pickSettings(store.settings())],
  ['PATCH', /^\/api\/settings$/, ({ body, user }) => { requireAdmin(user); return pickSettings(store.updateSettings(body)); }],

  // ---- chat com o Claude ----
  ['GET', /^\/api\/chat$/, ({ user }) => ({ messages: store.chatHistory(user?.id) })],
  ['DELETE', /^\/api\/chat$/, ({ user }) => {
    store.clearChat(user?.id);
    return { ok: true };
  }],
  ['POST', /^\/api\/chat$/, (ctx) => chat(ctx)],
];

const pickSettings = (s) => Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));

// ---- chat: roda a CLI do Claude Code só com as ferramentas do MCP tarefas ----

const chatting = new Map();

function chatError(stderr, result) {
  const text = `${result || ''}\n${stderr || ''}`;
  if (/auth|login|oauth|credential|api key/i.test(text)) {
    return 'A CLI do Claude não está logada. Abra o Terminal, rode `claude` e use /login. Depois tente de novo.';
  }
  return (result || stderr || 'O Claude encerrou sem responder').trim().slice(0, 500);
}

function chat({ body, user, res }) {
  const key = user?.id ?? 0;
  if (chatting.has(key)) throw new HttpError(409, 'O Claude ainda está respondendo a mensagem anterior');
  const message = cleanText(body.message, 'message', { required: true, max: 8000 });
  const project = body.project_id ? store.project(id(body.project_id)) : null;
  const sessionKey = `chat_session:${key}`;
  const settings = store.settings();
  const mcpConfig = JSON.stringify({
    mcpServers: {
      tarefas: { command: process.execPath, args: ['--no-warnings', join(SRC, 'mcp.js')], env: { CLAUDE_TASKS_DB: store.path } },
    },
  });
  const system = [
    'Você é o assistente embutido no painel do quadro de tarefas do usuário.',
    'Use somente as ferramentas do MCP "tarefas" para consultar e alterar o quadro. Execute as ações pedidas em vez de só sugerir.',
    `Hoje é ${today()}.${user ? ` Quem está falando: ${user.name} <${user.email}>.` : ''}`,
    project
      ? `O usuário está olhando o projeto "${project.name}" (id ${project.id}${project.path ? `, project_path ${project.path}` : ''}). Use esse projeto quando ele não disser outro.`
      : 'O usuário está na visão de todos os projetos.',
    'Responda em português do Brasil, curto e direto. Cite tarefas como #id.',
  ].join('\n');
  const args = [
    '-p', message, '--output-format', 'stream-json', '--verbose', '--model', String(settings.chat_model || 'sonnet'),
    '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__tarefas',
    '--append-system-prompt', system,
  ];
  if (settings[sessionKey]) args.push('--resume', settings[sessionKey]);

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const write = (o) => { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };

  const child = spawn(CLAUDE_BIN, args, { cwd: dirname(store.path), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  chatting.set(key, child);
  let text = '';
  let stderr = '';
  let sessionId = null;
  let failure = null;
  const tools = [];

  createInterface({ input: child.stdout }).on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id) sessionId = ev.session_id;
    // Mensagens "<synthetic>" são erros da própria CLI (ex.: login expirado), não respostas.
    if (ev.type === 'assistant' && ev.message?.model !== '<synthetic>') {
      for (const block of ev.message?.content || []) {
        if (block.type === 'text' && block.text.trim()) {
          text += `${text ? '\n\n' : ''}${block.text}`;
          write({ type: 'text', text: block.text });
        }
        if (block.type === 'tool_use') {
          const name = block.name.replace(/^mcp__tarefas__/, '');
          tools.push(name);
          write({ type: 'tool', name });
        }
      }
    }
    if (ev.type === 'result' && ev.is_error) failure = ev.result || ev.subtype;
  });
  child.stderr.on('data', (c) => { stderr += c; });
  res.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });

  child.on('error', (e) => {
    chatting.delete(key);
    write({ type: 'error', message: e.code === 'ENOENT' ? 'Não encontrei a CLI do Claude (defina CLAUDE_BIN).' : e.message });
    res.end();
  });
  child.on('close', (code) => {
    chatting.delete(key);
    const failed = failure || (code !== 0 && !text);
    if (failed) write({ type: 'error', message: chatError(stderr, failure) });
    if (!failed || text || tools.length) {
      if (sessionId) store.updateSettings({ [sessionKey]: sessionId });
      store.addChatMessage(user?.id, 'user', message);
      store.addChatMessage(user?.id, 'assistant', text || 'Feito.', tools);
    }
    write({ type: 'done' });
    res.end();
  });
  return undefined;
}

// ---- HTTP ----

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function setSession(res, token) {
  res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; Max-Age=${90 * 86400}; HttpOnly; SameSite=Lax`);
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

async function api(req, res, url) {
  const user = store.sessionUser(cookies(req)[COOKIE]);
  for (const [method, pattern, handler, opts = {}] of routes) {
    const match = req.method === method && url.pathname.match(pattern);
    if (!match) continue;
    if (req.method !== 'GET') {
      const origin = req.headers.origin?.replace(/^https?:\/\//, '');
      if (origin && !ALLOWED_HOSTS.has(origin)) throw new HttpError(403, 'Origem não permitida');
      if (opts.raw && !origin) throw new HttpError(403, 'Origem ausente');
      if (!opts.raw && req.method !== 'DELETE' && !req.headers['content-type']?.includes('application/json')) {
        throw new HttpError(415, 'Use application/json');
      }
    }
    if (!opts.public && !user) throw new HttpError(401, store.hasUsers() ? 'Faça login' : 'Crie a conta de administrador');
    let body = {};
    if (method === 'POST' || method === 'PATCH') {
      const raw = await readBody(req, opts.raw ? 26 * 1024 * 1024 : 1_000_000);
      if (opts.raw) body = raw;
      else {
        try { body = raw.length ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON inválido'); }
      }
    }
    const result = await handler({ req, res, url, params: match.slice(1), body, user });
    if (result !== undefined) json(res, 200, result);
    return;
  }
  throw new HttpError(404, 'Rota não encontrada');
}

async function staticFile(res, url) {
  const file = normalize(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
  if (file.startsWith('..') || !TYPES[extname(file)]) throw new HttpError(404, 'Não encontrado');
  const data = await readFile(join(PUBLIC, file)).catch(() => { throw new HttpError(404, 'Não encontrado'); });
  res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache' });
  res.end(data);
}

const server = createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(req.headers.host)) throw new HttpError(403, 'Host não permitido');
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else await staticFile(res, url);
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

// Avisos de prazo e automações por tempo.
const safeTick = () => { try { tick(store); } catch (e) { console.error('tick:', e); } };
setTimeout(safeTick, 5000);
setInterval(safeTick, 60000);

