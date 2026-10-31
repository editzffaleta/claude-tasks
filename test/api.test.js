// Sobe o painel de verdade numa porta livre, com banco temporário, e usa a API como o navegador.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
let dir, child, base, port;
const jar = {};

const freePort = () => new Promise((resolve) => {
  const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function req(path, { method = 'GET', body, as = 'admin', headers = {} } = {}) {
  const raw = body instanceof Buffer;
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body && !raw ? { 'content-type': 'application/json' } : {}),
      ...(jar[as] ? { cookie: jar[as] } : {}),
      origin: base,
      ...headers,
    },
    body: raw ? body : body ? JSON.stringify(body) : undefined,
  });
  const cookie = res.headers.get('set-cookie');
  if (cookie) jar[as] = cookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-tasks-api-'));
  port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: { ...process.env, CLAUDE_TASKS_DB: join(dir, 't.db'), CLAUDE_TASKS_PORT: String(port), CLAUDE_TASKS_NO_OS_NOTIFY: '1' },
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/auth/me`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
});

after(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('exige criar o administrador e depois login', async () => {
  assert.equal((await req('/api/auth/me', { as: 'anon' })).data.setup, true);
  assert.equal((await req('/api/state', { as: 'anon' })).status, 401);
  const setup = await req('/api/auth/setup', { method: 'POST', body: { name: 'Bruno', email: 'bruno@ex.com', password: 'senha-forte' } });
  assert.equal(setup.data.user.role, 'admin');
  assert.equal((await req('/api/auth/setup', { method: 'POST', as: 'x', body: { name: 'X', email: 'x@ex.com', password: 'senha-forte' } })).status, 409);
  assert.equal((await req('/api/auth/login', { method: 'POST', as: 'bad', body: { email: 'bruno@ex.com', password: 'errada' } })).status, 400);
  assert.equal((await req('/api/state')).status, 200);
});

test('bloqueia outras origens e hosts', async () => {
  assert.equal((await req('/api/projects', { method: 'POST', body: { name: 'X' }, headers: { origin: 'https://evil.example' } })).status, 403);
  const status = await new Promise((resolve) => {
    request({ host: '127.0.0.1', port, path: '/api/version', headers: { host: 'evil.example' } }, (res) => resolve(res.statusCode)).end();
  });
  assert.equal(status, 403);
});

test('quadro completo: projeto, colunas, sprint, tarefa, tempo, anexo, comentário', async () => {
  const project = (await req('/api/projects', { method: 'POST', body: { name: 'Site', color: '#d97757' } })).data;
  const col = (await req(`/api/projects/${project.id}/columns`, { method: 'POST', body: { name: 'Revisão', status: 'doing' } })).data;
  const sprint = (await req(`/api/projects/${project.id}/sprints`, { method: 'POST', body: { name: 'S1' } })).data;
  await req(`/api/sprints/${sprint.id}/start`, { method: 'POST', body: {} });

  const task = (await req('/api/tasks', { method: 'POST', body: { project_id: project.id, title: 'Home nova', due_date: '2030-01-10', sprint: sprint.id } })).data;
  const moved = (await req(`/api/tasks/${task.id}`, { method: 'PATCH', body: { column: col.id, estimate: '3h' } })).data;
  assert.equal(moved.status, 'doing');
  assert.equal(moved.column_id, col.id);
  assert.equal(moved.estimate_minutes, 180);

  await req(`/api/tasks/${task.id}/time`, { method: 'POST', body: { duration: '45m' } });
  await req(`/api/tasks/${task.id}/timer`, { method: 'POST', body: { action: 'start' } });
  const state = (await req(`/api/state?project=${project.id}`)).data;
  assert.equal(state.timers.length, 1);
  assert.equal(state.columns.length, 5);
  assert.equal(state.sprints[0].status, 'active');

  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const att = (await req(`/api/tasks/${task.id}/attachments`, { method: 'POST', body: png, headers: { 'content-type': 'image/png', 'x-filename': encodeURIComponent('tela inicial.png') } })).data;
  assert.equal(att.name, 'tela inicial.png');
  const file = await req(`/api/attachments/${att.id}`);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.match(file.headers.get('content-disposition'), /^inline/);

  await req(`/api/tasks/${task.id}/notes`, { method: 'POST', body: { body: 'Revisar com o time' } });
  const full = (await req(`/api/tasks/${task.id}`)).data;
  assert.equal(full.spent_minutes, 45);
  assert.equal(full.timer_running, true);
  assert.equal(full.attachments.length, 1);
  assert.ok(full.notes.some((n) => n.body === 'Revisar com o time' && n.user_name === 'Bruno'));

  const stats = (await req(`/api/stats?project=${project.id}`)).data;
  assert.equal(stats.totals.open, 1);
  assert.equal(stats.sprint.name, 'S1');
});

test('convite cria membro; membro não administra', async () => {
  const invite = (await req('/api/invites', { method: 'POST', body: { role: 'member' } })).data;
  assert.ok(invite.token);
  assert.equal((await req(`/api/invites/${invite.token}`, { as: 'ana' })).status, 200);
  const joined = await req(`/api/invites/${invite.token}/accept`, { method: 'POST', as: 'ana', body: { name: 'Ana', email: 'ana@ex.com', password: 'senha-da-ana' } });
  assert.equal(joined.data.user.role, 'member');
  assert.equal((await req(`/api/invites/${invite.token}/accept`, { method: 'POST', as: 'z', body: { name: 'Z', email: 'z@ex.com', password: 'senha-do-z' } })).status, 400);
  assert.equal((await req('/api/automations', { method: 'POST', as: 'ana', body: {} })).status, 403);

  const users = (await req('/api/users')).data;
  const ana = users.find((u) => u.name === 'Ana');
  const project = (await req('/api/projects', { method: 'POST', body: { name: 'Interno' } })).data;
  await req('/api/tasks', { method: 'POST', body: { project_id: project.id, title: 'Para a Ana', assignees: [ana.id] } });
  const notes = (await req('/api/notifications', { as: 'ana' })).data;
  assert.equal(notes.unread, 1);
  assert.match(notes.items[0].body, /Bruno atribuiu #\d+ a você: Para a Ana/);
});

test('automação por gatilho roda nas mudanças', async () => {
  const project = (await req('/api/projects', { method: 'POST', body: { name: 'Auto' } })).data;
  const rule = await req('/api/automations', {
    method: 'POST',
    body: { name: 'Bug vira alta', trigger: 'task_created', conditions: { type: ['bug'] }, action: { type: 'set_priority', value: 'high' }, project_id: project.id },
  });
  assert.equal(rule.status, 200);
  const task = (await req('/api/tasks', { method: 'POST', body: { project_id: project.id, title: 'Erro no login', type: 'bug' } })).data;
  const after = (await req(`/api/tasks/${task.id}`)).data;
  assert.equal(after.priority, 'high');
  assert.ok(after.notes.some((n) => n.body === 'automação “Bug vira alta”'));
});
