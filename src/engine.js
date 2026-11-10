// Motor de automações e notificações. É ligado em todo processo que grava no banco
// (painel e MCP), então as regras valem tanto para mudanças suas quanto do Claude.
import { spawn } from 'node:child_process';
import { AGENTS, agentName } from './agents.js';
import { mailEnabled, sendLater } from './mailer.js';
import { PRIORITY_LABEL, STATUS_LABEL, addDays, today } from './util.js';

const AUTOMATION = { author: 'automação' };

const fill = (text, t, extra = {}) => String(text)
  .replaceAll('{id}', t ? `#${t.id}` : '')
  .replaceAll('{ref}', t?.ref || (t ? `#${t.id}` : ''))
  .replaceAll('{titulo}', t?.title || '')
  .replaceAll('{projeto}', t?.project_name || extra.project || '')
  .replaceAll('{prazo}', t?.due_date || 'sem prazo')
  .replaceAll('{status}', t ? STATUS_LABEL[t.status] : '')
  .replaceAll('{prioridade}', t ? PRIORITY_LABEL[t.priority] : '')
  .replaceAll('{sprint}', extra.sprint || t?.sprint_name || '');

function conditionsMatch(rule, task, changes) {
  const c = rule.conditions || {};
  if (!task) return true;
  if (c.to_status && task.status !== c.to_status) return false;
  if (c.from_status && changes?.status?.[0] !== c.from_status) return false;
  if (c.priority?.length && !c.priority.includes(task.priority)) return false;
  if (c.type?.length && !c.type.includes(task.type)) return false;
  if (c.tag && !task.tags.includes(c.tag)) return false;
  if (c.by_claude && !AGENTS[task.source]) return false;
  if (c.field && changes && !Object.keys(changes).includes(c.field)) return false;
  return true;
}

function emailTargets(store, rule, task) {
  const to = String(rule.action.to || 'followers');
  if (to === 'followers' || to === 'assignees') {
    const ids = task ? (to === 'assignees' ? task.assignee_ids : store.followersOf(task)) : store.listUsers().map((u) => u.id);
    return ids.map((id) => store.user(id)?.email).filter(Boolean);
  }
  return to.split(',').map((x) => x.trim()).filter(Boolean);
}

function applyTo(store, rule, task, extra = {}) {
  const { type, value } = rule.action;
  switch (type) {
    case 'set_status': store.updateTask(task.id, { status: value }, AUTOMATION); break;
    case 'set_column': store.updateTask(task.id, { column: value }, AUTOMATION); break;
    case 'set_priority': store.updateTask(task.id, { priority: value }, AUTOMATION); break;
    case 'add_tag': store.updateTask(task.id, { tags: [...task.tags, value] }, AUTOMATION); break;
    case 'remove_tag': store.updateTask(task.id, { tags: task.tags.filter((t) => t !== value) }, AUTOMATION); break;
    case 'add_comment': store.addNote(task.id, fill(value, task, extra), AUTOMATION); break;
    case 'set_due_in_days': store.updateTask(task.id, { due_date: addDays(today(), Number(value)) }, AUTOMATION); break;
    case 'move_to_active_sprint': {
      const sprint = store.sprints(task.project_id).find((s) => s.status === 'active');
      if (sprint && sprint.id !== task.sprint_id) store.updateTask(task.id, { sprint_id: sprint.id }, AUTOMATION);
      break;
    }
    case 'move_to_sprint': store.updateTask(task.id, { sprint: value }, AUTOMATION); break;
    case 'assign': {
      const user = store.findUser(value);
      if (user && !task.assignee_ids.includes(user.id)) store.setAssignees(task.id, [...task.assignee_ids, user.id], AUTOMATION);
      break;
    }
    default: break;
  }
}

function sendMessage(store, rule, task, extra = {}) {
  const { type, value } = rule.action;
  const body = fill(value, task, extra);
  if (type === 'notify') {
    const ids = task ? store.followersOf(task) : [];
    store.notify({ user_ids: ids.length ? ids : null, task_id: task?.id ?? null, body, type: 'automation' });
  }
  if (type === 'send_email' && mailEnabled(store)) {
    const to = emailTargets(store, rule, task);
    if (to.length) {
      sendLater(store, {
        to,
        subject: fill(rule.action.subject || (task ? `[#${task.id}] ${task.title}` : rule.name), task, extra),
        text: body,
        link: task ? `${store.publicUrl()}/?task=${task.id}` : store.publicUrl(),
      });
    }
  }
}

function record(store, rule, task) {
  store.transaction(() => {
    if (task) store.logEvent(task.id, AUTOMATION, `automação “${rule.name}”`);
    store.recordAutomationRun(rule.id, task?.id ?? null);
  });
}

function run(store, trigger, { task, changes, actor }) {
  // Mudanças feitas por automações não disparam outras automações (evita cascata).
  if (actor?.author === 'automação' || !task) return;
  for (const rule of store.automationsFor(trigger, task.project_id)) {
    const fresh = store.task(task.id);
    if (!fresh || !conditionsMatch(rule, fresh, changes)) continue;
    try {
      if (['notify', 'send_email'].includes(rule.action.type)) sendMessage(store, rule, fresh);
      else applyTo(store, rule, fresh);
      record(store, rule, fresh);
    } catch (e) { console.error(`automação ${rule.id}:`, e.message); }
  }
}

// Gatilhos de sprint: avisos saem uma vez; ações de tarefa valem para cada tarefa aberta da sprint.
function runSprint(store, trigger, { sprint, actor }) {
  if (actor?.author === 'automação') return;
  for (const rule of store.automationsFor(trigger, sprint.project_id)) {
    try {
      if (['notify', 'send_email'].includes(rule.action.type)) {
        sendMessage(store, rule, null, { sprint: sprint.name, project: store.project(sprint.project_id)?.name });
        record(store, rule, null);
        continue;
      }
      for (const t of store.listTasks({ project_id: sprint.project_id, sprint_id: sprint.id, status: 'open', limit: 2000 })) {
        if (!conditionsMatch(rule, t)) continue;
        applyTo(store, rule, t, { sprint: sprint.name });
        record(store, rule, t);
      }
    } catch (e) { console.error(`automação ${rule.id}:`, e.message); }
  }
}

function actorName(store, actor) {
  if (agentName(actor?.author)) return agentName(actor.author);
  if (actor?.user_id) return store.user(actor.user_id)?.name || 'Alguém';
  return actor?.author === 'automação' ? 'Uma automação' : 'Alguém';
}

export function macNotify(body, title = 'Quadro de tarefas') {
  if (process.platform !== 'darwin' || process.env.CLAUDE_TASKS_NO_OS_NOTIFY) return;
  const clean = (s) => String(s).replace(/[\u0000-\u001f]+/g, ' ').slice(0, 240);
  const script = `display notification ${JSON.stringify(clean(body))} with title ${JSON.stringify(clean(title))}`;
  try { spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref(); } catch {}
}

const except = (ids, actor) => ids.filter((id) => id && id !== actor?.user_id);

export function attachEngine(store) {
  store.on('task.created', (e) => run(store, 'task_created', e));
  store.on('task.updated', (e) => {
    run(store, 'task_updated', e);
    if (e.changes.status) {
      run(store, 'status_changed', e);
      const targets = except(store.followersOf(e.task), e.actor);
      if (targets.length && e.actor?.author !== 'automação') {
        store.notify({ user_ids: targets, task_id: e.task.id, type: 'status', body: `${actorName(store, e.actor)} mudou #${e.task.id} para "${STATUS_LABEL[e.task.status]}": ${e.task.title}` });
      }
    }
    if (e.changes.priority) run(store, 'priority_changed', e);
  });
  store.on('task.commented', (e) => {
    if (!e.edited) run(store, 'comment_added', e);
    const task = store.task(e.task.id);
    const excerpt = e.note.body.length > 90 ? `${e.note.body.slice(0, 90)}…` : e.note.body;
    const mentioned = except(e.mentions || [], e.actor);
    if (mentioned.length) {
      store.notify({ user_ids: mentioned, task_id: task.id, type: 'mention', body: `${actorName(store, e.actor)} mencionou você em #${task.id}: ${excerpt}` });
    }
    const followers = except(store.followersOf(task), e.actor).filter((id) => !mentioned.includes(id));
    if (followers.length && !e.edited) {
      store.notify({ user_ids: followers, task_id: task.id, type: 'comment', body: `${actorName(store, e.actor)} comentou em #${task.id}: ${excerpt}` });
    }
  });
  store.on('task.assigned', (e) => {
    const task = store.task(e.task_id);
    if (e.user_id !== e.actor?.user_id) {
      store.notify({ user_ids: [e.user_id], task_id: task.id, type: 'assigned', body: `${actorName(store, e.actor)} atribuiu #${task.id} a você: ${task.title}` });
    }
    run(store, 'assigned', { task, actor: e.actor });
  });
  store.on('sprint.started', (e) => runSprint(store, 'sprint_started', e));
  store.on('sprint.completed', (e) => runSprint(store, 'sprint_completed', e));
  store.on('project.created', ({ project, actor }) => {
    if (actor?.author === 'automação') return;
    for (const rule of store.automationsFor('project_created', null)) {
      try { sendMessage(store, rule, null, { project: project.name }); record(store, rule, null); } catch (e) { console.error(`automação ${rule.id}:`, e.message); }
    }
  });

  // Canais por pessoa: macOS (se ligado nas configurações gerais) e e-mail.
  store.on('notification', ({ task_id, body, type, delivered }) => {
    if (store.setting('notify_macos') && delivered.some((d) => d.os)) macNotify(body);
    const emails = delivered.filter((d) => d.email && d.user_id).map((d) => store.user(d.user_id)?.email).filter(Boolean);
    if (emails.length && mailEnabled(store)) {
      const task = task_id ? store.task(task_id) : null;
      sendLater(store, {
        to: emails,
        subject: task ? `[#${task.id}] ${task.title}` : 'Notificação do quadro de tarefas',
        text: body,
        link: task ? `${store.publicUrl()}/?task=${task.id}` : store.publicUrl(),
        headers: { 'X-Quadro-Tipo': type },
      });
    }
  });
}

// Roda a cada minuto no servidor do painel: avisos de prazo e automações por tempo.
export function tick(store) {
  const d = today();
  const soon = addDays(d, Number(store.setting('due_soon_days')) || 0);
  for (const t of store.listTasks({ status: 'open', due: 'any', limit: 5000 })) {
    const followers = [...new Set([...t.assignee_ids, ...t.watcher_ids])];
    const user_ids = followers.length ? followers : null;
    if (t.due_date < d) {
      store.notify({ user_ids, task_id: t.id, type: 'overdue', key: `overdue:${t.id}:${t.due_date}`, body: `Atrasada: #${t.id} ${t.title} (prazo ${t.due_date.slice(8)}/${t.due_date.slice(5, 7)})` });
    } else if (t.due_date <= soon) {
      const when = t.due_date === d ? 'hoje' : t.due_date === addDays(d, 1) ? 'amanhã' : `em ${t.due_date.slice(8)}/${t.due_date.slice(5, 7)}`;
      store.notify({ user_ids, task_id: t.id, type: 'due', key: `due:${t.id}:${t.due_date}`, body: `Vence ${when}: #${t.id} ${t.title}` });
    }
  }

  for (const rule of store.listAutomations()) {
    if (!rule.enabled || (rule.trigger !== 'due_soon' && rule.trigger !== 'overdue')) continue;
    const limit = addDays(d, Number(rule.conditions.days ?? 1));
    for (const t of store.listTasks({ project_id: rule.project_id || undefined, status: 'open', due: 'any', limit: 5000 })) {
      const hit = rule.trigger === 'overdue' ? t.due_date < d : t.due_date >= d && t.due_date <= limit;
      if (!hit || store.alreadyFired(rule.id, t.id) || !conditionsMatch(rule, t)) continue;
      try {
        if (['notify', 'send_email'].includes(rule.action.type)) sendMessage(store, rule, t);
        else applyTo(store, rule, t);
        record(store, rule, t);
      } catch (e) { console.error(`automação ${rule.id}:`, e.message); }
    }
  }
}

