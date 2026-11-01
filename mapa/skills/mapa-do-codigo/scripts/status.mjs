#!/usr/bin/env node
// Diz se já existe um Mapa do código aqui e o quanto ele está desatualizado. Nunca falha.
// uso: node status.mjs [raiz]
import fs from 'node:fs';
import path from 'node:path';
import { git, mapDir, MAP_DIR, MAP_FILES } from './lib/common.mjs';

try {
  const root = path.resolve(process.argv[2] || '.');
  const dir = mapDir(root);
  const graphFile = path.join(dir, MAP_FILES.graph);
  const hasArch = fs.existsSync(path.join(dir, MAP_FILES.arch));
  if (!fs.existsSync(graphFile)) {
    const hasPlan = fs.existsSync(path.join(dir, MAP_FILES.plan));
    console.log(hasPlan
      ? `uma planta foi começada (${MAP_FILES.plan}) mas nunca desenhada: escreva ${MAP_FILES.arch} se ele estiver faltando e depois rode plan.mjs e build.mjs.`
      : hasArch ? `${MAP_FILES.arch} existe mas nunca foi montado: rode build.mjs.` : 'nenhum: ainda não há Mapa do código aqui (primeira vez).');
    process.exit(0);
  }
  const g = JSON.parse(fs.readFileSync(graphFile, 'utf8'));
  if (g.meta.blueprint) {
    console.log(`uma planta (planejada, ainda não construída${g.meta.blueprint.source ? `, a partir de ${g.meta.blueprint.source}` : ''}) montada em ${g.meta.generatedAt}: ${g.meta.counts.files} arquivos planejados, ${g.nodes.length} nós.\nPara mudar o plano, edite ${MAP_DIR}/${MAP_FILES.plan} e ${MAP_FILES.arch} e depois rode refresh.mjs (ele redesenha a partir de ${MAP_FILES.plan}). Se o código já existe e a pessoa quer um mapa dele, rode refresh.mjs --from-code.`);
    process.exit(0);
  }
  const lines = [`mapa montado em ${g.meta.generatedAt} cobrindo ${g.meta.counts.files} arquivos, ${g.nodes.length} nós.`];
  for (const r of g.meta.repos || []) {
    const abs = path.join(root, r.path);
    const head = git(abs, ['rev-parse', 'HEAD']);
    if (!head || !r.head) { lines.push(`  ${r.path}: não é mais um repositório git`); continue; }
    const changed = head === r.head ? [] : (git(abs, ['diff', '--name-only', r.head, head]) || '').split('\n').filter(Boolean);
    const dirty = (git(abs, ['status', '--porcelain']) || '').split('\n').filter(Boolean).length;
    lines.push(`  ${r.path}: ${head === r.head ? 'mesmo commit' : `${changed.length} arquivo(s) mudaram desde ${r.head.slice(0, 7)}`}${dirty ? `, ${dirty} sem commit` : ''}`);
    if (changed.length) lines.push(`    por exemplo ${changed.slice(0, 6).map((p) => (r.path === '.' ? p : `${r.path}/${p}`)).join(', ')}`);
  }
  lines.push('Já existe um mapa: atualize-o com refresh.mjs (só os arquivos que mudaram gastam tokens) em vez de começar do zero.');
  console.log(lines.join('\n'));
} catch (e) {
  console.log(`status indisponível (${e.message})`);
}
