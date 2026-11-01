#!/usr/bin/env node
// Planta do Mapa do código: transforma mapa-do-codigo/plano.json (os arquivos, endpoints e ligações que um
// sistema teria, planejados a partir de um PRD ou de uma descrição) em mapa-do-codigo/.cache/scan.json, no
// mesmo formato que o scan.mjs grava para código de verdade. O build.mjs então desenha uma planta: o mesmo
// mapa, marcado como planejado.
//
// uso: node plan.mjs [raiz] [--plan <arquivo>]

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, toPosix, mapDir, keepOutOfGit, MAP_DIR, MAP_FILES } from './lib/common.mjs';
import { planToScan } from './lib/blueprint.mjs';

const args = parseArgs(process.argv.slice(2));
const root = path.resolve(args._[0] || '.');
const outDir = mapDir(root);
const planFile = path.resolve(args.plan || path.join(outDir, MAP_FILES.plan));
const outFile = path.join(outDir, '.cache', 'scan.json');

const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
if (!fs.existsSync(planFile)) fail(`Não há plano em ${planFile}. Escreva-o primeiro (veja referencias/planta.md).`);
let plan;
try { plan = JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch (e) { fail(`${MAP_FILES.plan} não é um JSON válido: ${e.message}`); }

const { scan, errors, warnings } = planToScan(plan, root);
// "services" e "data" citam nós de arquitetura.json: confere agora, se ele já estiver escrito
const archFile = path.join(outDir, MAP_FILES.arch);
if (scan && fs.existsSync(archFile)) {
  let ids = null;
  try { ids = (JSON.parse(fs.readFileSync(archFile, 'utf8')).nodes || []).map((n) => n?.id).filter(Boolean); } catch {}
  if (ids) for (const l of scan.nodeLinks) if (!ids.includes(l.to)) {
    const near = ids.find((id) => id.toLowerCase().startsWith(l.to.toLowerCase().slice(0, 3)));
    errors.push(`files "${l.from}".${l.kind === 'data' ? 'data' : 'services'} "${l.to}" não é o id de nenhum nó em ${MAP_FILES.arch}${near ? ` (você quis dizer "${near}"?)` : ''}`);
  }
}
const out = [];
if (errors.length) { out.push(`✗ ${errors.length} erro(s) em ${toPosix(path.relative(root, planFile))}:`); for (const e of errors) out.push(`  - ${e}`); }
if (warnings.length) { out.push(`! ${warnings.length} aviso(s):`); for (const w of warnings.slice(0, 40)) out.push(`  - ${w}`); }
if (errors.length) { console.log(out.join('\n')); console.log('\nCorrija os erros acima e rode plan.mjs de novo.'); process.exit(1); }

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(scan));
keepOutOfGit(outDir);

const bp = scan.blueprint;
const byDir = new Map();
for (const f of scan.files) { const d = f.path.split('/').slice(0, -1).slice(0, 2).join('/') || '.'; byDir.set(d, (byDir.get(d) || 0) + 1); }
if (out.length) out.push('');
out.push(`PLANTA  ${scan.files.length} arquivos planejados · ${scan.routes.length} endpoints · ${scan.http.length} chamadas a endpoints planejados · ${scan.nodeLinks.length} ligações com serviços e dados`);
for (const [d, n] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`  ${String(n).padStart(4)}  ${d}/`);
const screens = scan.files.filter((f) => f.screens).length;
if (screens) out.push(`TELAS  ${screens} planejada(s)`);
if (bp.questions.length) out.push(`PERGUNTAS EM ABERTO  ${bp.questions.length} (aparecem na Saúde até serem respondidas)`);
out.push('');
out.push(`✓ gravei ${toPosix(path.relative(root, outFile))}. Próximo passo: rode build.mjs${fs.existsSync(archFile) ? '' : ` quando ${MAP_DIR}/${MAP_FILES.arch} estiver escrito`}.`);
console.log(out.join('\n'));
