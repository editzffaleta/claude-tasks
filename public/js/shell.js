// Estrutura fixa do app: barra lateral, cabeçalho, abas, filtros, notificações e timer.
import { api, attempt, toast } from './api.js';
import { closeDrawer, openTask } from './drawer.js';
import { N_, locale, t, tn } from './i18n.js';
import { openPalette } from './palette.js';
import { openSprints } from './sprints.js';
import {
  state, navigate, load, currentProject, activeFilterCount, emit, TASK_VIEWS, can, isAdmin, workspaceById, workspaceTree,
  since, isNew, markSeen, scopedProjectIds, userById,
} from './state.js';
import { openNewTask } from './taskform.js';
import { confirmAction, openDialog, showMenu } from './ui.js';
import {
  $, ICON, PRIORITIES, PRIORITY_LABEL, TYPES, TYPE_LABEL, VISIBILITY_LABEL, ago, avatar, debounce, esc, fmtClock, notificationText, projectBadge, tilde,
} from './util.js';

const PROJECT_COLORS = ['#d97757', '#2a78d6', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300', '#7c7c84'];

const TABS = [
  ['board', N_('Quadro'), ICON.board],
  ['list', N_('Lista'), ICON.list],
  ['calendar', N_('Calendário'), ICON.calendar],
  ['gantt', N_('Gantt'), ICON.gantt],
  ['dashboard', N_('Dashboard'), ICON.dashboard],
  // Só em projetos com pasta no computador (o mapa é gerado dentro dela).
  ['mapa', N_('Mapa do código'), ICON.map],
];
// Grupos recolhidos na barra lateral (por workspace), guardados no navegador.
const collapsed = new Set(JSON.parse((() => { try { return localStorage.getItem('tk_collapsed') || '[]'; } catch { return '[]'; } })()));
const saveCollapsed = () => { try { localStorage.setItem('tk_collapsed', JSON.stringify([...collapsed])); } catch {} };

export function mountShell(root) {
  root.innerHTML = `
    <div class="app">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8"/><path d="M9 16.5l4.5 4.5L23 11.5"/></svg></span>
          <div><div class="brand-name">${t('Tarefas')}</div><div class="brand-sub">${t('todos os projetos')}</div></div>
        </div>
        <button class="palette-btn" id="palette-btn">${ICON.search}<span>${t('Buscar ou ir para…')}</span><kbd>⌘K</kbd></button>
        <nav class="nav" id="nav" aria-label="${esc(t('Navegação'))}"></nav>
        <div class="sidebar-foot" id="sidebar-foot"></div>
      </aside>
      <div class="sidebar-scrim" id="sidebar-scrim"></div>
      <main class="main">
        <header class="topbar">
          <div class="topbar-row">
            <button class="icon-btn menu-btn" id="menu-btn" aria-label="${t('Abrir menu')}">${ICON.menu}</button>
            <div class="heading" id="heading"></div>
            <div class="top-actions" id="top-actions"></div>
          </div>
          <div class="topbar-row toolbar" id="toolbar"></div>
        </header>
        <div id="since-bar" hidden></div>
        <section class="view" id="view"></section>
      </main>
      <aside class="chat" id="chat" aria-label="${t('Chat com o Claude')}"></aside>
    </div>
    <div class="drawer-scrim" id="drawer-scrim"></div>
    <aside class="drawer" id="drawer" aria-label="${esc(t('Detalhes da tarefa'))}" aria-hidden="true" data-drop-label="${esc(t('Solte para anexar'))}"><div class="drawer-inner" id="drawer-inner"></div></aside>`;
  $('#palette-btn').onclick = () => { toggleSidebar(false); openPalette(); };

  $('#menu-btn').onclick = () => toggleSidebar(true);
  $('#sidebar-scrim').onclick = () => toggleSidebar(false);
  $('#drawer-scrim').onclick = closeDrawer;
  $('#nav').onclick = onNavClick;
  $('#sidebar-foot').onclick = onFootClick;
  $('#heading').onclick = onHeadingClick;
  $('#top-actions').onclick = onActionsClick;
  $('#toolbar').onclick = onToolbarClick;
  $('#since-bar').onclick = onSinceClick;
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
  renderSince();
}

// ---------- barra lateral ----------

function renderNav() {
  const active = state.projects.filter((p) => !p.archived_at);
  const archived = state.projects.filter((p) => p.archived_at);
  const open = active.reduce((n, p) => n + p.open, 0);
  const isPage = (v) => state.view === v && !state.projectId;
  const taskView = TASK_VIEWS.includes(state.view);
  const mine = state.users.length > 1;
  const item = (p, depth = 0) => `
    <button class="nav-item ${p.id === state.projectId ? 'active' : ''} ${p.open ? '' : 'idle'}" data-project="${p.id}" style="--depth:${depth}" title="${esc(p.path ? tilde(p.path) : p.name)}">
      ${projectBadge(p)}
      <span class="nav-label">${esc(p.name)}</span>
      ${p.visibility === 'private' ? `<span class="nav-lock" title="${esc(VISIBILITY_LABEL.private)}">${ICON.lock}</span>` : ''}
      ${p.overdue ? `<span class="nav-alert" title="${esc(tn(p.overdue, '{n} atrasada', '{n} atrasadas'))}">${p.overdue}</span>` : ''}
      <span class="nav-count">${p.open || ''}</span>
    </button>`;

  // Com um só workspace, a lista fica plana; com vários, agrupa por organização › workspace.
  let projectsHtml;
  const wsWithProjects = new Set(active.map((p) => p.workspace_id));
  if (state.workspaces.length <= 1 || wsWithProjects.size <= 1 && state.organizations.length <= 1) {
    projectsHtml = active.map((p) => item(p)).join('');
  } else {
    const multiOrg = state.organizations.length > 1;
    const group = (w, depth) => {
      const tree = workspaceTree(w.id);
      const inside = active.filter((p) => tree.has(p.workspace_id));
      if (!inside.length) return '';
      const key = `w${w.id}`;
      const shut = collapsed.has(key);
      const own = active.filter((p) => p.workspace_id === w.id);
      const children = state.workspaces.filter((c) => c.parent_id === w.id);
      const count = inside.reduce((n, p) => n + p.open, 0);
      return `
        <div class="nav-group" style="--depth:${depth}">
          <button class="nav-ws ${state.workspaceId === w.id && !state.projectId ? 'active' : ''}" data-ws="${w.id}" title="${esc(t('Ver tarefas deste workspace'))}">
            <span class="nav-caret" data-collapse="${key}">${shut ? ICON.right : ICON.down}</span>
            <span class="nav-label">${esc(w.name)}</span><span class="nav-count">${count || ''}</span>
          </button>
          ${shut ? '' : children.map((c) => group(c, depth + 1)).join('') + own.map((p) => item(p, depth + 1)).join('')}
        </div>`;
    };
    projectsHtml = state.organizations.map((o) => {
      const roots = state.workspaces.filter((w) => w.organization_id === o.id && !w.parent_id);
      const body = roots.map((w) => group(w, 0)).join('');
      if (!body) return '';
      return multiOrg ? `<div class="nav-org">${projectBadge(o)}<span>${esc(o.name)}</span></div>${body}` : body;
    }).join('');
    // Projetos sem workspace conhecido (não deveria acontecer, mas não somem).
    const known = new Set(state.workspaces.map((w) => w.id));
    projectsHtml += active.filter((p) => !known.has(p.workspace_id)).map((p) => item(p)).join('');
  }

  $('#nav').innerHTML = `
    <button class="nav-item ${isPage('dashboard') ? 'active' : ''}" data-go="dashboard"><span class="nav-icon">${ICON.dashboard}</span><span class="nav-label">${t('Dashboard')}</span></button>
    <button class="nav-item ${!state.projectId && !state.workspaceId && taskView && state.assignee !== 'me' ? 'active' : ''}" data-go="all">
      <span class="nav-icon">${ICON.inbox}</span><span class="nav-label">${t('Todas as tarefas')}</span><span class="nav-count">${open || ''}</span>
    </button>
    ${mine ? `<button class="nav-item ${!state.projectId && state.assignee === 'me' && taskView ? 'active' : ''}" data-go="mine">
      <span class="nav-icon">${ICON.user}</span><span class="nav-label">${t('Minhas tarefas')}</span>
      <span class="nav-count">${state.tasks.filter((x) => x.status !== 'done' && x.assignee_ids.includes(state.me?.id)).length || ''}</span>
    </button>` : ''}
    <button class="nav-item ${isPage('activity') ? 'active' : ''}" data-go="activity"><span class="nav-icon">${ICON.history}</span><span class="nav-label">${t('Atividade')}</span></button>
    <div class="nav-heading">${t('Projetos')} ${state.me?.role !== 'viewer' ? `<button class="icon-btn tiny" data-go="new-project" title="${esc(t('Novo projeto'))}" aria-label="${esc(t('Novo projeto'))}">${ICON.plus}</button>` : ''}</div>
    ${projectsHtml || `<div class="nav-empty">${t('Nenhum projeto ainda')}</div>`}
    ${archived.length ? `
      <button class="nav-heading toggle" data-go="toggle-archived">${state.showArchivedProjects ? ICON.down : ICON.right} ${t('Arquivados ({n})', { n: archived.length })}</button>
      ${state.showArchivedProjects ? archived.map((p) => item(p)).join('') : ''}` : ''}`;
}

function renderFoot() {
  const me = state.me;
  const page = (v, icon, label) => `<button class="nav-item ${state.view === v && !state.projectId ? 'active' : ''}" data-go="${v}"><span class="nav-icon">${icon}</span><span class="nav-label">${label}</span></button>`;
  $('#sidebar-foot').innerHTML = `
    ${page('automations', ICON.zap, t('Automações'))}
    ${page('team', ICON.users, t('Equipe'))}
    ${page('organizations', ICON.building, t('Organizações'))}
    ${isAdmin() ? page('settings', ICON.gear, t('Configurações')) : ''}
    ${isAdmin() ? page('admin', ICON.shield, t('Administração')) : ''}
    <div class="foot-row">
      <button class="user-chip" data-go="user-menu">${avatar(me, { size: 24 })}<span>${esc(me?.name || '')}</span>${ICON.down}</button>
      <div class="live" title="${esc(t('Atualização automática'))}"><span class="live-dot"></span><span>${t('ao vivo')}</span></div>
    </div>`;
}

function onNavClick(e) {
  const caret = e.target.closest('[data-collapse]');
  if (caret) {
    const key = caret.dataset.collapse;
    if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
    saveCollapsed();
    return renderNav();
  }
  const b = e.target.closest('[data-project], [data-go], [data-ws]');
  if (!b) return;
  const keepView = TASK_VIEWS.includes(state.view) || state.view === 'dashboard' ? state.view : 'board';
  if (b.dataset.project) {
    toggleSidebar(false);
    return navigate({ projectId: Number(b.dataset.project), view: keepView, assignee: state.assignee === 'me' ? '' : state.assignee });
  }
  if (b.dataset.ws) {
    toggleSidebar(false);
    return navigate({ projectId: null, workspaceId: Number(b.dataset.ws), view: TASK_VIEWS.includes(state.view) ? state.view : 'board' });
  }
  const go = b.dataset.go;
  toggleSidebar(false);
  if (go === 'dashboard') navigate({ projectId: null, workspaceId: null, view: 'dashboard' });
  if (go === 'activity') navigate({ projectId: null, view: 'activity' });
  if (go === 'all') navigate({ projectId: null, workspaceId: null, view: TASK_VIEWS.includes(state.view) ? state.view : 'board', assignee: '' });
  if (go === 'mine') navigate({ projectId: null, workspaceId: null, view: TASK_VIEWS.includes(state.view) ? state.view : 'list', assignee: 'me' });
  if (go === 'new-project') newProject();
  if (go === 'toggle-archived') { state.showArchivedProjects = !state.showArchivedProjects; renderNav(); }
}

function onFootClick(e) {
  const b = e.target.closest('[data-go]');
  if (!b) return;
  const go = b.dataset.go;
  if (go === 'user-menu') {
    return showMenu(b, [
      { label: t('Minha conta e preferências'), icon: ICON.user, onClick: () => navigate({ projectId: null, view: 'account' }) },
      { label: t('Documentação da API'), icon: ICON.code, onClick: () => window.open('/docs/api', '_blank', 'noopener') },
      { divider: true },
      { label: t('Sair'), icon: ICON.logout, onClick: logout },
    ]);
  }
  toggleSidebar(false);
  navigate({ projectId: null, view: go });
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: {} });
  location.href = '/';
}

// Opções de workspace com a hierarquia (Organização › Workspace › Sub-workspace).
export function workspaceOptions(selected) {
  const out = [];
  const walk = (w, prefix) => {
    const label = `${prefix}${w.name}`;
    out.push(`<option value="${w.id}" ${w.id === selected ? 'selected' : ''}>${esc(label)}</option>`);
    for (const c of state.workspaces.filter((x) => x.parent_id === w.id)) walk(c, `${label} › `);
  };
  const multi = state.organizations.length > 1;
  for (const o of state.organizations) {
    for (const w of state.workspaces.filter((x) => x.organization_id === o.id && !x.parent_id)) walk(w, multi ? `${o.name} › ` : '');
  }
  return out.join('');
}

export function newProject() {
  const ws = state.workspaceId || state.workspaces[0]?.id;
  openDialog({
    title: t('Novo projeto'),
    submitLabel: t('Criar projeto'),
    body: `
      <label class="field"><span>${t('Nome')}</span><input class="input" name="name" required maxlength="120" placeholder="${esc(t('ex.: Pessoal, Site, App'))}"></label>
      <label class="field"><span>${t('Descrição')}</span><textarea class="input" name="description" rows="2"></textarea></label>
      <div class="row-2">
        ${state.workspaces.length > 1 ? `<label class="field"><span>${t('Workspace')}</span><select class="input" name="workspace_id">${workspaceOptions(ws)}</select></label>` : ''}
        <label class="field"><span>${t('Visibilidade')}</span><select class="input" name="visibility">
          <option value="internal">${esc(VISIBILITY_LABEL.internal)}</option>
          <option value="private">${esc(VISIBILITY_LABEL.private)}</option>
          <option value="public">${esc(VISIBILITY_LABEL.public)}</option>
        </select></label>
      </div>
      <div class="field"><span>${t('Cor')}</span>${swatches(PROJECT_COLORS[0])}</div>
      <p class="hint">${t('Projetos de pasta (repositórios) são criados sozinhos quando o Claude registra uma tarefa neles.')}</p>`,
    onSubmit: async (form) => {
      const f = form.elements;
      const body = { name: f.name.value, description: f.description.value, color: f.color.value, visibility: f.visibility.value };
      if (f.workspace_id) body.workspace_id = Number(f.workspace_id.value);
      const p = await attempt(() => api('/api/projects', { method: 'POST', body }));
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

// [título, subtítulo] das páginas fora das visões de tarefa.
const PAGE_TITLES = /* i18n */ {
  dashboard: ['Dashboard', 'Visão geral de todos os projetos'],
  activity: ['Atividade', 'Tudo o que aconteceu no quadro, de todas as pessoas e do Claude'],
  automations: ['Automações', 'Regras que agem sozinhas quando algo acontece no quadro'],
  team: ['Equipe', 'Membros, convites e permissões'],
  organizations: ['Organizações', 'Organizações, workspaces e quem tem acesso a cada um'],
  settings: ['Configurações', 'Preferências gerais do quadro, e-mail e IA'],
  account: ['Minha conta', 'Seu perfil, senha e preferências'],
  admin: ['Administração', 'Saúde do sistema, backups e manutenção'],
};

function renderHeading() {
  const p = currentProject();
  let title;
  let sub;
  const ws = !p && state.workspaceId ? workspaceById(state.workspaceId) : null;
  if (p) {
    title = p.name;
    sub = p.path ? tilde(p.path) : (p.description || t('sem pasta vinculada'));
  } else if (state.view === 'project-settings') {
    [title, sub] = [t('Configurações do projeto'), t('Escolha um projeto')];
  } else if (PAGE_TITLES[state.view] && !TASK_VIEWS.includes(state.view)) {
    [title, sub] = PAGE_TITLES[state.view].map((x) => t(x));
  } else {
    const tree = ws ? workspaceTree(ws.id) : null;
    const projects = state.projects.filter((x) => !x.archived_at && (!tree || tree.has(x.workspace_id)));
    const open = projects.reduce((n, x) => n + x.open, 0);
    title = ws ? ws.name : state.assignee === 'me' ? t('Minhas tarefas') : t('Todas as tarefas');
    sub = `${tn(projects.length, '{n} projeto', '{n} projetos')} · ${tn(open, '{n} tarefa aberta', '{n} tarefas abertas')}`;
  }
  $('#heading').innerHTML = `
    <div class="heading-row">
      ${p ? `<span class="heading-badge">${projectBadge(p, { size: 12 })}</span>` : ws ? `<span class="heading-badge">${ICON.layers}</span>` : ''}
      <h1>${esc(title)}</h1>
      ${p?.key ? `<span class="chip mono">${esc(p.key)}</span>` : ''}
      ${p?.visibility && p.visibility !== 'internal' ? `<span class="chip">${p.visibility === 'private' ? ICON.lock : ICON.globe}${esc(VISIBILITY_LABEL[p.visibility])}</span>` : ''}
      ${p?.archived_at ? `<span class="chip">${t('arquivado')}</span>` : ''}
      ${p ? `<button class="icon-btn small" data-action="project-menu" aria-label="${esc(t('Opções do projeto'))}">${ICON.more}</button>` : ''}
      ${ws ? `<button class="icon-btn small" data-action="clear-ws" aria-label="${esc(t('Ver todos os projetos'))}" title="${esc(t('Ver todos os projetos'))}">${ICON.close}</button>` : ''}
      <span class="heading-sub ${p?.path ? 'is-path' : ''}" title="${esc(sub)}">${esc(sub)}</span>
    </div>`;
  document.title = `${p ? p.name : title} · ${t('Tarefas')}`;
}

function onHeadingClick(e) {
  if (e.target.closest('[data-action="clear-ws"]')) return navigate({ workspaceId: null });
  const b = e.target.closest('[data-action="project-menu"]');
  if (!b) return;
  const p = currentProject();
  const own = can(p, 'own');
  showMenu(b, [
    { label: t('Configurações do projeto'), icon: ICON.gear, onClick: () => navigate({ view: 'project-settings' }) },
    { label: t('Sprints'), icon: ICON.target, onClick: () => openSprints(p.id) },
    ...(p.visibility === 'public' && can(p, 'manage') ? [{ label: t('Link público de leitura'), icon: ICON.share, onClick: () => shareProject(p) }] : []),
    { label: t('Exportar CSV'), icon: ICON.download, onClick: () => { location.href = `/api/export.csv?project=${p.id}`; } },
    ...(p.path ? [{ label: t('Copiar caminho'), icon: ICON.copy, onClick: () => navigator.clipboard.writeText(p.path).then(() => toast(t('Caminho copiado'))) }] : []),
    ...(own ? [
      { divider: true },
      {
        label: p.archived_at ? t('Desarquivar projeto') : t('Arquivar projeto'),
        icon: ICON.archive,
        onClick: () => attempt(async () => {
          await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { archived: !p.archived_at } });
          await load();
        }, p.archived_at ? t('Projeto desarquivado') : t('Projeto arquivado')),
      },
      { label: t('Excluir projeto'), icon: ICON.trash, danger: true, onClick: () => deleteProject(p) },
    ] : []),
  ]);
}

async function shareProject(p) {
  const s = await attempt(() => api(`/api/projects/${p.id}/shares`, { method: 'POST', body: {} }));
  if (!s) return;
  const link = `${location.origin}/s/${s.token}`;
  await navigator.clipboard.writeText(link).catch(() => {});
  toast(t('Link público copiado: {link}', { link }));
}

async function deleteProject(p) {
  const total = p.open + p.done;
  const ok = await confirmAction(tn(total, 'Excluir “{name}” e a tarefa dele? Não dá para desfazer.', 'Excluir “{name}” e as {n} tarefas dele? Não dá para desfazer.', { name: p.name }), { title: t('Excluir projeto'), okLabel: t('Excluir') });
  if (!ok) return;
  await attempt(async () => {
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    closeDrawer();
    navigate({ projectId: null, view: 'board' });
    await load();
  }, t('Projeto excluído'));
}

// ---------- ações do topo: timer, notificações, chat, nova tarefa ----------

function renderActions() {
  const timer = state.timers[0];
  const writer = state.me?.role !== 'viewer';
  $('#top-actions').innerHTML = `
    ${timer ? `
      <div class="timer-pill" data-action="open-timer" data-task="${timer.task_id}" title="${esc(t('Timer: #{id} {title}', { id: timer.task_id, title: timer.task_title }))}">
        <span class="timer-dot"></span><b id="timer-clock">${fmtClock((Date.now() - Date.parse(timer.started_at)) / 1000)}</b>
        <span class="timer-title">#${timer.task_id} ${esc(timer.task_title)}</span>
        <button class="icon-btn tiny" data-action="stop-timer" title="${esc(t('Parar timer'))}" aria-label="${esc(t('Parar timer'))}">${ICON.stop}</button>
      </div>` : ''}
    <button class="icon-btn bell" data-action="notifications" aria-label="${esc(t('Notificações'))}" title="${esc(t('Notificações'))}">
      ${ICON.bell}${state.unread ? `<span class="badge">${state.unread > 99 ? '99+' : state.unread}</span>` : ''}
    </button>
    ${writer ? `<button class="icon-btn ${document.body.classList.contains('chat-open') ? 'on' : ''}" data-action="chat" aria-label="${esc(t('Chat com o Claude'))}" title="${esc(t('Chat com o Claude (C)'))}">${ICON.sparkles}</button>` : ''}
    ${writer && (!state.projectId || can(state.projectId, 'edit')) ? `<button class="btn primary" data-action="new-task">${ICON.plus}<span class="hide-sm">${t('Nova tarefa')}</span> <kbd class="hide-sm">N</kbd></button>` : ''}`;
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
    const timer = state.timers[0];
    await attempt(async () => {
      await api(`/api/tasks/${timer.task_id}/timer`, { method: 'POST', body: { action: 'stop' } });
      await load();
    }, t('Timer parado'));
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
    <div class="panel-head"><b>${t('Notificações')}</b>${data.unread ? `<button class="link-btn" data-read="all">${t('Marcar todas como lidas')}</button>` : ''}</div>
    <div class="notif-list">
      ${data.items.map((n) => `
        <button class="notif ${n.read_at ? '' : 'unread'} type-${esc(n.type || '')}" data-id="${n.id}" data-task="${n.task_id || ''}">
          <span class="notif-dot"></span>
          <span class="notif-body">${esc(notificationText(n.body))}<small>${ago(n.created_at)}</small></span>
        </button>`).join('') || `<div class="empty-small">${t('Nada por aqui.')}</div>`}
    </div>
    <div class="panel-foot"><button class="link-btn" data-prefs>${ICON.gear} ${t('Preferências de notificação')}</button></div>`, { width: 360 });
  panel.onclick = async (e) => {
    if (e.target.closest('[data-prefs]')) { closePanel(); return navigate({ projectId: null, view: 'account' }); }
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
  const show = taskView || (state.view === 'dashboard' && state.projectId) || state.view === 'mapa';
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
      ${TABS.filter(([v]) => v !== 'mapa' || p?.path).map(([v, label, icon]) => `<button role="tab" class="tab ${state.view === v ? 'on' : ''}" data-view="${v}" aria-selected="${state.view === v}">${icon}<span>${t(label)}</span></button>`).join('')}
    </div>
    <span class="spacer"></span>
    ${p && taskView ? `
      <div class="sprint-box">
        ${ICON.target}
        <select id="sprint-select" aria-label="${esc(t('Filtrar por sprint'))}">
          <option value="">${t('Todas as sprints')}</option>
          <option value="none" ${state.sprint === 'none' ? 'selected' : ''}>${t('Backlog (sem sprint)')}</option>
          ${state.sprints.map((s) => `<option value="${s.id}" ${String(s.id) === state.sprint ? 'selected' : ''}>${esc(s.name)}${s.status === 'active' ? ` · ${t('ativa')}` : s.status === 'completed' ? ` · ${t('concluída')}` : s.status === 'cancelled' ? ` · ${t('cancelada')}` : ''}</option>`).join('')}
        </select>
        <button class="icon-btn tiny" data-action="sprints" title="${esc(t('Gerenciar sprints'))}" aria-label="${esc(t('Gerenciar sprints'))}">${ICON.gear}</button>
      </div>` : ''}
    ${taskView ? `
      <label class="search">${ICON.search}<input id="search" type="search" placeholder="${esc(t('Filtrar'))}" value="${esc(state.q)}" autocomplete="off"><kbd>/</kbd></label>
      ${filterChips()}
      <button class="btn ghost bordered ${n ? 'active' : ''}" data-action="filters">${ICON.filter}${t('Filtros')}<span class="count">${n || ''}</span></button>` : ''}`;
}

// Filtros ativos à vista, cada um com um × para tirar.
function filterChips() {
  const chips = [];
  const person = (v) => (v === 'me' ? t('Eu') : v === 'none' ? t('Sem responsável') : userById(Number(v))?.name || v);
  const due = /* i18n */ { overdue: 'Atrasadas', today: 'Vencem hoje', week: 'Próximos 7 dias', none: 'Sem prazo' };
  if (state.onlyNew) chips.push(['onlyNew', t('Só as novas')]);
  if (state.prio) chips.push(['prio', PRIORITY_LABEL[state.prio]]);
  if (state.type) chips.push(['type', TYPE_LABEL[state.type]]);
  if (state.assignee) chips.push(['assignee', person(state.assignee)]);
  if (state.due) chips.push(['due', t(due[state.due])]);
  if (state.tag) chips.push(['tag', `#${state.tag}`]);
  return chips.slice(0, 3).map(([key, label]) => `
    <span class="filter-chip">${esc(label)}<button data-unfilter="${key}" aria-label="${esc(t('Tirar o filtro {f}', { f: label }))}">${ICON.close}</button></span>`).join('');
}

// ---------- faixa "enquanto você estava fora" ----------

function sinceText(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return t('hoje às {hora}', { hora: time });
  if (diff === 1) return t('ontem às {hora}', { hora: time });
  return t('{data} às {hora}', { data: d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' }), hora: time });
}

function newInScope() {
  const scope = scopedProjectIds();
  return state.tasks.filter((x) => isNew(x) && !x.parent_id && (!state.projectId || x.project_id === state.projectId) && (!scope || scope.has(x.project_id)));
}

function renderSince() {
  const el = $('#since-bar');
  const dismissed = (() => { try { return sessionStorage.getItem('tk_since_dismissed') === since; } catch { return false; } })();
  const list = since && state.loaded && TASK_VIEWS.includes(state.view) && !dismissed ? newInScope() : [];
  if (!list.length && !state.onlyNew) { el.hidden = true; el.innerHTML = ''; return; }
  const claude = list.filter((x) => x.source === 'claude').length;
  const projects = new Set(list.map((x) => x.project_id)).size;
  const details = [
    t('desde {quando}', { quando: sinceText(since) }),
    claude ? tn(claude, '{n} registrada pelo Claude', '{n} registradas pelo Claude') : '',
    !state.projectId && projects > 1 ? tn(projects, 'em {n} projeto', 'em {n} projetos') : '',
  ].filter(Boolean).join(' · ');
  el.hidden = false;
  el.innerHTML = `
    <div class="since-bar" role="status">
      <span class="ember" aria-hidden="true">${ICON.sparkles}</span>
      <span class="since-text"><b>${esc(tn(list.length, '{n} tarefa nova', '{n} tarefas novas'))}</b> <span class="muted">${esc(details)}</span></span>
      <button class="btn ghost bordered small" data-since="only">${state.onlyNew ? t('Ver todas') : t('Ver só as novas')}</button>
      ${list.length ? `<button class="btn ghost small" data-since="seen">${t('Marcar como vistas')}</button>` : ''}
      <button class="icon-btn small" data-since="close" aria-label="${esc(t('Dispensar'))}">${ICON.close}</button>
    </div>`;
}

function onSinceClick(e) {
  const b = e.target.closest('[data-since]');
  if (!b) return;
  const action = b.dataset.since;
  if (action === 'only') state.onlyNew = !state.onlyNew;
  if (action === 'seen') { state.onlyNew = false; markSeen(newInScope().map((x) => x.id)); }
  if (action === 'close') {
    try { sessionStorage.setItem('tk_since_dismissed', since); } catch {}
    state.onlyNew = false;
  }
  emit('filter');
}

function onToolbarClick(e) {
  const tab = e.target.closest('[data-view]');
  if (tab) return navigate({ view: tab.dataset.view });
  const off = e.target.closest('[data-unfilter]');
  if (off) {
    const key = off.dataset.unfilter;
    state[key] = key === 'onlyNew' ? false : '';
    return emit('filter');
  }
  const b = e.target.closest('[data-action]');
  if (b?.dataset.action === 'sprints') openSprints(state.projectId);
  if (b?.dataset.action === 'filters') showFilters(b);
}

function showFilters(anchor) {
  const sel = (name, options, value) => `<select class="input" name="${name}">${options.map(([v, l]) => `<option value="${v}" ${v === value ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const people = [['', t('Qualquer pessoa')], ...(state.me ? [['me', t('Eu')]] : []), ['none', t('Sem responsável')], ...state.users.filter((u) => u.id !== state.me?.id).map((u) => [String(u.id), u.name])];
  const tags = [...new Set(state.tasks.flatMap((x) => x.tags))].sort((a, b) => a.localeCompare(b));
  const panel = floatingPanel(anchor, `
    <div class="panel-head"><b>${t('Filtros')}</b><button class="link-btn" data-clear>${t('Limpar')}</button></div>
    <div class="filter-grid">
      <label class="field"><span>${t('Prioridade')}</span>${sel('prio', [['', t('Todas')], ...PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]])], state.prio)}</label>
      <label class="field"><span>${t('Tipo')}</span>${sel('type', [['', t('Todos')], ...TYPES.map((x) => [x, TYPE_LABEL[x]])], state.type)}</label>
      <label class="field"><span>${t('Responsável')}</span>${sel('assignee', people, state.assignee)}</label>
      <label class="field"><span>${t('Prazo')}</span>${sel('due', [['', t('Qualquer')], ['overdue', t('Atrasadas')], ['today', t('Vencem hoje')], ['week', t('Próximos 7 dias')], ['none', t('Sem prazo')]], state.due)}</label>
      ${tags.length ? `<label class="field span-2"><span>${t('Label')}</span>${sel('tag', [['', t('Qualquer')], ...tags.map((x) => [x, x])], state.tag)}</label>` : ''}
    </div>
    <label class="check"><input type="checkbox" name="showSubtasks" ${state.showSubtasks ? 'checked' : ''}><span>${t('Mostrar subtarefas no quadro')}</span></label>
    <label class="check"><input type="checkbox" name="showArchived" ${state.showArchived ? 'checked' : ''}><span>${t('Incluir tarefas arquivadas')}</span></label>`, { width: 320, align: 'right' });
  panel.onchange = async (e) => {
    const { name, type, checked, value } = e.target;
    const before = state.showArchived;
    state[name] = type === 'checkbox' ? checked : value;
    if (state.showArchived !== before) await load();
    emit('filter');
  };
  panel.onclick = (e) => {
    if (!e.target.closest('[data-clear]')) return;
    Object.assign(state, { prio: '', type: '', assignee: '', due: '', tag: '', showSubtasks: false });
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
