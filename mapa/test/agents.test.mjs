// Claude Code e Codex: a skill percebe qual dos dois a está rodando, e o mapa guarda isso, para que a barra de
// perguntas e os botões "Corrigir com …" citem o certo. Só o Claude Code ganha a nota no CLAUDE.local.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, shopApp, run, readGraph, readJson, cleanup, mapPath, FILES } from './helpers.mjs';

const { detectAgent } = await lib('agent.mjs');

test('o Codex é reconhecido pelas variáveis que ele define em todo comando', () => {
  assert.equal(detectAgent({}, { CODEX_THREAD_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, { CODEX_SESSION_ID: 'abc' }), 'codex');
  assert.equal(detectAgent({}, {}), 'claude');
  assert.equal(detectAgent({}, { CLAUDECODE: '1' }), 'claude');
});

test('--agent e FLOORPLAN_AGENT passam por cima do palpite, e valores sem sentido são ignorados', () => {
  assert.equal(detectAgent({ agent: 'codex' }, {}), 'codex');
  assert.equal(detectAgent({ agent: 'Claude' }, { CODEX_THREAD_ID: 'abc' }), 'claude');
  assert.equal(detectAgent({}, { FLOORPLAN_AGENT: 'codex' }), 'codex');
  assert.equal(detectAgent({ agent: 'gpt' }, { CODEX_THREAD_ID: 'abc' }), 'codex');
});

test('um mapa feito pelo Codex guarda isso e não mexe nas notas do projeto', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    const out = run('build.mjs', root, '--agent', 'codex');
    assert.equal(readGraph(root).meta.agent, 'codex');
    assert.match(out, /AGENTE {2}Codex: as perguntas feitas no mapa passam pelo Codex/);
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')), 'nenhum CLAUDE.local.md');
    assert.ok(!fs.existsSync(path.join(root, 'AGENTS.md')), 'nenhum AGENTS.md');
  } finally { cleanup(root); }
});

test('um mapa feito pelo Claude Code guarda isso e só acrescenta a nota no CLAUDE.local.md quando pedem', () => {
  const root = shopApp();
  const notes = path.join(root, 'CLAUDE.local.md');
  try {
    run('scan.mjs', root);
    assert.match(run('build.mjs', root, '--agent', 'claude'), /CLAUDE\.LOCAL\.MD {2}não adicionado/);
    assert.equal(readGraph(root).meta.agent, 'claude');
    assert.ok(!fs.existsSync(notes), 'nenhum CLAUDE.local.md até a pessoa dizer que sim');
    run('build.mjs', root, '--agent', 'claude', '--claude-md');
    assert.match(fs.readFileSync(notes, 'utf8'), /mapa-do-codigo\/consulta\.mjs/);
  } finally { cleanup(root); }
});

test('uma nota que já existe no CLAUDE.local.md é mantida em dia, e o marcador de desligar continua valendo', () => {
  const root = shopApp();
  const notes = path.join(root, 'CLAUDE.local.md');
  try {
    run('scan.mjs', root);
    fs.writeFileSync(notes, 'minhas notas\n\n<!-- mapa-do-codigo:inicio -->\nvelho\n<!-- mapa-do-codigo:fim -->\n');
    run('build.mjs', root, '--agent', 'claude');
    const text = fs.readFileSync(notes, 'utf8');
    assert.match(text, /^minhas notas/);
    assert.match(text, /mapa-do-codigo\/consulta\.mjs/);
    assert.doesNotMatch(text, /\nvelho\n/);
    fs.writeFileSync(notes, 'minhas notas\n<!-- mapa-do-codigo:desligado -->\n');
    assert.match(run('build.mjs', root, '--agent', 'claude', '--claude-md'), /CLAUDE\.LOCAL\.MD {2}ignorado \(desligado pelo usuário\)/);
    assert.equal(fs.readFileSync(notes, 'utf8'), 'minhas notas\n<!-- mapa-do-codigo:desligado -->\n');
  } finally { cleanup(root); }
});

test('a cópia para o app do Claude sempre diz Claude, não importa quem montou o mapa', () => {
  const root = shopApp();
  try {
    run('scan.mjs', root);
    run('build.mjs', root, '--agent', 'codex', '--artifact', '--no-claude-md');
    const html = fs.readFileSync(mapPath(root, FILES.artifact), 'utf8');
    assert.match(html, /"agent":"claude"/);
    assert.match(html, /"root":null/);
    assert.ok(!fs.existsSync(mapPath(root, 'artifact.html')), 'o nome antigo não é usado');
    assert.equal(readJson(mapPath(root, FILES.graph)).meta.agent, 'codex');
  } finally { cleanup(root); }
});
