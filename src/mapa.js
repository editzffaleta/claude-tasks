// Mapa do código dentro do quadro: serve o mapa gerado na pasta de cada projeto
// (mapa-do-codigo/, feito pelo plugin em mapa/) e a API dele, com o login e as permissões do quadro.
// O núcleo do servidor do mapa é o mesmo do servidor autônomo (servidor-nucleo.mjs).
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLAUDE_BIN } from './chat.js';

export const MAP_DIR = 'mapa-do-codigo';
export const SKILL_DIR = fileURLToPath(new URL('../mapa/skills/mapa-do-codigo', import.meta.url));
const NUCLEO = new URL('../mapa/skills/mapa-do-codigo/assets/servidor-nucleo.mjs', import.meta.url);

const servers = new Map(); // project_id → { root, core }

// O código de consulta sempre vem do plugin (nunca do consulta.mjs gravado na pasta do projeto):
// a pasta de um projeto pode ter vindo de qualquer lugar, e o quadro roda com a sua conta.
const asset = (name) => readFileSync(join(SKILL_DIR, 'assets', name), 'utf8');
const querySource = () => asset('graph-query.js');
let consultaFile = null;
function consultaScript() {
  const src = `${querySource()}\n// ---- cli ----\n${asset('query-cli.mjs')}`;
  const file = join(tmpdir(), `claude-tasks-consulta-${createHash('sha1').update(src).digest('hex').slice(0, 12)}.mjs`);
  if (consultaFile !== file || !existsSync(file)) {
    writeFileSync(file, src);
    consultaFile = file;
  }
  return file;
}
const graphs = new Map(); // caminho do grafo.json → { mtime, graph }

const mapDirOf = (project) => (project?.path ? join(project.path, MAP_DIR) : null);

function readGraph(project) {
  const dir = mapDirOf(project);
  if (!dir) return null;
  const file = join(dir, 'grafo.json');
  let mtime;
  try { mtime = statSync(file).mtimeMs; } catch { return null; }
  const cached = graphs.get(file);
  if (cached?.mtime === mtime) return cached.graph;
  try {
    const graph = JSON.parse(readFileSync(file, 'utf8'));
    graphs.set(file, { mtime, graph });
    return graph;
  } catch {
    return null;
  }
}

// Resumo para o painel e o MCP: existe mapa? quando foi feito, por quem, quantos problemas.
export function mapStatus(project) {
  if (!project?.path) return { available: false, exists: false, reason: 'Este projeto não tem pasta no computador' };
  if (!existsSync(project.path)) return { available: false, exists: false, reason: `A pasta ${project.path} não existe neste computador` };
  const dir = mapDirOf(project);
  const exists = existsSync(join(dir, 'index.html'));
  const g = exists ? readGraph(project) : null;
  const issues = g?.health?.issues || [];
  return {
    available: true,
    exists,
    folder: dir,
    generated_at: g?.meta?.generatedAt || null,
    agent: g?.meta?.agent || null,
    blueprint: !!g?.meta?.blueprint,
    files: g?.meta?.counts?.files ?? null,
    parts: g?.nodes?.filter((n) => !n.parent).length ?? null,
    screens: g?.screens?.length ?? null,
    endpoints: g?.routes?.length ?? null,
    health: { total: issues.length, high: issues.filter((i) => i.severity === 'high').length },
    recent: g?.recent?.items?.length ?? 0,
  };
}

// ---- tarefas ligadas aos arquivos do mapa ----

// Trechos que parecem caminhos de arquivo ("src/db.js", "db.js:120", `web/app/page.tsx`).
const PATH_RE = /[\w@.~-]+(?:\/[\w@.~-]+)*\.[a-z0-9]{1,6}\b/gi;

function filesMentioned(text, files, byBase) {
  const found = new Set();
  for (const raw of String(text || '').match(PATH_RE) || []) {
    const token = raw.replace(/^\.?\//, '').toLowerCase();
    if (token.includes('/')) {
      for (const f of files) if (f.lower === token || f.lower.endsWith(`/${token}`)) found.add(f.p);
    } else {
      // Só o nome do arquivo: liga quando não há ambiguidade.
      const same = byBase.get(token);
      if (same?.length === 1) found.add(same[0]);
    }
  }
  return [...found];
}

export function tasksOnMap(store, project) {
  const g = readGraph(project);
  const files = (g?.files || []).map((f) => ({ p: f.p, lower: String(f.p).toLowerCase() }));
  const byBase = new Map();
  for (const f of files) {
    const base = f.lower.split('/').pop();
    byBase.set(base, [...(byBase.get(base) || []), f.p]);
  }
  const since = new Date(Date.now() - 14 * 86400000).toISOString();
  return store.listTasks({ project_id: project.id, status: 'all', done_since: since, limit: 2000 })
    .map((t) => {
      // Tarefas criadas a partir de um cartão (ou de uma peça da planta) ficam presas a ele.
      const origin = t.external_source === 'mapa' ? String(t.external_id || '').match(/^(card|construir):(.+?)(?:#\d+)?$/) : null;
      return {
        id: t.id, ref: t.ref || `#${t.id}`, title: t.title, status: t.status, priority: t.priority, done: t.status === 'done',
        files: filesMentioned(`${t.title}\n${t.description}`, files, byBase),
        cards: origin ? [origin[2]] : [],
      };
    })
    .filter((t) => t.files.length || t.cards.length);
}

// Tarefa criada a partir do mapa (problema da Saúde, item da revisão da planta, peça a construir
// ou um cartão). A origem evita duplicar: o mesmo problema vira uma tarefa só.
export function taskFromMap(store, project, body, actor) {
  const kind = ['saude', 'revisao', 'construir', 'card'].includes(body?.origin?.kind) ? body.origin.kind : 'card';
  const originId = String(body?.origin?.id ?? '').slice(0, 300);
  // Problemas da Saúde, itens da revisão e peças a construir viram uma tarefa só; sobre um
  // cartão qualquer dá para criar várias (cada uma ganha um sufixo próprio).
  const unique = kind !== 'card';
  const external_id = originId ? `${kind}:${originId}${unique ? '' : `#${Date.now()}`}` : null;
  if (external_id && unique) {
    const existing = store.db.prepare("SELECT id FROM tasks WHERE project_id = ? AND external_source = 'mapa' AND external_id = ?").get(project.id, external_id);
    if (existing) return { task: summary(store.task(existing.id)), duplicate: true };
  }
  const tags = Array.isArray(body.tags) ? body.tags.map(String).slice(0, 6) : [];
  const { task, duplicate } = store.addTask(project.id, {
    title: String(body.title || '').slice(0, 300),
    description: String(body.description || ''),
    priority: ['urgent', 'high', 'medium', 'low', 'lowest'].includes(body.priority) ? body.priority : 'medium',
    // Só problemas importantes da Saúde viram bug; avisos menores são tarefas comuns.
    type: kind === 'saude' && body.priority === 'high' ? 'bug' : 'task',
    tags: [...new Set(['mapa', ...tags])],
    ...(external_id ? { external_source: 'mapa', external_id } : {}),
  }, actor);
  return { task: summary(task), duplicate };
}

const summary = (t) => ({ id: t.id, ref: t.ref || `#${t.id}`, title: t.title, status: t.status });

// ---- servidor do mapa por projeto ----

async function coreFor(project) {
  const cached = servers.get(project.id);
  if (cached && cached.root === project.path) return cached.core;
  cached?.core.close?.();
  const { createMapServer } = await import(NUCLEO);
  // Log só de erros: o quadro já registra o que importa.
  const log = { log: () => {}, error: (...a) => console.error('mapa:', ...a) };
  const core = createMapServer({
    root: project.path, mapDir: mapDirOf(project), skillDir: SKILL_DIR, log, onIdle: () => {},
    // Mesma CLI do Claude que o chat do painel usa (o PATH do launchd é mínimo).
    claudePath: process.env.FLOORPLAN_CLAUDE || CLAUDE_BIN,
    querySource: querySource(),
  });
  servers.set(project.id, { root: project.path, core });
  return core;
}

export function closeMapServers() {
  for (const { core } of servers.values()) core.close?.();
  servers.clear();
}

// Consulta ao mapa (MCP e API): a consulta do plugin lendo o grafo.json do projeto.
export function queryMap(project, args) {
  const dir = mapDirOf(project);
  if (!dir || !existsSync(join(dir, 'grafo.json'))) return Promise.reject(new Error('Este projeto ainda não tem mapa do código'));
  return new Promise((resolve, reject) => {
    const env = { ...process.env, MAPA_GRAFO_DIR: dir };
    execFile(process.execPath, ['--no-warnings', consultaScript(), ...args.map(String)], { cwd: project.path, env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) reject(new Error((stderr || err.message).trim().slice(0, 500)));
      else resolve(stdout.trim());
    });
  });
}

// ---- rota /mapa/<id>/… ----

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  // O painel mostra o mapa num iframe da mesma origem.
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'same-origin',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function emptyPage(res, title, text) {
  res.writeHead(404, PAGE_HEADERS);
  res.end(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f6f4;color:#1c1b19}
@media (prefers-color-scheme:dark){body{background:#0e0e10;color:#ededee}}div{max-width:460px;padding:24px;text-align:center}</style>
</head><body><div><h2>${title}</h2><p>${text}</p></div></body></html>`);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 2_000_000) throw Object.assign(new Error('Corpo grande demais'), { status: 413 });
    chunks.push(c);
  }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; } catch { throw Object.assign(new Error('JSON inválido'), { status: 400 }); }
}

// Trata /mapa/<id>[/…]. Devolve false se o caminho não é do mapa.
export async function handleMapRoute({ store, req, res, url, user, originAllowed }) {
  const m = url.pathname.match(/^\/mapa\/(\d+)(\/.*)?$/);
  if (!m) return false;
  if (!user) {
    res.writeHead(302, { location: '/' });
    res.end();
    return true;
  }
  if (!m[2]) {
    res.writeHead(301, { location: `/mapa/${m[1]}/` });
    res.end();
    return true;
  }
  const project = store.project(Number(m[1]));
  if (!project || !store.can(user, project, 'read')) {
    emptyPage(res, 'Mapa não encontrado', 'Este projeto não existe ou você não tem acesso a ele.');
    return true;
  }
  const status = mapStatus(project);
  const sub = m[2].slice(1);
  const canEdit = store.can(user, project, 'edit');
  const canManage = store.can(user, project, 'manage');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin?.replace(/^https?:\/\//, '');
    if (!origin || !originAllowed(origin)) return sendJson(res, 403, { error: 'Origem não permitida' }), true;
  }

  // Endpoints do quadro usados pela página do mapa.
  if (sub === 'api/quadro/tarefas') {
    if (req.method === 'GET') return sendJson(res, 200, { tasks: tasksOnMap(store, project) }), true;
    if (req.method === 'POST') {
      if (!canEdit) return sendJson(res, 403, { error: 'Criar tarefas exige permissão de edição no projeto' }), true;
      let body;
      try { body = await readJson(req); } catch (e) { return sendJson(res, e.status || 400, { error: e.message }), true; }
      if (!String(body.title || '').trim()) return sendJson(res, 400, { error: 'Informe o título da tarefa' }), true;
      try {
        return sendJson(res, 200, taskFromMap(store, project, body, { author: 'user', user_id: user.id })), true;
      } catch (e) {
        return sendJson(res, e.status || 400, { error: e.message }), true;
      }
    }
    return sendJson(res, 405, { error: 'Método não permitido' }), true;
  }

  if (!status.available) {
    emptyPage(res, 'Sem pasta', status.reason);
    return true;
  }
  if (!status.exists) {
    if (sub.startsWith('api/')) return sendJson(res, 404, { error: 'Este projeto ainda não tem mapa do código' }), true;
    emptyPage(res, 'Ainda não há mapa', 'Peça ao Claude Code (ou ao Codex), na pasta do projeto: “faça o mapa do código deste projeto”.');
    return true;
  }

  const core = await coreFor(project);
  if (sub === '' || sub === 'index.html') {
    const board = { projectId: project.id, projectName: project.name, canEdit, canManage };
    let html;
    try {
      html = core.page({ board, ...(canManage ? {} : { change: false }) });
    } catch (e) {
      if (e.code !== 'no_map') throw e;
      emptyPage(res, 'Ainda não há mapa', 'Peça ao Claude Code (ou ao Codex), na pasta do projeto: “faça o mapa do código deste projeto”.');
      return true;
    }
    res.writeHead(200, PAGE_HEADERS);
    res.end(req.method === 'HEAD' ? undefined : html);
    return true;
  }
  if (sub.startsWith('api/')) {
    // Visualizadores só olham; perguntar roda a IA na pasta do projeto (conta de quem mantém o quadro).
    const handled = await core.handle(req, res, sub.slice(4), {
      allowAsk: canEdit && user.role !== 'viewer',
      allowChange: canManage,
      allowFlows: canEdit,
      user: user.id,
    });
    if (!handled && !res.headersSent) sendJson(res, 404, { error: 'Rota do mapa não encontrada' });
    return true;
  }
  emptyPage(res, 'Não encontrado', 'Esse endereço do mapa não existe.');
  return true;
}
