#!/usr/bin/env node
// Montagem do Mapa do código: confere mapa-do-codigo/arquitetura.json com a varredura, coloca cada
// arquivo num nó, liga imports, chamadas HTTP e serviços externos, e grava mapa-do-codigo/grafo.json +
// mapa-do-codigo/index.html (mais servidor.mjs, servidor-nucleo.mjs e consulta.mjs ao lado).
//
// uso: node build.mjs [raiz] [--arch <arquivo>] [--scan <arquivo>] [--out <pasta>] [--check]
//      [--artifact] [--agent claude|codex] [--claude-md | --no-claude-md]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileGlob, parseArgs, fmtNum, mapDir, keepOutOfGit, MAP_DIR, MAP_FILES } from './lib/common.mjs';
import { fallbackFileName, fallbackRouteName, routeKey } from './lib/names.mjs';
import { buildHealth } from './lib/health.mjs';
import { buildPlanHealth } from './lib/blueprint.mjs';
import { buildScreens } from './lib/screens.mjs';
import { writeClaudeMd } from './lib/claudemd.mjs';
import { detectAgent } from './lib/agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.resolve(HERE, '..');
const args = parseArgs(process.argv.slice(2));
const agent = detectAgent(args);
const root = path.resolve(args._[0] || '.');
const outDir = path.resolve(args.out || mapDir(root));
const archFile = path.resolve(args.arch || path.join(outDir, MAP_FILES.arch));
const scanFile = path.resolve(args.scan || path.join(outDir, '.cache', 'scan.json'));

export const NODE_KINDS = ['ui', 'service', 'worker', 'library', 'feature', 'data', 'config', 'test', 'script', 'infra', 'external'];
export const EDGE_KINDS = ['import', 'call', 'http', 'rpc', 'event', 'queue', 'data', 'config'];

const errors = [];
const warnings = [];
const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
if (!fs.existsSync(scanFile)) fail(`Não há varredura em ${scanFile}. Rode: node ${path.join(SKILL_DIR, 'scripts', 'scan.mjs')} "${root}"`);
if (!fs.existsSync(archFile)) fail(`Não há arquivo de arquitetura em ${archFile}. Escreva-o primeiro (veja referencias/esquema.md).`);
const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
let arch;
try { arch = JSON.parse(fs.readFileSync(archFile, 'utf8')); } catch (e) { fail(`${MAP_FILES.arch} não é um JSON válido: ${e.message}`); }

// ---------- validate shape ----------
const isStr = (v) => typeof v === 'string' && v.length > 0;
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
function closest(word, options) {
  let best = null, bestD = Infinity;
  for (const o of options) {
    const d = lev(word, o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return bestD <= Math.max(2, word.length / 3) ? best : null;
}
function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) { const tmp = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = tmp; }
  }
  return dp[b.length];
}
const didYouMean = (w, opts) => { const c = closest(w, opts); return c ? ` — você quis dizer "${c}"?` : ''; };

if (!arch || typeof arch !== 'object') fail(`${MAP_FILES.arch} precisa ser um objeto`);
if (!arch.project || !isStr(arch.project.name)) err('project.name é obrigatório');
if (!Array.isArray(arch.nodes) || !arch.nodes.length) err('nodes precisa ser uma lista não vazia');
const nodes = Array.isArray(arch.nodes) ? arch.nodes : [];
const archEdges = Array.isArray(arch.edges) ? arch.edges : [];
const flows = Array.isArray(arch.flows) ? arch.flows : [];
const annotations = Array.isArray(arch.annotations) ? arch.annotations : [];
const include = isStrArr(arch.include) ? arch.include : ['code'];
const ignoreGlobs = (isStrArr(arch.ignore) ? arch.ignore : []).map(compileGlob);
// para quem as descrições são escritas: "everyone" (português simples, o padrão) ou "developers"
const AUDIENCES = ['everyone', 'developers'];
if (arch.audience !== undefined && !AUDIENCES.includes(arch.audience)) err(`audience "${arch.audience}" precisa ser um destes: ${AUDIENCES.join(', ')}${didYouMean(String(arch.audience), AUDIENCES)}`);
const audience = AUDIENCES.includes(arch.audience) ? arch.audience : 'everyone';

const byId = new Map();
nodes.forEach((n, i) => {
  const where = `nodes[${i}]${n?.id ? ` ("${n.id}")` : ''}`;
  if (!n || typeof n !== 'object') return err(`${where} precisa ser um objeto`);
  if (!isStr(n.id)) return err(`${where}.id é obrigatório`);
  if (!/^[A-Za-z0-9_.\-]+$/.test(n.id)) err(`${where}.id só pode ter letras sem acento, dígitos, "_", "-" e "."`);
  if (n.id === 'unassigned') err(`${where}.id "unassigned" é reservado`);
  if (byId.has(n.id)) err(`${where}.id repete um nó anterior`);
  byId.set(n.id, n);
  if (!isStr(n.label)) err(`${where}.label é obrigatório`);
  if (!NODE_KINDS.includes(n.kind)) err(`${where}.kind "${n.kind}" precisa ser um destes: ${NODE_KINDS.join(', ')}${didYouMean(String(n.kind), NODE_KINDS)}`);
  for (const k of ['paths', 'exclude', 'packages', 'hosts', 'tags']) if (n[k] !== undefined && !isStrArr(n[k])) err(`${where}.${k} precisa ser uma lista de textos`);
  if (n.kind === 'external' && n.paths?.length) warn(`${where} é external mas tem paths; nós externos normalmente não têm arquivos`);
});
const ids = [...byId.keys()];
for (const n of nodes) {
  if (n?.parent === undefined) continue;
  if (!byId.has(n.parent)) err(`nó "${n.id}".parent "${n.parent}" não existe${didYouMean(n.parent, ids)}`);
}
// cycles + depth
const depthOf = new Map();
const depth = (id, seen = new Set()) => {
  if (depthOf.has(id)) return depthOf.get(id);
  if (seen.has(id)) { err(`o nó "${id}" faz parte de um ciclo de parent`); return 0; }
  seen.add(id);
  const n = byId.get(id);
  const d = n?.parent && byId.has(n.parent) ? depth(n.parent, seen) + 1 : 0;
  depthOf.set(id, d);
  return d;
};
ids.forEach((id) => depth(id));

// ---------- files ----------
const filesAll = scan.files;
const fileByPath = new Map(filesAll.map((f) => [f.path, f]));
const included = filesAll.filter((f) => include.includes(f.category) && !ignoreGlobs.some((g) => g.test(f.path)));
const includedSet = new Set(included.map((f) => f.path));

// ---------- assign files to nodes ----------
// A node's `exclude` also applies to its descendants, so "web excludes tests" holds all the way down.
const inheritedExcludes = (n, seen = new Set()) => {
  if (!n || seen.has(n.id)) return [];
  seen.add(n.id);
  return [...(isStrArr(n.exclude) ? n.exclude : []), ...(n.parent ? inheritedExcludes(byId.get(n.parent), seen) : [])];
};
const matchers = nodes.filter((n) => n?.id && isStrArr(n.paths ?? [])).map((n, order) => ({
  id: n.id, order, depth: depthOf.get(n.id) || 0,
  paths: (n.paths || []).map(compileGlob), exclude: inheritedExcludes(n).map(compileGlob), hits: new Array((n.paths || []).length).fill(0),
}));
const owner = new Map();
let ambiguous = 0;
const ambiguousEx = [];
for (const f of included) {
  let best = null, bestKey = null, tie = null;
  for (const m of matchers) {
    if (m.exclude.some((g) => g.test(f.path))) continue;
    let spec = -1;
    m.paths.forEach((g, i) => { if (g.test(f.path)) { m.hits[i]++; spec = Math.max(spec, g.specificity); } });
    if (spec < 0) continue;
    const key = [m.depth, spec];
    if (!best || key[0] > bestKey[0] || (key[0] === bestKey[0] && key[1] > bestKey[1])) { best = m; bestKey = key; tie = null; }
    else if (key[0] === bestKey[0] && key[1] === bestKey[1]) tie = m.id;
  }
  if (tie) { ambiguous++; if (ambiguousEx.length < 3) ambiguousEx.push(`${f.path} (${best.id} vs ${tie})`); }
  owner.set(f.path, best ? best.id : 'unassigned');
}
for (const m of matchers) m.hits.forEach((h, i) => { if (!h) warn(`o path "${m.paths[i].glob}" do nó "${m.id}" não pega nenhum arquivo incluído`); });
if (ambiguous) warn(`${ambiguous} arquivo(s) se encaixaram igualmente em dois nós irmãos; ficou com o declarado primeiro. Deixe os globs mais específicos ou acrescente um exclude. Por exemplo: ${ambiguousEx.join('; ')}`);

// ---------- endpoints ----------
const resolveEndpoint = (ref, where) => {
  if (!isStr(ref)) { err(`${where} precisa ser um id de nó ou um caminho de arquivo`); return null; }
  if (byId.has(ref)) return `n:${ref}`;
  const p = ref.replace(/^file:/, '');
  if (includedSet.has(p)) return `f:${p}`;
  if (fileByPath.has(p)) { err(`${where} "${ref}" é um arquivo que não está incluído (categoria ${fileByPath.get(p).category}); aponte para o nó dele`); return null; }
  err(`${where} "${ref}" não é um id de nó nem um arquivo da varredura${didYouMean(ref, ids)}`);
  return null;
};

// ---------- links ----------
const links = new Map(); // key -> link
const addLink = (a, b, k, extra = {}) => {
  if (!a || !b || a === b) return;
  const key = `${a}|${b}|${k}`;
  let l = links.get(key);
  if (!l) { l = { a, b, k, w: 0 }; links.set(key, l); }
  l.w += extra.w || 1;
  if (extra.names?.length) l.names = [...new Set([...(l.names || []), ...extra.names])].slice(0, 40);
  if (extra.label) { l.labels = l.labels || []; if (!l.labels.includes(extra.label) && l.labels.length < 40) l.labels.push(extra.label); }
  if (extra.inferred) l.inferred = true;
  if (extra.desc) l.desc = extra.desc;
  if (extra.route !== undefined) { l.calls = l.calls || []; if (l.calls.length < 80) l.calls.push([extra.route, extra.callLine || 0]); }
};

// ---------- routes ----------
const routeIdx = new Map();
const routesIn = scan.routes.filter((r) => includedSet.has(r.file));
routesIn.forEach((r, i) => routeIdx.set(`${r.file}|${r.method}|${r.path}`, i));

for (const e of scan.edges) if (includedSet.has(e.from) && includedSet.has(e.to)) addLink(`f:${e.from}`, `f:${e.to}`, 'import', { w: e.count || 1, names: e.names });
for (const h of scan.http) if (includedSet.has(h.from) && includedSet.has(h.to)) addLink(`f:${h.from}`, `f:${h.to}`, 'http', { label: `${h.method} ${h.path}`, inferred: true, route: routeIdx.get(`${h.to}|${h.method}|${h.path}`), callLine: h.line });

// externals: packages / hosts claimed by nodes
const extIds = scan.externals.map((e) => e.id);
const pkgMatchers = nodes.filter((n) => n?.packages?.length).map((n) => ({ id: n.id, globs: n.packages.map((p) => compileGlob(p.includes(':') ? p : `*:${p}`)), hits: 0 }));
const hostMatchers = nodes.filter((n) => n?.hosts?.length).map((n) => ({ id: n.id, globs: n.hosts.map((h) => compileGlob(h.toLowerCase())), hits: 0 }));
for (const e of scan.extEdges) {
  if (!includedSet.has(e.from)) continue;
  const m = pkgMatchers.find((pm) => pm.globs.some((g) => g.test(e.pkg)));
  if (m) { m.hits++; addLink(`f:${e.from}`, `n:${m.id}`, 'import', { w: e.count, names: [e.pkg.split(':')[1]] }); }
}
for (const h of scan.hosts) {
  if (!includedSet.has(h.from)) continue;
  const m = hostMatchers.find((hm) => hm.globs.some((g) => g.test(h.host)));
  if (m) { m.hits++; addLink(`f:${h.from}`, `n:${m.id}`, 'http', { label: h.host, inferred: true }); }
}
for (const pm of pkgMatchers) if (!pm.hits) warn(`os packages do nó "${pm.id}" não pegam nada importado. Conhecidos: ${extIds.slice(0, 8).join(', ')}…`);
for (const hm of hostMatchers) if (!hm.hits) warn(`os hosts do nó "${hm.id}" não pegam nenhum host chamado pelo código`);

// numa planta, as ligações planejadas de arquivos com serviços externos e bancos de dados ("services"/"data" em plano.json)
for (const e of scan.nodeLinks || []) {
  if (!includedSet.has(e.from)) continue;
  if (!byId.has(e.to)) { err(`${MAP_FILES.plan}: "${e.from}" cita "${e.to}" em "${e.kind === 'data' ? 'data' : 'services'}", mas isso não é o id de nenhum nó em ${MAP_FILES.arch}${didYouMean(e.to, ids)}`); continue; }
  addLink(`f:${e.from}`, `n:${e.to}`, EDGE_KINDS.includes(e.kind) ? e.kind : 'call', { label: e.label });
}

archEdges.forEach((e, i) => {
  const where = `edges[${i}]`;
  if (!EDGE_KINDS.includes(e?.kind)) err(`${where}.kind "${e?.kind}" precisa ser um destes: ${EDGE_KINDS.join(', ')}${didYouMean(String(e?.kind), EDGE_KINDS)}`);
  const a = resolveEndpoint(e?.from, `${where}.from`);
  const b = resolveEndpoint(e?.to, `${where}.to`);
  if (a && b && EDGE_KINDS.includes(e.kind)) addLink(a, b, e.kind, { label: e.label, desc: e.description, w: 1 });
});

// ---------- flows + annotations ----------
const outFlows = [];
flows.forEach((fl, i) => {
  const where = `flows[${i}]`;
  if (!isStr(fl?.id) || !isStr(fl?.title)) err(`${where} precisa de id e title`);
  if (!Array.isArray(fl?.steps) || fl.steps.length < 2) { err(`${where}.steps precisa de pelo menos 2 passos`); return; }
  const steps = fl.steps.map((s, j) => ({ ref: resolveEndpoint(s?.node, `${where}.steps[${j}].node`), note: s?.note || '' }));
  outFlows.push({ id: fl.id, title: fl.title, description: fl.description || '', steps });
});
// Fluxos que as pessoas pediram pelo mapa (salvos por servidor.mjs). Os passos usam refs estáveis —
// "route:MÉTODO /caminho" e "sym:<arquivo>#<nome>" — para sobreviver a novas montagens; passos velhos saem.
const customFile = path.join(outDir, MAP_FILES.flows);
if (fs.existsSync(customFile)) {
  let custom = [];
  try { custom = JSON.parse(fs.readFileSync(customFile, 'utf8')).flows || []; } catch (e) { warn(`${MAP_FILES.flows} não é um JSON válido: ${e.message}`); }
  const routeAt = new Map(routesIn.map((r, i) => [routeKey(r), i]));
  const resolveStep = (ref) => {
    if (typeof ref !== 'string') return null;
    if (ref.startsWith('route:')) { const i = routeAt.get(ref.slice(6)); return i == null ? null : `r:${i}`; }
    if (ref.startsWith('sym:')) {
      const [p, name] = [ref.slice(4, ref.lastIndexOf('#')), ref.slice(ref.lastIndexOf('#') + 1)];
      const i = (fileByPath.get(p)?.symbols || []).findIndex((s) => s.name === name);
      return includedSet.has(p) && i >= 0 ? `s:${p}#${i}` : null;
    }
    if (ref.startsWith('n:')) return byId.has(ref.slice(2)) ? ref : null;
    if (ref.startsWith('f:')) return includedSet.has(ref.slice(2)) ? ref : null;
    return null;
  };
  let dropped = 0;
  for (const fl of custom) {
    const steps = (fl.steps || []).map((s) => ({ ref: resolveStep(s.ref), note: s.note || '' })).filter((s) => s.ref);
    dropped += (fl.steps || []).length - steps.length;
    if (steps.length >= 2 && isStr(fl.id) && !outFlows.some((x) => x.id === fl.id)) outFlows.push({ id: fl.id, title: fl.title || 'Fluxo', description: fl.description || '', steps, custom: true });
  }
  if (dropped) warn(`${dropped} passo(s) em ${MAP_FILES.flows} apontam para código que não existe mais e ficaram de fora.`);
}
// Tour "Comece por aqui": 3 a 8 paradas narradas (id de nó ou caminho de arquivo), escritas pelo agente em arquitetura.json
const outTour = [];
if (arch.tour !== undefined) {
  if (!Array.isArray(arch.tour)) err('tour precisa ser uma lista de { node, title, note }');
  else arch.tour.forEach((s, i) => {
    const ref = resolveEndpoint(s?.node, `tour[${i}].node`);
    if (ref) outTour.push({ ref, title: isStr(s.title) ? s.title : '', note: isStr(s.note) ? s.note : '' });
  });
}
// "Trabalho recente": o que o agente acabou de mudar, por tarefa, diante do que a pessoa pediu
// (mapa-do-codigo/trabalho-recente.json, reescrito a cada criação/atualização). Refs velhas viram avisos, nunca erros.
let outRecent = null;
const recentFile = path.join(outDir, MAP_FILES.recent);
if (fs.existsSync(recentFile)) {
  let rw = null;
  try { rw = JSON.parse(fs.readFileSync(recentFile, 'utf8')); } catch (e) { warn(`${MAP_FILES.recent} não é um JSON válido: ${e.message}`); }
  const routeIdx = new Map(routesIn.map((r, i) => [routeKey(r), i]));
  const resolveRecent = (ref) => {
    if (!isStr(ref)) return null;
    const s = ref.trim().replace(/^\.\//, '').replace(/^(route:|file:)/, '');
    if (/^n:/.test(s)) return byId.has(s.slice(2)) ? s : null;
    if (/^f:/.test(s)) return includedSet.has(s.slice(2)) ? s : null;
    if (byId.has(s)) return 'n:' + s;
    if (includedSet.has(s)) return 'f:' + s;
    const m = /^([A-Za-z]+)\s+(\/\S*)$/.exec(s);
    if (m && routeIdx.has(`${m[1].toUpperCase()} ${m[2]}`)) return `r:${routeIdx.get(`${m[1].toUpperCase()} ${m[2]}`)}`;
    return null;
  };
  if (rw && !Array.isArray(rw.tasks)) warn(`${MAP_FILES.recent} precisa de uma lista "tasks" (uma lista vazia limpa os destaques)`);
  else if (rw) {
    const tasks = [], items = [], missing = [];
    rw.tasks.forEach((t, ti) => {
      if (!isStr(t?.title)) return warn(`${MAP_FILES.recent} tasks[${ti}] precisa de um title`);
      tasks.push({ title: t.title, request: isStr(t.request) ? t.request : '', summary: isStr(t.summary) ? t.summary : '', ...(isStr(t.status) ? { status: t.status } : {}) });
      for (const it of Array.isArray(t.items) ? t.items : []) {
        const id = resolveRecent(it?.ref);
        if (!id) { missing.push(it?.ref); continue; }
        items.push({ id, task: tasks.length - 1, change: it.change === 'new' ? 'new' : 'changed', note: isStr(it.note) ? it.note : '' });
      }
    });
    if (missing.length) warn(`${MAP_FILES.recent}: ${missing.length} ref(s) não estão no mapa e ficaram de fora (use um caminho de arquivo, um id de nó ou "MÉTODO /caminho"): ${missing.slice(0, 5).map(String).join(', ')}${missing.length > 5 ? '…' : ''}`);
    outRecent = { updatedAt: isStr(rw.updatedAt) ? rw.updatedAt : fs.statSync(recentFile).mtime.toISOString(), tasks, items };
  }
}
const notes = new Map();
annotations.forEach((a, i) => {
  if (!isStr(a?.path) || !isStr(a?.note)) return err(`annotations[${i}] precisa de path e note`);
  if (!includedSet.has(a.path)) return err(`annotations[${i}].path "${a.path}" não é um arquivo incluído`);
  notes.set(a.path, { note: a.note, tags: isStrArr(a.tags) ? a.tags : undefined });
});
for (const ep of arch.project?.entrypoints || []) if (!includedSet.has(ep)) warn(`project.entrypoints "${ep}" não é um arquivo incluído`);

// ---------- nomes + descrições (mapa-do-codigo/descricoes/*.json) ----------
const descDir = path.join(outDir, MAP_FILES.descriptions);
const fileDesc = new Map(), routeDesc = new Map();
const routeKeys = new Set(routesIn.map(routeKey));
let staleFiles = 0, staleRoutes = 0;
const staleEx = [];
if (fs.existsSync(descDir)) {
  for (const name of fs.readdirSync(descDir).filter((n) => n.endsWith('.json')).sort()) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(descDir, name), 'utf8')); } catch (e) { err(`${MAP_FILES.descriptions}/${name} não é um JSON válido: ${e.message}`); continue; }
    for (const [p, v] of Object.entries(d.files || {})) {
      if (!v || typeof v !== 'object') { err(`${MAP_FILES.descriptions}/${name}: files["${p}"] precisa ser { name, description }`); continue; }
      if (!includedSet.has(p)) { staleFiles++; if (staleEx.length < 3) staleEx.push(p); continue; }
      fileDesc.set(p, { name: isStr(v.name) ? v.name.trim() : null, d: isStr(v.description) ? v.description.trim() : null, review: isStr(v.review) ? v.review : null });
    }
    for (const [k, v] of Object.entries(d.routes || {})) {
      if (!v || typeof v !== 'object') { err(`${MAP_FILES.descriptions}/${name}: routes["${k}"] precisa ser { name, description }`); continue; }
      if (!routeKeys.has(k)) { staleRoutes++; continue; }
      routeDesc.set(k, { name: isStr(v.name) ? v.name.trim() : null, d: isStr(v.description) ? v.description.trim() : null, review: isStr(v.review) ? v.review : null });
    }
  }
}
if (staleFiles) warn(`${staleFiles} arquivo(s) descrito(s) não existem mais ou não estão incluídos (por exemplo ${staleEx.join(', ')}). Tire-os de ${MAP_FILES.descriptions}/.`);
if (staleRoutes) warn(`${staleRoutes} endpoint(s) descrito(s) não correspondem mais a nenhuma rota da varredura; remova-os ou corrija a chave.`);

// ---------- stats ----------
const unassigned = included.filter((f) => owner.get(f.path) === 'unassigned');
const stats = new Map([...ids, 'unassigned'].map((id) => [id, { files: 0, loc: 0, langs: {}, repos: new Set() }]));
for (const f of included) {
  let id = owner.get(f.path);
  while (id) {
    const s = stats.get(id);
    s.files++; s.loc += f.loc; s.langs[f.lang || f.category] = (s.langs[f.lang || f.category] || 0) + f.loc;
    if (f.repo !== null) s.repos.add(f.repo);
    id = id === 'unassigned' ? null : byId.get(id)?.parent;
  }
}

// ---------- report ----------
const pct = included.length ? (unassigned.length / included.length) * 100 : 0;
const report = [];
if (errors.length) {
  report.push(`✗ ${errors.length} erro(s) em ${path.relative(root, archFile)}${scan.blueprint ? ` ou ${MAP_FILES.plan}` : ''}:`);
  for (const e of errors) report.push(`  - ${e}`);
}
if (warnings.length) {
  report.push(`! ${warnings.length} aviso(s):`);
  for (const w of warnings.slice(0, 40)) report.push(`  - ${w}`);
}
report.push('');
report.push(`ATRIBUIÇÃO  ${included.length} arquivos (${include.join('+')}), ${unassigned.length} não atribuídos (${pct.toFixed(1).replace('.', ',')}%)`);
for (const n of nodes.filter((n) => n?.id && !n.parent)) {
  const s = stats.get(n.id);
  report.push(`  ${n.id.padEnd(28)} ${String(s.files).padStart(5)} arquivos ${scan.blueprint ? '' : `${fmtNum(s.loc).padStart(6)} linhas  `}[${n.kind}]`);
}
if (unassigned.length) {
  const byDir = new Map();
  for (const f of unassigned) { const d = f.path.split('/').slice(0, -1).join('/') || '.'; byDir.set(d, (byDir.get(d) || 0) + 1); }
  report.push(`  não atribuídos, por pasta:`);
  for (const [d, c] of [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) report.push(`    ${String(c).padStart(4)}  ${d}/`);
}
const byKind = {};
for (const l of links.values()) byKind[l.k] = (byKind[l.k] || 0) + 1;
report.push(`LIGAÇÕES  ${[...links.values()].length} (${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')})`);
const describedFiles = included.filter((f) => fileDesc.get(f.path)?.d || f.desc).length;
const describedRoutes = routesIn.filter((r) => routeDesc.get(routeKey(r))?.d || r.desc).length;
const noSummary = nodes.filter((n) => n?.id && !isStr(n.summary)).map((n) => n.id);
const reviewCount = [...fileDesc.values(), ...routeDesc.values()].filter((d) => d.review).length;
report.push(`DESCRIÇÕES  arquivos ${describedFiles}/${included.length} · endpoints ${describedRoutes}/${routesIn.length} · módulos ${nodes.length - noSummary.length}/${nodes.length}${reviewCount ? ` · ${reviewCount} para revisar (o código mudou)` : ''}`);
if (noSummary.length) report.push(`  módulos sem summary: ${noSummary.slice(0, 12).join(', ')}${noSummary.length > 12 ? '…' : ''}`);
if (describedFiles < included.length || describedRoutes < routesIn.length || reviewCount) report.push(`  Rode describe.mjs para gerar as fichas dos ${included.length - describedFiles} arquivo(s) e ${routesIn.length - describedRoutes} endpoint(s) que ainda estão sem descrição.`);

if (errors.length) { console.log(report.join('\n')); console.log('\nCorrija os erros acima e rode build.mjs de novo.'); process.exit(1); }
if (args.check) { console.log(report.join('\n')); process.exit(0); }

// ---------- grava grafo.json + index.html ----------
const graph = {
  schema: 'floorplan/graph@1',
  meta: {
    generatedAt: new Date().toISOString(), scanAt: scan.generatedAt, rootName: scan.rootName, root: scan.root,
    audience, agent,
    ...(scan.blueprint ? { blueprint: { source: scan.blueprint.source, stack: scan.blueprint.stack, assumptions: scan.blueprint.assumptions } } : {}),
    repos: scan.repos.map(({ path: p, name, branch, head, remote }) => ({ path: p, name, branch, head, remote })),
    counts: { files: included.length, loc: included.reduce((s, f) => s + f.loc, 0), unassigned: unassigned.length },
  },
  project: arch.project,
  nodes: [
    ...nodes.map((n) => ({
      id: n.id, parent: n.parent || null, label: n.label, kind: n.kind, summary: n.summary || '', details: n.details || '',
      tags: n.tags || [], paths: n.paths || [], packages: n.packages || [], hosts: n.hosts || [],
      stats: { ...stats.get(n.id), repos: [...stats.get(n.id).repos] },
    })),
    ...(unassigned.length ? [{ id: 'unassigned', parent: null, label: 'Não atribuídos', kind: 'misc', summary: `Arquivos que nenhum nó reivindica. Acrescente globs em ${MAP_FILES.arch} para colocá-los em um nó.`, details: '', tags: [], paths: [], packages: [], hosts: [], stats: { ...stats.get('unassigned'), repos: [...stats.get('unassigned').repos] } }] : []),
  ],
  files: included.map((f) => {
    const d = fileDesc.get(f.path);
    return {
      p: f.path, n: owner.get(f.path), r: f.repo, l: f.lang || f.category, loc: f.loc,
      name: d?.name || f.name || fallbackFileName(f.path), d: d?.d || f.desc || f.doc || '', ...(d?.d || f.desc ? {} : { auto: true }),
      ...(f.doc ? { doc: f.doc } : {}),
      ...(f.tooLarge ? { tooLarge: true } : {}),
      ...(d?.review ? { review: d.review } : {}),
      ...(f.h ? { h: f.h, sig: f.sig } : {}),
      ...(f.symbols ? { s: f.symbols.map((s) => [s.name, s.kind, s.line, s.default ? 1 : 0, s.doc || '']) } : {}),
      ...(notes.has(f.path) ? notes.get(f.path) : {}),
    };
  }),
  routes: routesIn.map((r) => {
    const d = routeDesc.get(routeKey(r));
    return { f: r.file, m: r.method, p: r.path, l: r.line, h: r.handler || null, name: d?.name || r.name || fallbackRouteName(r), d: d?.d || r.desc || r.doc || '', ...(d?.d || r.desc ? {} : { auto: true }), ...(d?.review ? { review: d.review } : {}), ...(r.doc ? { doc: r.doc } : {}), ...(r.access ? { access: r.access } : {}), ...(r.who ? { who: r.who } : {}), ...(r.publicBecause ? { publicBecause: r.publicBecause } : {}) };
  }),
  links: [...links.values()],
  flows: outFlows,
  tour: outTour,
  ...(outRecent?.items.length ? { recent: outRecent } : {}),
};
// extension hooks, computed from the finished graph plus the raw scan
// a blueprint has no code to check, so its Health is a design review of the plan (computed after screens)
if (!scan.blueprint) try { graph.health = buildHealth({ graph, scan, arch, root }); } catch (e) { warn(`a verificação de saúde falhou: ${e.message}`); graph.health = { issues: [] }; }
try { graph.screens = buildScreens({ graph, scan, arch, root }); } catch (e) { warn(`a detecção de telas falhou: ${e.message}`); graph.screens = []; }
if (scan.blueprint) try { graph.health = buildPlanHealth({ graph, scan }); } catch (e) { warn(`a revisão do plano falhou: ${e.message}`); graph.health = { issues: [] }; }
fs.mkdirSync(outDir, { recursive: true });
const trackedWarning = keepOutOfGit(outDir);
fs.writeFileSync(path.join(outDir, MAP_FILES.graph), JSON.stringify(graph, null, 0));

const template = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'viewer.html'), 'utf8');
// O motor de layout (elkjs 0.9.3) e as fontes (Inter, JetBrains Mono) vêm em assets/vendor/ e entram
// embutidos, então o mapa não faz nenhuma requisição externa e funciona offline.
const vendor = path.join(SKILL_DIR, 'assets', 'vendor');
const elkTag = `<script>${fs.readFileSync(path.join(vendor, 'elk.bundled.js'), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`;
const FONT_RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
};
const fontCss = [['Inter', 'inter'], ['JetBrains Mono', 'jetbrains-mono']].flatMap(([family, file]) => Object.entries(FONT_RANGES).map(([subset, range]) =>
  `@font-face{font-family:"${family}";font-style:normal;font-display:swap;font-weight:100 900;unicode-range:${range};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(vendor, 'fonts', `${file}-${subset}-wght-normal.woff2`)).toString('base64')}) format("woff2")}`)).join('\n');
const graphQuery = fs.readFileSync(path.join(SKILL_DIR, 'assets', 'graph-query.js'), 'utf8');
const page = (g) => template
  .replace('/*__GRAPH_QUERY__*/', () => graphQuery.replace(/<\/script/gi, '<\\/script'))
  .replace('<!--__ELK_SCRIPT__-->', () => elkTag)
  .replace('/*__FONTS__*/', () => fontCss)
  .replace('/*__FLOORPLAN_DATA__*/null', () => JSON.stringify(g).replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029'))
  .replace(/__FLOORPLAN_TITLE__/g, () => escapeHtml(`${arch.project.name} · Mapa do código`))
  .replace(/__FLOORPLAN_LOGO__/g, () => dataUri('logo.png'))
  .replace(/__FLOORPLAN_FAVICON__/g, () => dataUri('favicon.png'))
  .replace('<!--__UI_EXTENSIONS__-->', () => uiScripts);
const uiDir = path.join(SKILL_DIR, 'assets', 'ui');
const uiScripts = fs.existsSync(uiDir) ? fs.readdirSync(uiDir).filter((n) => n.endsWith('.js')).sort().map((n) => `<script>/* ui/${n} */\n${fs.readFileSync(path.join(uiDir, n), 'utf8').replace(/<\/script/gi, '<\\/script')}</script>`).join('\n') : '';
const html = page(graph);
fs.writeFileSync(path.join(outDir, MAP_FILES.page), html);
// --artifact: uma cópia para publicar no app do Claude, sem o caminho absoluto desta máquina (links do editor)
if (args.artifact) fs.writeFileSync(path.join(outDir, MAP_FILES.artifact), page({ ...graph, meta: { ...graph.meta, root: null, agent: 'claude' } }));
// Ajudantes autossuficientes ao lado do mapa: perguntas pelo Claude Code ou pelo Codex (servidor.mjs, com a
// lógica compartilhada em servidor-nucleo.mjs) e as consultas ao grafo que ele entrega a eles (consulta.mjs).
// Precisam só do Node, não desta skill.
fs.writeFileSync(path.join(outDir, MAP_FILES.query), `${graphQuery}
// ---- cli ----
${fs.readFileSync(path.join(SKILL_DIR, 'assets', 'query-cli.mjs'), 'utf8')}`);
for (const name of [MAP_FILES.server, MAP_FILES.serverCore]) {
  const from = path.join(SKILL_DIR, 'assets', name);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, name));
}
// uma planta pode ser mudada pelo mapa: servidor.mjs a redesenha com o plan.mjs e o build.mjs desta skill
if (scan.blueprint) { fs.mkdirSync(path.join(outDir, '.cache'), { recursive: true }); fs.writeFileSync(path.join(outDir, '.cache', 'skill.json'), JSON.stringify({ dir: SKILL_DIR })); }
// o logo e o ícone da aba entram embutidos para o mapa continuar sendo um arquivo só
function dataUri(name) { return 'data:image/png;base64,' + fs.readFileSync(path.join(SKILL_DIR, 'assets', name)).toString('base64'); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

const hs = graph.health?.summary;
const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// os mesmos nomes que o painel Saúde usa para cada gravidade
const SEVERITY = { high: 'importante', medium: 'a corrigir', low: 'menor' };
if (hs && (hs.high || hs.medium || hs.low)) {
  report.push(`${scan.blueprint ? 'REVISÃO DA PLANTA' : 'SAÚDE'}  ${pl(hs.high, 'importante', 'importantes')} · ${hs.medium} a corrigir · ${pl(hs.low, 'menor', 'menores')}`);
  for (const i of graph.health.issues.filter((x) => x.severity !== 'low').slice(0, 8)) report.push(`  [${SEVERITY[i.severity] || i.severity}] ${i.title}`);
}
if (graph.screens?.length) report.push(`TELAS  ${pl(graph.screens.length, 'encontrada', 'encontradas')}`);
report.push(graph.recent
  ? `TRABALHO RECENTE  ${graph.recent.items.length} card(s) em destaque, de ${graph.recent.tasks.length} tarefa(s)`
  : `TRABALHO RECENTE  nada em destaque${fs.existsSync(recentFile) ? '' : ` (não há ${MAP_FILES.recent})`}`);
// aponta as próximas sessões do Claude Code neste projeto para o mapa. O Codex não tem um equivalente pessoal
// e fora do git (o AGENTS.md é compartilhado com a equipe), então um mapa feito pelo Codex não mexe nas notas do projeto.
const mapRel = path.relative(root, outDir).replace(/\\/g, '/') || '.';
if (agent === 'codex') report.push('AGENTE  Codex: as perguntas feitas no mapa passam pelo Codex');
else if (scan.blueprint) report.push(`PLANTA  planejado, ainda não construído: desenhado a partir de ${mapRel}/${MAP_FILES.plan}`);
else if (!args['no-claude-md']) report.push(`CLAUDE.LOCAL.MD  ${writeClaudeMd(root, outDir, { add: !!args['claude-md'] })}`);
report.push(trackedWarning ? `GIT  ! ${trackedWarning}` : `GIT  ${mapRel}/ fica fora do git (a pasta ignora a si mesma)`);
report.push('');
const kb = Math.round(html.length / 1024);
report.push(`✓ gravei ${path.relative(root, path.join(outDir, MAP_FILES.page))} (${kb >= 1024 ? `${(kb / 1024).toFixed(1).replace('.', ',')} MB` : `${kb} KB`}) e ${MAP_FILES.graph}`);
if (pct > 10) report.push(`  ${pct.toFixed(0)}% dos arquivos estão sem nó: acrescente nós ou globs para as pastas acima (ou coloque-as em "ignore") e monte de novo.`);
console.log(report.join('\n'));
