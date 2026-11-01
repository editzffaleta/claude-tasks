#!/usr/bin/env node
// Varredura do Mapa do código: encontra todos os repositórios sob a raiz do código, lista os arquivos,
// extrai imports, símbolos e rotas/chamadas HTTP, resolve tudo e grava mapa-do-codigo/.cache/scan.json.
// Imprime um resumo compacto para o Claude ou o Codex ler (o JSON em si pode ser grande).
//
// uso: node scan.mjs [raiz] [--out <arquivo>] [--include-worktrees] [--max-file-kb 2048]

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { discover, gitFiles, gitInfo, classify, toPosix, parseArgs, fmtNum, HARD_IGNORE_DIRS, MAP_DIR, OTHER_MAP_DIRS, isMapDir, mapDir, keepOutOfGit } from './lib/common.mjs';
import { extract, callableCallsVia } from './lib/extract.mjs';
import { findIssues } from './lib/health.mjs';
import { findScreens } from './lib/screens.mjs';
import { createResolver } from './lib/resolve.mjs';
import { resolveRoutes, matchCalls } from './lib/routes.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = args.out ? path.dirname(path.dirname(path.resolve(args.out))) : mapDir(root);
const outFile = path.resolve(args.out || path.join(outDir, '.cache', 'scan.json'));
const maxBytes = (Number(args['max-file-kb']) || 2048) * 1024;
const t0 = Date.now();
const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

// ---------- 1. discover repos and files ----------
const found = discover(root, { includeWorktrees: !!args['include-worktrees'] });
const repos = [];
const fileList = []; // { path, repo }
const seen = new Set();
// pastas de mapa (a nossa, ou uma do Floorplan) são saída gerada, não código
const mapDirs = new Map();
const inMap = (p) => {
  const segs = p.split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] !== MAP_DIR && !OTHER_MAP_DIRS.includes(segs[i])) continue;
    const d = segs.slice(0, i + 1).join('/');
    if (!mapDirs.has(d)) mapDirs.set(d, isMapDir(path.join(root, d)));
    if (mapDirs.get(d)) return true;
  }
  return false;
};
const ignoredByDir = (p) => p.split('/').some((seg) => HARD_IGNORE_DIRS.has(seg)) || inMap(p);

for (const r of found.repos) {
  const listed = gitFiles(r.abs);
  const info = gitInfo(r.abs);
  const prefix = r.path === '.' ? '' : r.path + '/';
  let count = 0;
  for (const f of listed || []) {
    const p = prefix + f;
    if (seen.has(p) || ignoredByDir(p)) continue;
    seen.add(p);
    fileList.push({ path: p, repo: r.path });
    count++;
  }
  repos.push({ path: r.path, name: path.basename(r.abs), ...info, files: count, ...(r.worktreeOf ? { worktreeOf: toPosix(r.worktreeOf) } : {}) });
}
for (const p of found.loose) if (!seen.has(p) && !inMap(p)) { seen.add(p); fileList.push({ path: p, repo: null }); }

// ---------- 2. classify, read, extract ----------
const files = [];
for (const { path: p, repo } of fileList) {
  const abs = path.join(root, p);
  let st;
  try { st = fs.statSync(abs); } catch { continue; }
  if (!st.isFile()) continue;
  const { category, lang } = classify(p, st.size);
  const f = { path: p, repo, category, lang, bytes: st.size, loc: 0 };
  if ((category === 'code' || category === 'config' || category === 'docs') && st.size <= maxBytes) {
    let src;
    try { src = fs.readFileSync(abs, 'utf8'); } catch { src = ''; }
    if (src.includes('\u0000')) { f.category = 'asset'; files.push(f); continue; }
    f.loc = src.split('\n').filter((l) => l.trim()).length;
    if (category === 'code' && src.length) {
      try { Object.assign(f, extract(src, lang, p)); } catch (e) { f.extractError = String(e.message || e); }
      // h: exact content. sig: the parts a description depends on (exports, routes, docstring),
      // so edits inside function bodies don't mark a file's description as stale.
      f.h = hash(src);
      f.sig = hash(JSON.stringify([(f.symbols || []).map((s) => s.name).sort(), (f.routes || []).map((r) => `${r.method} ${r.path}`).sort(), f.doc || '']));
    }
    // extension hooks: per-file health findings (lib/health.mjs) and app screens (lib/screens.mjs)
    if (src.length) {
      try { const iss = findIssues(src, f); if (iss?.length) f.issues = iss; } catch (e) { f.healthError = String(e.message || e); }
      try { const scr = findScreens(src, f); if (scr?.length) f.screens = scr; } catch (e) { f.screensError = String(e.message || e); }
    }
  } else if (category === 'code' || category === 'config' || category === 'docs') {
    // too big to read and parse, but still on the map: count its lines without loading it all
    f.tooLarge = true;
    f.loc = countLines(abs);
  }
  files.push(f);
}

/** Lines in a file, read in chunks so a huge file is never held in memory at once. */
function countLines(abs) {
  let fd, n = 0, last = 10;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(1 << 20);
    for (let got; (got = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      for (let i = 0; i < got; i++) if (buf[i] === 10) n++;
      last = buf[got - 1];
    }
  } catch { return 0; } finally { if (fd !== undefined) fs.closeSync(fd); }
  return n + (last === 10 ? 0 : 1);
}

// ---------- 3. resolve imports ----------
const resolve = createResolver(root, files);
const edges = [];
const externals = new Map(); // `${eco}:${name}` -> { eco, name, count, files:Set }
const extEdges = [];
let unresolved = 0;
for (const f of files) {
  if (!f.imports) continue;
  for (const imp of f.imports) {
    const res = resolve(f, imp);
    if (res.file || res.files) {
      imp.files = res.files || [res.file];
      const targets = res.files ? res.files.map((t, i) => [t, res.names?.[i]]) : [[res.file, null]];
      for (const [to, subName] of targets) {
        if (to === f.path) continue;
        edges.push({ from: f.path, to, names: subName ? [] : (imp.names || []), line: imp.line, ...(imp.dynamic ? { dynamic: true } : {}) });
      }
    } else if (res.external) {
      const key = `${res.eco}:${res.external}`;
      if (!externals.has(key)) externals.set(key, { eco: res.eco, name: res.external, count: 0, files: new Set() });
      const e = externals.get(key);
      e.count++;
      e.files.add(f.path);
      extEdges.push({ from: f.path, pkg: key });
    } else if (res.unresolved) unresolved++;
  }
}
// merge duplicate edges (same from/to)
const edgeMap = new Map();
for (const e of edges) {
  const k = e.from + '\u0000' + e.to;
  const prev = edgeMap.get(k);
  if (prev) { prev.names = [...new Set([...prev.names, ...e.names])]; prev.count++; }
  else edgeMap.set(k, { ...e, count: 1 });
}

// Firebase callable helpers used from other files: `import { callFunction } from '../lib/firebase'`,
// then callFunction('approveItem', data) calls the approveItem function
const wrappers = new Map(files.filter((f) => f.callableWrappers).map((f) => [f.path, new Set(f.callableWrappers)]));
if (wrappers.size) for (const f of files) {
  const via = (f.imports || []).flatMap((imp) => Object.entries(imp.locals || {}).filter(([, orig]) => imp.files?.some((t) => wrappers.get(t)?.has(orig))).map(([local]) => local));
  if (!via.length) continue;
  let src;
  try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
  for (const local of via) f.calls = [...(f.calls || []), ...callableCallsVia(src, local)];
}

// ---------- 4. routes and HTTP calls ----------
const routes = resolveRoutes(files);
const http = matchCalls(files, routes);
const hosts = [];
for (const f of files) for (const h of f.hosts || []) hosts.push({ from: f.path, host: h.host, line: h.line });

// ---------- 5. write scan.json ----------
const scan = {
  version: 1,
  generatedAt: new Date().toISOString(),
  root: toPosix(root),
  rootName: path.basename(root),
  repos,
  skipped: found.skipped,
  files: files.map((f) => ({
    path: f.path, repo: f.repo, category: f.category, lang: f.lang, loc: f.loc, bytes: f.bytes,
    ...(f.doc ? { doc: f.doc } : {}),
    ...(f.h ? { h: f.h, sig: f.sig } : {}),
    ...(f.symbols?.length ? { symbols: f.symbols } : {}),
    ...(f.tooLarge ? { tooLarge: true } : {}),
    ...(f.issues ? { issues: f.issues } : {}),
    ...(f.screens ? { screens: f.screens } : {}),
    ...(f.triggers ? { triggers: f.triggers } : {}),
  })),
  edges: [...edgeMap.values()].map(({ from, to, names, count, dynamic }) => ({ from, to, ...(names.length ? { names } : {}), ...(count > 1 ? { count } : {}), ...(dynamic ? { dynamic } : {}) })),
  externals: [...externals.values()].map((e) => ({ id: `${e.eco}:${e.name}`, eco: e.eco, name: e.name, imports: e.count, files: e.files.size })),
  extEdges: dedupeExt(extEdges),
  routes,
  http,
  hosts,
};
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(scan));
if (!args.out) keepOutOfGit(outDir);

function dedupeExt(list) {
  const m = new Map();
  for (const e of list) { const k = e.from + '|' + e.pkg; m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].map(([k, count]) => { const [from, pkg] = k.split('|'); return { from, pkg, count }; });
}

// ---------- 6. summary for Claude ----------
const code = scan.files.filter((f) => f.category === 'code');
const out = [];
const line = (s = '') => out.push(s);
line(`Mapa do código: varredura de ${scan.rootName}  (${((Date.now() - t0) / 1000).toFixed(1).replace('.', ',')}s) -> ${toPosix(path.relative(root, outFile))}`);
line();
line(`REPOSITÓRIOS (${repos.length})`);
for (const r of repos) line(`  ${r.path.padEnd(40)} ${String(r.files).padStart(6)} arquivos  ${r.branch || '-'}@${(r.head || '').slice(0, 8)}${r.worktreeOf ? '  (worktree)' : ''}`);
const looseCount = scan.files.filter((f) => f.repo === null).length;
if (looseCount) line(`  (fora de qualquer repositório)${''.padEnd(10)} ${String(looseCount).padStart(6)} arquivos`);
const wts = found.skipped.filter((s) => s.reason.includes('worktree'));
if (wts.length) line(`  ${wts.length} worktree(s) duplicado(s) ignorado(s), por exemplo ${wts.slice(0, 3).map((s) => s.path).join(', ')}`);
const dumps = found.skipped.filter((s) => s.reason.includes('despejo de dados'));
if (dumps.length) line(`  ${dumps.length} pasta(s) grande(s) fora do git ignorada(s), por exemplo ${dumps.slice(0, 2).map((s) => s.path).join(', ')}`);
line();

const byCat = {};
for (const f of scan.files) byCat[f.category] = (byCat[f.category] || 0) + 1;
line(`ARQUIVOS  ${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
const byLang = {};
for (const f of code) { byLang[f.lang] ??= { files: 0, loc: 0 }; byLang[f.lang].files++; byLang[f.lang].loc += f.loc; }
line(`CÓDIGO  ${Object.entries(byLang).sort((a, b) => b[1].loc - a[1].loc).slice(0, 10).map(([k, v]) => `${k} ${v.files} arquivos/${fmtNum(v.loc)} linhas`).join(' · ')}`);
line();

// árvore de pastas do código, agrupando as pequenas
line('ÁRVORE DO CÓDIGO (arquivos / linhas; pastas com menos de 2% do código ficam agrupadas)');
const tree = { children: new Map(), files: 0, loc: 0 };
for (const f of code) {
  let node = tree;
  node.files++; node.loc += f.loc;
  const parts = f.path.split('/').slice(0, -1);
  for (const part of parts) {
    if (!node.children.has(part)) node.children.set(part, { children: new Map(), files: 0, loc: 0 });
    node = node.children.get(part);
    node.files++; node.loc += f.loc;
  }
}
const minLoc = Math.max(50, tree.loc * 0.02);
const printTree = (node, prefix, depth) => {
  const kids = [...node.children.entries()].sort((a, b) => b[1].loc - a[1].loc);
  const shown = kids.filter(([, n]) => n.loc >= minLoc);
  for (const [name, n] of shown) {
    line(`${prefix}${name}/`.padEnd(64) + `${String(n.files).padStart(5)}  ${fmtNum(n.loc).padStart(6)}`);
    if (depth < 5) printTree(n, prefix + '  ', depth + 1);
  }
  const rest = kids.length - shown.length;
  if (rest > 0) { const rf = kids.slice(shown.length).reduce((s, [, n]) => s + n.files, 0); line(`${prefix}… ${rest} pasta(s) menor(es), ${rf} arquivos`); }
};
printTree(tree, '  ', 0);
line();

// entrypoint candidates
const ENTRY = /(^|\/)(main|index|app|server|cli|manage|wsgi|asgi|__main__|program|lib)\.(py|ts|tsx|js|mjs|go|rs|java|kt|cs|rb)$|(^|\/)app\/(page|layout)\.(t|j)sx?$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)Dockerfile[^/]*$|(^|\/)(docker-compose|compose)\.ya?ml$|(^|\/)(cloudbuild|serverless|vercel|netlify|fly|render|app)\.(ya?ml|json|toml)$/i;
const entries = scan.files.filter((f) => ENTRY.test(f.path) && f.path.split('/').length <= 5).map((f) => f.path);
line(`POSSÍVEIS PONTOS DE ENTRADA / DEPLOY (${entries.length})`);
for (const e of entries.slice(0, 30)) line(`  ${e}`);
if (entries.length > 30) line(`  … mais ${entries.length - 30}`);
line();

// directory-level dependency clusters
const dirOf = (p, depth) => p.split('/').slice(0, -1).slice(0, depth).join('/') || '.';
const depthFor = (p) => {
  const r = p.split('/');
  return Math.min(r.length - 1, 3 + (repos.length > 1 ? 1 : 0));
};
const dirEdges = new Map();
for (const e of scan.edges) {
  const a = dirOf(e.from, depthFor(e.from)), b = dirOf(e.to, depthFor(e.to));
  if (a === b) continue;
  const k = `${a} -> ${b}`;
  dirEdges.set(k, (dirEdges.get(k) || 0) + (e.count || 1));
}
line(`IMPORTS  ${scan.edges.length} ligações arquivo->arquivo resolvidas, ${unresolved} sem resolver. As mais pesadas, pasta->pasta:`);
for (const [k, v] of [...dirEdges.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) line(`  ${String(v).padStart(5)}  ${k}`);
line();

line(`HTTP  ${routes.length} definições de rota, ${http.length} chamadas ligadas a uma rota (ligações entre arquivos que os imports não mostram)`);
const httpDir = new Map();
for (const h of http) {
  const k = `${dirOf(h.from, depthFor(h.from))} -> ${dirOf(h.to, depthFor(h.to))}`;
  httpDir.set(k, (httpDir.get(k) || 0) + 1);
}
for (const [k, v] of [...httpDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) line(`  ${String(v).padStart(5)}  ${k}`);
line();

// Cloud Functions do Firebase: os endpoints já estão na linha HTTP; as de segundo plano precisam de um lugar no mapa
const fbRoutes = files.flatMap((f) => (f.routes || []).filter((r) => r.framework === 'firebase'));
const triggers = files.flatMap((f) => (f.triggers || []).map((t) => ({ ...t, file: f.path })));
if (fbRoutes.length || triggers.length) {
  const callable = fbRoutes.filter((r) => r.method === 'CALL').length;
  line(`FUNÇÕES DO FIREBASE  ${callable} callable, ${fbRoutes.length - callable} onRequest, ${triggers.length} em segundo plano`);
  if (triggers.length) {
    line('  em segundo plano (agendamentos e gatilhos; coloque-as num nó worker):');
    for (const t of triggers.slice(0, 20)) line(`    ${t.name}  ${t.on}${t.what ? ` "${t.what}"` : ''}  ${t.file}:${t.line}`);
    if (triggers.length > 20) line(`    … mais ${triggers.length - 20}`);
  }
  line();
}

const topExt = scan.externals.sort((a, b) => b.files - a.files).slice(0, 25);
line(`PACOTES EXTERNOS (pelo número de arquivos que importam cada um; até ${topExt.length})`);
line('  ' + topExt.map((e) => `${e.id}(${e.files})`).join('  '));
const hostCounts = new Map();
for (const h of hosts) hostCounts.set(h.host, (hostCounts.get(h.host) || 0) + 1);
if (hostCounts.size) {
  line(`HOSTS EXTERNOS chamados pelo código`);
  line('  ' + [...hostCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([h, c]) => `${h}(${c})`).join('  '));
}
line();
const big = code.filter((f) => f.loc > 1500).sort((a, b) => b.loc - a.loc).slice(0, 10);
if (big.length) { line('MAIORES ARQUIVOS'); for (const f of big) line(`  ${fmtNum(f.loc).padStart(6)}  ${f.path}`); line(); }
const unread = files.filter((f) => f.tooLarge).sort((a, b) => b.bytes - a.bytes);
if (unread.length) {
  line(`NÃO LIDOS  ${unread.length} arquivo(s) acima de ${fmtNum(maxBytes / 1024)} KB: estão no mapa, mas os imports, endpoints, requisições e segredos deles não foram verificados. Rode scan.mjs de novo com --max-file-kb <maior> para lê-los.`);
  for (const f of unread.slice(0, 15)) line(`  ${fmtNum(Math.round(f.bytes / 1024)).padStart(6)} KB  ${f.path}`);
  if (unread.length > 15) line(`  … mais ${unread.length - 15}`);
  line();
}
line(`Próximo passo: leia referencias/esquema.md, explore os pontos de entrada, depois escreva ${MAP_DIR}/arquitetura.json e rode build.mjs.`);
console.log(out.join('\n'));
