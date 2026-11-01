// Plantas: um mapa planejado a partir de um PRD antes de existir qualquer código. O plan.mjs transforma
// mapa-do-codigo/plano.json numa varredura, e o build.mjs a desenha como um mapa de código, com uma revisão
// do plano no lugar das verificações de código.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, MAP, FILES, SKILL, makeProject, mapPath, run, readGraph, readJson, writeJson, routeKeys, cleanup } from './helpers.mjs';

const FIXTURE = path.join(FIXTURES, 'blueprint');
let root, graph, planOut, buildOut;
before(() => {
  root = makeProject({});
  fs.cpSync(FIXTURE, root, { recursive: true });
  planOut = run('plan.mjs', root);
  buildOut = run('build.mjs', root, '--no-claude-md');
  graph = readGraph(root);
});
after(() => cleanup(root));

/** Uma cópia do exemplo com o plano.json alterado, para os casos de erro. */
function withPlan(change) {
  const r = makeProject({});
  fs.cpSync(FIXTURE, r, { recursive: true });
  const file = mapPath(r, FILES.plan);
  const plan = readJson(file);
  change(plan);
  writeJson(file, plan);
  return r;
}
const fails = (fn) => { try { fn(); } catch (e) { return String(e.stdout || '') + String(e.stderr || ''); } assert.fail('esperava que o script falhasse'); };

test('os arquivos e endpoints planejados estão no mapa, com os nomes que o plano dá', () => {
  assert.match(planOut, /PLANTA {2}21 arquivos planejados · 11 endpoints · 9 chamadas a endpoints planejados · 5 ligações com serviços e dados/);
  assert.match(planOut, /TELAS {2}5 planejada\(s\)/);
  assert.match(planOut, /PERGUNTAS EM ABERTO {2}1 \(aparecem na Saúde até serem respondidas\)/);
  assert.match(planOut, new RegExp(`✓ gravei ${MAP}/\\.cache/scan\\.json\\. Próximo passo: rode build\\.mjs\\.`));
  assert.equal(graph.files.length, 21);
  assert.equal(graph.files.filter((f) => f.auto).length, 0, 'todo arquivo tem descrição');
  assert.equal(graph.routes.length, 11);
  assert.equal(graph.files.find((f) => f.p === 'web/app/page.tsx').name, 'Página inicial');
  const book = graph.routes.find((r) => r.m === 'POST' && r.p === '/api/bookings');
  assert.equal(book.name, 'Reservar um passeio');
  assert.equal(book.access, 'signed-in');
  assert.deepEqual(graph.meta.blueprint.stack.slice(0, 2), ['Sites em Next.js para os donos e os passeadores', 'Servidor em Node.js + Express']);
  assert.equal(graph.meta.blueprint.source, 'docs/prd.md');
  assert.match(buildOut, /DESCRIÇÕES {2}arquivos 21\/21 · endpoints 11\/11/);
  assert.match(buildOut, new RegExp(`PLANTA {2}planejado, ainda não construído: desenhado a partir de ${MAP}/plano\\.json`));
});

test('as telas chamam endpoints, e os arquivos chegam aos serviços externos e ao banco de dados', () => {
  const http = graph.links.filter((l) => l.k === 'http' && l.labels?.length && l.a.startsWith('f:web/app/bookings')).map((l) => `${l.b.slice(2)} ${l.labels.join(', ')}`);
  assert.deepEqual(http, ['api/src/routes/bookings.ts GET /api/bookings, POST /api/bookings/:id/cancel']);
  const toNodes = graph.links.filter((l) => l.b.startsWith('n:')).map((l) => `${l.a.slice(2)} ${l.k} ${l.b.slice(2)}`).sort();
  assert.deepEqual(toNodes, [
    'api/src/db/bookings.ts data db', 'api/src/db/users.ts data db', 'api/src/db/walkers.ts data db',
    'api/src/services/email.ts http postmark', 'api/src/services/payments.ts http stripe',
  ]);
});

test('as Telas mostram do que cada página planejada depende, até o Stripe', () => {
  assert.deepEqual(graph.screens.map((s) => s.url).sort(), ['/', '/book/:walkerId', '/bookings', '/login', '/schedule']);
  const book = graph.screens.find((s) => s.url === '/book/:walkerId');
  const behind = book.behind.map((b) => `${b.kind} ${b.id}`);
  assert.ok(behind.includes('server f:api/src/routes/bookings.ts'));
  assert.ok(behind.includes('outside n:stripe'));
  // as notas são em português, e os pedidos ao servidor seguem o nome em português do endpoint
  const notes = Object.fromEntries(book.behind.map((b) => [b.id, b.note]));
  assert.equal(notes['f:web/app/book/[walkerId]/page.tsx'], 'A própria tela');
  assert.equal(notes[`r:${graph.routes.findIndex((r) => r.m === 'POST' && r.p === '/api/bookings')}`], 'Pede ao servidor para reservar um passeio');
  assert.equal(notes[`r:${graph.routes.findIndex((r) => r.m === 'GET' && r.p === '/api/walkers/:id/slots')}`], 'Pede ao servidor: horários livres de um passeador');
  assert.match(notes['f:api/src/routes/bookings.ts'], /^Código do servidor que atende “Reservar um passeio”/);
  assert.equal(notes['n:stripe'], 'Serviço externo, usado por Pagamentos com cartão');
  const db = graph.screens.find((s) => s.url === '/bookings').behind.find((b) => b.id === 'n:db');
  if (db) assert.equal(db.note, 'Onde os dados ficam guardados');
});

test('a Saúde é uma revisão do plano', () => {
  const issues = graph.health.issues;
  const titles = issues.map((i) => `${i.severity} ${i.title}`);
  assert.deepEqual(titles, [
    'medium Qualquer pessoa poderia alterar dados por um endpoint planejado',
    'medium O plano não diz quem pode usar um endpoint',
    'medium Os donos podem cancelar um passeio de graça? Até quando?',
    'low Nada no plano usa um endpoint',
    'low Um arquivo planejado não está ligado a nada',
  ]);
  const routesOf = (i) => i.items.filter((id) => id.startsWith('r:')).map((id) => `${graph.routes[+id.slice(2)].m} ${graph.routes[+id.slice(2)].p}`).sort();
  // o login é aberto de propósito (publicBecause diz por quê), então só o cadastro é apontado
  assert.deepEqual(routesOf(issues[0]), ['POST /api/auth/signup']);
  assert.deepEqual(routesOf(issues[1]), ['DELETE /api/walkers/:id']);
  assert.deepEqual(issues[2].items.sort(), ['f:web/app/bookings/page.tsx', `r:${graph.routes.findIndex((r) => r.p === '/api/bookings/:id/cancel')}`].sort());
  assert.deepEqual(routesOf(issues[3]), ['DELETE /api/walkers/:id']);
  assert.deepEqual(issues[4].items, ['f:api/src/lib/geo.ts']);
  assert.match(issues[0].fix, /^Revisão do plano em mapa-do-codigo\/plano\.json: /);
  assert.match(issues[0].fix, /Depois redesenhe a planta: rode plan\.mjs e build\.mjs da skill Mapa do código/);
  assert.equal(issues[0].notes[issues[0].items[0]], 'Planejado como aberto a qualquer pessoa, e altera dados');
  assert.match(issues[2].fix, /^Pergunta em aberto na planta \(mapa-do-codigo\/plano\.json\): Os donos podem cancelar/);
  // cada item também tem um pedido para resolvê-lo pelo mapa, para a pessoa completar ou editar
  assert.deepEqual(issues.map((i) => i.change), [
    'Revise quem pode usar POST /api/auth/signup: hoje qualquer pessoa consegue alterar dados por ele. ',
    'Decida quem pode usar DELETE /api/walkers/:id, com base no PRD. ',
    'Pergunta em aberto: "Os donos podem cancelar um passeio de graça? Até quando?" Minha resposta: ',
    'Nada chama DELETE /api/walkers/:id. Acrescente a tela ou o serviço que deveria usar esse endpoint, ou remova-o se ele não for necessário. ',
    'api/src/lib/geo.ts não está ligado a nada. Ligue esse arquivo ao que deveria usá-lo, ou remova-o. ',
  ]);
  assert.match(buildOut, /REVISÃO DA PLANTA {2}0 importantes · 3 a corrigir · 2 menores/);
  assert.match(buildOut, /\[a corrigir\] Qualquer pessoa poderia alterar dados/);
});

test('a página do mapa marca que é uma planta, e a consulta sabe que não há código para ler', () => {
  const html = fs.readFileSync(mapPath(root, FILES.page), 'utf8');
  assert.ok(html.includes('/* ui/06-blueprint.js */'));
  assert.ok(html.includes('"blueprint":{"source":"docs/prd.md"'));
  const query = fs.readFileSync(mapPath(root, FILES.query), 'utf8');
  // as instruções da planta mandam ler o plano no lugar do código
  assert.ok(query.includes(`${MAP}/${FILES.plan}`), 'consulta.mjs aponta para mapa-do-codigo/plano.json');
  assert.equal(readJson(mapPath(root, '.cache', 'skill.json')).dir, SKILL);
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.local.md')));
});

test('um endpoint diz quais pessoas logadas podem usá-lo', () => {
  const r = graph.routes.find((x) => x.p === '/api/walker/schedule');
  assert.equal(r.access, 'signed-in');
  assert.equal(r.who, 'passeadores');
  assert.match(graph.routes.find((x) => x.p === '/api/auth/login').publicBecause, /precisam entrar antes de estarem logadas/);
});

test('um projeto que só tem o plano.json pode ser planejado antes de existir o arquitetura.json', () => {
  const r = makeProject({ 'PRD.md': '# Um plano' });
  try {
    fs.mkdirSync(mapPath(r));
    fs.copyFileSync(path.join(FIXTURE, MAP, FILES.plan), mapPath(r, FILES.plan));
    assert.match(run('status.mjs', r), /uma planta foi começada \(plano\.json\) mas nunca desenhada/);
    assert.match(run('plan.mjs', r), /rode build\.mjs quando mapa-do-codigo\/arquitetura\.json estiver escrito/);
  } finally { cleanup(r); }
});

test('o plan.mjs diz o que está errado num plano', () => {
  const r = withPlan((p) => {
    p.files[0].uses.push('web/components/WalkerCrad.tsx');
    p.endpoints[0].access = 'everyone';
    p.endpoints[1].file = 'api/src/routes/walker.ts';
    p.files[1].calls.push('POST /api/payments');
    p.files[2].calls.push('cancelar');
    p.endpoints[2].access = 'staff';
    p.files.find((f) => f.services).services = ['strpe'];
  });
  try {
    const out = fails(() => run('plan.mjs', r));
    assert.match(out, /^✗ \d+ erro\(s\) em mapa-do-codigo\/plano\.json:/m);
    assert.match(out, /files "web\/app\/page\.tsx"\.uses "web\/components\/WalkerCrad\.tsx" não é um dos arquivos planejados/);
    assert.match(out, /access "everyone" precisa ser um destes: public, signed-in, team, webhook, internal/);
    assert.match(out, /\.file "api\/src\/routes\/walker\.ts" não é um dos arquivos planejados/);
    assert.match(out, /calls "cancelar" precisa estar no formato "POST \/api\/pedidos"/);
    assert.match(out, /calls "POST \/api\/payments" não corresponde a nenhum endpoint planejado/);
    assert.match(out, /access "staff" precisa ser um destes: .* \("team" é a sua própria equipe; para só alguns usuários do app, use "signed-in" com "who"\)/);
    assert.match(out, /services "strpe" não é o id de nenhum nó em arquitetura\.json \(você quis dizer "stripe"\?\)/);
    assert.match(out, /Corrija os erros acima e rode plan\.mjs de novo\./);
  } finally { cleanup(r); }
});

test('o build.mjs pega um serviço que não é um nó', () => {
  const r = withPlan((p) => { p.files.find((f) => f.services).services = ['strpe']; });
  try {
    // o plan.mjs confere isso quando o arquitetura.json existe; sem ele, a montagem é a rede de segurança
    const arch = mapPath(r, FILES.arch), saved = fs.readFileSync(arch);
    fs.rmSync(arch);
    run('plan.mjs', r);
    fs.writeFileSync(arch, saved);
    const out = fails(() => run('build.mjs', r, '--no-claude-md'));
    assert.match(out, /erro\(s\) em mapa-do-codigo.arquitetura\.json ou plano\.json/);
    assert.match(out, /cita "strpe" em "services", mas isso não é o id de nenhum nó em arquitetura\.json — você quis dizer "stripe"\?/);
    assert.match(out, /Corrija os erros acima e rode build\.mjs de novo\./);
  } finally { cleanup(r); }
});

test('o refresh redesenha uma planta a partir do plano.json, e --from-code mapeia o código de verdade', () => {
  const r = withPlan(() => {});
  try {
    run('plan.mjs', r);
    run('build.mjs', r, '--no-claude-md');
    assert.match(run('status.mjs', r), /uma planta \(planejada, ainda não construída, a partir de docs\/prd\.md\)/);
    const plan = readJson(mapPath(r, FILES.plan));
    plan.endpoints.push({ method: 'GET', path: '/api/health', file: 'api/src/server.ts', name: 'Verificar se está no ar', access: 'public' });
    writeJson(mapPath(r, FILES.plan), plan);
    assert.match(run('refresh.mjs', r, '--no-claude-md'), /redesenhada a partir de mapa-do-codigo\/plano\.json/);
    assert.ok(routeKeys(readGraph(r)).includes('GET /api/health'));

    fs.mkdirSync(path.join(r, 'api', 'src'), { recursive: true });
    fs.writeFileSync(path.join(r, 'api', 'src', 'server.ts'), `import express from 'express';\nconst app = express();\napp.get('/api/health', (req, res) => res.send('ok'));\napp.listen(3000);\n`);
    // os fluxos da planta apontam para arquivos que ainda não foram escritos, então o mapa do código ganha os próprios
    writeJson(mapPath(r, FILES.arch), { project: { name: 'Pawprint', summary: 'Em construção.' }, nodes: [{ id: 'api', label: 'Servidor principal', kind: 'service', summary: 'O servidor.', paths: ['api/**'] }] });
    const out = run('refresh.mjs', r, '--from-code', '--no-claude-md');
    assert.match(out, /^Mapa do código: atualização — último mapa em /);
    const g = readGraph(r);
    assert.equal(g.meta.blueprint, undefined);
    assert.deepEqual(routeKeys(g), ['GET /api/health']);
    assert.ok(fs.existsSync(mapPath(r, FILES.plan)), 'o plano fica guardado');
  } finally { cleanup(r); }
});
