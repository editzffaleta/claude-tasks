// Ponto de entrada: login, idioma e tema, estrutura, rotas entre visões, atalhos e tempo real.
import { api } from './api.js';
import { renderAuth } from './auth.js';
import { boardDragging, renderBoard } from './board.js';
import { renderCalendar } from './calendar.js';
import { mountChat, toggleChat } from './chat.js';
import { closeDrawer, mountDrawer, openTask, refreshDrawer } from './drawer.js';
import { renderGantt } from './gantt.js';
import { pickLanguage, setLanguage, t } from './i18n.js';
import { renderList } from './list.js';
import { openPalette } from './palette.js';
import { mountShell, renderShell, toggleSidebar } from './shell.js';
import { PAGES, TASK_VIEWS, load, navigate, onUiCommand, singleKeys, startLive, state, subscribe } from './state.js';
import { openNewTask } from './taskform.js';
import { $, applyTheme } from './util.js';

// Páginas carregadas sob demanda (módulo, função).
const LAZY = {
  dashboard: ['./dashboard.js', 'renderDashboard'],
  activity: ['./activity.js', 'renderActivity'],
  automations: ['./automations.js', 'renderAutomations'],
  team: ['./team.js', 'renderTeam'],
  account: ['./team.js', 'renderAccount'],
  organizations: ['./organizations.js', 'renderOrganizations'],
  settings: ['./settings.js', 'renderSettings'],
  'project-settings': ['./projectsettings.js', 'renderProjectSettings'],
  admin: ['./admin.js', 'renderAdmin'],
  mapa: ['./mapa.js', 'renderMapa'],
};
const VIEWS = { board: renderBoard, list: renderList, calendar: renderCalendar, gantt: renderGantt };
// Páginas com formulários próprios: não são redesenhadas a cada atualização ao vivo.
// O mapa se atualiza sozinho dentro do iframe; redesenhar a cada mudança do quadro o recarregaria.
const FORM_PAGES = new Set(['activity', 'automations', 'team', 'account', 'organizations', 'settings', 'project-settings', 'admin', 'mapa']);
let currentView = null;
let lastProject;
let renderSeq = 0;

async function renderView(reason) {
  let el = $('#view');
  const name = VIEWS[state.view] || LAZY[state.view] ? state.view : 'board';
  const projectChanged = state.projectId !== lastProject;
  lastProject = state.projectId;
  if (name !== currentView || projectChanged) {
    // Elemento novo a cada troca de visão: descarta os handlers da visão anterior.
    const fresh = el.cloneNode(false);
    el.replaceWith(fresh);
    el = fresh;
    el.className = `view view-${name}`;
    currentView = name;
  } else if (FORM_PAGES.has(name) && reason !== 'route') {
    return;
  }
  if (name === 'board' && boardDragging()) {
    state.pendingRender = true;
    return;
  }
  if (VIEWS[name]) return VIEWS[name](el);
  const seq = ++renderSeq;
  const [path, fn] = LAZY[name];
  const mod = await import(path);
  if (seq !== renderSeq || !el.isConnected) return;
  if (name === 'dashboard') return mod[fn](el, { refresh: reason === 'data' });
  return mod[fn](el);
}

// Estes eventos só mudam a estrutura em volta; a tela aberta não precisa ser redesenhada.
const SHELL_ONLY = new Set(['unread', 'live', 'panel']);
subscribe((what) => {
  renderShell();
  if (!SHELL_ONLY.has(what)) renderView(what);
});

function isTyping() {
  const el = document.activeElement;
  return el?.matches?.('input, textarea, select, [contenteditable]');
}

document.addEventListener('keydown', (e) => {
  if (!state.me) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openPalette();
  }
  if (document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (isTyping()) return document.activeElement.blur();
    if (state.taskId) return closeDrawer();
    return toggleSidebar(false);
  }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey || !singleKeys()) return;
  const key = e.key.toLowerCase();
  if (key === '/') {
    const search = $('#search');
    if (search) { e.preventDefault(); search.focus(); }
  }
  if (key === 'n' && state.me.role !== 'viewer') { e.preventDefault(); openNewTask(); }
  if (key === 'c' && state.me.role !== 'viewer') { e.preventDefault(); toggleChat(); }
  if (key === 'k') { e.preventDefault(); openPalette(); }
  const tab = ['1', '2', '3', '4', '5'].indexOf(key);
  if (tab >= 0) navigate({ view: [...TASK_VIEWS, 'dashboard'][tab] });
});

window.addEventListener('auth-required', () => location.reload());

// Pedidos do Claude ("abra a tarefa 12 no painel"), via MCP show_in_dashboard.
onUiCommand((cmd) => {
  const patch = {};
  if (cmd.project !== undefined) patch.projectId = cmd.project || null;
  if (cmd.view) patch.view = cmd.view;
  if (Object.keys(patch).length) navigate(patch);
  if (cmd.task) openTask(cmd.task);
});

async function boot() {
  const root = $('#root');
  const params = new URLSearchParams(location.search);
  const me = await api('/api/auth/me').catch(() => ({}));
  await setLanguage(pickLanguage(me.settings?.language, me.default_language));
  document.title = t('Quadro de Tarefas');
  applyTheme(me.settings?.theme);
  if (!me.user) {
    renderAuth(root, {
      setup: me.setup,
      invite: params.get('invite'),
      reset: params.get('reset'),
      mailEnabled: me.mail_enabled,
      onDone: () => { location.href = '/'; },
    });
    return;
  }
  state.me = me.user;
  state.prefs = me.settings;
  state.unread = me.unread;
  state.mailEnabled = me.mail_enabled;
  if (!state.view || (!VIEWS[state.view] && !PAGES.includes(state.view))) state.view = me.settings?.default_view || 'board';
  if (params.has('invite') || params.has('reset')) history.replaceState(null, '', location.pathname);
  mountShell(root);
  mountDrawer();
  if (state.me.role !== 'viewer') mountChat();
  await load();
  if (state.taskId) openTask(state.taskId);
  startLive(() => { if (state.taskId) refreshDrawer(); });
}

boot();
