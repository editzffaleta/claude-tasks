// Conversa com o servidor MCP de verdade (stdio) usando um banco temporário.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const MCP = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const HOOK = fileURLToPath(new URL('../bin/session-start.js', import.meta.url));

let dir, repo, child, nextId = 1;
const pending = new Map();

function rpc(method, params = {}) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

const call = async (name, args) => {
  const res = await rpc('tools/call', { name, arguments: args });
  return { text: res.result.content[0].text, isError: !!res.result.isError };
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-tasks-'));
  repo = join(dir, 'MeuApp');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
  // worktree: .git em arquivo apontando para o repositório principal
  mkdirSync(join(dir, 'wt'), { recursive: true });
  writeFileSync(join(dir, 'wt', '.git'), `gitdir: ${join(repo, '.git', 'worktrees', 'wt')}\n`);

  child = spawn(process.execPath, ['--no-warnings', MCP], { env: { ...process.env, CLAUDE_TASKS_DB: join(dir, 't.db') } });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
});

after(() => {
  child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('initialize e tools/list', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.match(init.result.instructions, /project_path/);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const list = await rpc('tools/list');
  assert.deepEqual(list.result.tools.map((t) => t.name).sort(), [
    'add_tasks', 'attach_file', 'complete_tasks', 'get_task', 'list_members', 'list_projects', 'list_tasks',
    'log_time', 'manage_sprints', 'update_task',
  ]);
});

test('add_tasks resolve o projeto pela raiz git e não duplica', async () => {
  const r = await call('add_tasks', {
    project_path: join(repo, 'src', 'deep'),
    tasks: [{ title: 'Corrigir login', priority: 'high', tags: ['bug'] }, { title: 'Escrever README' }],
  });
  assert.match(r.text, /Projeto: MeuApp/);
  assert.match(r.text, /criada: #1 \[a fazer\] \[alta\] Corrigir login \(bug\)/);

  const dup = await call('add_tasks', { project_path: join(dir, 'wt'), tasks: [{ title: 'corrigir LOGIN' }] });
  assert.match(dup.text, /Projeto: MeuApp/);
  assert.match(dup.text, /já existia: #1/);
});

test('update, complete, get e list', async () => {
  await call('update_task', { id: 2, status: 'doing', note: 'Comecei pela seção de instalação' });
  const done = await call('complete_tasks', { ids: [1], note: 'Corrigido no auth.ts' });
  assert.match(done.text, /concluída: #1 \[concluída\]/);

  const open = await call('list_tasks', { project: 'meuapp' });
  assert.match(open.text, /#2 \[em andamento\]/);
  assert.doesNotMatch(open.text, /#1 /);

  const detail = await call('get_task', { id: 1 });
  assert.match(detail.text, /a fazer → concluída/);
  assert.match(detail.text, /Corrigido no auth\.ts/);

  const projects = await call('list_projects', {});
  assert.match(projects.text, /MeuApp: 1 abertas \(1 em andamento, 0 bloqueadas\), 1 concluídas/);
});

test('subtarefas, dependências, sprints, prazos, recorrência, tempo e anexos', async () => {
  const sprint = await call('manage_sprints', { project: 'MeuApp', action: 'create', name: 'S1', goal: 'Lançar' });
  assert.match(sprint.text, /Criada: #1 S1 \[planejamento\]/);
  await call('manage_sprints', { project: 'MeuApp', action: 'start', id: 1 });

  const r = await call('add_tasks', {
    project: 'MeuApp',
    tasks: [
      { title: 'Épico de pagamentos', type: 'epic', due_date: '2020-01-01', estimate: '1d', sprint: 'active' },
      { title: 'Pré-requisito' },
    ],
  });
  assert.match(r.text, /#3 \[épico\] \[a fazer\] \[média\] Épico de pagamentos · prazo 2020-01-01 \(atrasada\) · sprint S1/);

  await call('add_tasks', { project: 'MeuApp', tasks: [{ title: 'Etapa 1', parent_id: 3 }] });
  await call('update_task', { id: 3, blocked_by: [4] });
  const cycle = await call('update_task', { id: 4, blocked_by: [3] });
  assert.equal(cycle.isError, true);
  assert.match(cycle.text, /ciclo/);

  await call('log_time', { id: 3, duration: '1h30m', note: 'investigação' });
  const file = join(dir, 'print.txt');
  writeFileSync(file, 'conteúdo');
  assert.match((await call('attach_file', { id: 3, path: file })).text, /Anexado em #3: print\.txt/);

  const detail = (await call('get_task', { id: 3 })).text;
  assert.match(detail, /subtarefas 0\/1 · bloqueada por 1/);
  assert.match(detail, /tempo 1h30m de 8h/);
  assert.match(detail, /Subtarefas:\n- #5 .*Etapa 1/);
  assert.match(detail, /Bloqueada por:\n- #4/);
  assert.match(detail, /Anexos:\n- print\.txt/);

  const overdue = await call('list_tasks', { due: 'overdue' });
  assert.match(overdue.text, /#3 /);

  const rec = await call('add_tasks', { project: 'MeuApp', tasks: [{ title: 'Backup semanal', recurrence: { freq: 'weekly' }, due_date: '2020-01-06' }] });
  const recId = Number(rec.text.match(/criada: #(\d+)/)[1]);
  const done = await call('complete_tasks', { ids: [recId] });
  assert.match(done.text, /próxima ocorrência #\d+/);

  const closed = await call('manage_sprints', { project: 'MeuApp', action: 'complete', id: 1 });
  assert.match(closed.text, /1 tarefa\(s\) pendente\(s\) movida\(s\) para o backlog/);
});

test('erros voltam como isError', async () => {
  const r = await call('update_task', { id: 999, status: 'done' });
  assert.equal(r.isError, true);
  assert.match(r.text, /#999 não encontrada/);
  const bad = await call('add_tasks', { project: 'X', tasks: [{ title: 'a', priority: 'altíssima' }] });
  assert.equal(bad.isError, true);
});

test('hook de início de sessão lista as pendências do projeto', async () => {
  const run = (cwd) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--no-warnings', HOOK], { env: { ...process.env, CLAUDE_TASKS_DB: join(dir, 't.db') } });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', () => resolve(out));
    p.stdin.end(JSON.stringify({ cwd, hook_event_name: 'SessionStart' }));
  });
  const ctx = JSON.parse(await run(join(repo, 'src'))).hookSpecificOutput.additionalContext;
  assert.match(ctx, /Tarefas abertas de "MeuApp"/);
  assert.match(ctx, /#2 \[em andamento\]/);
  assert.equal(await run(dir), '');
});
