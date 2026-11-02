#!/usr/bin/env node
// Sobe um quadro de demonstração, com projetos, pessoas e tarefas fictícios, para testar o painel sem
// tocar no seu quadro e para tirar as fotos do README (scripts/fotos.mjs).
//
//   node scripts/demo.mjs [--porta 4395]
//
// O banco fica numa pasta temporária, apagada no Ctrl+C. O endereço, o e-mail e o arquivo com a senha
// (gerada na hora) aparecem no terminal. O projeto "Quadro de Tarefas" usa o mapa do código deste
// repositório, se ele existir (mapa-do-codigo/), com uma simulação de demonstração.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const PORT = Number(args[args.indexOf('--porta') + 1]) || 4395;
const BASE = `http://localhost:${PORT}`;
const DIR = mkdtempSync(join(tmpdir(), 'quadro-demo-'));
const DB = join(DIR, 'tarefas.db');
const SECRET = join(DIR, 'senha.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, ['--no-warnings', join(ROOT, 'src/server.js')], {
  env: { ...process.env, CLAUDE_TASKS_DB: DB, CLAUDE_TASKS_PORT: String(PORT), CLAUDE_TASKS_HOSTS: '*', CLAUDE_TASKS_NO_OS_NOTIFY: '1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stop = () => { server.kill(); rmSync(DIR, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (let i = 0; i < 80; i++) {
  try { await fetch(`${BASE}/api/auth/me`); break; } catch { await sleep(150); }
}

const jar = {};
async function api(path, { as = 'ana', method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', origin: BASE, ...(jar[as] ? { cookie: jar[as] } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const cookie = res.headers.get('set-cookie');
  if (cookie && !cookie.includes('Max-Age=0')) jar[as] = cookie.split(';')[0];
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

const today = new Date();
today.setHours(12, 0, 0, 0);
const d = (n) => { const x = new Date(today); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
const password = randomBytes(12).toString('hex');
writeFileSync(SECRET, password, { mode: 0o600 });

// ---- pessoas, organização e projetos ----
await api('/api/auth/setup', { method: 'POST', body: { name: 'Ana Souza', email: 'ana@exemplo.test', password } });
const P = { ana: (await api('/api/auth/me')).user.id };
for (const [key, name] of [['carlos', 'Carlos Lima'], ['bia', 'Beatriz Rocha'], ['diego', 'Diego Martins']]) {
  const user = await api('/api/users', { method: 'POST', body: { name, email: `${key}@exemplo.test`, password, role: 'member' } });
  P[key] = user.id ?? user.user?.id;
  await api('/api/auth/login', { as: key, method: 'POST', body: { email: `${key}@exemplo.test`, password } });
}
await api('/api/organizations/1', { method: 'PATCH', body: { name: 'Estúdio Aurora', description: 'Produtos digitais' } }).catch(() => {});

const projects = {};
for (const [key, name, prefix, color, description] of [
  ['loja', 'Loja Online', 'LOJ', '#e0805f', 'Loja virtual de roupas: catálogo, carrinho, checkout e pedidos.'],
  ['ent', 'App de Entregas', 'ENT', '#5b8def', 'App do entregador e do cliente para acompanhar entregas.'],
  ['site', 'Site Institucional', 'SIT', '#3fb68b', 'Site da empresa, blog e páginas de contato.'],
  ['qt', 'Quadro de Tarefas', 'QT', '#a274e8', 'Este quadro: painel, MCP e Mapa do código.'],
]) {
  const project = await api('/api/projects', { method: 'POST', body: { name, color, description } });
  await api(`/api/projects/${project.id}`, { method: 'PATCH', body: { key: prefix, status: 'active' } });
  projects[key] = project.id;
  for (const who of ['carlos', 'bia', 'diego']) {
    await api(`/api/projects/${project.id}/members`, { method: 'POST', body: { user_id: P[who], role: 'member' } }).catch(() => {});
  }
}
const sprint = await api(`/api/projects/${projects.loja}/sprints`, { method: 'POST', body: { name: 'Sprint 12', goal: 'Checkout novo no ar', start_date: d(-5), end_date: d(9) } });
await api(`/api/sprints/${sprint.id}/start`, { method: 'POST', body: {} });

// ---- tarefas ----
const byClaude = [];
const ids = {};
async function task(project, spec) {
  const { as = 'ana', claude, key, logs = [], notes = [], subtasks = [], ...body } = spec;
  const created = await api('/api/tasks', { as, method: 'POST', body: { project_id: projects[project], ...body } });
  if (key) ids[key] = created.id;
  if (claude) byClaude.push(created.id);
  for (const sub of subtasks) await api('/api/tasks', { method: 'POST', body: { project_id: projects[project], parent_id: created.id, ...sub } });
  for (const [who, minutes, day, note] of logs) await api(`/api/tasks/${created.id}/time`, { as: who, method: 'POST', body: { minutes, date: d(day), note } });
  for (const [who, text] of notes) await api(`/api/tasks/${created.id}/notes`, { as: who, method: 'POST', body: { body: text } });
  return created;
}

await task('loja', { key: 'pix', title: 'Integração com o Pix', status: 'doing', priority: 'high', type: 'story', tags: ['pagamento', 'backend'], assignee_ids: [P.carlos], story_points: 5, sprint_id: sprint.id, start_date: d(-3), due_date: d(4), estimate: '12h', logs: [['carlos', 210, -2, 'QR code e webhook de confirmação'], ['carlos', 95, -1, 'testes com o sandbox do banco']] });
await task('loja', {
  title: 'Checkout em uma página', status: 'doing', priority: 'urgent', type: 'story', tags: ['checkout', 'ui'], assignee_ids: [P.ana, P.bia], story_points: 8, sprint_id: sprint.id, start_date: d(-4), due_date: d(2), estimate: '16h',
  description: 'Juntar endereço, frete e pagamento numa página só, com o resumo do pedido sempre visível.\n\n- [x] layout no celular\n- [x] cálculo do frete ao digitar o CEP\n- [ ] pagamento com cartão e Pix',
  subtasks: [{ title: 'Layout no celular', status: 'done' }, { title: 'Frete ao digitar o CEP', status: 'done' }, { title: 'Pagamento com cartão e Pix', status: 'doing' }],
  logs: [['ana', 180, -3, 'layout e validações'], ['bia', 140, -1, 'componente de endereço']],
  notes: [['bia', 'Testei no iPhone: o botão de pagar fica escondido pelo teclado quando o campo do CVV está aberto.'], ['ana', '@Beatriz ajustei o layout para o botão subir junto com o teclado. Pode testar de novo?']],
});
await task('loja', { title: 'Nota fiscal automática', status: 'todo', priority: 'high', tags: ['backend', 'fiscal'], assignee_ids: [P.diego], story_points: 5, sprint_id: sprint.id, start_date: d(4), due_date: d(9), blocked_by: [ids.pix] });
await task('loja', { title: 'Cupom de desconto no carrinho', status: 'todo', priority: 'high', type: 'story', tags: ['checkout', 'ui'], assignee_ids: [P.carlos], story_points: 3, sprint_id: sprint.id, start_date: d(2), due_date: d(6) });
await task('loja', { title: 'Página de rastreio do pedido', status: 'todo', priority: 'medium', tags: ['ui'], assignee_ids: [P.bia], story_points: 3, sprint_id: sprint.id, start_date: d(3), due_date: d(8) });
await task('loja', { title: 'Atualizar os banners da campanha de fim de ano', status: 'todo', priority: 'medium', tags: ['marketing'], assignee_ids: [P.diego], due_date: d(-2) });
await task('loja', { title: 'Revisar os textos da página de trocas', status: 'todo', priority: 'low', tags: ['conteúdo'], assignee_ids: [P.diego], due_date: d(12) });
await task('loja', { claude: true, title: 'Validar o CEP antes de calcular o frete', status: 'todo', priority: 'high', type: 'bug', tags: ['bug', 'frete'], description: 'Encontrado ao revisar `src/frete.js`: um CEP com 7 dígitos chega à API dos Correios e o checkout trava em "Calculando frete…". Validar no front e no back.', due_date: d(3) });
await task('loja', { claude: true, title: 'Cobrir o checkout com testes de ponta a ponta', status: 'todo', priority: 'medium', tags: ['testes'], description: 'Follow-up do checkout em uma página: cenários de cartão recusado, Pix expirado e cupom inválido.' });
await task('loja', { title: 'Busca com filtros por tamanho e cor', status: 'done', priority: 'medium', tags: ['catálogo'], assignee_ids: [P.bia], story_points: 5, sprint_id: sprint.id });
await task('loja', { title: 'Login com Google', status: 'done', priority: 'medium', tags: ['conta'], assignee_ids: [P.carlos], story_points: 2, sprint_id: sprint.id });
await task('loja', { title: 'Total do frete errado para CEPs do Norte', status: 'done', priority: 'high', type: 'bug', tags: ['bug', 'frete'], assignee_ids: [P.ana], story_points: 2, sprint_id: sprint.id });

await task('ent', { key: 'mapa', title: 'Posição do entregador em tempo real', status: 'doing', priority: 'high', type: 'story', tags: ['mapa', 'mobile'], assignee_ids: [P.diego], start_date: d(-6), due_date: d(5), logs: [['diego', 240, -2, 'WebSocket e atualização no mapa']] });
await task('ent', { claude: true, title: 'Travamento no Android 12 ao abrir a câmera', status: 'doing', priority: 'urgent', type: 'bug', tags: ['bug', 'android'], assignee_ids: [P.carlos], description: 'A permissão da câmera é pedida duas vezes e o app fecha. Visto ao rodar os testes no emulador com Android 12.', due_date: d(1) });
await task('ent', { title: 'Notificação quando o pedido sair para entrega', status: 'todo', priority: 'medium', tags: ['push'], assignee_ids: [P.bia], start_date: d(5), due_date: d(10), blocked_by: [ids.mapa] });
await task('ent', { title: 'Rota otimizada com várias paradas', status: 'todo', priority: 'high', tags: ['mapa'], assignee_ids: [P.diego], start_date: d(6), due_date: d(16) });
await task('ent', { title: 'Tela de avaliação da entrega', status: 'todo', priority: 'low', tags: ['ui'], assignee_ids: [P.bia], due_date: d(14) });
await task('ent', { title: 'Modo offline para o entregador', status: 'blocked', priority: 'medium', tags: ['mobile'], description: 'Esperando a definição de quanto tempo os pedidos ficam guardados no aparelho.' });
await task('ent', { title: 'Assinatura de quem recebe', status: 'done', priority: 'medium', tags: ['mobile'], assignee_ids: [P.carlos] });

await task('site', { title: 'Formulário de contato com proteção contra spam', status: 'doing', priority: 'medium', tags: ['formulário'], assignee_ids: [P.bia], start_date: d(-1), due_date: d(3) });
await task('site', { title: 'Política de privacidade revisada', status: 'todo', priority: 'high', tags: ['jurídico'], assignee_ids: [P.ana], due_date: d(1) });
await task('site', { title: 'Blog com posts em Markdown', status: 'todo', priority: 'medium', tags: ['blog'], assignee_ids: [P.carlos], start_date: d(4), due_date: d(15) });
await task('site', { claude: true, title: 'Melhorar a nota do Lighthouse para 95', status: 'todo', priority: 'low', tags: ['desempenho'], description: 'As imagens da página inicial não têm largura e altura definidas e somam 2,4 MB. Converter para WebP e definir os tamanhos.' });
await task('site', { title: 'Nova página Sobre nós', status: 'done', priority: 'medium', tags: ['conteúdo'], assignee_ids: [P.diego] });

await task('qt', { claude: true, title: 'Exportar o Gantt como imagem', status: 'todo', priority: 'low', tags: ['gantt'], description: 'Sugestão feita ao terminar as dependências no Gantt.' });
await task('qt', { title: 'Tema de alto contraste', status: 'todo', priority: 'medium', tags: ['acessibilidade', 'ui'], assignee_ids: [P.bia], due_date: d(20) });
await task('qt', { title: 'Atalho para mover a tarefa entre colunas', status: 'doing', priority: 'medium', tags: ['ui'], assignee_ids: [P.ana], start_date: d(-1), due_date: d(4) });

// Tarefas já concluídas, para o Dashboard ter oito semanas de história.
for (const [project, title, priority, type] of [
  ['loja', 'Carrinho salvo entre dispositivos', 'medium', 'task'], ['loja', 'Foto do produto com zoom', 'low', 'task'],
  ['loja', 'Erro 500 ao aplicar dois cupons', 'high', 'bug'], ['loja', 'Avise-me quando chegar', 'medium', 'story'],
  ['loja', 'Lista de desejos', 'medium', 'story'], ['ent', 'Login por código no celular', 'high', 'story'],
  ['ent', 'Histórico de entregas do entregador', 'medium', 'task'], ['ent', 'GPS impreciso em prédios altos', 'high', 'bug'],
  ['ent', 'Ícones novos do app', 'low', 'task'], ['site', 'Página de vagas', 'medium', 'task'],
  ['site', 'Mapa da loja física no rodapé', 'low', 'task'], ['qt', 'Notificações por e-mail', 'medium', 'story'],
  ['qt', 'Busca universal com ⌘K', 'high', 'story'], ['qt', 'Importar do Trello', 'medium', 'task'],
  ['loja', 'Frete grátis acima de R$ 299', 'medium', 'story'], ['ent', 'Tela de primeiro acesso', 'low', 'task'],
]) await task(project, { title, priority, type, status: 'done' });

// ---- o que a API não grava: autoria do Claude, pastas e datas ----
const db = new DatabaseSync(DB);
for (const id of byClaude) db.prepare("UPDATE tasks SET source = 'claude', created_by = NULL WHERE id = ?").run(id);
let seed = 7;
const random = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
const ago = (n) => new Date(today.getTime() - n * 86400000).toISOString();
for (const t of db.prepare('SELECT id, status FROM tasks').all()) {
  const created = t.status === 'done' ? 8 + Math.floor(random() * 46) : 1 + Math.floor(random() * 30);
  const done = Math.max(0, created - 2 - Math.floor(random() * 9));
  db.prepare('UPDATE tasks SET created_at = ?, updated_at = ?, completed_at = ? WHERE id = ?')
    .run(ago(created), ago(t.status === 'done' ? done : Math.floor(random() * 3)), t.status === 'done' ? ago(done) : null, t.id);
}
// O que o Claude registrou é recente: aparece como novidade para quem volta ao quadro.
byClaude.forEach((id, i) => db.prepare('UPDATE tasks SET created_at = ?, updated_at = ? WHERE id = ?').run(ago(0.2 + i * 0.3), ago(0.2 + i * 0.3), id));
const paths = { loja: '/Users/voce/Developer/loja-online', ent: '/Users/voce/Developer/app-entregas', site: '/Users/voce/Developer/site-institucional' };

// O projeto "Quadro de Tarefas" ganha o mapa deste repositório, com uma simulação feita por um simulador
// de teste (mapa/test/fixtures): os números são de demonstração, não do Breakscale.
const map = join(ROOT, 'mapa-do-codigo');
if (existsSync(join(map, 'grafo.json'))) {
  const folder = join(DIR, 'claude-tasks');
  mkdirSync(folder, { recursive: true });
  cpSync(map, join(folder, 'mapa-do-codigo'), { recursive: true, filter: (src) => !/simulacao/.test(src) });
  const bs = join(ROOT, 'mapa/skills/mapa-do-codigo/scripts/breakscale.mjs');
  execFileSync(process.execPath, [bs, 'rascunho', folder], { stdio: 'ignore' });
  const designFile = join(folder, 'mapa-do-codigo', 'simulacao-projeto.json');
  const design = JSON.parse(readFileSync(designFile, 'utf8'));
  design.nome = 'Quadro de Tarefas';
  for (const n of design.nodes) {
    if (n.id === 'origem-painel') Object.assign(n, { label: 'Pessoas usando o painel', config: { rps: 20 } });
    if (n.id === 'origem-claude') n.label = 'Sessões do Claude';
  }
  design.premissas = design.premissas.map((p) => (p.componente === 'sqlite'
    ? { ...p, texto: 'Um arquivo só (data/tasks.db), com WAL: muitas leituras ao mesmo tempo e uma escrita por vez (src/db.js).', origem: 'código' }
    : p));
  design.sugestoes = {
    sqlite: 'Juntar as gravações das atualizações ao vivo (src/server.js) e manter o WAL; se a equipe crescer muito, trocar o SQLite por Postgres.',
    mcp: 'Reaproveitar a conexão com o banco entre chamadas do MCP em vez de abrir uma por sessão.',
    servidor: 'Rodar o servidor em mais de um processo, atrás de um balanceador.',
  };
  writeFileSync(designFile, JSON.stringify(design, null, 2));
  execFileSync(process.execPath, [bs, 'simular', folder], {
    stdio: 'ignore',
    env: { ...process.env, MAPA_BREAKSCALE_CMD: JSON.stringify([process.execPath, join(ROOT, 'mapa/test/fixtures/fake-breakscale.mjs')]) },
  });
  paths.qt = folder;
}
for (const [key, path] of Object.entries(paths)) db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(path, projects[key]);
db.close();

console.log(`Quadro de demonstração em ${BASE}`);
console.log('Entre com ana@exemplo.test e a senha que está em:');
console.log(SECRET);
console.log(JSON.stringify({ base: BASE, pasta: DIR, senha: SECRET, projetos: projects }));
console.log('Ctrl+C desliga e apaga tudo.');
