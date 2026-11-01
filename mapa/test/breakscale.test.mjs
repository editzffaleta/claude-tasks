// Simulação no Breakscale: o rascunho tirado do mapa, a leitura do texto do simulador, a escolha dos
// gargalos e o comando breakscale.mjs falando com um servidor MCP falso (stdio e HTTP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { FIXTURES, SKILL, cleanup, lib, mapPath, readJson, writeJson } from './helpers.mjs';

const bs = await lib('breakscale.mjs');
const FAKE = path.join(FIXTURES, 'fake-breakscale.mjs');
const fakeEnv = { ...process.env, MAPA_BREAKSCALE_CMD: JSON.stringify([process.execPath, FAKE]) };

// Um grafo de mapa pequeno: site → API → Postgres; a API publica numa fila que um worker consome,
// cobra no Stripe e usa uma biblioteca interna.
const GRAPH = {
  schema: 'floorplan/graph@1',
  meta: { rootName: 'loja' },
  project: { name: 'Loja' },
  nodes: [
    { id: 'web', parent: null, label: 'Site da loja', kind: 'ui' },
    { id: 'web.paginas', parent: 'web', label: 'Páginas', kind: 'feature' },
    { id: 'api', parent: null, label: 'Servidor da loja', kind: 'service' },
    { id: 'api.pedidos', parent: 'api', label: 'Pedidos', kind: 'feature' },
    { id: 'jobs', parent: null, label: 'Envio de e-mails', kind: 'worker' },
    { id: 'comum', parent: null, label: 'Código comum', kind: 'library' },
    { id: 'testes', parent: null, label: 'Testes', kind: 'test' },
    { id: 'pg', parent: null, label: 'Postgres', kind: 'external', packages: ['pg'] },
    { id: 'fila', parent: null, label: 'Fila de e-mails', kind: 'external', packages: ['bullmq'] },
    { id: 'redis', parent: null, label: 'Redis', kind: 'external', packages: ['ioredis'] },
    { id: 'stripe', parent: null, label: 'Stripe', kind: 'external', hosts: ['api.stripe.com'] },
  ],
  files: [
    { p: 'web/src/pedidos.js', n: 'web.paginas' },
    { p: 'api/pedidos.js', n: 'api.pedidos' },
    { p: 'api/db.js', n: 'api' },
    { p: 'jobs/email.js', n: 'jobs' },
    { p: 'comum/util.js', n: 'comum' },
  ],
  links: [
    { a: 'f:web/src/pedidos.js', b: 'f:api/pedidos.js', k: 'http', labels: ['POST /api/pedidos'] },
    { a: 'f:api/db.js', b: 'n:pg', k: 'import', names: ['pg'] },
    { a: 'f:api/pedidos.js', b: 'n:fila', k: 'queue' },
    { a: 'f:jobs/email.js', b: 'n:fila', k: 'queue' },
    { a: 'f:api/pedidos.js', b: 'n:stripe', k: 'http' },
    { a: 'f:api/pedidos.js', b: 'f:comum/util.js', k: 'import' },
    { a: 'f:jobs/email.js', b: 'f:comum/util.js', k: 'import' },
  ],
};

function projectWithMap(graph = GRAPH) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mapa-breakscale-'));
  writeJson(mapPath(root, 'grafo.json'), graph);
  return root;
}
const cli = (...args) => execFileSync(process.execPath, [path.join(SKILL, 'scripts', 'breakscale.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe', env: fakeEnv });
const cliFail = (...args) => spawnSync(process.execPath, [path.join(SKILL, 'scripts', 'breakscale.mjs'), ...args], { encoding: 'utf8', env: fakeEnv });

test('os serviços externos viram o componente certo pelo nome, pacotes e hosts', () => {
  assert.equal(bs.storeKind({ id: 'pg', label: 'Postgres' }), 'db');
  assert.equal(bs.storeKind({ id: 'sqlite', label: 'Banco SQLite' }), 'db');
  assert.equal(bs.storeKind({ id: 'cache', label: 'Cache', packages: ['ioredis'] }), 'cache');
  assert.equal(bs.storeKind({ id: 'k', label: 'Eventos', packages: ['kafkajs'] }), 'streambroker');
  assert.equal(bs.storeKind({ id: 'q', label: 'Jobs', packages: ['bullmq'] }), 'queue');
  assert.equal(bs.storeKind({ id: 's3', label: 'Arquivos', hosts: ['bucket.s3.amazonaws.com'] }), 'objectstore');
  assert.equal(bs.storeKind({ id: 'stripe', label: 'Stripe', hosts: ['api.stripe.com'] }), null);
});

test('o rascunho tem só o que roda, com as ligações na direção do tráfego e todos os números como premissa', () => {
  const d = bs.draftFromGraph(GRAPH, { now: new Date('2026-11-01T00:00:00Z') });
  assert.equal(d.$schema, 'mapa/simulacao-projeto@1');
  assert.equal(d.nome, 'Loja');
  const kinds = Object.fromEntries(d.nodes.map((n) => [n.id, n.kind]));
  assert.deepEqual(kinds, { api: 'service', jobs: 'worker', pg: 'db', fila: 'queue', 'origem-web': 'client' });
  assert.ok(!('comum' in kinds) && !('testes' in kinds), 'biblioteca e testes ficam de fora');
  assert.ok(!('redis' in kinds), 'o que nada usa fica de fora');
  const edges = d.edges.map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(edges, ['api>fila', 'api>pg', 'fila>jobs', 'origem-web>api'], 'o worker consome a fila (fila → worker)');
  assert.ok(d.deixadoDeFora.some((x) => /Stripe/.test(x.texto)), 'a chamada ao Stripe é explicada, não ligada');
  assert.ok(d.deixadoDeFora.some((x) => /Redis/.test(x.texto)));
  assert.deepEqual(d.premissas.map((p) => p.componente).sort(), ['api', 'fila', 'jobs', 'origem-web', 'pg']);
  assert.ok(d.premissas.every((p) => p.origem === 'chute'));
  assert.deepEqual(bs.checkDesign(d), []);
});

test('sem tela no mapa, os servidores de entrada ganham uma origem de tráfego genérica', () => {
  const g = { ...GRAPH, nodes: GRAPH.nodes.filter((n) => !n.id.startsWith('web')), links: GRAPH.links.filter((l) => !l.a.startsWith('f:web')) };
  const d = bs.draftFromGraph(g);
  assert.ok(d.edges.some((e) => e.from === 'origem-usuarios' && e.to === 'api'));
});

test('o projeto é conferido antes de ir para o Breakscale', () => {
  assert.match(bs.checkDesign({ nodes: [] }).join(' '), /pelo menos um/);
  const p = bs.checkDesign({ nodes: [{ id: 'a', kind: 'servidor' }, { id: 'a', kind: 'db' }], edges: [{ from: 'a', to: 'x' }], cenarios: [0] }).join('\n');
  assert.match(p, /tipo "servidor"/);
  assert.match(p, /Dois componentes com o id 'a'/);
  assert.match(p, /origem de tráfego/);
  assert.match(p, /'x'/);
  assert.match(p, /cenarios/);
});

test('cada cenário multiplica o tráfego das origens e manda só o formato curto', () => {
  const d = { nome: 'Loja', nodes: [{ id: 'u', kind: 'client', label: 'Usuários', config: { rps: 40 } }, { id: 'api', kind: 'service', config: { capacity: 16 } }], edges: [{ from: 'u', to: 'api', extra: 1 }], premissas: [], sugestoes: {} };
  const x = bs.forBreakscale(d, 5);
  assert.equal(x.name, 'Loja (5× o tráfego)');
  assert.equal(x.nodes[0].config.rps, 200);
  assert.deepEqual(x.nodes[1], { id: 'api', kind: 'service', config: { capacity: 16 } });
  assert.deepEqual(x.edges, [{ from: 'u', to: 'api' }]);
  assert.equal(bs.forBreakscale({ ...d, nodes: [{ id: 'u', kind: 'client' }] }, 2).nodes[0].config.rps, 100, 'sem rps, parte dos 50 do Breakscale');
  assert.equal(d.nodes[0].config.rps, 40, 'o original não muda');
});

// O texto do create_view, montado como o run.ts do breakscale-mcp 0.1.1 escreve.
const RUN_TEXT = [
  'Simulated 30s with seed 1.',
  'Offered 250/s, served 190/s, 24.0% failed. Latency p50 41ms, p95 820ms, p99 1.9s.',
  'Failed requests over the run: 1200 were turned away by a full queue; 600 timed out; 3 gave up waiting for a pool slot.',
  '',
  'Components (busiest first):',
  "- Banco (principal) (db, id 'pg'): 250/s in, 190/s done, 100.0% busy, 64 waiting, p99 1.7s, 24.0% failed, 40/s turned away, 20/s timed out",
  "- Servidor da loja (service, id 'api'): 250/s in, 190/s done, 61.5% busy, p99 1.9s",
  "- Cache (cache, id 'redis'): 12.5/s in, 12.5/s done, 3.1% busy, p99 4ms, hit rate 80.0%",
  '',
  'Link to the design, which opens it on breakscale.tech: https://breakscale.tech/#d3.AQIDBA',
  '',
  'A changed design can be shown by passing the whole updated design to create_view; keeping the node ids keeps the layout stable.',
].join('\n');

test('o texto do simulador vira números, inclusive nomes com parênteses e os motivos das falhas', () => {
  const r = bs.parseRun(RUN_TEXT);
  assert.deepEqual([r.segundos, r.semente, r.interrompido], [30, 1, false]);
  assert.deepEqual([r.oferecido, r.servido, r.falhas, r.p50, r.p95, r.p99], [250, 190, 0.24, 41, 820, 1900]);
  assert.deepEqual(r.motivos.map((m) => [m.motivo, m.n]), [['shed', 1200], ['timeout', 600], ['acquire-timeout', 3]]);
  const pg = r.componentes.find((c) => c.id === 'pg');
  assert.equal(pg.nome, 'Banco (principal)');
  assert.deepEqual([pg.entrada, pg.concluidas, pg.ocupacao, pg.esperando, pg.p99, pg.falhas, pg.recusadas, pg.tempoEsgotado], [250, 190, 1, 64, 1700, 0.24, 40, 20]);
  assert.equal(r.componentes.find((c) => c.id === 'redis').acertoCache, 0.8);
  assert.equal(r.link, 'https://breakscale.tech/#d3.AQIDBA');
  assert.equal(bs.parseRun(RUN_TEXT.replace('Simulated 30s with seed 1.', 'Simulated 12s with seed 1 (stopped at 12s of 30s: the design is too heavy to simulate further here).')).interrompido, true);
  assert.throws(() => bs.parseRun('The design was not accepted'), /formato que esta versão não reconhece/);
});

test('o primeiro cenário em que um componente não aguenta vira um gargalo, com urgência pelo tamanho do tráfego', () => {
  const ok = { id: 'api', tipo: 'service', ocupacao: 0.4 };
  const scenarios = [
    { fator: 10, oferecido: 500, componentes: [{ id: 'api', tipo: 'service', ocupacao: 1, esperando: 30, falhas: 0.2 }, { id: 'pg', tipo: 'db', ocupacao: 1 }] },
    { fator: 1, oferecido: 50, componentes: [ok, { id: 'pg', tipo: 'db', ocupacao: 0.5 }] },
    { fator: 2, oferecido: 100, componentes: [ok, { id: 'pg', tipo: 'db', ocupacao: 0.95, recusadas: 2.5 }, { id: 'u', tipo: 'client', ocupacao: 1 }] },
  ];
  const g = bs.findBottlenecks(scenarios, { nodes: [{ id: 'pg', label: 'Postgres' }, { id: 'api', label: 'Servidor' }], sugestoes: { pg: 'Pôr um cache na frente.' } });
  assert.deepEqual(g.map((x) => [x.id, x.fator, x.severidade]), [['pg', 2, 'alta'], ['api', 10, 'baixa']]);
  assert.equal(g[0].titulo, 'Postgres não aguenta 2× o tráfego');
  assert.equal(g[0].porque, 'Com 2× o tráfego (100 pedidos por segundo), Postgres fica 95% ocupado e 2,5 por segundo são recusados por fila cheia.');
  assert.equal(g[0].sugestao, 'Pôr um cache na frente.');
  assert.match(g[1].porque, /30 pedidos esperam na fila/);
});

test('rascunho: precisa de mapa e não apaga ajustes feitos à mão', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'mapa-breakscale-'));
  try {
    const r = cliFail('rascunho', empty);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Ainda não há mapa/);
  } finally { cleanup(empty); }
  const root = projectWithMap();
  try {
    const out = cli('rascunho', root);
    assert.match(out, /RASCUNHO {2}mapa-do-codigo\/simulacao-projeto\.json: 5 componentes, 4 ligações/);
    assert.match(out, /fila → jobs/);
    assert.equal(fs.readFileSync(mapPath(root, '.gitignore'), 'utf8').includes('*'), true, 'a pasta continua fora do git');
    const again = cliFail('rascunho', root);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /--forcar/);
    assert.match(cli('rascunho', root, '--forcar'), /RASCUNHO/);
  } finally { cleanup(root); }
});

test('simular: roda os cenários, grava o resultado e o arquivo .breakscale, e as sugestões entram depois', () => {
  const root = projectWithMap();
  try {
    assert.match(cli('status', root), /nenhuma simulação/);
    cli('rascunho', root);
    assert.match(cli('status', root), /ainda não simulado/);
    const out = cli('simular', root);
    assert.match(out, /SIMULAÇÃO {2}Loja, neste computador/);
    assert.match(out, /10× o tráfego/);
    const r = readJson(mapPath(root, 'simulacao.json'));
    assert.equal(r.$schema, 'mapa/simulacao@1');
    assert.deepEqual(r.cenarios.map((c) => c.fator), [1, 2, 5, 10]);
    assert.equal(r.origem, 'local');
    assert.equal(r.pacote, 'breakscale-mcp@0.1.1');
    assert.match(r.link, /^https:\/\/breakscale\.tech\/#d3\./);
    assert.ok(r.gargalos.length >= 1, 'com 10× o tráfego algo quebra');
    assert.ok(r.cenarios.every((c) => c.componentes.every((x) => x.tipo !== 'client')));
    const file = readJson(mapPath(root, 'simulacao.breakscale'));
    assert.equal(file.app, 'breakscale');
    assert.equal(file.topology.nodes.length, 5);
    assert.match(cli('status', root), /simulado em/);

    const design = readJson(mapPath(root, 'simulacao-projeto.json'));
    design.sugestoes = { [r.gargalos[0].componente]: 'Aumentar o pool de conexões.' };
    writeJson(mapPath(root, 'simulacao-projeto.json'), design);
    assert.match(cli('anotar', root), /ANOTADO {2}1 de/);
    assert.equal(readJson(mapPath(root, 'simulacao.json')).gargalos[0].sugestao, 'Aumentar o pool de conexões.');
    assert.match(cli('simular', root, '--cenarios', '1,3'), /3× o tráfego/);
    assert.deepEqual(readJson(mapPath(root, 'simulacao.json')).cenarios.map((c) => c.fator), [1, 3]);
  } finally { cleanup(root); }
});

test('simular: o que o Breakscale recusa volta como erro para corrigir o projeto', () => {
  const root = projectWithMap();
  try {
    cli('rascunho', root);
    const d = readJson(mapPath(root, 'simulacao-projeto.json'));
    writeJson(mapPath(root, 'simulacao-projeto.json'), { ...d, nodes: [...d.nodes, { id: 'x', kind: 'servidor' }] });
    const local = cliFail('simular', root);
    assert.equal(local.status, 1);
    assert.match(local.stderr, /tipo "servidor"/, 'a conferência local pega antes de chamar o simulador');
    writeJson(mapPath(root, 'simulacao-projeto.json'), { ...d, nodes: [...d.nodes, { id: 'x', kind: 'sidecar' }], edges: [...d.edges, { from: 'api', to: 'x' }] });
    const remote = cliFail('simular', root);
    assert.equal(remote.status, 1);
    assert.match(remote.stderr, /O Breakscale recusou o create_view/);
    assert.match(remote.stderr, /Corrija simulacao-projeto\.json/);
    assert.ok(!fs.existsSync(mapPath(root, 'simulacao.json')), 'nada é gravado pela metade');
  } finally { cleanup(root); }
});

test('simular --remoto: fala com o servidor hospedado por HTTP, com sessão e respostas em SSE', async () => {
  const { startHttp } = await import(FAKE);
  const { server, calls, url } = await startHttp();
  const root = projectWithMap();
  try {
    cli('rascunho', root);
    const out = await new Promise((resolve, reject) => {
      const env = { ...process.env, MAPA_BREAKSCALE_URL: url };
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, [path.join(SKILL, 'scripts', 'breakscale.mjs'), 'simular', root, '--remoto'], { env, encoding: 'utf8' }, (err, stdout, stderr) => (err ? reject(new Error(stderr)) : resolve(stdout))));
    });
    assert.match(out, /no servidor do Breakscale/);
    const r = readJson(mapPath(root, 'simulacao.json'));
    assert.equal(r.origem, 'hospedado');
    assert.equal(r.pacote, null);
    assert.equal(calls[0].method, 'initialize');
    assert.equal(calls[0].session, null);
    assert.ok(calls.slice(1).every((c) => c.session === 'sessao-teste'), 'a sessão volta em todo pedido depois do initialize');
    assert.match(calls[0].accept, /text\/event-stream/);
    assert.equal(calls.filter((c) => c.method === 'tools/call').length, 5, '4 cenários e o export');
  } finally {
    server.close();
    cleanup(root);
  }
});
