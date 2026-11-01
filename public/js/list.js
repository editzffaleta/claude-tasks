// Visão Lista: tabela ordenável e agrupável, com subtarefas aninhadas e ações em lote.
import { api, attempt, toast } from './api.js';
import { tagChip } from './board.js';
import { openTask } from './drawer.js';
import { locale, t, tn } from './i18n.js';
import { can, canWrite, filteredTasks, load, state, userById } from './state.js';
import { openNewTask } from './taskform.js';
import { confirmAction, promptText, showMenu } from './ui.js';
import {
  ICON, PRIORITIES, PRIORITY_LABEL, PRIORITY_ORDER, STATUSES, STATUS_LABEL, TYPE_LABEL, ago, avatar, columnLabel, dueInfo, esc, fmtDuration, fmtNumber,
  prioIcon, projectBadge, statusIcon, taskRef, typeIcon,
} from './util.js';

const STATUS_ORDER = { doing: 0, blocked: 1, todo: 2, done: 3 };
let sortKey = 'default';
let sortDir = 1;
let groupBy = 'none';
const collapsed = new Set();
const selected = new Set();

const GROUPS = /* i18n */ {
  none: 'Sem agrupamento',
  project: 'Projeto',
  status: 'Status',
  priority: 'Prioridade',
  due: 'Prazo',
  assignee: 'Responsável',
  sprint: 'Sprint',
  type: 'Tipo',
  label: 'Label',
};

function dueBucket(x) {
  if (!x.due_date) return ['5', t('Sem prazo')];
  if (x.status !== 'done' && x.overdue) return ['0', t('Atrasadas')];
  if (x.due_date === state.today) return ['1', t('Hoje')];
  const days = (new Date(`${x.due_date}T12:00:00`) - new Date(`${state.today}T12:00:00`)) / 86400000;
  if (days <= 7) return ['2', t('Próximos 7 dias')];
  if (days <= 31) return ['3', t('Próximos 30 dias')];
  return ['4', t('Mais tarde')];
}

function groupOf(x) {
  switch (groupBy) {
    case 'project': return [x.project_name, x.project_name];
    case 'status': return [String(STATUS_ORDER[x.status]), STATUS_LABEL[x.status]];
    case 'priority': return [String(PRIORITY_ORDER[x.priority]), PRIORITY_LABEL[x.priority]];
    case 'due': return dueBucket(x);
    case 'assignee': {
      const u = userById(x.assignee_ids[0]);
      return u ? [u.name, u.name] : ['~', t('Sem responsável')];
    }
    case 'sprint': return x.sprint_name ? [`${x.sprint_status === 'active' ? 0 : 1}${x.sprint_name}`, x.sprint_name] : ['~', t('Backlog')];
    case 'type': return [x.type, TYPE_LABEL[x.type]];
    case 'label': return x.tags[0] ? [x.tags[0].toLowerCase(), x.tags[0]] : ['~', t('Sem label')];
    default: return ['', ''];
  }
}

const SORTS = {
  default: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.sort_rank - b.sort_rank,
  title: (a, b) => a.title.localeCompare(b.title, locale()),
  project: (a, b) => a.project_name.localeCompare(b.project_name, locale()),
  status: (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status],
  priority: (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority],
  due: (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'),
  points: (a, b) => (a.story_points ?? -1) - (b.story_points ?? -1),
  time: (a, b) => (a.spent_minutes || 0) - (b.spent_minutes || 0),
  updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
};

function ordered(tasks) {
  const sorter = (a, b) => (SORTS[sortKey](a, b) || a.id - b.id) * sortDir;
  const ids = new Set(tasks.map((x) => x.id));
  const children = new Map();
  for (const x of tasks) {
    if (x.parent_id && ids.has(x.parent_id)) {
      if (!children.has(x.parent_id)) children.set(x.parent_id, []);
      children.get(x.parent_id).push(x);
    }
  }
  const out = [];
  const walk = (x, depth) => {
    out.push({ x, depth });
    (children.get(x.id) || []).sort((a, b) => a.sort_rank - b.sort_rank).forEach((c) => walk(c, depth + 1));
  };
  tasks.filter((x) => !x.parent_id || !ids.has(x.parent_id)).sort(sorter).forEach((x) => walk(x, 0));
  return out;
}

function row({ x, depth }) {
  const due = dueInfo(x, state.today);
  const people = x.assignee_ids.map(userById).filter(Boolean);
  const editable = can(x.project_id, 'edit');
  const project = { name: x.project_name, color: x.project_color, avatar: state.projects.find((p) => p.id === x.project_id)?.avatar };
  return `
    <tr class="${x.status === 'done' ? 'done' : ''} ${x.id === state.taskId ? 'selected' : ''} ${selected.has(x.id) ? 'picked' : ''}" data-id="${x.id}" tabindex="0">
      <td class="c-pick">${editable ? `<input type="checkbox" data-pick="${x.id}" ${selected.has(x.id) ? 'checked' : ''} aria-label="${esc(t('Selecionar {ref}', { ref: taskRef(x) }))}">` : ''}</td>
      <td class="c-check">${editable ? `<button class="check-btn ${x.status === 'done' ? 'on' : ''}" data-toggle="${x.id}" aria-label="${esc(x.status === 'done' ? t('Reabrir {ref}', { ref: taskRef(x) }) : t('Concluir {ref}', { ref: taskRef(x) }))}">${x.status === 'done' ? ICON.check : ''}</button>` : statusIcon(x.status)}</td>
      <td class="c-title">
        <div class="title-cell" style="--depth:${depth}">
          ${depth ? `<span class="sub-mark">${ICON.subtask}</span>` : ''}
          ${prioIcon(x.priority)}${typeIcon(x.type)}<span class="tid">${esc(taskRef(x))}</span>
          <span class="t">${esc(x.title)}</span>
          ${x.open_blockers ? `<span class="flag blocked" title="${esc(t('Bloqueada'))}">${ICON.blocked}</span>` : ''}
          ${x.subtask_count ? `<span class="meta-icon">${ICON.subtask}${x.subtask_done}/${x.subtask_count}</span>` : ''}
          ${x.recurrence ? `<span class="flag" title="${esc(t('Recorrente'))}">${ICON.repeat}</span>` : ''}
          ${x.tags.map((tag) => tagChip(tag, x.project_id)).join('')}
        </div>
      </td>
      ${state.projectId ? '' : `<td class="c-project"><span class="chip">${projectBadge(project)}${esc(x.project_name)}</span></td>`}
      <td class="c-status"><span class="status-cell">${statusIcon(x.status)}${esc(x.column_name ? columnLabel(x.column_name, x.status) : STATUS_LABEL[x.status])}</span></td>
      <td class="c-people">${people.map((u) => avatar(u, { size: 20 })).join('') || '<span class="muted">—</span>'}</td>
      <td class="c-due">${due ? `<span class="due ${due.cls}" title="${esc(due.title)}">${due.text}</span>` : '<span class="muted">—</span>'}</td>
      ${state.projectId ? `<td class="c-sprint">${x.sprint_name ? esc(x.sprint_name) : '<span class="muted">—</span>'}</td>` : ''}
      <td class="c-points">${x.story_points != null ? fmtNumber(x.story_points) : '<span class="muted">—</span>'}</td>
      <td class="c-time ${x.estimate_minutes && x.spent_minutes > x.estimate_minutes ? 'over' : ''}">${x.spent_minutes || x.estimate_minutes ? `${fmtDuration(x.spent_minutes)}${x.estimate_minutes ? ` / ${fmtDuration(x.estimate_minutes)}` : ''}` : '<span class="muted">—</span>'}</td>
      <td class="c-updated muted" title="${esc(x.updated_at)}">${ago(x.updated_at)}</td>
    </tr>`;
}

function bulkBar(visible) {
  const n = [...selected].filter((id) => visible.has(id)).length;
  if (!n) return '';
  return `
    <div class="bulk-bar" role="toolbar" aria-label="${esc(t('Ações em lote'))}">
      <b>${esc(tn(n, '{n} selecionada', '{n} selecionadas'))}</b>
      <button class="btn ghost small" data-bulk="status">${statusIcon('doing')}${t('Status')}</button>
      <button class="btn ghost small" data-bulk="priority">${prioIcon('high')}${t('Prioridade')}</button>
      <button class="btn ghost small" data-bulk="assign">${ICON.user}${t('Responsável')}</button>
      ${state.projectId ? `<button class="btn ghost small" data-bulk="sprint">${ICON.target}${t('Sprint')}</button>` : ''}
      <button class="btn ghost small" data-bulk="label">${ICON.tag}${t('Label')}</button>
      <button class="btn ghost small" data-bulk="archive">${ICON.archive}${t('Arquivar')}</button>
      <button class="btn ghost small danger" data-bulk="delete">${ICON.trash}${t('Excluir')}</button>
      <span class="spacer"></span>
      <button class="link-btn" data-bulk="clear">${t('Limpar seleção')}</button>
    </div>`;
}

async function bulk(body, success) {
  const ids = [...selected];
  const r = await attempt(() => api('/api/tasks/bulk', { method: 'POST', body: { ids, ...body } }), success);
  if (r) { selected.clear(); await load(); }
}

function bulkMenu(anchor, kind) {
  const ids = [...selected];
  const n = ids.length;
  if (kind === 'clear') { selected.clear(); return renderList(anchor.closest('.view')); }
  if (kind === 'status') {
    return showMenu(anchor, STATUSES.map((s) => ({ label: STATUS_LABEL[s], icon: statusIcon(s), onClick: () => bulk({ patch: { status: s } }, tn(n, '{n} tarefa atualizada', '{n} tarefas atualizadas')) })));
  }
  if (kind === 'priority') {
    return showMenu(anchor, PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], icon: prioIcon(p), onClick: () => bulk({ patch: { priority: p } }, tn(n, '{n} tarefa atualizada', '{n} tarefas atualizadas')) })));
  }
  if (kind === 'assign') {
    return showMenu(anchor, [
      ...state.users.map((u) => ({ label: u.name, icon: avatar(u, { size: 18 }), onClick: () => bulk({ patch: { assignee_ids: [u.id] } }, tn(n, '{n} tarefa atribuída', '{n} tarefas atribuídas')) })),
      { divider: true },
      { label: t('Sem responsável'), icon: ICON.close, onClick: () => bulk({ patch: { assignee_ids: [] } }) },
    ]);
  }
  if (kind === 'sprint') {
    return showMenu(anchor, [
      { label: t('Backlog (sem sprint)'), icon: ICON.list, onClick: () => bulk({ patch: { sprint_id: null } }) },
      ...state.sprints.filter((s) => !['completed', 'cancelled'].includes(s.status)).map((s) => ({ label: s.name, icon: ICON.target, onClick: () => bulk({ patch: { sprint_id: s.id } }) })),
    ]);
  }
  if (kind === 'label') {
    return (async () => {
      const name = await promptText({ title: t('Adicionar label'), label: t('Label'), placeholder: t('ex.: frontend') });
      if (!name) return;
      // Cada tarefa mantém as suas labels e ganha a nova.
      const r = await attempt(async () => {
        for (const id of ids) {
          const x = state.tasks.find((y) => y.id === id);
          if (x && !x.tags.some((g) => g.toLowerCase() === name.toLowerCase())) {
            await api(`/api/tasks/${id}`, { method: 'PATCH', body: { tags: [...x.tags, name] } });
          }
        }
        return true;
      }, t('Label adicionada'));
      if (r) { selected.clear(); await load(); }
    })();
  }
  if (kind === 'archive') return bulk({ patch: { archived: true } }, tn(n, '{n} tarefa arquivada', '{n} tarefas arquivadas'));
  if (kind === 'delete') {
    return confirmAction(tn(n, 'Excluir {n} tarefa? Não dá para desfazer.', 'Excluir {n} tarefas? Não dá para desfazer.'), { title: t('Excluir tarefas'), okLabel: t('Excluir') })
      .then((ok) => ok && bulk({ delete: true }, tn(n, '{n} tarefa excluída', '{n} tarefas excluídas')));
  }
}

export function renderList(el) {
  const tasks = filteredTasks({ subtasks: 'all' });
  const visible = new Set(tasks.map((x) => x.id));
  for (const id of selected) if (!visible.has(id)) selected.delete(id);
  const head = (key, label, cls = '') => `
    <th class="${cls}"><button data-sort="${key}" class="${sortKey === key ? 'on' : ''}">${esc(label)}${sortKey === key ? (sortDir > 0 ? ' ↑' : ' ↓') : ''}</button></th>`;
  const cols = 10;
  const pickable = tasks.filter((x) => can(x.project_id, 'edit'));
  const allPicked = pickable.length && pickable.every((x) => selected.has(x.id));

  let body;
  if (groupBy === 'none') {
    body = ordered(tasks).map(row).join('');
  } else {
    const groups = new Map();
    for (const x of tasks) {
      const [key, label] = groupOf(x);
      if (!groups.has(key)) groups.set(key, { label, items: [] });
      groups.get(key).items.push(x);
    }
    body = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, locale())).map(([key, g]) => `
      <tr class="group-row"><td colspan="${cols}">
        <button data-group="${esc(key)}">${collapsed.has(key) ? ICON.right : ICON.down}<b>${esc(g.label)}</b><span class="count">${g.items.length}</span>
          ${g.items.some((x) => x.story_points) ? `<span class="muted small">${fmtNumber(g.items.reduce((n, x) => n + (x.story_points || 0), 0))} ${t('pts')}</span>` : ''}</button>
      </td></tr>
      ${collapsed.has(key) ? '' : ordered(g.items).map(row).join('')}`).join('');
  }

  const filtered = state.q || state.prio || state.due || state.tag || state.type || state.assignee;
  el.innerHTML = `
    <div class="list-view">
      <div class="list-tools">
        <label class="inline-field">${t('Agrupar por')}
          <select id="group-by">${Object.entries(GROUPS).map(([k, l]) => `<option value="${k}" ${k === groupBy ? 'selected' : ''}>${esc(t(l))}</option>`).join('')}</select>
        </label>
        <span class="muted">${esc(tn(tasks.length, '{n} tarefa', '{n} tarefas'))}</span>
        <span class="spacer"></span>
        <a class="btn ghost bordered" href="/api/export.csv${state.projectId ? `?project=${state.projectId}` : ''}" download>${ICON.download}<span class="hide-sm">${t('Exportar CSV')}</span></a>
        ${canWrite() ? `<button class="btn ghost bordered" data-new>${ICON.plus} ${t('Nova tarefa')}</button>` : ''}
      </div>
      ${bulkBar(visible)}
      <div class="table-wrap">
        <table class="task-table">
          <thead><tr>
            <th class="c-pick">${pickable.length ? `<input type="checkbox" data-pickall ${allPicked ? 'checked' : ''} aria-label="${esc(t('Selecionar todas'))}">` : ''}</th>
            <th class="c-check"></th>
            ${head('title', t('Tarefa'), 'c-title')}
            ${state.projectId ? '' : head('project', t('Projeto'), 'c-project')}
            ${head('status', t('Status'), 'c-status')}
            <th class="c-people">${t('Responsáveis')}</th>
            ${head('due', t('Prazo'), 'c-due')}
            ${state.projectId ? `<th class="c-sprint">${t('Sprint')}</th>` : ''}
            ${head('points', t('Pontos'), 'c-points')}
            ${head('time', t('Tempo'), 'c-time')}
            ${head('updated', t('Atualizada'), 'c-updated')}
          </tr></thead>
          <tbody>${body || `<tr><td colspan="${cols}" class="empty-row">${filtered ? t('Nenhuma tarefa com esses filtros.') : t('Nenhuma tarefa aqui ainda.')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  el.onchange = (e) => {
    if (e.target.id === 'group-by') { groupBy = e.target.value; return renderList(el); }
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const id = Number(pick.dataset.pick);
      if (pick.checked) selected.add(id); else selected.delete(id);
      return renderList(el);
    }
    if (e.target.matches('[data-pickall]')) {
      if (e.target.checked) pickable.forEach((x) => selected.add(x.id)); else selected.clear();
      return renderList(el);
    }
  };
  el.onclick = async (e) => {
    if (e.target.closest('[data-pick], [data-pickall], .c-pick')) return;
    const b = e.target.closest('[data-bulk]');
    if (b) return bulkMenu(b, b.dataset.bulk);
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
      const x = state.tasks.find((y) => y.id === Number(toggle.dataset.toggle));
      await attempt(() => api(`/api/tasks/${x.id}`, { method: 'PATCH', body: { status: x.status === 'done' ? 'todo' : 'done' } }));
      return load();
    }
    const tr = e.target.closest('tr[data-id]');
    if (tr) openTask(Number(tr.dataset.id));
  };
  el.onkeydown = (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (tr && e.key === 'Enter') openTask(Number(tr.dataset.id));
    if (e.key === 'Escape' && selected.size) { selected.clear(); renderList(el); toast(t('Seleção limpa')); }
  };
}
