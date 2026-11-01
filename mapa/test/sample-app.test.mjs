// Ponta a ponta: mapeia uma lojinha em dois repositórios do jeito que a skill faz e confere o mapa, a Saúde,
// as promessas de privacidade (offline, nenhum valor secreto, nada commitado) e uma atualização.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { shopApp, scanAndBuild, run, readGraph, readJson, writeJson, routeKeys, openEndpoints, allFiles, cleanup, mapPath, FILES, MAP, SKILL, FAKE_PASSWORD } from './helpers.mjs';

let root, graph, output;
before(() => { root = shopApp(); output = scanAndBuild(root); graph = readGraph(root); });
after(() => cleanup(root));

test('os dois repositórios são encontrados e todo arquivo cai numa parte do mapa', () => {
  assert.deepEqual(graph.meta.repos.map((r) => r.path).sort(), ['shop-api', 'shop-web']);
  assert.equal(graph.meta.counts.unassigned, 0);
  assert.ok(graph.files.some((f) => f.p === 'shop-web/src/App.jsx' && f.n === 'web'));
});

test('a varredura e a montagem falam português e gravam com os nomes novos', () => {
  assert.match(output, /Mapa do código: varredura de /);
  assert.match(output, /ATRIBUIÇÃO {2}\d+ arquivos \(code\), 0 não atribuídos \(0,0%\)/);
  assert.match(output, /DESCRIÇÕES {2}arquivos \d+\/\d+ · endpoints \d+\/4 · módulos 2\/2/);
  assert.match(output, new RegExp(`✓ gravei ${MAP}/index\\.html \\(.+ [KM]B\\) e grafo\\.json`));
  assert.match(output, new RegExp(`GIT {2}${MAP}/ fica fora do git`));
  for (const f of [FILES.graph, FILES.page, FILES.query, FILES.server]) assert.ok(fs.existsSync(mapPath(root, f)), f);
  for (const old of ['graph.json', 'query.mjs', 'serve.mjs', 'architecture.json']) assert.ok(!fs.existsSync(mapPath(root, old)), `${old} não deveria existir`);
  assert.ok(!fs.existsSync(path.join(root, 'floorplan')), 'nada vai para floorplan/');
});

test('o servidor e o núcleo dele são copiados para a pasta do mapa quando existem na skill', () => {
  // servidor-nucleo.mjs é novo; enquanto ele não existir em assets/, a montagem segue sem ele
  const skillCore = path.join(SKILL, 'assets', FILES.serverCore);
  assert.equal(fs.existsSync(mapPath(root, FILES.serverCore)), fs.existsSync(skillCore));
});

test('os endpoints ganham o prefixo do router em que são montados', () => {
  assert.deepEqual(routeKeys(graph), ['DELETE /admin/users/:id', 'GET /api/orders', 'POST /api/notes', 'POST /api/orders/:id/refund']);
});

test('as requisições do site são ligadas aos endpoints do servidor, entre repositórios', () => {
  const http = graph.links.filter((l) => l.k === 'http' && l.a === 'f:shop-web/src/api.js').map((l) => l.b);
  assert.ok(http.includes('f:shop-api/routes/orders.js'), JSON.stringify(graph.links.filter((l) => l.k === 'http')));
  assert.ok(graph.links.some((l) => l.k === 'import' && l.a === 'f:shop-web/src/App.jsx' && l.b === 'f:shop-web/src/api.js'));
});

test('a Saúde aponta só o endpoint sem verificação de login e a senha escrita no código', () => {
  // orders usa requireAuth na rota, admin é verificado onde é montado, notes não tem nada
  assert.deepEqual(openEndpoints(graph), ['POST /api/notes']);
  const secret = graph.health.issues.find((i) => i.kind === 'secret');
  assert.ok(secret, 'a senha em config.js é apontada');
  assert.deepEqual(secret.locations, [{ file: 'shop-api/config.js', line: 1 }]);
});

test('o valor secreto nunca é gravado em nada que o Mapa do código grava, nem impresso', () => {
  assert.ok(!output.includes(FAKE_PASSWORD), 'saída da varredura/montagem');
  for (const f of allFiles(mapPath(root))) assert.ok(!f.text.includes(FAKE_PASSWORD), path.relative(root, f.path));
});

test('o mapa não faz requisições externas: scripts, estilos e fontes estão todos dentro do arquivo', () => {
  const html = fs.readFileSync(mapPath(root, FILES.page), 'utf8');
  assert.doesNotMatch(html, /<script[^>]*\ssrc\s*=\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /<link[^>]*\shref\s*=\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /url\(\s*["']?(https?:)?\/\//i);
  assert.doesNotMatch(html, /@import/);
  assert.match(html, /@font-face\{font-family:"Inter"/);
  assert.match(html, /<title>Loja · Mapa do código<\/title>/);
});

test('nada do que o Mapa do código cria é commitado: mapa-do-codigo/ ignora a si mesma', () => {
  const gi = fs.readFileSync(mapPath(root, '.gitignore'), 'utf8');
  assert.equal(gi.trim().split('\n').pop(), '*');
  assert.match(gi, /^# O Mapa do código fica fora do git/);
});

test('consulta.mjs acha coisas no mapa por palavras comuns', () => {
  const found = JSON.parse(execFileSync(process.execPath, [mapPath(root, FILES.query), 'find', 'refund'], { encoding: 'utf8' }));
  const ids = JSON.stringify(found);
  assert.ok(ids.includes('r:'), `um endpoint é encontrado: ${ids.slice(0, 300)}`);
});

test('uma atualização leva as descrições junto para um arquivo renomeado e registra as mudanças', () => {
  const descFile = mapPath(root, FILES.descriptions, 'api.json');
  const desc = { name: 'Recados dos clientes', description: 'Salva um recado que o cliente deixa.' };
  writeJson(descFile, { files: { 'shop-api/routes/notes.js': desc } });
  fs.renameSync(path.join(root, 'shop-api/routes/notes.js'), path.join(root, 'shop-api/routes/feedback.js'));
  const server = path.join(root, 'shop-api/server.js');
  fs.writeFileSync(server, fs.readFileSync(server, 'utf8').replaceAll('notes', 'feedback'));
  const out = run('refresh.mjs', root);
  assert.match(out, /Mapa do código: atualização — último mapa em /);
  assert.match(out, /arquivos {3}\+0 novos · −0 apagados · 1 movidos\/renomeados/);
  assert.match(out, /PRÓXIMOS PASSOS\n {2}1\. /);
  const files = readJson(descFile).files;
  assert.deepEqual(files['shop-api/routes/feedback.js'], desc);
  assert.equal(files['shop-api/routes/notes.js'], undefined);
  assert.equal(readGraph(root).files.find((f) => f.p === 'shop-api/routes/feedback.js').name, 'Recados dos clientes');
  const changes = readJson(mapPath(root, '.cache', 'mudancas.json'));
  assert.deepEqual(changes.files.moved, [{ from: 'shop-api/routes/notes.js', to: 'shop-api/routes/feedback.js' }]);
  assert.match(run('recent.mjs', root), /O QUE MUDOU DESDE O MAPA ANTERIOR[\s\S]*movido {3}shop-api\/routes\/notes\.js → shop-api\/routes\/feedback\.js {2}→ "Recados dos clientes" em Servidor/);
});

test('describe.mjs gera fichas em português, pedindo nomes e descrições em português', () => {
  const out = run('describe.mjs', root);
  assert.match(out, new RegExp(`ficha\\(s\\) em ${MAP}/\\.cache/worksheets/`));
  assert.match(out, /Idioma: escreva todo "name" e toda "description" em português do Brasil/);
  const sheet = fs.readFileSync(mapPath(root, '.cache', 'worksheets', 'web.md'), 'utf8');
  assert.match(sheet, /^# Ficha web: Site/);
  assert.match(sheet, /Público: todo mundo \("audience": "everyone"\)\. Escreva em português simples/);
  assert.match(sheet, new RegExp(`Escreva em: ${MAP}/descricoes/web\\.json`));
  assert.ok(fs.existsSync(mapPath(root, FILES.descriptions, 'web.json')));
});

test('status.mjs diz em português que o mapa existe', () => {
  assert.match(run('status.mjs', root), /^mapa montado em .* cobrindo \d+ arquivos, 2 nós\./);
  const empty = fs.mkdtempSync(path.join(path.dirname(root), 'mapa-vazio-'));
  try { assert.match(run('status.mjs', empty), /nenhum: ainda não há Mapa do código aqui/); } finally { cleanup(empty); }
});
