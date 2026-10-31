// Estrutura fixa do app: barra lateral, cabeçalho, abas, filtros, notificações e timer.
import { api, attempt, toast } from './api.js';
import { closeDrawer, openTask } from './drawer.js';
import { openSprints } from './sprints.js';
import { state, navigate, load, currentProject, activeFilterCount, emit, TASK_VIEWS } from './state.js';
import { openNewTask } from './taskform.js';
import { confirmAction, openDialog, showMenu } from './ui.js';
import {
  $, ICON, PRIORITIES, PRIORITY_LABEL, TYPES, TYPE_LABEL, ago, avatar, debounce, esc, fmtClock, projectColor, tilde,
} from './util.js';

const PROJECT_COLORS = ['#d97757', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300', '#7c7c84'];

const TABS = [
  ['board', 'Quadro', ICON.board],
  ['list', 'Lista', ICON.list],
  ['calendar', 'Calendário', ICON.calendar],
  ['gantt', 'Gantt', ICON.gantt],
  ['dashboard', 'Dashboard', ICON.dashboard],
];

export function mountShell(root) {
  root.innerHTML = `
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8"/><path d="M9 16.5l4.5 4.5L23 11.5"/></svg></span>
          <div><div class="brand-name">Tarefas</div><div class="brand-sub">todos os projetos</div></div>
        </div>
        <nav class="nav" id="nav" aria-label="Navegação"></nav>
        <div class="sidebar-foot" id="sidebar-foot"></div>
      </aside>
      <div class="sidebar-scrim" id="sidebar-scrim"></div>
      <main class="main">
        <header class="topbar">
          <div class="topbar-row">
            <button class="icon-btn menu-btn" id="menu-btn" aria-label="Abrir menu">${ICON.menu}</button>
            <div class="heading" id="heading"></div>
            <div class="top-actions" id="top-actions"></div>
          </div>
          <div class="topbar-row toolbar" id="toolbar"></div>
        </header>
        <section class="view" id="view"></section>
      </main>
      <aside class="chat" id="chat" aria-label="Chat com o Claude"></aside>
    </div>
    <div class="drawer-scrim" id="drawer-scrim"></div>
    <aside class="drawer" id="drawer" aria-label="Detalhes da tarefa" aria-hidden="true"><div class="drawer-inner" id="drawer-inner"></div></aside>`;

  $('#menu-btn').onclick = () => toggleSidebar(true);
  $('#sidebar-scrim').onclick = () => toggleSidebar(false);
  $('#drawer-scrim').onclick = closeDrawer;
  $('#nav').onclick = onNavClick;
  $('#sidebar-foot').onclick = onFootClick;
  $('#heading').onclick = onHeadingClick;
  $('#top-actions').onclick = onActionsClick;
  $('#toolbar').onclick = onToolbarClick;
  $('#toolbar').oninput = debounce((e) => {
    if (e.target.id === 'search') { state.q = e.target.value; emit('filter'); }
  }, 120);
  $('#toolbar').onchange = (e) => {
    if (e.target.id === 'sprint-select') navigate({ sprint: e.target.value });
  };
  setInterval(tickTimer, 1000);
}

export function toggleSidebar(open) {
  $('#sidebar').classList.toggle('open', open);
  $('#sidebar-scrim').classList.toggle('show', open);
}

export function renderShell() {
  renderNav();
  renderFoot();
  renderHeading();
  renderActions();
  renderToolbar();
}

// ---------- barra lateral ----------

function renderNav() {
  const active = state.projects.filter((p) => !p.archived_at);
  const archived = state.projects.filter((p) => p.archived_at);
  const open = active.reduce((n, p) => n + p.open, 0);
  const isPage = (v) => state.view === v && !state.projectId;
  const mine = state.users.length > 1;
  const item = (p) => `
    <button class="nav-item ${p.id === state.projectId ? 'active' : ''} ${p.open ? '' : 'idle'}" data-project="${p.id}" title="${esc(p.path ? tilde(p.path) : p.name)}">
      <span class="dot" style="--c:${projectColor(p)}"></span>
      <span class="nav-label">${esc(p.name)}</span>
      ${p.overdue ? `<span class="nav-alert" title="${p.overdue} atrasada(s)">${p.overdue}</span>` : ''}
      <span class="nav-count">${p.open || ''}</span>
    </button>`;
  $('#nav').innerHTML = `
    <button class="nav-item ${isPage('dashboard') ? 'active' : ''}" data-go="dashboard"><span class="nav-icon">${ICON.dashboard}</span><span class="nav-label">Dashboard</span></button>
    <button class="nav-item ${!state.projectId && TASK_VIEWS.includes(state.view) && state.assignee !== 'me' ? 'active' : ''}" data-go="all">
      <span class="nav-icon">${ICON.grid}</span><span class="nav-label">Todas as tarefas</span><span class="nav-count">${open || ''}</span>
    </button>
    ${mine ? `<button class="nav-item ${!state.projectId && state.assignee === 'me' && TASK_VIEWS.includes(state.view) ? 'active' : ''}" data-go="mine">
      <span class="nav-icon">${ICON.user}</span><span class="nav-label">Minhas tarefas</span>
      <span class="nav-count">${state.tasks.filter((t) => t.status !== 'done' && t.assignee_ids.includes(state.me?.id)).length || ''}</span>
    </button>` : ''}
    <div class="nav-heading">Projetos <button class="icon-btn tiny" data-go="new-project" title="Novo projeto" aria-label="Novo projeto">${ICON.plus}</button></div>
    ${active.map(item).join('') || '<div class="nav-empty">Nenhum projeto ainda</div>'}
    ${archived.length ? `
      <button class="nav-heading toggle" data-go="toggle-archived">${state.showArchivedProjects ? ICON.down : ICON.right} Arquivados (${archived.length})</button>
      ${state.showArchivedProjects ? archived.map(item).join('') : ''}` : ''}`;
}

function renderFoot() {
  const me = state.me;
  const page = (v, icon, label) => `<button class="nav-item ${state.view === v ? 'active' : ''}" data-go="${v}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span></button>`;
  $('#sidebar-foot').innerHTML = `
    ${page('automations', ICON.zap, 'Automações')}
    ${page('team', ICON.users, 'Equipe')}
    ${page('settings', ICON.gear, 'Configurações')}
    <div class="foot-row">
      <button class="user-chip" data-go="user-menu">${avatar(me, { size: 24 })}<span>${esc(me?.name || '')}</span>${ICON.down}</button>
      <div class="live" title="Atualização automática"><span class="live-dot"></span><span>ao vivo</span></div>
    </div>`;
}

function onNavClick(e) {
  const b = e.target.closest('[data-project], [data-go]');
  if (!b) return;
  if (b.dataset.project) {
    toggleSidebar(false);
    const view = TASK_VIEWS.includes(state.view) || state.view === 'dashboard' ? state.view : 'board';
    return navigate({ projectId: Number(b.dataset.project), view, assignee: state.assignee === 'me' ? '' : state.assignee });
  }
  const go = b.dataset.go;
  toggleSidebar(false);
  if (go === 'dashboard') navigate({ projectId: null, view: 'dashboard' });
  if (go === 'all') navigate({ projectId: null, view: TASK_VIEWS.includes(state.view) ? state.view : 'board', assignee: '' });
  if (go === 'mine') navigate({ projectId: null, view: TASK_VIEWS.includes(state.view) ? state.view : 'list', assignee: 'me' });
  if (go === 'new-project') newProject();
  if (go === 'toggle-archived') { state.showArchivedProjects = !state.showArchivedProjects; renderNav(); }
}

function onFootClick(e) {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  const go = b.dataset.go;
  if (go === 'user-menu') {
    return showMenu(b, [
      { label: 'Minha conta', icon: ICON.user, onClick: () => navigate({ projectId: null, view: 'account' }) },
      { divider: true },
      { label: 'Sair', icon: ICON.logout, onClick: logout },
    ]);
  }
  toggleSidebar(false);
  navigate({ projectId: null, view: go });
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: {} });
  location.href = '/';
}

export function newProject() {
  openDialog({
    title: 'Novo projeto',
    submitLabel: 'Criar projeto',
    body: `
      <label class="field"><span>Nome</span><input class="input" name="name" required maxlength="120" placeholder="ex.: Pessoal, Site, App"></label>
      <label class="field"><span>Descrição</span><textarea class="input" name="description" rows="2"></textarea></label>
      <div class="field"><span>Cor</span>${swatches(PROJECT_COLORS[0])}</div>
      <p class="hint">Projetos de pasta (repositórios) são criados sozinhos quando o Claude registra uma tarefa neles.</p>`,
    onSubmit: async (form) => {
      const f = form.elements;
      const p = await attempt(() => api('/api/projects', { method: 'POST', body: { name: f.name.value, description: f.description.value, color: f.color.value } }));
      if (!p) return false;
      await load();
      navigate({ projectId: p.id, view: 'board' });
    },
  });
}

export function swatches(selected) {
  return `<div class="swatches">${PROJECT_COLORS.map((c) => `
    <label class="swatch" style="--c:${c}"><input type="radio" name="color" value="${c}" ${c === selected ? 'checked' : ''}><span></span></label>`).join('')}</div>`;
}

// ---------- cabeçalho ----------

const PAGE_TITLES = {
  dashboard: ['Dashboard', 'Visão geral de todos os projetos'],
  automations: ['Automações', 'Regras que agem sozinhas quando algo acontece no quadro'],
  team: ['Equipe', 'Membros, convites e permissões'],
  settings: ['Configurações', 'Preferências do quadro'],
  account: ['Minha conta', 'Seu perfil e senha'],
};

function renderHeading() {
  const p = currentProject();
  let title;
  let sub;
  if (p) {
    title = p.name;
    sub = p.path ? tilde(p.path) : (p.description || 'sem pasta vinculada');
  } else if (PAGE_TITLES[state.view]) {
    [title, sub] = PAGE_TITLES[state.view];
  } else {
    const open = state.projects.reduce((n, x) => n + (x.archived_at ? 0 : x.open), 0);
    title = state.assignee === 'me' ? 'Minhas tarefas' : 'Todas as tarefas';
    sub = `${state.projects.filter((x) => !x.archived_at).length} projetos · ${open} ${open === 1 ? 'tarefa aberta' : 'tarefas abertas'}`;
  }
  $('#heading').innerHTML = `
    <div class="heading-row">
      ${p ? `<span class="heading-dot" style="--c:${projectColor(p)}"></span>` : ''}
      <h1>${esc(title)}</h1>
      ${p?.archived_at ? '<span class="chip">arquivado</span>' : ''}
      ${p ? `<button class="icon-btn small" data-action="project-menu" aria-label="Opções do projeto">${ICON.more}</button>` : ''}
    </div>
    <div class="heading-sub">${esc(sub)}</div>`;
  document.title = p ? `${p.name} · Tarefas` : `${title} · Tarefas`;
}

function onHeadingClick(e) {
  const b = e.target.closest('[data-action="project-menu"]');
  if (!b) return;
  const p = currentProject();
  showMenu(b, [
    { label: 'Configurações do projeto', icon: ICON.gear, onClick: () => navigate({ view: 'settings' }) },
    { label: 'Sprints', icon: ICON.target, onClick: () => openSprints(p.id) },
    ...(p.path ? [{ label: 'Copiar caminho', icon: ICON.copy, onClick: () => navigator.clipboard.writeText(p.path).then(() => toast('Caminho copiado')) }] : []),
    { divider: true },
    {
      label: p.archived_at ? 'Desarquivar projeto' : 'Arquivar projeto',
      icon: ICON.archive,
      onClick: () => attempt(async () => {
        await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { archived: !p.archived_at } });
        await load();
      }, p.archived_at ? 'Projeto desarquivado' : 'Projeto arquivado'),
    },
    { label: 'Excluir projeto', icon: ICON.trash, danger: true, onClick: () => deleteProject(p) },
  ]);
}

async function deleteProject(p) {
  const total = p.open + p.done;
  const ok = await confirmAction(`Excluir “${p.name}” e ${total === 1 ? 'a tarefa dele' : `as ${total} tarefas dele`}? Não dá para desfazer.`, { title: 'Excluir projeto', okLabel: 'Excluir' });
  if (!ok) return;
  await attempt(async () => {
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    closeDrawer();
    navigate({ projectId: null, view: 'board' });
    await load();
  }, 'Projeto excluído');
}

// ---------- ações do topo: timer, notificações, chat, nova tarefa ----------

function renderActions() {
  const timer = state.timers[0];
  $('#top-actions').innerHTML = `
    ${timer ? `
      <div class="timer-pill" data-action="open-timer" data-task="${timer.task_id}" title="Timer: #${timer.task_id} ${esc(timer.task_title)}">
        <span class="timer-dot"></span><b id="timer-clock">${fmtClock((Date.now() - Date.parse(timer.started_at)) / 1000)}</b>
        <span class="timer-title">#${timer.task_id} ${esc(timer.task_title)}</span>
        <button class="icon-btn tiny" data-action="stop-timer" title="Parar timer" aria-label="Parar timer">${ICON.stop}</button>
      </div>` : ''}
    <button class="icon-btn bell" data-action="notifications" aria-label="Notificações" title="Notificações">
      ${ICON.bell}${state.unread ? `<span class="badge">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}
    </button>
    <button class="icon-btn ${document.body.classList.contains('chat-open') ? 'on' : ''}" data-action="chat" aria-label="Chat com o Claude" title="Chat com o Claude (C)">${ICON.sparkles}</button>
    <button class="btn primary" data-action="new-task">${ICON.plus}<span class="hide-sm">Nova tarefa</span> <kbd class="hide-sm">N</kbd></button>`;
}

function tickTimer() {
  const timer = state.timers[0];
  const el = $('#timer-clock');
  if (timer && el) el.textContent = fmtClock((Date.now() - Date.parse(timer.started_at)) / 1000);
}

async function onActionsClick(e) {
  const b = e.target.closest('[data-action]');
  if (!b) return;
  const action = b.dataset.action;
  if (action === 'stop-timer') {
    e.stopPropagation();
    const t = state.timers[0];
    await attempt(async () => {
      await api(`/api/tasks/${t.task_id}/timer`, { method: 'POST', body: { action: 'stop' } });
      await load();
    }, 'Timer parado');
  }
  if (action === 'open-timer') openTask(Number(b.dataset.task));
  if (action === 'notifications') showNotifications(b);
  if (action === 'chat') {
    const { toggleChat } = await import('./chat.js');
    toggleChat();
  }
  if (action === 'new-task') openNewTask();
}

async function showNotifications(anchor) {
  const data = await attempt(() => api('/api/notifications'));
  if (!data) return;
  const panel = floatingPanel(anchor, `
    <div class="panel-head"><b>Notificações</b>${data.unread ? '<button class="link-btn" data-read="all">Marcar todas como lidas</button>' : ''}</div>
    <div class="notif-list">
      ${data.items.map((n) => `
        <button class="notif ${n.read_at ? '' : 'unread'}" data-id="${n.id}" data-task="${n.task_id || ''}">
          <span class="notif-dot"></span>
          <span class="notif-body">${esc(n.body)}<small>${ago(n.created_at)}</small></span>
        </button>`).join('') || '<div class="empty-small">Nada por aqui.</div>'}
    </div>`, { width: 360 });
  panel.onclick = async (e) => {
    if (e.target.closest('[data-read]')) {
      const r = await attempt(() => api('/api/notifications/read', { method: 'POST', body: { ids: 'all' } }));
      if (r) { state.unread = r.unread; renderActions(); closePanel(); }
      return;
    }
    const n = e.target.closest('.notif');
    if (!n) return;
    closePanel();
    const r = await api('/api/notifications/read', { method: 'POST', body: { ids: [Number(n.dataset.id)] } }).catch(() => null);
    if (r) { state.unread = r.unread; renderActions(); }
    if (n.dataset.task) openTask(Number(n.dataset.task));
  };
}

// ---------- barra de ferramentas: abas, sprint, busca, filtros ----------

function renderToolbar() {
  const bar = $('#toolbar');
  const taskView = TASK_VIEWS.includes(state.view);
  const show = taskView || (state.view === 'dashboard' && state.projectId);
  bar.hidden = !show && state.view !== 'dashboard';
  if (bar.hidden) return;
  const p = currentProject();
  const n = activeFilterCount();
  const searchFocused = document.activeElement?.id === 'search';
  if (searchFocused) {
    // Não recria a busca enquanto digita: só atualiza o contador de filtros.
    const fb = $('[data-action="filters"]', bar);
    if (fb) fb.querySelector('.count').textContent = n || '';
    return;
  }
  bar.innerHTML = `
    <div class="tabs" role="tablist">
      ${TABS.map(([v, label, icon]) => `<button role="tab" class="tab ${state.view === v ? 'on' : ''}" data-view="${v}" aria-selected="${state.view === v}">${icon}<span>${label}</span></button>`).join('')}
    </div>
    <span class="spacer"></span>
    ${p && taskView ? `
      <div class="sprint-box">
        ${ICON.target}
        <select id="sprint-select" aria-label="Filtrar por sprint">
          <option value="">Todas as sprints</option>
          <option value="none" ${state.sprint === 'none' ? 'selected' : ''}>Backlog (sem sprint)</option>
          ${state.sprints.map((s) => `<option value="${s.id}" ${String(s.id) === state.sprint ? 'selected' : ''}>${esc(s.name)}${s.status === 'active' ? ' · ativa' : s.status === 'completed' ? ' · concluída' : ''}</option>`).join('')}
        </select>
        <button class="icon-btn tiny" data-action="sprints" title="Gerenciar sprints" aria-label="Gerenciar sprints">${ICON.gear}</button>
      </div>` : ''}
    ${taskView ? `
      <label class="search">${ICON.search}<input id="search" type="search" placeholder="Buscar" value="${esc(state.q)}" autocomplete="off"><kbd>/</kbd></label>
      <button class="btn ghost bordered ${n ? 'active' : ''}" data-action="filters">${ICON.filter}Filtros<span class="count">${n || ''}</span></button>` : ''}`;
}

function onToolbarClick(e) {
  const tab = e.target.closest('[data-view]');
  if (tab) return navigate({ view: tab.dataset.view });
  const b = e.target.closest('[data-action]');
  if (b?.dataset.action === 'sprints') openSprints(state.projectId);
  if (b?.dataset.action === 'filters') showFilters(b);
}

function showFilters(anchor) {
  const sel = (name, options, value) => `<select class="input" name="${name}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const people = [['', 'Qualquer pessoa'], ...(state.me ? [['me', 'Eu']] : []), ['none', 'Sem responsável'], ...state.users.filter((u) => u.id !== state.me?.id).map((u) => [String(u.id), u.name])];
  const panel = floatingPanel(anchor, `
    <div class="panel-head"><b>Filtros</b><button class="link-btn" data-clear>Limpar</button></div>
    <div class="filter-grid">
      <label class="field"><span>Prioridade</span>${sel('prio', [['', 'Todas'], ...PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]])], state.prio)}</label>
      <label class="field"><span>Tipo</span>${sel('type', [['', 'Todos'], ...TYPES.map((t) => [t, TYPE_LABEL[t]])], state.type)}</label>
      <label class="field"><span>Responsável</span>${sel('assignee', people, state.assignee)}</label>
      <label class="field"><span>Prazo</span>${sel('due', [['', 'Qualquer'], ['overdue', 'Atrasadas'], ['today', 'Vencem hoje'], ['week', 'Próximos 7 dias'], ['none', 'Sem prazo']], state.due)}</label>
    </div>
    <label class="check"><input type="checkbox" name="showSubtasks" ${state.showSubtasks ? 'checked' : ''}><span>Mostrar subtarefas no quadro</span></label>
    <label class="check"><input type="checkbox" name="showArchived" ${state.showArchived ? 'checked' : ''}><span>Incluir tarefas arquivadas</span></label>`, { width: 320, align: 'right' });
  panel.onchange = async (e) => {
    const { name, type, checked, value } = e.target;
    const before = state.showArchived;
    state[name] = type === 'checkbox' ? checked : value;
    if (state.showArchived !== before) await load();
    emit('filter');
  };
  panel.onclick = (e) => {
    if (!e.target.closest('[data-clear]')) return;
    Object.assign(state, { prio: '', type: '', assignee: '', due: '', showSubtasks: false });
    const reload = state.showArchived;
    state.showArchived = false;
    closePanel();
    if (reload) load(); else emit('filter');
  };
}

// ---------- painel flutuante genérico ----------

let panelEl = null;
export function floatingPanel(anchor, html, { width = 300, align = 'left' } = {}) {
  closePanel();
  panelEl = document.createElement('div');
  panelEl.className = 'float-panel';
  panelEl.style.width = `${Math.min(width, innerWidth - 16)}px`;
  panelEl.innerHTML = html;
  document.body.append(panelEl);
  const r = anchor.getBoundingClientRect();
  const w = panelEl.offsetWidth;
  let left = align === 'right' ? r.right - w : r.left;
  if (left + w > innerWidth - 8) left = innerWidth - w - 8;
  Object.assign(panelEl.style, { left: `${Math.max(8, left)}px`, top: `${r.bottom + 6}px` });
  setTimeout(() => document.addEventListener('pointerdown', outsidePanel, true));
  return panelEl;
}

function outsidePanel(e) {
  if (panelEl && !panelEl.contains(e.target) && !e.target.closest('.menu-pop')) closePanel();
}

export function closePanel() {
  panelEl?.remove();
  panelEl = null;
  document.removeEventListener('pointerdown', outsidePanel, true);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panelEl) { e.stopPropagation(); closePanel(); } }, true);
