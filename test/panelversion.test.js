// Versão do painel: é o que faz uma janela aberta perceber que o código mudou.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { panelVersionReader } from '../src/panelversion.js';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'painel-versao-'));
  mkdirSync(join(dir, 'js'));
  writeFileSync(join(dir, 'index.html'), '<h1>Quadro</h1>');
  writeFileSync(join(dir, 'js', 'main.js'), 'console.log(1);');
});
after(() => rmSync(dir, { recursive: true, force: true }));

test('versão do painel muda com o conteúdo, mas não com a data do arquivo', () => {
  const version = panelVersionReader(dir, { maxAge: 0 });
  const v1 = version();
  assert.match(v1, /^[0-9a-f]{12}$/);
  assert.equal(version(), v1);

  // Mesmo conteúdo com outra data, como ao trocar de branch e voltar.
  const later = new Date(Date.now() + 60000);
  utimesSync(join(dir, 'js', 'main.js'), later, later);
  assert.equal(version(), v1);

  writeFileSync(join(dir, 'js', 'main.js'), 'console.log(2);');
  const v2 = version();
  assert.notEqual(v2, v1);

  writeFileSync(join(dir, 'js', 'novo.js'), '');
  const v3 = version();
  assert.notEqual(v3, v2);

  rmSync(join(dir, 'js', 'novo.js'));
  assert.equal(version(), v2);
});

test('versão do painel ignora arquivos ocultos', () => {
  const version = panelVersionReader(dir, { maxAge: 0 });
  const v1 = version();
  writeFileSync(join(dir, '.DS_Store'), 'x');
  writeFileSync(join(dir, 'js', '.DS_Store'), 'x');
  assert.equal(version(), v1);
});

test('versão do painel só confere o disco de vez em quando', () => {
  const version = panelVersionReader(dir, { maxAge: 60000 });
  const v1 = version();
  writeFileSync(join(dir, 'index.html'), '<h1>Outro</h1>');
  assert.equal(version(), v1);
  assert.notEqual(panelVersionReader(dir, { maxAge: 0 })(), v1);
});

test('versão do painel fica vazia se a pasta não existe, sem derrubar o servidor', () => {
  assert.equal(panelVersionReader(join(dir, 'nao-existe'), { maxAge: 0 })(), '');
});
