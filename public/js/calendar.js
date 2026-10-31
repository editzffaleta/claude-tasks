// Visão Calendário: mês com as tarefas no dia do prazo. Arraste para remarcar;
// arraste da lista "Sem prazo" para agendar; clique num dia para criar.
import { api, toast } from './api.js';
import { openTask } from './drawer.js';
import { floatingPanel, closePanel } from './shell.js';
import { state, filteredTasks, load } from './state.js';
import { openNewTask } from './taskform.js';
import { $$, ICON, MONTHS_LONG, WEEKDAYS, addDays, daysBetween, esc, localDate, prioIcon, projectColor, toDate } from './util.js';

const MAX_PER_DAY = 4;
let cursor = null; // 'AAAA-MM'
let dragId = null;

function chip(t) {
  return `
    <button class="cal-chip ${t.status === 'done' ? 'done' : ''} ${t.overdue ? 'overdue' : ''}" draggable="true" data-id="${t.id}"
      style="--c:${projectColor(t)}" title="#${t.id} ${esc(t.title)} · ${esc(t.project_name)}">
      ${prioIcon(t.priority)}<span>${esc(t.title)}</span>
    </button>`;
}

export function renderCalendar(el) {
  if (!cursor) cursor = state.today.slice(0, 7);
  const [y, m] = cursor.split('-').map(Number);
  const first = `${cursor}-01`;
  const start = addDays(first, -toDate(first).getDay());
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const tasks = filteredTasks({ subtasks: 'all' });
  const byDay = new Map();
  for (const t of tasks) {
    if (!t.due_date) continue;
    if (!byDay.has(t.due_date)) byDay.set(t.due_date, []);
    byDay.get(t.due_date).push(t);
  }
  const undated = tasks.filter((t) => !t.due_date && t.status !== 'done');

  el.innerHTML = `
    <div class="calendar-view">
      <div class="cal-main">
        <div class="cal-head">
          <button class="icon-btn" data-nav="-1" aria-label="Mês anterior">${ICON.left}</button>
          <h2>${MONTHS_LONG[m - 1]} <span class="muted">${y}</span></h2>
          <button class="icon-btn" data-nav="1" aria-label="Próximo mês">${ICON.right}</button>
          <button class="btn ghost bordered small" data-nav="today">Hoje</button>
        </div>
        <div class="cal-grid">
          ${WEEKDAYS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}
          ${days.map((d) => {
            const list = (byDay.get(d) || []).sort((a, b) => (a.status === 'done') - (b.status === 'done') || a.sort_rank - b.sort_rank);
            const out = d.slice(0, 7) !== cursor;
            const weekend = [0, 6].includes(toDate(d).getDay());
            return `
              <div class="cal-day ${out ? 'out' : ''} ${d === state.today ? 'today' : ''} ${weekend ? 'weekend' : ''}" data-day="${d}">
                <div class="cal-date"><span>${Number(d.slice(8))}</span><button class="icon-btn tiny add" data-add="${d}" aria-label="Nova tarefa em ${d}">${ICON.plus}</button></div>
                ${list.slice(0, MAX_PER_DAY).map(chip).join('')}
                ${list.length > MAX_PER_DAY ? `<button class="cal-more" data-more="${d}">+${list.length - MAX_PER_DAY} mais</button>` : ''}
              </div>`;
          }).join('')}
        </div>
      </div>
      <aside class="cal-side">
        <h3>Sem prazo <span class="count">${undated.length}</span></h3>
        <p class="hint">Arraste para um dia para definir o prazo.</p>
        <div class="cal-undated">${undated.map(chip).join('') || '<div class="empty-small">Tudo com prazo.</div>'}</div>
      </aside>
    </div>`;

  el.onclick = (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      if (nav.dataset.nav === 'today') cursor = state.today.slice(0, 7);
      else {
        const d = new Date(y, m - 1 + Number(nav.dataset.nav), 1, 12);
        cursor = localDate(d).slice(0, 7);
      }
      return renderCalendar(el);
    }
    const more = e.target.closest('[data-more]');
    if (more) {
      const list = byDay.get(more.dataset.more);
      const panel = floatingPanel(more, `<div class="panel-head"><b>${more.dataset.more.split('-').reverse().join('/')}</b></div><div class="cal-more-list">${list.map(chip).join('')}</div>`, { width: 280 });
      panel.onclick = (ev) => { const c = ev.target.closest('[data-id]'); if (c) { closePanel(); openTask(Number(c.dataset.id)); } };
      return;
    }
    const c = e.target.closest('.cal-chip');
    if (c) return openTask(Number(c.dataset.id));
    const add = e.target.closest('[data-add]');
    const day = e.target.closest('.cal-day');
    if (add || (day && e.target === day)) openNewTask({ due_date: (add || day).dataset.add || day.dataset.day });
  };
  el.ondragstart = (e) => {
    const c = e.target.closest('.cal-chip');
    if (!c) return;
    dragId = Number(c.dataset.id);
    c.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.dataset.id);
  };
  el.ondragend = () => {
    dragId = null;
    $$('.dragging, .drop', el).forEach((n) => n.classList.remove('dragging', 'drop'));
  };
  el.ondragover = (e) => {
    const day = e.target.closest('.cal-day');
    if (!day || !dragId) return;
    e.preventDefault();
    $$('.cal-day.drop', el).forEach((d) => d !== day && d.classList.remove('drop'));
    day.classList.add('drop');
  };
  el.ondrop = async (e) => {
    const day = e.target.closest('.cal-day');
    if (!day || !dragId) return;
    e.preventDefault();
    const t = state.tasks.find((x) => x.id === dragId);
    dragId = null;
    const due = day.dataset.day;
    if (!t || t.due_date === due) return renderCalendar(el);
    const patch = { due_date: due };
    // Mantém a duração quando a tarefa tem início.
    if (t.start_date && t.due_date) patch.start_date = addDays(t.start_date, daysBetween(t.due_date, due));
    else if (t.start_date && t.start_date > due) patch.start_date = due;
    Object.assign(t, patch);
    renderCalendar(el);
    try {
      await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: patch });
    } catch (err) {
      toast(err.message, true);
    }
    load();
  };
}
