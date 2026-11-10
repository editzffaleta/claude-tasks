// Painel lateral de detalhes: campos, labels, campos personalizados, descrição, subtarefas,
// dependências, tempo, anexos, comentários em conversa e histórico.
import { api, attempt, toast, upload } from './api.js';
import { bindEditor, mentionNames, toolbar } from './editor.js';
import { t, tn } from './i18n.js';
import { can, labelFor, load, markSeen, navigate, state, syncUrl, userById } from './state.js';
import { confirmAction, showMenu } from './ui.js';
import {
  $, $$, AGENTS, DEPENDENCY_HINT, DEPENDENCY_LABEL, DEPENDENCY_TYPES, FREQS, FREQ_LABEL, ICON, PRIORITIES, PRIORITY_LABEL, SPRINT_STATUS_LABEL,
  STATUS_LABEL, TYPES, TYPE_LABEL, agentAvatar, agentBadge, agentOf, ago, avatar, columnLabel, describeRecurrence, dtf, dueInfo, esc, eventText, fmtDate, fmtDuration, fmtNumber, localDate, md,
  prioIcon, statusIcon, taskRef, tilde, typeIcon, weekdayNames,
} from './util.js';

let task = null;
let editingDesc = false;
let showTimeForm = false;
let replyTo = null;
let editingNote = null;
let timelineMode = 'all';

const drawer = () => $('#drawer');
const isTyping = () => document.activeElement?.matches?.('input, textarea, select') && drawer().contains(document.activeElement);
const editable = () => task && can(task.project_id, 'edit') && task.my_role !== 'viewer';
const managing = () => task && can(task.project_id, 'manage');
const ro = () => (editable() ? '' : 'disabled');
const mdOpts = () => ({ mentions: mentionNames() });

let returnFocus = null;
// "Mais detalhes" (relator, observadores, datas, estimativa…) fica aberto ou fechado como a pessoa deixou.
let moreOpen = (() => { try { return localStorage.getItem('tk_more_props') === '1'; } catch { return false; } })();

export async function openTask(id) {
  if (state.taskId !== id) { editingDesc = false; showTimeForm = false; replyTo = null; editingNote = null; }
  const wasOpen = drawer().classList.contains('open');
  if (!wasOpen && !drawer().contains(document.activeElement)) returnFocus = document.activeElement;
  markSeen(id);
  state.taskId = id;
  syncUrl();
  try {
    task = await api(`/api/tasks/${id}`);
  } catch (e) {
    toast(e.message, true);
    return closeDrawer();
  }
  render();
  drawer().inert = false;
  drawer().classList.add('open');
  drawer().setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').classList.add('show');
  // O foco entra no detalhe (no título) para o teclado e os leitores de tela começarem por ele.
  if (!wasOpen) requestAnimationFrame(() => $('#d-title')?.focus({ preventScroll: true }));
  $$('.selected[data-id], .selected[data-row]').forEach((c) => c.classList.remove('selected'));
  $$(`[data-id="${id}"].card, tr[data-id="${id}"], [data-row="${id}"]`).forEach((c) => c.classList.add('selected'));
}

export function closeDrawer() {
  saveDescription();
  state.taskId = null;
  task = null;
  syncUrl();
  drawer()?.classList.remove('open');
  drawer()?.setAttribute('aria-hidden', 'true');
  if (drawer()) drawer().inert = true;
  $('#drawer-scrim')?.classList.remove('show');
  $$('.selected[data-id], .selected[data-row]').forEach((c) => c.classList.remove('selected'));
  // Devolve o foco para onde a pessoa estava (o cartão ou a linha que abriu a tarefa).
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  returnFocus = null;
}

export async function refreshDrawer() {
  if (!state.taskId) return;
  try {
    task = await api(`/api/tasks/${state.taskId}`);
  } catch {
    toast(t('Essa tarefa foi excluída'));
    return closeDrawer();
  }
  // Não atropela o que está sendo digitado: só atualiza as listas.
  if (isTyping()) renderSections();
  else render();
}

async function patch(body, success) {
  const id = task.id;
  const r = await attempt(() => api(`/api/tasks/${id}`, { method: 'PATCH', body }), success);
  if (r) await Promise.all([load(), refreshDrawer()]);
  else refreshDrawer();
  return r;
}

const refresh = () => Promise.all([load(), refreshDrawer()]);

// ---------- campos ----------

function labelChip(name, removable) {
  const l = labelFor(name, task.project_id);
  return `<span class="label-chip" style="${l?.color ? `--c:${esc(l.color)}` : ''}" title="${esc(l?.description || name)}">
    <span class="dot"></span>${esc(name)}${removable ? `<button class="x" data-untag="${esc(name)}" aria-label="${esc(t('Remover {name}', { name }))}">${ICON.close}</button>` : ''}
  </span>`;
}

function fieldInput(f) {
  const id = `d-field-${f.id}`;
  const v = f.value;
  const dis = ro();
  if (f.type === 'boolean') return `<label class="switch"><input type="checkbox" id="${id}" data-field="${f.id}" ${v ? 'checked' : ''} ${dis}><span></span></label>`;
  if (f.type === 'select') {
    return `<select id="${id}" data-field="${f.id}" ${dis}><option value="">—</option>${(f.options || []).map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
  }
  if (f.type === 'multi_select') {
    const set = new Set(Array.isArray(v) ? v : []);
    return `<div class="multi-opts" data-multifield="${f.id}">${(f.options || []).map((o) => `
      <label class="opt-chip ${set.has(o) ? 'on' : ''}"><input type="checkbox" value="${esc(o)}" ${set.has(o) ? 'checked' : ''} ${dis}>${esc(o)}</label>`).join('')}</div>`;
  }
  if (f.type === 'user') {
    return `<select id="${id}" data-field="${f.id}" ${dis}><option value="">—</option>${state.users.map((u) => `<option value="${u.id}" ${u.id === v ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
  }
  const type = { number: 'number', date: 'date', url: 'url' }[f.type] || 'text';
  const link = f.type === 'url' && v ? `<a class="icon-btn tiny" href="${esc(v)}" target="_blank" rel="noopener" aria-label="${esc(t('Abrir link'))}">${ICON.link}</a>` : '';
  return `<div class="inline"><input type="${type}" id="${id}" data-field="${f.id}" value="${esc(v ?? '')}" ${f.type === 'number' ? 'step="any"' : ''} ${dis}>${link}</div>`;
}

function recurrenceFields(r) {
  if (!r) return '';
  const weekly = r.freq === 'weekly';
  const monthly = r.freq === 'monthly' || r.freq === 'quarterly';
  const days = new Set(r.weekdays || []);
  return `
    <div class="recur-box">
      <label class="inline-field">${t('a cada')} <input type="number" id="d-interval" min="1" max="365" value="${r.interval || 1}" ${ro()}></label>
      ${weekly ? `<div class="weekday-picks">${weekdayNames().map((d, i) => `<label class="opt-chip ${days.has(i) ? 'on' : ''}"><input type="checkbox" data-weekday="${i}" ${days.has(i) ? 'checked' : ''} ${ro()}>${esc(d)}</label>`).join('')}</div>` : ''}
      ${monthly ? `<label class="inline-field">${t('no dia')} <select id="d-monthday" ${ro()}><option value="">${t('da data')}</option>${Array.from({ length: 31 }, (_, i) => `<option value="${i + 1}" ${r.monthday === i + 1 ? 'selected' : ''}>${i + 1}</option>`).join('')}<option value="last" ${r.monthday === 'last' ? 'selected' : ''}>${t('último')}</option></select></label>` : ''}
      <label class="inline-field">${t('até')} <input type="date" id="d-until" value="${r.until || ''}" ${ro()}></label>
      <label class="inline-field">${t('ou')} <input type="number" id="d-count" min="1" max="1000" value="${r.count || ''}" placeholder="∞" ${ro()}> ${t('vezes')}</label>
    </div>`;
}

function props(x) {
  const people = task.assignees || [];
  const columns = task.columns || [];
  const allowed = task.allowed_columns ? new Set(task.allowed_columns) : null;
  const currentCol = x.column_id ?? columns.find((c) => c.status === x.status)?.id ?? x.status;
  const sprints = (task.sprints || []).filter((s) => !['completed', 'cancelled'].includes(s.status) || s.id === x.sprint_id);
  const due = dueInfo(x, state.today);
  const opts = (map, value) => Object.entries(map).map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const dis = ro();
  const fields = task.fields || [];
  const watching = task.watchers?.some((w) => w.id === state.me?.id);
  return `
    <div class="props">
      <span>${t('Status')}</span>
      <select id="d-column" ${dis}>${columns.map((c) => {
        const key = c.id ?? c.status;
        const blocked = allowed && c.id != null && !allowed.has(c.id);
        return `<option value="${key}" ${String(key) === String(currentCol) ? 'selected' : ''} ${blocked ? 'disabled' : ''}>${esc(columnLabel(c.name, c.status))}${blocked ? ` — ${esc(t('transição não permitida'))}` : ''}</option>`;
      }).join('')}</select>
      <span>${t('Prioridade')}</span><select id="d-priority" ${dis}>${opts(Object.fromEntries(PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]])), x.priority)}</select>
      <span>${t('Tipo')}</span><select id="d-type" ${dis}>${opts(Object.fromEntries(TYPES.map((y) => [y, TYPE_LABEL[y]])), x.type)}</select>
      <span>${t('Responsáveis')}</span>
      <div class="people-field">
        ${people.map((u) => `<span class="person">${avatar(u, { size: 20 })}${esc(u.name)}${dis ? '' : `<button class="x" data-unassign="${u.id}" aria-label="${esc(t('Remover {name}', { name: u.name }))}">${ICON.close}</button>`}</span>`).join('')}
        ${dis ? (people.length ? '' : `<span class="muted">${t('Ninguém')}</span>`) : `<button class="add-chip" data-action="assign">${ICON.plus}${people.length ? '' : t('Atribuir')}</button>`}
      </div>
      <span>${t('Labels')}</span>
      <div class="people-field labels-field">
        ${x.tags.map((g) => labelChip(g, !dis)).join('')}
        ${dis ? (x.tags.length ? '' : '<span class="muted">—</span>') : `<button class="add-chip" data-action="labels">${ICON.tag}${x.tags.length ? '' : t('Adicionar')}</button>`}
      </div>
      <span>${t('Prazo')}</span>
      <div class="inline"><input type="date" id="d-due" value="${x.due_date || ''}" ${dis}>${due && due.cls ? `<span class="due ${due.cls}">${due.title}</span>` : ''}</div>
      <span>${t('Sprint')}</span>
      <select id="d-sprint" ${dis}><option value="">${t('Backlog')}</option>${sprints.map((s) => `<option value="${s.id}" ${s.id === x.sprint_id ? 'selected' : ''}>${esc(s.name)}${s.status !== 'planning' ? ` · ${esc(SPRINT_STATUS_LABEL[s.status].toLowerCase())}` : ''}</option>`).join('')}</select>
      ${fields.filter((f) => f.required).map((f) => `<span title="${esc(f.name)}">${esc(f.name)} *</span>${fieldInput(f)}`).join('')}
    </div>
    <details class="props-more" ${moreOpen ? 'open' : ''}>
      <summary>${ICON.right}${t('Mais detalhes')}</summary>
      <div class="props">
      <span>${t('Relator')}</span>
      <select id="d-reporter" ${dis}><option value="">—</option>${state.users.map((u) => `<option value="${u.id}" ${u.id === x.reporter_id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>
      <span>${t('Observadores')}</span>
      <div class="people-field">
        ${(task.watchers || []).map((u) => `<span class="person small">${avatar(u, { size: 18 })}${esc(u.name.split(' ')[0])}${dis ? '' : `<button class="x" data-unwatch="${u.id}" aria-label="${esc(t('Remover {name}', { name: u.name }))}">${ICON.close}</button>`}</span>`).join('')}
        ${dis ? '' : `<button class="add-chip" data-action="watchers">${ICON.plus}</button>`}
        <button class="link-btn small" data-action="watch">${ICON.eye}${watching ? t('Deixar de acompanhar') : t('Acompanhar')}</button>
      </div>
      <span>${t('Início')}</span><input type="date" id="d-start" value="${x.start_date || ''}" ${dis}>
      <span>${t('Pontos')}</span><input type="number" id="d-points" min="0" max="1000" step="any" value="${x.story_points ?? ''}" placeholder="${esc(t('story points'))}" ${dis}>
      <span>${t('Estimativa')}</span>
      <div class="est-pair">
        <input id="d-estimate" value="${x.estimate_minutes ? fmtDuration(x.estimate_minutes) : ''}" placeholder="${esc(t('original: 2h, 1d'))}" title="${esc(t('Estimativa original'))}" ${dis}>
        <input id="d-remaining" value="${x.remaining_minutes != null ? fmtDuration(x.remaining_minutes) : ''}" placeholder="${esc(t('restante'))}" title="${esc(t('Estimativa restante'))}" ${dis}>
      </div>
      <span>${t('Projeto')}</span>
      <select id="d-project" ${dis}>${state.projects.filter((p) => (!p.archived_at && can(p, 'edit')) || p.id === x.project_id).map((p) => `<option value="${p.id}" ${p.id === x.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span>${t('Recorrência')}</span>
      <div>
        <select id="d-recur" ${dis}><option value="">${t('Não repete')}</option>${opts(Object.fromEntries(FREQS.map((f) => [f, FREQ_LABEL[f]])), x.recurrence?.freq || '')}</select>
        ${recurrenceFields(x.recurrence)}
      </div>
      ${fields.filter((f) => !f.required).map((f) => `<span title="${esc(f.name)}">${esc(f.name)}</span>${fieldInput(f)}`).join('')}
      ${x.project_path ? `<span>${t('Pasta')}</span><div class="path">${esc(tilde(x.project_path))}</div>` : ''}
      </div>
    </details>`;
}

// Caixas de seleção da descrição: clicar em ☐ marca a linha correspondente.
function toggleChecklist(index) {
  let i = -1;
  const next = task.description.split('\n').map((line) => {
    if (!/^\s*(?:[-*+]|\d+[.)])\s+\[( |x)\]/i.test(line)) return line;
    i += 1;
    if (i !== index) return line;
    return line.replace(/\[( |x)\]/i, (m) => (m.toLowerCase() === '[x]' ? '[ ]' : '[x]'));
  }).join('\n');
  if (next !== task.description) { task.description = next; patch({ description: next }); }
}

function descSection(x) {
  const canEdit = editable();
  return `
    <section>
      <div class="section-label">${t('Descrição')} ${canEdit ? `<button data-action="toggle-desc">${editingDesc ? t('Concluir') : t('Editar')}</button>` : ''}</div>
      ${editingDesc
        ? `${toolbar('d-desc')}
           <textarea class="input desc-edit" id="d-desc" data-md placeholder="${esc(t('Contexto, arquivos, critérios de pronto… Cole imagens direto aqui.'))}">${esc(x.description)}</textarea>
           <p class="hint">${t('Markdown. {k} ou Esc para concluir. Cole uma imagem para anexar. Use @ para mencionar.', { k: '<kbd>⌘</kbd><kbd>↵</kbd>' })}</p>`
        : `<div class="desc md ${x.description ? '' : 'empty'}" ${canEdit ? 'data-action="toggle-desc"' : ''}>${x.description ? md(x.description, mdOpts()) : esc(canEdit ? t('Sem descrição. Clique para adicionar.') : t('Sem descrição.'))}</div>`}
    </section>`;
}

function subtasksSection() {
  const list = task.subtasks || [];
  const done = list.filter((s) => s.status === 'done').length;
  return `
    <div class="section-label">${ICON.subtask} ${t('Subtarefas')} ${list.length ? `<span class="count">${done}/${list.length}</span>` : ''}</div>
    ${list.length ? `<div class="progress"><span style="width:${(done / list.length) * 100}%"></span></div>` : ''}
    <div class="sublist">
      ${list.map((s) => `
        <div class="subrow ${s.status === 'done' ? 'done' : ''}">
          <button class="check-btn ${s.status === 'done' ? 'on' : ''}" data-subtoggle="${s.id}" aria-label="${esc(t('Concluir {ref}', { ref: taskRef(s) }))}" ${ro()}>${s.status === 'done' ? ICON.check : ''}</button>
          <button class="subtitle" data-open="${s.id}">${prioIcon(s.priority)}<span class="tid">${esc(taskRef(s))}</span><span>${esc(s.title)}</span></button>
          ${s.due_date ? `<span class="due ${dueInfo(s, state.today)?.cls}">${dueInfo(s, state.today).text}</span>` : ''}
          ${s.assignee_ids.map(userById).filter(Boolean).map((u) => avatar(u, { size: 18 })).join('')}
          <span class="status-mini" title="${esc(STATUS_LABEL[s.status])}">${statusIcon(s.status)}</span>
        </div>`).join('')}
      ${editable() ? `<form class="add-row" data-form="subtask">
        <input class="input small" name="title" placeholder="${esc(t('Adicionar subtarefa…'))}" autocomplete="off" maxlength="300">
      </form>` : ''}
    </div>`;
}

function depsSection() {
  const row = (d, removable) => `
    <div class="dep-row ${d.status === 'done' ? 'done' : ''}">
      ${statusIcon(d.status)}<button class="subtitle" data-open="${d.id}"><span class="tid">#${d.id}</span><span>${esc(d.title)}</span></button>
      <span class="chip dep-type" title="${esc(DEPENDENCY_HINT[d.type || 'finish_start'])}">${esc(DEPENDENCY_LABEL[d.type || 'finish_start'])}</span>
      ${d.project_id !== task.project_id ? `<span class="chip">${esc(d.project_name)}</span>` : ''}
      ${removable && editable() ? `<button class="icon-btn tiny" data-unblock="${d.id}" aria-label="${esc(t('Remover dependência'))}">${ICON.close}</button>` : ''}
    </div>`;
  const candidates = state.tasks.filter((x) => x.id !== task.id && x.status !== 'done' && !task.blockers.some((b) => b.id === x.id));
  return `
    <div class="section-label">${ICON.link} ${t('Dependências')}</div>
    <div class="deps">
      <div class="dep-group"><small>${t('Depende de')}</small>
        ${task.blockers.map((d) => row(d, true)).join('') || `<div class="muted small">${t('Nada bloqueando.')}</div>`}
        ${editable() ? `<form class="add-row dep-form" data-form="blocker">
          <input class="input small" name="ref" list="dep-options" placeholder="${esc(t('#id ou título da tarefa'))}" autocomplete="off">
          <select class="input small" name="type" aria-label="${esc(t('Tipo de dependência'))}">${DEPENDENCY_TYPES.map((d) => `<option value="${d}" title="${esc(DEPENDENCY_HINT[d])}">${esc(DEPENDENCY_LABEL[d])}</option>`).join('')}</select>
          <button class="btn ghost bordered small" type="submit">${t('Adicionar')}</button>
          <datalist id="dep-options">${candidates.slice(0, 300).map((x) => `<option value="#${x.id} ${esc(x.title)}"></option>`).join('')}</datalist>
        </form>` : ''}
      </div>
      ${task.blocking.length ? `<div class="dep-group"><small>${t('Bloqueia')}</small>${task.blocking.map((d) => row(d, false)).join('')}</div>` : ''}
    </div>`;
}

function timeSection(x) {
  const spent = x.spent_minutes || 0;
  const est = x.estimate_minutes || 0;
  const pct = est ? Math.min(100, (spent / est) * 100) : 0;
  const mine = state.timers.find((y) => y.task_id === x.id);
  const canEdit = editable();
  return `
    <div class="section-label">${ICON.clock} ${t('Tempo')}
      ${canEdit ? `<button data-action="time-form">${showTimeForm ? t('Cancelar') : t('Registrar manualmente')}</button>` : ''}
    </div>
    <div class="time-summary">
      ${canEdit ? `<button class="btn ${mine ? 'danger-solid' : 'ghost bordered'} small" data-action="${mine ? 'stop' : 'start'}">${mine ? `${ICON.stop} ${t('Parar timer')}` : `${ICON.play} ${t('Iniciar timer')}`}</button>` : ''}
      <div class="time-numbers">${est ? t('{spent} de {total}', { spent: `<b>${fmtDuration(spent)}</b>`, total: fmtDuration(est) }) : t('{spent} gastos', { spent: `<b>${fmtDuration(spent)}</b>` })}${x.remaining_minutes != null ? ` · ${t('{d} restantes', { d: fmtDuration(x.remaining_minutes) })}` : ''}${est && spent > est ? ` <span class="over">${t('acima da estimativa')}</span>` : ''}</div>
    </div>
    ${est ? `<div class="progress ${spent > est ? 'over' : ''}"><span style="width:${pct}%"></span></div>` : ''}
    ${showTimeForm ? `
      <form class="time-form" data-form="time">
        <input class="input small" name="duration" placeholder="${esc(t('45m, 1h30m'))}" required>
        <input class="input small" type="date" name="date" value="${localDate()}">
        <input class="input small" name="note" placeholder="${esc(t('O que foi feito (opcional)'))}">
        <button class="btn primary small" type="submit">${t('Salvar')}</button>
      </form>` : ''}
    ${task.time_entries.length ? `
      <div class="time-list">
        ${task.time_entries.slice(0, 20).map((e) => `
          <div class="time-row">
            <span class="who">${agentOf(e.author) ? `${agentOf(e.author).name}${e.user_name ? ` · ${esc(e.user_name)}` : ''}` : e.user_name ? esc(e.user_name) : t('Você')}</span>
            <span class="muted">${fmtDate(localDate(new Date(e.started_at)))}</span>
            <span class="note">${esc(e.note)}</span>
            <b>${e.ended_at ? fmtDuration(e.minutes) : `<span class="live-time">${t('rodando')}</span>`}</b>
            ${canEdit ? `<button class="icon-btn tiny" data-deltime="${e.id}" aria-label="${esc(t('Apagar registro'))}">${ICON.trash}</button>` : ''}
          </div>`).join('')}
      </div>` : ''}`;
}

function filesSection() {
  const images = task.attachments.filter((a) => a.mime.startsWith('image/') && a.mime !== 'image/svg+xml');
  const others = task.attachments.filter((a) => !images.includes(a));
  const canEdit = editable();
  const del = (a) => (canEdit ? `<button class="icon-btn tiny" data-delfile="${a.id}" aria-label="${esc(t('Apagar {name}', { name: a.name }))}">${ICON.close}</button>` : '');
  return `
    <div class="section-label">${ICON.clip} ${t('Anexos')} <span class="count">${task.attachments.length || ''}</span>
      ${canEdit ? `<button data-action="upload">${t('Adicionar')}</button>` : ''}
    </div>
    <input type="file" id="d-file" multiple hidden>
    ${images.length ? `<div class="thumbs">${images.map((a) => `
      <figure class="thumb"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/attachments/${a.id}" alt="${esc(a.name)}" loading="lazy"></a>${del(a)}</figure>`).join('')}</div>` : ''}
    ${others.map((a) => `
      <div class="file-row">${ICON.clip}<a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.name)}</a>
        <span class="muted">${a.size > 1048576 ? fmtNumber(a.size / 1048576, { style: 'unit', unit: 'megabyte', unitDisplay: 'short', maximumFractionDigits: 1 }) : fmtNumber(Math.ceil(a.size / 1024), { style: 'unit', unit: 'kilobyte', unitDisplay: 'short' })}</span>${del(a)}</div>`).join('')}
    ${task.attachments.length || !canEdit ? '' : `<div class="dropzone" data-action="upload">${t('Arraste arquivos aqui ou clique para anexar')}</div>`}`;
}

function sharesSection() {
  const shares = task.shares || [];
  if (!shares.length) return '';
  return `
    <div class="section-label">${ICON.share} ${t('Links públicos')}</div>
    ${shares.map((s) => `
      <div class="file-row">${ICON.globe}<a href="/s/${esc(s.token)}" target="_blank" rel="noopener">${esc(`${location.origin}/s/${s.token.slice(0, 8)}…`)}</a>
        <span class="muted small">${s.expires_at ? t('expira {d}', { d: fmtDate(s.expires_at.slice(0, 10)) }) : t('sem validade')}</span>
        <button class="icon-btn tiny" data-copyshare="${esc(s.token)}" aria-label="${esc(t('Copiar link'))}">${ICON.copy}</button>
        ${editable() ? `<button class="icon-btn tiny" data-revoke="${esc(s.token)}" aria-label="${esc(t('Revogar link'))}">${ICON.close}</button>` : ''}
      </div>`).join('')}`;
}

// ---------- conversa e histórico ----------

function who(n) {
  if (n.user_name) return esc(n.user_name);
  return agentOf(n.author)?.name || { 'automação': t('Automação'), 'você': t('Você'), 'e-mail': t('E-mail'), ia: t('IA'), user: t('Alguém') }[n.author] || esc(n.author);
}

function noteAvatar(n) {
  if (agentOf(n.author)) return agentAvatar(n.author);
  if (n.author === 'e-mail') return `<span class="avatar mail">${ICON.mail}</span>`;
  if (n.user_name) return avatar({ name: n.user_name, color: n.user_color, avatar: n.user_avatar }, { size: 22 });
  return `<span class="avatar">${esc(who(n)[0] || '?')}</span>`;
}

function commentHtml(n, replies) {
  const when = `<span title="${esc(dtf.format(new Date(n.created_at)))}">${ago(n.created_at)}</span>`;
  const mine = state.me && n.user_id === state.me.id;
  const canChange = editable() && (mine || managing());
  const editing = editingNote === n.id;
  return `
    <div class="note comment" id="note-${n.id}">
      ${noteAvatar(n)}
      <div class="note-main">
        <div class="note-meta"><b>${who(n)}</b> · ${when}${n.edited_at ? ` · <span class="muted" title="${esc(dtf.format(new Date(n.edited_at)))}">${t('editado')}</span>` : ''}
          <span class="note-actions">
            ${editable() && !n.parent_id ? `<button class="link-btn" data-reply="${n.id}">${ICON.reply}${t('Responder')}</button>` : ''}
            ${canChange && !editing ? `<button class="icon-btn tiny" data-editnote="${n.id}" aria-label="${esc(t('Editar comentário'))}">${ICON.edit}</button>
              <button class="icon-btn tiny" data-delnote="${n.id}" aria-label="${esc(t('Excluir comentário'))}">${ICON.trash}</button>` : ''}
          </span>
        </div>
        ${editing ? `
          <div class="note-edit">
            ${toolbar(`d-edit-${n.id}`)}
            <textarea class="input" id="d-edit-${n.id}" data-md data-noteedit="${n.id}" rows="3">${esc(n.body)}</textarea>
            <div class="row"><span class="spacer"></span><button class="btn ghost small" data-canceledit>${t('Cancelar')}</button><button class="btn primary small" data-saveedit="${n.id}">${t('Salvar')}</button></div>
          </div>` : `<div class="note-body md">${md(n.body, mdOpts())}</div>`}
        ${replies.length || replyTo === n.id ? `<div class="replies">
          ${replies.map((r) => commentHtml(r, [])).join('')}
          ${replyTo === n.id ? `<div class="comment-box reply-box">
            ${toolbar('d-reply')}
            <textarea class="input" id="d-reply" data-md rows="2" placeholder="${esc(t('Responder…'))}"></textarea>
            <div class="row"><span class="spacer"></span><button class="btn ghost small" data-cancelreply>${t('Cancelar')}</button><button class="btn primary small" data-sendreply="${n.id}">${t('Responder')}</button></div>
          </div>` : ''}
        </div>` : ''}
      </div>
    </div>`;
}

function timeline(x) {
  const comments = task.notes.filter((n) => n.kind === 'note');
  const byParent = new Map();
  for (const c of comments) if (c.parent_id) byParent.set(c.parent_id, [...(byParent.get(c.parent_id) || []), c]);
  const known = new Set(comments.map((c) => c.id));
  const roots = comments.filter((c) => !c.parent_id || !known.has(c.parent_id));
  // Quem criou: o agente (Claude, Codex), a conta (created_by) quando houver ou a origem (automação, e-mail).
  const creator = agentOf(x.source)?.name || userById(x.created_by)?.name
    || { 'automação': t('Automação'), 'e-mail': t('E-mail') }[x.source] || t('Alguém');
  const created = `<div class="note event"><div class="avatar-dot">${ICON.dot}</div><div class="note-meta">${t('{who} criou a tarefa', { who: `<b>${esc(creator)}</b>` })} · ${ago(x.created_at)}</div></div>`;
  const items = timelineMode === 'comments'
    ? roots.map((n) => commentHtml(n, byParent.get(n.id) || []))
    : [created, ...task.notes.filter((n) => n.kind === 'event' || roots.includes(n)).map((n) => {
      if (n.kind !== 'event') return commentHtml(n, byParent.get(n.id) || []);
      const when = `<span title="${esc(dtf.format(new Date(n.created_at)))}">${ago(n.created_at)}</span>`;
      return `<div class="note event"><div class="avatar-dot">${ICON.dot}</div><div class="note-meta"><b>${who(n)}</b> ${esc(eventText(n.body))} · ${when}</div></div>`;
    })];
  return items.join('') || `<div class="muted small">${t('Nenhum comentário ainda.')}</div>`;
}

function timelineHead() {
  const n = task.notes.filter((x) => x.kind === 'note').length;
  return `${t('Atividade')}
    <span class="seg small">
      <button class="${timelineMode === 'all' ? 'on' : ''}" data-tlmode="all">${t('Tudo')}</button>
      <button class="${timelineMode === 'comments' ? 'on' : ''}" data-tlmode="comments">${tn(n, '{n} comentário', '{n} comentários')}</button>
    </span>`;
}

function renderSections() {
  if (!task) return;
  const x = task;
  const set = (id, html) => { const el = $(`#${id}`); if (el) el.innerHTML = html; };
  set('d-subtasks', subtasksSection());
  set('d-deps', depsSection());
  set('d-time', timeSection(x));
  set('d-files', filesSection());
  set('d-shares', sharesSection());
  if (!editingNote && replyTo == null) set('d-timeline', timeline(x));
  set('d-tlhead', timelineHead());
}

function render() {
  const x = task;
  if (!x) return;
  const canEdit = editable();
  const watching = task.watchers?.some((w) => w.id === state.me?.id);
  $('#drawer-inner').innerHTML = `
    <div class="drawer-head">
      ${typeIcon(x.type, { always: true })}<span class="tid">${esc(taskRef(x))}</span><span>·</span>
      <button class="link-btn" data-goproject="${x.project_id}">${esc(x.project_name)}</button>
      ${x.parent_id ? `<span>·</span><button class="link-btn parent" data-open="${x.parent_id}">${ICON.subtask}${esc(x.parent_title || `#${x.parent_id}`)}</button>` : ''}
      ${x.archived_at ? `<span class="chip">${t('arquivada')}</span>` : ''}
      ${!canEdit ? `<span class="chip">${ICON.eye}${t('somente leitura')}</span>` : ''}
      ${agentBadge(x.source, (agent) => t('Registrada pelo {agent}', { agent }))}
      <span class="spacer"></span>
      <button class="btn bordered small send-claude" data-action="copy" aria-label="${esc(sendLabel('claude'))}" title="${esc(t('Copiar pedido para colar numa sessão do {agent}', { agent: AGENTS.claude.name }))}">${ICON.claude}<span>${sendLabel('claude')}</span></button>
      <button class="icon-btn small ${watching ? 'on' : ''}" data-action="watch" aria-pressed="${!!watching}" aria-label="${esc(watching ? t('Deixar de acompanhar') : t('Acompanhar (receber notificações)'))}" title="${esc(watching ? t('Deixar de acompanhar') : t('Acompanhar (receber notificações)'))}">${ICON.eye}</button>
      <button class="icon-btn small" data-action="more" aria-label="${esc(t('Mais ações'))}" title="${esc(t('Mais ações'))}" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
      <button class="icon-btn small" data-action="close" aria-label="${esc(t('Fechar (Esc)'))}" title="${esc(t('Fechar (Esc)'))}">${ICON.close}</button>
    </div>
    <textarea class="title-edit" id="d-title" rows="1" maxlength="300" aria-label="${esc(t('Título'))}" ${canEdit ? '' : 'readonly'}>${esc(x.title)}</textarea>
    ${props(x)}
    ${descSection(x)}
    <section id="d-subtasks">${subtasksSection()}</section>
    <section id="d-deps">${depsSection()}</section>
    <section id="d-time">${timeSection(x)}</section>
    <section id="d-files">${filesSection()}</section>
    <section id="d-shares">${sharesSection()}</section>
    <section>
      <div class="section-label" id="d-tlhead">${timelineHead()}</div>
      <div class="timeline" id="d-timeline">${timeline(x)}</div>
      ${canEdit ? `<div class="comment-box">
        ${toolbar('d-note')}
        <textarea class="input" id="d-note" data-md rows="2" placeholder="${esc(t('Escreva um comentário… use @ para mencionar, cole imagens aqui'))}"></textarea>
        <div class="row"><span class="hint"><kbd>⌘</kbd><kbd>↵</kbd></span><button class="btn ghost bordered small" data-action="note">${t('Comentar')}</button></div>
      </div>` : ''}
    </section>
    ${canEdit ? `<div class="drawer-foot">
      ${x.status === 'done'
        ? `<button class="btn ghost bordered" data-action="reopen">${t('Reabrir')}</button>`
        : `<button class="btn primary" data-action="complete">${ICON.check} ${t('Concluir')}</button>`}
      ${x.recurrence ? `<span class="hint">${ICON.repeat} ${esc(describeRecurrence(x.recurrence))}</span>` : ''}
      <span class="spacer"></span>
      <button class="btn ghost" data-action="archive">${ICON.archive}${x.archived_at ? t('Desarquivar') : t('Arquivar')}</button>
      ${managing() ? `<button class="btn danger" data-action="delete">${ICON.trash}${t('Excluir')}</button>` : ''}
    </div>` : ''}`;
  autosize($('#d-title'));
  if (editingDesc) $('#d-desc')?.focus();
  if (editingNote) $(`#d-edit-${editingNote}`)?.focus();
  if (replyTo != null) $('#d-reply')?.focus();
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// ---------- ações ----------

function saveDescription() {
  const value = $('#d-desc')?.value;
  if (task && value != null && value !== task.description) {
    task.description = value;
    patch({ description: value });
  }
}

async function addFiles(files, { insertInto } = {}) {
  for (const file of files) {
    const name = file.name && file.name !== 'image.png' ? file.name : `colado-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    const a = await attempt(() => upload(task.id, file, name));
    if (a && insertInto && file.type.startsWith('image/')) {
      const el = insertInto;
      const snippet = `![${a.name}](/api/attachments/${a.id})`;
      const pos = el.selectionStart ?? el.value.length;
      el.value = `${el.value.slice(0, pos)}${snippet}${el.value.slice(pos)}`;
      el.dispatchEvent(new Event('input'));
    }
  }
  await refresh();
}

async function addComment(el, parent_id = null) {
  const body = el?.value.trim();
  if (!body || !task) return;
  const r = await attempt(() => api(`/api/tasks/${task.id}/notes`, { method: 'POST', body: { body, parent_id } }));
  if (r) {
    el.value = '';
    replyTo = null;
    await refresh();
  }
}

function peopleMenu(anchor, current, onPick) {
  if (!state.users.length) return toast(t('Convide pessoas na página Equipe para atribuir tarefas'));
  showMenu(anchor, state.users.map((u) => ({
    label: u.name,
    icon: avatar(u, { size: 18 }),
    checked: current.has(u.id),
    onClick: () => onPick(current.has(u.id) ? [...current].filter((x) => x !== u.id) : [...current, u.id]),
  })));
}

function labelsMenu(anchor) {
  const have = new Set(task.tags.map((g) => g.toLowerCase()));
  const available = state.labels.filter((l) => !l.project_id || l.project_id === task.project_id);
  const used = [...new Set(state.tasks.filter((x) => x.project_id === task.project_id).flatMap((x) => x.tags))];
  const names = [...new Map([...available.map((l) => [l.name.toLowerCase(), l.name]), ...used.map((g) => [g.toLowerCase(), g])]).values()].sort((a, b) => a.localeCompare(b));
  const toggle = (name) => {
    const next = have.has(name.toLowerCase()) ? task.tags.filter((g) => g.toLowerCase() !== name.toLowerCase()) : [...task.tags, name];
    patch({ tags: next });
  };
  showMenu(anchor, [
    ...names.map((name) => {
      const l = labelFor(name, task.project_id);
      return { label: name, icon: `<span class="dot" style="--c:${esc(l?.color || 'var(--text-3)')}"></span>`, checked: have.has(name.toLowerCase()), onClick: () => toggle(name) };
    }),
    ...(names.length ? [{ divider: true }] : []),
    {
      label: t('Nova label…'),
      icon: ICON.plus,
      onClick: async () => {
        const { promptText } = await import('./ui.js');
        const name = await promptText({ title: t('Nova label'), label: t('Nome'), placeholder: t('ex.: frontend, urgente-cliente') });
        if (name) patch({ tags: [...task.tags, name] });
      },
    },
    ...(managing() ? [{
      label: t('Gerenciar labels e cores'),
      icon: ICON.gear,
      onClick: async () => {
        const pid = task.project_id;
        (await import('./projectsettings.js')).openProjectSettingsSection('labels');
        closeDrawer();
        navigate({ projectId: pid, view: 'project-settings' });
      },
    }] : []),
  ]);
}

async function shareTask() {
  const s = await attempt(() => api(`/api/tasks/${task.id}/shares`, { method: 'POST', body: {} }));
  if (!s) return;
  const link = `${location.origin}/s/${s.token}`;
  await navigator.clipboard.writeText(link).catch(() => {});
  toast(t('Link público copiado: {link}', { link }));
  refreshDrawer();
}

// O pedido que a pessoa cola numa sessão do Claude. Leva o número que aparece no cartão: o MCP
// entende tanto "#28" quanto o código do projeto ("WEB-12").
// O pedido é o mesmo para qualquer agente: texto puro, que funciona numa sessão do Claude ou do Codex.
const agentRequest = (x) => t('Resolva a tarefa {ref} do quadro de tarefas (“{title}”, projeto {project}). Leia os detalhes com get_task, marque como em andamento e, ao terminar, conclua com complete_tasks e uma nota do que foi feito.', { ref: taskRef(x), title: x.title, project: x.project_name });
const sendLabel = (key) => t('Mandar para o {agent}', { agent: AGENTS[key].name });

// Sem acesso à área de transferência (página fora de HTTPS, permissão negada), o texto vai no aviso.
async function copyText(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done);
  } catch {
    toast(text);
  }
}

function sendToAgent(key) {
  const x = task;
  const agent = AGENTS[key].name;
  return copyText(agentRequest(x), x.project_path
    ? t('Pedido copiado. Cole numa sessão do {agent} aberta em {path}', { agent, path: tilde(x.project_path) })
    : t('Pedido copiado. Cole numa sessão do {agent}', { agent }));
}

// Uma linha que abre a sessão do agente já na pasta do projeto, com o pedido.
const shellQuote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const copyTerminalCommand = (key) => copyText(`cd ${shellQuote(task.project_path)} && ${AGENTS[key].cli} ${shellQuote(agentRequest(task))}`, t('Comando copiado. Cole no Terminal'));

function moreMenu(anchor) {
  const x = task;
  const canEdit = editable();
  // No celular o botão do cabeçalho some (styles.css) e a ação fica aqui.
  const narrow = matchMedia('(max-width: 820px)').matches;
  showMenu(anchor, [
    ...(narrow ? [{ label: sendLabel('claude'), icon: ICON.claude, onClick: () => sendToAgent('claude') }] : []),
    { label: sendLabel('codex'), icon: ICON.codex, onClick: () => sendToAgent('codex') },
    ...(x.project_path ? Object.keys(AGENTS).map((key) => (
      { label: t('Copiar comando do Terminal ({agent})', { agent: AGENTS[key].name }), icon: ICON.command, onClick: () => copyTerminalCommand(key) })) : []),
    { divider: true },
    ...(canEdit ? [
      { label: t('Adicionar subtarefa'), icon: ICON.subtask, onClick: () => $('[data-form="subtask"] input')?.focus() },
      { label: x.timer_running ? t('Parar timer') : t('Iniciar timer'), icon: ICON.clock, onClick: () => timer(x.timer_running ? 'stop' : 'start') },
      { label: t('Criar link público de leitura'), icon: ICON.share, onClick: shareTask },
    ] : []),
    { label: t('Copiar link'), icon: ICON.link, onClick: () => navigator.clipboard.writeText(`${location.origin}/?task=${x.id}`).then(() => toast(t('Link copiado'))) },
    ...(canEdit ? [
      { divider: true },
      { label: x.archived_at ? t('Desarquivar') : t('Arquivar'), icon: ICON.archive, onClick: () => patch({ archived: !x.archived_at }) },
    ] : []),
    ...(managing() ? [{ label: t('Excluir tarefa'), icon: ICON.trash, danger: true, onClick: deleteTask }] : []),
  ], { align: 'right' });
}

async function timer(action) {
  const r = await attempt(() => api(`/api/tasks/${task.id}/timer`, { method: 'POST', body: { action } }), action === 'start' ? t('Timer iniciado') : t('Timer parado'));
  if (r) await refresh();
}

async function deleteTask() {
  const n = task.subtask_count;
  const ref = taskRef(task);
  const msg = n
    ? tn(n, 'Excluir a tarefa {ref} e {n} subtarefa? Não dá para desfazer.', 'Excluir a tarefa {ref} e {n} subtarefas? Não dá para desfazer.', { ref })
    : t('Excluir a tarefa {ref}? Não dá para desfazer.', { ref });
  if (!(await confirmAction(msg, { title: t('Excluir tarefa'), okLabel: t('Excluir') }))) return;
  const id = task.id;
  if (await attempt(() => api(`/api/tasks/${id}`, { method: 'DELETE' }), t('Tarefa excluída'))) {
    closeDrawer();
    load();
  }
}

function recurrenceFromForm() {
  const freq = $('#d-recur').value;
  if (!freq) return null;
  const r = { freq, interval: Number($('#d-interval')?.value) || 1 };
  const days = $$('[data-weekday]:checked').map((c) => Number(c.dataset.weekday));
  if (freq === 'weekly' && days.length) r.weekdays = days;
  const monthday = $('#d-monthday')?.value;
  if ((freq === 'monthly' || freq === 'quarterly') && monthday) r.monthday = monthday === 'last' ? 'last' : Number(monthday);
  if ($('#d-until')?.value) r.until = $('#d-until').value;
  if ($('#d-count')?.value) { r.count = Number($('#d-count').value); r.n = task.recurrence?.n || 1; }
  return r;
}

function fieldValue(fid) {
  const f = task.fields.find((x) => x.id === fid);
  if (f.type === 'multi_select') return $$(`[data-multifield="${fid}"] input:checked`).map((c) => c.value);
  const el = $(`#d-field-${fid}`);
  if (f.type === 'boolean') return el.checked;
  if (f.type === 'number') return el.value === '' ? null : Number(el.value);
  if (f.type === 'user') return el.value ? Number(el.value) : null;
  return el.value || null;
}

export function mountDrawer() {
  const d = drawer();
  d.inert = true;
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-labelledby', 'd-title');
  d.addEventListener('toggle', (e) => {
    if (!e.target.matches?.('.props-more')) return;
    moreOpen = e.target.open;
    try { localStorage.setItem('tk_more_props', moreOpen ? '1' : '0'); } catch {}
  }, true);
  bindEditor(d);

  d.onclick = async (e) => {
    const x = task;
    if (!x) return;
    const hit = (sel) => e.target.closest(sel);
    if (hit('[data-format]')) return;
    const check = hit('.desc .md-check');
    if (check && editable()) {
      e.stopPropagation();
      return toggleChecklist($$('.desc .md-check').indexOf(check));
    }
    if (hit('.desc a, .note-body a')) return;
    const open = hit('[data-open]');
    if (open) return openTask(Number(open.dataset.open));
    const proj = hit('[data-goproject]');
    if (proj) { closeDrawer(); return navigate({ projectId: Number(proj.dataset.goproject) }); }
    const unassign = hit('[data-unassign]');
    if (unassign) return patch({ assignee_ids: task.assignees.map((u) => u.id).filter((y) => y !== Number(unassign.dataset.unassign)) });
    const unwatch = hit('[data-unwatch]');
    if (unwatch) return patch({ watchers: task.watchers.map((u) => u.id).filter((y) => y !== Number(unwatch.dataset.unwatch)) });
    const untag = hit('[data-untag]');
    if (untag) return patch({ tags: task.tags.filter((g) => g !== untag.dataset.untag) });
    const subtoggle = hit('[data-subtoggle]');
    if (subtoggle) {
      const s = task.subtasks.find((y) => y.id === Number(subtoggle.dataset.subtoggle));
      await attempt(() => api(`/api/tasks/${s.id}`, { method: 'PATCH', body: { status: s.status === 'done' ? 'todo' : 'done' } }));
      return refresh();
    }
    const unblock = hit('[data-unblock]');
    if (unblock) {
      await attempt(() => api(`/api/tasks/${x.id}/blockers/${unblock.dataset.unblock}`, { method: 'DELETE' }));
      return refresh();
    }
    const deltime = hit('[data-deltime]');
    if (deltime) {
      await attempt(() => api(`/api/time/${deltime.dataset.deltime}`, { method: 'DELETE' }));
      return refresh();
    }
    const delfile = hit('[data-delfile]');
    if (delfile) {
      if (!(await confirmAction(t('Apagar este anexo?'), { okLabel: t('Apagar') }))) return;
      await attempt(() => api(`/api/attachments/${delfile.dataset.delfile}`, { method: 'DELETE' }));
      return refresh();
    }
    const copyShare = hit('[data-copyshare]');
    if (copyShare) return navigator.clipboard.writeText(`${location.origin}/s/${copyShare.dataset.copyshare}`).then(() => toast(t('Link copiado')));
    const revoke = hit('[data-revoke]');
    if (revoke) {
      if (!(await confirmAction(t('Revogar este link? Quem tiver o endereço perde o acesso.'), { okLabel: t('Revogar') }))) return;
      await attempt(() => api(`/api/shares/${revoke.dataset.revoke}`, { method: 'DELETE' }), t('Link revogado'));
      return refreshDrawer();
    }
    const tl = hit('[data-tlmode]');
    if (tl) { timelineMode = tl.dataset.tlmode; editingNote = null; replyTo = null; return renderSections(); }
    const reply = hit('[data-reply]');
    if (reply) { replyTo = Number(reply.dataset.reply); editingNote = null; render(); return; }
    if (hit('[data-cancelreply]')) { replyTo = null; return render(); }
    const sendReply = hit('[data-sendreply]');
    if (sendReply) return addComment($('#d-reply'), Number(sendReply.dataset.sendreply));
    const editNote = hit('[data-editnote]');
    if (editNote) { editingNote = Number(editNote.dataset.editnote); replyTo = null; return render(); }
    if (hit('[data-canceledit]')) { editingNote = null; return render(); }
    const saveEdit = hit('[data-saveedit]');
    if (saveEdit) {
      const body = $(`#d-edit-${saveEdit.dataset.saveedit}`).value.trim();
      if (!body) return;
      const r = await attempt(() => api(`/api/notes/${saveEdit.dataset.saveedit}`, { method: 'PATCH', body: { body } }));
      if (r) { editingNote = null; await refresh(); }
      return;
    }
    const delNote = hit('[data-delnote]');
    if (delNote) {
      if (!(await confirmAction(t('Excluir este comentário?'), { okLabel: t('Excluir') }))) return;
      await attempt(() => api(`/api/notes/${delNote.dataset.delnote}`, { method: 'DELETE' }), t('Comentário excluído'));
      return refresh();
    }
    const btn = hit('[data-action]');
    const action = btn?.dataset.action;
    if (!action) return;
    if (action === 'close') closeDrawer();
    if (action === 'more') moreMenu(btn);
    if (action === 'assign') peopleMenu(btn, new Set((task.assignees || []).map((u) => u.id)), (ids) => patch({ assignee_ids: ids }));
    if (action === 'watchers') peopleMenu(btn, new Set((task.watchers || []).map((u) => u.id)), (ids) => patch({ watchers: ids }));
    if (action === 'labels') labelsMenu(btn);
    if (action === 'watch') {
      const on = !task.watchers?.some((w) => w.id === state.me?.id);
      const r = await attempt(() => api(`/api/tasks/${x.id}/watch`, { method: 'POST', body: { on } }), on ? t('Você vai receber as novidades desta tarefa') : t('Você deixou de acompanhar'));
      if (r) refreshDrawer();
    }
    if (action === 'toggle-desc') {
      if (editingDesc) saveDescription();
      editingDesc = !editingDesc;
      render();
    }
    if (action === 'note') addComment($('#d-note'));
    if (action === 'complete') patch({ status: 'done' }, t('{ref} concluída', { ref: taskRef(x) }));
    if (action === 'reopen') patch({ status: 'todo' });
    if (action === 'archive') patch({ archived: !x.archived_at }, x.archived_at ? t('Tarefa desarquivada') : t('Tarefa arquivada'));
    if (action === 'delete') deleteTask();
    if (action === 'start' || action === 'stop') timer(action);
    if (action === 'time-form') { showTimeForm = !showTimeForm; renderSections(); $('[data-form="time"] input')?.focus(); }
    if (action === 'upload') $('#d-file').click();
    if (action === 'copy') sendToAgent('claude');
  };

  d.onchange = (e) => {
    if (!task) return;
    const el = e.target;
    const { id, value } = el;
    if (id === 'd-column') patch({ column: /^\d+$/.test(value) ? Number(value) : value });
    if (id === 'd-priority') patch({ priority: value });
    if (id === 'd-type') patch({ type: value });
    if (id === 'd-reporter') patch({ reporter_id: value ? Number(value) : null });
    if (id === 'd-start') patch({ start_date: value || null });
    if (id === 'd-due') patch({ due_date: value || null });
    if (id === 'd-points') patch({ story_points: value === '' ? null : Number(value) });
    if (id === 'd-sprint') patch({ sprint_id: value ? Number(value) : null });
    if (id === 'd-project') patch({ project_id: Number(value) }, t('Tarefa movida'));
    if (['d-recur', 'd-interval', 'd-monthday', 'd-until', 'd-count'].includes(id) || el.dataset.weekday != null) {
      patch({ recurrence: recurrenceFromForm() });
    }
    if (el.dataset.field) patch({ fields: { [el.dataset.field]: fieldValue(Number(el.dataset.field)) } });
    const multi = el.closest('[data-multifield]');
    if (multi) patch({ fields: { [multi.dataset.multifield]: fieldValue(Number(multi.dataset.multifield)) } });
    if (id === 'd-file') addFiles([...el.files]);
  };

  d.oninput = (e) => {
    if (e.target.id === 'd-title') autosize(e.target);
  };

  d.onfocusout = (e) => {
    if (!task) return;
    const { id, value } = e.target;
    if (id === 'd-title' && editable()) {
      const title = value.trim();
      if (!title) e.target.value = task.title;
      else if (title !== task.title) patch({ title });
    }
    if (id === 'd-estimate' && value.trim() !== (task.estimate_minutes ? fmtDuration(task.estimate_minutes) : '')) {
      patch({ estimate: value.trim() || null });
    }
    if (id === 'd-remaining' && value.trim() !== (task.remaining_minutes != null ? fmtDuration(task.remaining_minutes) : '')) {
      patch({ remaining: value.trim() || null });
    }
    if (id === 'd-desc') saveDescription();
  };

  d.onkeydown = (e) => {
    const cmdEnter = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    const id = e.target.id;
    if ((id === 'd-title' || id === 'd-estimate' || id === 'd-remaining') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
    if (id === 'd-note' && cmdEnter) addComment(e.target);
    if (id === 'd-reply' && cmdEnter) addComment(e.target, replyTo);
    if (e.target.dataset?.noteedit && cmdEnter) $(`[data-saveedit="${e.target.dataset.noteedit}"]`)?.click();
    if (id === 'd-desc' && (cmdEnter || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      saveDescription();
      editingDesc = false;
      render();
    }
  };

  d.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.dataset.form;
    const x = task;
    if (kind === 'subtask') {
      const title = form.elements.title.value.trim();
      if (!title) return;
      const r = await attempt(() => api('/api/tasks', { method: 'POST', body: { project_id: x.project_id, parent_id: x.id, title } }));
      if (r) { form.reset(); await refresh(); $('[data-form="subtask"] input')?.focus(); }
    }
    if (kind === 'blocker') {
      const ref = form.elements.ref.value.trim();
      const m = ref.match(/^#?(\d+)/) || ref.match(/^([A-Za-z][\w]*-\d+)/);
      const found = m ? m[1] : state.tasks.find((y) => y.title.toLowerCase() === ref.toLowerCase())?.id;
      if (!found) return toast(t('Informe o número da tarefa, ex.: #12'), true);
      const r = await attempt(() => api(`/api/tasks/${x.id}/blockers`, { method: 'POST', body: { blocked_by: found, type: form.elements.type.value } }));
      if (r) await refresh();
    }
    if (kind === 'time') {
      const f = form.elements;
      const r = await attempt(() => api(`/api/tasks/${x.id}/time`, { method: 'POST', body: { duration: f.duration.value, date: f.date.value, note: f.note.value } }), t('Tempo registrado'));
      if (r) { showTimeForm = false; await refresh(); }
    }
  };

  // Colar imagens na descrição ou nos comentários.
  d.addEventListener('paste', (e) => {
    const target = e.target.closest('#d-desc, #d-note, #d-reply, [data-noteedit]');
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!target || !files.length || !task || !editable()) return;
    e.preventDefault();
    addFiles(files, { insertInto: target });
  });

  // Arrastar arquivos para o painel.
  d.addEventListener('dragover', (e) => {
    if (task && editable() && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); d.classList.add('file-over'); }
  });
  d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) d.classList.remove('file-over'); });
  d.addEventListener('drop', (e) => {
    d.classList.remove('file-over');
    if (!task || !editable() || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });
}
