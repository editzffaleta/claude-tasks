#!/usr/bin/env node
// Fatos para marcar o "trabalho recente" no mapa: o que mudou desde o último mapa (pelo refresh.mjs),
// as mudanças sem commit e os commits recentes, cada um ligado ao card em que aparece. O agente acrescenta
// o porquê (o que a pessoa pediu) e escreve mapa-do-codigo/trabalho-recente.json. Só lê.
// uso: node recent.mjs [raiz] [--days 7]
import fs from 'node:fs';
import path from 'node:path';
import { git, parseArgs, mapDir, MAP_DIR, MAP_FILES } from './lib/common.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const dir = mapDir(root);
const graphFile = path.join(dir, MAP_FILES.graph);
if (!fs.existsSync(graphFile)) { console.error(`✗ Não há ${MAP_DIR}/${MAP_FILES.graph}. Rode build.mjs primeiro.`); process.exit(1); }
const G = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const changes = readJson(path.join(dir, '.cache', 'mudancas.json'));
const current = readJson(path.join(dir, MAP_FILES.recent));

const files = new Map(G.files.map((f) => [f.p, f]));
const labels = new Map(G.nodes.map((n) => [n.id, n.label]));
const routesOf = new Map();
for (const r of G.routes) { if (!routesOf.has(r.f)) routesOf.set(r.f, []); routesOf.get(r.f).push(`${r.m} ${r.p}`); }
const card = (p) => {
  const f = files.get(p);
  if (!f) return '(não está no mapa)';
  const rs = routesOf.get(p) || [];
  return `"${f.name}" em ${labels.get(f.n) || f.n}${rs.length ? ` · ${rs.length} endpoint(s)` : ''}`;
};
const L = [];
const MAX = 40;
const list = (rows) => { rows.slice(0, MAX).forEach((r) => L.push('  ' + r)); if (rows.length > MAX) L.push(`  … mais ${rows.length - MAX}`); };

L.push(`FATOS PARA O TRABALHO RECENTE de ${G.project.name}  (mapa montado em ${G.meta.generatedAt})`);
L.push(current?.tasks
  ? `${MAP_FILES.recent} atual: ${current.tasks.length} tarefa(s), atualizado em ${current.updatedAt || 'data desconhecida'}. Reescreva-o: ele substitui os destaques anteriores.`
  : `Ainda não há ${MAP_FILES.recent}.`);

if (changes) {
  L.push('', `O QUE MUDOU DESDE O MAPA ANTERIOR (${changes.since} → ${changes.at})`);
  const rows = [
    ...changes.files.new.map((p) => `novo     ${p}  → ${card(p)}`),
    ...changes.files.edited.map((p) => `editado  ${p}  → ${card(p)}`),
    ...changes.files.moved.map((m) => `movido   ${m.from} → ${m.to}  → ${card(m.to)}`),
    ...changes.files.deleted.map((p) => `apagado  ${p}  (saiu do mapa; mencione no resumo da tarefa)`),
    ...changes.routes.new.map((k) => `endpoint novo             ${k}`),
    ...changes.routes.moved.map((m) => `endpoint com caminho novo ${m.from} → ${m.to}`),
    ...changes.routes.removed.map((k) => `endpoint removido         ${k}`),
  ];
  if (rows.length) list(rows); else L.push('  nada');
}

const since = changes?.since || current?.updatedAt || new Date(Date.now() - (Number(args.days) || 7) * 86400000).toISOString();
for (const r of G.meta.repos || []) {
  const abs = path.join(root, r.path);
  const prefix = r.path === '.' ? '' : r.path + '/';
  const status = (git(abs, ['status', '--porcelain=v1', '-uall']) || '').split('\n').filter(Boolean);
  const log = (git(abs, ['log', `--since=${since}`, '--max-count=20', '--no-merges', '--name-only', '--date=short', '--format=@@%h %ad %s']) || '').trim();
  if (!status.length && !log) continue;
  L.push('', `REPOSITÓRIO ${r.path === '.' ? G.meta.rootName : r.path}`);
  if (status.length) {
    L.push('  sem commit:');
    list(status.map((s) => { const p = prefix + s.slice(3).replace(/^.* -> /, '').replace(/"/g, ''); return `  ${s.slice(0, 2).trim().padEnd(2)} ${p}  → ${card(p)}`; }));
  }
  if (log) {
    L.push(`  commits desde ${since.slice(0, 10)}:`);
    for (const block of log.split('@@').filter(Boolean)) {
      const [head, ...paths] = block.trim().split('\n').filter(Boolean);
      L.push(`    ${head}`);
      paths.slice(0, 8).forEach((p) => L.push(`        ${prefix + p}  → ${card(prefix + p)}`));
      if (paths.length > 8) L.push(`        … mais ${paths.length - 8} arquivos`);
    }
  }
}

L.push('', `Escreva ${MAP_DIR}/${MAP_FILES.recent} (refs: um caminho de arquivo, um id de nó ou "MÉTODO /caminho"; veja a parte sobre ${MAP_FILES.recent} em referencias/esquema.md):`,
  '  { "tasks": [ { "title": "…", "request": "o que a pessoa pediu", "summary": "o que foi feito para isso, e em que pé está",',
  '      "items": [ { "ref": "<caminho do arquivo>", "change": "changed|new", "note": "o que mudou aqui, e como isso atende ao pedido" } ] } ] }',
  'Escreva os textos em português do Brasil. Depois rode build.mjs. Use { "tasks": [] } quando nada tiver sido feito.');
console.log(L.join('\n'));
