// O servidor do mapa. Sozinho (servidor.mjs), ele escuta só nesta máquina e a API dele só atende a página do
// mapa que ele serviu (um token novo a cada início, da mesma origem), então outros sites não conseguem usá-lo.
// Montado pelo quadro de tarefas (servidor-nucleo.mjs), o mesmo núcleo funciona sob um prefixo, com a página
// recebendo os dados do quadro e cada pedido respeitando as permissões que o quadro passa.
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, MAP, FILES, mapPath, shopApp, scanAndBuild, cleanup } from './helpers.mjs';
import { createMapServer } from '../skills/mapa-do-codigo/assets/servidor-nucleo.mjs';

const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-cli');
let root, server, base, token;
before(async () => {
  root = shopApp();
  scanAndBuild(root);
  const port = 20000 + Math.floor(Math.random() * 20000);
  // sem CLI do Claude Code nem do Codex: aqui só o servidor em si é exercitado
  server = spawn(process.execPath, [mapPath(root, FILES.server), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'nao-existe'), FLOORPLAN_CODEX: path.join(root, 'nao-existe') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`o servidor não iniciou: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Mapa do código: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`o servidor saiu (${code}): ${out}`)));
  });
  token = /"token":"([0-9a-f]+)"/.exec(await (await fetch(base + '/')).text())?.[1];
});
after(async () => {
  // espera o servidor sair antes: no Windows a pasta de trabalho dele não pode ser apagada enquanto ele roda
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

const api = (p, { headers = {}, ...opts } = {}) => fetch(base + p, { ...opts, headers: { 'content-type': 'application/json', ...headers } });

test('o mapa traz o servidor e o núcleo ao lado', () => {
  for (const f of [FILES.server, FILES.serverCore, FILES.query, FILES.page]) assert.ok(fs.existsSync(mapPath(root, f)), f);
});

test('escuta só em 127.0.0.1', () => {
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('a página que ele serve traz um token novo', () => {
  assert.match(token || '', /^[0-9a-f]{32}$/);
});

test('sem CLI instalada, a página sabe disso e o servidor continua de pé', async () => {
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(base + '/')).text())[1]);
  assert.equal(page.cli, false);
  assert.equal(page.engine, null);
  const health = await (await api('/api/health', { headers: { 'x-floorplan-token': token } })).json();
  assert.equal(health.cli, false);
});

test('chamadas à API sem o token são recusadas', async () => {
  assert.equal((await api('/api/flows')).status, 403);
  assert.equal((await api('/api/ask', { method: 'POST', body: '{"question":"oi"}' })).status, 403);
  assert.equal((await api('/api/flows', { headers: { 'x-floorplan-token': 'errado' } })).status, 403);
});

test('chamadas à API com o token, mas vindas de outro site, são recusadas', async () => {
  const r = await api('/api/flows', { headers: { 'x-floorplan-token': token, origin: 'https://malicioso.example' } });
  assert.equal(r.status, 403);
});

test('um caminho da API que não existe dá 404', async () => {
  assert.equal((await api('/api/nada', { headers: { 'x-floorplan-token': token } })).status, 404);
  assert.equal((await api('/api/cloud/prompt', { headers: { 'x-floorplan-token': token } })).status, 404, 'o Floorplan Cloud foi retirado');
});

/** Um pedido ao servidor com outro nome de host, como um site que aponta o próprio domínio para 127.0.0.1 mandaria. */
const asHost = (host, p) => new Promise((resolve, reject) => {
  const u = new URL(base + p);
  http.get({ hostname: u.hostname, port: u.port, path: u.pathname, headers: { host, 'x-floorplan-token': token } }, (r) => { r.resume(); resolve(r.statusCode); }).on('error', reject);
});

test('pedidos com qualquer outro nome de host são recusados, inclusive a página (DNS rebinding)', async () => {
  const port = new URL(base).port;
  assert.equal(await asHost(`malicioso.example:${port}`, '/'), 403);
  assert.equal(await asHost(`malicioso.example:${port}`, '/api/flows'), 403);
  assert.equal(await asHost('127.0.0.1:1', '/'), 403);
  assert.equal(await asHost(`localhost:${port}`, '/'), 200);
  assert.equal(await asHost(`127.0.0.1:${port}`, '/api/flows'), 200);
});

test('chamadas à API com o token, vindas do próprio mapa, funcionam', async () => {
  const r = await api('/api/flows', { headers: { 'x-floorplan-token': token } });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { flows: [] });
});

test('arquivos fora da pasta do mapa nunca são servidos', async () => {
  // inclusive de uma pasta vizinha cujo nome começa com o nome da pasta do mapa
  fs.mkdirSync(path.join(root, `${MAP}-antigo`));
  fs.writeFileSync(path.join(root, `${MAP}-antigo`, 'notas.txt'), 'notas privadas');
  for (const p of ['/../shop-api/config.js', '/%2e%2e/shop-api/config.js', '/..%2fshop-api%2fconfig.js', `/..%2f${MAP}-antigo%2fnotas.txt`]) {
    const r = await fetch(base + p);
    const body = await r.text();
    assert.ok(!body.includes('DB_PASSWORD') && !body.includes('notas privadas'), `${p} -> ${r.status}`);
  }
});

test('um endereço malformado recebe um erro, e o servidor continua rodando', async () => {
  assert.equal((await fetch(base + '/%E0%A4%A')).status, 400);
  assert.equal((await fetch(base + '/')).status, 200);
});

test('--stop para o servidor e diz isso em português', async () => {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync(process.execPath, [mapPath(root, FILES.server), '--stop'], { cwd: root, encoding: 'utf8' });
  assert.match(out, /Servidor do mapa parado \(http:\/\/127\.0\.0\.1:\d+\)\./);
  await new Promise((resolve) => (server.exitCode !== null ? resolve() : server.once('exit', resolve)));
  assert.match(execFileSync(process.execPath, [mapPath(root, FILES.server), '--stop'], { cwd: root, encoding: 'utf8' }), /O servidor do mapa não estava rodando\./);
});

// ---------- o núcleo montado por outro servidor, sob um prefixo ----------
describe('montado sob /mapa/7/ (como o quadro de tarefas faz)', () => {
  const BOARD = { projectId: 7, projectName: 'Loja </script><script>alert(1)</script> $\' & "Ação"', canEdit: true, canManage: false };
  let core, host, prefix, log;
  // as permissões de cada pedido, como o quadro decidiria a partir de quem está logado
  let perms = {};
  before(async () => {
    log = path.join(root, 'fake-montado.log');
    process.env.FAKE_LOG = log;
    core = createMapServer({ root, claudePath: path.join(FAKE, 'fake-claude.mjs'), codexPath: path.join(root, 'nao-existe'), engine: 'claude', log: { log() {}, error() {} } });
    host = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/mapa/7/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(core.page({ board: BOARD, ...(BOARD.canManage ? {} : { change: false }) })); }
      if (url.pathname.startsWith('/mapa/7/api/')) {
        const handled = await core.handle(req, res, url.pathname.slice('/mapa/7/api/'.length), perms);
        if (!handled) { res.writeHead(404); res.end('fora da API'); }
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
    prefix = `http://127.0.0.1:${host.address().port}/mapa/7/`;
  });
  after(async () => {
    core.close();
    await new Promise((resolve) => host.close(resolve));
    delete process.env.FAKE_LOG;
  });

  const pageInfo = async () => JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});<\/script>/.exec(await (await fetch(prefix)).text())[1]);
  // relativo à página, como o navegador resolve api/ask a partir de /mapa/7/
  const call = (p, { method = 'GET', body, headers = {} } = {}) => fetch(new URL(p, prefix), {
    method, headers: { 'content-type': 'application/json', 'x-floorplan-token': core.token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const events = async (r) => (await r.text()).split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));

  test('a página recebe os dados do quadro junto com os do servidor, sem quebrar a tag <script>', async () => {
    const html = await (await fetch(prefix)).text();
    assert.ok(!html.includes('</script><script>alert(1)'), 'o nome do projeto não fecha a tag');
    const info = await pageInfo();
    assert.deepEqual(info.board, BOARD);
    assert.equal(info.token, core.token);
    assert.equal(info.cli, true);
    assert.equal(info.engine, 'claude');
    assert.equal(info.change, false, 'quem não gerencia o projeto não vê Alterar');
    assert.equal(core.info().change, true);
    assert.deepEqual(Object.keys(core.info()).sort(), ['change', 'cli', 'engine', 'model', 'token', 'version', 'want']);
  });

  test('perguntar funciona pelo prefixo, com o Claude Code só lendo', async () => {
    const ev = await events(await call('api/ask', { method: 'POST', body: { question: 'Como funcionam os reembolsos?' } }));
    assert.deepEqual(ev.filter((e) => e.event === 'progress').map((e) => e.data.text), ['Lendo a visão geral do mapa', 'Lendo shop-api/routes/orders.js']);
    const answer = ev.find((e) => e.event === 'answer')?.data;
    assert.equal(answer.title, 'Reembolsos');
    const last = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual(last.args.slice(last.args.indexOf('--allowedTools') + 1), [`Bash(node ${MAP}/${FILES.query}:*)`, 'Read', 'Grep', 'Glob']);
    assert.match(last.args[last.args.indexOf('--append-system-prompt') + 1], /português do Brasil/);
  });

  test('os fluxos pedidos são salvos e lidos pelo prefixo', async () => {
    const flow = { id: 'custom-1', title: 'Reembolso', steps: [{ ref: 'web', note: 'Pede.' }, { ref: 'api', note: 'Devolve.' }] };
    assert.deepEqual((await (await call('api/flows', { method: 'POST', body: { flow } })).json()).flows.map((f) => f.id), ['custom-1']);
    assert.deepEqual((await (await call('api/flows')).json()).flows.map((f) => f.id), ['custom-1']);
    assert.ok(fs.existsSync(mapPath(root, FILES.flows)));
    assert.deepEqual((await (await call('api/flows', { method: 'DELETE', body: { id: 'custom-1' } })).json()).flows, []);
  });

  test('status, health e o stream de eventos respondem pelo prefixo', async () => {
    assert.equal((await (await call('api/status')).json()).root, root);
    assert.equal((await (await call('api/health')).json()).engine, 'claude');
    const ctl = new AbortController();
    const r = await fetch(new URL(`api/events?token=${core.token}`, prefix), { signal: ctl.signal });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    ctl.abort();
  });

  test('o token continua obrigatório, e o que não é da API volta para quem montou', async () => {
    assert.equal((await call('api/flows', { headers: { 'x-floorplan-token': 'errado' } })).status, 403);
    assert.equal((await call('api/nada')).status, 404);
    assert.equal(await (await call('api/nada')).text(), 'fora da API');
  });

  test('as permissões do quadro valem por pedido, com mensagens em português', async () => {
    try {
      perms = { allowAsk: false, allowChange: false, allowFlows: false };
      const ask = await call('api/ask', { method: 'POST', body: { question: 'oi' } });
      assert.equal(ask.status, 403);
      assert.match((await ask.json()).error, /Você só pode ver este mapa: perguntar exige permissão de edição no projeto/);
      assert.equal((await call('api/cancel', { method: 'POST' })).status, 403);
      const flows = await call('api/flows', { method: 'POST', body: { flow: { id: 'x', steps: [] } } });
      assert.equal(flows.status, 403);
      assert.match((await flows.json()).error, /fluxos exige permissão de edição/);
      assert.equal((await call('api/flows', { method: 'DELETE', body: { id: 'x' } })).status, 403);
      assert.equal((await call('api/flows')).status, 200, 'ver os fluxos continua liberado');
      assert.equal((await call('api/export', { method: 'POST', body: {} })).status, 200, 'exportar continua liberado');
      const undo = await call('api/plan/undo', { method: 'POST' });
      assert.equal(undo.status, 403);
      assert.match((await undo.json()).error, /Alterar a planta exige ser gerente do projeto/);

      perms = { allowChange: false };
      const change = await call('api/ask', { method: 'POST', body: { question: 'planeje reembolsos', mode: 'change' } });
      assert.equal(change.status, 403);
      assert.match((await change.json()).error, /Alterar a planta exige ser gerente do projeto/);
    } finally { perms = {}; }
  });

  test('Parar encerra só as perguntas de quem pediu', async () => {
    // a pergunta é feita sem usuário (perms = {}); depois a ana aperta Parar
    const pending = call('api/ask', { method: 'POST', body: { question: 'uma pergunta DEMORADA' } });
    let settled = false;
    const res = pending.then(async (r) => { const e = await events(r); settled = true; return e; });
    await new Promise((r) => setTimeout(r, 500));
    perms = { user: 'ana' };
    assert.equal((await call('api/cancel', { method: 'POST' })).status, 204, 'ana não tem perguntas em andamento');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(settled, false, 'a pergunta dos outros continua');
    perms = {};
    assert.equal((await call('api/cancel', { method: 'POST' })).status, 204);
    const ev = await res;
    assert.equal(ev.filter((e) => e.event === 'answer').length, 0);
    assert.equal(ev.filter((e) => e.event === 'failure').length, 1);
  });

  test('um corpo que quem montou já leu (req.body) também é aceito', async () => {
    const res = { headers: {}, writeHead(s, h) { this.status = s; Object.assign(this.headers, h); }, end(b) { this.body = b; }, headersSent: false };
    const req = { method: 'POST', url: '/mapa/7/api/flows', headers: { host: 'x', 'x-floorplan-token': core.token }, body: { flow: { id: 'lido', steps: [{ ref: 'web' }, { ref: 'api' }] } }, resume() {} };
    assert.equal(await core.handle(req, res, 'flows'), true);
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).flows.map((f) => f.id), ['lido']);
    req.body = { id: 'lido' }; req.method = 'DELETE';
    await core.handle(req, res, '/api/flows');
    assert.deepEqual(JSON.parse(res.body).flows, []);
    assert.equal(await core.handle({ ...req, method: 'PUT' }, res, 'flows'), false, 'método que a API não tem');
  });

  test('sem nenhuma CLI instalada, info() não falha', () => {
    const none = createMapServer({ root, claudePath: path.join(root, 'nao-existe'), codexPath: path.join(root, 'nao-existe'), log: { log() {}, error() {} } });
    try {
      const i = none.info();
      assert.equal(i.cli, false);
      assert.equal(i.engine, null);
      assert.ok(['claude', 'codex'].includes(i.want));
    } finally { none.close(); }
  });

  test('um projeto ainda sem mapa não derruba o núcleo', () => {
    const empty = fs.mkdtempSync(path.join(path.dirname(root), 'mapa-vazio-'));
    const none = createMapServer({ root: empty, claudePath: path.join(root, 'nao-existe'), codexPath: path.join(root, 'nao-existe'), log: { log() {}, error() {} } });
    try {
      assert.equal(none.info().cli, false);
      assert.throws(() => none.page(), /ainda não tem mapa/);
    } finally { none.close(); cleanup(empty); }
  });
});
