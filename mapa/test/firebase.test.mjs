// Cloud Functions do Firebase (#8): funções callable e onRequest são endpoints com o nome da exportação,
// as chamadas httpsCallable e fetch do site chegam a elas, e as Telas e a Saúde acompanham.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, lib, makeProject, run, readGraph, routeKeys, openEndpoints, cleanup } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { matchCalls } = await lib('routes.mjs');

let root, graph, summary;
before(() => {
  root = makeProject({}, { arch: {
    project: { name: 'firebase-app', summary: 'Fixture de teste.' },
    nodes: [
      { id: 'web', label: 'Site', kind: 'ui', summary: 'O site.', paths: ['web/**'] },
      { id: 'fn', label: 'Funções', kind: 'service', summary: 'As Cloud Functions.', paths: ['functions/**'] },
    ],
  } });
  fs.cpSync(path.join(FIXTURES, 'firebase-app'), root, { recursive: true });
  summary = run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

test('funções callable e onRequest são endpoints, com o nome que o arquivo de entrada exporta', () => {
  // archiveItem é exportada como retireItem; api é um app Express, então as rotas dele são os endpoints
  assert.deepEqual(routeKeys(graph), [
    'ANY /legacyPing', 'ANY /signDocument', 'CALL /approveItem', 'CALL /legacyStats', 'CALL /retireItem',
    'GET /api/reports', 'POST /api/reports',
  ]);
  assert.equal(graph.routes.find((r) => r.p === '/approveItem').d, 'Approves an item once an admin has reviewed it.');
  assert.equal(graph.routes.find((r) => r.p === '/api/reports' && r.m === 'GET').name, 'Buscar api reports');
});

test('as chamadas do site chegam às funções: httpsCallable, um ajudante em volta dele e fetch', () => {
  const http = graph.links.filter((l) => l.k === 'http').map((l) => `${l.a.slice(2)} -> ${l.b.slice(2)} ${l.labels.join(', ')}`).sort();
  assert.deepEqual(http, [
    'web/src/lib/firebase.ts -> functions/src/docs/api.ts GET /api/reports',
    'web/src/lib/firebase.ts -> functions/src/docs/signDocument.ts ANY /signDocument',
    'web/src/pages/Items.tsx -> functions/src/items/itemCallables.ts CALL /approveItem, CALL /retireItem',
    'web/src/pages/Items.tsx -> functions/src/legacy/v1.js CALL /legacyStats',
  ]);
});

test('as Telas mostram o código do servidor por trás de uma página que chama funções', () => {
  const items = graph.screens.find((s) => s.url === '/items');
  assert.ok(items, 'a tela /items');
  const server = items.behind.filter((b) => b.kind === 'server').map((b) => b.id);
  assert.deepEqual(server, ['f:functions/src/items/itemCallables.ts', 'f:functions/src/legacy/v1.js']);
  assert.deepEqual(items.behind[0], { id: 'f:web/src/pages/Items.tsx', note: 'A própria tela', kind: 'screen' });
  for (const b of items.behind.filter((x) => x.kind === 'request')) assert.match(b.note, /^Pede ao servidor/);
  for (const b of items.behind.filter((x) => x.kind === 'server')) assert.match(b.note, /^(Código do servidor que atende|Faz o trabalho por trás de) /);
});

test('Saúde: uma callable que confere request.auth ou context.auth está protegida; uma que não confere está aberta', () => {
  assert.deepEqual(openEndpoints(graph), ['ANY /legacyPing', 'CALL /retireItem', 'GET /api/reports', 'POST /api/reports']);
});

test('as funções em segundo plano aparecem no resumo da varredura', () => {
  assert.match(summary, /FUNÇÕES DO FIREBASE {2}3 callable, 3 onRequest, 3 em segundo plano/);
  assert.match(summary, /em segundo plano \(agendamentos e gatilhos; coloque-as num nó worker\):/);
  assert.match(summary, /nightlyCleanup {2}onSchedule "every day 03:00"/);
  assert.match(summary, /onOrderCreated {2}onDocumentCreated "orders\/\{orderId\}"/);
  assert.match(summary, /weeklyDigest {2}pubsub\.onRun "every monday 09:00"/);
});

test('cadeias da v1, genéricos em várias linhas, nomes agrupados e endereços cloudfunctions.net', () => {
  const fn = extract([
    `const functions = require('firebase-functions');`,
    `exports.report = functions.region('europe-west1').runWith({ memory: '1GB' }).https.onRequest((req, res) => res.end());`,
    `exports.onSignup = functions.auth.user().onCreate(async (user) => {});`,
    `const unsubscribe = db.collection('x').onSnapshot(() => {});`,
  ].join('\n'), 'javascript', 'functions/index.js');
  assert.deepEqual(fn.routes.map((r) => `${r.method} ${r.path}`), ['ANY /report']);
  assert.deepEqual(fn.triggers.map((t) => `${t.name} ${t.on}`), ['onSignup auth.onCreate']);

  const web = extract([
    `import { httpsCallable } from 'firebase/functions';`,
    `const a = httpsCallable<`,
    `  Req,`,
    `  Promise<Res>`,
    `>(getFunctions(app), 'items-approve');`,
    `const b = functions.httpsCallable('legacyName');`,
    'fetch(`https://${REGION}-${PROJECT}.cloudfunctions.net/report`);',
  ].join('\n'), 'typescript', 'web/api.ts');
  assert.deepEqual(web.calls.map((c) => `${c.method} ${c.path}`).sort(), ['CALL /items/approve', 'CALL /legacyName', 'null /report']);
  assert.deepEqual(web.hosts, []);
});

test('uma callable só combina com callables, e uma URL nunca combina com uma callable', () => {
  const routes = [
    { file: 'fn/a.ts', method: 'CALL', path: '/approve' },
    { file: 'api/b.ts', method: 'ANY', path: '/approve' },
  ];
  const files = [{ path: 'web/x.ts', calls: [{ path: '/approve', method: 'CALL', line: 1 }, { path: '/approve', method: 'POST', line: 2 }] }];
  assert.deepEqual(matchCalls(files, routes).map((h) => `${h.line} ${h.to}`), ['1 fn/a.ts', '2 api/b.ts']);
});
