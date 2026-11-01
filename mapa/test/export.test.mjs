// Exportar uma cópia do mapa para compartilhar: o servidor.mjs --export e o botão Exportar do mapa (POST
// api/export) gravam a mesma página autossuficiente, marcada como exportada, sem os dados deste computador nem o
// token do servidor, e só com os extras pedidos. A saúde e o trabalho recente ficam de fora, a menos que pedidos.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { FILES, mapPath, shopApp, run, readJson, writeJson, cleanup, FAKE_PASSWORD } from './helpers.mjs';

const TOKEN_IN_REMOTE = 'ghp-not-a-real-token-1234';
let root, server, base, token;
const serveJs = () => mapPath(root, FILES.server);
/** O nome do arquivo exportado: o nome do projeto sem acentos, em minúsculas, com hífens, mais "-mapa.html". */
const exportName = () => `${readJson(mapPath(root, FILES.arch)).project.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-mapa.html`;
/** O grafo dentro de uma página exportada. */
const dataOf = (html) => JSON.parse(/<script>window\.FLOORPLAN = (.*?);<\/script>/s.exec(html)[1]);
/** Roda o servidor.mjs --export com estes argumentos; devolve a página exportada e o que ele imprimiu. */
function exportCli(...args) {
  const out = execFileSync(process.execPath, [serveJs(), '--export', ...args], { cwd: root, encoding: 'utf8' });
  const file = /Mapa exportado para (.+)/.exec(out)[1].trim();
  return { out, html: fs.readFileSync(file, 'utf8'), file };
}

before(async () => {
  root = shopApp();
  execFileSync('git', ['-C', path.join(root, 'shop-api'), 'remote', 'add', 'origin', `https://someone:${TOKEN_IN_REMOTE}@example.com/shop-api.git`]);
  const arch = readJson(mapPath(root, FILES.arch));
  writeJson(mapPath(root, FILES.arch), {
    ...arch,
    annotations: [{ path: 'shop-api/config.js', note: 'Vai para o cofre de segredos no próximo sprint.' }],
    flows: [{ id: 'refund', title: 'Reembolso', description: 'Um cliente pede reembolso.', steps: [{ node: 'web', note: 'O site pede.' }, { node: 'api', note: 'O servidor devolve.' }] }],
  });
  writeJson(mapPath(root, FILES.recent), { tasks: [{ title: 'Reembolsos', summary: 'Reembolsos adicionados.', items: [{ ref: 'shop-api/routes/orders.js', change: 'changed', note: 'Endpoint de reembolso.' }] }] });
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');

  const port = 20000 + Math.floor(Math.random() * 20000);
  server = spawn(process.execPath, [serveJs(), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_CLAUDE: path.join(root, 'nao-existe'), FLOORPLAN_CODEX: path.join(root, 'nao-existe') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`o servidor não iniciou: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Mapa do código: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`o servidor saiu (${code}): ${out}`)));
  });
  token = /"token":"([0-9a-f]+)"/.exec(await (await fetch(base + '/')).text())[1];
});
after(async () => {
  if (server && server.exitCode === null) await new Promise((resolve) => { server.once('exit', resolve); server.kill(); });
  cleanup(root);
});

test('o mapa tem saúde, trabalho recente, uma nota, um fluxo e um remote para deixar de fora', () => {
  const g = dataOf(fs.readFileSync(mapPath(root, FILES.page), 'utf8'));
  assert.ok(g.health.issues.length > 0);
  assert.equal(g.recent.items.length, 1);
  assert.ok(g.files.some((f) => f.note));
  assert.equal(g.flows.length, 1);
  assert.ok(g.meta.root);
});

test('por padrão a exportação mantém fluxos e notas e deixa de fora a saúde, o trabalho recente e este computador', () => {
  const { html, file, out } = exportCli();
  assert.equal(path.basename(file), exportName());
  assert.equal(path.dirname(file), mapPath(fs.realpathSync(root)));
  const g = dataOf(html);
  assert.match(g.meta.exported.at, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(g.meta.exported.include, ['flows', 'notes']);
  assert.equal(g.health, undefined);
  assert.equal(g.recent, undefined);
  assert.equal(g.flows.length, 1);
  assert.ok(g.files.some((f) => f.note));
  assert.equal(g.meta.root, null);
  assert.ok(g.meta.repos.every((r) => !('remote' in r)));
  assert.ok(!html.includes(TOKEN_IN_REMOTE), 'nenhum token de acesso vindo de um remote do git');
  const here = readJson(mapPath(root, FILES.graph)).meta.root;
  assert.ok(here && !html.includes(here), 'nenhum caminho de pasta deste computador');
  assert.ok(!html.includes('FLOORPLAN_SERVER='), 'nenhum dado do servidor');
  assert.match(out, /Inclui: o mapa, os fluxos e o tour, as notas\./);
  assert.match(out, /sem a barra de perguntas/);
  assert.doesNotMatch(out, /Compartilhe só com pessoas de confiança/);
});

test('a saúde e o trabalho recente só entram quando pedidos, com um aviso sobre a saúde', () => {
  const { html, out } = exportCli(path.join(root, 'tudo.html'), '--include', 'flows,notes,recent,health');
  const g = dataOf(html);
  assert.deepEqual(g.meta.exported.include, ['flows', 'notes', 'recent', 'health']);
  assert.ok(g.health.issues.length > 0);
  assert.equal(g.recent.items.length, 1);
  assert.match(out, /Compartilhe só com pessoas de confiança/);
  // onde um segredo está, nunca o segredo
  assert.ok(!html.includes(FAKE_PASSWORD));
});

test('os fluxos, o tour e as notas também podem ficar de fora', () => {
  const { html } = exportCli(path.join(root, 'vazio.html'), '--include', 'none');
  const g = dataOf(html);
  assert.deepEqual(g.meta.exported.include, []);
  assert.deepEqual(g.flows, []);
  assert.deepEqual(g.tour, []);
  assert.ok(g.files.every((f) => !('note' in f)));
});

test('a página exportada continua sendo o mapa inteiro, pronta para abrir', () => {
  const { html } = exportCli(path.join(root, 'pagina.html'));
  const g = dataOf(html);
  const built = readJson(mapPath(root, FILES.graph));
  assert.equal(g.files.length, built.files.length);
  assert.equal(g.routes.length, built.routes.length);
  assert.equal(g.links.length, built.links.length);
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /ui\/60-export\.js/);
});

test('uma exportação sem mapa falha com uma mensagem clara', () => {
  const copy = fs.mkdtempSync(path.join(path.dirname(root), 'mapa-sem-pagina-'));
  try {
    fs.mkdirSync(path.join(copy, 'mapa-do-codigo'));
    for (const f of [FILES.server, FILES.serverCore]) fs.copyFileSync(mapPath(root, f), path.join(copy, 'mapa-do-codigo', f));
    let err;
    try { execFileSync(process.execPath, [path.join(copy, 'mapa-do-codigo', FILES.server), '--export'], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { err = e; }
    assert.equal(err?.status, 1);
    assert.match(String(err.stderr), /✗ Não consegui exportar o mapa: Este projeto ainda não tem mapa/);
  } finally { cleanup(copy); }
});

const api = (body, headers = {}) => fetch(base + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('o botão Exportar precisa do token da página do mapa', async () => {
  assert.equal((await api({ include: ['flows'] })).status, 403);
  assert.equal((await api({ include: ['flows'] }, { 'x-floorplan-token': 'errado' })).status, 403);
});

test('o botão Exportar baixa a cópia, com os fluxos pedidos desde o último build', async () => {
  const extra = { id: 'custom-1', title: 'O administrador apaga um usuário', description: '', steps: [{ ref: 'web', note: 'Primeiro.' }, { ref: 'api', note: 'Depois.' }] };
  const r = await api({ include: ['flows', 'health'], flows: [extra, { id: 'ruim', steps: 'não' }] }, { 'x-floorplan-token': token });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
  assert.equal(r.headers.get('content-disposition'), `attachment; filename="${exportName()}"`);
  const g = dataOf(await r.text());
  assert.deepEqual(g.meta.exported.include, ['flows', 'health']);
  assert.deepEqual(g.flows.map((f) => f.id), ['refund', 'custom-1']);
  assert.equal(g.flows[1].custom, true);
  assert.ok(g.files.every((f) => !('note' in f)), 'as notas não foram marcadas');
  assert.equal(g.recent, undefined);
  assert.ok(g.health);
});

test('um corpo grande demais é recusado', async () => {
  const r = await fetch(base + '/api/export', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': token }, body: JSON.stringify({ flows: 'x'.repeat(600000) }) }).catch(() => null);
  // o servidor responde 413 (ou corta a conexão antes de o cliente terminar de mandar)
  assert.ok(!r || r.status === 413, `status ${r?.status}`);
  assert.equal((await fetch(base + '/')).status, 200, 'o servidor continua de pé');
});
