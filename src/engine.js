// Motor de automações e notificações. É ligado em todo processo que grava no banco
// (painel e MCP), então as regras valem tanto para mudanças suas quanto do Claude.
import { spawn } from 'node:child_process';
import { PRIORITY_LABEL, STATUS_LABEL, addDays, today } from './util.js';

const AUTOMATION = { author: 'automação' };

const fill = (text, t) => String(text)
  .replaceAll('{id}', `#${t.id}`)
  .replaceAll('{titulo}', t.title)
  .replaceAll('{projeto}', t.project_name)
  .replaceAll('{prazo}', t.due_date || 'sem prazo')
  .replaceAll('{status}', STATUS_LABEL[t.status])
  .replaceAll('{prioridade}', PRIORITY_LABEL[t.priority]);

function conditionsMatch(rule, task, changes) {
  const c = rule.conditions || {};
  if (c.to_status && task.status !== c.to_status) return false;
  if (c.from_status && changes?.status?.[0] !== c.from_status) return false;
  if (c.priority?.length && !c.priority.includes(task.priority)) return false;
  if (c.type?.length && !c.type.includes(task.type)) return false;
  if (c.tag && !task.tags.includes(c.tag)) return false;
  if (c.by_claude && task.source !== 'claude') return false;
  return true;
}

function apply(store, rule, task) {
  const { type, value } = rule.action;
  switch (type) {
    case 'set_status': store.updateTask(task.id, { status: value }, AUTOMATION); break;
    case 'set_priority': store.updateTask(task.id, { priority: value }, AUTOMATION); break;
    case 'add_tag': store.updateTask(task.id, { tags: [...task.tags, value] }, AUTOMATION); break;
    case 'remove_tag': store.updateTask(task.id, { tags: task.tags.filter((t) => t !== value) }, AUTOMATION); break;
    case 'add_comment': store.addNote(task.id, fill(value, task), AUTOMATION); break;
    case 'notify':
      store.notify({ user_ids: task.assignee_ids.length ? task.assignee_ids : null, task_id: task.id, body: fill(value, task) });
      break;
    case 'set_due_in_days': store.updateTask(task.id, { due_date: addDays(today(), Number(value)) }, AUTOMATION); break;
    case 'move_to_active_sprint': {
      const sprint = store.sprints(task.project_id).find((s) => s.status === 'active');
      if (sprint && sprint.id !== task.sprint_id) store.updateTask(task.id, { sprint_id: sprint.id }, AUTOMATION);
      break;
    }
    case 'assign': {
      const user = store.findUser(value);
      if (user && !task.assignee_ids.includes(user.id)) store.setAssignees(task.id, [...task.assignee_ids, user.id], AUTOMATION);
      break;
    }
  }
  store.transaction(() => {
    store.logEvent(task.id, AUTOMATION, `automação “${rule.name}”`);
    store.recordAutomationRun(rule.id, task.id);
  });
}

function run(store, trigger, { task, changes, actor }) {
  // Mudanças feitas por automações não disparam outras automações (evita cascata).
  if (actor?.author === 'automação' || !task) return;
  for (const rule of store.automationsFor(trigger, task.project_id)) {
    const fresh = store.task(task.id);
    if (!fresh || !conditionsMatch(rule, fresh, changes)) continue;
    try { apply(store, rule, fresh); } catch (e) { console.error(`automação ${rule.id}:`, e.message); }
  }
}

function actorName(store, actor) {
  if (actor?.author === 'claude') return 'Claude';
  if (actor?.user_id) return store.user(actor.user_id)?.name || 'Alguém';
  return actor?.author === 'claude' ? 'Claude' : actor?.author === 'automação' ? 'Uma automação' : 'Alguém';
}

export function macNotify(body, title = 'Quadro de tarefas') {
  if (process.platform !== 'darwin' || process.env.CLAUDE_TASKS_NO_OS_NOTIFY) return;
  const clean = (s) => String(s).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 240);
  const script = `display notification ${JSON.stringify(clean(body))} with title ${JSON.stringify(clean(title))}`;
  try { spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

export function attachEngine(store) {
  store.on('task.created', (e) => run(store, 'task_created', e));
  store.on('task.updated', (e) => {
    if (e.changes.status) run(store, 'status_changed', e);
    if (e.changes.priority) run(store, 'priority_changed', e);
  });
  store.on('task.commented', (e) => {
    run(store, 'comment_added', e);
    const task = store.task(e.task.id);
    const targets = task.assignee_ids.filter((id) => id !== e.actor?.user_id);
    if (targets.length) {
      const excerpt = e.note.body.length > 90 ? `${e.note.body.slice(0, 90)}…` : e.note.body;
      store.notify({ user_ids: targets, task_id: task.id, body: `${actorName(store, e.actor)} comentou em #${task.id}: ${excerpt}` });
    }
  });
  store.on('task.assigned', (e) => {
    const task = store.task(e.task_id);
    if (e.user_id !== e.actor?.user_id) {
      store.notify({ user_ids: [e.user_id], task_id: task.id, body: `${actorName(store, e.actor)} atribuiu #${task.id} a você: ${task.title}` });
    }
    run(store, 'assigned', { task, actor: e.actor });
  });
  store.on('notification', ({ body }) => {
    if (store.setting('notify_macos')) macNotify(body);
  });
}

// Roda a cada minuto no servidor do painel: avisos de prazo e automações por tempo.
const shortDate = (s) => `${s.slice(8)}/${s.slice(5, 7)}`;

export function tick(store) {
  const d = today();
  const soon = addDays(d, Number(store.setting('due_soon_days')) || 0);
  for (const t of store.listTasks({ status: 'open', due: 'any', limit: 5000 })) {
    const user_ids = t.assignee_ids.length ? t.assignee_ids : null;
    if (t.due_date < d) {
      store.notify({ user_ids, task_id: t.id, key: `overdue:${t.id}:${t.due_date}`, body: `Atrasada: #${t.id} ${t.title} (prazo ${shortDate(t.due_date)})` });
    } else if (t.due_date <= soon) {
      const when = t.due_date === d ? 'hoje' : t.due_date === addDays(d, 1) ? 'amanhã' : `em ${shortDate(t.due_date)}`;
      store.notify({ user_ids, task_id: t.id, key: `due:${t.id}:${t.due_date}`, body: `Vence ${when}: #${t.id} ${t.title}` });
    }
  }

  for (const rule of store.listAutomations()) {
    if (!rule.enabled || (rule.trigger !== 'due_soon' && rule.trigger !== 'overdue')) continue;
    const limit = addDays(d, Number(rule.conditions.days ?? 1));
    for (const t of store.listTasks({ project_id: rule.project_id || undefined, status: 'open', due: 'any', limit: 5000 })) {
      const hit = rule.trigger === 'overdue' ? t.due_date < d : t.due_date >= d && t.due_date <= limit;
      if (!hit || store.alreadyFired(rule.id, t.id) || !conditionsMatch(rule, t)) continue;
      try { apply(store, rule, t); } catch (e) { console.error(`automação ${rule.id}:`, e.message); }
    }
  }
}
