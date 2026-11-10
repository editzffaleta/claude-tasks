// O quadro grava qual agente escreveu (Claude ou Codex) a partir do clientInfo do MCP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentFromClient, agentName, agentNameSql } from '../src/agents.js';

const MCP = fileURLToPath(new URL('../src/mcp.js', import.meta.url));

let dir, repo;
const sessions = [];

// Uma sessão MCP de verdade (stdio), apresentando-se com o clientInfo dado.
async function session(clientInfo) {
  const child = spawn(process.execPath, ['--no-warnings', MCP], { env: { ...process.env, CLAUDE_TASKS_DB: join(dir, 't.db') } });
  sessions.push(child);
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  });
  const rpc = (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve) => pending.set(id, resolve));
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo });
  return async (name, args) => {
    const res = await rpc('tools/call', { name, arguments: args });
    assert.equal(!!res.result.isError, false, res.result.content[0].text);
    return res.result.content[0].text;
  };
}

const rows = (sql, ...args) => {
  const db = new DatabaseSync(join(dir, 't.db'), { readOnly: true });
  try { return db.prepare(sql).all(...args); } finally { db.close(); }
};

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-tasks-agentes-'));
  repo = join(dir, 'Loja');
  mkdirSync(join(repo, '.git'), { recursive: true });
});

after(() => {
  for (const child of sessions) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('agentFromClient: o Codex pelo nome ou pelo título; o resto conta como Claude', () => {
  assert.equal(agentFromClient({ name: 'codex-mcp-client', title: 'Codex', version: '0.144.5' }), 'codex');
  assert.equal(agentFromClient({ name: 'cliente', title: 'Codex' }), 'codex');
  assert.equal(agentFromClient({ name: 'claude-code', version: '2.1.0' }), 'claude');
  assert.equal(agentFromClient({ name: 'outro-cliente' }), 'claude');
  assert.equal(agentFromClient(undefined), 'claude');
  assert.equal(agentName('codex'), 'Codex');
  assert.equal(agentName('e-mail'), null);
  assert.equal(agentNameSql('e.author'), "CASE e.author WHEN 'claude' THEN 'Claude' WHEN 'codex' THEN 'Codex' ELSE e.author END");
});

test('cada sessão grava com o nome do seu agente', async () => {
  const codex = await session({ name: 'codex-mcp-client', title: 'Codex', version: '0.144.5' });
  const claude = await session({ name: 'claude-code', version: '2.1.0' });

  // Regra "só tarefas criadas por um agente": vale para os dois.
  await claude('manage_automations', {
    action: 'create', name: 'De agente', all_projects: true, trigger: 'task_created',
    conditions: { by_claude: true }, action_type: 'add_tag', action_value: 'de-agente',
  });

  await codex('add_tasks', { project_path: repo, tasks: [{ title: 'Tarefa do Codex' }] });
  await claude('add_tasks', { project_path: repo, tasks: [{ title: 'Tarefa do Claude' }] });
  await codex('complete_tasks', { ids: [1], note: 'Feito pelo Codex' });
  await codex('log_time', { id: 2, duration: '30m', note: 'Revisão' });
  await codex('send_notification', { message: 'Terminei' });

  assert.deepEqual(rows('SELECT title, source, tags FROM tasks ORDER BY id').map((r) => ({ ...r })), [
    { title: 'Tarefa do Codex', source: 'codex', tags: '["de-agente"]' },
    { title: 'Tarefa do Claude', source: 'claude', tags: '["de-agente"]' },
  ]);
  assert.deepEqual(rows("SELECT author FROM notes WHERE task_id = 1 AND kind = 'note'").map((r) => r.author), ['codex']);
  assert.deepEqual(rows('SELECT author FROM time_entries').map((r) => r.author), ['codex']);
  assert.match(rows('SELECT body FROM notifications ORDER BY id DESC LIMIT 1')[0].body, /^Codex: Terminei/);

  // O que o agente lê de volta também cita o nome certo.
  const task = JSON.parse(await claude('get_task', { id: 1, format: 'json' }));
  assert.ok(task.notes.some((n) => n.author === 'codex' && n.body === 'Feito pelo Codex'));
  assert.match(await claude('get_task', { id: 1 }), /Codex/);
  const activity = await claude('get_activity', { project_path: repo });
  assert.match(activity, /Codex criou #1 Tarefa do Codex/);
  assert.match(activity, /Claude criou #2 Tarefa do Claude/);
  assert.match(await claude('get_overview', {}), /2 criadas \(1 pelo Claude, 1 pelo Codex\)/);
  assert.match(await claude('time_report', { group_by: 'person' }), /Codex/);
});
