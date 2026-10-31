// Ponto de entrada: login, estrutura, rotas entre visões, atalhos e atualização ao vivo.
import { api } from './api.js';
import { renderAuth } from './auth.js';
import { renderAutomations } from './automations.js';
import { boardDragging, renderBoard } from './board.js';
import { renderCalendar } from './calendar.js';
import { mountChat, toggleChat } from './chat.js';
import { renderDashboard } from './dashboard.js';
import { closeDrawer, mountDrawer, openTask, refreshDrawer } from './drawer.js';
import { renderGantt } from './gantt.js';
import { renderList } from './list.js';
import { renderSettings } from './settings.js';
import { mountShell, renderShell, toggleSidebar } from './shell.js';
import { TASK_VIEWS, load, navigate, startPolling, state, subscribe } from './state.js';
import { openNewTask } from './taskform.js';
import { renderAccount, renderTeam } from './team.js';
import { $ } from './util.js';

const VIEWS = {
  board: renderBoard,
  list: renderList,
  calendar: renderCalendar,
  gantt: renderGantt,
  dashboard: renderDashboard,
  automations: renderAutomations,
  team: renderTeam,
  settings: renderSettings,
  account: renderAccount,
};
// Páginas com formulários próprios: não são redesenhadas a cada atualização ao vivo.
const FORM_PAGES = new Set(['automations', 'team', 'settings', 'account']);
let currentView = null;
let lastProject;

function renderView(reason) {
  let el = $('#view');
  const name = VIEWS[state.view] ? state.view : 'board';
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
  if (name === 'dashboard') return renderDashboard(el, { refresh: reason === 'data' });
  VIEWS[name](el);
}

subscribe((what) => {
  renderShell();
  if (what !== 'unread') renderView(what);
});

function isTyping() {
  const el = document.activeElement;
  return el?.matches?.('input, textarea, select, [contenteditable]');
}

document.addEventListener('keydown', (e) => {
  if (!state.me || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') {
    if (isTyping()) return document.activeElement.blur();
    if (state.taskId) return closeDrawer();
    return toggleSidebar(false);
  }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === '/') {
    const search = $('#search');
    if (search) { e.preventDefault(); search.focus(); }
  }
  if (key === 'n') { e.preventDefault(); openNewTask(); }
  if (key === 'c') { e.preventDefault(); toggleChat(); }
  const tab = ['1', '2', '3', '4', '5'].indexOf(key);
  if (tab >= 0) navigate({ view: [...TASK_VIEWS, 'dashboard'][tab] });
});

window.addEventListener('auth-required', () => location.reload());

async function boot() {
  const root = $('#root');
  const params = new URLSearchParams(location.search);
  const me = await api('/api/auth/me').catch(() => ({}));
  if (!me.user) {
    renderAuth(root, { setup: me.setup, invite: params.get('invite'), onDone: () => { location.href = '/'; } });
    return;
  }
  state.me = me.user;
  state.unread = me.unread;
  if (params.has('invite')) history.replaceState(null, '', location.pathname);
  mountShell(root);
  mountDrawer();
  mountChat();
  await load();
  if (state.taskId) openTask(state.taskId);
  startPolling(() => { if (state.taskId) refreshDrawer(); });
}

boot();
