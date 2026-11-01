// Visão Gantt: barras do início ao prazo, setas de dependência, arrastar para mover/redimensionar.
import { api, toast } from './api.js';
import { openTask } from './drawer.js';
import { state, filteredTasks, load } from './state.js';
import { $, monthNamesLong, addDays, daysBetween, esc, fmtDate, projectColor, statusIcon, toDate, DEPENDENCY_LABEL, taskRef } from './util.js';
import { locale, t } from './i18n.js';

const ZOOM = { day: 34, week: 14, month: 5 };
const ROW_H = 34;
const labelWidth = () => (innerWidth <= 820 ? 170 : 300);
let zoom = 'day';
let lastRange = null;

const span = (task) => {
  const s = task.start_date || task.due_date;
  const e = task.due_date || task.start_date;
  return s <= e ? [s, e] : [e, s];
};
const ZOOMS = /* i18n */ { day: 'Dias', week: 'Semanas', month: 'Meses' };

function buildRows(tasks) {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map();
  for (const t of tasks) if (t.parent_id && ids.has(t.parent_id)) {
    if (!children.has(t.parent_id)) children.set(t.parent_id, []);
    children.get(t.parent_id).push(t);
  }
  const byStart = (a, b) => span(a)[0].localeCompare(span(b)[0]) || a.id - b.id;
  const rows = [];
  const walk = (t, depth) => {
    rows.push({ t, depth });
    (children.get(t.id) || []).sort(byStart).forEach((c) => walk(c, depth + 1));
  };
  const roots = tasks.filter((t) => !t.parent_id || !ids.has(t.parent_id)).sort(byStart);
  if (state.projectId) roots.forEach((t) => walk(t, 0));
  else {
    const groups = Map.groupBy(roots, (t) => t.project_id);
    for (const list of groups.values()) {
      rows.push({ group: list[0] });
      list.forEach((t) => walk(t, 0));
    }
  }
  return rows;
}

function scale(min, total, px) {
  const dayMonth = new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'numeric' });
  const months = [];
  const days = [];
  for (let i = 0; i < total; i++) {
    const d = addDays(min, i);
    const date = toDate(d);
    if (i === 0 || date.getDate() === 1) months.push({ i, label: `${monthNamesLong()[date.getMonth()]} ${date.getFullYear()}` });
    if (zoom === 'day') days.push(`<div class="g-tick ${[0, 6].includes(date.getDay()) ? 'weekend' : ''} ${d === state.today ? 'today' : ''}" style="left:${i * px}px;width:${px}px">${date.getDate()}</div>`);
    else if (zoom === 'week' && date.getDay() === 1) days.push(`<div class="g-tick" style="left:${i * px}px;width:${7 * px}px">${dayMonth.format(date)}</div>`);
  }
  return `
    <div class="g-months">${months.map((m, k) => `<div class="g-month" style="left:${m.i * px}px;width:${((months[k + 1]?.i ?? total) - m.i) * px}px">${m.label}</div>`).join('')}</div>
    <div class="g-days">${days.join('')}</div>`;
}

function barHtml(task, min, px) {
  const [s, e] = span(task);
  const left = daysBetween(min, s) * px;
  const milestone = !task.start_date && task.due_date;
  if (milestone) {
    return `<div class="g-bar milestone ${task.status} ${task.overdue ? 'overdue' : ''}" data-id="${task.id}" style="left:${left + px / 2 - 8}px;--c:${projectColor(task)}" title="#${task.id} ${esc(task.title)} · ${esc(t('prazo {d}', { d: fmtDate(task.due_date) }))}"></div>
      <span class="g-bar-label outside" style="left:${left + px / 2 + 12}px">${esc(task.title)}</span>`;
  }
  const width = Math.max(px, (daysBetween(s, e) + 1) * px) - 4;
  const progress = task.subtask_count ? task.subtask_done / task.subtask_count : task.status === 'done' ? 1 : 0;
  const inside = width > 90;
  return `
    <div class="g-bar ${task.status} ${task.overdue ? 'overdue' : ''}" data-id="${task.id}" style="left:${left + 2}px;width:${width}px;--c:${projectColor(task)};--p:${progress}"
      title="#${task.id} ${esc(task.title)} · ${fmtDate(s)} → ${fmtDate(e)}">
      <span class="h-left"></span>${inside ? `<span class="g-bar-label">${esc(task.title)}</span>` : ''}<span class="h-right"></span>
    </div>
    ${inside ? '' : `<span class="g-bar-label outside" style="left:${left + width + 8}px">${esc(task.title)}</span>`}`;
}

function arrows(rows, min, px) {
  const index = new Map();
  rows.forEach((r, i) => { if (r.t) index.set(r.t.id, i); });
  const paths = [];
  for (const { task_id: to, blocked_by: from, type = 'finish_start' } of state.dependencies || []) {
    if (!index.has(to) || !index.has(from)) continue;
    const a = rows[index.get(from)].t;
    const b = rows[index.get(to)].t;
    // Tipo da dependência: de qual ponta da barra A sai a seta e em qual ponta da B ela chega.
    const fromEnd = type === 'finish_start' || type === 'finish_finish';
    const toStart = type === 'finish_start' || type === 'start_start';
    const ax = fromEnd ? span(a)[1] : span(a)[0];
    const bx = toStart ? span(b)[0] : span(b)[1];
    const x1 = fromEnd ? (daysBetween(min, ax) + 1) * px - 2 : daysBetween(min, ax) * px + 2;
    const x2 = toStart ? daysBetween(min, bx) * px + 2 : (daysBetween(min, bx) + 1) * px - 2;
    const y1 = index.get(from) * ROW_H + ROW_H / 2;
    const y2 = index.get(to) * ROW_H + ROW_H / 2;
    const late = (type === 'finish_start' ? bx <= ax : bx < ax) && b.status !== 'done';
    const out = fromEnd ? 8 : -8;
    const d = (toStart ? x2 - x1 >= 16 : x2 - x1 <= -16)
      ? `M${x1} ${y1} H${x1 + out} V${y2} H${x2}`
      : `M${x1} ${y1} H${x1 + out} V${(y1 + y2) / 2} H${x2 + (toStart ? -10 : 10)} V${y2} H${x2}`;
    const label = `${taskRef(a)} → ${taskRef(b)} · ${DEPENDENCY_LABEL[type]}${late ? ` (${t('datas conflitantes')})` : ''}`;
    paths.push(`<path class="${late ? 'late' : ''}" d="${d}" marker-end="url(#arrow${late ? '-late' : ''})"><title>${esc(label)}</title></path>`);
  }
  return paths.join('');
}

export function renderGantt(el) {
  const tasks = filteredTasks({ subtasks: 'all' });
  const dated = tasks.filter((x) => x.start_date || x.due_date);
  const undated = tasks.filter((x) => !x.start_date && !x.due_date && x.status !== 'done');
  let min = addDays(state.today, -7);
  let max = addDays(state.today, 42);
  for (const x of dated) {
    const [s, e] = span(x);
    if (s < min) min = s;
    if (e > max) max = e;
  }
  min = addDays(min, -3);
  max = addDays(max, 10);
  const LABEL_W = labelWidth();
  const px = ZOOM[zoom];
  const total = daysBetween(min, max) + 1;
  const width = total * px;
  const rows = buildRows(dated);
  const todayX = daysBetween(min, state.today) * px;
  const weekends = zoom === 'day'
    ? Array.from({ length: total }, (_, i) => i).filter((i) => [0, 6].includes(toDate(addDays(min, i)).getDay()))
      .map((i) => `<div class="g-weekend" style="left:${i * px}px;width:${px}px"></div>`).join('')
    : '';

  const prevScroll = $('.gantt-scroll', el);
  const keep = prevScroll && lastRange === `${min}|${zoom}` ? { left: prevScroll.scrollLeft, top: prevScroll.scrollTop } : null;
  lastRange = `${min}|${zoom}`;

  el.innerHTML = `
    <div class="gantt-view">
      <div class="gantt-tools">
        <div class="seg" role="group" aria-label="${esc(t('Zoom'))}">
          ${Object.entries(ZOOMS).map(([k, l]) => `<button data-zoom="${k}" class="${zoom === k ? 'on' : ''}">${esc(t(l))}</button>`).join('')}
        </div>
        <button class="btn ghost bordered small" data-today>${t('Hoje')}</button>
        <span class="hint">${t('Arraste uma barra para mover, as bordas para mudar início ou prazo. Setas mostram dependências.')}</span>
      </div>
      <div class="gantt-scroll">
        <div class="gantt" style="width:${LABEL_W + width}px;--lw:${LABEL_W}px">
          <div class="g-head">
            <div class="g-corner">${t('Tarefa')}</div>
            <div class="g-scale" style="width:${width}px">${scale(min, total, px)}</div>
          </div>
          <div class="g-body" style="height:${rows.length * ROW_H}px">
            <div class="g-layer" style="left:${LABEL_W}px;width:${width}px">
              ${weekends}
              <div class="g-today" style="left:${todayX + px / 2}px" title="${esc(t('Hoje'))}"></div>
              <svg class="g-arrows" width="${width}" height="${rows.length * ROW_H}">
                <defs>
                  <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z"/></marker>
                  <marker id="arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L8 4L0 8z"/></marker>
                </defs>
                ${arrows(rows, min, px)}
              </svg>
            </div>
            ${rows.map((r) => (r.group ? `
              <div class="g-row group"><div class="g-label"><span class="dot" style="--c:${projectColor(r.group)}"></span><b>${esc(r.group.project_name)}</b></div><div class="g-track"></div></div>`
              : `
              <div class="g-row ${r.t.id === state.taskId ? 'selected' : ''}" data-row="${r.t.id}">
                <div class="g-label" style="--depth:${r.depth}" data-open="${r.t.id}">
                  ${statusIcon(r.t.status)}<span class="tid">${esc(taskRef(r.t))}</span><span class="t">${esc(r.t.title)}</span>
                </div>
                <div class="g-track" style="width:${width}px">${barHtml(r.t, min, px)}</div>
              </div>`)).join('')}
            ${rows.length ? '' : `<div class="g-empty">${t('Nenhuma tarefa com datas. Defina início ou prazo nas tarefas, ou clique numa linha abaixo.')}</div>`}
          </div>
        </div>
      </div>
      ${undated.length ? `
        <details class="g-undated" ${rows.length ? '' : 'open'}>
          <summary>${t('Sem datas')} <span class="count">${undated.length}</span> <span class="hint">${t('clique num dia da linha para agendar')}</span></summary>
          <div class="gantt-scroll-mini">
            <div class="gantt" style="width:${LABEL_W + width}px;--lw:${LABEL_W}px">
              ${undated.slice(0, 60).map((x) => `
                <div class="g-row" data-row="${x.id}">
                  <div class="g-label" data-open="${x.id}">${statusIcon(x.status)}<span class="tid">${esc(taskRef(x))}</span><span class="t">${esc(x.title)}</span></div>
                  <div class="g-track schedulable" data-schedule="${x.id}" style="width:${width}px"></div>
                </div>`).join('')}
            </div>
          </div>
        </details>` : ''}
    </div>`;

  const scroller = $('.gantt-scroll', el);
  const mini = $('.gantt-scroll-mini', el);
  if (keep) Object.assign(scroller, { scrollLeft: keep.left, scrollTop: keep.top });
  else scroller.scrollLeft = Math.max(0, todayX - 160);
  if (mini) {
    mini.scrollLeft = scroller.scrollLeft;
    scroller.onscroll = () => { mini.scrollLeft = scroller.scrollLeft; };
    mini.onscroll = () => { scroller.scrollLeft = mini.scrollLeft; };
  }

  el.onclick = async (e) => {
    const z = e.target.closest('[data-zoom]');
    if (z) { zoom = z.dataset.zoom; return renderGantt(el); }
    if (e.target.closest('[data-today]')) { scroller.scrollLeft = Math.max(0, todayX - 160); return; }
    const open = e.target.closest('[data-open]');
    if (open) return openTask(Number(open.dataset.open));
    const sched = e.target.closest('[data-schedule]');
    if (sched) {
      const day = addDays(min, Math.floor((e.clientX - sched.getBoundingClientRect().left) / px));
      await save(Number(sched.dataset.schedule), { start_date: day, due_date: addDays(day, 2) });
    }
  };

  el.onpointerdown = (e) => {
    const bar = e.target.closest('.g-bar');
    if (!bar || e.button !== 0) return;
    const task = state.tasks.find((x) => x.id === Number(bar.dataset.id));
    const milestone = !task.start_date;
    const mode = milestone ? 'move' : e.target.closest('.h-left') ? 'start' : e.target.closest('.h-right') ? 'end' : 'move';
    const [s0, e0] = span(task);
    const x0 = e.clientX;
    let delta = 0;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('dragging');
    const left0 = parseFloat(bar.style.left);
    const width0 = parseFloat(bar.style.width) || 0;
    const tip = document.createElement('div');
    tip.className = 'g-tip';
    bar.parentElement.append(tip);
    const dates = () => {
      let s = s0;
      let en = e0;
      if (mode === 'move') { s = addDays(s0, delta); en = addDays(e0, delta); }
      if (mode === 'start') s = addDays(s0, Math.min(delta, daysBetween(s0, e0)));
      if (mode === 'end') en = addDays(e0, Math.max(delta, -daysBetween(s0, e0)));
      return [s, en];
    };
    bar.onpointermove = (ev) => {
      delta = Math.round((ev.clientX - x0) / px);
      const [s, en] = dates();
      if (mode === 'move') bar.style.left = `${left0 + delta * px}px`;
      if (mode === 'start') { const d = daysBetween(s0, s); bar.style.left = `${left0 + d * px}px`; bar.style.width = `${width0 - d * px}px`; }
      if (mode === 'end') bar.style.width = `${width0 + daysBetween(e0, en) * px}px`;
      tip.textContent = milestone ? t('Prazo {d}', { d: fmtDate(en) }) : `${fmtDate(s)} → ${fmtDate(en)}`;
      tip.style.left = `${parseFloat(bar.style.left)}px`;
    };
    bar.onpointerup = async () => {
      bar.onpointermove = bar.onpointerup = null;
      tip.remove();
      bar.classList.remove('dragging');
      if (!delta) return openTask(task.id);
      const [s, en] = dates();
      await save(task.id, milestone ? { due_date: en } : { start_date: s, due_date: en });
    };
  };
}

async function save(id, patch) {
  const task = state.tasks.find((x) => x.id === id);
  if (task) Object.assign(task, patch);
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: patch });
  } catch (err) {
    toast(err.message, true);
  }
  load();
}

