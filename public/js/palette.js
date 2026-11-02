// Paleta de comandos (⌘K / Ctrl+K / K): busca em tarefas, comentários, projetos, sprints,
// labels, pessoas e workspaces, e atalhos para as páginas e ações do painel.
import { api } from './api.js';
import { openTask } from './drawer.js';
import { t, tn } from './i18n.js';
import { TASK_VIEWS, can, isAdmin, navigate, singleKeys, state, triageable } from './state.js';
import { ICON, avatar, debounce, esc, projectBadge, statusIcon, taskRef } from './util.js';

let dialog = null;

function commands() {
  const go = (view, extra = {}) => () => navigate({ view, ...extra });
  const list = [
    { label: t('Nova tarefa'), icon: ICON.plus, hint: 'N', run: () => import('./taskform.js').then((m) => m.openNewTask()), when: state.me?.role !== 'viewer' && (!state.projectId || can(state.projectId, 'edit')) },
    { label: t('Revisar as novas'), icon: ICON.sparkles, run: () => import('./triage.js').then((m) => m.openTriage()), when: triageable().length > 0 },
    { label: t('Novo projeto'), icon: ICON.folder, run: () => import('./shell.js').then((m) => m.newProject()), when: state.me?.role !== 'viewer' },
    { label: t('Chat com o Claude'), icon: ICON.sparkles, hint: 'C', run: () => import('./chat.js').then((m) => m.toggleChat()), when: state.me?.role !== 'viewer' },
    { label: t('Todas as tarefas'), icon: ICON.grid, run: go(TASK_VIEWS.includes(state.view) ? state.view : 'board', { projectId: null, workspaceId: null, assignee: '' }) },
    { label: t('Minhas tarefas'), icon: ICON.user, run: go('list', { projectId: null, workspaceId: null, assignee: 'me' }) },
    { label: t('Quadro'), icon: ICON.board, hint: '1', run: go('board') },
    { label: t('Lista'), icon: ICON.list, hint: '2', run: go('list') },
    { label: t('Calendário'), icon: ICON.calendar, hint: '3', run: go('calendar') },
    { label: t('Gantt'), icon: ICON.gantt, hint: '4', run: go('gantt') },
    { label: t('Dashboard'), icon: ICON.dashboard, hint: '5', run: go('dashboard') },
    { label: t('Atividade'), icon: ICON.history, run: go('activity', { projectId: null }) },
    { label: t('Automações'), icon: ICON.zap, run: go('automations', { projectId: null }) },
    { label: t('Equipe'), icon: ICON.users, run: go('team', { projectId: null }) },
    { label: t('Organizações'), icon: ICON.building, run: go('organizations', { projectId: null }) },
    { label: t('Configurações do projeto'), icon: ICON.gear, run: go('project-settings'), when: !!state.projectId },
    { label: t('Configurações'), icon: ICON.gear, run: go('settings', { projectId: null }), when: isAdmin() },
    { label: t('Administração'), icon: ICON.shield, run: go('admin', { projectId: null }), when: isAdmin() },
    { label: t('Minha conta e preferências'), icon: ICON.user, run: go('account', { projectId: null }) },
    { label: t('Documentação da API'), icon: ICON.code, run: () => window.open('/docs/api', '_blank', 'noopener') },
  ];
  return list.filter((c) => c.when !== false);
}

const norm = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function localMatches(q) {
  const n = norm(q);
  const cmds = commands().filter((c) => !n || norm(c.label).includes(n));
  const projects = n ? state.projects.filter((p) => norm(`${p.name} ${p.key || ''}`).includes(n)).slice(0, 6) : [];
  return { cmds, projects };
}

let seq = 0;
function section(title, rows) {
  if (!rows.length) return '';
  const id = `pal-sec-${++seq}`;
  return `<div role="group" aria-labelledby="${id}"><div class="pal-section" id="${id}">${esc(title)}</div>${rows.join('')}</div>`;
}

function row(kind, id, icon, label, hint = '', extra = '') {
  return `<button type="button" class="pal-item" role="option" tabindex="-1" aria-selected="false" id="pal-opt-${++seq}" data-kind="${kind}" data-id="${esc(id)}" ${extra}>
    <span class="pal-icon">${icon}</span><span class="pal-label">${label}</span>${hint ? `<span class="pal-hint">${hint}</span>` : ''}
  </button>`;
}

function render(results, q) {
  const { cmds, projects } = localMatches(q);
  const r = results || {};
  const html = [
    section(t('Tarefas'), (r.tasks || []).map((x) => row('task', x.id, statusIcon(x.status), `<b class="mono">${esc(taskRef(x))}</b> ${esc(x.title)}`, esc(x.project_name)))),
    section(t('Projetos'), [...new Map([...projects, ...(r.projects || [])].map((p) => [p.id, p])).values()].slice(0, 6)
      .map((p) => row('project', p.id, projectBadge(state.projects.find((x) => x.id === p.id) || p), esc(p.name), p.key ? esc(p.key) : ''))),
    section(t('Comentários'), (r.comments || []).map((c) => row('task', c.task_id, ICON.comment, esc(c.body.slice(0, 90)), esc(c.title)))),
    section(t('Sprints'), (r.sprints || []).map((s) => row('sprint', s.id, ICON.target, esc(s.name), esc(s.project_name), `data-project="${s.project_id}"`))),
    section(t('Labels'), (r.labels || []).map((l) => row('label', l.name, `<span class="dot" style="--c:${esc(l.color || 'var(--text-3)')}"></span>`, esc(l.name), '', `data-project="${l.project_id || ''}"`))),
    section(t('Pessoas'), (r.people || []).map((u) => row('person', u.id, avatar(u, { size: 18 }), esc(u.name), esc(u.email)))),
    section(t('Workspaces'), (r.workspaces || []).map((w) => row('workspace', w.id, ICON.layers, esc(w.name)))),
    section(t('Ações e páginas'), cmds.map((c, i) => row('cmd', i, c.icon, esc(c.label), c.hint && singleKeys() ? `<kbd>${esc(c.hint)}</kbd>` : ''))),
  ].join('');
  const list = dialog.querySelector('.pal-list');
  list.innerHTML = html || `<div class="pal-empty">${esc(t('Nada encontrado para “{q}”', { q }))}</div>`;
  setActive(list.querySelector('.pal-item'));
  list._cmds = cmds;
  const count = list.querySelectorAll('.pal-item').length;
  dialog.querySelector('input').setAttribute('aria-expanded', String(count > 0));
  dialog.querySelector('.pal-status').textContent = q.trim() ? tn(count, '{n} resultado', '{n} resultados') : '';
}

// A opção ativa é só uma marca: o foco fica no campo, e o leitor de tela acompanha pelo aria-activedescendant.
function setActive(item) {
  const on = dialog.querySelector('.pal-item.on');
  on?.classList.remove('on');
  on?.setAttribute('aria-selected', 'false');
  const input = dialog.querySelector('input');
  if (!item) return input.removeAttribute('aria-activedescendant');
  item.classList.add('on');
  item.setAttribute('aria-selected', 'true');
  input.setAttribute('aria-activedescendant', item.id);
}

function choose(item) {
  const { kind, id } = item.dataset;
  const cmds = dialog.querySelector('.pal-list')._cmds;
  closePalette();
  if (kind === 'cmd') return cmds[Number(id)].run();
  if (kind === 'task') return openTask(Number(id));
  if (kind === 'project') return navigate({ projectId: Number(id), view: TASK_VIEWS.includes(state.view) ? state.view : 'board' });
  if (kind === 'sprint') return navigate({ projectId: Number(item.dataset.project), view: 'board', sprint: String(id) });
  if (kind === 'label') {
    state.tag = id;
    const patch = { view: TASK_VIEWS.includes(state.view) ? state.view : 'list' };
    if (item.dataset.project) patch.projectId = Number(item.dataset.project);
    return navigate(patch);
  }
  if (kind === 'person') return navigate({ projectId: null, workspaceId: null, view: 'list', assignee: String(id) === String(state.me?.id) ? 'me' : String(id) });
  if (kind === 'workspace') return navigate({ projectId: null, workspaceId: Number(id), view: TASK_VIEWS.includes(state.view) ? state.view : 'board' });
}

function move(delta) {
  const items = [...dialog.querySelectorAll('.pal-item')];
  if (!items.length) return;
  const i = items.findIndex((x) => x.classList.contains('on'));
  const next = items[(i + delta + items.length) % items.length];
  setActive(next);
  next.scrollIntoView({ block: 'nearest' });
}

export function closePalette() {
  dialog?.close();
  dialog?.remove();
  dialog = null;
}

export function openPalette() {
  if (dialog) return dialog.querySelector('input').focus();
  dialog = document.createElement('dialog');
  dialog.className = 'palette';
  dialog.setAttribute('aria-label', t('Paleta de comandos'));
  const hint = t('Buscar tarefas, projetos, pessoas… ou digite um comando');
  dialog.innerHTML = `
    <div class="pal-box">
      <label class="pal-search">${ICON.search}<input type="search" role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" aria-label="${esc(hint)}" placeholder="${esc(hint)}" autocomplete="off" spellcheck="false"><kbd>esc</kbd></label>
      <div class="pal-list" id="pal-list" role="listbox" aria-label="${esc(t('Resultados'))}"></div>
      <div class="sr-only pal-status" role="status"></div>
    </div>`;
  document.body.append(dialog);
  const input = dialog.querySelector('input');
  let latest = 0;
  const search = debounce(async (q) => {
    const mine = ++latest;
    const results = q.trim().length >= 2 ? await api(`/api/search?q=${encodeURIComponent(q.trim())}`).catch(() => null) : null;
    if (dialog && mine === latest) render(results, q);
  }, 140);
  input.oninput = () => { render(null, input.value); search(input.value); };
  dialog.onkeydown = (e) => {
    // No campo de busca o Esc só limparia o texto; aqui fecha a paleta direto.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); return closePalette(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const on = dialog.querySelector('.pal-item.on');
      if (on) choose(on);
    }
  };
  dialog.onclick = (e) => {
    const item = e.target.closest('.pal-item');
    if (item) return choose(item);
    if (e.target === dialog) closePalette();
  };
  dialog.onmousemove = (e) => {
    const item = e.target.closest('.pal-item');
    if (!item || item.classList.contains('on')) return;
    setActive(item);
  };
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); closePalette(); });
  dialog.showModal();
  render(null, '');
  input.focus();
}
