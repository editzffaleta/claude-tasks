// Visão Quadro (kanban): colunas do projeto (ou as 4 categorias), arrastar entre e dentro das colunas.
import { api, toast } from './api.js';
import { openTask } from './drawer.js';
import { state, filteredTasks, load, userById, currentProject } from './state.js';
import { openNewTask } from './taskform.js';
import {
  $, $$, COLUMN_LABEL, ICON, STATUSES, avatar, dueInfo, esc, fmtDuration, prioIcon, projectColor, statusIcon, typeIcon,
} from './util.js';

let drag = null;
export const boardDragging = () => !!drag;

function boardColumns() {
  if (state.projectId && state.columns) {
    return state.columns.map((c) => ({ key: c.id != null ? `c${c.id}` : c.status, ref: c.id ?? c.status, name: c.name, status: c.status, color: c.color }));
  }
  return STATUSES.map((s) => ({ key: s, ref: s, name: COLUMN_LABEL[s], status: s }));
}

function columnOf(t, cols) {
  if (state.projectId && t.column_id) {
    const c = cols.find((col) => col.key === `c${t.column_id}`);
    if (c) return c.key;
  }
  return cols.find((c) => c.status === t.status)?.key;
}

export function cardHtml(t, { showProject = !state.projectId } = {}) {
  const due = dueInfo(t, state.today);
  const people = t.assignee_ids.map(userById).filter(Boolean);
  const spent = t.spent_minutes || 0;
  const classes = ['card', t.status === 'done' && 'done', t.id === state.taskId && 'selected', t.archived_at && 'archived'].filter(Boolean).join(' ');
  return `
    <article class="${classes}" draggable="true" data-id="${t.id}" tabindex="0">
      <div class="card-top">
        ${prioIcon(t.priority)}${typeIcon(t.type)}<span class="tid">#${t.id}</span>
        ${t.open_blockers ? `<span class="flag blocked" title="Bloqueada por ${t.open_blockers} tarefa(s)">${ICON.blocked}</span>` : ''}
        ${t.timer_running ? `<span class="flag timer" title="Timer rodando">${ICON.clock}</span>` : ''}
        ${t.recurrence ? `<span class="flag" title="Recorrente">${ICON.repeat}</span>` : ''}
        <span class="spacer"></span>
        ${t.source === 'claude' ? `<span class="by claude" title="Criada pelo Claude">${ICON.claude}</span>` : ''}
        ${people.length ? `<span class="avatars">${people.slice(0, 3).map((u) => avatar(u, { size: 18 })).join('')}</span>` : ''}
      </div>
      ${t.parent_id ? `<div class="parent-ref">${ICON.subtask}${esc(t.parent_title || `#${t.parent_id}`)}</div>` : ''}
      <h3>${esc(t.title)}</h3>
      <div class="card-meta">
        ${showProject ? `<span class="chip"><span class="dot" style="--c:${projectColor(t)}"></span>${esc(t.project_name)}</span>` : ''}
        ${due ? `<span class="chip due ${due.cls}" title="${due.title}">${ICON.calendar}${due.text}</span>` : ''}
        ${t.tags.map((tag) => `<span class="chip tag">${esc(tag)}</span>`).join('')}
        ${t.subtask_count ? `<span class="meta-icon ${t.subtask_done === t.subtask_count ? 'complete' : ''}" title="Subtarefas">${ICON.subtask}${t.subtask_done}/${t.subtask_count}</span>` : ''}
        ${t.note_count ? `<span class="meta-icon" title="Comentários">${ICON.comment}${t.note_count}</span>` : ''}
        ${t.attachment_count ? `<span class="meta-icon" title="Anexos">${ICON.clip}${t.attachment_count}</span>` : ''}
        ${spent || t.estimate_minutes ? `<span class="meta-icon ${t.estimate_minutes && spent > t.estimate_minutes ? 'over' : ''}" title="Tempo gasto / estimado">${ICON.clock}${fmtDuration(spent)}${t.estimate_minutes ? `/${fmtDuration(t.estimate_minutes)}` : ''}</span>` : ''}
      </div>
    </article>`;
}

export function renderBoard(el) {
  if (!state.projects.length) {
    el.innerHTML = `
      <div class="welcome">
        <h2>O quadro está vazio</h2>
        <p>Quando o Claude deixar algo pendente em qualquer projeto, a tarefa aparece aqui sozinha.
        Você também pode pedir numa sessão: <code>anota isso no quadro de tarefas</code>.</p>
        <button class="btn primary" data-new>${ICON.plus} Criar a primeira tarefa</button>
      </div>`;
    el.onclick = (e) => { if (e.target.closest('[data-new]')) openNewTask(); };
    return;
  }
  const cols = boardColumns();
  const tasks = filteredTasks();
  const buckets = Object.fromEntries(cols.map((c) => [c.key, []]));
  for (const t of tasks) buckets[columnOf(t, cols)]?.push(t);
  const filtered = state.q || state.prio || state.type || state.assignee || state.due;

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
              <button class="icon-btn" data-add="${col.ref}" title="Nova tarefa em “${esc(col.name)}”" aria-label="Nova tarefa em ${esc(col.name)}">${ICON.plus}</button>
            </div>
            <div class="cards">${list.map((t) => cardHtml(t)).join('') || `<div class="empty-col">${filtered ? 'Nada com esse filtro' : 'Nada aqui'}</div>`}</div>
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
    drag = { id: Number(card.dataset.id) };
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.dataset.id);
  };
  el.ondragend = () => {
    $$('.dragging, .drop', el).forEach((n) => n.classList.remove('dragging', 'drop'));
    $$('.drop-line', el).forEach((n) => n.remove());
    drag = null;
    if (state.pendingRender) { state.pendingRender = false; renderBoard(el); }
  };
  el.ondragover = (e) => {
    const col = e.target.closest('.column');
    if (!col || !drag) return;
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
    const id = drag.id;
    const index = dropIndex(col, e.clientY);
    drag = null;
    moveCard(el, id, cols, cols.find((c) => c.key === col.dataset.key), buckets[col.dataset.key], index);
  };
}

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
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  const siblings = list.filter((t) => t.id !== id);
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
    if (patch.status === 'done' || col.status === 'done') toast(`#${id} concluída`);
  } catch (e) {
    toast(e.message, true);
  }
  load();
}

// Usado quando o projeto atual mudou de colunas e precisa de rótulo (lista, detalhe).
export const columnName = (t) => (state.projectId && currentProject() && t.column_name) || COLUMN_LABEL[t.status];
