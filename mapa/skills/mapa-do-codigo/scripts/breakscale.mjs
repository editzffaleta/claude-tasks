#!/usr/bin/env node
// Simulação no Breakscale (https://breakscale.tech): onde o sistema mapeado quebra quando o tráfego sobe.
// Veja referencias/simulacao.md para o passo a passo.
// uso:
//   node breakscale.mjs rascunho [raiz] [--forcar]                  monta mapa-do-codigo/simulacao-projeto.json a partir do mapa
//   node breakscale.mjs simular  [raiz] [--remoto] [--cenarios 1,2,5,10]
//                                                                   roda o simulador e grava simulacao.json e simulacao.breakscale
//   node breakscale.mjs anotar   [raiz]                             passa as sugestões do projeto para o resultado, sem simular de novo
//   node breakscale.mjs status   [raiz]
// O simulador é o pacote breakscale-mcp (MIT), rodando neste computador pelo npx: nada sai daqui.
// Com --remoto usa o servidor hospedado do Breakscale, e o projeto simulado (nomes e ligações das peças,
// nunca o código) é enviado para lá. MAPA_BREAKSCALE_CMD (lista JSON) troca o comando local.
import fs from 'node:fs';
import path from 'node:path';
import { keepOutOfGit, MAP_DIR, MAP_FILES, parseArgs } from './lib/common.mjs';
import {
  BREAKSCALE_PACKAGE, DEFAULT_SCENARIOS, DESIGN_SCHEMA, LOCAL_COMMAND, REMOTE_URL, RESULT_SCHEMA, SIM_FILES,
  applySuggestions, checkDesign, draftFromGraph, findBottlenecks, fmtFactor, forBreakscale, parseRun,
} from './lib/breakscale.mjs';
import { httpClient, stdioClient } from './lib/breakscale-mcp.mjs';

const args = parseArgs(process.argv.slice(2));
const [action = 'status', rootArg = '.'] = args._;
const root = path.resolve(rootArg);
const dir = path.join(root, MAP_DIR);
const file = (name) => path.join(dir, name);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, data) => fs.writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };
const designPath = file(SIM_FILES.design);
const resultPath = file(SIM_FILES.result);

const ms = (v) => (v == null ? '?' : v >= 1000 ? `${String(Math.round(v / 100) / 10).replace('.', ',')} s` : `${Math.round(v)} ms`);
const pct = (v) => (v == null ? '?' : `${String(Math.round(v * 1000) / 10).replace('.', ',')}%`);
const rate = (v) => (v == null ? '?' : `${String(Math.round(v * 10) / 10).replace('.', ',')}/s`);

if (action === 'rascunho') {
  const graphFile = file(MAP_FILES.graph);
  if (!fs.existsSync(graphFile)) fail(`Ainda não há mapa em ${MAP_DIR}/. Faça o mapa do código primeiro (scan.mjs e build.mjs).`);
  if (fs.existsSync(designPath) && !args.forcar) {
    fail(`${MAP_DIR}/${SIM_FILES.design} já existe e pode ter ajustes feitos à mão. Edite esse arquivo, ou rode de novo com --forcar para começar do zero.`);
  }
  const design = draftFromGraph(readJson(graphFile));
  if (!design.nodes.length) fail('O mapa não tem servidores, telas, bancos ou filas ligados entre si para simular.');
  keepOutOfGit(dir);
  writeJson(designPath, design);
  const lines = [
    `RASCUNHO  ${MAP_DIR}/${SIM_FILES.design}: ${design.nodes.length} componentes, ${design.edges.length} ligações.`,
    ...design.nodes.map((n) => `  ${n.kind.padEnd(12)} ${n.id}  ${n.label}`),
    '',
    'LIGAÇÕES',
    ...design.edges.map((e) => `  ${e.from} → ${e.to}`),
  ];
  if (design.deixadoDeFora.length) lines.push('', 'DEIXADO DE FORA', ...design.deixadoDeFora.map((x) => `  - ${x.texto}`));
  lines.push(
    '',
    `PRÓXIMO PASSO  Todos os números estão no padrão do Breakscale (veja "premissas"). Leia o código e troque pelo que ele diz:`,
    '  pool de conexões e limites → capacity; réplicas e processos → instances; tempo médio → serviceMs;',
    '  timeouts e novas tentativas de quem chama → timeoutMs e retries; tráfego real → rps de cada origem (client).',
    '  Para cada número trocado, atualize a premissa com a origem (arquivo:linha) e origem "código". Depois rode: breakscale.mjs simular',
  );
  console.log(lines.join('\n'));
} else if (action === 'simular') {
  if (!fs.existsSync(designPath)) fail(`Falta ${MAP_DIR}/${SIM_FILES.design}. Rode primeiro: breakscale.mjs rascunho`);
  let design;
  try { design = readJson(designPath); } catch (e) { fail(`${SIM_FILES.design} não é um JSON válido: ${e.message}`); }
  if (args.cenarios) design.cenarios = String(args.cenarios).split(',').map(Number);
  const problems = checkDesign(design);
  if (problems.length) fail(`O projeto tem problemas:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const scenarios = [...new Set((design.cenarios ?? DEFAULT_SCENARIOS).map(Number))].sort((a, b) => a - b);
  const remote = !!args.remoto;
  let client;
  try {
    if (remote) client = await httpClient(process.env.MAPA_BREAKSCALE_URL || REMOTE_URL);
    else {
      const command = process.env.MAPA_BREAKSCALE_CMD ? JSON.parse(process.env.MAPA_BREAKSCALE_CMD) : LOCAL_COMMAND;
      console.log(`Rodando o simulador do Breakscale neste computador (${command.join(' ')}).${command === LOCAL_COMMAND ? ' Na primeira vez o npx baixa o pacote.' : ''}`);
      client = await stdioClient(command);
    }
  } catch (e) {
    fail(`Não deu para falar com o Breakscale: ${e.message}`);
  }
  const results = [];
  let breakscaleFile = null;
  try {
    for (const factor of scenarios) {
      const text = await client.call('create_view', forBreakscale(design, factor));
      const run = parseRun(text);
      results.push({ fator: factor, nome: factor === 1 ? 'Tráfego de base' : `${fmtFactor(factor)} o tráfego`, ...run });
    }
    breakscaleFile = await client.call('export_design', forBreakscale(design, 1));
  } catch (e) {
    client.close();
    fail(e.code === 'tool_error' ? `${e.message}\nCorrija ${SIM_FILES.design} e rode de novo.` : e.message);
  }
  client.close();
  let parsedFile = null;
  try { parsedFile = JSON.parse(breakscaleFile); } catch {}
  if (parsedFile?.app !== 'breakscale') fail('O export_design não devolveu um arquivo .breakscale.');

  const names = new Map(design.nodes.map((n) => [n.id, n]));
  const result = {
    $schema: RESULT_SCHEMA,
    nome: design.nome,
    geradoEm: new Date().toISOString(),
    origem: remote ? 'hospedado' : 'local',
    pacote: remote ? null : BREAKSCALE_PACKAGE,
    link: results.find((r) => r.fator === 1)?.link || results[0]?.link || null,
    arquivo: SIM_FILES.file,
    componentes: design.nodes.map((n) => ({ id: n.id, nome: n.label || n.id, tipo: n.kind })),
    cenarios: results.map((r) => ({ ...r, componentes: r.componentes.filter((c) => names.has(c.id)) })),
    gargalos: findBottlenecks(results, design),
    premissas: design.premissas || [],
    deixadoDeFora: design.deixadoDeFora || [],
  };
  keepOutOfGit(dir);
  writeJson(resultPath, result);
  fs.writeFileSync(file(SIM_FILES.file), breakscaleFile.endsWith('\n') ? breakscaleFile : `${breakscaleFile}\n`);

  const lines = [`SIMULAÇÃO  ${result.nome}, ${remote ? 'no servidor do Breakscale' : 'neste computador'}, semente ${results[0]?.semente ?? '?'}.`];
  for (const r of results) {
    lines.push(`  ${r.nome.padEnd(16)} ${rate(r.oferecido)} chegando, ${rate(r.servido)} atendidos, ${pct(r.falhas)} falham, p95 ${ms(r.p95)}, p99 ${ms(r.p99)}${r.interrompido ? ' (simulação interrompida: pesada demais)' : ''}`);
  }
  if (result.gargalos.length) {
    lines.push('', 'GARGALOS');
    for (const g of result.gargalos) lines.push(`  [${g.severidade}] ${g.titulo}\n      ${g.porque}${g.sugestao ? `\n      Sugestão: ${g.sugestao}` : ''}`);
  } else lines.push('', `GARGALOS  nenhum até ${fmtFactor(scenarios.at(-1))} o tráfego de base.`);
  const guessed = (design.premissas || []).filter((p) => p.origem !== 'código').length;
  lines.push(
    '',
    `ARQUIVOS  ${MAP_DIR}/${SIM_FILES.result} e ${MAP_DIR}/${SIM_FILES.file} (abre em breakscale.tech, em Settings > Open a file).`,
    result.link ? `LINK  ${result.link}` : 'LINK  o projeto é grande demais para caber num link; use o arquivo .breakscale.',
    '',
    `PRÓXIMO PASSO  Conte ao usuário, em português simples, onde o sistema quebra e por quê, e diga quais números foram chute (${guessed} premissa(s) ainda são chute).`,
    `  Para cada gargalo, escreva uma sugestão em "sugestoes" no ${SIM_FILES.design} ({ "<id do componente>": "texto" }) e rode: breakscale.mjs anotar`,
    '  Os gargalos aparecem na aba Mapa do código do quadro, em Simulação, com um botão para virar tarefa.',
  );
  console.log(lines.join('\n'));
} else if (action === 'anotar') {
  if (!fs.existsSync(resultPath)) fail('Ainda não há simulação. Rode: breakscale.mjs simular');
  const result = applySuggestions(readJson(resultPath), readJson(designPath));
  writeJson(resultPath, result);
  const filled = result.gargalos.filter((g) => g.sugestao).length;
  console.log(`ANOTADO  ${filled} de ${result.gargalos.length} gargalo(s) com sugestão.`);
} else if (action === 'status') {
  if (!fs.existsSync(designPath)) {
    console.log(`nenhuma simulação: rode breakscale.mjs rascunho para montar o projeto do Breakscale a partir do mapa.`);
  } else if (!fs.existsSync(resultPath)) {
    const d = readJson(designPath);
    console.log(`projeto montado (${d.nodes?.length ?? 0} componentes) e ainda não simulado: rode breakscale.mjs simular.`);
  } else {
    const r = readJson(resultPath);
    const designNewer = fs.statSync(designPath).mtimeMs > fs.statSync(resultPath).mtimeMs + 1000;
    console.log(`simulado em ${r.geradoEm} (${r.cenarios.length} cenários, ${r.gargalos.length} gargalo(s)).${designNewer ? ` O ${SIM_FILES.design} mudou depois disso: rode breakscale.mjs simular de novo.` : ''}`);
  }
} else {
  fail(`Ação desconhecida: ${action}. Use rascunho, simular, anotar ou status. (esquema ${DESIGN_SCHEMA})`);
}
