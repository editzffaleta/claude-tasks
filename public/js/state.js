// Estado compartilhado, rota (na URL), filtros e sincronização com o servidor.
import { api } from './api.js';
import { localDate } from './util.js';

const params = new URLSearchParams(location.search);

export const TASK_VIEWS = ['board', 'list', 'calendar', 'gantt'];
export const PAGES = ['dashboard', 'automations', 'team', 'settings', 'account'];

export const state = {
  me: null,
  users: [],
  projects: [],
  tasks: [],
  columns: null,
  sprints: [],
  timers: [],
  unread: 0,
  today: localDate(),
  version: null,
  loaded: false,

  projectId: Number(params.get('project')) || null,
  view: params.get('view') || 'board',
  taskId: Number(params.get('task')) || null,
  sprint: params.get('sprint') || '',

  q: '',
  prio: '',
  type: '',
  assignee: params.get('mine') ? 'me' : '',
  due: '',
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
  if (state.view !== 'board') p.set('view', state.view);
  if (state.sprint && state.projectId) p.set('sprint', state.sprint);
  if (state.taskId) p.set('task', state.taskId);
  history.replaceState(null, '', p.size ? `?${p}` : location.pathname);
}

export function navigate(patch) {
  const projectChanged = 'projectId' in patch && patch.projectId !== state.projectId;
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

let polling;
export function startPolling(onChange) {
  clearInterval(polling);
  polling = setInterval(async () => {
    try {
      const { version, unread } = await api('/api/version');
      setLive(true);
      if (unread !== state.unread) { state.unread = unread; emit('unread'); }
      if (version !== state.version) {
        await load();
        onChange?.();
      }
    } catch {
      setLive(false);
    }
  }, 2000);
}

function setLive(ok) {
  const el = document.querySelector('.live');
  if (!el) return;
  el.classList.toggle('off', !ok);
  el.querySelector('span:last-child').textContent = ok ? 'ao vivo' : 'sem conexão';
}

// ---------- consultas ----------

export const currentProject = () => state.projects.find((p) => p.id === state.projectId) || null;
export const userById = (id) => state.users.find((u) => u.id === id);
export const taskById = (id) => state.tasks.find((t) => t.id === id);

export function activeFilterCount() {
  return [state.prio, state.type, state.assignee, state.due].filter(Boolean).length + (state.showSubtasks ? 1 : 0) + (state.showArchived ? 1 : 0);
}

// Aplica sprint, busca e filtros. subtasks: 'filter' (respeita o filtro), 'all' ou 'none'.
export function filteredTasks({ subtasks = 'filter' } = {}) {
  const q = state.q.trim().toLowerCase();
  const me = state.me?.id;
  const today = state.today;
  const week = new Date(`${today}T12:00:00`);
  week.setDate(week.getDate() + 7);
  const weekEnd = localDate(week);
  return state.tasks.filter((t) => {
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
    if (q && !`#${t.id} ${t.title} ${t.description} ${t.tags.join(' ')} ${t.project_name}`.toLowerCase().includes(q)) return false;
    return true;
  });
}
