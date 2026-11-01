// Coerência do pacote: os manifestos do Claude Code e do Codex concordam (nome, versão, descrição), os dois
// marketplaces do repositório apontam para a pasta mapa/, e a skill só cita arquivos que existem. Este
// repositório não publica versões assinadas, então os testes de selo, changelog e CHECKSUMS do Floorplan
// original não se aplicam aqui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO, SKILL, readJson } from './helpers.mjs';

const BOARD_REPO = path.resolve(REPO, '..');
const plugin = readJson(path.join(REPO, '.claude-plugin', 'plugin.json'));
const codex = readJson(path.join(REPO, '.codex-plugin', 'plugin.json'));
const skill = fs.readFileSync(path.join(SKILL, 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');

test('o plugin se chama mapa-do-codigo e tem uma versão semântica', () => {
  assert.equal(plugin.name, 'mapa-do-codigo');
  assert.match(plugin.version, /^\d+\.\d+\.\d+$/);
  assert.equal(plugin.license, 'MIT');
  assert.match(plugin.description, /Mapa do código/);
  assert.match(plugin.description, /Floorplan, de Hayden Smith \(licença MIT\)/);
});

test('o plugin do Codex combina com o do Claude Code e aponta para a mesma skill', () => {
  for (const k of ['name', 'version', 'description', 'license']) assert.deepEqual(codex[k], plugin[k], `.codex-plugin/plugin.json ${k}`);
  assert.deepEqual(codex.author, plugin.author);
  assert.equal(codex.skills, './skills/');
  assert.ok(fs.existsSync(path.join(REPO, 'skills', plugin.name, 'SKILL.md')));
  assert.equal(codex.interface.displayName, 'Mapa do código');
  assert.ok(codex.interface.defaultPrompt.length >= 1);
  for (const k of ['composerIcon', 'logo']) assert.ok(fs.existsSync(path.join(REPO, codex.interface[k])), `${k}: ${codex.interface[k]}`);
  assert.ok(fs.existsSync(path.join(REPO, '.claude-plugin', 'icon.png')));
  const yaml = fs.readFileSync(path.join(SKILL, 'agents', 'openai.yaml'), 'utf8');
  assert.match(yaml, /display_name: "Mapa do código"/);
  assert.match(yaml, /\$mapa-do-codigo/);
});

test('o marketplace do Claude Code lista o plugin, a partir da pasta mapa/ deste repositório', () => {
  const market = readJson(path.join(BOARD_REPO, '.claude-plugin', 'marketplace.json'));
  assert.equal(market.name, 'claude-tasks');
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `.claude-plugin/marketplace.json lista ${plugin.name}`);
  assert.equal(entry.source, './mapa');
  assert.ok(fs.existsSync(path.join(BOARD_REPO, entry.source, '.claude-plugin', 'plugin.json')));
});

test('o marketplace do Codex lista o plugin, a partir da pasta mapa/ deste repositório', () => {
  const market = readJson(path.join(BOARD_REPO, '.agents', 'plugins', 'marketplace.json'));
  const entry = market.plugins.find((p) => p.name === plugin.name);
  assert.ok(entry, `.agents/plugins/marketplace.json lista ${plugin.name}`);
  assert.deepEqual(entry.source, { source: 'local', path: './mapa' });
  assert.ok(fs.existsSync(path.join(BOARD_REPO, entry.source.path, '.codex-plugin', 'plugin.json')));
});

/** O âncora que o GitHub dá a um título: minúsculas, sem pontuação, espaços viram hífens (acentos ficam). */
const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');
const anchorsOf = (file) => new Set([...fs.readFileSync(file, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));

test('a skill tem nome e descrição, e cada arquivo que ela cita existe', () => {
  assert.match(skill, /^---\nname: mapa-do-codigo\ndescription: .{50,}/);
  const description = /^description: (.*)$/m.exec(skill)[1];
  // dispara tanto com pedidos em português quanto em inglês
  for (const w of [/mapa do código/i, /atualize o mapa/i, /floorplan/i, /map this codebase/i]) assert.match(description, w);
  assert.doesNotMatch(skill, /\]\(references\//, 'as referências agora ficam em referencias/');
  const refs = [...skill.matchAll(/\]\((referencias\/[\w.-]+\.md)(#[^)]*)?\)/g)];
  assert.ok(refs.length >= 4);
  for (const [, ref, anchor] of refs) {
    assert.ok(fs.existsSync(path.join(SKILL, ref)), ref);
    if (anchor) assert.ok(anchorsOf(path.join(SKILL, ref)).has(decodeURIComponent(anchor.slice(1))), `${ref}${anchor}`);
  }
  for (const [, script] of skill.matchAll(/scripts\/(\w+\.mjs)/g)) assert.ok(fs.existsSync(path.join(SKILL, 'scripts', script)), script);
  assert.deepEqual(fs.readdirSync(path.join(SKILL, 'referencias')).sort(), ['escolhendo-limites.md', 'escrevendo-descricoes.md', 'esquema.md', 'planta.md']);
});

test('as referências só apontam para arquivos e títulos que existem', () => {
  const dir = path.join(SKILL, 'referencias');
  for (const name of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const [, target, anchor] of text.matchAll(/\]\(([\w.-]*\.md)?(#[^)]*)?\)/g)) {
      const file = path.join(dir, target || name);
      assert.ok(fs.existsSync(file), `${name} → ${target}`);
      if (anchor) assert.ok(anchorsOf(file).has(decodeURIComponent(anchor.slice(1))), `${name} → ${target || ''}${anchor}`);
    }
  }
});

test('os scripts da skill só mandam ler referências que existem', () => {
  const cited = [];
  for (const dir of ['scripts', path.join('scripts', 'lib'), 'assets']) {
    for (const name of fs.readdirSync(path.join(SKILL, dir)).filter((n) => /\.(mjs|js)$/.test(n))) {
      for (const [ref] of fs.readFileSync(path.join(SKILL, dir, name), 'utf8').matchAll(/(?:referencias|references)\/[\w-]+\.md/g)) cited.push(`${dir}/${name}: ${ref}`);
    }
  }
  assert.deepEqual(cited.filter((c) => !fs.existsSync(path.join(SKILL, c.split(': ')[1]))), [], 'referências citadas que não existem');
});
