// Painel lateral de detalhes: campos, descrição, subtarefas, dependências, tempo, anexos e atividade.
import { api, attempt, toast, upload } from './api.js';
import { state, syncUrl, load, navigate, userById } from './state.js';
import { confirmAction, showMenu } from './ui.js';
import {
  $, $$, FREQ_LABEL, ICON, PRIORITIES, PRIORITY_LABEL, STATUS_LABEL, TYPES, TYPE_LABEL, ago, avatar, describeRecurrence,
  dtf, dueInfo, esc, fmtDate, fmtDuration, localDate, md, prioIcon, statusIcon, tilde, typeIcon,
} from './util.js';

let task = null;
let editingDesc = false;
let showTimeForm = false;

const drawer = () => $('#drawer');
const isTyping = () => document.activeElement?.matches?.('input, textarea, select') && drawer().contains(document.activeElement);

export async function openTask(id) {
  if (state.taskId !== id) { editingDesc = false; showTimeForm = false; }
  state.taskId = id;
  syncUrl();
  try {
    task = await api(`/api/tasks/${id}`);
  } catch (e) {
    toast(e.message, true);
    return closeDrawer();
  }
  render();
  drawer().classList.add('open');
  drawer().setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').classList.add('show');
  $$('.selected[data-id], .selected[data-row]').forEach((c) => c.classList.remove('selected'));
  $$(`[data-id="${id}"].card, tr[data-id="${id}"], [data-row="${id}"]`).forEach((c) => c.classList.add('selected'));
}

export function closeDrawer() {
  saveDescription();
  state.taskId = null;
  task = null;
  syncUrl();
  drawer()?.classList.remove('open');
  drawer()?.setAttribute('aria-hidden', 'true');
  $('#drawer-scrim')?.classList.remove('show');
  $$('.selected[data-id], .selected[data-row]').forEach((c) => c.classList.remove('selected'));
}

export async function refreshDrawer() {
  if (!state.taskId) return;
  try {
    task = await api(`/api/tasks/${state.taskId}`);
  } catch {
    toast('Essa tarefa foi excluída');
    return closeDrawer();
  }
  // Não atropela o que está sendo digitado: só atualiza as listas.
  if (isTyping()) renderSections();
  else render();
}

async function patch(body, success) {
  const id = task.id;
  const r = await attempt(() => api(`/api/tasks/${id}`, { method: 'PATCH', body }), success);
  if (r) await Promise.all([load(), refreshDrawer()]);
  return r;
}

// ---------- seções ----------

function props(t) {
  const people = (task.assignees || []);
  const columns = task.columns || [];
  const currentCol = t.column_id ?? columns.find((c) => c.status === t.status)?.id ?? t.status;
  const sprints = (task.sprints || []).filter((s) => s.status !== 'completed' || s.id === t.sprint_id);
  const due = dueInfo(t, state.today);
  const opts = (map, value) => Object.entries(map).map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${esc(l)}</option>`).join('');
  return `
    <div class="props">
      <span>Status</span>
      <select id="d-column">${columns.map((c) => `<option value="${c.id ?? c.status}" ${String(c.id ?? c.status) === String(currentCol) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
      <span>Prioridade</span><select id="d-priority">${opts(Object.fromEntries(PRIORITIES.map((p) => [p, PRIORITY_LABEL[p]])), t.priority)}</select>
      <span>Tipo</span><select id="d-type">${opts(Object.fromEntries(TYPES.map((x) => [x, TYPE_LABEL[x]])), t.type)}</select>
      <span>Responsáveis</span>
      <div class="people-field">
        ${people.map((u) => `<span class="person">${avatar(u, { size: 20 })}${esc(u.name)}<button class="x" data-unassign="${u.id}" aria-label="Remover ${esc(u.name)}">${ICON.close}</button></span>`).join('')}
        <button class="add-chip" data-action="assign">${ICON.plus}${people.length ? '' : 'Atribuir'}</button>
      </div>
      <span>Início</span><input type="date" id="d-start" value="${t.start_date || ''}">
      <span>Prazo</span>
      <div class="inline"><input type="date" id="d-due" value="${t.due_date || ''}">${due && due.cls ? `<span class="due ${due.cls}">${due.title}</span>` : ''}</div>
      <span>Estimativa</span><input id="d-estimate" value="${t.estimate_minutes ? fmtDuration(t.estimate_minutes) : ''}" placeholder="ex.: 2h, 1h30m, 1d">
      <span>Sprint</span>
      <select id="d-sprint"><option value="">Backlog</option>${sprints.map((s) => `<option value="${s.id}" ${s.id === t.sprint_id ? 'selected' : ''}>${esc(s.name)}${s.status === 'active' ? ' · ativa' : ''}</option>`).join('')}</select>
      <span>Projeto</span>
      <select id="d-project">${state.projects.filter((p) => !p.archived_at || p.id === t.project_id).map((p) => `<option value="${p.id}" ${p.id === t.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <span>Recorrência</span>
      <div class="inline">
        <select id="d-recur"><option value="">Não repete</option>${opts(FREQ_LABEL, t.recurrence?.freq || '')}</select>
        ${t.recurrence ? `<label class="inline-field">a cada <input type="number" id="d-interval" min="1" max="365" value="${t.recurrence.interval || 1}"></label>` : ''}
      </div>
      <span>Tags</span><input id="d-tags" value="${esc(t.tags.join(', '))}" placeholder="Separadas por vírgula">
      ${t.project_path ? `<span>Pasta</span><div class="path">${esc(tilde(t.project_path))}</div>` : ''}
    </div>`;
}

function descSection(t) {
  return `
    <section>
      <div class="section-label">Descrição <button data-action="toggle-desc">${editingDesc ? 'Concluir' : 'Editar'}</button></div>
      ${editingDesc
        ? `<textarea class="input desc-edit" id="d-desc" placeholder="Contexto, arquivos, critérios de pronto… Cole imagens direto aqui.">${esc(t.description)}</textarea>
           <p class="hint">Markdown simples. <kbd>⌘</kbd><kbd>↵</kbd> ou <kbd>Esc</kbd> para concluir. Cole uma imagem para anexar.</p>`
        : `<div class="desc ${t.description ? '' : 'empty'}" data-action="toggle-desc">${t.description ? md(t.description) : 'Sem descrição. Clique para adicionar.'}</div>`}
    </section>`;
}

function subtasksSection(t) {
  const list = task.subtasks || [];
  const done = list.filter((s) => s.status === 'done').length;
  return `
    <div class="section-label">${ICON.subtask} Subtarefas ${list.length ? `<span class="count">${done}/${list.length}</span>` : ''}</div>
    ${list.length ? `<div class="progress"><span style="width:${(done / list.length) * 100}%"></span></div>` : ''}
    <div class="sublist">
      ${list.map((s) => `
        <div class="subrow ${s.status === 'done' ? 'done' : ''}">
          <button class="check-btn ${s.status === 'done' ? 'on' : ''}" data-subtoggle="${s.id}" aria-label="Concluir #${s.id}">${s.status === 'done' ? ICON.check : ''}</button>
          <button class="subtitle" data-open="${s.id}">${prioIcon(s.priority)}<span class="tid">#${s.id}</span><span>${esc(s.title)}</span></button>
          ${s.due_date ? `<span class="due ${dueInfo(s, state.today)?.cls}">${dueInfo(s, state.today).text}</span>` : ''}
          ${s.assignee_ids.map(userById).filter(Boolean).map((u) => avatar(u, { size: 18 })).join('')}
          <span class="status-mini" title="${STATUS_LABEL[s.status]}">${statusIcon(s.status)}</span>
        </div>`).join('')}
      <form class="add-row" data-form="subtask">
        <input class="input small" name="title" placeholder="Adicionar subtarefa…" autocomplete="off" maxlength="300">
      </form>
    </div>`;
}

function depsSection() {
  const row = (d, removable) => `
    <div class="dep-row ${d.status === 'done' ? 'done' : ''}">
      ${statusIcon(d.status)}<button class="subtitle" data-open="${d.id}"><span class="tid">#${d.id}</span><span>${esc(d.title)}</span></button>
      ${d.project_id !== task.project_id ? `<span class="chip">${esc(d.project_name)}</span>` : ''}
      ${removable ? `<button class="icon-btn tiny" data-unblock="${d.id}" aria-label="Remover dependência">${ICON.close}</button>` : ''}
    </div>`;
  const candidates = state.tasks.filter((x) => x.id !== task.id && x.status !== 'done' && !task.blockers.some((b) => b.id === x.id));
  return `
    <div class="section-label">${ICON.link} Dependências</div>
    <div class="deps">
      <div class="dep-group"><small>Bloqueada por</small>
        ${task.blockers.map((d) => row(d, true)).join('') || '<div class="muted small">Nada bloqueando.</div>'}
        <form class="add-row" data-form="blocker">
          <input class="input small" name="ref" list="dep-options" placeholder="#id ou título da tarefa que precisa vir antes" autocomplete="off">
          <datalist id="dep-options">${candidates.slice(0, 300).map((x) => `<option value="#${x.id} ${esc(x.title)}"></option>`).join('')}</datalist>
        </form>
      </div>
      ${task.blocking.length ? `<div class="dep-group"><small>Bloqueia</small>${task.blocking.map((d) => row(d, false)).join('')}</div>` : ''}
    </div>`;
}

function timeSection(t) {
  const spent = t.spent_minutes || 0;
  const est = t.estimate_minutes || 0;
  const pct = est ? Math.min(100, (spent / est) * 100) : 0;
  const mine = state.timers.find((x) => x.task_id === t.id);
  return `
    <div class="section-label">${ICON.clock} Tempo
      <button data-action="time-form">${showTimeForm ? 'Cancelar' : 'Registrar manualmente'}</button>
    </div>
    <div class="time-summary">
      <button class="btn ${mine ? 'danger-solid' : 'ghost bordered'} small" data-action="${mine ? 'stop' : 'start'}">${mine ? `${ICON.stop} Parar timer` : `${ICON.play} Iniciar timer`}</button>
      <div class="time-numbers"><b>${fmtDuration(spent)}</b>${est ? ` de ${fmtDuration(est)}` : ' gastos'}${est && spent > est ? ' <span class="over">acima da estimativa</span>' : ''}</div>
    </div>
    ${est ? `<div class="progress ${spent > est ? 'over' : ''}"><span style="width:${pct}%"></span></div>` : ''}
    ${showTimeForm ? `
      <form class="time-form" data-form="time">
        <input class="input small" name="duration" placeholder="45m, 1h30m" required>
        <input class="input small" type="date" name="date" value="${localDate()}">
        <input class="input small" name="note" placeholder="O que foi feito (opcional)">
        <button class="btn primary small" type="submit">Salvar</button>
      </form>` : ''}
    ${task.time_entries.length ? `
      <div class="time-list">
        ${task.time_entries.slice(0, 20).map((e) => `
          <div class="time-row">
            <span class="who">${e.author === 'claude' ? `Claude${e.user_name ? ` · ${esc(e.user_name)}` : ''}` : e.user_name ? esc(e.user_name) : 'Você'}</span>
            <span class="muted">${fmtDate(localDate(new Date(e.started_at)))}</span>
            <span class="note">${esc(e.note)}</span>
            <b>${e.ended_at ? fmtDuration(e.minutes) : '<span class="live-time">rodando</span>'}</b>
            <button class="icon-btn tiny" data-deltime="${e.id}" aria-label="Apagar registro">${ICON.trash}</button>
          </div>`).join('')}
      </div>` : ''}`;
}

function filesSection() {
  const images = task.attachments.filter((a) => a.mime.startsWith('image/') && a.mime !== 'image/svg+xml');
  const others = task.attachments.filter((a) => !images.includes(a));
  return `
    <div class="section-label">${ICON.clip} Anexos <span class="count">${task.attachments.length || ''}</span>
      <button data-action="upload">Adicionar</button>
    </div>
    <input type="file" id="d-file" multiple hidden>
    ${images.length ? `<div class="thumbs">${images.map((a) => `
      <figure class="thumb"><a href="/api/attachments/${a.id}" target="_blank" rel="noopener"><img src="/api/attachments/${a.id}" alt="${esc(a.name)}" loading="lazy"></a>
        <button class="icon-btn tiny" data-delfile="${a.id}" aria-label="Apagar ${esc(a.name)}">${ICON.close}</button></figure>`).join('')}</div>` : ''}
    ${others.map((a) => `
      <div class="file-row">${ICON.clip}<a href="/api/attachments/${a.id}" target="_blank" rel="noopener">${esc(a.name)}</a>
        <span class="muted">${a.size > 1048576 ? `${(a.size / 1048576).toFixed(1)} MB` : `${Math.ceil(a.size / 1024)} KB`}</span>
        <button class="icon-btn tiny" data-delfile="${a.id}" aria-label="Apagar ${esc(a.name)}">${ICON.close}</button></div>`).join('')}
    ${task.attachments.length ? '' : '<div class="dropzone" data-action="upload">Arraste arquivos aqui ou clique para anexar</div>'}`;
}

function who(n) {
  if (n.user_name) return esc(n.user_name);
  return { claude: 'Claude', 'automação': 'Automação', 'você': 'Você', user: 'Alguém' }[n.author] || esc(n.author);
}

function timeline(t) {
  const created = `<div class="note event"><div class="avatar-dot">${ICON.dot}</div><div class="note-meta"><b>${t.source === 'claude' ? 'Claude' : t.source === 'automação' ? 'Automação' : 'Você'}</b> criou a tarefa · ${ago(t.created_at)}</div></div>`;
  return created + task.notes.map((n) => {
    const when = `<span title="${dtf.format(new Date(n.created_at))}">${ago(n.created_at)}</span>`;
    if (n.kind === 'event') return `<div class="note event"><div class="avatar-dot">${ICON.dot}</div><div class="note-meta"><b>${who(n)}</b> ${esc(n.body)} · ${when}</div></div>`;
    const av = n.author === 'claude' ? `<span class="avatar claude">${ICON.claude}</span>` : n.user_name ? avatar({ name: n.user_name, color: n.user_color }, { size: 22 }) : `<span class="avatar">${who(n)[0]}</span>`;
    return `<div class="note">${av}<div><div class="note-meta"><b>${who(n)}</b> · ${when}</div><div class="note-body md">${md(n.body)}</div></div></div>`;
  }).join('');
}

function renderSections() {
  if (!task) return;
  const t = task;
  const set = (id, html) => { const el = $(`#${id}`); if (el) el.innerHTML = html; };
  set('d-subtasks', subtasksSection(t));
  set('d-deps', depsSection());
  set('d-time', timeSection(t));
  set('d-files', filesSection());
  set('d-timeline', timeline(t));
}

function render() {
  const t = task;
  if (!t) return;
  $('#drawer-inner').innerHTML = `
    <div class="drawer-head">
      ${typeIcon(t.type, { always: true })}<span class="tid">#${t.id}</span><span>·</span>
      <button class="link-btn" data-goproject="${t.project_id}">${esc(t.project_name)}</button>
      ${t.parent_id ? `<span>·</span><button class="link-btn parent" data-open="${t.parent_id}">${ICON.subtask}${esc(t.parent_title || `#${t.parent_id}`)}</button>` : ''}
      ${t.archived_at ? '<span class="chip">arquivada</span>' : ''}
      <span class="spacer"></span>
      <button class="icon-btn small" data-action="copy" title="Copiar pedido para colar numa sessão do Claude">${ICON.copy}</button>
      <button class="icon-btn small" data-action="more" title="Mais ações">${ICON.more}</button>
      <button class="icon-btn small" data-action="close" title="Fechar (Esc)">${ICON.close}</button>
    </div>
    <textarea class="title-edit" id="d-title" rows="1" maxlength="300" aria-label="Título">${esc(t.title)}</textarea>
    ${props(t)}
    ${descSection(t)}
    <section id="d-subtasks">${subtasksSection(t)}</section>
    <section id="d-deps">${depsSection()}</section>
    <section id="d-time">${timeSection(t)}</section>
    <section id="d-files">${filesSection()}</section>
    <section>
      <div class="section-label">Atividade</div>
      <div class="timeline" id="d-timeline">${timeline(t)}</div>
      <div class="comment-box">
        <textarea class="input" id="d-note" rows="2" placeholder="Escreva um comentário… (cole imagens aqui)"></textarea>
        <div class="row"><span class="hint"><kbd>⌘</kbd><kbd>↵</kbd></span><button class="btn ghost bordered small" data-action="note">Comentar</button></div>
      </div>
    </section>
    <div class="drawer-foot">
      ${t.status === 'done'
        ? '<button class="btn ghost bordered" data-action="reopen">Reabrir</button>'
        : `<button class="btn primary" data-action="complete">${ICON.check} Concluir</button>`}
      ${t.recurrence ? `<span class="hint">${ICON.repeat} ${describeRecurrence(t.recurrence)}</span>` : ''}
      <span class="spacer"></span>
      <button class="btn ghost" data-action="archive">${ICON.archive}${t.archived_at ? 'Desarquivar' : 'Arquivar'}</button>
      <button class="btn danger" data-action="delete">${ICON.trash}Excluir</button>
    </div>`;
  autosize($('#d-title'));
  if (editingDesc) $('#d-desc')?.focus();
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// ---------- ações ----------

function saveDescription() {
  const value = $('#d-desc')?.value;
  if (task && value != null && value !== task.description) {
    task.description = value;
    patch({ description: value });
  }
}

async function addFiles(files, { insertInto } = {}) {
  for (const file of files) {
    const name = file.name && file.name !== 'image.png' ? file.name : `colado-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`;
    const a = await attempt(() => upload(task.id, file, name));
    if (a && insertInto && file.type.startsWith('image/')) {
      const el = insertInto;
      const snippet = `![${a.name}](/api/attachments/${a.id})`;
      const pos = el.selectionStart ?? el.value.length;
      el.value = `${el.value.slice(0, pos)}${snippet}${el.value.slice(pos)}`;
      el.dispatchEvent(new Event('input'));
    }
  }
  await Promise.all([load(), refreshDrawer()]);
}

async function addComment() {
  const el = $('#d-note');
  const body = el.value.trim();
  if (!body || !task) return;
  const r = await attempt(() => api(`/api/tasks/${task.id}/notes`, { method: 'POST', body: { body } }));
  if (r) {
    el.value = '';
    await Promise.all([load(), refreshDrawer()]);
  }
}

function assignMenu(anchor) {
  const current = new Set((task.assignees || []).map((u) => u.id));
  if (!state.users.length) return toast('Convide pessoas na página Equipe para atribuir tarefas');
  showMenu(anchor, state.users.map((u) => ({
    label: u.name,
    icon: avatar(u, { size: 18 }),
    checked: current.has(u.id),
    onClick: () => {
      const next = current.has(u.id) ? [...current].filter((x) => x !== u.id) : [...current, u.id];
      patch({ assignee_ids: next });
    },
  })));
}

function moreMenu(anchor) {
  const t = task;
  showMenu(anchor, [
    { label: 'Adicionar subtarefa', icon: ICON.subtask, onClick: () => $('[data-form="subtask"] input')?.focus() },
    { label: t.timer_running ? 'Parar timer' : 'Iniciar timer', icon: ICON.clock, onClick: () => timer(t.timer_running ? 'stop' : 'start') },
    { label: 'Copiar link', icon: ICON.link, onClick: () => navigator.clipboard.writeText(`${location.origin}/?task=${t.id}`).then(() => toast('Link copiado')) },
    { divider: true },
    { label: t.archived_at ? 'Desarquivar' : 'Arquivar', icon: ICON.archive, onClick: () => patch({ archived: !t.archived_at }) },
    { label: 'Excluir tarefa', icon: ICON.trash, danger: true, onClick: deleteTask },
  ], { align: 'right' });
}

async function timer(action) {
  const r = await attempt(() => api(`/api/tasks/${task.id}/timer`, { method: 'POST', body: { action } }), action === 'start' ? 'Timer iniciado' : 'Timer parado');
  if (r) await Promise.all([load(), refreshDrawer()]);
}

async function deleteTask() {
  const n = task.subtask_count;
  const ok = await confirmAction(`Excluir a tarefa #${task.id}${n ? ` e ${n} subtarefa(s)` : ''}? Não dá para desfazer.`, { title: 'Excluir tarefa', okLabel: 'Excluir' });
  if (!ok) return;
  const id = task.id;
  if (await attempt(() => api(`/api/tasks/${id}`, { method: 'DELETE' }), 'Tarefa excluída')) {
    closeDrawer();
    load();
  }
}

export function mountDrawer() {
  const d = drawer();

  d.onclick = async (e) => {
    const t = task;
    if (!t) return;
    const open = e.target.closest('[data-open]');
    if (open) return openTask(Number(open.dataset.open));
    const proj = e.target.closest('[data-goproject]');
    if (proj) { closeDrawer(); return navigate({ projectId: Number(proj.dataset.goproject) }); }
    const unassign = e.target.closest('[data-unassign]');
    if (unassign) return patch({ assignee_ids: task.assignees.map((u) => u.id).filter((x) => x !== Number(unassign.dataset.unassign)) });
    const subtoggle = e.target.closest('[data-subtoggle]');
    if (subtoggle) {
      const s = task.subtasks.find((x) => x.id === Number(subtoggle.dataset.subtoggle));
      await attempt(() => api(`/api/tasks/${s.id}`, { method: 'PATCH', body: { status: s.status === 'done' ? 'todo' : 'done' } }));
      return Promise.all([load(), refreshDrawer()]);
    }
    const unblock = e.target.closest('[data-unblock]');
    if (unblock) {
      await attempt(() => api(`/api/tasks/${t.id}/blockers/${unblock.dataset.unblock}`, { method: 'DELETE' }));
      return Promise.all([load(), refreshDrawer()]);
    }
    const deltime = e.target.closest('[data-deltime]');
    if (deltime) {
      await attempt(() => api(`/api/time/${deltime.dataset.deltime}`, { method: 'DELETE' }));
      return Promise.all([load(), refreshDrawer()]);
    }
    const delfile = e.target.closest('[data-delfile]');
    if (delfile) {
      if (!(await confirmAction('Apagar este anexo?', { okLabel: 'Apagar' }))) return;
      await attempt(() => api(`/api/attachments/${delfile.dataset.delfile}`, { method: 'DELETE' }));
      return Promise.all([load(), refreshDrawer()]);
    }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'close') closeDrawer();
    if (action === 'more') moreMenu(e.target.closest('[data-action]'));
    if (action === 'assign') assignMenu(e.target.closest('[data-action]'));
    if (action === 'toggle-desc') {
      if (editingDesc) saveDescription();
      editingDesc = !editingDesc;
      render();
    }
    if (action === 'note') addComment();
    if (action === 'complete') patch({ status: 'done' }, `#${t.id} concluída`);
    if (action === 'reopen') patch({ status: 'todo' });
    if (action === 'archive') patch({ archived: !t.archived_at }, t.archived_at ? 'Tarefa desarquivada' : 'Tarefa arquivada');
    if (action === 'delete') deleteTask();
    if (action === 'start' || action === 'stop') timer(action);
    if (action === 'time-form') { showTimeForm = !showTimeForm; renderSections(); $('[data-form="time"] input')?.focus(); }
    if (action === 'upload') $('#d-file').click();
    if (action === 'copy') {
      await navigator.clipboard.writeText(`Pegue a tarefa #${t.id} do quadro de tarefas (“${t.title}”), leia os detalhes com get_task e trabalhe nela.`);
      toast('Pedido copiado. Cole numa sessão do Claude');
    }
  };

  d.onchange = (e) => {
    if (!task) return;
    const { id, value } = e.target;
    if (id === 'd-column') patch({ column: /^\d+$/.test(value) ? Number(value) : value });
    if (id === 'd-priority') patch({ priority: value });
    if (id === 'd-type') patch({ type: value });
    if (id === 'd-start') patch({ start_date: value || null });
    if (id === 'd-due') patch({ due_date: value || null });
    if (id === 'd-sprint') patch({ sprint_id: value ? Number(value) : null });
    if (id === 'd-project') patch({ project_id: Number(value) }, 'Tarefa movida');
    if (id === 'd-recur' || id === 'd-interval') {
      const freq = $('#d-recur').value;
      patch({ recurrence: freq ? { freq, interval: Number($('#d-interval')?.value) || 1 } : null });
    }
    if (id === 'd-file') addFiles([...e.target.files]);
  };

  d.oninput = (e) => {
    if (e.target.id === 'd-title') autosize(e.target);
  };

  d.addEventListener('focusout', (e) => {
    if (!task) return;
    const { id, value } = e.target;
    if (id === 'd-title') {
      const title = value.trim();
      if (!title) e.target.value = task.title;
      else if (title !== task.title) patch({ title });
    }
    if (id === 'd-tags') {
      const tags = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (tags.join(',') !== task.tags.join(',')) patch({ tags });
    }
    if (id === 'd-estimate' && value.trim() !== (task.estimate_minutes ? fmtDuration(task.estimate_minutes) : '')) {
      patch({ estimate: value.trim() || null });
    }
    if (id === 'd-desc') saveDescription();
  });

  d.onkeydown = (e) => {
    const cmdEnter = e.key === 'Enter' && (e.metaKey || e.ctrlKey);
    const id = e.target.id;
    if ((id === 'd-title' || id === 'd-tags' || id === 'd-estimate') && e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    }
    if (id === 'd-note' && cmdEnter) addComment();
    if (id === 'd-desc' && (cmdEnter || e.key === 'Escape')) {
      e.preventDefault();
      e.stopPropagation();
      saveDescription();
      editingDesc = false;
      render();
    }
  };

  d.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const kind = form.dataset.form;
    const t = task;
    if (kind === 'subtask') {
      const title = form.elements.title.value.trim();
      if (!title) return;
      const r = await attempt(() => api('/api/tasks', { method: 'POST', body: { project_id: t.project_id, parent_id: t.id, title } }));
      if (r) { form.reset(); await Promise.all([load(), refreshDrawer()]); $('[data-form="subtask"] input')?.focus(); }
    }
    if (kind === 'blocker') {
      const ref = form.elements.ref.value.trim();
      const m = ref.match(/^#?(\d+)/);
      const found = m ? Number(m[1]) : state.tasks.find((x) => x.title.toLowerCase() === ref.toLowerCase())?.id;
      if (!found) return toast('Informe o número da tarefa, ex.: #12', true);
      const r = await attempt(() => api(`/api/tasks/${t.id}/blockers`, { method: 'POST', body: { blocked_by: found } }));
      if (r) await Promise.all([load(), refreshDrawer()]);
    }
    if (kind === 'time') {
      const f = form.elements;
      const r = await attempt(() => api(`/api/tasks/${t.id}/time`, { method: 'POST', body: { duration: f.duration.value, date: f.date.value, note: f.note.value } }), 'Tempo registrado');
      if (r) { showTimeForm = false; await Promise.all([load(), refreshDrawer()]); }
    }
  };

  // Colar imagens na descrição ou no comentário.
  d.addEventListener('paste', (e) => {
    const target = e.target.closest('#d-desc, #d-note');
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!target || !files.length || !task) return;
    e.preventDefault();
    addFiles(files, { insertInto: target });
  });

  // Arrastar arquivos para o painel.
  d.addEventListener('dragover', (e) => {
    if (task && [...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); d.classList.add('file-over'); }
  });
  d.addEventListener('dragleave', (e) => { if (!d.contains(e.relatedTarget)) d.classList.remove('file-over'); });
  d.addEventListener('drop', (e) => {
    d.classList.remove('file-over');
    if (!task || !e.dataTransfer?.files.length) return;
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
  });
}
