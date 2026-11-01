// Estado compartilhado, rota (na URL), filtros e sincronização com o servidor.
import { api } from './api.js';
import { t } from './i18n.js';
import { localDate } from './util.js';

const params = new URLSearchParams(location.search);

export const TASK_VIEWS = ['board', 'list', 'calendar', 'gantt'];
export const PAGES = ['dashboard', 'activity', 'automations', 'team', 'organizations', 'settings', 'project-settings', 'account', 'admin'];

export const state = {
  me: null,
  prefs: null,
  users: [],
  projects: [],
  tasks: [],
  organizations: [],
  workspaces: [],
  labels: [],
  fields: [],
  columns: null,
  transitions: [],
  sprints: [],
  timers: [],
  my_role: null,
  mailEnabled: false,
  unread: 0,
  today: localDate(),
  version: null,
  loaded: false,

  projectId: Number(params.get('project')) || null,
  view: params.get('view') || '',
  workspaceId: Number(params.get('workspace')) || null,
  taskId: Number(params.get('task')) || null,
  sprint: params.get('sprint') || '',

  q: '',
  prio: '',
  type: '',
  assignee: params.get('mine') ? 'me' : '',
  due: '',
  tag: '',
  showSubtasks: false,
  showArchived: false,
  showArchivedProjects: false,
};

const listeners = new Set();
export const subscribe = (fn) => listeners.add(fn);
export const emit = (what = 'all') => listeners.forEach((fn) => fn(what));

export function syncUrl() {
  const p = new URLSearchParams();
  if (state.projectId) p.set('project', state.projectId);
  if (state.workspaceId && !state.projectId) p.set('workspace', state.workspaceId);
  if (state.view !== 'board') p.set('view', state.view);
  if (state.sprint && state.projectId) p.set('sprint', state.sprint);
  if (state.taskId) p.set('task', state.taskId);
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
}

export function navigate(patch) {
  const projectChanged = 'projectId' in patch && patch.projectId !== state.projectId;
  if (projectChanged && patch.projectId) state.workspaceId = null;
  Object.assign(state, patch);
  if (projectChanged) state.sprint = patch.sprint ?? '';
  syncUrl();
  if (projectChanged) load();
  else emit('route');
}

export async function load() {
  const q = new URLSearchParams();
  if (state.projectId) q.set('project', state.projectId);
  if (state.showArchived) q.set('archived', '1');
  const data = await api(`/api/state${q.size ? `?${q}` : ''}`);
  if (state.projectId && !data.projects.some((p) => p.id === state.projectId)) {
    state.projectId = null;
    syncUrl();
    return load();
  }
  Object.assign(state, data, { loaded: true });
  emit('data');
  return data;
}

// Tempo real: Server-Sent Events (/api/events). Se o navegador ou um proxy não
// mantiver a conexão, cai para consultar /api/version a cada 3 s.
let source = null;
let polling = null;
let reloading = null;
const uiHandlers = new Set();
export const onUiCommand = (fn) => uiHandlers.add(fn);

async function reloadIfChanged(version, onChange) {
  if (version === state.version) return;
  if (reloading) return;
  reloading = load().then(() => onChange?.()).catch(() => {}).finally(() => { reloading = null; });
}

export function startLive(onChange) {
  stopLive();
  if (!('EventSource' in window)) return startPolling(onChange);
  let failures = 0;
  source = new EventSource('/api/events');
  source.addEventListener('hello', (e) => {
    failures = 0;
    setLive(true);
    const d = JSON.parse(e.data);
    if (d.unread !== state.unread) { state.unread = d.unread; emit('unread'); }
    reloadIfChanged(d.version, onChange);
  });
  source.addEventListener('change', (e) => reloadIfChanged(JSON.parse(e.data).version, onChange));
  source.addEventListener('unread', (e) => { state.unread = JSON.parse(e.data).unread; emit('unread'); });
  source.addEventListener('ui', (e) => { const cmd = JSON.parse(e.data); uiHandlers.forEach((fn) => fn(cmd)); });
  source.onerror = () => {
    setLive(false);
    // O navegador reconecta sozinho; depois de várias falhas seguidas, usa polling.
    if (++failures >= 4) { stopLive(); startPolling(onChange); }
  };
}

function stopLive() {
  source?.close();
  source = null;
  clearInterval(polling);
  polling = null;
}

function startPolling(onChange) {
  polling = setInterval(async () => {
    try {
      const { version, unread } = await api('/api/version');
      setLive(true);
      if (unread !== state.unread) { state.unread = unread; emit('unread'); }
      await reloadIfChanged(version, onChange);
      for (const cmd of await api('/api/ui-commands')) uiHandlers.forEach((fn) => fn(cmd));
    } catch {
      setLive(false);
    }
  }, 3000);
}

function setLive(ok) {
  const el = document.querySelector('.live');
  if (!el) return;
  el.classList.toggle('off', !ok);
  el.querySelector('span:last-child').textContent = ok ? t('ao vivo') : t('sem conexão');
}

// ---------- consultas ----------

export const currentProject = () => state.projects.find((p) => p.id === state.projectId) || null;
export const userById = (id) => state.users.find((u) => u.id === id);
export const taskById = (id) => state.tasks.find((t) => t.id === id);
export const projectById = (id) => state.projects.find((p) => p.id === id);
export const workspaceById = (id) => state.workspaces.find((w) => w.id === id);

// ---------- permissões (o servidor confere de novo; aqui só esconde o que não pode) ----------

const RANK = { viewer: 1, member: 2, manager: 3, owner: 4 };
const LEVEL = { read: 1, edit: 2, manage: 3, own: 4 };
export const isAdmin = () => !state.me || state.me.role === 'admin';
export const roleIn = (projectOrId) => {
  const p = typeof projectOrId === 'object' ? projectOrId : projectById(projectOrId);
  return isAdmin() ? 'owner' : p?.my_role || null;
};
export const can = (projectOrId, level = 'edit') => (RANK[roleIn(projectOrId)] || 0) >= LEVEL[level];
// Sem projeto escolhido: pode criar/editar se a conta não é só de leitura.
export const canWrite = () => (state.projectId ? can(state.projectId, 'edit') : state.me?.role !== 'viewer');

// Projetos visíveis no filtro de workspace atual (inclui sub-workspaces).
export function workspaceTree(id) {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const w of state.workspaces) if (w.parent_id && ids.has(w.parent_id) && !ids.has(w.id)) { ids.add(w.id); grew = true; }
  }
  return ids;
}
export function scopedProjectIds() {
  if (!state.workspaceId) return null;
  const tree = workspaceTree(state.workspaceId);
  return new Set(state.projects.filter((p) => tree.has(p.workspace_id)).map((p) => p.id));
}

// Cor de uma tag: label do projeto > label global > cor derivada do nome.
export function labelFor(tag, project_id) {
  const name = String(tag).toLowerCase();
  return state.labels.find((l) => l.project_id === project_id && l.name.toLowerCase() === name)
    || state.labels.find((l) => !l.project_id && l.name.toLowerCase() === name) || null;
}

export function activeFilterCount() {
  return [state.prio, state.type, state.assignee, state.due, state.tag].filter(Boolean).length + (state.showSubtasks ? 1 : 0) + (state.showArchived ? 1 : 0);
}

// Aplica sprint, busca e filtros. subtasks: 'filter' (respeita o filtro), 'all' ou 'none'.
export function filteredTasks({ subtasks = 'filter' } = {}) {
  const q = state.q.trim().toLowerCase();
  const me = state.me?.id;
  const today = state.today;
  const week = new Date(`${today}T12:00:00`);
  week.setDate(week.getDate() + 7);
  const weekEnd = localDate(week);
  const scope = state.projectId ? null : scopedProjectIds();
  return state.tasks.filter((t) => {
    if (scope && !scope.has(t.project_id)) return false;
    if (subtasks === 'none' && t.parent_id) return false;
    if (subtasks === 'filter' && t.parent_id && !state.showSubtasks) return false;
    if (state.projectId && state.sprint) {
      if (state.sprint === 'none' ? t.sprint_id : String(t.sprint_id) !== state.sprint) return false;
    }
    if (state.prio && t.priority !== state.prio) return false;
    if (state.type && t.type !== state.type) return false;
    if (state.assignee === 'me' && !t.assignee_ids.includes(me)) return false;
    if (state.assignee === 'none' && t.assignee_ids.length) return false;
    if (state.assignee && !['me', 'none'].includes(state.assignee) && !t.assignee_ids.includes(Number(state.assignee))) return false;
    if (state.due === 'overdue' && !t.overdue) return false;
    if (state.due === 'today' && t.due_date !== today) return false;
    if (state.due === 'week' && !(t.due_date && t.due_date >= today && t.due_date <= weekEnd)) return false;
    if (state.due === 'none' && t.due_date) return false;
    if (state.tag && !t.tags.some((x) => x.toLowerCase() === state.tag.toLowerCase())) return false;
    if (q && !`#${t.id} ${t.ref || ''} ${t.title} ${t.description} ${t.tags.join(' ')} ${t.project_name}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
