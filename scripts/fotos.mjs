#!/usr/bin/env node
// Tira as fotos do painel para o README: abre o Chrome sem janela num quadro de demonstração
// (scripts/demo.mjs) e fotografa cada tela nos temas claro e escuro. Sem dependências: fala com o
// Chrome pelo DevTools Protocol.
//
//   node scripts/fotos.mjs --base http://localhost:4395 --senha <arquivo> [--saida docs/imagens]
//                          [--so quadro,lista] [--revisao] [--banner] [--visita <horas atrás>]
//
// --revisao também fotografa as telas que não vão para o README (login, paleta, nova tarefa,
// configurações, celular), para revisar o design. --banner refaz docs/imagens/banner.png.
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback; };
const BASE = opt('base', 'http://localhost:4395');
const OUT = opt('saida', join(ROOT, 'docs/imagens'));
const ONLY = opt('so', '').split(',').filter(Boolean);
const REVIEW = args.includes('--revisao');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const PROFILE = mkdtempSync(join(tmpdir(), 'quadro-fotos-'));
const PORT = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--no-first-run',
  '--no-default-browser-check', '--hide-scrollbars', '--lang=pt-BR', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
const done = () => { chrome.kill(); try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 }); } catch {} };
process.on('exit', done);

let pageWs;
for (let i = 0; i < 80 && !pageWs; i++) {
  await sleep(200);
  try { pageWs = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page')?.webSocketDebuggerUrl; } catch {}
}
if (!pageWs) throw new Error(`O Chrome não abriu (${CHROME}). Use CHROME=<caminho> para indicar outro.`);
const ws = new WebSocket(pageWs);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const waiting = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
});
const cdp = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params }));
});
const run = async (expr) => (await cdp('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true })).result?.value;
const press = async (key, code) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
};
const viewport = (width, height, mobile = false) => cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });

await cdp('Page.enable');
await cdp('Network.enable');
// Simula uma visita anterior (padrão: dois dias atrás), para as fotos mostrarem o que é novidade.
const lastVisit = new Date(Date.now() - Number(opt('visita', 48)) * 3600000).toISOString();
await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `try { if (!sessionStorage.getItem('tk_since')) localStorage.setItem('tk_last_visit', ${JSON.stringify(lastVisit)}); } catch {}` });

// O projeto do mapa fica numa pasta temporária; nas fotos ele aparece com a pasta que teria de verdade.
const FIX_PATHS = `
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walk.nextNode());) if (/quadro-demo-[^/]*\\/claude-tasks/.test(n.nodeValue)) n.nodeValue = '~/Developer/claude-tasks';`;

const README = [
  { name: 'quadro', url: '/?project=1', wait: 1500 },
  { name: 'todas', url: '/', wait: 1500 },
  { name: 'lista', url: '/?project=1&view=list', wait: 1500 },
  { name: 'calendario', url: '/?project=1&view=calendar', wait: 1500 },
  { name: 'gantt', url: '/?project=1&view=gantt', wait: 1800 },
  { name: 'dashboard', url: '/?view=dashboard', wait: 2500 },
  { name: 'tarefa', url: '/?project=1&task=2', wait: 2000 },
  { name: 'triagem', url: '/?project=1', wait: 1500, prepare: async () => { await run("document.querySelector('[data-since=\"triage\"]').click(); await new Promise((r) => setTimeout(r, 800));"); } },
  { name: 'mapa', url: '/?project=4&view=mapa', wait: 6000 },
  { name: 'simulacao', url: '/?project=4&view=mapa', wait: 4000, prepare: async () => { await run("document.querySelector('[data-modo=\"sim\"]').click(); await new Promise((r) => setTimeout(r, 1500));"); } },
];
const EXTRA = [
  { name: 'paleta', url: '/?project=1', wait: 1500, prepare: async () => { await press('k', 'KeyK'); await sleep(500); } },
  { name: 'nova-tarefa', url: '/?project=1', wait: 1500, prepare: async () => { await press('n', 'KeyN'); await sleep(500); } },
  { name: 'atividade', url: '/?view=activity', wait: 1800 },
  { name: 'minhas', url: '/?view=list&mine=1', wait: 1500 },
  { name: 'equipe', url: '/?view=team', wait: 1500 },
  { name: 'automacoes', url: '/?view=automations', wait: 1500 },
  { name: 'configuracoes', url: '/?view=settings', wait: 1500 },
  { name: 'projeto-config', url: '/?project=1&view=project-settings', wait: 1800 },
  { name: 'celular-quadro', url: '/?project=1', wait: 1500, mobile: true },
  { name: 'celular-tarefa', url: '/?project=1&task=2', wait: 2000, mobile: true },
  { name: 'login', url: '/', wait: 1500, anonymous: true },
];

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify({ email: 'ana@exemplo.test', password: readFileSync(opt('senha', ''), 'utf8').trim() }),
  });
  if (!res.ok) throw new Error(`Login no quadro de demonstração falhou (${res.status}). Ele está rodando em ${BASE}?`);
  const [name, value] = res.headers.get('set-cookie').split(';')[0].split('=');
  return { name, value, domain: new URL(BASE).hostname, path: '/', httpOnly: true };
}
const cookie = await login();

const shots = [...README, ...(REVIEW ? EXTRA : [])].filter((s) => !ONLY.length || ONLY.includes(s.name));
for (const theme of ['light', 'dark']) {
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] });
  for (const shot of shots) {
    await cdp('Network.clearBrowserCookies');
    if (!shot.anonymous) await cdp('Network.setCookie', cookie);
    await (shot.mobile ? viewport(390, 844, true) : viewport(1440, 900));
    await cdp('Page.navigate', { url: `${BASE}${shot.url}` });
    await sleep(shot.wait);
    // Espera a tela sair do "Carregando…" (Dashboard, Atividade e as páginas buscam dados ao abrir).
    await run("const busy = () => { const t = document.querySelector('#view, body')?.innerText || ''; return /Carregando/.test(t) || document.querySelector('[aria-busy=true]') || t.trim().length < 4; }; for (let i = 0; i < 40 && busy(); i++) await new Promise((r) => setTimeout(r, 200));");
    if (shot.prepare) await shot.prepare();
    await run(FIX_PATHS);
    await sleep(400);
    const { data } = await cdp('Page.captureScreenshot', { format: 'webp', quality: 86 });
    const file = join(OUT, `${shot.name}-${theme === 'light' ? 'claro' : 'escuro'}.webp`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(file);
  }
}

if (args.includes('--banner')) {
  // O banner usa a foto do quadro no tema escuro, então ela precisa estar na pasta de saída.
  const work = mkdtempSync(join(tmpdir(), 'quadro-banner-'));
  copyFileSync(join(OUT, 'quadro-escuro.webp'), join(work, 'tela.webp'));
  copyFileSync(join(ROOT, 'scripts/fotos-banner.html'), join(work, 'banner.html'));
  copyFileSync(join(ROOT, 'public/fonts/inter-latin-wght-normal.woff2'), join(work, 'inter.woff2'));
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1280, height: 440, deviceScaleFactor: 2, mobile: false });
  await cdp('Page.navigate', { url: `file://${join(work, 'banner.html')}` });
  await sleep(1500);
  const { data } = await cdp('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'banner.png'), Buffer.from(data, 'base64'));
  rmSync(work, { recursive: true, force: true });
  console.log(join(OUT, 'banner.png'));
}
ws.close();
process.exit(0);
