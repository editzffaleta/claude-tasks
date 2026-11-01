// Visão Quadro (kanban): colunas do projeto (ou as 4 categorias), arrastar entre e dentro das colunas.
import { api, toast } from './api.js';
import { openTask } from './drawer.js';
import { t, tn } from './i18n.js';
import { state, filteredTasks, load, userById, currentProject, can, canWrite, labelFor } from './state.js';
import { openNewTask } from './taskform.js';
import {
  $, $$, COLUMN_LABEL, ICON, STATUSES, avatar, columnLabel, dueInfo, esc, fmtDuration, fmtNumber, prioIcon, projectBadge, statusIcon, taskRef, typeIcon,
} from './util.js';

let drag = null;
export const boardDragging = () => !!drag;

function boardColumns() {
  if (state.projectId && state.columns) {
    return state.columns.map((c) => ({ key: c.id != null ? `c${c.id}` : c.status, ref: c.id ?? c.status, name: columnLabel(c.name, c.status), status: c.status, color: c.color }));
  }
  return STATUSES.map((s) => ({ key: s, ref: s, name: COLUMN_LABEL[s], status: s }));
}

function columnOf(task, cols) {
  if (state.projectId && task.column_id) {
    const c = cols.find((col) => col.key === `c${task.column_id}`);
    if (c) return c.key;
  }
  return cols.find((c) => c.status === task.status)?.key;
}

// Label colorida (cor da label cadastrada; sem cadastro, chip neutro).
export function tagChip(tag, project_id) {
  const l = labelFor(tag, project_id);
  return `<span class="chip tag ${l?.color ? 'colored' : ''}" ${l?.color ? `style="--c:${esc(l.color)}"` : ''}>${esc(tag)}</span>`;
}

export function cardHtml(x, { showProject = !state.projectId } = {}) {
  const due = dueInfo(x, state.today);
  const people = x.assignee_ids.map(userById).filter(Boolean);
  const spent = x.spent_minutes || 0;
  const classes = ['card', x.status === 'done' && 'done', x.id === state.taskId && 'selected', x.archived_at && 'archived'].filter(Boolean).join(' ');
  const project = { name: x.project_name, color: x.project_color, avatar: state.projects.find((p) => p.id === x.project_id)?.avatar };
  return `
    <article class="${classes}" draggable="${can(x.project_id, 'edit')}" data-id="${x.id}" tabindex="0">
      <div class="card-top">
        ${prioIcon(x.priority)}${typeIcon(x.type)}<span class="tid">${esc(taskRef(x))}</span>
        ${x.open_blockers ? `<span class="flag blocked" title="${esc(tn(x.open_blockers, 'Bloqueada por {n} tarefa', 'Bloqueada por {n} tarefas'))}">${ICON.blocked}</span>` : ''}
        ${x.timer_running ? `<span class="flag timer" title="${esc(t('Timer rodando'))}">${ICON.clock}</span>` : ''}
        ${x.recurrence ? `<span class="flag" title="${esc(t('Recorrente'))}">${ICON.repeat}</span>` : ''}
        <span class="spacer"></span>
        ${x.source === 'claude' ? `<span class="by claude" title="${esc(t('Criada pelo Claude'))}">${ICON.claude}</span>` : ''}
        ${x.source === 'e-mail' ? `<span class="by" title="${esc(t('Criada por e-mail'))}">${ICON.mail}</span>` : ''}
        ${people.length ? `<span class="avatars">${people.slice(0, 3).map((u) => avatar(u, { size: 18 })).join('')}</span>` : ''}
      </div>
      ${x.parent_id ? `<div class="parent-ref">${ICON.subtask}${esc(x.parent_title || `#${x.parent_id}`)}</div>` : ''}
      <h3>${esc(x.title)}</h3>
      <div class="card-meta">
        ${showProject ? `<span class="chip">${projectBadge(project)}${esc(x.project_name)}</span>` : ''}
        ${due ? `<span class="chip due ${due.cls}" title="${esc(due.title)}">${ICON.calendar}${due.text}</span>` : ''}
        ${x.story_points != null ? `<span class="chip points" title="${esc(t('Story points'))}">${fmtNumber(x.story_points)} ${t('pts')}</span>` : ''}
        ${x.tags.map((tag) => tagChip(tag, x.project_id)).join('')}
        ${x.subtask_count ? `<span class="meta-icon ${x.subtask_done === x.subtask_count ? 'complete' : ''}" title="${esc(t('Subtarefas'))}">${ICON.subtask}${x.subtask_done}/${x.subtask_count}</span>` : ''}
        ${x.note_count ? `<span class="meta-icon" title="${esc(t('Comentários'))}">${ICON.comment}${x.note_count}</span>` : ''}
        ${x.attachment_count ? `<span class="meta-icon" title="${esc(t('Anexos'))}">${ICON.clip}${x.attachment_count}</span>` : ''}
        ${spent || x.estimate_minutes ? `<span class="meta-icon ${x.estimate_minutes && spent > x.estimate_minutes ? 'over' : ''}" title="${esc(t('Tempo gasto / estimado'))}">${ICON.clock}${fmtDuration(spent)}${x.estimate_minutes ? `/${fmtDuration(x.estimate_minutes)}` : ''}</span>` : ''}
      </div>
    </article>`;
}

// Fluxo do projeto: para quais colunas a tarefa pode ir (null = qualquer uma).
function allowedTargets(task, cols) {
  if (!state.projectId || !state.transitions?.length) return null;
  const from = task.column_id ?? state.columns?.find((c) => c.status === task.status)?.id;
  const ok = new Set([`c${from}`]);
  for (const r of state.transitions) if (r.from_column_id === from) ok.add(`c${r.to_column_id}`);
  return new Set(cols.filter((c) => ok.has(c.key)).map((c) => c.key));
}

export function renderBoard(el) {
  if (!state.projects.length) {
    el.innerHTML = `
      <div class="welcome">
        <h2>${t('O quadro está vazio')}</h2>
        <p>${t('Quando o Claude deixar algo pendente em qualquer projeto, a tarefa aparece aqui sozinha. Você também pode pedir numa sessão:')} <code>${t('anota isso no quadro de tarefas')}</code>.</p>
        ${canWrite() ? `<button class="btn primary" data-new>${ICON.plus} ${t('Criar a primeira tarefa')}</button>` : ''}
      </div>`;
    el.onclick = (e) => { if (e.target.closest('[data-new]')) openNewTask(); };
    return;
  }
  const cols = boardColumns();
  const tasks = filteredTasks();
  const buckets = Object.fromEntries(cols.map((c) => [c.key, []]));
  for (const x of tasks) buckets[columnOf(x, cols)]?.push(x);
  const filtered = state.q || state.prio || state.type || state.assignee || state.due || state.tag;
  const writer = canWrite();

  const scroll = Object.fromEntries($$('.column', el).map((c) => [c.dataset.key, $('.cards', c).scrollTop]));
  const scrollLeft = $('.board', el)?.scrollLeft || 0;
  const first = !$('.board', el);
  el.innerHTML = `
    <div class="board ${first ? 'animate' : ''}" style="--cols:${cols.length}">
      ${cols.map((col) => {
        const list = buckets[col.key];
        return `
          <div class="column" data-key="${col.key}" data-ref="${col.ref}" data-status="${col.status}">
            <div class="column-head">
              ${statusIcon(col.status)}<h2>${esc(col.name)}</h2><span class="count">${list.length}</span>
              ${points(list) ? `<span class="col-points" title="${esc(t('Story points'))}">${fmtNumber(points(list))} ${t('pts')}</span>` : ''}
              ${writer ? `<button class="icon-btn" data-add="${col.ref}" title="${esc(t('Nova tarefa em “{name}”', { name: col.name }))}" aria-label="${esc(t('Nova tarefa em “{name}”', { name: col.name }))}">${ICON.plus}</button>` : ''}
            </div>
            <div class="cards">${list.map((x) => cardHtml(x)).join('') || `<div class="empty-col">${filtered ? t('Nada com esse filtro') : t('Nada aqui')}</div>`}</div>
          </div>`;
      }).join('')}
    </div>`;
  $$('.column', el).forEach((c) => { $('.cards', c).scrollTop = scroll[c.dataset.key] || 0; });
  $('.board', el).scrollLeft = scrollLeft;

  el.onclick = (e) => {
    const add = e.target.closest('[data-add]');
    if (add) {
      const col = cols.find((c) => String(c.ref) === add.dataset.add);
      return openNewTask({ status: col.status === 'done' ? 'todo' : col.status, column: state.projectId ? col.ref : undefined });
    }
    const card = e.target.closest('.card');
    if (card) openTask(Number(card.dataset.id));
  };
  el.onkeydown = (e) => {
    const card = e.target.closest('.card');
    if (card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openTask(Number(card.dataset.id)); }
  };
  el.ondragstart = (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    const task = state.tasks.find((x) => x.id === Number(card.dataset.id));
    if (!task || !can(task.project_id, 'edit')) return e.preventDefault();
    drag = { id: task.id, allowed: allowedTargets(task, cols) };
    if (drag.allowed) $$('.column', el).forEach((c) => c.classList.toggle('no-drop', !drag.allowed.has(c.dataset.key)));
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
  };
  el.ondragend = () => {
    $$('.dragging, .drop, .no-drop', el).forEach((n) => n.classList.remove('dragging', 'drop', 'no-drop'));
    $$('.drop-line', el).forEach((n) => n.remove());
    drag = null;
    if (state.pendingRender) { state.pendingRender = false; renderBoard(el); }
  };
  el.ondragover = (e) => {
    const col = e.target.closest('.column');
    if (!col || !drag || drag.allowed?.has(col.dataset.key) === false) return;
    e.preventDefault();
    $$('.column.drop', el).forEach((c) => c !== col && c.classList.remove('drop'));
    col.classList.add('drop');
    placeLine(col, e.clientY);
  };
  el.ondragleave = (e) => {
    const col = e.target.closest('.column');
    if (col && !col.contains(e.relatedTarget)) {
      col.classList.remove('drop');
      $('.drop-line', col)?.remove();
    }
  };
  el.ondrop = (e) => {
    const col = e.target.closest('.column');
    if (!col || !drag) return;
    e.preventDefault();
    if (drag.allowed?.has(col.dataset.key) === false) { drag = null; return toast(t('O fluxo deste projeto não permite mover para essa coluna'), true); }
    const id = drag.id;
    const index = dropIndex(col, e.clientY);
    drag = null;
    moveCard(el, id, cols, cols.find((c) => c.key === col.dataset.key), buckets[col.dataset.key], index);
  };
}

const points = (list) => list.reduce((n, x) => n + (x.story_points || 0), 0);

function cardsIn(col) {
  return $$('.card:not(.dragging)', col);
}

function dropIndex(col, y) {
  const cards = cardsIn(col);
  const i = cards.findIndex((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
  return i < 0 ? cards.length : i;
}

function placeLine(col, y) {
  const box = $('.cards', col);
  let line = $('.drop-line', box);
  if (!line) {
    $$('.drop-line').forEach((n) => n.remove());
    line = document.createElement('div');
    line.className = 'drop-line';
  }
  const cards = cardsIn(col);
  const i = dropIndex(col, y);
  if (cards[i]) cards[i].before(line); else box.append(line);
}

async function moveCard(el, id, cols, col, list, index) {
  const task = state.tasks.find((x) => x.id === id);
  if (!task) return;
  const siblings = list.filter((x) => x.id !== id);
  const patch = {};
  const sameColumn = columnOf(task, cols) === col.key;
  if (state.projectId && !sameColumn) patch.column = col.ref;
  else if (!state.projectId && task.status !== col.status) patch.status = col.status;
  // Ordem manual (a coluna Concluídas é ordenada por data de conclusão).
  if (col.status !== 'done') {
    const prev = siblings[index - 1]?.sort_rank;
    const next = siblings[index]?.sort_rank;
    const rank = prev != null && next != null ? (prev + next) / 2 : prev != null ? prev + 1000 : next != null ? next - 1000 : undefined;
    if (rank !== undefined && Math.abs(rank - task.sort_rank) > 1e-6) patch.rank = rank;
  }
  if (!Object.keys(patch).length) return renderBoard(el);

  Object.assign(task, { status: col.status, column_id: state.projectId && typeof col.ref === 'number' ? col.ref : null });
  if (patch.rank !== undefined) task.sort_rank = patch.rank;
  state.tasks.sort((a, b) => a.sort_rank - b.sort_rank);
  renderBoard(el);
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: patch });
    if (patch.status === 'done' || col.status === 'done') toast(t('{ref} concluída', { ref: taskRef(task) }));
  } catch (e) {
    toast(e.message, true);
  }
  load();
}

// Usado quando o projeto atual mudou de colunas e precisa de rótulo (lista, detalhe).
export const columnName = (task) => (state.projectId && currentProject() && task.column_name ? columnLabel(task.column_name, task.status) : COLUMN_LABEL[task.status]);
