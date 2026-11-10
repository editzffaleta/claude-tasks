// Recursos da paridade com o Taskosaur, direto na camada de dados (sem servidor).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Store } from '../src/db.js';
import { exportCsv, importCsv, importJiraIssues, importTrelloBoard, parseCsv } from '../src/importers.js';
import { ingestRaw, saveInbox, saveRule } from '../src/inbox.js';
import { isEncrypted } from '../src/secret.js';
import { addDays, nextOccurrence, today } from '../src/util.js';

let dir, store, P;
const ME = { author: 'user', user_id: 1 };

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-tasks-feat-'));
  store = new Store(join(dir, 't.db'));
  store.createUser({ name: 'Bruno Teste', email: 'bruno@ex.test', password: 'senha-forte-1', role: 'admin' });
  store.createUser({ name: 'Ana Lima', email: 'ana@ex.test', password: 'senha-forte-2' });
  P = store.createProject('Site', null, { key: 'WEB' });
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('chave do projeto numera as tarefas (WEB-1) e a referência resolve', () => {
  const t = store.addTask(P.id, { title: 'Home' }, ME).task;
  assert.equal(t.ref, 'WEB-1');
  assert.equal(store.resolveTaskRef('WEB-1'), t.id);
  assert.equal(store.resolveTaskRef(`#${t.id}`), t.id);
});

test('5 prioridades, pontos e estimativa original/restante', () => {
  const t = store.addTask(P.id, { title: 'Pontuada', priority: 'lowest', story_points: 5, estimate: '1d', remaining: '3h' }, ME).task;
  assert.equal(t.priority, 'lowest');
  assert.equal(t.story_points, 5);
  assert.equal(t.estimate_minutes, 480);
  assert.equal(t.remaining_minutes, 180);
  assert.throws(() => store.updateTask(t.id, { story_points: -1 }, ME), /story_points/);
});

test('labels com cor: renomear a label renomeia a tag nas tarefas', () => {
  const t = store.addTask(P.id, { title: 'Com label', tags: ['front'] }, ME).task;
  const l = store.createLabel({ project_id: P.id, name: 'front', color: '#2a78d6' });
  store.updateLabel(l.id, { name: 'frontend' });
  assert.deepEqual(store.task(t.id).tags, ['frontend']);
  assert.throws(() => store.createLabel({ project_id: P.id, name: 'x', color: 'azul' }), /Cor inválida/);
});

test('campos personalizados validam o tipo do valor', () => {
  const sel = store.createField({ project_id: P.id, name: 'Ambiente', type: 'select', options: ['dev', 'prod'] });
  const num = store.createField({ project_id: P.id, name: 'Esforço', type: 'number' });
  const t = store.addTask(P.id, { title: 'Campos' }, ME).task;
  store.updateTask(t.id, { fields: { Ambiente: 'prod', [num.id]: '3' } }, ME);
  const full = store.taskWithNotes(t.id);
  assert.equal(full.fields.find((f) => f.id === sel.id).value, 'prod');
  assert.equal(full.fields.find((f) => f.id === num.id).value, 3);
  assert.throws(() => store.updateTask(t.id, { fields: { Ambiente: 'qa' } }, ME));
});

test('fluxo: transições permitidas barram movimentos fora da regra', () => {
  const Q = store.createProject('Fluxo', null, {});
  store.materializeColumns(Q.id);
  const cols = store.columns(Q.id);
  const [todo, doing, , done] = cols;
  store.setTransitions(Q.id, [[todo.id, doing.id], [doing.id, done.id]]);
  const t = store.addTask(Q.id, { title: 'Segue o fluxo' }, ME).task;
  assert.throws(() => store.updateTask(t.id, { column: done.id }, ME), /Transição não permitida/);
  store.updateTask(t.id, { column: doing.id }, ME);
  assert.equal(store.updateTask(t.id, { column: done.id }, ME).status, 'done');
  assert.deepEqual(store.taskWithNotes(t.id).allowed_columns, [done.id]);
});

test('workflow salvo de um projeto e aplicado em outro', () => {
  const Q = store.createProject('Modelo', null, {});
  store.materializeColumns(Q.id);
  store.createColumn(Q.id, { name: 'Revisão', status: 'doing' });
  const wf = store.workflowFromProject(Q.id, { name: 'Com revisão' });
  const R = store.createProject('Destino', null, {});
  store.applyWorkflow(R.id, wf.id);
  assert.ok(store.columns(R.id).some((c) => c.name === 'Revisão'));
});

test('dependências com tipo e sem ciclos', () => {
  const a = store.addTask(P.id, { title: 'A' }, ME).task;
  const b = store.addTask(P.id, { title: 'B' }, ME).task;
  store.addBlocker(b.id, a.id, 'start_start');
  assert.equal(store.blockers(b.id)[0].type, 'start_start');
  assert.throws(() => store.addBlocker(a.id, b.id), /ciclo|circular/i);
  assert.throws(() => store.addBlocker(b.id, a.id, 'depois'));
});

test('recorrência avançada: dias da semana, último dia do mês e limite de vezes', () => {
  assert.equal(nextOccurrence('2026-11-02', { freq: 'weekly', interval: 1, weekdays: [1, 3] }), '2026-11-04');
  assert.equal(nextOccurrence('2026-01-31', { freq: 'monthly', interval: 1, monthday: 'last' }), '2026-02-28');
  // Prazo na próxima segunda-feira: a ocorrência seguinte nunca cai antes de hoje, então uma data
  // fixa no passado faria o resultado depender do dia em que o teste roda.
  const monday = nextOccurrence(today(), { freq: 'weekly', weekdays: [1] });
  const t = store.addTask(P.id, { title: 'Relatório', due_date: monday, recurrence: { freq: 'weekly', weekdays: [1, 3], count: 2 } }, ME).task;
  const done1 = store.updateTask(t.id, { status: 'done' }, ME);
  const next = store.task(done1.recurrence_next_id);
  assert.equal(next.due_date, addDays(monday, 2));
  const done2 = store.updateTask(next.id, { status: 'done' }, ME);
  assert.equal(done2.recurrence_next_id, null, 'parou na 2ª ocorrência');
});

test('velocidade guarda o planejado ao concluir a sprint', () => {
  const Q = store.createProject('Sprints', null, {});
  const s = store.createSprint(Q.id, { name: 'S1' });
  store.startSprint(s.id, ME);
  const tasks = [3, 5, 8].map((pts, i) => store.addTask(Q.id, { title: `T${i}`, story_points: pts, sprint: s.id }, ME).task);
  store.updateTask(tasks[0].id, { status: 'done' }, ME);
  const s2 = store.createSprint(Q.id, { name: 'S2' });
  store.completeSprint(s.id, { move_to: s2.id }, ME);
  const v = store.stats({ project_id: Q.id }).velocity[0];
  assert.deepEqual({ points: v.points, planned_points: v.planned_points, tasks: v.tasks, planned: v.planned }, { points: 3, planned_points: 16, tasks: 1, planned: 3 });
  store.cancelSprint(s2.id, {}, ME);
  assert.equal(store.sprint(s2.id).status, 'cancelled');
  assert.equal(store.stats({ project_id: Q.id }).velocity.length, 1, 'sprint cancelada não entra na velocidade');
});

test('CSV: exporta e importa de volta (reimportar atualiza, não duplica)', () => {
  const Q = store.createProject('CSV', null, {});
  const r = importCsv(store, Q.id, 'Título,Prioridade,Status,Tags,Prazo,Pontos\n"Login, com vírgula",Alta,Em andamento,"a,b",31/12/2026,3\nSair,low,done,,,', { actor: ME });
  assert.equal(r.created, 2);
  const list = store.listTasks({ project_id: Q.id, status: 'all' });
  const login = list.find((t) => t.title === 'Login, com vírgula');
  assert.equal(login.priority, 'high');
  assert.equal(login.status, 'doing');
  assert.equal(login.due_date, '2026-12-31');
  assert.equal(login.story_points, 3);
  const csv = exportCsv(store, list);
  assert.equal(parseCsv(csv).length, 3);
  // Reimportar a própria exportação (editada) atualiza em vez de duplicar.
  const edited = csv.replace('Sair', 'Sair do sistema');
  const again = importCsv(store, Q.id, edited, { actor: ME });
  assert.deepEqual({ created: again.created, updated: again.updated }, { created: 0, updated: 2 });
  assert.ok(store.listTasks({ project_id: Q.id, status: 'all' }).some((t) => t.title === 'Sair do sistema'));
  // O mesmo CSV em outro projeto cria tarefas novas (ID de outro projeto não casa).
  const R = store.createProject('CSV 2', null, {});
  assert.equal(importCsv(store, R.id, csv, { actor: ME }).created, 2);
});

test('Jira (issues da API) e Trello (JSON exportado), reimportação atualiza', () => {
  const Q = store.createProject('Importado', null, {});
  const issues = [{ key: 'ABC-1', fields: { summary: 'Bug no carrinho', status: { statusCategory: { key: 'indeterminate' } }, priority: { name: 'Highest' }, issuetype: { name: 'Bug' }, labels: ['loja'], description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Some o item' }] }] } } }];
  assert.equal(importJiraIssues(store, Q.id, issues, { actor: ME }).created, 1);
  const bug = store.listTasks({ project_id: Q.id, status: 'all' }).find((t) => t.title === 'Bug no carrinho');
  assert.equal(bug.type, 'bug');
  assert.equal(bug.status, 'doing');
  assert.match(bug.description, /Some o item/);
  issues[0].fields.summary = 'Bug no carrinho (renomeado)';
  assert.equal(importJiraIssues(store, Q.id, issues, { actor: ME }).updated, 1);

  const board = {
    lists: [{ id: 'l1', name: 'A fazer' }, { id: 'l2', name: 'Feito' }],
    labels: [{ id: 'x', name: 'urgente', color: 'red' }],
    cards: [{ id: 'c1', name: 'Cartão', idList: 'l1', labels: [{ name: 'urgente' }], idMembers: [] }, { id: 'c2', name: 'Pronto', idList: 'l2', dueComplete: true }],
    checklists: [{ idCard: 'c1', checkItems: [{ id: 'i1', name: 'Passo 1', state: 'complete' }] }],
  };
  const r = importTrelloBoard(store, Q.id, board, { actor: ME });
  assert.equal(r.created, 2);
  assert.equal(store.labels(Q.id).find((l) => l.name === 'urgente').color, '#e34948');
  const card = store.listTasks({ project_id: Q.id, status: 'all' }).find((t) => t.title === 'Cartão');
  assert.equal(store.taskWithNotes(card.id).subtasks[0].status, 'done');
  assert.equal(importTrelloBoard(store, Q.id, board, { actor: ME }).updated, 2);
});

test('caixa de entrada: e-mail vira tarefa, resposta com [#id] vira comentário, regras aplicam', () => {
  const Q = store.createProject('Suporte', null, {});
  saveInbox(store, Q.id, { address: 'suporte@ex.test', imap_host: 'imap.ex.test', imap_user: 'suporte', imap_pass: 'segredo-imap' });
  assert.ok(isEncrypted(store.db.prepare('SELECT imap_pass FROM inboxes WHERE project_id = ?').get(Q.id).imap_pass), 'senha IMAP cifrada');
  saveRule(store, Q.id, { name: 'Urgente', conditions: { subject_contains: 'urgente' }, actions: { priority: 'urgent', tags: ['vip'] } });
  const mail = (id, subject, body, from = 'Cliente <cliente@fora.test>') => [
    `From: ${from}`, 'To: suporte@ex.test', `Subject: ${subject}`, `Message-ID: <${id}@fora.test>`, 'Date: Sat, 31 Oct 2026 10:00:00 -0300',
    'Content-Type: text/plain; charset=utf-8', '', body,
  ].join('\r\n');
  assert.equal(ingestRaw(store, Q.id, mail('m1', 'URGENTE: site fora do ar', 'Nada abre desde as 9h.')), 'task');
  assert.equal(ingestRaw(store, Q.id, mail('m1', 'URGENTE: site fora do ar', 'repetido')), 'dup');
  const t = store.listTasks({ project_id: Q.id, status: 'all' })[0];
  assert.equal(t.priority, 'urgent');
  assert.deepEqual(t.tags.sort(), ['e-mail', 'vip']);
  assert.equal(t.source, 'e-mail');
  assert.equal(ingestRaw(store, Q.id, mail('m2', `Re: [#${t.id}] ${t.title}`, 'Voltou, obrigado!\n\nEm sáb, Suporte escreveu:\n> texto antigo')), 'comment');
  const note = store.taskWithNotes(t.id).notes.find((n) => n.kind === 'note');
  assert.match(note.body, /Voltou, obrigado!/);
  assert.doesNotMatch(note.body, /texto antigo/);
});

test('segredos ficam cifrados no banco e mascarados na leitura', () => {
  store.updateSettings({ smtp_pass: 'senha-smtp', ai_api_key: 'chave-ia' });
  const raw = store.db.prepare("SELECT value FROM settings WHERE key = 'smtp_pass'").get().value;
  assert.ok(isEncrypted(JSON.parse(raw)));
  assert.equal(store.settings().smtp_pass, '••••••••');
  assert.equal(store.settings({ reveal: true }).ai_api_key, 'chave-ia');
  store.updateSettings({ smtp_pass: '••••••••' });
  assert.equal(store.settings({ reveal: true }).smtp_pass, 'senha-smtp', 'máscara não sobrescreve');
});

test('busca universal encontra tarefas, comentários, projetos e pessoas', () => {
  const t = store.addTask(P.id, { title: 'Integrar pagamento' }, ME).task;
  store.addNote(t.id, 'Usar o gateway novo', ME);
  const r = store.search('gateway');
  assert.equal(r.comments[0].task_id, t.id);
  assert.equal(store.search('Ana').people[0].email, 'ana@ex.test');
  assert.equal(store.search('Site').projects[0].id, P.id);
});

test('atalhos de uma tecla vêm ligados e a pessoa pode desligar', () => {
  const ana = store.findUser('ana@ex.test');
  assert.equal(store.userSettings(ana.id).single_keys, true);
  assert.equal(store.updateUserSettings(ana.id, { single_keys: false }).single_keys, false);
  assert.equal(store.userSettings(ana.id).single_keys, false);
  assert.equal(store.updateUserSettings(ana.id, { single_keys: true }).single_keys, true);
});

test('aviso de prazo com o canal "no painel" desligado não se repete e não aparece no sino', () => {
  const ana = store.findUser('ana@ex.test');
  store.updateUserSettings(ana.id, { notify: { due: { app: false, email: true } } });
  const first = store.notify({ user_ids: [ana.id], body: 'Vence amanhã', key: 'due:1:2026-11-01', type: 'due' });
  const again = store.notify({ user_ids: [ana.id], body: 'Vence amanhã', key: 'due:1:2026-11-01', type: 'due' });
  assert.deepEqual([first, again], [1, 0]);
  assert.equal(store.notifications(ana.id).length, 0);
  assert.equal(store.unreadCount(ana.id), 0);
});

test('sem a chave de segredos, o segredo vira vazio em vez de derrubar o painel', () => {
  store.updateSettings({ smtp_pass: 'outra' });
  store.db.prepare("UPDATE settings SET value = ? WHERE key = 'smtp_pass'").run(JSON.stringify('enc:v1:lixo:lixo:lixo'));
  assert.equal(store.settings({ reveal: true }).smtp_pass, '');
});

