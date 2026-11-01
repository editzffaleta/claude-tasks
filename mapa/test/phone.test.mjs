// Layout de celular: o mapa gerado tem uma barra de cima que quebra em duas linhas em vez de sair da tela, botões só com
// ícone que continuam com nome, alvos de toque de 44 px e uma folha de detalhes que abre ao tocar num cartão. São
// conferências na página gerada (as regras e o código estão lá, e a linha de início roda num navegador de mentira), não
// numa tela de verdade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { shopApp, scanAndBuild, cleanup, mapPath, FILES } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(mapPath(root, FILES.page), 'utf8'); });
after(() => cleanup(root));

/** O CSS de todos os blocos @media da página com exatamente esta condição, juntos (uma página pode ter vários com a mesma condição). */
function media(condition) {
  let out = '', from = 0, found = 0;
  for (;;) {
    const start = html.indexOf(`@media ${condition} {`, from);
    if (start < 0) break;
    let depth = 0, i = html.indexOf('{', start);
    const open = i + 1;
    for (; i < html.length; i++) { if (html[i] === '{') depth++; else if (html[i] === '}' && --depth === 0) break; }
    out += html.slice(open, i) + '\n'; found++; from = i;
  }
  assert.ok(found > 0, `a página tem um bloco de regras para ${condition}`);
  return out;
}

test('em celulares e tablets a barra de cima quebra numa segunda linha, então nada sai da tela', () => {
  const css = media('(max-width: 999px), (max-width: 1279px) and (pointer: coarse)');
  assert.match(css, /header \{[^}]*display: flex; flex-wrap: wrap;/);
  assert.match(css, /\.hr \{[^}]*flex-wrap: wrap;/);
  assert.match(css, /\.hr \.btn \.bl \{ display: none; \}/);
});

test('com mouse a partir de 1000 px a barra de cima fica exatamente como era: toda mudança nela está dentro de uma regra de celular/tablet', () => {
  assert.match(html, /header \{ position: fixed; inset: 0 0 auto 0; height: 64px; display: grid; grid-template-columns: 1fr auto 1fr;/);
  const outside = html.replace(/@media [^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g, '');
  assert.doesNotMatch(outside, /header \{[^}]*flex-wrap/);
  assert.doesNotMatch(outside, /\.hr \.btn \.bl \{ display: none/);
  assert.doesNotMatch(outside, /#btn-up, \.brand \{ flex: none; \}/); // a seta de subir e o logo não mudam no computador
  assert.doesNotMatch(outside, /header \.btn:focus-visible/);
});

test('todo controle da barra tem um nome que continua quando as palavras somem', () => {
  const header = html.match(/<header>[\s\S]*?<\/header>/)[0];
  const buttons = [...header.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 5);
  for (const b of buttons) assert.match(b, /aria-label="[^"]+"/, `${b} tem aria-label`);
  // os botões das extensões ganham o texto como nome, e a Saúde diz quantos pontos precisam de atenção
  assert.match(html, /if \(label\) b\.setAttribute\('aria-label', label\)/);
  assert.match(html, /btn\.setAttribute\('aria-label', btn\.title\)/);
});

test('os alvos de toque têm pelo menos 44 px em telas pequenas e de toque, inclusive os botões de zoom', () => {
  const css = media('(max-width: 999px), (pointer: coarse)');
  assert.match(css, /header \.btn, #search-btn \{ height: 44px; min-width: 44px; \}/);
  assert.match(css, /header \.btn\.icon \{ width: 44px; \}/);
  assert.match(css, /#zoom button \{ width: 44px; height: 44px; \}/);
  assert.match(css, /#ask-mode button \{ height: 44px; \}/); // a chave Perguntar / Alterar também
});

test('no celular, perguntar ou rascunhar uma mudança fecha antes a folha de detalhes, e o resumo depois de uma mudança também, para nada esconder a barra Perguntar nem o resumo', () => {
  assert.match(html, /ask: \(text\) => \{ closeSheet\(\); askInput\.value = text; submitAsk\(\); \}/);
  assert.match(html, /draftChange\(text\) \{\s*if \(!canChange\(\)\) return false;\s*closeSheet\(\);/);
  assert.match(html, /function showChangeResult\(\) \{[\s\S]*?closeSheet\(\);[\s\S]*?sheetShell\(c\.question,/);
});

test('no celular o painel de detalhes é uma folha embaixo que começa fechada e não cobre a barra Perguntar', () => {
  const css = media('(max-width: 700px)');
  assert.match(css, /#panel \{ top: auto; left: 8px; right: 8px; bottom: 8px; width: auto; max-height: min\(56vh, 480px\); \}/);
  assert.match(css, /body:not\(\.no-panel\) #ask \{ display: none; \}/);
  assert.match(css, /#panel-resize \{ display: none; \}/);
});

test('no celular, tocar num cartão abre os detalhes; entrar ou sair de um cartão, ou tocar no vazio, fecha', () => {
  assert.match(html, /if \(sel && isPhone\(\) && document\.body\.classList\.contains\('no-panel'\)\) \{ setPanel\(true\); if \(typeof sel === 'string'\) bringIntoView\(sel\); \}/);
  assert.match(html, /svg\.addEventListener\('click', closeSheet\);/);
  assert.match(html, /closeSheet\(\);\n  go\(item, \{ zoomFrom: item \}\);/);
  assert.match(html, /function up\(\) \{ if \(state\.container === 'root'\) return; closeSheet\(\);/);
  // a escolha no celular não é salva, para não fechar o painel lateral num computador que divide o armazenamento
  assert.match(html, /if \(!isPhone\(\)\) store\.set\('panel', on\);/);
});

test('a altura da barra de cima é medida, e tudo embaixo dela acompanha', () => {
  assert.match(html, /new ResizeObserver\(syncHeader\)\.observe\(headerEl\)/);
  for (const sel of ['#context', '#flowbar', '#panel', '#panel-resize']) assert.match(html, new RegExp(`${sel} \\{[^}]*calc\\(var\\(--hh, 64px\\) \\+ \\d+px\\)`), `${sel} acompanha a barra`);
});

test('a animação é desligada para quem pede menos movimento', () => {
  const css = media('(prefers-reduced-motion: reduce) and (max-width: 999px), (prefers-reduced-motion: reduce) and (pointer: coarse)');
  assert.match(css, /#panel, body\.no-panel #panel, #viewport\.anim, #ask, #flowbar, #zoom button \{ transition: none; \}/);
});

/** Roda o script de início de uma linha (antes de qualquer desenho) num navegador de mentira. */
function startUp({ phone, hash = '' }) {
  const classes = new Set();
  const script = html.match(/<body>\s*<script>([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script, {
    matchMedia: (q) => ({ matches: phone && q.includes('max-width: 700px') }),
    location: { hash },
    document: { body: { classList: { add: (c) => classes.add(c) } } },
  });
  return classes;
}

test('o celular começa com os detalhes fechados (para não piscarem abertos), a não ser que o link aponte para um cartão', () => {
  assert.ok(startUp({ phone: true }).has('no-panel'));
  assert.ok(!startUp({ phone: true, hash: '#v=a&s=n:web' }).has('no-panel'));
  assert.ok(!startUp({ phone: false }).has('no-panel'));
});

test('abrir a folha de detalhes no celular não reajusta o mapa', () => {
  assert.match(html, /if \(was !== on && !isPhone\(\)\) fit\(true\);/);
});

test('Fluxos e Filtros abrem dentro da tela, onde quer que a barra tenha quebrado', () => {
  assert.match(media('(max-width: 999px), (max-width: 1279px) and (pointer: coarse)'), /header \.rel \{ position: static; \}[^\n]*\n  #flowmenu, #legend \{ position: fixed;/);
});

test('em tablets e celulares os botões de zoom saem de baixo da barra Perguntar', () => {
  assert.match(html, /@media \(max-width: 999px\), \(max-width: 1279px\) and \(pointer: coarse\) \{\n  header \.hr \.btn \{ width: 44px; \}[\s\S]*?#zoom \{ left: auto; right: calc\(var\(--pw\) \+ 16px\); bottom: auto; top: calc\(var\(--hh, 56px\) \+ 8px\);/);
});

test('a folha do celular se alcança e fecha pelo teclado: Esc fecha, fechada ela some do Tab e dos leitores de tela, o foco entra e volta', () => {
  assert.match(media('(max-width: 700px)'), /body\.no-panel #panel \{[^}]*visibility: hidden;/);
  assert.match(html, /else if \(isPhone\(\) && !document\.body\.classList\.contains\('no-panel'\)\) closeSheet\(\);/);
  assert.match(html, /panel\.setAttribute\('role', 'dialog'\); panel\.setAttribute\('aria-label', 'Detalhes'\)/);
  assert.match(html, /if \(on && keyboardUser\) \{ sheetReturn = document\.activeElement; panel\.focus/);
  assert.match(html, /sheetReturn\.focus\?\./);
});

test('no celular a descrição se dobra numa linha, com um botão Mais / Menos que diz se está aberta e é lembrado', () => {
  const css = media('(max-width: 700px)');
  assert.match(css, /#context\.folded \.cd \{ display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 1; overflow: hidden; \}/);
  assert.match(css, /#context \.ctx-more:not\(\[hidden\]\) \{ display: inline-flex; align-items: center; min-height: 44px;/);
  assert.match(html, /\.ctx-more \{ display: none; \}/); // só o celular mostra
  assert.match(html, /<button type="button" class="ctx-more" aria-controls="ctx-desc" hidden><\/button>/);
  assert.match(html, /more\.setAttribute\('aria-expanded', String\(open\)\);/);
  assert.match(html, /store\.set\('contextOpen', !open\)/);
  assert.match(html, /desc\.inert = isPhone\(\) && long && !open;/); // as linhas escondidas não recebem foco pelo Tab
});

test('no celular o aviso sobre conectar uma ferramenta de IA só aparece enquanto a barra Perguntar está em uso, e é lido quando aparece', () => {
  assert.match(media('(max-width: 700px)'), /#ask:not\(\.asking\) #ask-warn \{ display: none; \}/);
  assert.match(html, /<div id="ask-live" role="status" aria-live="polite"><\/div>/);
  assert.match(html, /\['pointerdown', 'touchstart', 'focusin'\]\.forEach\(\(t\) => askBox\.addEventListener\(t, \(\) => askOn\(true\)/); // um toque conta mesmo com o campo desligado
  assert.match(html, /askBox\.addEventListener\('focusout', \(ev\) => \{ if \(!askBox\.contains\(ev\.relatedTarget\)\) askOn\(false\); \}\);/);
  assert.match(html, /const on = isPhone\(\) && askInput\.disabled && !warn\.hidden; if \(on\) \{ askForm\.tabIndex = 0;/); // quem usa teclado alcança o aviso quando o campo está desligado
});

test('no celular os botões de zoom ficam lado a lado na linha de cima, ao lado do ícone de busca', () => {
  assert.match(media('(max-width: 700px)'), /header #zoom \{ position: static; flex: none; flex-direction: row;/);
  assert.match(html, /if \(isPhone\(\)\) headerEl\.insertBefore\(zoomEl, headerEl\.querySelector\('\.hc'\)\); else zoomHome\.insertBefore\(zoomEl, zoomNext\);/);
  assert.match(media('(max-width: 700px)'), /#crumbs button:not\(\.cur\), #crumbs \.sep \{ display: none; \}/); // o caminho mostra onde você está, para a linha caber em 360 px
});

test('nada novo aparece no computador: os botões não ganharam dicas novas', () => {
  assert.doesNotMatch(html, /id="search-btn" title=/);
  assert.doesNotMatch(html, /id="flows-btn" title=/);
});

test('no toque, o campo e os botões do pedido de tarefa do quadro também têm 44 px', () => {
  assert.match(html, /@media \(pointer: coarse\) \{ \.tqf input, \.tqf \.tqa \.btn \{ height: 44px; \} \}/);
});

test('com mouse a partir de 1000 px, a barra só vira ícones quando os rótulos não cabem, e os botões continuam com nome', () => {
  // a regra fica num bloco próprio de 1000 px para cima e só vale com a classe que o fitHeader põe quando falta espaço
  assert.match(media('(min-width: 1000px)'), /body\.hdr-compact \.hr \.btn \.bl \{ display: none; \}/);
  assert.match(html, /const tight = headerEl\.scrollWidth > headerEl\.clientWidth \+ 1 \|\| hl\.clientWidth < brand\.scrollWidth \+ 100;/);
  assert.match(html, /const on = wideBar\.matches && !tabletBar\.matches && tight;/);
  assert.match(html, /const syncHeader = \(\) => \{ fitHeader\(\);/);
  assert.match(html, /if \(on\) flowsBtn\.title = 'Fluxos'; else flowsBtn\.removeAttribute\('title'\);/); // o único botão sem dica ganha uma só nesse modo
});
