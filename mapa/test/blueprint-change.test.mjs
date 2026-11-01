// Alterar uma planta pelo mapa: o modo Alterar da barra de perguntas manda um pedido ao agente (aqui, um de
// mentira, fixtures/fake-cli), que responde com o plano inteiro atualizado. O servidor.mjs confere com o plan.mjs
// e o build.mjs, salva, redesenha o mapa com as mudanças em destaque e consegue desfazer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { REPO, FIXTURES, MAP, FILES, mapPath, makeProject, shopApp, run, readGraph, readJson, writeJson, routeKeys, cleanup } from './helpers.mjs';

const FIXTURE = path.join(FIXTURES, 'blueprint');
const FAKE = path.join(REPO, 'test', 'fixtures', 'fake-cli', 'fake-claude.mjs');
const fixture = (f) => path.join(FIXTURE, MAP, f);
const servers = [], roots = [];
after(async () => {
  await Promise.all(servers.filter((s) => s.exitCode === null).map((s) => new Promise((resolve) => { s.once('exit', resolve); s.kill(); })));
  for (const r of roots) cleanup(r);
});

/** A planta de exemplo, desenhada, com o servidor do mapa respondendo pelas `replies` do agente de mentira. */
async function served(replies, root) {
  if (!root) {
    root = makeProject({});
    fs.cpSync(FIXTURE, root, { recursive: true });
    run('plan.mjs', root);
    run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  }
  roots.push(root);
  const changes = path.join(root, 'respostas.json');
  writeJson(changes, replies);
  const log = path.join(root, 'fake.log');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [mapPath(root, FILES.server), '--port', String(port), '--no-open'], {
    cwd: root, env: { ...process.env, FLOORPLAN_ENGINE: '', FLOORPLAN_CLAUDE: FAKE, FAKE_LOG: log, FAKE_CHANGES: changes }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(server);
  const base = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`o servidor não iniciou: ${out}`)), 20000);
    server.stdout.on('data', (d) => { out += d; const m = /Mapa do código: (http:\/\/\S+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } });
    server.on('exit', (code) => reject(new Error(`o servidor saiu (${code}): ${out}`)));
  });
  const page = JSON.parse(/window\.FLOORPLAN_SERVER=(\{.*?\});/.exec(await (await fetch(base + '/')).text())[1]);
  const token = page.token;
  // o agente de mentira é o Claude Code, que segue um schema nas respostas, então o mapa oferece Alterar
  assert.equal(page.change, true);
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', 'x-floorplan-token': token }, body: JSON.stringify(body || {}) });
  return {
    root,
    async change(question) {
      const text = await (await post('/api/ask', { question, mode: 'change' })).text();
      return text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (\w+)/.exec(b)[1], data: JSON.parse(/^data: (.*)$/m.exec(b)[1]) }));
    },
    undo: async () => (await post('/api/plan/undo')).json(),
    calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
  };
}
const pick = (events, name) => events.filter((e) => e.event === name).map((e) => e.data);

/** O plano de exemplo com reembolsos: um arquivo novo de endpoints, o endpoint e a página "Meus passeios" chamando-o. */
function withRefunds(change = (p) => p) {
  const plan = readJson(fixture(FILES.plan));
  plan.files.push({ path: 'api/src/routes/refunds.ts', name: 'Endpoints de reembolso', description: 'Devolve ao cartão do dono o valor de um passeio cancelado.', uses: ['api/src/services/payments.ts', 'api/src/db/bookings.ts'] });
  plan.files.find((f) => f.path === 'web/app/bookings/page.tsx').calls.push('POST /api/refunds');
  plan.endpoints.push({ method: 'POST', path: '/api/refunds', file: 'api/src/routes/refunds.ts', name: 'Reembolsar um passeio', description: 'Devolve o dinheiro de um passeio cancelado.', access: 'signed-in', who: 'o dono que reservou' });
  change(plan);
  return {
    title: 'Reembolsos planejados',
    summary: 'Acrescentei um endpoint de **reembolso** que a página Meus passeios chama quando um passeio é cancelado.',
    plan: JSON.stringify(plan),
    architecture: fs.readFileSync(fixture(FILES.arch), 'utf8'),
    changes: [
      { ref: 'api/src/routes/refunds.ts', change: 'new', note: 'Onde os reembolsos são tratados.' },
      { ref: 'POST /api/refunds', change: 'new', note: 'O pedido que reembolsa um passeio.' },
      { ref: 'web/app/bookings/page.tsx', change: 'changed', note: 'Agora pede um reembolso quando um passeio é cancelado.' },
    ],
    followups: ['Mandar um email ao dono quando o reembolso sair'],
  };
}

test('uma alteração é conferida, salva e desenhada, com o que mudou em destaque', async () => {
  const s = await served([withRefunds()]);
  const events = await s.change('planeje também os reembolsos');
  assert.deepEqual(pick(events, 'failure'), []);
  assert.deepEqual(pick(events, 'progress').map((p) => p.text), [`Lendo ${MAP}/${FILES.plan}`, 'Conferindo o plano atualizado']);
  const [answer] = pick(events, 'answer');
  assert.equal(answer.title, 'Reembolsos planejados');
  assert.equal(answer.changes, 3);
  assert.deepEqual(answer.followups, ['Mandar um email ao dono quando o reembolso sair']);
  assert.match(answer.undo, /^[0-9a-z]+$/);

  const g = readGraph(s.root);
  assert.ok(routeKeys(g).includes('POST /api/refunds'));
  assert.ok(g.links.some((l) => l.a === 'f:web/app/bookings/page.tsx' && l.b === 'f:api/src/routes/refunds.ts' && l.labels.includes('POST /api/refunds')));
  assert.equal(g.recent.tasks[0].title, 'Reembolsos planejados');
  assert.equal(g.recent.tasks[0].request, 'planeje também os reembolsos');
  assert.deepEqual(g.recent.items.map((x) => `${x.change} ${x.id}`).sort(), ['changed f:web/app/bookings/page.tsx', 'new f:api/src/routes/refunds.ts', `new r:${g.routes.findIndex((r) => r.p === '/api/refunds')}`].sort());
  assert.equal(readJson(mapPath(s.root, FILES.plan)).endpoints.at(-1).who, 'o dono que reservou');
  assert.equal(readJson(mapPath(s.root, FILES.recent)).tasks[0].summary, 'Acrescentei um endpoint de reembolso que a página Meus passeios chama quando um passeio é cancelado.');

  // o agente só leu: nenhuma ferramenta de edição, e recebeu o schema de alteração
  const [call] = s.calls();
  assert.ok(!call.args.join(' ').match(/\b(Edit|Write)\b/), 'o agente não recebe ferramentas de edição');
  assert.match(call.args[call.args.indexOf('--json-schema') + 1], /"architecture"/);
  assert.match(call.args[call.args.indexOf('--append-system-prompt') + 1], /português do Brasil/);
  assert.equal(call.input, 'planeje também os reembolsos');

  // desfazer devolve o plano e o mapa
  assert.deepEqual(await s.undo(), { ok: true, left: 0 });
  assert.ok(!routeKeys(readGraph(s.root)).includes('POST /api/refunds'));
  assert.deepEqual(await s.undo(), { ok: false, error: 'Nada para desfazer.' });
});

test('um plano que não passa nas verificações volta para o agente uma vez, com os problemas', async () => {
  const broken = withRefunds((p) => { p.endpoints.at(-1).file = 'api/src/routes/refund.ts'; });
  const s = await served([broken, withRefunds()]);
  const events = await s.change('planeje também os reembolsos');
  assert.ok(pick(events, 'progress').some((p) => p.text === 'Corrigindo um problema que as verificações encontraram'));
  assert.equal(pick(events, 'answer')[0].title, 'Reembolsos planejados');
  const [, retry] = s.calls();
  assert.match(retry.input, /Seu plano atualizado não passou nas verificações, então nada foi salvo/);
  assert.match(retry.input, /"api\/src\/routes\/refund\.ts"/);
  assert.match(retry.input, /O pedido era: planeje também os reembolsos$/);
  assert.equal(retry.args[retry.args.indexOf('--resume') + 1], 'test-session');
});

test('arquivos novos fora de todas as partes voltam uma vez, para o agente acrescentar um glob', async () => {
  const stray = withRefunds((p) => { p.files.push({ path: 'admin/app/page.tsx', name: 'Início da administração', description: 'A nossa própria página de administração.' }); });
  const arch = readJson(fixture(FILES.arch));
  const fixed = { ...stray, architecture: JSON.stringify({ ...arch, nodes: [...arch.nodes, { id: 'admin', label: 'Administração', kind: 'ui', summary: 'A nossa própria página de administração.', paths: ['admin/**'] }] }) };
  const s = await served([stray, fixed]);
  const events = await s.change('acrescente uma página de administração');
  assert.match(s.calls()[1].input, /1 arquivo\(s\) planejado\(s\) não cabem nos paths de nenhum nó/);
  assert.equal(pick(events, 'answer').length, 1);
  assert.equal(readGraph(s.root).files.filter((f) => f.n === 'unassigned').length, 0);
});

test('quando a segunda tentativa também falha, nada muda', async () => {
  const broken = withRefunds((p) => { p.endpoints.at(-1).access = 'owners'; });
  const s = await served([broken]);
  const before = fs.readFileSync(mapPath(s.root, FILES.plan), 'utf8');
  const events = await s.change('planeje também os reembolsos');
  const [failure] = pick(events, 'failure');
  assert.equal(failure.code, 'change_invalid');
  assert.match(failure.message, /^O plano atualizado não passou nas verificações, então nada mudou:\n- /);
  assert.match(failure.message, /"owners"/);
  assert.equal(fs.readFileSync(mapPath(s.root, FILES.plan), 'utf8'), before);
  assert.ok(!routeKeys(readGraph(s.root)).includes('POST /api/refunds'));
  assert.equal(s.calls().length, 2);
});

test('um mapa de código de verdade não pode ser alterado assim', async () => {
  const root = shopApp();
  run('scan.mjs', root);
  run('build.mjs', root, '--no-claude-md', '--agent', 'claude');
  const s = await served([withRefunds()], root);
  const [failure] = pick(await s.change('acrescente reembolsos'), 'failure');
  assert.match(failure.message, /Só uma planta pode ser alterada pelo mapa/);
});
