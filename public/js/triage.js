// Triagem guiada: uma tarefa nova por vez, com atalhos de uma tecla, para decidir prioridade,
// responsável, sprint e prazo do que chegou (quase sempre pelo Claude) e terminar com a fila zerada.
// As mudanças valem na hora, como no detalhe da tarefa; "Aceitar" só a tira da lista de novidades.
import { api } from './api.js';
import { openTask } from './drawer.js';
import { t, tn } from './i18n.js';
import { emit, load, markSeen, state, subscribe, taskById, triageable } from './state.js';
import { ICON, PRIORITIES, PRIORITY_LABEL, TYPE_LABEL, ago, esc, md, prioIcon, projectBadge, taskRef, typeIcon } from './util.js';

let dialog = null;
let queue = [];
let index = 0;
let entering = false;
// O que aconteceu com cada tarefa: 'accepted', 'archived' ou 'skipped'.
let outcome = new Map();
let notice = null;
let undoId = null;
// Sprint ativa por projeto, descoberta pelo detalhe da primeira tarefa de cada um.
let sprints = new Map();

const available = (id) => { const x = taskById(id); return x && !x.archived_at ? x : null; };
const current = () => available(queue[index]);
const box = () => dialog.querySelector('.triage-box');

// O dialog fica por cima de tudo, então os avisos aparecem dentro dele, não no toast da página.
function say(text, { error = false, undo = null } = {}) {
  notice = text ? { text, error } : null;
  undoId = undo;
  dialog.querySelector('#triage-live').textContent = text || '';
}

const noticeInner = () => `${notice ? `<span>${esc(notice.text)}</span>` : ''}${undoId ? `<button type="button" class="link-btn" data-t="undo">${t('Desfazer')}<kbd>Z</kbd></button>` : ''}`;
const noticeHtml = () => `<div class="triage-notice ${notice?.error ? 'error' : ''}">${noticeInner()}</div>`;

function fieldsHtml(x) {
  const mine = x.assignee_ids.includes(state.me?.id);
  const sprint = sprints.get(x.project_id);
  const inSprint = sprint && x.sprint_id === sprint.id;
  return `
    <div class="triage-prio" role="group" aria-label="${esc(t('Prioridade'))}">
      ${PRIORITIES.map((p, i) => `<button type="button" data-t="prio-${p}" data-prio="${p}" aria-pressed="${x.priority === p}">${prioIcon(p)}<span>${esc(PRIORITY_LABEL[p])}</span><kbd>${i + 1}</kbd></button>`).join('')}
    </div>
    <div class="triage-row">
      <button type="button" class="btn ghost bordered" data-t="me" aria-pressed="${mine}">${mine ? ICON.check : ICON.user}${t('Atribuir a mim')}<kbd>I</kbd></button>
      ${sprint ? `<button type="button" class="btn ghost bordered" data-t="sprint" aria-pressed="${!!inSprint}" title="${esc(t('Sprint ativa'))}">${inSprint ? ICON.check : ICON.target}<span class="triage-clip">${esc(sprint.name)}</span><kbd>S</kbd></button>` : ''}
      <label class="triage-date">${ICON.calendar}<span>${t('Prazo')}</span><input type="date" id="triage-due" value="${esc(x.due_date || '')}"><kbd>D</kbd></label>
    </div>`;
}

function taskHtml(x) {
  const position = t('{i} de {n}', { i: index + 1, n: queue.length });
  return `
    <header class="triage-head">
      <span class="ember" aria-hidden="true">${ICON.sparkles}</span>
      <h2 id="triage-title">${t('Triagem')}</h2>
      <span class="triage-count">${esc(position)}</span>
      <span class="spacer"></span>
      <button type="button" class="btn ghost small" data-t="open">${t('Abrir detalhes')}<kbd>O</kbd></button>
      <button type="button" class="icon-btn small" data-t="close" aria-label="${esc(t('Fechar'))}">${ICON.close}</button>
    </header>
    <div class="triage-progress" aria-hidden="true"><span style="width:${(index / queue.length) * 100}%"></span></div>
    <article class="triage-task ${entering ? 'enter' : ''}">
      <div class="triage-meta">
        ${x.project_name ? `<span class="triage-project">${projectBadge(state.projects.find((p) => p.id === x.project_id) || {})}${esc(x.project_name)}</span>` : ''}
        <span class="tid">${esc(taskRef(x))}</span>
        <span class="triage-type">${typeIcon(x.type, { always: true })}${esc(TYPE_LABEL[x.type] || '')}</span>
        ${x.source === 'claude' ? `<span class="by claude">${ICON.claude}${t('Registrada pelo Claude')}</span>` : ''}
        <span>${esc(ago(x.created_at))}</span>
      </div>
      <h3>${esc(x.title)}</h3>
      ${x.description ? `<div class="triage-desc md">${md(x.description)}</div>` : `<p class="triage-desc empty">${t('Sem descrição.')}</p>`}
      ${x.tags.length ? `<div class="triage-tags">${x.tags.map((g) => `<span class="chip tag">${esc(g)}</span>`).join('')}</div>` : ''}
    </article>
    <section class="triage-fields" aria-label="${esc(t('Decisões da triagem'))}">${fieldsHtml(x)}</section>
    <footer class="triage-foot">
      ${noticeHtml()}
      <button type="button" class="btn ghost" data-t="archive">${ICON.archive}${t('Arquivar')}<kbd>⌫</kbd></button>
      ${index > 0 ? `<button type="button" class="btn ghost" data-t="back">${t('Voltar')}<kbd>←</kbd></button>` : ''}
      <button type="button" class="btn ghost bordered" data-t="skip">${t('Pular')}<kbd>→</kbd></button>
      <button type="button" class="btn primary" data-t="accept">${ICON.check}${t('Aceitar')}<kbd>↵</kbd></button>
    </footer>`;
}

function doneHtml() {
  const count = (kind) => [...outcome.values()].filter((v) => v === kind).length;
  const left = skippedIds().length;
  const summary = [
    count('accepted') ? tn(count('accepted'), '{n} aceita', '{n} aceitas') : '',
    count('archived') ? tn(count('archived'), '{n} arquivada', '{n} arquivadas') : '',
    left ? tn(left, '{n} pulada', '{n} puladas') : '',
  ].filter(Boolean).join(' · ');
  return `
    <div class="triage-done">
      <span class="ember" aria-hidden="true">${left ? ICON.sparkles : ICON.check}</span>
      <h2 id="triage-title">${left ? t('Só falta o que você pulou') : t('Triagem zerada')}</h2>
      <p>${esc(summary)}</p>
      ${noticeHtml()}
      <div class="triage-done-actions">
        <button type="button" class="btn ghost" data-t="back">${t('Voltar')}<kbd>←</kbd></button>
        ${left ? `<button type="button" class="btn ghost" data-t="close">${t('Fechar')}</button><button type="button" class="btn primary" data-t="again">${t('Revisar as puladas')}<kbd>↵</kbd></button>` : `<button type="button" class="btn primary" data-t="close">${t('Fechar')}<kbd>↵</kbd></button>`}
      </div>
    </div>`;
}

const skippedIds = () => queue.filter((id) => outcome.get(id) === 'skipped' && available(id));

function paint() {
  if (!dialog) return;
  const active = document.activeElement;
  // Não redesenha debaixo de quem está escolhendo a data: só atualiza o aviso.
  if (active?.id === 'triage-due') {
    dialog.querySelector('.triage-notice').innerHTML = noticeInner();
    return;
  }
  const focusKey = dialog.contains(active) ? active.dataset?.t : null;
  const x = current();
  box().innerHTML = x ? taskHtml(x) : doneHtml();
  entering = false;
  const again = focusKey && box().querySelector(`[data-t="${focusKey}"]`);
  if (again) again.focus();
  else if (active !== dialog) dialog.focus();
  if (x) loadSprint(x);
}

async function loadSprint(x) {
  if (sprints.has(x.project_id)) return;
  sprints.set(x.project_id, null);
  const full = await api(`/api/tasks/${x.id}`).catch(() => null);
  const active = (full?.sprints || []).find((s) => s.status === 'active');
  if (!active) return;
  sprints.set(x.project_id, active);
  if (current()?.project_id === x.project_id) paint();
}

// Vai para a próxima (ou anterior) tarefa que ainda existe; depois da última, o resumo.
function go(delta) {
  let i = index + delta;
  while (i >= 0 && i < queue.length && !available(queue[i])) i += delta;
  if (i < 0) return;
  index = Math.min(i, queue.length);
  entering = true;
  const x = current();
  paint();
  dialog.querySelector('#triage-live').textContent = x ? `${t('{i} de {n}', { i: index + 1, n: queue.length })}: ${x.title}` : box().querySelector('h2').textContent;
}

async function change(body, message) {
  const x = current();
  if (!x) return;
  Object.assign(x, body);
  say(message);
  paint();
  try {
    await api(`/api/tasks/${x.id}`, { method: 'PATCH', body });
  } catch (e) {
    say(e.message, { error: true });
    await load().catch(() => {});
    paint();
  }
}

function setPriority(p) {
  change({ priority: p }, t('Prioridade: {p}', { p: PRIORITY_LABEL[p] }));
}

function toggleMine() {
  const x = current();
  const me = state.me?.id;
  if (!x || !me) return;
  const mine = x.assignee_ids.includes(me);
  change({ assignee_ids: mine ? x.assignee_ids.filter((id) => id !== me) : [...x.assignee_ids, me] }, mine ? t('Tirada de você') : t('Atribuída a você'));
}

function toggleSprint() {
  const x = current();
  const sprint = x && sprints.get(x.project_id);
  if (!sprint) return;
  const inside = x.sprint_id === sprint.id;
  change({ sprint_id: inside ? null : sprint.id }, inside ? t('Fora da sprint') : t('Na sprint {name}', { name: sprint.name }));
}

function focusDue() {
  const input = dialog.querySelector('#triage-due');
  if (!input) return;
  input.focus();
  try { input.showPicker(); } catch {}
}

function accept() {
  const x = current();
  if (!x) return;
  outcome.set(x.id, 'accepted');
  say('');
  markSeen(x.id);
  go(1);
}

function skip() {
  const x = current();
  if (!x) return;
  if (outcome.get(x.id) !== 'accepted') outcome.set(x.id, 'skipped');
  say('');
  go(1);
}

async function archive() {
  const x = current();
  if (!x) return;
  const ref = taskRef(x);
  outcome.set(x.id, 'archived');
  x.archived_at = new Date().toISOString();
  say(t('{ref} arquivada', { ref }), { undo: x.id });
  go(1);
  try {
    await api(`/api/tasks/${x.id}`, { method: 'PATCH', body: { archived: true } });
  } catch (e) {
    outcome.delete(x.id);
    say(e.message, { error: true });
    await load().catch(() => {});
    paint();
  }
}

async function undoArchive() {
  const id = undoId;
  if (!id) return;
  say('');
  try {
    await api(`/api/tasks/${id}`, { method: 'PATCH', body: { archived: false } });
    await load();
    outcome.delete(id);
    index = Math.max(0, queue.indexOf(id));
    entering = true;
  } catch (e) {
    say(e.message, { error: true });
  }
  paint();
}

function reviewSkipped() {
  queue = skippedIds();
  index = 0;
  entering = true;
  say('');
  paint();
}

function details() {
  const x = current();
  if (!x) return;
  const { id } = x;
  closeTriage();
  openTask(id);
}

const ACTIONS = {
  close: () => closeTriage(), open: details, accept, skip, archive, back: () => { say(''); go(-1); },
  undo: undoArchive, again: reviewSkipped, me: toggleMine, sprint: toggleSprint,
};

function onClick(e) {
  if (e.target === dialog) return closeTriage();
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  // Com o mouse, o foco volta para o dialog e as teclas continuam valendo; pelo teclado, fica no botão.
  if (e.detail > 0) dialog.focus();
  if (b.dataset.prio) return setPriority(b.dataset.prio);
  ACTIONS[b.dataset.t]?.();
}

function onChange(e) {
  if (e.target.id !== 'triage-due') return;
  const { value } = e.target;
  change({ due_date: value || null }, value ? t('Prazo definido') : t('Prazo removido'));
}

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.id === 'triage-due') {
    if (e.key === 'Enter' || e.key === 'Escape') {
      e.preventDefault();
      dialog.focus();
      paint();
    }
    return;
  }
  const onButton = e.target !== dialog && e.target.matches?.('button');
  if ((e.key === 'Enter' || e.key === ' ') && onButton) return;
  const x = current();
  const key = e.key.toLowerCase();
  if (e.key === 'Enter') { e.preventDefault(); return x ? accept() : skippedIds().length ? reviewSkipped() : closeTriage(); }
  if (key === 'z' && undoId) return void undoArchive();
  if (e.key === 'ArrowLeft') { e.preventDefault(); say(''); return go(-1); }
  if (!x) return;
  const p = ['1', '2', '3', '4', '5'].indexOf(key);
  if (p >= 0) return setPriority(PRIORITIES[p]);
  if (key === 'i') return toggleMine();
  if (key === 's') return toggleSprint();
  if (key === 'd') { e.preventDefault(); return focusDue(); }
  if (key === 'o') return details();
  if (e.key === 'Backspace') { e.preventDefault(); return void archive(); }
  if (e.key === 'ArrowRight') { e.preventDefault(); return skip(); }
}

// Mudanças de fora (o Claude, outra pessoa) aparecem na tarefa aberta.
subscribe((what) => { if (what === 'data') paint(); });

export function closeTriage() {
  if (!dialog) return;
  dialog.close();
  dialog.remove();
  dialog = null;
  if (state.onlyNew && !triageable().length) {
    state.onlyNew = false;
    emit('filter');
  }
  // O botão que abriu a triagem pode ter sido redesenhado: o foco não fica perdido na página.
  if (document.activeElement === document.body) document.querySelector('[data-since="triage"], #since-bar button, [data-action="new-task"]')?.focus();
}

export function openTriage() {
  if (dialog) return;
  queue = triageable().map((x) => x.id);
  if (!queue.length) return;
  index = 0;
  entering = true;
  outcome = new Map();
  sprints = new Map();
  notice = null;
  undoId = null;
  dialog = document.createElement('dialog');
  dialog.className = 'triage';
  dialog.tabIndex = -1;
  dialog.setAttribute('aria-labelledby', 'triage-title');
  dialog.innerHTML = '<div class="triage-box"></div><div class="sr-only" id="triage-live" role="status"></div>';
  document.body.append(dialog);
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('change', onChange);
  dialog.addEventListener('keydown', onKey);
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeTriage(); });
  dialog.showModal();
  dialog.focus();
  paint();
}
