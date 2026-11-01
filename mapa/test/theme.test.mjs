// Claro e escuro: o mapa gerado traz os dois temas, escolhe um antes de desenhar qualquer coisa e tem um botão de Tema.
// O script de início roda aqui num navegador de mentira, então a lógica da escolha é conferida sem um de verdade.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { shopApp, scanAndBuild, cleanup, mapPath, FILES } from './helpers.mjs';

let root, html;
before(() => { root = shopApp(); scanAndBuild(root); html = fs.readFileSync(mapPath(root, FILES.page), 'utf8'); });
after(() => cleanup(root));

const bootScript = () => {
  const at = html.indexOf('/* Theme: runs before');
  return html.slice(html.lastIndexOf('<script>', at) + '<script>'.length, html.indexOf('</script>', at));
};

/** Roda o script de início com um aparelho de mentira e devolve o que ele fez na página. */
function boot({ saved, deviceLight = false, storageThrows = false } = {}) {
  const attrs = {}, classes = new Set(), store = new Map(saved ? [['floorplan-theme', saved]] : []);
  const listeners = {}, events = [];
  const mq = { matches: deviceLight, addEventListener: (_, f) => { mq.change = f; } };
  const win = {
    document: { documentElement: { setAttribute: (k, v) => { attrs[k] = v; }, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } } },
    matchMedia: () => mq,
    localStorage: { getItem: (k) => { if (storageThrows) throw new Error('blocked'); return store.get(k) ?? null; }, setItem: (k, v) => { if (storageThrows) throw new Error('blocked'); store.set(k, v); } },
    addEventListener: (t, f) => { listeners[t] = f; },
    dispatchEvent: (e) => { events.push(e.type); },
    Event: class { constructor(type) { this.type = type; } },
    requestAnimationFrame: (f) => f(),
  };
  win.window = win;
  vm.runInNewContext(bootScript(), Object.assign(win, { Event: win.Event }));
  return { attrs, store, mq, events, theme: win.floorplanTheme, classes };
}

test('a página tem um conjunto de cores escuro e um claro, e o escuro continua o padrão', () => {
  assert.match(html, /:root \{[^}]*--bg: #0f0f0f;/);
  assert.match(html, /:root\[data-theme="light"\] \{[^}]*--bg: #f3f3f1;/);
  assert.match(html, /:root\[data-theme="light"\] \{[^}]*color-scheme: light;/);
  // toda variável de cor que o escuro define também ganha um valor no claro
  const vars = (block) => new Set([...block.matchAll(/(--[\w-]+):/g)].map((m) => m[1]));
  const dark = vars(html.match(/\n:root \{([\s\S]*?)\n\}/)[1]);
  const light = vars(html.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)[1]);
  const sameInBoth = new Set(['--sans', '--mono', '--r-card', '--r-panel', '--r-ctl', '--ease', '--ease-io', '--panel-w', '--pw', '--gutter', '--m-ANY', '--focus']);
  for (const v of dark) assert.ok(light.has(v) || sameInBoth.has(v), `${v} não tem valor no claro`);
});

test('a página não pinta mais com tons brancos fixos, que sumiriam no claro', () => {
  // o próprio bloco do claro pode usar branco (caixas brancas); no resto, os tons passam por --ink
  const outsideLight = html.replace(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/, '');
  const left = outsideLight.match(/rgba\(255, 255, 255, [.\d]+\)/g) || [];
  assert.equal(left.length, 0, `sobraram tons brancos fixos: ${left.join(' ')}`);
});

test('o script de início fica no head, antes de a página ser desenhada', () => {
  assert.ok(html.indexOf('Theme: runs before') < html.indexOf('<style>'), 'o script vem antes dos estilos');
  assert.ok(html.indexOf('Theme: runs before') < html.indexOf('<body>'));
});

test('a página é em português do Brasil', () => {
  assert.match(html, /^<!doctype html>\n<html lang="pt-BR">/);
  assert.doesNotMatch(html, /lang="en"/);
});

test('Automático segue o aparelho, ao vivo', () => {
  const dark = boot({ deviceLight: false });
  assert.equal(dark.attrs['data-theme'], 'dark');
  const light = boot({ deviceLight: true });
  assert.equal(light.attrs['data-theme'], 'light');
  dark.mq.matches = true; dark.mq.change();
  assert.equal(dark.attrs['data-theme'], 'light');
});

test('uma escolha salva vale mais que o aparelho, e uma escolha nova é salva', () => {
  assert.equal(boot({ saved: 'dark', deviceLight: true }).attrs['data-theme'], 'dark');
  assert.equal(boot({ saved: 'light', deviceLight: false }).attrs['data-theme'], 'light');
  const b = boot({ deviceLight: false });
  b.theme.set('light');
  assert.equal(b.store.get('floorplan-theme'), 'light');
  assert.equal(b.attrs['data-theme'], 'light');
  assert.equal(b.theme.get(), 'light');
  assert.ok(b.events.length >= 2, 'o botão fica sabendo');
});

test('um valor salvo desconhecido é ignorado, e com o armazenamento bloqueado a escolha ainda vale nesta visita', () => {
  assert.equal(boot({ saved: 'purple', deviceLight: false }).attrs['data-theme'], 'dark');
  const b = boot({ storageThrows: true, deviceLight: false });
  b.theme.set('light');
  assert.equal(b.attrs['data-theme'], 'light');
  assert.equal(b.theme.get(), 'light');
});

test('o botão de Tema está na página com um nome simples em português, alvo de 44 px e anel de foco visível', () => {
  assert.match(html, /\/\* ui\/05-theme\.js \*\//);
  assert.ok(html.includes('Tema: ${NAME[c]}. Pressione para mudar para ${WORD[NEXT[c]]}.'));
  assert.ok(html.includes("auto: 'Automático (segue o dispositivo)', light: 'Claro', dark: 'Escuro'"));
  assert.ok(html.includes('O tema agora é ${next === \'auto\' ? \'automático, seguindo o dispositivo\' : WORD[next]}.'));
  assert.match(html, /#theme-toggle \{[^}]*width: 44px; height: 44px;/);
  assert.match(html, /#theme-toggle:focus-visible \{ outline: 2px solid/);
  assert.match(html, /prefers-reduced-motion: reduce\) \{ #theme-toggle/);
});

test('no claro, o texto no selo vermelho e âmbar da Saúde é legível (4,5:1 ou mais)', () => {
  const light = html.match(/:root\[data-theme="light"\] \{([\s\S]*?)\n\}/)[1];
  const get = (name) => light.match(new RegExp(`${name}: (#[0-9a-f]{3,6})`, 'i'))[1].replace(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i, '#$1$1$2$2$3$3');
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const chip of ['--sev-high', '--sev-medium']) assert.ok(ratio(get('--on-sev-text'), get(chip)) >= 4.5, `o selo ${chip} está fraco demais`);
  assert.ok(ratio(get('--text-3'), get('--raise')) >= 4.5, 'o texto da busca está fraco demais');
});

test('as contagens de tarefas do quadro nos cartões usam só as cores do tema, então funcionam no claro e no escuro', () => {
  const css = html.match(/\n\.tq \{[^}]*\}/)?.[0];
  assert.ok(css, 'a página tem o selo de tarefas');
  assert.match(css, /color: var\(--text-2\)/);
  assert.match(css, /box-shadow: inset 0 0 0 1px rgba\(var\(--ink\), \.18\)/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b/i, 'nenhuma cor fixa');
});

test("a busca cede o espaço do botão de Tema, para o nome do projeto e os botões caberem como antes", () => {
  assert.match(html, /@media \(min-width: 701px\) \{ #search-btn \{ width: min\(460px, max\(calc\(36vw - 48px\), 250px\)\); \} \}/);
});
