#!/usr/bin/env node
// Mostra o mapa ao usuário depois de um build ou refresh. Reaproveita o servidor deste mapa se ele estiver
// rodando (as abas abertas já recarregaram sozinhas), reinicia se servidor.mjs ou servidor-nucleo.mjs mudou,
// senão inicia em segundo plano e abre uma aba no navegador. Mostra o endereço e como parar.
// uso: node open.mjs [raiz] [--no-open] [--port N] [--engine claude|codex] [--model M] [--claude CAMINHO] [--codex CAMINHO]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs, mapDir } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const dir = mapDir(root);
const serveFile = path.join(dir, 'servidor.mjs');
const stateFile = path.join(dir, '.cache', 'server.json');
const rel = path.relative(process.cwd(), dir).replace(/\\/g, '/') || '.';
const IDLE_MINUTES = 120;

if (!fs.existsSync(path.join(dir, 'index.html')) || !fs.existsSync(serveFile) || !fs.existsSync(path.join(dir, 'servidor-nucleo.mjs'))) {
  console.error('✗ Ainda não há um mapa pronto aqui. Rode o build.mjs primeiro.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
async function api(s, p) {
  try {
    const r = await fetch(s.url + p, { headers: { 'x-floorplan-token': s.token }, signal: AbortSignal.timeout(3000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
function openBrowser(u) {
  const [cmd, a] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true }).unref(); return true; } catch { return false; }
}
// a mesma impressão digital que o servidor informa em /api/status (serverHash, em servidor-nucleo.mjs)
const hash = (() => {
  const h = crypto.createHash('sha1');
  for (const f of ['servidor.mjs', 'servidor-nucleo.mjs']) { try { h.update(fs.readFileSync(path.join(dir, f))); } catch {} h.update('\0'); }
  return h.digest('hex').slice(0, 12);
})();

let s = readState();
let status = s?.pid && alive(s.pid) ? await api(s, '/api/status') : null;
let restarted = false;
const hadTabs = status?.tabs > 0;

if (status && status.hash !== hash) {
  // este build trouxe um servidor mais novo: reinicia para o mapa usá-lo; as abas abertas reconectam e recarregam
  try { process.kill(s.pid); } catch {}
  for (let i = 0; i < 20 && alive(s.pid); i++) await sleep(150);
  status = null;
  restarted = true;
}

if (!status) {
  const pass = ['port', 'engine', 'model', 'claude', 'codex'].flatMap((k) => (args[k] ? ['--' + k, String(args[k])] : []));
  if (!args.port && s?.port) pass.push('--port', String(s.port)); // mantém o endereço que as pessoas já têm aberto
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const log = fs.openSync(path.join(dir, '.cache', 'server.log'), 'w');
  const prev = s?.pid;
  spawn(process.execPath, [serveFile, '--no-open', '--idle-exit', String(IDLE_MINUTES), ...pass], {
    cwd: root, detached: true, stdio: ['ignore', log, log], windowsHide: true,
  }).unref();
  // achar a CLI do Claude Code ou do Codex leva alguns segundos antes de o servidor escutar
  for (let i = 0; i < 100; i++) {
    await sleep(200);
    const n = readState();
    if (n?.pid && n.pid !== prev && alive(n.pid)) { s = n; status = await api(s, '/api/status'); if (status) break; }
  }
  if (!status) {
    console.error(`✗ O servidor do mapa não iniciou. O log dele está em ${rel}/.cache/server.log. O mapa ainda abre como arquivo: ${rel}/index.html`);
    process.exit(1);
  }
  // as abas de antes de um reinício voltam sozinhas em poucos segundos
  if (restarted && hadTabs) for (let i = 0; i < 50 && !(status?.tabs > 0); i++) { await sleep(200); status = await api(s, '/api/status'); }
}

const health = await api(s, '/api/health');
let shown;
if (status.tabs > 0) shown = `já aberto em ${status.tabs === 1 ? 'uma aba do navegador' : status.tabs + ' abas do navegador'}, que recarregaram com o mapa mais recente`;
else if (args['no-open']) shown = 'não aberto no navegador (--no-open): abra o endereço você mesmo';
else shown = openBrowser(s.url) ? 'aberto no navegador' : 'não deu para abrir um navegador: abra o endereço você mesmo';

console.log(`MAPA  ${s.url}  (${shown})`);
const CLI = {
  claude: { by: 'pela CLI do Claude Code', of: 'da CLI do Claude Code', found: 'encontrada', docs: 'https://docs.claude.com/en/docs/claude-code' },
  codex: { by: 'pelo Codex', of: 'do Codex', found: 'encontrado', docs: 'https://developers.openai.com/codex' },
};
const want = CLI[health?.want] || CLI.claude;
console.log(health?.cli
  ? `PERGUNTAS  funcionam: rodam ${(CLI[health.engine] || CLI.claude).by}${health.version ? ' (' + health.version + ')' : ''}`
  : `PERGUNTAS  precisam ${want.of}, que não foi ${want.found}; o mapa em si funciona (${want.docs})`);
console.log(`SERVIDOR  roda em segundo plano, atualiza as abas abertas quando o mapa é refeito e para sozinho ${IDLE_MINUTES / 60} horas depois que a última aba fecha. Para parar agora: node ${rel}/servidor.mjs --stop`);
