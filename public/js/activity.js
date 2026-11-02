// Página Atividade: tarefas criadas, comentários e alterações de todos os projetos visíveis,
// com filtros por projeto, pessoa, tipo, período e texto, agrupadas por dia.
import { api, attempt } from './api.js';
import { openTask } from './drawer.js';
import { locale, t, tn } from './i18n.js';
import { projectById, state, taskById, userById } from './state.js';
import { $, ICON, ago, avatar, debounce, dtf, esc, eventText, localDate, md, projectBadge } from './util.js';

const PAGE = 50;
const EMPTY = { project: '', who: '', kind: '', since: '', until: '', q: '' };

// Filtros e itens carregados ficam entre visitas à página.
const filters = { ...EMPTY };
let lastProject;
let rows = [];
let hasMore = false;
let seq = 0;

const KIND_ICON = { created: ICON.plus, note: ICON.comment, event: ICON.history };
const filtered = () => Object.keys(EMPTY).some((k) => filters[k]);

function query(offset) {
  const q = new URLSearchParams({ limit: PAGE, offset });
  if (filters.project) q.set('project', filters.project);
  if (filters.who.startsWith('u:')) q.set('user', filters.who.slice(2));
  if (filters.who.startsWith('a:')) q.set('author', filters.who.slice(2));
  for (const k of ['kind', 'since', 'until']) if (filters[k]) q.set(k, filters[k]);
  if (filters.q.trim()) q.set('q', filters.q.trim());
  return q;
}

export async function renderActivity(el) {
  // Projeto escolhido no menu lateral vira o filtro padrão.
  if (state.projectId !== lastProject) {
    lastProject = state.projectId;
    filters.project = state.projectId ? String(state.projectId) : '';
  }
  el.innerHTML = `
    <div class="page activity-page">
      <form class="act-filters" data-form="filters" role="search">
        ${filterControls()}
      </form>
      <div class="act-feed" id="act-feed" aria-live="polite"><div class="skeleton" aria-busy="true" aria-label="${t('Carregando…')}" style="padding: 8px 0">${'<div class="sk line"></div>'.repeat(8)}</div></div>
    </div>`;
  bind(el);
  await fetchRows(el, { reset: true });
}

function option(value, label, selected) {
  return `<option value="${esc(value)}"${value === selected ? ' selected' : ''}>${esc(label)}</option>`;
}

function filterControls() {
  const projects = [...state.projects].sort((a, b) => !!a.archived_at - !!b.archived_at || a.name.localeCompare(b.name));
  const people = [...state.users].sort((a, b) => a.name.localeCompare(b.name));
  return `
    <label class="act-search">
      ${ICON.search}
      <input class="input small" type="search" name="q" value="${esc(filters.q)}" placeholder="${esc(t('Buscar no título ou no texto'))}" aria-label="${esc(t('Buscar'))}">
    </label>
    <select class="input small" name="project" aria-label="${esc(t('Projeto'))}">
      ${option('', t('Todos os projetos'), filters.project)}
      ${projects.map((p) => option(String(p.id), p.name, filters.project)).join('')}
    </select>
    <select class="input small" name="who" aria-label="${esc(t('Quem'))}">
      ${option('', t('Todas as pessoas'), filters.who)}
      <optgroup label="${esc(t('Pessoas'))}">${people.map((u) => option(`u:${u.id}`, u.name, filters.who)).join('')}</optgroup>
      <optgroup label="${esc(t('Outros'))}">
        ${option('a:claude', t('Claude'), filters.who)}
        ${option('a:automação', t('Automações'), filters.who)}
        ${option('a:e-mail', t('E-mail'), filters.who)}
      </optgroup>
    </select>
    <select class="input small" name="kind" aria-label="${esc(t('Tipo'))}">
      ${option('', t('Tudo'), filters.kind)}
      ${option('created', t('Tarefas criadas'), filters.kind)}
      ${option('note', t('Comentários'), filters.kind)}
      ${option('event', t('Alterações'), filters.kind)}
    </select>
    <span class="act-dates">
      <input class="input small" type="date" name="since" value="${esc(filters.since)}" max="${esc(filters.until)}" aria-label="${esc(t('De'))}" title="${esc(t('De'))}">
      <span class="muted">–</span>
      <input class="input small" type="date" name="until" value="${esc(filters.until)}" min="${esc(filters.since)}" aria-label="${esc(t('Até'))}" title="${esc(t('Até'))}">
    </span>
    <button class="btn ghost small" type="button" data-clear${filtered() ? '' : ' hidden'}>${ICON.close}<span>${t('Limpar')}</span></button>
    <button class="icon-btn small" type="button" data-refresh aria-label="${esc(t('Atualizar'))}" title="${esc(t('Atualizar'))}">${ICON.repeat}</button>`;
}

async function fetchRows(el, { reset = false } = {}) {
  const my = ++seq;
  const offset = reset ? 0 : rows.length;
  const more = $('[data-more]', el);
  if (more) more.disabled = true;
  const page = await attempt(() => api(`/api/activity?${query(offset)}`));
  if (my !== seq || !el.isConnected) return;
  if (!page) {
    if (more) more.disabled = false;
    if (reset) $('#act-feed', el).innerHTML = `<div class="empty-box">${ICON.blocked}<p>${t('Não foi possível carregar a atividade.')}</p></div>`;
    return;
  }
  rows = reset ? page : rows.concat(page);
  hasMore = page.length === PAGE;
  paintFeed(el);
}

// ---------- feed ----------

function dayLabel(day) {
  const today = localDate();
  const d = new Date(`${day}T12:00:00`);
  const y = new Date(`${today}T12:00:00`);
  y.setDate(y.getDate() - 1);
  if (day === today) return t('Hoje');
  if (day === localDate(y)) return t('Ontem');
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale(), { weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

function actor(r) {
  if (r.author === 'claude') return { pic: `<span class="avatar claude">${ICON.claude}</span>`, name: t('Claude') };
  if (r.user_id) {
    const u = userById(r.user_id) || { name: r.user_name || t('Alguém') };
    return { pic: avatar(u, { size: 24 }), name: u.name };
  }
  if (r.author === 'automação') return { pic: `<span class="act-sys">${ICON.zap}</span>`, name: t('Automação') };
  if (r.author === 'e-mail') return { pic: `<span class="act-sys">${ICON.mail}</span>`, name: t('E-mail') };
  if (r.author === 'você') return { pic: `<span class="act-sys">${ICON.user}</span>`, name: t('Você') };
  return { pic: `<span class="act-sys">${ICON.user}</span>`, name: r.author && r.author !== 'user' ? r.author : t('Alguém') };
}

function sentence(kind, who, task) {
  if (kind === 'created') return t('{who} criou {task}', { who, task });
  if (kind === 'note') return t('{who} comentou em {task}', { who, task });
  return t('{who} alterou {task}', { who, task });
}

function item(r) {
  const a = actor(r);
  const known = taskById(r.task_id);
  const ref = known?.ref || `#${r.task_id}`;
  const p = projectById(r.project_id) || { name: r.project_name };
  const who = `<b class="act-who">${esc(a.name)}</b>`;
  const task = `<button class="act-task" data-task="${r.task_id}"><span class="tid">${esc(ref)}</span> ${esc(r.title)}</button>`;
  const mentions = state.users.map((u) => u.name);
  return `
    <li class="act-item kind-${esc(r.kind)}">
      <span class="act-icon" title="${esc(r.kind === 'created' ? t('Tarefa criada') : r.kind === 'note' ? t('Comentário') : t('Alteração'))}">${KIND_ICON[r.kind] || ICON.dot}</span>
      <div class="act-main">
        <div class="act-line">${a.pic}<span>${sentence(r.kind, who, task)}</span></div>
        ${r.kind === 'event' && r.body ? `<div class="act-change">${esc(eventText(r.body))}</div>` : ''}
        ${r.kind === 'note' && r.body ? `<div class="act-body md" data-expand title="${esc(t('Clique para ver tudo'))}">${md(r.body, { mentions })}</div>` : ''}
        <div class="act-meta">
          <span class="act-project">${projectBadge(p)}<span>${esc(r.project_name)}</span></span>
          <time datetime="${esc(r.created_at)}" title="${esc(dtf.format(new Date(r.created_at)))}">${esc(ago(r.created_at))}</time>
        </div>
      </div>
    </li>`;
}

function paintFeed(el) {
  const feed = $('#act-feed', el);
  if (!rows.length) {
    feed.innerHTML = `<div class="empty-box">${ICON.history}<p>${filtered() ? t('Nenhuma atividade com esses filtros.') : t('Nenhuma atividade ainda.')}</p></div>`;
    return;
  }
  const days = new Map();
  for (const r of rows) {
    const day = localDate(new Date(r.created_at));
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(r);
  }
  feed.innerHTML = `
    ${[...days].map(([day, list]) => `
      <section class="act-day">
        <h3>${esc(dayLabel(day))} <span class="count">${list.length}</span></h3>
        <ul class="act-list">${list.map(item).join('')}</ul>
      </section>`).join('')}
    <div class="act-more">
      ${hasMore ? `<button class="btn bordered small" data-more>${t('Carregar mais')}</button>` : `<span class="muted small">${tn(rows.length, '{n} item', '{n} itens')}</span>`}
    </div>`;
}

// ---------- eventos ----------

function readFilters(form) {
  for (const k of Object.keys(EMPTY)) filters[k] = form.elements[k]?.value ?? '';
}

function refreshFilters(el) {
  const form = $('[data-form="filters"]', el);
  const focused = document.activeElement?.name;
  form.innerHTML = filterControls();
  if (focused) form.elements[focused]?.focus();
}

function bind(el) {
  const search = debounce(() => fetchRows(el, { reset: true }), 300);
  el.oninput = (e) => {
    if (e.target.name !== 'q') return;
    filters.q = e.target.value;
    $('[data-clear]', el).hidden = !filtered();
    search();
  };
  el.onchange = (e) => {
    const form = e.target.closest('[data-form="filters"]');
    if (!form || e.target.name === 'q') return;
    readFilters(form);
    refreshFilters(el);
    fetchRows(el, { reset: true });
  };
  el.onsubmit = (e) => {
    e.preventDefault();
    readFilters(e.target);
    fetchRows(el, { reset: true });
  };
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (b?.dataset.task) return openTask(Number(b.dataset.task));
    if (b && 'more' in b.dataset) return fetchRows(el);
    if (b && 'refresh' in b.dataset) return fetchRows(el, { reset: true });
    if (b && 'clear' in b.dataset) {
      Object.assign(filters, EMPTY);
      refreshFilters(el);
      return fetchRows(el, { reset: true });
    }
    // Comentário longo: clique abre/fecha (links continuam funcionando).
    const body = e.target.closest('[data-expand]');
    if (body && !e.target.closest('a')) body.classList.toggle('open');
  };
}
