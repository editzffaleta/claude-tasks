// Perguntas no mapa: o servidor.mjs roda a CLI do Claude Code ou o Codex com o login da própria pessoa, só
// lendo, e transforma os eventos deles em linhas de progresso e num quadro de resposta. CLIs de mentira
// (fixtures/fake-cli) registram o que receberam, então estes testes rodam sem nenhuma das duas instalada.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, MAP, FILES, mapPath, shopApp, run, cleanup } from './helpers.mjs';

const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-cli');
let root;
const servers = [];

/** Inicia o servidor do mapa com estas variáveis de ambiente; devolve { base, token, page, calls }. */
async function serve(env) {
  const log = path.join(root, `fake-${servers.length}.log`);
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [mapPath(root, FILES.server), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_ENGINE: '', FAKE_LOG: log, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`o servidor não iniciou: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Mapa do código: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`o servidor saiu (${code}): ${out}`)));
  });
  const html = await (await fetch(base + '/')).text();
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(html)[1]);
  return { base, token: page.token, page, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) };
}

/** Faz uma pergunta e devolve os eventos que o servidor mandou, como [{ event, data }]. */
async function ask(s, question, session) {
  const r = await fetch(s.base + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': s.token }, body: JSON.stringify({ question, session }) });
  return (await r.text()).split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
}
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

// feito "pelo Claude Code", qualquer que seja o agente que roda os testes, para a ordem dos motores abaixo ser previsível
before(() => { root = shopApp(); run('scan.mjs', root); run('build.mjs', root, '--no-claude-md', '--agent', 'claude'); });
after(async () => {
  // espera os servidores saírem antes: no Windows a pasta de trabalho deles não pode ser apagada enquanto rodam
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  cleanup(root);
});

test('com só o Codex instalado, as perguntas passam pelo Codex, só lendo e fora do histórico dele', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'nao-existe'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  assert.equal(s.page.engine, 'codex');
  assert.equal(s.page.cli, true);

  const events = await ask(s, 'Como funcionam os reembolsos?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Procurando "reembolso" no mapa', 'Lendo shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Reembolsos');
  assert.deepEqual(answer.items.map((i) => i.id), ['f:shop-api/routes/orders.js']);
  assert.match(answer.session, /^[0-9a-f]{16}$/);

  const [call] = s.calls();
  const flag = (name) => call.args[call.args.indexOf(name) + 1];
  assert.equal(call.args[0], 'exec');
  assert.equal(flag('--sandbox'), 'read-only');
  assert.ok(call.args.includes('--ephemeral'), 'nada vai para o histórico do Codex');
  // o Node roda o servidor.mjs pelo caminho real, e no macOS a pasta temporária /var/… é na verdade /private/var/…
  assert.equal(fs.realpathSync(flag('-C')), fs.realpathSync(root));
  assert.match(call.input, /O pedido:\nComo funcionam os reembolsos\?$/);
  assert.match(call.input, /português do Brasil/);
  assert.match(call.input, new RegExp(`node ${MAP}/consulta\\.mjs`), 'as instruções mandam consultar o mapa pelo consulta.mjs');
});

test('o Codex recebe um schema de resposta que ele aceita: toda propriedade obrigatória, nada a mais', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'nao-existe'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  await ask(s, 'O que é isto?');
  const { schema } = s.calls()[0];
  const check = (node, where) => {
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, where);
      assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort(), where);
      for (const [k, v] of Object.entries(node.properties)) check(v, `${where}.${k}`);
    }
    if (node.type === 'array') check(node.items, `${where}[]`);
  };
  check(schema, 'answer');
  assert.ok(schema.required.includes('steps') && schema.required.includes('followups'));
});

test('uma continuação no Codex leva junto a conversa até ali', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'nao-existe'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  const [first] = pick(await ask(s, 'Como funcionam os reembolsos?'), 'answer');
  const [second] = pick(await ask(s, 'Quem pode pedir um?', first.session), 'answer');
  assert.equal(second.session, first.session);
  const calls = s.calls();
  assert.doesNotMatch(calls[0].input, /Antes, nesta conversa/);
  assert.match(calls[1].input, /Antes, nesta conversa:\nP: Como funcionam os reembolsos\?\nR: Os reembolsos passam por/);
  // uma sessão desconhecida começa uma conversa nova
  const [other] = pick(await ask(s, 'Começar de novo', 'sessao-que-nao-existe'), 'answer');
  assert.notEqual(other.session, first.session);
  assert.doesNotMatch(s.calls()[2].input, /Antes, nesta conversa/);
});

test('um Codex sem login diz isso, para o mapa pedir que a pessoa entre', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(root, 'nao-existe'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  const [failure] = pick(await ask(s, 'pergunta SIGNED-OUT'), 'failure');
  assert.equal(failure.code, 'not_logged_in');
  assert.equal(pick(await ask(s, 'SIGNED-OUT de novo'), 'answer').length, 0);
});

test('a CLI do Claude Code vem primeiro num mapa que o Claude fez, com ferramentas só de leitura, e as continuações retomam', async () => {
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(FAKE, 'fake-codex.mjs') });
  assert.equal(s.page.engine, 'claude');
  const events = await ask(s, 'Como funcionam os reembolsos?');
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), ['Lendo a visão geral do mapa', 'Lendo shop-api/routes/orders.js']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.session, 'test-session');
  await ask(s, 'E depois?', answer.session);
  const [first, second] = s.calls();
  assert.ok(first.args.includes('-p'));
  assert.deepEqual(first.args.slice(first.args.indexOf('--allowedTools') + 1), [`Bash(node ${MAP}/consulta.mjs:*)`, 'Read', 'Grep', 'Glob']);
  assert.ok(!first.args.join(' ').match(/\b(Edit|Write)\b/), 'nenhuma ferramenta de edição');
  assert.match(first.args[first.args.indexOf('--append-system-prompt') + 1], /português do Brasil/);
  assert.equal(first.input, 'Como funcionam os reembolsos?');
  assert.equal(second.args[second.args.indexOf('--resume') + 1], 'test-session');
});

test('--engine escolhe uma CLI e nunca cai para a outra', async () => {
  const s = await serve({ FLOORPLAN_ENGINE: 'codex', FLOORPLAN_CLAUDE: path.join(FAKE, 'fake-claude.mjs'), FLOORPLAN_CODEX: path.join(root, 'nao-existe') });
  assert.equal(s.page.cli, false);
  assert.equal(s.page.want, 'codex');
  const [failure] = pick(await ask(s, 'Alguma coisa?'), 'failure');
  assert.equal(failure.code, 'cli_missing');
  assert.match(failure.message, /Não encontrei o Codex/);
});

// Windows: uma instalação mais nova do Claude Code pelo npm tem o programa de verdade em <npm>/node_modules/@anthropic-ai/claude-code/bin/claude.exe, nenhum cli.js,
// e só atalhos de shell ao lado (o "claude" sem extensão que o `where claude` lista primeiro, e o claude.cmd), que não podem ser executados. O servidor tem de usar o programa.
test('no Windows, uma instalação do Claude Code pelo npm só com bin/claude.exe é achada e executada (não o atalho)', { skip: process.platform !== 'win32' }, async () => {
  const npm = path.join(root, 'fake-npm');
  const pkg = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(npm, 'claude'), '#!/bin/sh\n'); // o atalho: um arquivo de texto que não pode ser executado
  const fakeExe = path.join(pkg, 'claude.exe');
  fs.copyFileSync(process.execPath, fakeExe); // um programa que responde a --version (uma cópia, não um link: um link não pode ser apagado depois em alguns runners do Windows)
  fs.chmodSync(fakeExe, 0o666); // a cópia mantém a marca de só leitura do Node, que impede a limpeza da pasta
  const s = await serve({ FLOORPLAN_CLAUDE: path.join(npm, 'claude'), FLOORPLAN_CODEX: path.join(root, 'nao-existe') });
  assert.equal(s.page.engine, 'claude');
  assert.equal(s.page.version, process.version);
});
