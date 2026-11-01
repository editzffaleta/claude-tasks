#!/usr/bin/env node
// mapa-do-codigo/servidor.mjs: mostra este mapa localmente e responde perguntas sobre o código pela CLI do
// Claude Code ou pelo Codex. Gerado pelo build.mjs; precisa só do Node 18+ e de um `claude` ou `codex` com login.
//
// uso: node mapa-do-codigo/servidor.mjs [--port 4378] [--engine claude|codex] [--model <modelo>] [--claude <caminho>] [--codex <caminho>]
//                                       [--no-open] [--idle-exit <minutos>]
//      node mapa-do-codigo/servidor.mjs --stop
//      node mapa-do-codigo/servidor.mjs --export [<arquivo>] [--include flows,notes,recent,health]   (uma cópia para compartilhar; padrão flows,notes)
//
// O servidor escuta só em 127.0.0.1. Cada pergunta roda na raiz do código, na conta da própria pessoa:
// `claude -p` com ferramentas só de leitura (Read, Grep, Glob e Bash limitado a mapa-do-codigo/consulta.mjs) ou
// `codex exec` no sandbox só de leitura. Usa o agente que fez o mapa; se ele não estiver instalado, o outro.
// Quando o mapa é refeito, as abas abertas recarregam sozinhas. O servidor em execução fica anotado em
// .cache/server.json. Todo o trabalho fica em servidor-nucleo.mjs, que o quadro de tarefas também usa.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMapServer, exportMap, EXPORT_DEFAULT, engineInfo } from './servidor-nucleo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf('--' + name); return i < 0 ? dflt : argv[i + 1]; };
const has = (name) => argv.includes('--' + name);
const stateFile = path.join(here, '.cache', 'server.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };

if (has('stop')) {
  const s = readState();
  let stopped = false;
  if (s?.pid) { try { process.kill(s.pid); stopped = true; } catch {} }
  try { fs.unlinkSync(stateFile); } catch {}
  console.log(stopped ? `Servidor do mapa parado (${s.url}).` : 'O servidor do mapa não estava rodando.');
  process.exit(0);
}

if (has('export')) {
  const dest = opt('export');
  const include = String(opt('include', EXPORT_DEFAULT.join(','))).split(',').map((s) => s.trim().toLowerCase());
  try {
    const x = exportMap(here, include);
    const file = path.resolve(dest && !dest.startsWith('--') ? dest : path.join(here, x.name));
    fs.writeFileSync(file, x.html);
    console.log(`Mapa exportado para ${file}`);
    const label = { flows: 'os fluxos e o tour', notes: 'as notas', recent: 'o trabalho recente', health: x.plan ? 'a revisão da planta' : 'a verificação de saúde' };
    console.log(`Inclui: o mapa${x.include.map((p) => ', ' + label[p]).join('')}. Um arquivo só, que abre em qualquer navegador, sem a barra de perguntas.`);
    if (x.include.includes('health') && !x.plan) console.log('Inclui a verificação de saúde: quais endpoints estão abertos e onde há segredos no código (nunca os valores). Compartilhe só com pessoas de confiança.');
    process.exit(0);
  } catch (e) { console.error(`✗ Não consegui exportar o mapa: ${e.message}`); process.exit(1); }
}

const wantPort = Number(opt('port', 4378));
const mapa = createMapServer({
  root, mapDir: here,
  engine: opt('engine'), model: opt('model'), claudePath: opt('claude'), codexPath: opt('codex'),
  idleExit: Number(opt('idle-exit', 0)), // para tanto tempo depois que a última aba fecha (0 = nunca)
  onIdle: () => process.exit(0),
});
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

let port = wantPort;
const server = http.createServer(async (req, res) => {
  // só os nomes desta máquina: um site que aponta o próprio domínio para 127.0.0.1 (DNS rebinding) contaria
  // como a mesma origem do mapa e poderia ler o token da página
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || '').toLowerCase())) { res.writeHead(403); return res.end('host desconhecido'); }
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith('/api/')) {
    if (!(await mapa.handle(req, res, url.pathname.slice('/api/'.length)))) { res.writeHead(404); res.end(); }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html;
    try { html = mapa.page(); } catch (e) { res.writeHead(404, { 'Content-Type': TYPES['.html'] }); return res.end(e.message); }
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  let file;
  try { file = path.join(here, decodeURIComponent(url.pathname)); } catch { res.writeHead(400); return res.end('endereço inválido'); }
  // só dentro desta pasta: uma vizinha como ../mapa-do-codigo-antigo/ também começa com o caminho desta pasta
  if (!file.startsWith(here + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('não encontrado'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
// outro mapa (ou outra coisa) na porta: usa a próxima livre
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && port < wantPort + 20) { port++; server.listen(port, '127.0.0.1'); return; }
  console.error(`✗ Não consegui iniciar o servidor do mapa: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1');
server.on('listening', () => {
  const u = `http://127.0.0.1:${port}`;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port, url: u, token: mapa.token, hash: mapa.hash, startedAt: new Date().toISOString() }, null, 2));
  } catch {}
  const forget = () => { try { if (readState()?.pid === process.pid) fs.unlinkSync(stateFile); } catch {} };
  process.on('exit', () => { mapa.close(); forget(); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => process.exit(0));
  const s = mapa.info();
  const want = engineInfo(s.want);
  console.log(`Mapa do código: ${u}`);
  console.log(s.cli
    ? `perguntas pela ${s.engine === 'codex' ? 'CLI do Codex' : 'CLI do Claude Code'} ${s.version || ''} (${mapa.cliPath()})${s.model ? `, modelo ${s.model}` : ''}`
    : `Não encontrei ${want.the}: o mapa funciona, mas para perguntar é preciso instalar essa ferramenta (${want.site}). Se ela estiver num lugar fora do comum, use --${s.want} <caminho>.`);
  if (!has('no-open')) {
    const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
    try { spawn(opener[0], opener[1], { stdio: 'ignore', detached: true }).unref(); } catch {}
  }
});
