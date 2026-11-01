#!/usr/bin/env node
// Descrições do Mapa do código: transforma o grafo montado em fichas por módulo que o agente (ou
// subagentes em paralelo) usa para escrever um nome legível + uma descrição de uma linha, em português,
// para cada arquivo e endpoint.
//
// uso: node describe.mjs [raiz]                  grava as fichas + os esqueletos das descrições e imprime um índice
//      node describe.mjs [raiz] --all            inclui os itens que já têm descrição
//      node describe.mjs [raiz] --max-files 40   arquivos por ficha antes de dividir em partes
//
// Rode build.mjs antes: as fichas são geradas a partir de mapa-do-codigo/grafo.json.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, fmtNum, mapDir, MAP_DIR, MAP_FILES } from './lib/common.mjs';
import { fallbackFileName, fallbackRouteName, routeKey } from './lib/names.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const graphFile = path.join(outDir, MAP_FILES.graph);
if (!fs.existsSync(graphFile)) { console.error(`✗ Não há ${MAP_DIR}/${MAP_FILES.graph}. Rode build.mjs primeiro.`); process.exit(1); }
const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const maxFiles = Number(args['max-files']) || 40;
const wsDir = path.join(outDir, '.cache', 'worksheets');
const descDir = path.join(outDir, MAP_FILES.descriptions);
fs.mkdirSync(wsDir, { recursive: true });
fs.mkdirSync(descDir, { recursive: true });
for (const f of fs.readdirSync(wsDir)) fs.unlinkSync(path.join(wsDir, f));

const nodes = new Map(g.nodes.map((n) => [n.id, n]));
const fileByPath = new Map(g.files.map((f) => [f.p, f]));
const label = (id) => nodes.get(id)?.label || id;
// Para quem o mapa é escrito ("audience" em arquitetura.json, copiado para graph.meta pelo build.mjs).
const audience = g.meta?.audience === 'developers' ? 'developers' : 'everyone';
const AUDIENCE = audience === 'developers' ? 'desenvolvedores ("audience": "developers")' : 'todo mundo ("audience": "everyone")';
const STYLE = audience === 'developers'
  ? 'estilo técnico, para engenheiros: cite os frameworks, padrões e mecanismos quando ajudarem.'
  : 'português simples, para um dono que não é técnico: o que aquilo faz pelo negócio ou pelos usuários, em palavras do dia a dia, mas específico. Sem jargão (endpoint, ORM, blueprint, webhook, worker…): o caminho e o método/URL já aparecem ao lado. Veja "Linguagem simples" em referencias/escrevendo-descricoes.md.';
const LANGUAGE = 'Idioma: escreva todo "name" e toda "description" em português do Brasil, mesmo quando o código, os comentários ou os nomes no código estiverem em inglês.';

// file -> neighbours, summarised by owning node
const usesOf = new Map(), usedBy = new Map();
const bump = (m, k, v) => { if (!m.has(k)) m.set(k, new Map()); m.get(k).set(v, (m.get(k).get(v) || 0) + 1); };
for (const l of g.links) {
  if (!l.a.startsWith('f:')) continue;
  const a = l.a.slice(2);
  const bNode = l.b.startsWith('f:') ? fileByPath.get(l.b.slice(2))?.n : l.b.slice(2);
  if (bNode) bump(usesOf, a, label(bNode));
  if (l.b.startsWith('f:')) { const aNode = fileByPath.get(a)?.n; if (aNode) bump(usedBy, l.b.slice(2), label(aNode)); }
}
const top = (m, n = 5) => m ? [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, n).map(([k, v]) => `${k}${v > 1 ? ` ×${v}` : ''}`).join(', ') : '';

const routesByFile = new Map();
for (const r of g.routes || []) { if (!routesByFile.has(r.f)) routesByFile.set(r.f, []); routesByFile.get(r.f).push(r); }

const needs = (f) => args.all || f.auto || f.review;
const byNode = new Map();
for (const f of g.files) {
  const rs = routesByFile.get(f.p) || [];
  if (!needs(f) && !rs.some((r) => args.all || r.auto || r.review)) continue;
  if (!byNode.has(f.n)) byNode.set(f.n, []);
  byNode.get(f.n).push(f);
}

const index = [];
for (const [nid, list] of byNode) {
  list.sort((a, b) => a.p.localeCompare(b.p));
  // Split into parts of at most maxFiles files or ~100 routes, whichever comes first.
  const chunks = [[]];
  let routesInChunk = 0;
  for (const f of list) {
    const nr = (routesByFile.get(f.p) || []).length;
    const cur = chunks[chunks.length - 1];
    if (cur.length && (cur.length >= maxFiles || routesInChunk + nr > 100)) { chunks.push([]); routesInChunk = 0; }
    chunks[chunks.length - 1].push(f);
    routesInChunk += nr;
  }
  const parts = chunks.length;
  for (let i = 0; i < parts; i++) {
    const chunk = chunks[i];
    const key = parts > 1 ? `${nid}--${i + 1}` : nid;
    const descFile = path.join(descDir, `${key}.json`);
    const n = nodes.get(nid);
    const out = [];
    out.push(`# Ficha ${key}: ${n?.label || nid}${parts > 1 ? ` (parte ${i + 1}/${parts})` : ''}`);
    out.push(`Público: ${AUDIENCE}. Escreva em ${STYLE}`);
    out.push(LANGUAGE);
    if (n?.summary) out.push(`Módulo: ${n.summary}`);
    out.push(`Escreva em: ${MAP_DIR}/${MAP_FILES.descriptions}/${key}.json (o esqueleto já está lá; preencha toda "description" e melhore todo "name").`);
    out.push('Itens marcados REVISAR já têm descrição, mas o código deles mudou: atualize name/description se a mudança importar e depois apague o campo "review". Itens que não aparecem aqui estão certos; deixe-os como estão.');
    out.push('');
    let routeCount = 0;
    for (const f of chunk) {
      out.push(`## ${f.p}  (${fmtNum(f.loc)} linhas, ${f.l})${f.review ? '  REVISAR' : !needs(f) ? '  (já descrito; só os endpoints dele precisam de atenção)' : ''}`);
      if (f.review) out.push(`atual: ${f.name} — ${f.d}
mudou: ${f.review}`);
      if (f.doc) out.push(`doc: ${f.doc}`);
      if (f.s?.length) {
        const syms = f.s.slice(0, 12).map((s) => `${s[0]}${s[1] === 'function' ? '()' : ''}${s[4] ? ` (${s[4]})` : ''}`);
        out.push(`define: ${syms.join('; ')}${f.s.length > 12 ? `; … +${f.s.length - 12}` : ''}`);
      }
      const u = top(usesOf.get(f.p)), b = top(usedBy.get(f.p));
      if (u) out.push(`usa: ${u}`);
      if (b) out.push(`usado por: ${b}`);
      for (const r of routesByFile.get(f.p) || []) {
        routeCount++;
        const mark = r.review ? `  REVISAR (${r.review}); atual: ${r.name} — ${r.d}` : r.auto ? '  NOVO' : '  (descrito)';
        out.push(`endpoint: ${routeKey({ method: r.m, path: r.p })}  handler ${r.h || '?'}${r.doc ? ` (${r.doc})` : ''}${mark}`);
      }
      out.push('');
    }
    fs.writeFileSync(path.join(wsDir, `${key}.md`), out.join('\n'));

    // esqueleto: mantém o que já foi escrito e acrescenta as chaves que faltam
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(descFile, 'utf8')); } catch {}
    const skel = { files: { ...(existing.files || {}) }, routes: { ...(existing.routes || {}) } };
    for (const f of chunk) {
      if (!skel.files[f.p]) skel.files[f.p] = { name: f.auto ? fallbackFileName(f.p) : f.name, description: f.auto ? '' : f.d };
      for (const r of routesByFile.get(f.p) || []) {
        const k = routeKey({ method: r.m, path: r.p });
        if (!skel.routes[k]) skel.routes[k] = { name: r.auto ? fallbackRouteName({ handler: r.h, method: r.m, path: r.p }) : r.name, description: r.auto ? '' : r.d };
      }
    }
    if (!Object.keys(skel.routes).length) delete skel.routes;
    fs.writeFileSync(descFile, JSON.stringify(skel, null, 2) + '\n');
    index.push({ key, node: n?.label || nid, files: chunk.length, routes: routeCount, loc: chunk.reduce((s, f) => s + f.loc, 0) });
  }
}

if (!index.length) { console.log('✓ Todo arquivo e endpoint já tem descrição. Use --all para gerar as fichas de tudo de novo.'); process.exit(0); }
const totals = index.reduce((s, w) => ({ files: s.files + w.files, routes: s.routes + w.routes }), { files: 0, routes: 0 });
console.log(`${index.length} ficha(s) em ${MAP_DIR}/.cache/worksheets/ cobrindo ${totals.files} arquivos e ${totals.routes} endpoints ainda por descrever.`);
console.log(`Cada uma tem um esqueleto correspondente em ${MAP_DIR}/${MAP_FILES.descriptions}/<chave>.json. Preencha-os e depois rode build.mjs.`);
console.log(`Público: ${AUDIENCE}. Escreva em ${STYLE}`);
console.log(`${LANGUAGE}\n`);
console.log('chave'.padEnd(34) + 'arquivos'.padStart(9) + 'endpoints'.padStart(10) + 'linhas'.padStart(8) + '  módulo');
for (const w of index.sort((a, b) => b.files - a.files)) console.log(w.key.padEnd(34) + String(w.files).padStart(9) + String(w.routes).padStart(10) + fmtNum(w.loc).padStart(8) + '  ' + w.node);
