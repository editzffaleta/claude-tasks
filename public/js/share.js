// Página pública de um link compartilhado (/s/<token>): tarefa ou projeto, só leitura, sem login.
// Usa só util.js e i18n.js: state.js, api.js e drawer.js pressupõem uma sessão aberta.
import { LANGUAGES, pickLanguage, setLanguage, t, tn } from './i18n.js';
import {
  $, COLUMN_LABEL, ICON, PRIORITY_LABEL, PROJECT_STATUS_LABEL, STATUS_LABEL, STATUSES, TYPE_LABEL,
  agentAvatar, agentByName, ago, avatar, columnLabel, dtf, dueInfo, esc, fmtDate, fmtNumber, localDate, md, prioIcon, projectColor, statusIcon, typeIcon,
} from './util.js';

const root = $('#share');
const token = location.pathname.match(/^\/s\/([\w-]+)/)?.[1] || '';
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

let data = null;
let mode = 'board';
let filter = '';

const fileUrl = (id) => `/api/public/${encodeURIComponent(token)}/attachments/${id}`;
// Imagens coladas na descrição apontam para /api/attachments/<id>, que exige login.
const publicMd = (src) => md(String(src || '').replace(/\/api\/attachments\/(\d+)/g, (_, id) => fileUrl(id)));
const when = (iso) => `<time datetime="${esc(iso)}" title="${esc(dtf.format(new Date(iso)))}">${esc(ago(iso))}</time>`;

function fmtBytes(n) {
  const [unit, size] = [['megabyte', 1e6], ['kilobyte', 1e3]].find(([, s]) => n >= s) || ['byte', 1];
  return fmtNumber(n / size, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: unit === 'byte' ? 0 : 1 });
}

function person(name, size = 22) {
  if (agentByName(name)) return agentAvatar(agentByName(name), { size });
  return avatar({ name }, { size });
}

function due(task) {
  const d = dueInfo(task, localDate());
  return d ? `<span class="due ${d.cls}" title="${esc(d.title)}">${ICON.calendar} ${esc(d.text)}</span>` : '';
}

async function boot() {
  const preferred = (navigator.languages?.length ? navigator.languages : [navigator.language])
    .map((l) => String(l || '').slice(0, 2).toLowerCase()).find((l) => LANGUAGES[l]);
  await setLanguage(pickLanguage(preferred, null));
  document.title = `${t('Link compartilhado')} · ${t('Quadro de Tarefas')}`;
  $('#share-foot').innerHTML = `${ICON.lock}<span>${t('Somente leitura · Quadro de tarefas')}</span>`;
  root.onclick = onClick;
  root.oninput = onInput;
  await fetchShare();
}

async function fetchShare() {
  root.innerHTML = `<p class="share-loading muted">${t('Carregando…')}</p>`;
  let res;
  try {
    res = token ? await fetch(`/api/public/${encodeURIComponent(token)}`) : { status: 404, ok: false };
  } catch {
    res = null;
  }
  if (res?.ok) {
    data = await res.json();
    render();
  } else if (res && (res.status === 404 || res.status === 400)) {
    document.title = `${t('Link inválido ou expirado')} · ${t('Quadro de Tarefas')}`;
    root.innerHTML = errorCard(t('Link inválido ou expirado'), t('Este link foi revogado, expirou ou nunca existiu. Peça um link novo a quem compartilhou.'));
  } else {
    root.innerHTML = errorCard(t('Não foi possível carregar'), t('Confira a conexão e tente de novo.'), true);
  }
}

function errorCard(title, text, retry = false) {
  return `
    <div class="card-box share-error">
      ${ICON.link}
      <h1>${esc(title)}</h1>
      <p class="muted">${esc(text)}</p>
      ${retry ? `<button class="btn bordered" data-retry>${t('Tentar de novo')}</button>` : ''}
    </div>`;
}

function render() {
  if (data.kind === 'task') renderTask(data);
  else renderProject(data);
}

// ---------- tarefa ----------

function renderTask({ task: tk, project }) {
  document.title = `${tk.title} · ${t('Quadro de Tarefas')}`;
  const props = [
    [t('Status'), `<span class="share-status">${statusIcon(tk.status)}${esc(tk.column || STATUS_LABEL[tk.status])}</span>`],
    [t('Prioridade'), `<span class="share-status">${prioIcon(tk.priority)}${esc(PRIORITY_LABEL[tk.priority])}</span>`],
    [t('Tipo'), `<span class="share-status">${typeIcon(tk.type, { always: true })}${esc(TYPE_LABEL[tk.type])}</span>`],
    tk.start_date && [t('Início'), esc(fmtDate(tk.start_date, { year: true }))],
    tk.due_date && [t('Prazo'), due(tk)],
    tk.story_points != null && [t('Pontos'), esc(fmtNumber(tk.story_points))],
    tk.assignees.length && [t('Responsáveis'), `<span class="share-people">${tk.assignees.map((n) => `<span class="person">${person(n, 20)}<span>${esc(n)}</span></span>`).join('')}</span>`],
    tk.tags.length && [t('Tags'), tk.tags.map((x) => `<span class="chip tag">${esc(x)}</span>`).join(' ')],
  ].filter(Boolean);
  const images = tk.attachments.filter((a) => INLINE_IMAGES.has(a.mime));
  const files = tk.attachments.filter((a) => !INLINE_IMAGES.has(a.mime));
  root.innerHTML = `
    <article class="share-task">
      <header class="share-head">
        <div class="share-crumb"><span class="dot" style="--c:${esc(projectColor(project))}"></span><span>${esc(project.name)}</span><span class="tid">${esc(tk.ref || `#${tk.id}`)}</span></div>
        <h1>${esc(tk.title)}</h1>
        <p class="muted small">${t('Atualizada {when}', { when: when(tk.updated_at) })}</p>
      </header>

      <dl class="share-props">${props.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>

      <section class="card-box">
        <h3>${t('Descrição')}</h3>
        ${tk.description ? `<div class="md">${publicMd(tk.description)}</div>` : `<p class="muted">${t('Sem descrição.')}</p>`}
      </section>

      ${tk.subtasks.length ? `
        <section class="card-box">
          <h3>${ICON.subtask} ${t('Subtarefas')} <span class="count">${t('{done} de {total}', { done: tk.subtasks.filter((s) => s.status === 'done').length, total: tk.subtasks.length })}</span></h3>
          <ul class="share-checklist">
            ${tk.subtasks.map((s) => `<li class="${s.status === 'done' ? 'done' : ''}">${statusIcon(s.status)}<span>${esc(s.title)}</span></li>`).join('')}
          </ul>
        </section>` : ''}

      ${tk.attachments.length ? `
        <section class="card-box">
          <h3>${ICON.clip} ${t('Anexos')} <span class="count">${tk.attachments.length}</span></h3>
          ${images.length ? `<div class="thumbs">${images.map((a) => `
            <figure class="thumb"><a href="${fileUrl(a.id)}" target="_blank" rel="noopener" title="${esc(a.name)}"><img src="${fileUrl(a.id)}" alt="${esc(a.name)}" loading="lazy"></a></figure>`).join('')}</div>` : ''}
          ${files.map((a) => `
            <div class="file-row">${ICON.clip}<a href="${fileUrl(a.id)}" target="_blank" rel="noopener">${esc(a.name)}</a><span class="muted small">${esc(fmtBytes(a.size || 0))}</span></div>`).join('')}
        </section>` : ''}

      <section class="card-box">
        <h3>${ICON.comment} ${t('Comentários')} <span class="count">${tk.comments.length}</span></h3>
        ${tk.comments.length ? thread(tk.comments) : `<p class="muted">${t('Nenhum comentário.')}</p>`}
      </section>
    </article>`;
}

// Comentários com respostas aninhadas (parent_id).
function thread(comments) {
  const ids = new Set(comments.map((c) => c.id));
  const kids = new Map();
  for (const c of comments) {
    const parent = c.parent_id && ids.has(c.parent_id) ? c.parent_id : null;
    if (!kids.has(parent)) kids.set(parent, []);
    kids.get(parent).push(c);
  }
  const branch = (parent, depth) => {
    const list = kids.get(parent) || [];
    if (!list.length) return '';
    return `<ul class="share-thread${depth ? ' replies' : ''}">${list.map((c) => `
      <li class="share-comment">
        ${person(c.author, 24)}
        <div class="share-comment-main">
          <div class="note-meta"><b>${esc(c.author)}</b> · ${when(c.created_at)}</div>
          <div class="md note-body">${publicMd(c.body)}</div>
          ${branch(c.id, depth + 1)}
        </div>
      </li>`).join('')}</ul>`;
  };
  return branch(null, 0);
}

// ---------- projeto ----------

function columnsOf(payload) {
  const cols = payload.columns?.length ? payload.columns : STATUSES.map((s) => ({ id: null, name: null, status: s }));
  return cols.map((c, i) => ({ ...c, key: c.id ?? `s:${c.status}:${i}`, label: c.id == null ? COLUMN_LABEL[c.status] : columnLabel(c.name, c.status) }));
}

// Coluna da tarefa: column_id quando existe; senão a primeira coluna com o mesmo status.
function columnFor(task, cols) {
  return (task.column_id != null && cols.find((c) => c.id === task.column_id)) || cols.find((c) => c.status === task.status) || cols[0];
}

function renderProject(payload) {
  const p = payload.project;
  document.title = `${p.name} · ${t('Quadro de Tarefas')}`;
  const dates = p.start_date || p.end_date
    ? `${p.start_date ? esc(fmtDate(p.start_date, { year: true })) : '…'} → ${p.end_date ? esc(fmtDate(p.end_date, { year: true })) : '…'}`
    : '';
  root.innerHTML = `
    <article class="share-project">
      <header class="share-head">
        <h1><span class="dot big" style="--c:${esc(projectColor(p))}"></span>${esc(p.name)}</h1>
        <div class="share-chips">
          ${p.status ? `<span class="chip">${esc(PROJECT_STATUS_LABEL[p.status] || p.status)}</span>` : ''}
          ${dates ? `<span class="chip">${ICON.calendar}${dates}</span>` : ''}
          <span class="chip">${tn(payload.tasks.length, '{n} tarefa', '{n} tarefas')}</span>
        </div>
        ${p.description ? `<div class="md share-desc-top">${md(p.description)}</div>` : ''}
      </header>
      <div class="share-toolbar">
        <div class="seg" role="tablist" aria-label="${esc(t('Visualização'))}">
          <button data-mode="board" role="tab" aria-selected="${mode === 'board'}" class="${mode === 'board' ? 'on' : ''}">${ICON.board} ${t('Quadro')}</button>
          <button data-mode="list" role="tab" aria-selected="${mode === 'list'}" class="${mode === 'list' ? 'on' : ''}">${ICON.list} ${t('Lista')}</button>
        </div>
        <label class="search share-search">${ICON.search}<input type="search" value="${esc(filter)}" placeholder="${esc(t('Filtrar tarefas'))}" aria-label="${esc(t('Filtrar tarefas'))}" data-filter></label>
        <span class="hint">${t('Mostra as tarefas abertas e as concluídas nos últimos 30 dias.')}</span>
      </div>
      <div id="share-tasks"></div>
    </article>`;
  paintTasks();
}

function visibleTasks() {
  const q = filter.trim().toLowerCase();
  if (!q) return data.tasks;
  return data.tasks.filter((x) => `${x.ref || ''} ${x.title} ${x.tags.join(' ')} ${x.assignees.join(' ')}`.toLowerCase().includes(q));
}

function cardMeta(x) {
  return [
    due(x),
    x.subtask_count ? `<span class="meta-icon${x.subtask_done === x.subtask_count ? ' complete' : ''}">${ICON.subtask}${x.subtask_done}/${x.subtask_count}</span>` : '',
    x.story_points != null ? `<span class="meta-icon">${ICON.points}${esc(fmtNumber(x.story_points))}</span>` : '',
    ...x.tags.map((tag) => `<span class="chip tag">${esc(tag)}</span>`),
    x.assignees.length ? `<span class="avatars">${x.assignees.map((n) => person(n, 20)).join('')}</span>` : '',
  ].filter(Boolean).join('');
}

function card(x) {
  return `
    <article class="card share-card${x.status === 'done' ? ' done' : ''}">
      <div class="card-top">${typeIcon(x.type)}<span class="tid">${esc(x.ref || `#${x.id}`)}</span><span class="spacer"></span>${prioIcon(x.priority)}</div>
      <h3>${esc(x.title)}</h3>
      ${cardMeta(x) ? `<div class="card-meta">${cardMeta(x)}</div>` : ''}
      ${x.description ? `<details class="share-details"><summary>${t('Descrição')}</summary><div class="md">${publicMd(x.description)}</div></details>` : ''}
    </article>`;
}

function paintTasks() {
  const box = $('#share-tasks');
  const cols = columnsOf(data);
  const tasks = visibleTasks();
  const byCol = new Map(cols.map((c) => [c.key, []]));
  for (const x of tasks) byCol.get(columnFor(x, cols).key).push(x);
  if (mode === 'board') {
    box.innerHTML = `
      <div class="board share-board" style="--cols:${cols.length}">
        ${cols.map((c) => `
          <section class="column">
            <header class="column-head">${statusIcon(c.status)}<h2>${esc(c.label)}</h2><span class="count">${byCol.get(c.key).length}</span></header>
            <div class="cards">${byCol.get(c.key).map(card).join('') || `<div class="empty-col">${t('Nada aqui')}</div>`}</div>
          </section>`).join('')}
      </div>`;
    return;
  }
  const ordered = cols.flatMap((c) => byCol.get(c.key).map((x) => [x, c]));
  box.innerHTML = ordered.length ? `
    <ul class="card-box share-rows">
      ${ordered.map(([x, c]) => `
        <li class="share-row${x.status === 'done' ? ' done' : ''}">
          <span class="share-row-title">${statusIcon(x.status)}<span class="tid">${esc(x.ref || `#${x.id}`)}</span><span class="t">${esc(x.title)}</span></span>
          <span class="share-row-meta">
            <span class="chip" title="${esc(t('Coluna'))}">${esc(c.label)}</span>
            ${prioIcon(x.priority)}
            ${cardMeta(x)}
          </span>
        </li>`).join('')}
    </ul>` : `<div class="empty-box">${ICON.search}<p>${t('Nenhuma tarefa encontrada.')}</p></div>`;
}

// ---------- eventos ----------

function onClick(e) {
  const b = e.target.closest('button');
  if (!b) return;
  if ('retry' in b.dataset) return fetchShare();
  if (b.dataset.mode && b.dataset.mode !== mode) {
    mode = b.dataset.mode;
    for (const x of root.querySelectorAll('[data-mode]')) {
      x.classList.toggle('on', x.dataset.mode === mode);
      x.setAttribute('aria-selected', String(x.dataset.mode === mode));
    }
    paintTasks();
  }
}

function onInput(e) {
  if (!e.target.matches('[data-filter]')) return;
  filter = e.target.value;
  paintTasks();
}

boot();
