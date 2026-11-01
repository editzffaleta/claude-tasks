#!/usr/bin/env node
// Atualização do Mapa do código: põe um mapa existente em dia sem refazer tudo.
// Varre de novo, compara com a última montagem (grafo.json), concilia descricoes/*.json (renomeações
// levam a descrição junto, itens apagados saem, itens cujas exportações/endpoints mudaram ganham o campo
// "review"), monta de novo e diz exatamente o que sobrou para o agente olhar.
//
// uso: node refresh.mjs [raiz] [--from-code]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileGlob, parseArgs, mapDir, MAP_DIR, MAP_FILES } from './lib/common.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const graphFile = path.join(outDir, MAP_FILES.graph);
const archFile = path.join(outDir, MAP_FILES.arch);
if (!fs.existsSync(graphFile) || !fs.existsSync(archFile)) {
  console.log(`Não há mapa aqui (${MAP_DIR}/${MAP_FILES.graph} + ${MAP_FILES.arch}). Faça o mapa completo do zero.`);
  process.exit(0);
}
const old = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const arch = JSON.parse(fs.readFileSync(archFile, 'utf8'));

// Uma planta é redesenhada a partir de plano.json, não do código. --from-code mapeia o código de verdade
// (plano.json fica guardado, então a planta pode ser desenhada de novo com plan.mjs + build.mjs).
if (old.meta?.blueprint && !args['from-code']) {
  const run = (script, ...rest) => execFileSync(process.execPath, [path.join(HERE, script), root, ...rest], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    process.stdout.write(run('plan.mjs') + '\n' + run('build.mjs', ...process.argv.slice(2).filter((a) => a.startsWith('--'))));
  } catch (e) { process.stdout.write(String(e.stdout || '')); process.exit(1); }
  console.log(`\nPRÓXIMO  Este mapa é uma planta, redesenhada a partir de ${MAP_DIR}/${MAP_FILES.plan}. Para mudar o plano, edite ${MAP_FILES.plan} e ${MAP_FILES.arch}. Quando o código existir, rode refresh.mjs --from-code para ter um mapa do código de verdade; ${MAP_FILES.plan} continua guardado.`);
  process.exit(0);
}

// ---------- 1. varre de novo (sem gastar tokens) ----------
const node = process.execPath;
execFileSync(node, [path.join(HERE, 'scan.mjs'), root], { stdio: ['ignore', 'ignore', 'inherit'] });
const scan = JSON.parse(fs.readFileSync(path.join(outDir, '.cache', 'scan.json'), 'utf8'));

const include = Array.isArray(arch.include) ? arch.include : ['code'];
const ignore = (arch.ignore || []).map(compileGlob);
const now = new Map(scan.files.filter((f) => include.includes(f.category) && !ignore.some((g) => g.test(f.path))).map((f) => [f.path, f]));
const before = new Map(old.files.map((f) => [f.p, f]));

// ---------- 2. diff files ----------
const added = [...now.keys()].filter((p) => !before.has(p));
const removed = [...before.keys()].filter((p) => !now.has(p));
const edited = [...now.keys()].filter((p) => before.has(p) && before.get(p).h && now.get(p).h !== before.get(p).h);
const digestChanged = edited.filter((p) => before.get(p).sig && now.get(p).sig !== before.get(p).sig);

// renames: same content, or same file name + same digest
const renames = new Map();
const addedLeft = new Set(added);
for (const r of removed) {
  const o = before.get(r);
  let match = o.h ? [...addedLeft].find((a) => now.get(a).h === o.h) : null;
  if (!match) {
    const cands = [...addedLeft].filter((a) => path.posix.basename(a) === path.posix.basename(r) && (!o.sig || now.get(a).sig === o.sig));
    if (cands.length === 1) match = cands[0];
  }
  if (match) { renames.set(r, match); addedLeft.delete(match); }
}
const deleted = removed.filter((r) => !renames.has(r));
const created = [...addedLeft];

// o que mudou nas exportações/endpoints de um arquivo, para a nota de revisão
const oldRoutesByFile = new Map();
for (const r of old.routes || []) { if (!oldRoutesByFile.has(r.f)) oldRoutesByFile.set(r.f, []); oldRoutesByFile.get(r.f).push(`${r.m} ${r.p}`); }
const newRoutesByFile = new Map();
for (const r of scan.routes) { if (!newRoutesByFile.has(r.file)) newRoutesByFile.set(r.file, []); newRoutesByFile.get(r.file).push(`${r.method} ${r.path}`); }
function changeNote(p, prevPath = p) {
  const o = before.get(prevPath), n = now.get(p);
  const os = new Set((o.s || []).map((s) => s[0])), ns = new Set((n.symbols || []).map((s) => s.name));
  const plus = [...ns].filter((x) => !os.has(x)), minus = [...os].filter((x) => !ns.has(x));
  const orr = new Set(oldRoutesByFile.get(prevPath) || []), nr = new Set(newRoutesByFile.get(p) || []);
  const rPlus = [...nr].filter((x) => !orr.has(x)).length, rMinus = [...orr].filter((x) => !nr.has(x)).length;
  const parts = [];
  if (plus.length) parts.push(`exportações novas: ${plus.slice(0, 6).join(', ')}${plus.length > 6 ? '…' : ''}`);
  if (minus.length) parts.push(`exportações removidas: ${minus.slice(0, 6).join(', ')}${minus.length > 6 ? '…' : ''}`);
  if (rPlus) parts.push(`${rPlus} endpoint(s) novo(s)`);
  if (rMinus) parts.push(`${rMinus} endpoint(s) removido(s)`);
  if (!parts.length) parts.push('a docstring ou a estrutura mudou');
  return parts.join('; ');
}

// ---------- 3. diff routes ----------
const oldRouteKeys = new Map((old.routes || []).map((r) => [`${r.m} ${r.p}`, r]));
const newRouteKeys = new Map(scan.routes.map((r) => [`${r.method} ${r.path}`, r]));
const routeMoves = new Map(); // old key -> new key (same handler in the same / renamed file)
const goneRoutes = [...oldRouteKeys.keys()].filter((k) => !newRouteKeys.has(k));
const newRoutes = new Set([...newRouteKeys.keys()].filter((k) => !oldRouteKeys.has(k)));
for (const k of goneRoutes) {
  const o = oldRouteKeys.get(k);
  const file = renames.get(o.f) || o.f;
  const m = [...newRoutes].find((nk) => { const n = newRouteKeys.get(nk); return n.file === file && o.h && n.handler === o.h; });
  if (m) { routeMoves.set(k, m); newRoutes.delete(m); }
}

// ---------- 4. concilia as descrições ----------
const descDir = path.join(outDir, MAP_FILES.descriptions);
let carried = 0, pruned = 0, flagged = 0, routeCarried = 0, routePruned = 0;
const digestSet = new Set(digestChanged);
if (fs.existsSync(descDir)) {
  for (const name of fs.readdirSync(descDir).filter((n) => n.endsWith('.json'))) {
    const fp = path.join(descDir, name);
    let d;
    try { d = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
    let changed = false;
    const filesOut = {};
    for (const [p, v] of Object.entries(d.files || {})) {
      if (renames.has(p)) {
        const np = renames.get(p);
        filesOut[np] = now.get(np).sig !== before.get(p).sig ? { ...v, review: `movido de ${p}; ${changeNote(np, p)}` } : v;
        carried++; changed = true;
      } else if (deleted.includes(p)) { pruned++; changed = true; }
      else if (digestSet.has(p) && v.description) { filesOut[p] = { ...v, review: changeNote(p) }; flagged++; changed = true; }
      else filesOut[p] = v;
    }
    const routesOut = {};
    for (const [k, v] of Object.entries(d.routes || {})) {
      if (routeMoves.has(k)) { routesOut[routeMoves.get(k)] = { ...v, review: `o caminho mudou de ${k}` }; routeCarried++; changed = true; }
      else if (!newRouteKeys.has(k) && oldRouteKeys.has(k)) { routePruned++; changed = true; }
      else routesOut[k] = v;
    }
    if (changed) {
      const outObj = { files: filesOut, ...(Object.keys(routesOut).length ? { routes: routesOut } : {}) };
      if (!Object.keys(filesOut).length && !Object.keys(routesOut).length) fs.unlinkSync(fp);
      else fs.writeFileSync(fp, JSON.stringify(outObj, null, 2) + '\n');
    }
  }
}

// o que mudou desde a última montagem, para o recent.mjs (marcar o trabalho recente no mapa)
fs.writeFileSync(path.join(outDir, '.cache', 'mudancas.json'), JSON.stringify({
  since: old.meta.generatedAt, at: new Date().toISOString(),
  files: { new: created, edited: edited.filter((p) => !created.includes(p)), moved: [...renames].map(([a, b]) => ({ from: a, to: b })), deleted },
  routes: { new: [...newRoutes], removed: goneRoutes.filter((k) => !routeMoves.has(k)), moved: [...routeMoves].map(([a, b]) => ({ from: a, to: b })) },
}, null, 2));

// ---------- 5. monta de novo (sem gastar tokens) ----------
let buildOut = '';
let buildOk = true;
try { buildOut = execFileSync(node, [path.join(HERE, 'build.mjs'), root], { encoding: 'utf8' }); }
catch (e) { buildOut = (e.stdout || '') + (e.stderr || ''); buildOk = false; }

// ---------- 6. relatório ----------
const since = new Date(old.meta.generatedAt);
const L = [];
L.push(`Mapa do código: atualização — último mapa em ${since.toLocaleString('pt-BR')}`);
L.push(`  arquivos   +${created.length} novos · −${deleted.length} apagados · ${renames.size} movidos/renomeados (descrições mantidas) · ${edited.length} editados, ${digestChanged.length} com exportações/endpoints mudados`);
L.push(`  endpoints  +${newRoutes.size} novos · −${goneRoutes.length - routeMoves.size} removidos · ${routeMoves.size} com caminho novo (descrições mantidas)`);
L.push(`  descrições: ${carried + routeCarried} mantidas, ${pruned + routePruned} removidas, ${flagged} marcadas para revisão`);
if (!before.values().next().value?.h) L.push('  (o mapa anterior é de antes das impressões digitais de conteúdo, então as edições desde então não puderam ser detectadas; as próximas atualizações vão detectar)');
const byDir = new Map();
for (const p of created) { const d = p.split('/').slice(0, -1).join('/'); byDir.set(d, (byDir.get(d) || 0) + 1); }
if (byDir.size) {
  L.push('  arquivos novos, por pasta:');
  for (const [d, c] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) L.push(`    ${String(c).padStart(4)}  ${d}/`);
}
L.push('');
L.push('MONTAGEM');
L.push(buildOut.split('\n').filter((l) => /^(✗|!|  - |ATRIBUIÇÃO|  não atribuídos|    |DESCRIÇÕES|  Rode describe|✓)/.test(l)).slice(0, 40).join('\n'));
L.push('');
const todo = [];
if (!buildOk) todo.push(`Corrija os erros de montagem acima em ${MAP_FILES.arch} (normalmente um passo de fluxo ou uma anotação apontando para um arquivo apagado) e depois rode build.mjs.`);
if (/não atribuídos, por pasta/.test(buildOut)) todo.push(`Arquivos novos ficaram fora de todos os nós: acrescente globs (ou um nó) em ${MAP_FILES.arch} para as pastas listadas em "não atribuídos".`);
if (/Rode describe/.test(buildOut)) todo.push('Rode describe.mjs: ele gera fichas só para os itens novos e marcados. Preencha-as em português (apague cada campo "review" quando o item estiver certo) e depois rode build.mjs.');
if (created.length + deleted.length > Math.max(20, before.size * 0.15)) todo.push('Esta é uma mudança grande: releia os resumos dos módulos que ganharam ou perderam muitos arquivos e confira se os fluxos ainda valem.');
todo.push(`Marque o trabalho recente: rode recent.mjs, reescreva ${MAP_FILES.recent} com o que acabou de ser feito (uma lista "tasks" vazia se nada foi feito) e depois rode build.mjs.`);
L.push('PRÓXIMOS PASSOS');
todo.forEach((t, i) => L.push(`  ${i + 1}. ${t}`));
console.log(L.join('\n'));
