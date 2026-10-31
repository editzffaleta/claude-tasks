// Dashboard: indicadores, criadas x concluídas por semana, distribuição e próximos prazos.
import { api } from './api.js';
import { openTask } from './drawer.js';
import { state, navigate, currentProject } from './state.js';
import { $, ICON, PRIORITIES, PRIORITY_LABEL, ago, dueInfo, esc, fmtDate, fmtDuration, prioIcon, projectColor, statusIcon } from './util.js';

let stats = null;
let loadedFor = null;

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

function tile(label, value, { tone = '', icon = '', hint = '', go = '' } = {}) {
  return `
    <button class="stat-tile ${tone}" ${go ? `data-go="${go}"` : 'disabled'}>
      <span class="stat-label">${icon}${label}</span>
      <b class="stat-value">${value}</b>
      ${hint ? `<span class="stat-hint">${hint}</span>` : ''}
    </button>`;
}

// Barras horizontais de uma série: rótulo à esquerda, valor direto no fim da barra.
function hbars(items, { format = (v) => v, empty = 'Sem dados' } = {}) {
  if (!items.length) return `<div class="empty-small">${empty}</div>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="hbars">${items.map((i) => `
    <div class="hbar-row" ${i.go ? `data-go="${i.go}"` : ''} data-tip="${esc(i.label)}: ${esc(format(i.value))}${i.extra ? ` · ${esc(i.extra)}` : ''}">
      <span class="hbar-label">${i.dot ? `<span class="dot" style="--c:${i.dot}"></span>` : ''}${esc(i.label)}</span>
      <span class="hbar-track"><span class="hbar" style="width:${Math.max(2, (i.value / max) * 100)}%"></span><b>${esc(format(i.value))}</b></span>
    </div>`).join('')}</div>`;
}

function weeklyChart(weeks) {
  const max = niceMax(Math.max(...weeks.flatMap((w) => [w.created, w.done]), 1));
  const label = (w) => { const [, m, d] = w.week.split('-'); return `${Number(d)}/${Number(m)}`; };
  return `
    <div class="legend"><span class="key s1"></span>Criadas<span class="key s2"></span>Concluídas</div>
    <div class="vbars">
      <div class="vb-grid">${[1, 0.5, 0].map((f) => `<div class="vb-line" style="bottom:${f * 100}%"><span>${Math.round(max * f)}</span></div>`).join('')}</div>
      <div class="vb-cols">
        ${weeks.map((w) => `
          <div class="vb-group" data-tip="Semana de ${label(w)}: ${w.created} criada(s), ${w.done} concluída(s)">
            <div class="vb-bars">
              <span class="vb s1" style="height:${(w.created / max) * 100}%"></span>
              <span class="vb s2" style="height:${(w.done / max) * 100}%"></span>
            </div>
            <span class="vb-label">${label(w)}</span>
          </div>`).join('')}
      </div>
    </div>
    <details class="table-toggle"><summary>Ver como tabela</summary>
      <table class="mini-table"><thead><tr><th>Semana</th><th>Criadas</th><th>Concluídas</th></tr></thead>
      <tbody>${weeks.map((w) => `<tr><td>${label(w)}</td><td>${w.created}</td><td>${w.done}</td></tr>`).join('')}</tbody></table>
    </details>`;
}

// Mesma regra do quadro: coluna própria da tarefa ou a primeira coluna do status dela.
function byColumn() {
  const cols = (state.columns || []).filter((c) => c.status !== 'done');
  const counts = new Map(cols.map((c) => [c, 0]));
  for (const t of state.tasks) {
    if (t.status === 'done' || t.archived_at) continue;
    const col = cols.find((c) => c.id != null && c.id === t.column_id) || cols.find((c) => c.status === t.status);
    if (col) counts.set(col, counts.get(col) + 1);
  }
  return cols.map((c) => ({ label: c.name, value: counts.get(c) }));
}

function activityItem(a) {
  const who = a.user_name || { claude: 'Claude', 'automação': 'Automação', 'você': 'Você' }[a.author] || 'Alguém';
  const what = a.kind === 'created' ? 'criou' : a.kind === 'note' ? 'comentou em' : esc(a.body);
  return `
    <button class="feed-item" data-task="${a.task_id}">
      <span class="feed-who ${a.author === 'claude' ? 'claude' : ''}">${a.author === 'claude' ? ICON.claude : ''}<b>${esc(who)}</b></span>
      <span class="feed-what">${what}${a.kind === 'event' ? ' em' : ''} <span class="tid">#${a.task_id}</span> ${esc(a.title)}</span>
      <span class="feed-meta">${state.projectId ? '' : `${esc(a.project_name)} · `}${ago(a.created_at)}</span>
    </button>`;
}

export async function renderDashboard(el, { refresh = false } = {}) {
  const key = String(state.projectId || 'all');
  if (!stats || loadedFor !== key || refresh) {
    if (!stats || loadedFor !== key) el.innerHTML = '<div class="empty-small pad">Carregando…</div>';
    try {
      stats = await api(`/api/stats${state.projectId ? `?project=${state.projectId}` : ''}`);
      loadedFor = key;
    } catch (e) {
      el.innerHTML = `<div class="empty-small pad">${esc(e.message)}</div>`;
      return;
    }
  }
  const s = stats;
  const t = s.totals;
  const project = currentProject();
  const prio = PRIORITIES.map((p) => ({ label: PRIORITY_LABEL[p], value: s.byPriority[p] })).filter((x) => x.value);
  const projects = s.byProject.filter((p) => p.open).sort((a, b) => b.open - a.open);
  const distribution = project ? byColumn() : [...projects.slice(0, 9).map((p) => ({ label: p.name, value: p.open, dot: projectColor(p), go: `project:${p.id}`, extra: p.overdue ? `${p.overdue} atrasada(s)` : '' })),
      ...(projects.length > 9 ? [{ label: 'Outros', value: projects.slice(9).reduce((n, p) => n + p.open, 0) }] : [])];

  el.innerHTML = `
    <div class="dashboard">
      <div class="tiles">
        ${tile('Abertas', t.open, { icon: ICON.grid, hint: `${t.doing} em andamento · ${t.blocked} bloqueadas`, go: 'open' })}
        ${tile('Atrasadas', t.overdue, { tone: t.overdue ? 'critical' : '', icon: ICON.calendar, hint: t.overdue ? 'precisam de atenção' : 'nada atrasado', go: 'overdue' })}
        ${tile('Vencem em 7 dias', t.due_week, { tone: t.due_week ? 'warning' : '', icon: ICON.clock, go: 'week' })}
        ${tile('Concluídas', t.done_7d, { icon: ICON.check, hint: 'últimos 7 dias' })}
        ${tile('Registradas pelo Claude', t.claude_7d, { icon: ICON.claude, hint: `de ${t.created_7d} criadas em 7 dias` })}
        ${tile('Tempo registrado', fmtDuration(t.minutes_7d), { icon: ICON.clock, hint: 'últimos 7 dias' })}
      </div>

      <div class="dash-grid">
        <section class="card-box span-2">
          <h3>Criadas × concluídas por semana</h3>
          ${weeklyChart(s.weeks)}
        </section>

        ${s.sprint ? `
        <section class="card-box">
          <h3>${ICON.target} Sprint ativa · ${esc(s.sprint.name)}</h3>
          <div class="meter-big"><b>${s.sprint.total ? Math.round((s.sprint.done / s.sprint.total) * 100) : 0}%</b><span>${s.sprint.done} de ${s.sprint.total} concluídas</span></div>
          <div class="progress"><span style="width:${s.sprint.total ? (s.sprint.done / s.sprint.total) * 100 : 0}%"></span></div>
          <p class="muted small">${s.sprint.start_date ? fmtDate(s.sprint.start_date) : '?'} → ${s.sprint.end_date ? fmtDate(s.sprint.end_date) : 'sem fim definido'}${s.sprint.goal ? ` · ${esc(s.sprint.goal)}` : ''}</p>
        </section>` : ''}

        <section class="card-box">
          <h3>${project ? 'Abertas por coluna' : 'Abertas por projeto'}</h3>
          ${hbars(distribution, { empty: 'Nenhuma tarefa aberta' })}
        </section>

        <section class="card-box">
          <h3>Abertas por prioridade</h3>
          ${hbars(prio, { empty: 'Nenhuma tarefa aberta' })}
        </section>

        <section class="card-box">
          <h3>Tempo registrado (7 dias)</h3>
          ${hbars(s.timeByProject.map((p) => ({ label: p.name, value: p.minutes, dot: projectColor(p) })), { format: fmtDuration, empty: 'Nenhum tempo registrado. Use o timer nas tarefas.' })}
        </section>

        <section class="card-box">
          <h3>Próximos prazos</h3>
          <div class="due-list">
            ${s.upcoming.map((x) => {
              const d = dueInfo(x, state.today);
              return `<button class="due-row" data-task="${x.id}">${statusIcon(x.status)}${prioIcon(x.priority)}<span class="t">${esc(x.title)}</span>
                ${state.projectId ? '' : `<span class="muted small">${esc(x.project_name)}</span>`}<span class="due ${d.cls}" title="${d.title}">${d.text}</span></button>`;
            }).join('') || '<div class="empty-small">Nenhuma tarefa com prazo.</div>'}
          </div>
        </section>

        <section class="card-box span-2">
          <h3>Atividade recente</h3>
          <div class="feed">${s.activity.map(activityItem).join('') || '<div class="empty-small">Nada ainda.</div>'}</div>
        </section>
      </div>
    </div>`;

  el.onclick = (e) => {
    const task = e.target.closest('[data-task]');
    if (task) return openTask(Number(task.dataset.task));
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (!go) return;
    if (go.startsWith('project:')) return navigate({ projectId: Number(go.slice(8)), view: 'board' });
    if (go === 'open') return navigate({ view: 'board' });
    state.due = go === 'overdue' ? 'overdue' : go === 'week' ? 'week' : '';
    navigate({ view: 'list' });
  };
  bindTooltips(el);
}

function bindTooltips(el) {
  let tip = $('.viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    document.body.append(tip);
  }
  el.onpointermove = (e) => {
    const target = e.target.closest('[data-tip]');
    if (!target) { tip.classList.remove('show'); return; }
    tip.textContent = target.dataset.tip;
    tip.classList.add('show');
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
    const y = e.clientY - tip.offsetHeight - 12 < 8 ? e.clientY + 18 : e.clientY - tip.offsetHeight - 12;
    tip.style.transform = `translate(${x}px, ${y}px)`;
  };
  el.onpointerleave = () => tip.classList.remove('show');
}
