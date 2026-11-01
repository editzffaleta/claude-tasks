// Mapa do código dentro do quadro: página servida com login e permissões, tarefas ligadas aos
// arquivos do mapa, criação de tarefas a partir do mapa e a consulta pelo MCP/API.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
let dir, child, base, repo, P, Q, mapaPage;
const jar = {};

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function req(path, { method = 'GET', body, as = 'admin', headers = {}, redirect = 'manual' } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    redirect,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(jar[as] ? { cookie: jar[as] } : {}), origin: base, ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const cookie = res.headers.get('set-cookie');
  if (cookie && !cookie.includes('Max-Age=0')) jar[as] = cookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}
const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data).slice(0, 300)); return r.data; };

// Um mapa mínimo, como o build.mjs grava: index.html com os dados embutidos, grafo.json e consulta.mjs.
function writeMap(root) {
  const graph = {
    schema: 'floorplan/graph@1',
    meta: { generatedAt: new Date().toISOString(), agent: 'claude', counts: { files: 3 } },
    project: { name: 'Loja' },
    nodes: [{ id: 'api', parent: null, label: 'Servidor da loja', kind: 'service', summary: 'Recebe os pedidos.', details: '', tags: [], paths: ['src'], packages: [], hosts: [] }],
    files: [
      { p: 'src/pedidos.js', n: 'api', l: 'javascript', loc: 40, name: 'Pedidos', d: 'Cria e lista os pedidos da loja.' },
      { p: 'src/pagamentos/stripe.js', n: 'api', l: 'javascript', loc: 30, name: 'Pagamentos', d: 'Cobra no cartão pelo Stripe.' },
      { p: 'web/src/pedidos.js', n: 'api', l: 'javascript', loc: 20, name: 'Tela de pedidos', d: 'Mostra os pedidos para o cliente.' },
    ],
    routes: [{ f: 'src/pedidos.js', m: 'POST', p: '/api/pedidos', l: 3, name: 'Criar pedido', d: 'Recebe um pedido novo.' }],
    links: [],
    flows: [],
    tour: [],
    screens: [],
    health: { issues: [{ id: 'secret:src/pagamentos/stripe.js:3', severity: 'high', title: 'Chave secreta no código' }] },
  };
  mkdirSync(join(root, 'mapa-do-codigo'), { recursive: true });
  writeFileSync(join(root, 'mapa-do-codigo', 'grafo.json'), JSON.stringify(graph));
  writeFileSync(join(root, 'mapa-do-codigo', 'index.html'),
    `<!doctype html><html lang="pt-BR"><head><title>Mapa do código</title></head><body><script>window.FLOORPLAN = ${JSON.stringify(graph)};</script></body></html>`);
  writeFileSync(join(root, 'mapa-do-codigo', 'consulta.mjs'), "console.log('consulta:', process.argv.slice(2).join(' '));\n");
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-tasks-mapa-'));
  repo = join(dir, 'loja');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: { ...process.env, CLAUDE_TASKS_DB: join(dir, 't.db'), CLAUDE_TASKS_PORT: String(port), CLAUDE_TASKS_NO_OS_NOTIFY: '1' },
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/auth/me`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  ok(await req('/api/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'admin@ex.test', password: 'senha-admin-1' } }));
  for (const [key, role] of [['ana', 'member'], ['vera', 'viewer']]) {
    ok(await req('/api/users', { method: 'POST', body: { name: key, email: `${key}@ex.test`, password: `senha-${key}-1`, role } }));
    ok(await req('/api/auth/login', { method: 'POST', as: key, body: { email: `${key}@ex.test`, password: `senha-${key}-1` } }));
  }
  // Projeto com pasta (criado como o MCP cria, pela pasta) e outro privado.
  ok(await req('/api/tasks', { method: 'POST', body: { project_name: 'Loja', title: 'Placeholder' } }));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(dir, 't.db'));
  db.prepare('UPDATE projects SET path = ? WHERE name = ?').run(repo, 'Loja');
  db.close();
  P = ok(await req('/api/state')).projects.find((p) => p.name === 'Loja');
  Q = ok(await req('/api/projects', { method: 'POST', body: { name: 'Secreto', visibility: 'private' } }));
});

after(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('sem mapa: o status explica, a página orienta e a API do mapa responde 404', async () => {
  const s = ok(await req(`/api/projects/${P.id}/mapa`));
  assert.deepEqual([s.available, s.exists], [true, false]);
  assert.equal((await req(`/mapa/${P.id}/`)).status, 404);
  assert.equal((await req(`/mapa/${P.id}/api/status`)).status, 404);
  const sem = ok(await req(`/api/projects/${Q.id}/mapa`));
  assert.equal(sem.available, false, 'projeto sem pasta');
});

test('com mapa: página só com login, no mesmo site, com os dados do quadro injetados', async () => {
  writeMap(repo);
  const s = ok(await req(`/api/projects/${P.id}/mapa`));
  assert.equal(s.exists, true);
  assert.equal(s.files, 3);
  assert.equal(s.health.high, 1);

  assert.equal((await req(`/mapa/${P.id}/`, { as: 'anon' })).status, 302);
  assert.equal((await req(`/mapa/${P.id}`)).status, 301);
  const page = await req(`/mapa/${P.id}/`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(page.data, /window\.FLOORPLAN_SERVER=/);
  assert.match(page.data, new RegExp(`"board":\\{"projectId":${P.id}`));
  mapaPage = page.data;
  // Visualizador vê o mapa, sem poder alterar a planta.
  const vista = await req(`/mapa/${P.id}/`, { as: 'vera' });
  assert.equal(vista.status, 200);
  assert.match(vista.data, /"canEdit":false/);
  // Projeto privado: quem não é membro não vê nem a página.
  assert.equal((await req(`/mapa/${Q.id}/`, { as: 'ana' })).status, 404);
});

test('tarefas que citam arquivos aparecem ligadas a eles no mapa', async () => {
  ok(await req('/api/tasks', { method: 'POST', body: { project_id: P.id, title: 'Corrigir total em src/pedidos.js', description: 'Ver também stripe.js e web/src/pedidos.js:40' } }));
  ok(await req('/api/tasks', { method: 'POST', body: { project_id: P.id, title: 'Sem arquivo nenhum' } }));
  const { tasks } = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`));
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].files.sort(), ['src/pagamentos/stripe.js', 'src/pedidos.js', 'web/src/pedidos.js']);
});

test('problema da Saúde vira tarefa uma vez só; visualizador não cria', async () => {
  const body = {
    title: 'Chave secreta no código: src/pagamentos/stripe.js', description: 'Mover a chave para variável de ambiente.', priority: 'high',
    tags: ['saúde'], origin: { kind: 'saude', id: 'secret:src/pagamentos/stripe.js:3' },
  };
  const first = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`, { method: 'POST', body }));
  assert.equal(first.duplicate, false);
  const again = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`, { method: 'POST', body }));
  assert.deepEqual([again.duplicate, again.task.id], [true, first.task.id]);
  const t = ok(await req(`/api/tasks/${first.task.id}`));
  assert.deepEqual([t.priority, t.type], ['high', 'bug']);
  assert.ok(t.tags.includes('mapa') && t.tags.includes('saúde'));
  assert.equal((await req(`/mapa/${P.id}/api/quadro/tarefas`, { method: 'POST', as: 'vera', body: { ...body, origin: { kind: 'card', id: 'x' } } })).status, 403);
  assert.equal((await req(`/mapa/${P.id}/api/quadro/tarefas`, { method: 'POST', body, headers: { origin: 'https://evil.example' } })).status, 403);
});

test('perguntar ao mapa e alterar a planta respeitam as permissões', async () => {
  const token = mapaPage.match(/"token":"([^"]+)"/)?.[1];
  assert.ok(token, 'token injetado');
  const ask = await req(`/mapa/${P.id}/api/ask`, { method: 'POST', as: 'vera', body: { question: 'O que faz o servidor?' }, headers: { 'x-floorplan-token': token } });
  assert.equal(ask.status, 403);
  const undo = await req(`/mapa/${P.id}/api/plan/undo`, { method: 'POST', as: 'ana', body: {}, headers: { 'x-floorplan-token': token } });
  assert.equal(undo.status, 403);
});

test('consulta ao mapa pela API (a mesma que o MCP usa) roda o código do plugin, não o da pasta', async () => {
  const r = ok(await req(`/api/projects/${P.id}/mapa/consulta?arg=find&arg=pedidos`));
  assert.doesNotMatch(r.text, /^consulta:/, 'o consulta.mjs da pasta do projeto não é executado');
  assert.ok(JSON.parse(r.text).some((x) => x.path === 'src/pedidos.js'), r.text.slice(0, 300));
  assert.equal((await req(`/api/projects/${Q.id}/mapa/consulta?arg=find&arg=x`, { as: 'ana' })).status, 403);
});

test('tarefas criadas sobre um cartão ficam presas a ele; dá para criar mais de uma', async () => {
  const body = { title: 'Revisar o servidor da loja', description: 'Ver regras de pedido', origin: { kind: 'card', id: 'n:api' } };
  const a = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`, { method: 'POST', body }));
  const b = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`, { method: 'POST', body: { ...body, title: 'Outra coisa no servidor' } }));
  assert.notEqual(a.task.id, b.task.id);
  const { tasks } = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`));
  assert.deepEqual(tasks.filter((t) => t.cards.includes('n:api')).map((t) => t.id).sort(), [a.task.id, b.task.id].sort());
});


// Simulação no Breakscale, como o breakscale.mjs do plugin grava.
function writeSimulation(root, extra = {}) {
  const sim = {
    $schema: 'mapa/simulacao@1',
    nome: 'Loja',
    geradoEm: '2026-11-01T12:00:00.000Z',
    origem: 'local',
    pacote: 'breakscale-mcp@0.1.1',
    link: 'https://breakscale.tech/#d3.AQID',
    arquivo: 'simulacao.breakscale',
    componentes: [{ id: 'origem-web', nome: 'Usuários', tipo: 'client' }, { id: 'api', nome: 'Servidor da loja', tipo: 'service' }, { id: 'pg', nome: 'Postgres', tipo: 'db' }],
    cenarios: [
      { fator: 1, nome: 'Tráfego de base', oferecido: 50, servido: 50, falhas: 0, p50: 20, p95: 40, p99: 80, motivos: [], componentes: [{ id: 'api', ocupacao: 0.3 }, { id: 'pg', ocupacao: 0.6 }], link: 'javascript:alert(1)' },
      { fator: 2, nome: '2× o tráfego', oferecido: 100, servido: 92, falhas: 0.08, p50: 30, p95: 400, p99: 900, motivos: [{ motivo: 'shed', texto: 'foram recusados por uma fila cheia', n: 240 }], componentes: [{ id: 'api', ocupacao: 0.6 }, { id: 'pg', ocupacao: 1, recusadas: 8 }] },
    ],
    gargalos: [
      { id: 'pg', componente: 'pg', nome: 'Postgres', tipo: 'db', fator: 2, trafego: 100, severidade: 'alta', titulo: 'Postgres não aguenta 2× o tráfego', porque: 'Com 2× o tráfego, Postgres fica 100% ocupado.', sugestao: 'Pôr um cache na frente.' },
      { id: 'api', componente: 'api', nome: 'Servidor da loja', tipo: 'service', fator: 10, trafego: 500, severidade: 'baixa', titulo: 'Servidor da loja não aguenta 10× o tráfego', porque: 'Fila cheia.', sugestao: null, extra: '<script>' },
    ],
    premissas: [{ componente: 'pg', texto: 'Pool de 10 conexões (src/db.js:4).', origem: 'código' }, { componente: 'origem-web', texto: '50 pedidos por segundo.', origem: 'chute' }],
    deixadoDeFora: [{ texto: 'O Stripe ficou de fora.' }],
    ...extra,
  };
  writeFileSync(join(root, 'mapa-do-codigo', 'simulacao.json'), JSON.stringify(sim));
  writeFileSync(join(root, 'mapa-do-codigo', 'simulacao.breakscale'), JSON.stringify({ app: 'breakscale', version: 1, topology: { nodes: [], edges: [] } }));
  return sim;
}

test('simulação: o status resume, a API devolve só o que é esperado e o modelo pode ser baixado', async () => {
  assert.equal(ok(await req(`/api/projects/${P.id}/mapa`)).simulation, null);
  assert.equal((await req(`/api/projects/${P.id}/mapa/simulacao`)).status, 404);
  writeSimulation(repo);
  const s = ok(await req(`/api/projects/${P.id}/mapa`)).simulation;
  assert.deepEqual([s.scenarios, s.bottlenecks, s.urgent], [2, 2, 1]);
  const sim = ok(await req(`/api/projects/${P.id}/mapa/simulacao`));
  assert.equal(sim.link, 'https://breakscale.tech/#d3.AQID');
  assert.equal(sim.cenarios[0].link, null, 'links que não são do Breakscale são descartados');
  assert.equal(sim.gargalos[1].extra, undefined, 'campos desconhecidos não passam');
  assert.equal(sim.temArquivo, true);
  assert.deepEqual(sim.tarefas, {});
  const file = await req(`/api/projects/${P.id}/mapa/simulacao/arquivo`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment; filename\*=UTF-8''loja\.breakscale/);
  assert.equal(file.data.app, 'breakscale');
  writeSimulation(repo, { link: 'https://evil.example/#x' });
  assert.equal(ok(await req(`/api/projects/${P.id}/mapa/simulacao`)).link, null);
  // Visualizador vê; quem não é membro de um projeto privado, não.
  assert.equal((await req(`/api/projects/${P.id}/mapa/simulacao`, { as: 'vera' })).status, 200);
  assert.equal((await req(`/api/projects/${Q.id}/mapa/simulacao`, { as: 'ana' })).status, 403);
});

test('simulação: cada gargalo vira uma tarefa só, com o texto gravado, e aparece no cartão do mapa', async () => {
  writeSimulation(repo);
  const r = ok(await req(`/api/projects/${P.id}/mapa/simulacao/tarefas`, { method: 'POST', body: { ids: ['pg', 'api'] } }));
  assert.deepEqual(r.tasks.map((x) => [x.gargalo, x.duplicate]), [['pg', false], ['api', false]]);
  const t = ok(await req(`/api/tasks/${r.tasks[0].task.id}`));
  assert.equal(t.title, 'Postgres não aguenta 2× o tráfego');
  assert.equal(t.priority, 'high');
  assert.equal(t.type, 'task');
  assert.ok(t.tags.includes('mapa') && t.tags.includes('simulação'));
  assert.match(t.description, /Pôr um cache na frente/);
  assert.match(t.description, /\[Abrir no Breakscale\]\(https:\/\/breakscale\.tech\/#d3\.AQID\)/);
  assert.equal(ok(await req(`/api/tasks/${r.tasks[1].task.id}`)).priority, 'low');
  const again = ok(await req(`/api/projects/${P.id}/mapa/simulacao/tarefas`, { method: 'POST', body: { id: 'pg' } }));
  assert.deepEqual([again.tasks[0].duplicate, again.tasks[0].task.id], [true, r.tasks[0].task.id]);
  assert.equal(ok(await req(`/api/projects/${P.id}/mapa/simulacao`)).tarefas.pg.id, r.tasks[0].task.id);
  // O gargalo "api" é a parte "api" do mapa: a tarefa fica presa ao cartão dela.
  const { tasks } = ok(await req(`/mapa/${P.id}/api/quadro/tarefas`));
  assert.ok(tasks.find((x) => x.id === r.tasks[1].task.id).cards.includes('n:api'));
  assert.equal((await req(`/api/projects/${P.id}/mapa/simulacao/tarefas`, { method: 'POST', body: { id: 'nao-existe' } })).status, 404);
  const before = ok(await req('/api/state')).tasks?.length;
  assert.equal((await req(`/api/projects/${P.id}/mapa/simulacao/tarefas`, { method: 'POST', body: { ids: ['pg', 'nao-existe'] } })).status, 404, 'um id errado recusa a lista toda');
  assert.equal(ok(await req('/api/state')).tasks?.length, before);
  assert.equal((await req(`/api/projects/${P.id}/mapa/simulacao/tarefas`, { method: 'POST', body: {} })).status, 400);
  assert.equal((await req(`/api/projects/${P.id}/mapa/simulacao/tarefas`, { method: 'POST', as: 'vera', body: { id: 'pg' } })).status, 403);
});
