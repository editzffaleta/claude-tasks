// Permissões por projeto, links públicos, conversas nos comentários e tempo real, pela API
// de um painel de verdade (porta livre, banco temporário).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../src/server.js', import.meta.url));
let dir, child, base;
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
  if (cookie && !cookie.includes('Max-Age=0')) jar[as] = cookie.split(';')[0];
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text(), headers: res.headers };
}

const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data; };
let A, B, aTask, bTask, ana, carla, vera;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-tasks-perm-'));
  const port = await freePort();
  base = `http://localhost:${port}`;
  child = spawn(process.execPath, ['--no-warnings', SERVER], {
    env: { ...process.env, CLAUDE_TASKS_DB: join(dir, 't.db'), CLAUDE_TASKS_PORT: String(port), CLAUDE_TASKS_NO_OS_NOTIFY: '1' },
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${base}/api/auth/me`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  ok(await req('/api/auth/setup', { method: 'POST', body: { name: 'Admin', email: 'admin@ex.test', password: 'senha-admin-1' } }));
  for (const [key, name, role] of [['ana', 'Ana', 'member'], ['carla', 'Carla', 'member'], ['vera', 'Vera', 'viewer']]) {
    ok(await req('/api/users', { method: 'POST', body: { name, email: `${key}@ex.test`, password: `senha-${key}-1`, role } }));
    ok(await req('/api/auth/login', { method: 'POST', as: key, body: { email: `${key}@ex.test`, password: `senha-${key}-1` } }));
  }
  const users = ok(await req('/api/users'));
  [ana, carla, vera] = ['Ana', 'Carla', 'Vera'].map((n) => users.find((u) => u.name === n));
  A = ok(await req('/api/projects', { method: 'POST', body: { name: 'Aberto', visibility: 'internal' } }));
  B = ok(await req('/api/projects', { method: 'POST', body: { name: 'Secreto', visibility: 'private' } }));
  ok(await req('/api/labels', { method: 'POST', body: { project_id: B.id, name: 'confidencial', color: '#d64545' } }));
  aTask = ok(await req('/api/tasks', { method: 'POST', body: { project_id: A.id, title: 'Tarefa aberta' } }));
  bTask = ok(await req('/api/tasks', { method: 'POST', body: { project_id: B.id, title: 'Plano secreto' } }));
});

after(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('projeto privado some para quem não é membro (inclusive labels)', async () => {
  const state = ok(await req('/api/state', { as: 'ana' }));
  assert.deepEqual(state.projects.map((p) => p.name), ['Aberto']);
  assert.ok(!state.tasks.some((t) => t.id === bTask.id));
  assert.ok(!state.labels.some((l) => l.name === 'confidencial'));
  assert.equal((await req(`/api/tasks/${bTask.id}`, { as: 'ana' })).status, 403);
  assert.equal(ok(await req('/api/search?q=secreto', { as: 'ana' })).tasks.length, 0);
});

test('referências cruzadas não furam o projeto privado', async () => {
  const as = 'ana';
  assert.equal((await req('/api/tasks', { method: 'POST', as, body: { project_id: A.id, parent_id: bTask.id, title: 'Sub infiltrada' } })).status, 403);
  assert.equal((await req(`/api/tasks/${aTask.id}`, { method: 'PATCH', as, body: { project_id: B.id } })).status, 403);
  assert.equal((await req('/api/tasks/bulk', { method: 'POST', as, body: { ids: [aTask.id], patch: { project_id: B.id } } })).status, 403);
  assert.equal((await req(`/api/tasks/${aTask.id}/blockers`, { method: 'POST', as, body: { blocked_by: bTask.id } })).status, 403);
  assert.equal((await req(`/api/tasks/${aTask.id}`, { method: 'PATCH', as, body: { blocked_by: [bTask.id] } })).status, 403);
  assert.equal(ok(await req(`/api/tasks/${aTask.id}`, { as })).blockers.length, 0);
});

test('projeto inexistente é 404 até para administradores', async () => {
  assert.equal((await req('/api/export.csv?project=999')).status, 404);
  assert.equal((await req('/api/projects/999/shares', { method: 'POST', body: {} })).status, 404);
  assert.equal((await req('/api/workflows/from-project/999', { method: 'POST', body: {} })).status, 404);
  assert.equal((await req('/api/organizations/999/members')).status, 404);
});

test('gerente não mexe no dono; dono sim', async () => {
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', body: { user: carla.id, role: 'owner' } }));
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', body: { user: ana.id, role: 'manager' } }));
  assert.equal((await req(`/api/projects/${A.id}/members`, { method: 'POST', as: 'ana', body: { user: carla.id, role: 'member' } })).status, 403);
  assert.equal((await req(`/api/projects/${A.id}/members`, { method: 'POST', as: 'ana', body: { user: carla.id, role: null } })).status, 403);
  assert.equal((await req(`/api/projects/${A.id}/members`, { method: 'POST', as: 'ana', body: { user: vera.id, role: 'owner' } })).status, 403);
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', as: 'ana', body: { user: vera.id, role: 'viewer' } }));
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', as: 'carla', body: { user: vera.id, role: 'member' } }));
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', as: 'carla', body: { user: vera.id, role: null } }));
});

test('gerente cria automação no próprio projeto, mas não a move para outro', async () => {
  const rule = ok(await req('/api/automations', {
    method: 'POST', as: 'ana', body: { name: 'Bug alta', project_id: A.id, trigger: 'task_created', conditions: { type: ['bug'] }, action: { type: 'set_priority', value: 'high' } },
  }));
  assert.equal((await req(`/api/automations/${rule.id}`, { method: 'PATCH', as: 'ana', body: { project_id: B.id } })).status, 403);
  assert.equal((await req(`/api/automations/${rule.id}`, { method: 'PATCH', as: 'ana', body: { project_id: null } })).status, 403);
  assert.equal((await req('/api/automations', { method: 'POST', as: 'carla', body: { name: 'Global', trigger: 'task_created', action: { type: 'notify', value: 'x' } } })).status, 403);
});

test('visualizador só lê: não cria, não comenta, não usa o chat', async () => {
  assert.equal((await req('/api/tasks', { method: 'POST', as: 'vera', body: { project_id: A.id, title: 'Não pode' } })).status, 403);
  assert.equal((await req(`/api/tasks/${aTask.id}/notes`, { method: 'POST', as: 'vera', body: { body: 'oi' } })).status, 403);
  assert.equal((await req('/api/chat', { method: 'POST', as: 'vera', body: { message: 'oi' } })).status, 403);
  assert.equal((await req('/api/projects', { method: 'POST', as: 'vera', body: { name: 'X' } })).status, 403);
  assert.equal(ok(await req(`/api/tasks/${aTask.id}`, { as: 'vera' })).my_role, 'viewer');
});

test('comentários em conversa: resposta, menção, edição só do autor', async () => {
  const root = ok(await req(`/api/tasks/${aTask.id}/notes`, { method: 'POST', as: 'carla', body: { body: 'Alguém revisa? @Ana' } })).id;
  ok(await req(`/api/tasks/${aTask.id}/notes`, { method: 'POST', as: 'ana', body: { body: 'Eu reviso', parent_id: root } }));
  const notes = ok(await req(`/api/tasks/${aTask.id}`)).notes.filter((n) => n.kind === 'note');
  assert.equal(notes.find((n) => n.body === 'Eu reviso').parent_id, root);
  const mention = ok(await req('/api/notifications', { as: 'ana' })).items.find((n) => n.type === 'mention');
  assert.ok(mention, 'Ana recebeu a menção');
  const reply = notes.find((n) => n.body === 'Eu reviso');
  // Ana é gerente de A: pode editar comentário alheio. Carla (dona) também. Um membro comum não.
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', body: { user: ana.id, role: 'member' } }));
  assert.equal((await req(`/api/notes/${root}`, { method: 'PATCH', as: 'ana', body: { body: 'editado por outra' } })).status, 403);
  const edited = ok(await req(`/api/notes/${reply.id}`, { method: 'PATCH', as: 'ana', body: { body: 'Eu reviso amanhã' } }));
  assert.ok(edited.edited_at);
  ok(await req(`/api/notes/${reply.id}`, { method: 'DELETE', as: 'carla' }));
});

test('link público: só leitura, some quando o projeto deixa de ser público', async () => {
  assert.equal((await req(`/api/projects/${A.id}/shares`, { method: 'POST', body: {} })).status, 400);
  ok(await req(`/api/projects/${A.id}`, { method: 'PATCH', body: { visibility: 'public' } }));
  const share = ok(await req(`/api/projects/${A.id}/shares`, { method: 'POST', body: { days: 7 } }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex');
  const att = ok(await req(`/api/tasks/${aTask.id}/attachments`, { method: 'POST', body: png, headers: { 'content-type': 'image/png', 'x-filename': 'a.png' } }));
  const pub = ok(await req(`/api/public/${share.token}`, { as: 'anon' }));
  assert.equal(pub.kind, 'project');
  assert.ok(pub.tasks.some((t) => t.title === 'Tarefa aberta'));
  assert.ok(!JSON.stringify(pub).includes('@ex.test'), 'sem e-mails no link público');
  assert.equal((await req(`/api/public/${share.token}/attachments/${att.id}`, { as: 'anon' })).status, 200);
  assert.equal((await req(`/s/${share.token}`, { as: 'anon' })).status, 200);
  ok(await req(`/api/projects/${A.id}`, { method: 'PATCH', body: { visibility: 'internal' } }));
  assert.equal((await req(`/api/public/${share.token}`, { as: 'anon' })).status, 404);
  assert.equal((await req(`/api/public/${share.token}/attachments/${att.id}`, { as: 'anon' })).status, 404);
});

test('organização e workspaces aninhados dão acesso aos projetos de dentro', async () => {
  const org = ok(await req('/api/organizations', { method: 'POST', body: { name: 'Cliente X' } }));
  const ws = ok(await req('/api/workspaces', { method: 'POST', body: { organization_id: org.id, name: 'Produto' } }));
  const sub = ok(await req('/api/workspaces', { method: 'POST', body: { organization_id: org.id, parent_id: ws.id, name: 'Mobile' } }));
  const P = ok(await req('/api/projects', { method: 'POST', body: { name: 'App', visibility: 'private', workspace_id: sub.id } }));
  assert.equal((await req(`/api/projects/${P.id}/columns`, { as: 'ana' })).status, 403);
  ok(await req(`/api/workspaces/${ws.id}/members`, { method: 'POST', body: { user: ana.id, role: 'manager' } }));
  assert.equal(ok(await req('/api/state', { as: 'ana' })).projects.find((p) => p.id === P.id)?.my_role, 'manager');
  // Gerente da organização não dá papel de dono.
  ok(await req(`/api/organizations/${org.id}/members`, { method: 'POST', body: { user: carla.id, role: 'manager' } }));
  assert.equal((await req(`/api/workspaces/${ws.id}/members`, { method: 'POST', as: 'carla', body: { user: vera.id, role: 'owner' } })).status, 403);
  ok(await req(`/api/workspaces/${ws.id}/members`, { method: 'POST', as: 'carla', body: { user: vera.id, role: 'viewer' } }));
});

test('tempo real: /api/events manda hello e avisa mudanças', async () => {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { cookie: jar.ana }, signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const until = async (re) => {
    const deadline = Date.now() + 5000;
    while (!re.test(text) && Date.now() < deadline) text += decoder.decode((await reader.read()).value || new Uint8Array(), { stream: true });
    return re.test(text);
  };
  assert.ok(await until(/event: hello\ndata: .*"panel":"[0-9a-f]{12}"/));
  assert.match(ok(await req('/api/version')).panel, /^[0-9a-f]{12}$/);
  ok(await req('/api/tasks', { method: 'POST', body: { project_id: A.id, title: 'Nova ao vivo' } }));
  assert.ok(await until(/event: change/));
  controller.abort();
  assert.equal((await fetch(`${base}/api/events`)).status, 401);
});

test('esqueci a senha responde igual exista ou não a conta; link do admin troca a senha', async () => {
  const a = await req('/api/auth/forgot', { method: 'POST', as: 'anon', body: { email: 'ana@ex.test' } });
  const b = await req('/api/auth/forgot', { method: 'POST', as: 'anon', body: { email: 'ninguem@ex.test' } });
  assert.deepEqual(a.data, b.data);
  const { link } = ok(await req(`/api/users/${vera.id}/reset-link`, { method: 'POST', body: {} }));
  const token = new URL(link).searchParams.get('reset');
  assert.equal(ok(await req(`/api/auth/reset/${token}`, { as: 'anon' })).email, 'vera@ex.test');
  ok(await req(`/api/auth/reset/${token}`, { method: 'POST', as: 'vera2', body: { password: 'senha-nova-da-vera' } }));
  assert.equal((await req(`/api/auth/reset/${token}`, { method: 'POST', as: 'x', body: { password: 'outra-senha-1' } })).status, 400);
  ok(await req('/api/auth/login', { method: 'POST', as: 'vera3', body: { email: 'vera@ex.test', password: 'senha-nova-da-vera' } }));
});

test('conta de visualizador continua só lendo mesmo com papel maior no projeto', async () => {
  ok(await req(`/api/projects/${A.id}/members`, { method: 'POST', body: { user: vera.id, role: 'manager' } }));
  assert.equal(ok(await req(`/api/tasks/${aTask.id}`, { as: 'vera3' })).my_role, 'viewer');
  assert.equal((await req('/api/tasks', { method: 'POST', as: 'vera3', body: { project_id: A.id, title: 'Não pode' } })).status, 403);
});

test('menção a quem não vê o projeto privado não gera aviso; link público de tarefa privada só com gerente', async () => {
  ok(await req(`/api/projects/${B.id}/members`, { method: 'POST', body: { user: ana.id, role: 'member' } }));
  const before = ok(await req('/api/notifications', { as: 'carla' })).items.length;
  ok(await req(`/api/tasks/${bTask.id}/notes`, { method: 'POST', as: 'ana', body: { body: 'Olha isso @Carla' } }));
  assert.equal(ok(await req('/api/notifications', { as: 'carla' })).items.length, before);
  assert.equal((await req(`/api/tasks/${bTask.id}/shares`, { method: 'POST', as: 'ana', body: {} })).status, 403);
  ok(await req(`/api/tasks/${bTask.id}/shares`, { method: 'POST', body: {} }));
});

