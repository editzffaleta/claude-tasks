// Gestos de toque: o mapa gerado deixa um dedo arrastá-lo, dois dedos fazerem pinça e moverem, e nenhum gesto o deixa
// travado ou o reajusta. São conferências na página gerada (as regras e o código estão lá), não numa tela de verdade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shopApp, scanAndBuild, cleanup, mapPath, FILES } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(mapPath(root, FILES.page), 'utf8'); });
after(() => cleanup(root));

test('o mapa fica com o toque, e a página não balança embaixo dele (só em telas de toque)', () => {
  assert.match(html, /#svg \{ touch-action: none; \}/); // um dedo arrasta o mapa, e a pinça não dá zoom na página inteira
  assert.match(html, /@media \(pointer: coarse\) \{ html, body \{ overscroll-behavior: none; \} \}/);
});

test('dois dedos fazem pinça no mapa (zoom em volta do ponto entre eles) e o movem, com os mesmos limites da roda do mouse', () => {
  assert.match(html, /const k = clamp\(t0\.k \* now\.d \/ pinch\.d, 0\.08, 2\.5\)/);
  assert.match(html, /const k = clamp\(state\.t\.k \* f, 0\.08, 2\.5\)/); // os limites da roda
  assert.match(html, /if \(fingers\.size === 2\) \{ if \(drag\?\.moved\) swallowClick = true; drag = null;/); // o segundo dedo encerra o arraste de um dedo
});

test('um arraste segue só o dedo que o começou, termina quando o navegador cancela o toque, e a barra de endereço do celular não reajusta o mapa', () => {
  assert.match(html, /if \(!drag \|\| ev\.pointerId !== drag\.id\) return;/);
  assert.match(html, /window\.addEventListener\('pointercancel', endDrag\)/);
  assert.match(html, /window\.addEventListener\('pointercancel', liftFinger\)/);
  assert.match(html, /if \(matchMedia\('\(pointer: coarse\)'\)\.matches && \(heightOnly \|\| drag \|\| pinch\)\) return;\n  fit\(false\);/);
});

test('um terceiro dedo é ignorado, e o clique que termina um arraste é engolido uma vez e liberado no toque seguinte, então o próximo toque funciona', () => {
  assert.match(html, /swallowClick = false; vp\.classList\.remove\('anim'\)/);
  assert.match(html, /if \(ev\.pointerType === 'touch'\) \{\n    if \(fingers\.size >= 2\) return; \/\/ a third finger is ignored/);
});

test('um toque não deixa uma dica de passar o mouse sobre os detalhes, e a dica fica dentro de uma tela estreita', () => {
  assert.match(html, /\(ev\) => \{ touching = ev\.pointerType === 'touch'; \}/);
  assert.match(html, /if \(!html \|\| touching \|\| drag\?\.moved/);
  assert.match(html, /tip\.style\.left = Math\.max\(8, x\) \+ 'px'; tip\.style\.top = Math\.max\(8, y\) \+ 'px';/);
});

test('nada disso muda o mouse: o deslize só é cancelado para um dedo, e o arraste com mouse mantém a proteção original de um clique', () => {
  assert.match(html, /if \(ev\.pointerType === 'touch'\) swallowClick = true; else svg\.addEventListener\('click', \(e\) => e\.stopPropagation\(\), \{ capture: true, once: true \}\)/);
  assert.match(html, /svg\.addEventListener\('click', \(\) => select\(null\)\);/);
});
