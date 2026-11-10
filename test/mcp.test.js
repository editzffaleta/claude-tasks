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
    'add_comment', 'add_tasks', 'attach_file', 'code_map', 'complete_tasks', 'delete_tasks', 'export_tasks', 'get_activity',
    'get_attachment', 'get_overview', 'get_task', 'import_tasks', 'list_members', 'list_notifications', 'list_projects',
    'list_tasks', 'log_time', 'manage_automations', 'manage_columns', 'manage_comment', 'manage_fields', 'manage_inbox',
    'manage_labels', 'manage_members', 'manage_project', 'manage_settings', 'manage_sprints', 'manage_workspaces',
    'search', 'send_notification', 'share_link', 'show_in_dashboard', 'time_report', 'timer', 'update_task', 'update_tasks',
  ]);
  for (const t of list.result.tools) {
    assert.ok(t.title && t.description && t.inputSchema?.type === 'object', `${t.name} completo`);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', `${t.name} anotado`);
  }
  assert.equal(list.result.tools.find((t) => t.name === 'delete_tasks').annotations.destructiveHint, true);
  assert.deepEqual(Object.keys(init.result.capabilities).sort(), ['completions', 'prompts', 'resources', 'tools']);
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
  assert.match(detail, /Anexos \(leia com get_attachment\):\n- id \d+: print\.txt/);

  const overdue = await call('list_tasks', { due: 'overdue' });
  assert.match(overdue.text, /#3 /);

  const rec = await call('add_tasks', { project: 'MeuApp', tasks: [{ title: 'Backup semanal', recurrence: { freq: 'weekly' }, due_date: '2020-01-06' }] });
  const recId = Number(rec.text.match(/criada: #(\d+)/)[1]);
  const done = await call('complete_tasks', { ids: [recId] });
  assert.match(done.text, /próxima ocorrência #\d+/);

  const closed = await call('manage_sprints', { project: 'MeuApp', action: 'complete', id: 1 });
  assert.match(closed.text, /1 tarefa\(s\) pendente\(s\) movida\(s\) para o backlog/);
});

test('edição em massa, posição, tags, dependências incrementais, comentários e exclusão', async () => {
  const r = await call('add_tasks', { project: 'Massa', tasks: [{ title: 'A' }, { title: 'B' }, { title: 'C', tags: ['x'] }] });
  const [a, b, c] = [...r.text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  const bulk = await call('update_tasks', { ids: [a, b], priority: 'urgent', add_tags: ['lote'] });
  assert.match(bulk.text, /Atualizadas 2 tarefa\(s\)/);
  assert.match(bulk.text, /\[urgente\] A \(lote\)/);

  await call('update_task', { id: c, add_tags: ['y'], remove_tags: ['x'], add_blocked_by: [a] });
  await call('update_task', { id: c, add_blocked_by: [b] });
  await call('update_task', { id: c, position: 'top' });
  const json = JSON.parse((await call('get_task', { id: c, format: 'json' })).text);
  assert.deepEqual(json.tags, ['y']);
  assert.deepEqual(json.blocked_by.map((x) => x.id).sort(), [a, b].sort());

  assert.match((await call('add_comment', { id: c, body: 'Decidido usar SQLite' })).text, /Comentário adicionado/);
  const listJson = JSON.parse((await call('list_tasks', { project: 'Massa', format: 'json', sort: 'priority' })).text);
  assert.equal(listJson.total, 3);
  assert.equal(listJson.tasks[0].priority, 'urgent');

  const refused = await call('delete_tasks', { ids: [b], confirm: false });
  assert.equal(refused.isError, true);
  assert.match((await call('delete_tasks', { ids: [b], confirm: true })).text, /Excluídas: #\d+ B/);
});

test('projetos, colunas, timer, relatório de tempo e anexos legíveis', async () => {
  assert.match((await call('manage_project', { action: 'create', name: 'Pessoal', description: 'Coisas minhas', color: '#2a78d6' })).text, /Projeto criado: \[\d+\] Pessoal/);
  const cols = await call('manage_columns', { project: 'Pessoal', action: 'create', name: 'Revisão', status: 'doing' });
  assert.match(cols.text, /Revisão \[em andamento\] \(id \d+\)/);
  const renamed = await call('manage_columns', { project: 'Pessoal', action: 'update', column: 'A fazer', name: 'Backlog' });
  assert.match(renamed.text, /1\. Backlog \[a fazer\]/);
  const t = await call('add_tasks', { project: 'Pessoal', tasks: [{ title: 'Revisar contrato', column: 'Revisão' }] });
  const id = Number(t.text.match(/#(\d+)/)[1]);
  const inCol = await call('list_tasks', { project: 'Pessoal', column: 'Revisão' });
  assert.match(inCol.text, /Revisar contrato/);

  assert.match((await call('timer', { action: 'start', id })).text, /Timer iniciado/);
  assert.match((await call('timer', { action: 'status' })).text, new RegExp(`#${id} Revisar contrato`));
  assert.match((await call('timer', { action: 'stop', id })).text, /Timer parado/);
  await call('log_time', { id, duration: '2h', note: 'leitura' });
  const report = await call('time_report', { project: 'Pessoal', group_by: 'task' });
  assert.match(report.text, /Revisar contrato \(Pessoal\): 2h/);

  const png = join(dir, 'tela.png');
  writeFileSync(png, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5e00000000049454e44ae426082', 'hex'));
  const txt = join(dir, 'log.txt');
  writeFileSync(txt, 'erro na linha 42');
  const imgId = Number((await call('attach_file', { id, path: png })).text.match(/id (\d+)/)[1]);
  const txtId = Number((await call('attach_file', { id, path: txt })).text.match(/id (\d+)/)[1]);
  const img = await rpc('tools/call', { name: 'get_attachment', arguments: { id: imgId } });
  assert.equal(img.result.content[1].type, 'image');
  assert.equal(img.result.content[1].mimeType, 'image/png');
  assert.match((await call('get_attachment', { id: txtId })).text, /erro na linha 42/);

  assert.match((await call('manage_project', { action: 'archive', project: 'Pessoal' })).text, /arquivado/);
});

test('visão geral, atividade, notificações, automações e configurações', async () => {
  assert.match((await call('get_overview', {})).text, /# Visão geral de todos os projetos/);
  assert.match((await call('get_overview', { project: 'MeuApp' })).text, /# Visão geral · MeuApp/);
  assert.match((await call('get_activity', { limit: 5 })).text, /Claude/);
  assert.match((await call('send_notification', { message: 'Lembrar do deploy' })).text, /Notificação enviada/);
  assert.match((await call('list_notifications', { mark_read: true })).text, /Claude: Lembrar do deploy/);
  assert.equal((await call('list_notifications', {})).text, 'Nenhuma notificação.');

  const rule = await call('manage_automations', {
    action: 'create', name: 'Bug vira alta', trigger: 'task_created', conditions: { type: ['bug'] }, action_type: 'set_priority', action_value: 'high',
  });
  assert.match(rule.text, /Criada: #\d+ \[ativa\] Bug vira alta/);
  const bug = await call('add_tasks', { project: 'MeuApp', tasks: [{ title: 'Crash ao salvar', type: 'bug' }] });
  const bugId = Number(bug.text.match(/#(\d+)/)[1]);
  assert.match((await call('get_task', { id: bugId })).text, /\[alta\] Crash ao salvar/);
  const ruleId = Number(rule.text.match(/#(\d+)/)[1]);
  assert.match((await call('manage_automations', { action: 'disable', id: ruleId })).text, /\[pausada\]/);

  assert.match((await call('manage_settings', { action: 'update', due_soon_days: 3 })).text, /3 dia\(s\) de antecedência/);
  assert.equal((await call('manage_settings', { action: 'update', due_soon_days: 99 })).isError, true);
});

test('resources: lista, templates e leitura', async () => {
  const list = await rpc('resources/list');
  const uris = list.result.resources.map((r) => r.uri);
  assert.ok(uris.includes('tarefas://overview') && uris.includes('tarefas://my-tasks'));
  assert.ok(uris.some((u) => /^tarefas:\/\/projects\/\d+$/.test(u)));
  const templates = await rpc('resources/templates/list');
  assert.deepEqual(templates.result.resourceTemplates.map((t) => t.uriTemplate), ['tarefas://tasks/{id}', 'tarefas://projects/{id}', 'tarefas://projects/{id}/overview']);
  const task = await rpc('resources/read', { uri: 'tarefas://tasks/2' });
  assert.equal(task.result.contents[0].mimeType, 'text/markdown');
  assert.match(task.result.contents[0].text, /#2 /);
  const board = await rpc('resources/read', { uri: 'tarefas://projects/1' });
  assert.match(board.result.contents[0].text, /^# MeuApp/);
  const missing = await rpc('resources/read', { uri: 'tarefas://tasks/99999' });
  assert.equal(missing.error.code, -32002);
});

test('prompts e autocompletar', async () => {
  const list = await rpc('prompts/list');
  assert.deepEqual(list.result.prompts.map((p) => p.name).sort(), [
    'concluir', 'pendencias', 'planejar_sprint', 'proxima', 'quebrar_tarefa', 'registrar_pendencias', 'relatorio', 'resolver', 'revisar_prazos', 'triagem',
  ]);
  const p = await rpc('prompts/get', { name: 'pendencias', arguments: { projeto: 'MeuApp' } });
  assert.equal(p.result.messages[0].role, 'user');
  assert.match(p.result.messages[0].content.text, /Projeto: MeuApp/);
  const q = await rpc('prompts/get', { name: 'quebrar_tarefa', arguments: { tarefa: '#2 Escrever README' } });
  assert.match(q.result.messages[0].content.text, /parent_id: 2/);
  const missing = await rpc('prompts/get', { name: 'concluir', arguments: {} });
  assert.equal(missing.error.code, -32602);
  const rel = await rpc('prompts/get', { name: 'relatorio', arguments: { periodo: 'semana' } });
  assert.match(rel.result.messages[0].content.text, /Concluídas no período/);

  const c1 = await rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'pendencias' }, argument: { name: 'projeto', value: 'me' } });
  assert.ok(c1.result.completion.values.includes('MeuApp'));
  const c2 = await rpc('completion/complete', { ref: { type: 'ref/resource', uri: 'tarefas://tasks/{id}' }, argument: { name: 'id', value: '' } });
  assert.ok(c2.result.completion.values.length > 0);
});

test('prompt resolver: pega a tarefa pelo número ou pelo código e avisa se a pasta é outra', async () => {
  const text = async (name, tarefa) => (await rpc('prompts/get', { name, arguments: { tarefa } })).result.messages[0].content.text;
  const byId = await text('resolver', '2');
  assert.match(byId, /^Resolva a tarefa #2 do quadro/);
  assert.match(byId, /update_task[\s\S]*complete_tasks/);
  // O MCP do teste roda fora da pasta do projeto MeuApp.
  assert.match(byId, /Atenção: Esta sessão está em .*, e o projeto da tarefa fica em .*MeuApp/);
  assert.equal(await text('resolver', '#2'), byId);

  // Com código de projeto, "COD-1" não pode virar a tarefa de número geral 1.
  await call('manage_project', { action: 'create', name: 'Com código', key: 'COD' });
  await call('add_tasks', { project: 'Com código', tasks: [{ title: 'Tarefa com código' }] });
  const byCode = await text('resolver', 'COD-1');
  assert.match(byCode, /Tarefa com código/);
  // Projeto sem pasta: não há com o que comparar a pasta da sessão.
  assert.doesNotMatch(byCode, /Atenção: Esta sessão está em/);
  assert.match(await text('concluir', 'cod-1'), /Tarefa com código/);

  const missing = await rpc('prompts/get', { name: 'resolver', arguments: { tarefa: 'COD-99' } });
  assert.equal(missing.error.code, -32602);
  const done = await call('complete_tasks', { ids: ['COD-1'], note: 'feito' });
  assert.equal(done.isError, false);
  assert.match(await text('resolver', 'COD-1'), /Atenção: Esta tarefa já está concluída/);
  await call('manage_project', { action: 'archive', project: 'Com código' });
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

test('add_blocked_by mantém o tipo das dependências existentes', async () => {
  const r = await call('add_tasks', { project: 'Deps', tasks: [{ title: 'Base' }, { title: 'Paralela' }, { title: 'Final' }] });
  const [a, b, c] = [...r.text.matchAll(/criada: #(\d+)/g)].map((m) => Number(m[1]));
  await call('update_task', { id: c, blocked_by: [{ id: a, type: 'start_start' }] });
  await call('update_task', { id: c, add_blocked_by: [b] });
  const { Store } = await import('../src/db.js');
  const s = new Store(join(dir, 't.db'));
  const deps = Object.fromEntries(s.blockers(c).map((d) => [d.id, d.type]));
  assert.deepEqual(deps, { [a]: 'start_start', [b]: 'finish_start' });
  s.db.close();
});

test('code_map: status cita a simulação e a action simulacao resume gargalos e premissas', async () => {
  await call('add_tasks', { project_path: repo, tasks: [{ title: 'Garante o projeto' }] });
  mkdirSync(join(repo, 'mapa-do-codigo'), { recursive: true });
  writeFileSync(join(repo, 'mapa-do-codigo', 'index.html'), '<!doctype html>');
  writeFileSync(join(repo, 'mapa-do-codigo', 'grafo.json'), JSON.stringify({ meta: { generatedAt: '2026-11-01T10:00:00Z', counts: { files: 1 } }, nodes: [], health: { issues: [] } }));
  assert.match((await call('code_map', { project_path: repo })).text, /Simulação no Breakscale: nenhuma ainda/);
  assert.match((await call('code_map', { project_path: repo, action: 'simulacao' })).text, /ainda não tem simulação/);
  writeFileSync(join(repo, 'mapa-do-codigo', 'simulacao.json'), JSON.stringify({
    $schema: 'mapa/simulacao@1', geradoEm: '2026-11-01T12:00:00Z', origem: 'local', link: 'https://breakscale.tech/#d3.AQID',
    cenarios: [{ fator: 1, nome: 'Tráfego de base', oferecido: 50, servido: 50, falhas: 0, p95: 40, p99: 1500, componentes: [] }],
    gargalos: [{ id: 'db', titulo: 'Banco não aguenta 2× o tráfego', porque: 'Fica 100% ocupado.', severidade: 'alta', sugestao: 'Cache.' }],
    premissas: [{ texto: 'Pool de 10.', origem: 'código' }, { texto: '50/s.', origem: 'chute' }],
  }));
  assert.match((await call('code_map', { project_path: repo })).text, /1 gargalo\(s\), 1 urgente\(s\)/);
  const sim = (await call('code_map', { project_path: repo, action: 'simulacao' })).text;
  assert.match(sim, /das quais 1 ainda são estimativas/);
  assert.match(sim, /Tráfego de base: 50\/s chegando, 50\/s atendidos, 0% falham, p95 40 ms, p99 1\.5 s/);
  assert.match(sim, /\[urgente\] Banco não aguenta 2× o tráfego\. Fica 100% ocupado\. Sugestão: Cache\. \(sem tarefa\)/);
  assert.match(sim, /Abrir no Breakscale: https:\/\/breakscale\.tech\/#d3\.AQID/);
});
