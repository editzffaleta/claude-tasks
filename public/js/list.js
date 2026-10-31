// Visão Lista: tabela ordenável e agrupável, com subtarefas aninhadas.
import { api, attempt } from './api.js';
import { openTask } from './drawer.js';
import { state, filteredTasks, load, userById } from './state.js';
import { openNewTask } from './taskform.js';
import {
  ICON, PRIORITY_LABEL, PRIORITY_ORDER, STATUS_LABEL, TYPE_LABEL, ago, avatar, dueInfo, esc, fmtDuration,
  prioIcon, projectColor, statusIcon, typeIcon,
} from './util.js';

const STATUS_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };
let sortKey = 'default';
let sortDir = 1;
let groupBy = 'none';
const collapsed = new Set();

const GROUPS = {
  none: 'Sem agrupamento',
  project: 'Projeto',
  status: 'Status',
  priority: 'Prioridade',
  due: 'Prazo',
  assignee: 'Responsável',
  sprint: 'Sprint',
  type: 'Tipo',
};

function dueBucket(t) {
  if (!t.due_date) return ['5', 'Sem prazo'];
  if (t.status !== 'done' && t.overdue) return ['0', 'Atrasadas'];
  if (t.due_date === state.today) return ['1', 'Hoje'];
  const days = (new Date(`${t.due_date}T12:00:00`) - new Date(`${state.today}T12:00:00`)) / 86400000;
  if (days <= 7) return ['2', 'Próximos 7 dias'];
  if (days <= 31) return ['3', 'Próximos 30 dias'];
  return ['4', 'Mais tarde'];
}

function groupOf(t) {
  switch (groupBy) {
    case 'project': return [t.project_name, t.project_name];
    case 'status': return [String(STATUS_ORDER[t.status]), STATUS_LABEL[t.status]];
    case 'priority': return [String(PRIORITY_ORDER[t.priority]), PRIORITY_LABEL[t.priority]];
    case 'due': return dueBucket(t);
    case 'assignee': {
      const u = userById(t.assignee_ids[0]);
      return u ? [u.name, u.name] : ['~', 'Sem responsável'];
    }
    case 'sprint': return t.sprint_name ? [`${t.sprint_status === 'active' ? 0 : 1}${t.sprint_name}`, t.sprint_name] : ['~', 'Backlog'];
    case 'type': return [t.type, TYPE_LABEL[t.type]];
    default: return ['', ''];
  }
}

const SORTS = {
  default: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.sort_rank - b.sort_rank,
  title: (a, b) => a.title.localeCompare(b.title, 'pt-BR'),
  project: (a, b) => a.project_name.localeCompare(b.project_name, 'pt-BR'),
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  priority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  due: (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'),
  time: (a, b) => (a.spent_minutes || 0) - (b.spent_minutes || 0),
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
};

function ordered(tasks) {
  const sorter = (a, b) => (SORTS[sortKey](a, b) || a.id - b.id) * sortDir;
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map();
  for (const t of tasks) {
    if (t.parent_id && ids.has(t.parent_id)) {
      if (!children.has(t.parent_id)) children.set(t.parent_id, []);
      children.get(t.parent_id).push(t);
    }
  }
  const out = [];
  const walk = (t, depth) => {
    out.push({ t, depth });
    (children.get(t.id) || []).sort((a, b) => a.sort_rank - b.sort_rank).forEach((c) => walk(c, depth + 1));
  };
  tasks.filter((t) => !t.parent_id || !ids.has(t.parent_id)).sort(sorter).forEach((t) => walk(t, 0));
  return out;
}

function row({ t, depth }) {
  const due = dueInfo(t, state.today);
  const people = t.assignee_ids.map(userById).filter(Boolean);
  return `
    <tr class="${t.status === 'done' ? 'done' : ''} ${t.id === state.taskId ? 'selected' : ''}" data-id="${t.id}" tabindex="0">
      <td class="c-check"><button class="check-btn ${t.status === 'done' ? 'on' : ''}" data-toggle="${t.id}" aria-label="${t.status === 'done' ? 'Reabrir' : 'Concluir'} #${t.id}">${t.status === 'done' ? ICON.check : ''}</button></td>
      <td class="c-title">
        <div class="title-cell" style="--depth:${depth}">
          ${depth ? `<span class="sub-mark">${ICON.subtask}</span>` : ''}
          ${prioIcon(t.priority)}${typeIcon(t.type)}<span class="tid">#${t.id}</span>
          <span class="t">${esc(t.title)}</span>
          ${t.open_blockers ? `<span class="flag blocked" title="Bloqueada">${ICON.blocked}</span>` : ''}
          ${t.subtask_count ? `<span class="meta-icon">${ICON.subtask}${t.subtask_done}/${t.subtask_count}</span>` : ''}
          ${t.recurrence ? `<span class="flag" title="Recorrente">${ICON.repeat}</span>` : ''}
          ${t.tags.map((tag) => `<span class="chip tag">${esc(tag)}</span>`).join('')}
        </div>
      </td>
      ${state.projectId ? '' : `<td class="c-project"><span class="chip"><span class="dot" style="--c:${projectColor(t)}"></span>${esc(t.project_name)}</span></td>`}
      <td class="c-status"><span class="status-cell">${statusIcon(t.status)}${esc(t.column_name || STATUS_LABEL[t.status])}</span></td>
      <td class="c-people">${people.map((u) => avatar(u, { size: 20 })).join('') || '<span class="muted">—</span>'}</td>
      <td class="c-due">${due ? `<span class="due ${due.cls}" title="${due.title}">${due.text}</span>` : '<span class="muted">—</span>'}</td>
      ${state.projectId ? `<td class="c-sprint">${t.sprint_name ? esc(t.sprint_name) : '<span class="muted">—</span>'}</td>` : ''}
      <td class="c-time ${t.estimate_minutes && t.spent_minutes > t.estimate_minutes ? 'over' : ''}">${t.spent_minutes || t.estimate_minutes ? `${fmtDuration(t.spent_minutes)}${t.estimate_minutes ? ` / ${fmtDuration(t.estimate_minutes)}` : ''}` : '<span class="muted">—</span>'}</td>
      <td class="c-updated muted" title="${t.updated_at}">${ago(t.updated_at)}</td>
    </tr>`;
}

export function renderList(el) {
  const tasks = filteredTasks({ subtasks: 'all' });
  const head = (key, label, cls = '') => `
    <th class="${cls}"><button data-sort="${key}" class="${sortKey === key ? 'on' : ''}">${label}${sortKey === key ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  const cols = 7 + (state.projectId ? 1 : 1);

  let body;
  if (groupBy === 'none') {
    body = ordered(tasks).map(row).join('');
  } else {
    const groups = new Map();
    for (const t of tasks) {
      const [key, label] = groupOf(t);
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key).items.push(t);
    }
    body = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'pt-BR')).map(([key, g]) => `
      <tr class="group-row"><td colspan="${cols}">
        <button data-group="${esc(key)}">${collapsed.has(key) ? ICON.right : ICON.down}<b>${esc(g.label)}</b><span class="count">${g.items.length}</span></button>
      </td></tr>
      ${collapsed.has(key) ? '' : ordered(g.items).map(row).join('')}`).join('');
  }

  el.innerHTML = `
    <div class="list-view">
      <div class="list-tools">
        <label class="inline-field">Agrupar por
          <select id="group-by">${Object.entries(GROUPS).map(([k, l]) => `<option value="${k}" ${k === groupBy ? 'selected' : ''}>${l}</option>`).join('')}</select>
        </label>
        <span class="muted">${tasks.length} ${tasks.length === 1 ? 'tarefa' : 'tarefas'}</span>
        <span class="spacer"></span>
        <button class="btn ghost bordered" data-new>${ICON.plus} Nova tarefa</button>
      </div>
      <div class="table-wrap">
        <table class="task-table">
          <thead><tr>
            <th class="c-check"></th>
            ${head('title', 'Tarefa', 'c-title')}
            ${state.projectId ? '' : head('project', 'Projeto', 'c-project')}
            ${head('status', 'Status', 'c-status')}
            <th class="c-people">Responsáveis</th>
            ${head('due', 'Prazo', 'c-due')}
            ${state.projectId ? '<th class="c-sprint">Sprint</th>' : ''}
            ${head('time', 'Tempo', 'c-time')}
            ${head('updated', 'Atualizada', 'c-updated')}
          </tr></thead>
          <tbody>${body || `<tr><td colspan="${cols}" class="empty-row">Nenhuma tarefa ${state.q || state.prio || state.due ? 'com esses filtros' : 'aqui ainda'}.</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  el.onchange = (e) => {
    if (e.target.id === 'group-by') { groupBy = e.target.value; renderList(el); }
  };
  el.onclick = async (e) => {
    const sort = e.target.closest('[data-sort]');
    if (sort) {
      if (sortKey === sort.dataset.sort) sortDir = -sortDir;
      else { sortKey = sort.dataset.sort; sortDir = 1; }
      return renderList(el);
    }
    const group = e.target.closest('[data-group]');
    if (group) {
      const k = group.dataset.group;
      if (collapsed.has(k)) collapsed.delete(k); else collapsed.add(k);
      return renderList(el);
    }
    if (e.target.closest('[data-new]')) return openNewTask();
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const t = state.tasks.find((x) => x.id === Number(toggle.dataset.toggle));
      await attempt(() => api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: t.status === 'done' ? 'todo' : 'done' } }));
      return load();
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) openTask(Number(tr.dataset.id));
  };
  el.onkeydown = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && e.key === 'Enter') openTask(Number(tr.dataset.id));
  };
}
