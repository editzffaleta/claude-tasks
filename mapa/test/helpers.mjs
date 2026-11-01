// Funções comuns dos testes: criam um projeto descartável no disco, rodam os scripts da skill nele e
// leem o que eles gravaram. Cada projeto fica na pasta temporária do sistema e é apagado no final.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILL = path.join(REPO, 'skills', 'mapa-do-codigo');
export const lib = (name) => import(new URL(`../skills/mapa-do-codigo/scripts/lib/${name}`, import.meta.url));
/** As fixtures dos testes (mapa/test/fixtures). */
export const FIXTURES = path.join(REPO, 'test', 'fixtures');
/** A pasta que o mapa cria dentro do projeto, e os nomes dos arquivos que ele grava nela. */
export const MAP = 'mapa-do-codigo';
export const FILES = {
  arch: 'arquitetura.json', plan: 'plano.json', graph: 'grafo.json', descriptions: 'descricoes',
  recent: 'trabalho-recente.json', flows: 'fluxos-pedidos.json', page: 'index.html', artifact: 'artefato.html',
  server: 'servidor.mjs', serverCore: 'servidor-nucleo.mjs', query: 'consulta.mjs',
};
/** Um caminho dentro da pasta do mapa de um projeto: mapPath(root, FILES.graph). */
export const mapPath = (root, ...parts) => path.join(root, MAP, ...parts);

/**
 * Grava `files` ({ 'caminho/relativo': 'conteúdo' }) numa pasta temporária nova. Cada pasta em `repos`
 * vira um repositório git próprio, como um frontend e um backend lado a lado. Devolve a pasta.
 */
export function makeProject(files, { repos = [], arch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapa-teste-'));
  for (const [p, src] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), src);
  }
  for (const r of repos) execFileSync('git', ['init', '-q', path.join(root, r)]);
  if (arch) writeJson(mapPath(root, FILES.arch), arch);
  return root;
}

/** Roda um dos scripts da skill (scan.mjs, build.mjs, …) num projeto e devolve o que ele imprimiu. */
export function run(script, root, ...args) {
  return execFileSync(process.execPath, [path.join(SKILL, 'scripts', script), root, ...args], { encoding: 'utf8', stdio: 'pipe' });
}

/** scan + build, do jeito que a skill faz um primeiro mapa (sem mexer no CLAUDE.local.md). */
export function scanAndBuild(root) {
  return run('scan.mjs', root) + run('build.mjs', root, '--no-claude-md');
}

export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2)); };
export const readGraph = (root) => readJson(mapPath(root, FILES.graph));
export const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

/** Todos os arquivos dentro de uma pasta, como { path, text }. */
export function allFiles(dir) {
  return fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => { const p = path.join(e.parentPath ?? e.path, e.name); return { path: p, text: fs.readFileSync(p, 'utf8') }; });
}

/** "MÉTODO /caminho" de cada endpoint do mapa. */
export const routeKeys = (graph) => graph.routes.map((r) => `${r.m} ${r.p}`).sort();

/** "MÉTODO /caminho" de cada endpoint que a Saúde aponta como aberto a qualquer pessoa. */
export function openEndpoints(graph) {
  return graph.health.issues
    .filter((i) => i.kind === 'unprotected-endpoint')
    .flatMap((i) => i.items.filter((id) => id.startsWith('r:')).map((id) => graph.routes[+id.slice(2)]))
    .map((r) => `${r.m} ${r.p}`)
    .sort();
}

// Uma senha falsa para o app de exemplo. Ela é montada na hora, para nenhum texto com cara de segredo
// ser commitado neste repositório, e os testes conferem que ela nunca chega a nada que o Mapa do código grava.
export const FAKE_PASSWORD = ['correct', 'horse', 'battery', 'staple', '42'].join('-');

/**
 * Uma lojinha: uma API em Express e um site, em dois repositórios. Tem endpoints protegidos de três jeitos
 * (middleware na rota, uma verificação onde o router é montado, nenhuma), requisições do site entre
 * repositórios e uma senha escrita no código.
 */
export function shopApp() {
  const files = {
    'shop-api/package.json': JSON.stringify({ name: 'shop-api', type: 'module', dependencies: { express: '^4.19.0' } }),
    'shop-api/server.js': [
      `import express from 'express';`,
      `import orders from './routes/orders.js';`,
      `import admin from './routes/admin.js';`,
      `import notes from './routes/notes.js';`,
      `import { requireStaff } from './auth.js';`,
      ``,
      `const app = express();`,
      `app.use('/api', orders);`,
      `app.use('/admin', requireStaff, admin);`,
      `app.use('/api', notes);`,
      `app.listen(3000);`,
    ].join('\n'),
    'shop-api/auth.js': [
      `/** Rejects requests without a signed-in customer. */`,
      `export function requireAuth(req, res, next) { if (!req.headers.authorization) return res.status(401).end(); next(); }`,
      `/** Rejects requests that aren't from staff. */`,
      `export function requireStaff(req, res, next) { if (!req.user?.staff) return res.status(403).end(); next(); }`,
    ].join('\n'),
    'shop-api/config.js': `export const DB_PASSWORD = "${FAKE_PASSWORD}";\nexport const PORT = 3000;\n`,
    'shop-api/routes/orders.js': [
      `import { Router } from 'express';`,
      `import { requireAuth } from '../auth.js';`,
      `import { DB_PASSWORD } from '../config.js';`,
      ``,
      `const router = Router();`,
      `/** Every order for the signed-in customer. */`,
      `router.get('/orders', requireAuth, async (req, res) => { res.json([]); });`,
      `router.post('/orders/:id/refund', requireAuth, async (req, res) => { res.json({ ok: !!DB_PASSWORD }); });`,
      `export default router;`,
    ].join('\n'),
    'shop-api/routes/admin.js': [
      `import { Router } from 'express';`,
      `const router = Router();`,
      `router.delete('/users/:id', async (req, res) => { res.status(204).end(); });`,
      `export default router;`,
    ].join('\n'),
    'shop-api/routes/notes.js': [
      `import { Router } from 'express';`,
      `const router = Router();`,
      `router.post('/notes', async (req, res) => { res.json({ saved: true }); });`,
      `export default router;`,
    ].join('\n'),
    'shop-web/package.json': JSON.stringify({ name: 'shop-web', type: 'module', dependencies: { react: '^18.3.0' } }),
    'shop-web/src/api.js': [
      `export const listOrders = () => fetch('/api/orders').then((r) => r.json());`,
      'export const refund = (id) => fetch(`/api/orders/${id}/refund`, { method: \'POST\' });',
    ].join('\n'),
    'shop-web/src/App.jsx': [
      `import { listOrders, refund } from './api.js';`,
      `export default function App() { return <button onClick={() => listOrders().then((o) => refund(o[0].id))}>Refund</button>; }`,
    ].join('\n'),
  };
  const arch = {
    project: { name: 'Loja', summary: 'Uma loja de exemplo.' },
    nodes: [
      { id: 'api', label: 'Servidor', kind: 'service', summary: 'O servidor da loja.', paths: ['shop-api/**'] },
      { id: 'web', label: 'Site', kind: 'ui', summary: 'O site da loja.', paths: ['shop-web/**'] },
    ],
  };
  return makeProject(files, { repos: ['shop-api', 'shop-web'], arch });
}
