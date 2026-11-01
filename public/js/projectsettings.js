// Configurações do projeto: geral, membros, fluxo de trabalho, labels, campos, caixa de entrada,
// importação, links públicos e zona de perigo. É uma página de formulário: só é redesenhada pela
// rota ou depois das próprias gravações (não a cada atualização ao vivo).
import { api, attempt, pickFile, toast, uploadTo } from './api.js';
import { openTask } from './drawer.js';
import { t, tn } from './i18n.js';
import { swatches, workspaceOptions } from './shell.js';
import { can, currentProject, isAdmin, load, navigate, state, taskById, userById } from './state.js';
import { openDialog } from './ui.js';
import {
  $, $$, FIELD_TYPES, FIELD_TYPE_LABEL, ICON, PRIORITIES, PRIORITY_LABEL, PROJECT_STATUSES, PROJECT_STATUS_LABEL, ROLES, ROLE_LABEL,
  STATUSES, STATUS_LABEL, TYPES, TYPE_LABEL, USER_ROLE_LABEL, VISIBILITIES, VISIBILITY_HINT, VISIBILITY_LABEL,
  ago, avatar, columnLabel, dtf, esc, fmtDate, projectBadge, projectColor, statusIcon, taskRef, tilde,
} from './util.js';

const MASK = '••••••••';
const LABEL_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300', '#7c7c84'];
const SELECT_TYPES = ['select', 'multi_select'];

const SECTIONS = [
  { id: 'general', label: () => t('Geral'), icon: ICON.sliders },
  { id: 'members', label: () => t('Membros'), icon: ICON.users },
  { id: 'workflow', label: () => t('Fluxo de trabalho'), icon: ICON.board },
  { id: 'labels', label: () => t('Labels'), icon: ICON.tag },
  { id: 'fields', label: () => t('Campos personalizados'), icon: ICON.list },
  { id: 'inbox', label: () => t('Caixa de entrada'), icon: ICON.inbox },
  { id: 'import', label: () => t('Importar e exportar'), icon: ICON.upload },
  { id: 'shares', label: () => t('Links públicos'), icon: ICON.globe, when: (p) => p.visibility === 'public' },
  { id: 'danger', label: () => t('Zona de perigo'), icon: ICON.trash, danger: true },
];

let section = 'general';
let renderSeq = 0;
// Último resultado de importação, mostrado no topo da seção até ser fechado.
let importResult = null;

// Para outras telas abrirem direto numa seção: openProjectSettingsSection('labels') antes do navigate.
export function openProjectSettingsSection(id) {
  if (SECTIONS.some((s) => s.id === id)) section = id;
}

export async function renderProjectSettings(el) {
  const seq = ++renderSeq;
  const project = currentProject();
  if (!project) return renderPicker(el);
  const visible = SECTIONS.filter((s) => !s.when || s.when(project));
  if (!visible.some((s) => s.id === section)) section = 'general';
  const view = VIEWS[section];
  let data = {};
  let error = null;
  if (view.load) {
    try { data = await view.load(project); } catch (e) { error = e.message; }
  }
  if (seq !== renderSeq || !el.isConnected) return;
  const ctx = {
    el,
    project,
    data,
    manage: can(project, 'manage'),
    own: can(project, 'own'),
    admin: isAdmin(),
    rerender: () => renderProjectSettings(el),
  };
  el.innerHTML = `
    <div class="page project-settings">
      <div class="ps-layout">
        <nav class="ps-nav" aria-label="${esc(t('Seções das configurações do projeto'))}">
          ${visible.map((s) => `
            <button type="button" class="ps-nav-item ${s.danger ? 'danger' : ''} ${s.id === section ? 'on' : ''}" data-go="${s.id}" ${s.id === section ? 'aria-current="page"' : ''}>
              ${s.icon}<span>${esc(s.label())}</span>
            </button>`).join('')}
        </nav>
        <div class="ps-body">
          ${error ? `
            <div class="empty-box">${ICON.blocked}<p>${esc(error)}</p>
              <p><button type="button" class="btn bordered small" data-act="retry">${esc(t('Tentar de novo'))}</button></p></div>`
            : view.html(ctx)}
        </div>
      </div>
    </div>`;
  keepNavItemVisible(el);
  bind(el, ctx);
}

// Em telas estreitas a navegação vira uma faixa com rolagem horizontal: mantém a seção atual à vista.
function keepNavItemVisible(el) {
  const nav = $('.ps-nav', el);
  const on = $('.ps-nav-item.on', nav);
  if (!on || nav.scrollWidth <= nav.clientWidth) return;
  const left = on.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
  nav.scrollLeft = Math.max(0, left - (nav.clientWidth - on.offsetWidth) / 2);
}

// ---------- sem projeto escolhido ----------

function renderPicker(el) {
  const active = state.projects.filter((p) => !p.archived_at);
  const archived = state.projects.filter((p) => p.archived_at);
  const picks = (list) => `<div class="project-picks">${list.map((p) => `
    <button type="button" class="chip-btn" data-pick="${p.id}">${projectBadge(p)}${esc(p.name)}</button>`).join('')}</div>`;
  el.innerHTML = `
    <div class="page narrow project-settings">
      <section class="card-box">
        <h3>${ICON.gear} ${esc(t('Configurações do projeto'))}</h3>
        ${state.projects.length ? `
          <p class="hint ps-gap">${esc(t('Escolha o projeto que você quer configurar.'))}</p>
          ${picks(active)}
          ${archived.length ? `<h4 class="ps-subhead">${esc(t('Arquivados'))}</h4>${picks(archived)}` : ''}`
        : `<p class="empty-small">${esc(t('Nenhum projeto por aqui ainda.'))}</p>`}
      </section>
    </div>`;
  el.onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) navigate({ projectId: Number(b.dataset.pick), view: 'project-settings' });
  };
  el.onsubmit = null;
  el.onchange = null;
  el.oninput = null;
  el.onkeydown = null;
}

// ---------- helpers ----------

const options = (list, labels, selected) => list.map((v) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(labels[v])}</option>`).join('');
const dis = (ok) => (ok ? '' : 'disabled');
const readOnly = (ok, text) => (ok ? '' : `<p class="notice">${ICON.lock} ${esc(text || t('Você pode ver estas configurações, mas só gerentes e donos do projeto podem mudá-las.'))}</p>`);
const fieldset = (ok, inner) => `<fieldset class="ps-fieldset" ${dis(ok)}>${inner}</fieldset>`;
const labelChip = (l) => `<span class="chip ps-label" style="--c:${esc(l.color || '#7c7c84')}"><span class="dot"></span>${esc(l.name)}</span>`;
const shareUrl = (token) => `${location.origin}/s/${token}`;
const taskCount = (p) => (p.todo || 0) + (p.doing || 0) + (p.blocked || 0) + (p.done || 0);
const realColumns = () => (state.columns || []).filter((c) => c.id != null);

function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : esc(dtf.format(d));
}

async function refresh(ctx, { reload = true } = {}) {
  if (reload) await load().catch(() => {});
  return ctx.rerender();
}

// Desabilita o botão enquanto a ação demora (testes de conexão, importações).
async function busy(button, fn) {
  if (button) button.disabled = true;
  try { return await fn(); } finally { if (button?.isConnected) button.disabled = false; }
}

async function copy(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast(t('Não deu para copiar. Selecione o link e copie manualmente.'), true);
  }
}

function dialog(opts) {
  return openDialog({
    cancelLabel: t('Cancelar'),
    ...opts,
    onOpen: (form, d) => {
      d.classList.add('project-settings');
      opts.onOpen?.(form, d);
    },
  });
}

// Confirmação que responde pelo próprio botão: o evento "close" do <dialog> nem sempre chega
// depois que openDialog o remove do DOM, e o confirmAction de ui.js fica esperando para sempre.
function confirmDanger(message, okLabel, title = t('Confirmar')) {
  return new Promise((resolve) => {
    const { dialog: d } = openDialog({
      title,
      body: `<p class="dialog-text">${esc(message)}</p>`,
      submitLabel: okLabel,
      cancelLabel: t('Cancelar'),
      danger: true,
      onSubmit: () => resolve(true),
    });
    const no = () => resolve(false);
    d.addEventListener('cancel', no);
    d.addEventListener('close', no);
    d.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === d) no(); });
  });
}

// ---------- delegação de eventos ----------

function bind(el, ctx) {
  el.onclick = async (e) => {
    const b = e.target.closest('[data-go], [data-act]');
    if (!b || b.disabled) return;
    if (b.dataset.go) {
      section = b.dataset.go;
      return ctx.rerender();
    }
    const fn = ACTIONS[b.dataset.act];
    if (fn) await fn(ctx, b);
  };
  el.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fn = FORMS[form.dataset.form];
    if (!fn) return;
    await busy($('[type="submit"]', form), () => fn(ctx, form));
  };
  el.onchange = (e) => CHANGES[e.target.dataset.change]?.(ctx, e.target);
  el.oninput = (e) => INPUTS[e.target.dataset.input]?.(ctx, e.target);
  el.onkeydown = (e) => {
    // Enter no nome da coluna confirma (dispara o change).
    if (e.key === 'Enter' && e.target.dataset.change === 'col-name') e.target.blur();
  };
}

// ---------- 1. Geral ----------

function keyHint(key) {
  return key
    ? t('As tarefas aparecem como {ref}. Trocar o prefixo muda o código de todas, mas os números continuam.', { ref: `${key}-12` })
    : t('Sem prefixo, as tarefas aparecem só com o número (#12).');
}

function projectAvatar(p) {
  if (p.avatar) return `<img class="ps-avatar" src="/api/avatars/${esc(p.avatar)}" alt="">`;
  return `<span class="ps-avatar" style="--c:${esc(projectColor(p))}">${esc((p.name || '?').trim().charAt(0).toUpperCase())}</span>`;
}

function generalHtml({ project: p, manage, own }) {
  const visIcon = { private: ICON.lock, internal: ICON.users, public: ICON.globe };
  return `
    <section class="card-box">
      <h3>${ICON.sliders} ${esc(t('Geral'))}</h3>
      ${readOnly(manage)}
      <form data-form="general">
        ${fieldset(manage, `
          <div class="ps-avatar-row">
            ${projectAvatar(p)}
            <div class="ps-avatar-actions">
              <div class="ps-row">
                <button type="button" class="btn bordered small" data-act="avatar-upload">${ICON.upload} ${esc(p.avatar ? t('Trocar imagem') : t('Enviar imagem'))}</button>
                ${p.avatar ? `<button type="button" class="btn ghost small" data-act="avatar-remove">${esc(t('Remover imagem'))}</button>` : ''}
              </div>
              <p class="hint">${esc(t('PNG, JPEG, WebP ou GIF de até 2 MB. Sem imagem, o projeto aparece com a cor escolhida.'))}</p>
            </div>
          </div>
          <label class="field"><span>${esc(t('Nome'))}</span><input class="input" name="name" value="${esc(p.name)}" required maxlength="120"></label>
          <label class="field"><span>${esc(t('Descrição'))}</span><textarea class="input" name="description" rows="3">${esc(p.description || '')}</textarea></label>
          <div class="field"><span>${esc(t('Cor'))}</span>${swatches(p.color || '')}</div>
          <div class="field-row">
            <label class="field"><span>${esc(t('Prefixo das tarefas'))}</span>
              <input class="input ps-key" name="key" value="${esc(p.key || '')}" maxlength="10" pattern="[A-Za-z][A-Za-z0-9]{1,9}"
                placeholder="${esc(t('ex.: WEB'))}" title="${esc(t('2 a 10 letras ou números, começando por letra'))}" data-input="key" autocomplete="off" spellcheck="false"></label>
            <label class="field"><span>${esc(t('Status'))}</span><select class="input" name="status">${options(PROJECT_STATUSES, PROJECT_STATUS_LABEL, p.status)}</select></label>
            <label class="field"><span>${esc(t('Prioridade'))}</span><select class="input" name="priority">${options(PRIORITIES, PRIORITY_LABEL, p.priority)}</select></label>
          </div>
          <p class="hint" data-key-hint>${esc(keyHint(p.key))}</p>
          <div class="field-row">
            <label class="field"><span>${esc(t('Início'))}</span><input class="input" type="date" name="start_date" value="${esc(p.start_date || '')}"></label>
            <label class="field"><span>${esc(t('Fim'))}</span><input class="input" type="date" name="end_date" value="${esc(p.end_date || '')}"></label>
          </div>
          <label class="field"><span>${esc(t('Workspace'))}</span>
            <select class="input" name="workspace_id"><option value="">${esc(t('Sem workspace'))}</option>${workspaceOptions(p.workspace_id)}</select></label>
          <div class="field"><span>${esc(t('Visibilidade'))}</span>
            <div class="ps-choices">
              ${VISIBILITIES.map((v) => `
                <label class="ps-choice">
                  <input type="radio" name="visibility" value="${v}" ${p.visibility === v ? 'checked' : ''} ${dis(own)}>
                  <span><b>${visIcon[v]} ${esc(VISIBILITY_LABEL[v])}</b><small>${esc(VISIBILITY_HINT[v])}</small></span>
                </label>`).join('')}
            </div>
            ${own ? '' : `<p class="hint">${ICON.lock} ${esc(t('Só donos do projeto mudam a visibilidade.'))}</p>`}
          </div>
          ${p.path ? `
            <div class="field"><span>${esc(t('Pasta'))}</span><code class="path ps-path">${esc(tilde(p.path))}</code>
              <p class="hint">${esc(t('Projeto ligado a esta pasta: o Claude Code registra aqui as tarefas de quem trabalha nela.'))}</p></div>` : ''}
          <div><button class="btn primary" type="submit">${esc(t('Salvar alterações'))}</button></div>`)}
      </form>
    </section>`;
}

async function saveGeneral(ctx, form) {
  const f = form.elements;
  const p = ctx.project;
  const body = {
    name: f.name.value,
    description: f.description.value,
    key: f.key.value.trim() || null,
    status: f.status.value,
    priority: f.priority.value,
    start_date: f.start_date.value || null,
    end_date: f.end_date.value || null,
    workspace_id: f.workspace_id.value ? Number(f.workspace_id.value) : null,
  };
  // Cor fora da paleta (definida pela API) fica como está se nenhuma for marcada.
  if (f.color?.value) body.color = f.color.value;
  // Mudar visibilidade exige papel de dono: só manda quando mudou.
  const vis = $('input[name="visibility"]:checked', form)?.value;
  if (ctx.own && vis && vis !== p.visibility) body.visibility = vis;
  if (await attempt(() => api(`/api/projects/${p.id}`, { method: 'PATCH', body }), t('Projeto salvo'))) await refresh(ctx);
}

async function uploadAvatar(ctx) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
  if (!file) return;
  if (await attempt(() => uploadTo(`/api/projects/${ctx.project.id}/avatar`, file), t('Imagem atualizada'))) await refresh(ctx);
}

// Corpo vazio remove a imagem (não há rota DELETE para avatar de projeto).
async function removeAvatar(ctx) {
  const empty = new Blob([]);
  if (await attempt(() => uploadTo(`/api/projects/${ctx.project.id}/avatar`, empty, { name: 'vazio', type: 'application/octet-stream' }), t('Imagem removida'))) await refresh(ctx);
}

// ---------- 2. Membros ----------

const ROLE_HINT = {
  owner: () => t('Tudo, inclusive mudar a visibilidade, arquivar e excluir o projeto'),
  manager: () => t('Configurações, colunas, labels, membros e importações'),
  member: () => t('Cria, edita e move tarefas'),
  viewer: () => t('Só vê o projeto e as tarefas'),
};

function accessText(p) {
  if (p.visibility === 'private') {
    return t('Projeto privado: só as pessoas desta lista, e quem tem papel no workspace ou na organização do projeto, conseguem ver. Administradores do quadro veem tudo.');
  }
  if (p.visibility === 'public') {
    return t('Projeto público: todas as contas do quadro veem o projeto, mesmo sem estar nesta lista, e dá para gerar links de leitura sem login. Quem não está na lista entra com o papel da conta: Membro (cria e edita tarefas) ou Visualizador (só lê).');
  }
  return t('Projeto interno: todas as contas do quadro veem o projeto, mesmo sem estar nesta lista. Quem não está na lista entra com o papel da conta: Membro (cria e edita tarefas) ou Visualizador (só lê).');
}

function membersHtml({ project: p, data, manage, own }) {
  const list = data.members;
  const ids = new Set(list.map((m) => m.id));
  const candidates = state.users.filter((u) => !ids.has(u.id));
  const roleOptions = (selected) => ROLES.map((r) => `<option value="${r}" ${r === selected ? 'selected' : ''} ${r === 'owner' && !own ? 'disabled' : ''}>${esc(ROLE_LABEL[r])}</option>`).join('');
  return `
    <section class="card-box">
      <h3>${ICON.shield} ${esc(t('Quem tem acesso'))}</h3>
      <p class="ps-text">${esc(accessText(p))}</p>
      <p class="hint ps-gap">${esc(t('Um papel definido aqui substitui o da conta (inclusive para menos). Papéis no workspace ou na organização também valem: prevalece o maior. Administradores do quadro são donos de todos os projetos.'))}</p>
      <dl class="ps-roles">${ROLES.map((r) => `<div><dt>${esc(ROLE_LABEL[r])}</dt><dd>${esc(ROLE_HINT[r]())}</dd></div>`).join('')}</dl>
    </section>

    <section class="card-box">
      <h3>${ICON.users} ${esc(t('Membros do projeto'))} <span class="count">${list.length}</span></h3>
      ${readOnly(manage)}
      ${list.length ? `
        <div class="ps-table-wrap">
          <table class="mini-table members">
            <thead><tr><th>${esc(t('Pessoa'))}</th><th class="hide-sm">${esc(t('Conta'))}</th><th>${esc(t('Papel no projeto'))}</th><th></th></tr></thead>
            <tbody>${list.map((m) => {
              const locked = !manage || (m.role === 'owner' && !own);
              return `
                <tr>
                  <td><span class="person-cell">${avatar(m, { size: 28 })}<span><b>${esc(m.name)}</b>${m.id === state.me?.id ? ` <span class="chip">${esc(t('você'))}</span>` : ''}<br><span class="muted small">${esc(m.email)}</span></span></span></td>
                  <td class="hide-sm muted">${esc(USER_ROLE_LABEL[m.account_role] || m.account_role)}</td>
                  <td><select class="input small" data-change="member-role" data-user="${m.id}" aria-label="${esc(t('Papel de {name}', { name: m.name }))}" ${dis(!locked)}>${roleOptions(m.role)}</select></td>
                  <td>${locked ? '' : `<button type="button" class="icon-btn small" data-act="member-remove" data-user="${m.id}" aria-label="${esc(t('Remover {name} do projeto', { name: m.name }))}">${ICON.trash}</button>`}</td>
                </tr>`;
            }).join('')}</tbody>
          </table>
        </div>`
      : `<p class="empty-small">${esc(t('Ninguém foi adicionado diretamente a este projeto.'))}</p>`}
    </section>

    ${manage ? `
    <section class="card-box">
      <h3>${ICON.plus} ${esc(t('Adicionar pessoa'))}</h3>
      ${candidates.length ? `
        <form data-form="member-add" class="stack">
          ${candidates.length > 6 ? `<input class="input" type="search" placeholder="${esc(t('Filtrar por nome ou e-mail'))}" data-input="member-filter" aria-label="${esc(t('Filtrar pessoas'))}">` : ''}
          <div class="ps-pick-list" role="radiogroup" aria-label="${esc(t('Pessoa'))}">
            ${candidates.map((u) => `
              <label class="ps-pick" data-q="${esc(`${u.name} ${u.email}`.toLowerCase())}">
                <input type="radio" name="user" value="${u.id}" required>
                ${avatar(u, { size: 26 })}
                <span class="ps-pick-text"><b>${esc(u.name)}</b><small>${esc(u.email)}</small></span>
                <span class="chip">${esc(USER_ROLE_LABEL[u.role] || u.role)}</span>
              </label>`).join('')}
          </div>
          <div class="ps-row">
            <label class="inline-field">${esc(t('Papel'))} <select name="role">${roleOptions('member')}</select></label>
            <button class="btn primary" type="submit">${ICON.plus} ${esc(t('Adicionar ao projeto'))}</button>
          </div>
        </form>`
      : `<p class="empty-small">${esc(t('Todas as contas do quadro já estão na lista. Convide mais pessoas na página Equipe.'))}</p>`}
    </section>` : ''}`;
}

async function setMember(ctx, user, role, message) {
  const ok = await attempt(() => api(`/api/projects/${ctx.project.id}/members`, { method: 'POST', body: { user, role } }), message);
  // Papel no projeto muda my_role e a lista de projetos visíveis.
  await refresh(ctx, { reload: !!ok });
}

async function addMember(ctx, form) {
  const f = form.elements;
  if (!f.user.value) return toast(t('Escolha uma pessoa'), true);
  await setMember(ctx, Number(f.user.value), f.role.value, t('Pessoa adicionada'));
}

async function removeMember(ctx, b) {
  const m = ctx.data.members.find((x) => x.id === Number(b.dataset.user));
  if (!m) return;
  const msg = ctx.project.visibility === 'private'
    ? t('Remover {name} do projeto? Por ser privado, a pessoa deixa de ver o projeto (a não ser que tenha papel no workspace ou na organização).', { name: m.name })
    : t('Remover {name} do projeto? A pessoa volta ao papel padrão da conta.', { name: m.name });
  if (!(await confirmDanger(msg, t('Remover')))) return;
  await setMember(ctx, m.id, null, t('Pessoa removida'));
}

function filterMembers(ctx, input) {
  const q = input.value.trim().toLowerCase();
  for (const row of $$('.ps-pick', ctx.el)) row.hidden = !!q && !row.dataset.q.includes(q);
}

// ---------- 3. Fluxo de trabalho ----------

async function loadWorkflow(p) {
  const [columns, transitions, workflows] = await Promise.all([
    api(`/api/projects/${p.id}/columns`),
    api(`/api/projects/${p.id}/transitions`),
    api('/api/workflows'),
  ]);
  return { columns, transitions, workflows };
}

function workflowHtml(ctx) {
  return `${columnsCard(ctx)}${transitionsCard(ctx)}${workflowsCard(ctx)}`;
}

function columnsCard({ data, manage }) {
  const cols = data.columns;
  const custom = cols.some((c) => c.id != null);
  return `
    <section class="card-box">
      <h3>${ICON.board} ${esc(t('Colunas do quadro'))}</h3>
      <p class="hint ps-gap">${esc(t('Cada coluna pertence a uma categoria (a fazer, em andamento, bloqueada ou concluída). Pode haver várias colunas por categoria, como “Revisão” e “Homologação” dentro de “em andamento”. O Claude também move tarefas entre elas.'))}</p>
      ${readOnly(manage)}
      <div class="col-editor">
        ${cols.map((c, i) => `
          <div class="col-row">
            ${statusIcon(c.status)}
            ${c.id != null ? `
              <input class="input small" data-change="col-name" data-id="${c.id}" value="${esc(c.name)}" maxlength="60" aria-label="${esc(t('Nome da coluna'))}" ${dis(manage)}>
              <select class="input small" data-change="col-status" data-id="${c.id}" aria-label="${esc(t('Categoria da coluna'))}" ${dis(manage)}>${options(STATUSES, STATUS_LABEL, c.status)}</select>
              <span class="ps-col-actions">
                <button type="button" class="icon-btn small" data-act="col-move" data-id="${c.id}" data-move="left" ${i === 0 || !manage ? 'disabled' : ''} aria-label="${esc(t('Mover para a esquerda'))}">${ICON.left}</button>
                <button type="button" class="icon-btn small" data-act="col-move" data-id="${c.id}" data-move="right" ${i === cols.length - 1 || !manage ? 'disabled' : ''} aria-label="${esc(t('Mover para a direita'))}">${ICON.right}</button>
                <button type="button" class="icon-btn small" data-act="col-delete" data-id="${c.id}" ${dis(manage)} aria-label="${esc(t('Excluir coluna'))}">${ICON.trash}</button>
              </span>`
            : `<span class="ps-grow">${esc(columnLabel(c.name, c.status))}</span><span class="muted small">${esc(t('padrão'))}</span>`}
          </div>`).join('')}
      </div>
      ${manage ? `
        <form data-form="column-add" class="inline-form">
          <input class="input" name="name" placeholder="${esc(t('Nova coluna (ex.: Revisão)'))}" required maxlength="60" aria-label="${esc(t('Nome da nova coluna'))}">
          <select class="input ps-shrink" name="status" aria-label="${esc(t('Categoria da coluna'))}">${options(STATUSES, STATUS_LABEL, 'doing')}</select>
          <button class="btn primary" type="submit">${ICON.plus} ${esc(t('Adicionar coluna'))}</button>
        </form>` : ''}
      ${custom ? '' : `<p class="hint ps-gap-top">${esc(t('Este projeto usa as 4 colunas padrão. Ao adicionar a primeira coluna, elas viram editáveis.'))}</p>`}
    </section>`;
}

// Colunas padrão (virtuais) não têm id: o servidor aceita a categoria no lugar.
const colKey = (c) => String(c.id ?? c.status);

function transitionsCard({ data, manage }) {
  const cols = data.columns;
  const pairs = data.transitions;
  const set = new Set(pairs.map((x) => `${x.from_column_id}>${x.to_column_id}`));
  return `
    <section class="card-box">
      <h3>${ICON.repeat} ${esc(t('Transições permitidas'))}</h3>
      <p class="hint ps-gap">${esc(t('Marque, em cada linha, para quais colunas uma tarefa pode ir a partir daquela coluna. Sem nenhuma marcação, qualquer movimento vale. Ficar na mesma coluna sempre pode.'))}</p>
      <form data-form="transitions">
        ${fieldset(manage, `
          <div class="ps-table-wrap">
            <table class="ps-matrix">
              <thead><tr>
                <th scope="col" class="ps-corner"><span>${esc(t('De ↓ · Para →'))}</span></th>
                ${cols.map((c) => `<th scope="col"><span class="ps-colname" data-colref="${c.id ?? ''}">${esc(columnLabel(c.name, c.status))}</span></th>`).join('')}
              </tr></thead>
              <tbody>${cols.map((from) => `
                <tr>
                  <th scope="row">${statusIcon(from.status)}<span class="ps-colname" data-colref="${from.id ?? ''}">${esc(columnLabel(from.name, from.status))}</span></th>
                  ${cols.map((to) => (from === to
                    ? '<td class="ps-self" aria-hidden="true">—</td>'
                    : `<td><input type="checkbox" name="pair" value="${colKey(from)}>${colKey(to)}" ${set.has(`${from.id}>${to.id}`) ? 'checked' : ''}
                        aria-label="${esc(t('De {de} para {para}', { de: columnLabel(from.name, from.status), para: columnLabel(to.name, to.status) }))}"></td>`)).join('')}
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          <div class="ps-row">
            <button class="btn primary" type="submit">${esc(t('Salvar transições'))}</button>
            <button type="button" class="btn ghost" data-act="transitions-clear" ${pairs.length ? '' : 'disabled'}>${esc(t('Liberar tudo'))}</button>
            <span class="hint">${esc(pairs.length ? tn(pairs.length, '{n} movimento permitido', '{n} movimentos permitidos') : t('Sem restrições: qualquer movimento é permitido.'))}</span>
          </div>`)}
      </form>
    </section>`;
}

function workflowsCard({ project: p, data, manage, admin }) {
  const list = data.workflows;
  return `
    <section class="card-box">
      <h3>${ICON.layers} ${esc(t('Modelos de workflow'))}</h3>
      <p class="hint ps-gap">${esc(t('Um modelo guarda colunas e transições para reaproveitar em outros projetos. O modelo padrão é aplicado sozinho aos projetos novos.'))}</p>
      ${list.length ? `<div class="ps-list">${list.map((w) => `
        <div class="ps-item">
          <div class="ps-item-main">
            <div class="ps-item-title"><b>${esc(w.name)}</b>${w.is_default ? ` <span class="chip">${esc(t('padrão'))}</span>` : ''}</div>
            ${w.description ? `<p class="muted small">${esc(w.description)}</p>` : ''}
            <div class="ps-chips">${w.columns.map((c) => `<span class="chip">${statusIcon(c.status)}${esc(columnLabel(c.name, c.status))}</span>`).join('')}</div>
            ${w.transitions.length ? `<p class="hint">${esc(tn(w.transitions.length, '{n} transição definida', '{n} transições definidas'))}</p>` : ''}
          </div>
          <div class="ps-item-actions">
            ${manage ? `<button type="button" class="btn bordered small" data-act="workflow-apply" data-id="${w.id}">${esc(t('Aplicar'))}</button>` : ''}
            ${admin ? `<button type="button" class="icon-btn small" data-act="workflow-delete" data-id="${w.id}" aria-label="${esc(t('Excluir modelo {name}', { name: w.name }))}">${ICON.trash}</button>` : ''}
          </div>
        </div>`).join('')}</div>`
      : `<p class="empty-small">${esc(t('Nenhum modelo salvo ainda.'))}</p>`}
      ${manage ? `
        <form data-form="workflow-save" class="stack ps-subform">
          <h4 class="ps-subhead">${esc(t('Salvar o fluxo deste projeto como modelo'))}</h4>
          <div class="field-row">
            <label class="field"><span>${esc(t('Nome do modelo'))}</span><input class="input" name="name" maxlength="80" placeholder="${esc(t('Workflow de {name}', { name: p.name }))}"></label>
            <label class="field"><span>${esc(t('Descrição'))}</span><input class="input" name="description" maxlength="300"></label>
          </div>
          ${admin ? `<label class="check"><input type="checkbox" name="is_default"><span>${esc(t('Usar como padrão para projetos novos'))}</span></label>` : ''}
          <div><button class="btn bordered" type="submit">${ICON.download} ${esc(t('Salvar como modelo'))}</button></div>
        </form>` : ''}
    </section>`;
}

async function addColumn(ctx, form) {
  const f = form.elements;
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/columns`, { method: 'POST', body: { name: f.name.value, status: f.status.value } }), t('Coluna criada'))) await refresh(ctx);
}

async function renameColumn(ctx, input) {
  const col = ctx.data.columns.find((c) => String(c.id) === input.dataset.id);
  const name = input.value.trim();
  if (!col) return;
  if (!name) { input.value = col.name; return; }
  if (name === col.name) return;
  const saved = await attempt(() => api(`/api/columns/${col.id}`, { method: 'PATCH', body: { name } }), t('Coluna renomeada'));
  if (!saved) { input.value = col.name; return; }
  col.name = saved.name;
  // Atualiza os nomes na matriz sem redesenhar (não tira o foco do próximo campo).
  for (const n of $$(`[data-colref="${col.id}"]`, ctx.el)) n.textContent = saved.name;
  load().catch(() => {});
}

async function changeColumnStatus(ctx, select) {
  await attempt(() => api(`/api/columns/${select.dataset.id}`, { method: 'PATCH', body: { status: select.value } }), t('Categoria alterada'));
  await refresh(ctx);
}

async function moveColumn(ctx, b) {
  if (await attempt(() => api(`/api/columns/${b.dataset.id}`, { method: 'PATCH', body: { move: b.dataset.move } }))) await refresh(ctx);
}

async function deleteColumn(ctx, b) {
  if (!(await confirmDanger(t('Excluir esta coluna? As tarefas dela vão para a primeira coluna da mesma categoria.'), t('Excluir')))) return;
  if (await attempt(() => api(`/api/columns/${b.dataset.id}`, { method: 'DELETE' }), t('Coluna excluída'))) await refresh(ctx);
}

const pairValue = (v) => v.split('>').map((x) => (/^\d+$/.test(x) ? Number(x) : x));

async function saveTransitions(ctx, form) {
  const transitions = $$('input[name="pair"]:checked', form).map((i) => pairValue(i.value));
  const msg = transitions.length ? t('Transições salvas') : t('Movimentos liberados');
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/transitions`, { method: 'PUT', body: { transitions } }), msg)) await refresh(ctx);
}

async function clearTransitions(ctx) {
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/transitions`, { method: 'PUT', body: { transitions: [] } }), t('Movimentos liberados'))) await refresh(ctx);
}

async function applyWorkflow(ctx, b) {
  const w = ctx.data.workflows.find((x) => x.id === Number(b.dataset.id));
  if (!w) return;
  const ok = await confirmDanger(
    t('Aplicar o modelo "{name}"? As colunas e transições atuais do projeto são substituídas pelas do modelo. Cada tarefa vai para a coluna de mesmo nome e categoria; se não houver, fica na primeira coluna da categoria dela.', { name: w.name }),
    t('Aplicar modelo'),
    t('Aplicar modelo'),
  );
  if (!ok) return;
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/workflow`, { method: 'POST', body: { workflow_id: w.id } }), t('Modelo aplicado'))) await refresh(ctx);
}

async function deleteWorkflow(ctx, b) {
  const w = ctx.data.workflows.find((x) => x.id === Number(b.dataset.id));
  if (!w || !(await confirmDanger(t('Excluir o modelo "{name}"? Os projetos que já usam essas colunas não mudam.', { name: w.name }), t('Excluir')))) return;
  if (await attempt(() => api(`/api/workflows/${w.id}`, { method: 'DELETE' }), t('Modelo excluído'))) await refresh(ctx, { reload: false });
}

async function saveWorkflow(ctx, form) {
  const f = form.elements;
  const body = { name: f.name.value.trim() || undefined, description: f.description.value.trim(), is_default: !!f.is_default?.checked };
  if (await attempt(() => api(`/api/workflows/from-project/${ctx.project.id}`, { method: 'POST', body }), t('Modelo salvo'))) await refresh(ctx, { reload: false });
}

// ---------- 4. Labels ----------

function labelRows(list, editable) {
  return `<div class="ps-list">${list.map((l) => `
    <div class="ps-item ps-item-row">
      ${labelChip(l)}
      <span class="ps-item-main muted small">${esc(l.description || '')}</span>
      <span class="muted small ps-nowrap">${esc(tn(l.usage || 0, '{n} tarefa', '{n} tarefas'))}</span>
      ${editable ? `
        <span class="ps-item-actions">
          <button type="button" class="icon-btn small" data-act="label-edit" data-id="${l.id}" aria-label="${esc(t('Editar label {name}', { name: l.name }))}">${ICON.edit}</button>
          <button type="button" class="icon-btn small" data-act="label-delete" data-id="${l.id}" aria-label="${esc(t('Excluir label {name}', { name: l.name }))}">${ICON.trash}</button>
        </span>` : ''}
    </div>`).join('')}</div>`;
}

function labelsHtml({ project: p, data, manage, admin }) {
  const mine = data.labels.filter((l) => l.project_id === p.id);
  const global = data.labels.filter((l) => !l.project_id);
  return `
    <section class="card-box">
      <h3>${ICON.tag} ${esc(t('Labels do projeto'))} <span class="count">${mine.length}</span>
        ${manage ? `<span class="spacer"></span><button type="button" class="btn primary small" data-act="label-new">${ICON.plus} ${esc(t('Novo label'))}</button>` : ''}</h3>
      <p class="hint ps-gap">${esc(t('Labels dão cor e descrição às tags das tarefas: uma tag com o mesmo nome de um label aparece com a cor dele. Renomear um label atualiza as tarefas que o usam.'))}</p>
      ${readOnly(manage)}
      ${mine.length ? labelRows(mine, manage) : `<p class="empty-small">${esc(t('Nenhum label só deste projeto ainda.'))}</p>`}
    </section>
    <section class="card-box">
      <h3>${ICON.globe} ${esc(t('Labels globais'))} <span class="count">${global.length}</span>
        ${admin ? `<span class="spacer"></span><button type="button" class="btn bordered small" data-act="label-new" data-global="1">${ICON.plus} ${esc(t('Novo label global'))}</button>` : ''}</h3>
      <p class="hint ps-gap">${esc(admin ? t('Valem para todos os projetos. Um label do projeto com o mesmo nome tem prioridade.') : t('Valem para todos os projetos. Só administradores editam labels globais.'))}</p>
      ${global.length ? labelRows(global, admin) : `<p class="empty-small">${esc(t('Nenhum label global.'))}</p>`}
    </section>`;
}

function labelDialog(ctx, label, { global = false } = {}) {
  const color = label?.color || LABEL_COLORS[(ctx.data.labels.length || 0) % LABEL_COLORS.length];
  const editing = !!label;
  dialog({
    title: editing ? t('Editar label') : global ? t('Novo label global') : t('Novo label'),
    submitLabel: editing ? t('Salvar') : t('Criar label'),
    body: `
      <div class="ps-preview"><span class="muted small">${esc(t('Prévia'))}</span><span data-preview>${labelChip({ name: label?.name || t('nome do label'), color })}</span></div>
      <label class="field"><span>${esc(t('Nome'))}</span><input class="input" name="name" value="${esc(label?.name || '')}" required maxlength="40"></label>
      <div class="field"><span>${esc(t('Cor'))}</span>
        <div class="swatches">
          ${LABEL_COLORS.map((c) => `<label class="swatch" style="--c:${c}"><input type="radio" name="swatch" value="${c}" ${c === color ? 'checked' : ''}><span></span></label>`).join('')}
          <input type="color" class="ps-color-input" name="color" value="${esc(color)}" aria-label="${esc(t('Outra cor'))}" title="${esc(t('Outra cor'))}">
        </div>
      </div>
      <label class="field"><span>${esc(t('Descrição'))}</span><input class="input" name="description" value="${esc(label?.description || '')}" maxlength="300" placeholder="${esc(t('Quando usar este label (opcional)'))}"></label>`,
    onOpen: (form) => {
      const f = form.elements;
      const sync = (e) => {
        if (e?.target.name === 'swatch') f.color.value = e.target.value;
        if (e?.target.name === 'color') for (const r of $$('input[name="swatch"]', form)) r.checked = r.value === f.color.value;
        $('[data-preview]', form).innerHTML = labelChip({ name: f.name.value.trim() || t('nome do label'), color: f.color.value });
      };
      form.addEventListener('input', sync);
      form.addEventListener('change', sync);
    },
    onSubmit: async (form) => {
      const f = form.elements;
      const body = { name: f.name.value, color: f.color.value, description: f.description.value };
      const ok = editing
        ? await attempt(() => api(`/api/labels/${label.id}`, { method: 'PATCH', body }), t('Label salvo'))
        : await attempt(() => api('/api/labels', { method: 'POST', body: { ...body, project_id: global ? null : ctx.project.id } }), t('Label criado'));
      if (!ok) return false;
      await refresh(ctx);
    },
  });
}

async function deleteLabel(ctx, b) {
  const l = ctx.data.labels.find((x) => x.id === Number(b.dataset.id));
  if (!l) return;
  const msg = l.usage
    ? tn(l.usage, 'Excluir o label "{name}"? A tag também sai de {n} tarefa.', 'Excluir o label "{name}"? A tag também sai de {n} tarefas.', { name: l.name })
    : t('Excluir o label "{name}"?', { name: l.name });
  if (!(await confirmDanger(msg, t('Excluir')))) return;
  if (await attempt(() => api(`/api/labels/${l.id}`, { method: 'DELETE' }), t('Label excluído'))) await refresh(ctx);
}

// ---------- 5. Campos personalizados ----------

function fieldsHtml({ data, manage, admin }) {
  const list = data.fields;
  const editable = (f) => (f.project_id ? manage : admin);
  return `
    <section class="card-box">
      <h3>${ICON.list} ${esc(t('Campos personalizados'))} <span class="count">${list.length}</span>
        ${manage ? `<span class="spacer"></span><button type="button" class="btn primary small" data-act="field-new">${ICON.plus} ${esc(t('Novo campo'))}</button>` : ''}</h3>
      <p class="hint ps-gap">${esc(t('Campos extras que aparecem em todas as tarefas do projeto, como “Cliente”, “Ambiente” ou “Link do PR”. Campos globais aparecem em todos os projetos.'))}</p>
      ${readOnly(manage)}
      ${list.length ? `<div class="ps-list">${list.map((f) => `
        <div class="ps-item">
          <div class="ps-item-main">
            <div class="ps-item-title"><b>${esc(f.name)}</b>
              <span class="chip">${esc(FIELD_TYPE_LABEL[f.type] || f.type)}</span>
              ${f.required ? `<span class="chip">${esc(t('obrigatório'))}</span>` : ''}
              ${f.project_id ? '' : `<span class="chip">${ICON.globe}${esc(t('todos os projetos'))}</span>`}
            </div>
            ${f.options.length ? `<div class="ps-chips">${f.options.slice(0, 12).map((o) => `<span class="chip tag">${esc(o)}</span>`).join('')}${f.options.length > 12 ? `<span class="muted small">+${f.options.length - 12}</span>` : ''}</div>` : ''}
          </div>
          ${editable(f) ? `
            <div class="ps-item-actions">
              <button type="button" class="icon-btn small" data-act="field-edit" data-id="${f.id}" aria-label="${esc(t('Editar campo {name}', { name: f.name }))}">${ICON.edit}</button>
              <button type="button" class="icon-btn small" data-act="field-delete" data-id="${f.id}" aria-label="${esc(t('Excluir campo {name}', { name: f.name }))}">${ICON.trash}</button>
            </div>` : ''}
        </div>`).join('')}</div>`
      : `<p class="empty-small">${esc(t('Nenhum campo personalizado ainda.'))}</p>`}
      ${!admin && list.some((f) => !f.project_id) ? `<p class="hint ps-gap-top">${esc(t('Só administradores editam campos globais.'))}</p>` : ''}
    </section>`;
}

function fieldDialog(ctx, field) {
  const editing = !!field;
  const type = field?.type || 'text';
  dialog({
    title: editing ? t('Editar campo') : t('Novo campo'),
    submitLabel: editing ? t('Salvar') : t('Criar campo'),
    body: `
      <label class="field"><span>${esc(t('Nome'))}</span><input class="input" name="name" value="${esc(field?.name || '')}" required maxlength="60" placeholder="${esc(t('ex.: Cliente'))}"></label>
      <label class="field"><span>${esc(t('Tipo'))}</span>
        <select class="input" name="type" ${editing ? 'disabled' : ''}>${options(FIELD_TYPES, FIELD_TYPE_LABEL, type)}</select>
        ${editing ? `<small class="hint">${esc(t('O tipo não muda depois de criado.'))}</small>` : ''}</label>
      <label class="field" data-options ${SELECT_TYPES.includes(type) ? '' : 'hidden'}><span>${esc(t('Opções (uma por linha)'))}</span>
        <textarea class="input" name="options" rows="5" placeholder="${esc(t('Opção A\nOpção B'))}">${esc((field?.options || []).join('\n'))}</textarea>
        <small class="hint">${esc(t('Até 50 opções. Repetidas e vazias são ignoradas.'))}</small></label>
      <label class="check"><input type="checkbox" name="required" ${field?.required ? 'checked' : ''}><span>${esc(t('Obrigatório'))}</span></label>
      ${!editing && ctx.admin ? `<label class="check"><input type="checkbox" name="global"><span>${esc(t('Disponível em todos os projetos (campo global)'))}</span></label>` : ''}`,
    onOpen: (form) => {
      const f = form.elements;
      const sync = () => {
        const show = SELECT_TYPES.includes(f.type.value);
        $('[data-options]', form).hidden = !show;
        f.options.required = show;
      };
      f.type.addEventListener('change', sync);
      sync();
    },
    onSubmit: async (form) => {
      const f = form.elements;
      const options = f.options.value.split('\n').map((o) => o.trim()).filter(Boolean);
      const t0 = editing ? field.type : f.type.value;
      const body = { name: f.name.value, required: f.required.checked, ...(SELECT_TYPES.includes(t0) ? { options } : {}) };
      const ok = editing
        ? await attempt(() => api(`/api/fields/${field.id}`, { method: 'PATCH', body }), t('Campo salvo'))
        : await attempt(() => api('/api/fields', { method: 'POST', body: { ...body, type: t0, project_id: f.global?.checked ? null : ctx.project.id } }), t('Campo criado'));
      if (!ok) return false;
      await refresh(ctx);
    },
  });
}

async function deleteField(ctx, b) {
  const f = ctx.data.fields.find((x) => x.id === Number(b.dataset.id));
  if (!f || !(await confirmDanger(t('Excluir o campo "{name}"? Os valores preenchidos nas tarefas também são apagados.', { name: f.name }), t('Excluir')))) return;
  if (await attempt(() => api(`/api/fields/${f.id}`, { method: 'DELETE' }), t('Campo excluído'))) await refresh(ctx);
}

// ---------- 6. Caixa de entrada (e-mail) ----------

const MESSAGE_STATUS = {
  task: () => t('Virou tarefa'),
  comment: () => t('Comentário'),
  ignored: () => t('Ignorado'),
  error: () => t('Erro'),
};

const columnName = (ref) => {
  const c = (state.columns || []).find((x) => String(x.id) === String(ref) || x.status === ref || x.name.toLowerCase() === String(ref).toLowerCase());
  return c ? columnLabel(c.name, c.status) : String(ref);
};
const userName = (ref) => userById(Number(ref))?.name || String(ref);

function columnSelect(name, selected, { emptyLabel, virtual = false } = {}) {
  const cols = virtual ? (state.columns || []) : realColumns();
  return `<select class="input" name="${name}"><option value="">${esc(emptyLabel)}</option>${cols.map((c) => {
    const v = virtual ? colKey(c) : String(c.id);
    return `<option value="${esc(v)}" ${v === String(selected ?? '') ? 'selected' : ''}>${esc(columnLabel(c.name, c.status))}</option>`;
  }).join('')}</select>`;
}

function userSelect(name, selected, emptyLabel) {
  return `<select class="input" name="${name}"><option value="">${esc(emptyLabel)}</option>${state.users.map((u) => `
    <option value="${u.id}" ${String(u.id) === String(selected ?? '') ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select>`;
}

function inboxHtml(ctx) {
  const { data, manage } = ctx;
  const box = data.inbox;
  return `
    ${data.mail_enabled ? '' : `
      <div class="notice ps-notice">
        <span>${esc(t('O envio de e-mails (SMTP) não está configurado. A caixa de entrada funciona, mas a resposta automática não sai até alguém configurar o SMTP nas configurações gerais.'))}</span>
        <button type="button" class="btn bordered small" data-act="open-settings">${ICON.gear} ${esc(t('Abrir configurações gerais'))}</button>
      </div>`}
    <section class="card-box">
      <h3>${ICON.inbox} ${esc(t('Caixa de entrada por e-mail'))}
        ${box ? `<span class="chip">${esc(box.enabled ? t('ativa') : t('pausada'))}</span>` : ''}</h3>
      <ul class="ps-howto">
        <li>${esc(t('O quadro verifica a caixa IMAP de tempos em tempos: cada e-mail não lido vira uma tarefa neste projeto, com os anexos.'))}</li>
        <li>${esc(t('Respostas com [#id] no assunto (por exemplo “Re: [#12] Erro no login”) viram comentários na tarefa 12.'))}</li>
        <li>${esc(t('A resposta automática avisa o remetente do número da tarefa. Ela precisa do SMTP configurado nas configurações gerais.'))}</li>
      </ul>
      ${box ? `
        <p class="hint ps-gap">${esc(t('Última verificação: {quando}', { quando: box.last_sync_at ? ago(box.last_sync_at) : t('nunca') }))}</p>
        ${box.last_error ? `<p class="ps-error">${ICON.blocked} ${esc(box.last_error)}</p>` : ''}` : ''}
      ${readOnly(manage)}
      <form data-form="inbox">
        ${fieldset(manage, inboxForm(box))}
      </form>
    </section>
    ${box ? rulesCard(ctx) : ''}
    ${box ? messagesCard(ctx) : ''}`;
}

function inboxForm(box) {
  const b = box || { enabled: true, imap_secure: true, imap_port: 993, mailbox: 'INBOX', sync_minutes: 5, default_type: 'task', default_priority: 'medium' };
  return `
    <label class="check"><input type="checkbox" name="enabled" ${b.enabled ? 'checked' : ''}><span>${esc(t('Ativa: verificar a caixa automaticamente'))}</span></label>
    <label class="field"><span>${esc(t('Endereço da caixa'))}</span><input class="input" type="email" name="address" value="${esc(b.address || '')}" maxlength="200" placeholder="${esc(t('suporte@empresa.com'))}">
      <small class="hint">${esc(t('O endereço para onde as pessoas mandam os pedidos. Aparece só como referência.'))}</small></label>
    <h4 class="ps-subhead">${esc(t('Servidor IMAP'))}</h4>
    <div class="field-row">
      <label class="field ps-span-2"><span>${esc(t('Servidor'))}</span><input class="input" name="imap_host" value="${esc(b.imap_host || '')}" maxlength="200" placeholder="imap.gmail.com" required autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>${esc(t('Porta'))}</span><input class="input" type="number" name="imap_port" value="${esc(b.imap_port || 993)}" min="1" max="65535"></label>
    </div>
    <label class="check"><input type="checkbox" name="imap_secure" ${b.imap_secure ? 'checked' : ''}><span>${esc(t('Usar TLS (recomendado; sem TLS a senha trafega sem criptografia)'))}</span></label>
    <div class="field-row">
      <label class="field"><span>${esc(t('Usuário'))}</span><input class="input" name="imap_user" value="${esc(b.imap_user || '')}" maxlength="200" required autocomplete="off" spellcheck="false"></label>
      <label class="field"><span>${esc(t('Senha'))}</span><input class="input" type="password" name="imap_pass" value="${esc(b.imap_pass || '')}" autocomplete="new-password"
        placeholder="${esc(t('Senha ou senha de app'))}"></label>
    </div>
    ${b.imap_pass ? `<p class="hint">${esc(t('Deixe a senha como está para manter a salva. Apague para remover.'))}</p>` : ''}
    <div class="field-row">
      <label class="field"><span>${esc(t('Pasta'))}</span><input class="input" name="mailbox" value="${esc(b.mailbox || 'INBOX')}" maxlength="100"></label>
      <label class="field"><span>${esc(t('Verificar a cada (minutos)'))}</span><input class="input" type="number" name="sync_minutes" value="${esc(b.sync_minutes || 5)}" min="1" max="1440"></label>
    </div>
    <h4 class="ps-subhead">${esc(t('Tarefas criadas'))}</h4>
    <div class="field-row">
      <label class="field"><span>${esc(t('Tipo'))}</span><select class="input" name="default_type">${options(TYPES, TYPE_LABEL, b.default_type)}</select></label>
      <label class="field"><span>${esc(t('Prioridade'))}</span><select class="input" name="default_priority">${options(PRIORITIES, PRIORITY_LABEL, b.default_priority)}</select></label>
      <label class="field"><span>${esc(t('Coluna'))}</span>${columnSelect('default_column', b.default_column_id, { emptyLabel: t('Primeira coluna') })}</label>
      <label class="field"><span>${esc(t('Responsável'))}</span>${userSelect('default_assignee', b.default_assignee_id, t('Ninguém'))}</label>
    </div>
    <h4 class="ps-subhead">${esc(t('Resposta automática'))}</h4>
    <label class="check"><input type="checkbox" name="auto_reply" ${b.auto_reply ? 'checked' : ''}><span>${esc(t('Responder ao remetente com o número da tarefa'))}</span></label>
    <label class="field"><span>${esc(t('Mensagem'))}</span><textarea class="input" name="auto_reply_template" rows="3"
      placeholder="${esc(t('Recebemos sua mensagem e abrimos a tarefa {id}: {titulo}. Responda este e-mail para acrescentar informações.'))}">${esc(b.auto_reply_template || '')}</textarea>
      <small class="hint">${esc(t('Variáveis: {id} (número da tarefa), {titulo} e {link}. Vazio usa a mensagem padrão.'))}</small></label>
    <label class="field"><span>${esc(t('Assinatura'))}</span><textarea class="input" name="signature" rows="2">${esc(b.signature || '')}</textarea></label>
    <div class="ps-row">
      <button class="btn primary" type="submit">${esc(box ? t('Salvar caixa de entrada') : t('Criar caixa de entrada'))}</button>
      ${box ? `
        <button type="button" class="btn bordered" data-act="inbox-test">${ICON.check} ${esc(t('Testar conexão'))}</button>
        <button type="button" class="btn bordered" data-act="inbox-sync">${ICON.repeat} ${esc(t('Verificar agora'))}</button>
        <span class="spacer"></span>
        <button type="button" class="btn danger" data-act="inbox-delete">${ICON.trash} ${esc(t('Remover caixa'))}</button>` : ''}
    </div>
    ${box ? `<p class="hint">${esc(t('O teste e a verificação usam a configuração salva.'))}</p>` : ''}`;
}

function ruleChips(r) {
  const c = r.conditions || {};
  const a = r.actions || {};
  const chip = (label, value) => `<span class="chip">${esc(label)}${value != null ? ` <b>${esc(value)}</b>` : ''}</span>`;
  const conds = [
    c.from_contains && chip(t('Remetente contém'), c.from_contains),
    c.subject_contains && chip(t('Assunto contém'), c.subject_contains),
    c.body_contains && chip(t('Texto contém'), c.body_contains),
  ].filter(Boolean);
  const acts = [
    a.ignore && chip(t('Ignorar o e-mail')),
    a.priority && chip(t('Prioridade'), PRIORITY_LABEL[a.priority]),
    a.type && chip(t('Tipo'), TYPE_LABEL[a.type]),
    a.tags?.length && chip(t('Tags'), a.tags.join(', ')),
    a.assignee && chip(t('Responsável'), userName(a.assignee)),
    a.column && chip(t('Coluna'), columnName(a.column)),
    r.stop && chip(t('Para nesta regra')),
  ].filter(Boolean);
  return `
    <div class="ps-chips"><span class="ps-kicker">${esc(t('Se'))}</span>${conds.length ? conds.join('') : chip(t('qualquer e-mail'))}</div>
    <div class="ps-chips"><span class="ps-kicker">${esc(t('Então'))}</span>${acts.length ? acts.join('') : chip(t('nada muda'))}</div>`;
}

function rulesCard({ data, manage }) {
  const rules = data.rules;
  return `
    <section class="card-box">
      <h3>${ICON.filter} ${esc(t('Regras'))} <span class="count">${rules.length}</span>
        ${manage ? `<span class="spacer"></span><button type="button" class="btn primary small" data-act="rule-new">${ICON.plus} ${esc(t('Nova regra'))}</button>` : ''}</h3>
      <p class="hint ps-gap">${esc(t('As regras rodam em ordem para cada e-mail novo (não para respostas). Todas as condições preenchidas precisam bater, sem diferenciar maiúsculas. Uma regra sem condição vale para todos os e-mails.'))}</p>
      ${rules.length ? `<div class="rule-list">${rules.map((r) => `
        <div class="rule ${r.enabled ? '' : 'off'}">
          <label class="switch" title="${esc(r.enabled ? t('Ativa') : t('Pausada'))}">
            <input type="checkbox" data-change="rule-toggle" data-id="${r.id}" ${r.enabled ? 'checked' : ''} ${dis(manage)} aria-label="${esc(t('Ativar a regra {name}', { name: r.name }))}"><span></span></label>
          <div class="rule-main"><b>${esc(r.name)}</b>${ruleChips(r)}</div>
          ${manage ? `
            <div class="ps-item-actions">
              <button type="button" class="icon-btn small" data-act="rule-edit" data-id="${r.id}" aria-label="${esc(t('Editar regra {name}', { name: r.name }))}">${ICON.edit}</button>
              <button type="button" class="icon-btn small" data-act="rule-delete" data-id="${r.id}" aria-label="${esc(t('Excluir regra {name}', { name: r.name }))}">${ICON.trash}</button>
            </div>` : ''}
        </div>`).join('')}</div>`
      : `<p class="empty-small">${esc(t('Nenhuma regra: todo e-mail novo vira tarefa com os padrões acima.'))}</p>`}
    </section>`;
}

function messagesCard({ data }) {
  const list = data.messages;
  return `
    <section class="card-box">
      <h3>${ICON.mail} ${esc(t('Últimos e-mails'))} <span class="count">${list.length}</span></h3>
      ${list.length ? `
        <div class="ps-table-wrap">
          <table class="mini-table ps-messages">
            <thead><tr><th>${esc(t('De'))}</th><th>${esc(t('Assunto'))}</th><th>${esc(t('Resultado'))}</th><th class="hide-sm">${esc(t('Recebido'))}</th></tr></thead>
            <tbody>${list.map((m) => `
              <tr>
                <td>${m.from_name ? `<b>${esc(m.from_name)}</b><br>` : ''}<span class="muted small">${esc(m.from_address || '—')}</span></td>
                <td class="ps-subject">${esc(m.subject || (m.status === 'error' ? '' : t('(sem assunto)')))}${m.error ? `<div class="ps-error small">${esc(m.error)}</div>` : ''}</td>
                <td><div class="ps-chips">
                  <span class="chip ps-msg-${esc(m.status)}">${esc(MESSAGE_STATUS[m.status]?.() || m.status)}</span>
                  ${m.task_id ? `<button type="button" class="link-btn" data-act="open-task" data-id="${m.task_id}">${ICON.link} ${esc(taskRef(taskById(m.task_id) || { id: m.task_id }))}</button>` : ''}
                </div></td>
                <td class="hide-sm muted small ps-nowrap">${when(m.received_at || m.created_at)}</td>
              </tr>`).join('')}</tbody>
          </table>
        </div>`
      : `<p class="empty-small">${esc(t('Nenhum e-mail processado ainda.'))}</p>`}
    </section>`;
}

async function saveInbox(ctx, form) {
  const f = form.elements;
  const body = {
    enabled: f.enabled.checked,
    address: f.address.value.trim(),
    imap_host: f.imap_host.value.trim(),
    imap_port: Number(f.imap_port.value) || 993,
    imap_secure: f.imap_secure.checked,
    imap_user: f.imap_user.value.trim(),
    imap_pass: f.imap_pass.value,
    mailbox: f.mailbox.value.trim() || 'INBOX',
    sync_minutes: Number(f.sync_minutes.value) || 5,
    default_type: f.default_type.value,
    default_priority: f.default_priority.value,
    default_column: f.default_column.value,
    default_assignee: f.default_assignee.value,
    auto_reply: f.auto_reply.checked,
    auto_reply_template: f.auto_reply_template.value,
    signature: f.signature.value,
  };
  const msg = ctx.data.inbox ? t('Caixa de entrada salva') : t('Caixa de entrada criada');
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/inbox`, { method: 'PUT', body }), msg)) await refresh(ctx, { reload: false });
}

async function testInbox(ctx, b) {
  await busy(b, () => attempt(() => api(`/api/projects/${ctx.project.id}/inbox/test`, { method: 'POST', body: {} }), t('Conexão com o servidor IMAP funcionando')));
}

async function syncInbox(ctx, b) {
  const r = await busy(b, () => attempt(() => api(`/api/projects/${ctx.project.id}/inbox/sync`, { method: 'POST', body: {} })));
  if (r) {
    toast([
      tn(r.tasks, '{n} tarefa nova', '{n} tarefas novas'),
      tn(r.comments, '{n} comentário', '{n} comentários'),
      tn(r.ignored, '{n} ignorado', '{n} ignorados'),
      tn(r.errors, '{n} erro', '{n} erros'),
    ].join(' · '), r.errors > 0);
  }
  // Mesmo com erro o servidor grava last_error: redesenha para mostrar.
  await refresh(ctx, { reload: !!r });
}

async function deleteInbox(ctx) {
  if (!(await confirmDanger(t('Remover a caixa de entrada deste projeto? As regras e o histórico de e-mails também são apagados; as tarefas criadas continuam.'), t('Remover')))) return;
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/inbox`, { method: 'DELETE' }), t('Caixa de entrada removida'))) await refresh(ctx, { reload: false });
}

function ruleDialog(ctx, rule) {
  const editing = !!rule;
  const c = rule?.conditions || {};
  const a = rule?.actions || {};
  const keep = t('Não mudar');
  dialog({
    title: editing ? t('Editar regra') : t('Nova regra'),
    submitLabel: editing ? t('Salvar') : t('Criar regra'),
    wide: true,
    body: `
      <div class="field-row">
        <label class="field ps-span-2"><span>${esc(t('Nome'))}</span><input class="input" name="name" value="${esc(rule?.name || '')}" required maxlength="120" placeholder="${esc(t('ex.: Bugs de clientes'))}"></label>
        <label class="field"><span>${esc(t('Ordem'))}</span><input class="input" type="number" name="position" value="${esc(rule?.position ?? ctx.data.rules.length)}" step="1"></label>
      </div>
      <h4 class="ps-subhead">${esc(t('Quando o e-mail…'))}</h4>
      <div class="field-row">
        <label class="field"><span>${esc(t('Remetente contém'))}</span><input class="input" name="from_contains" value="${esc(c.from_contains || '')}" maxlength="200" placeholder="@cliente.com"></label>
        <label class="field"><span>${esc(t('Assunto contém'))}</span><input class="input" name="subject_contains" value="${esc(c.subject_contains || '')}" maxlength="200"></label>
        <label class="field"><span>${esc(t('Texto contém'))}</span><input class="input" name="body_contains" value="${esc(c.body_contains || '')}" maxlength="200"></label>
      </div>
      <h4 class="ps-subhead">${esc(t('Então…'))}</h4>
      <label class="check"><input type="checkbox" name="ignore" ${a.ignore ? 'checked' : ''}><span>${esc(t('Ignorar o e-mail (não cria tarefa)'))}</span></label>
      <div class="field-row" data-task-actions ${a.ignore ? 'hidden' : ''}>
        <label class="field"><span>${esc(t('Prioridade'))}</span><select class="input" name="priority"><option value="">${esc(keep)}</option>${options(PRIORITIES, PRIORITY_LABEL, a.priority)}</select></label>
        <label class="field"><span>${esc(t('Tipo'))}</span><select class="input" name="type"><option value="">${esc(keep)}</option>${options(TYPES, TYPE_LABEL, a.type)}</select></label>
        <label class="field"><span>${esc(t('Responsável'))}</span>${userSelect('assignee', a.assignee, keep)}</label>
        <label class="field"><span>${esc(t('Coluna'))}</span>${columnSelect('column', a.column, { emptyLabel: keep, virtual: true })}</label>
        <label class="field ps-span-2"><span>${esc(t('Acrescentar tags (separadas por vírgula)'))}</span><input class="input" name="tags" value="${esc((a.tags || []).join(', '))}"></label>
      </div>
      <label class="check"><input type="checkbox" name="stop" ${rule?.stop ? 'checked' : ''}><span>${esc(t('Parar aqui: não aplicar as regras seguintes'))}</span></label>
      <label class="check"><input type="checkbox" name="enabled" ${rule ? (rule.enabled ? 'checked' : '') : 'checked'}><span>${esc(t('Regra ativa'))}</span></label>`,
    onOpen: (form) => {
      const f = form.elements;
      f.ignore.addEventListener('change', () => { $('[data-task-actions]', form).hidden = f.ignore.checked; });
    },
    onSubmit: async (form) => {
      const body = ruleBody(form.elements);
      const path = `/api/projects/${ctx.project.id}/inbox/rules`;
      const ok = editing
        ? await attempt(() => api(`${path}/${rule.id}`, { method: 'PATCH', body }), t('Regra salva'))
        : await attempt(() => api(path, { method: 'POST', body }), t('Regra criada'));
      if (!ok) return false;
      await refresh(ctx, { reload: false });
    },
  });
}

function ruleBody(f) {
  const ignore = f.ignore.checked;
  return {
    name: f.name.value,
    position: Number(f.position.value) || 0,
    enabled: f.enabled.checked,
    stop: f.stop.checked,
    conditions: { from_contains: f.from_contains.value.trim(), subject_contains: f.subject_contains.value.trim(), body_contains: f.body_contains.value.trim() },
    actions: ignore ? { ignore: true } : {
      priority: f.priority.value || undefined,
      type: f.type.value || undefined,
      assignee: f.assignee.value || undefined,
      column: f.column.value || undefined,
      tags: f.tags.value.split(',').map((x) => x.trim()).filter(Boolean),
    },
  };
}

// O PATCH de regra substitui tudo: manda a regra inteira com o novo "enabled".
async function toggleRule(ctx, input) {
  const r = ctx.data.rules.find((x) => x.id === Number(input.dataset.id));
  if (!r) return;
  const body = { name: r.name, position: r.position, enabled: input.checked, stop: r.stop, conditions: r.conditions, actions: r.actions };
  const ok = await attempt(() => api(`/api/projects/${ctx.project.id}/inbox/rules/${r.id}`, { method: 'PATCH', body }), input.checked ? t('Regra ativada') : t('Regra pausada'));
  if (!ok) input.checked = !input.checked;
  else await refresh(ctx, { reload: false });
}

async function deleteRule(ctx, b) {
  const r = ctx.data.rules.find((x) => x.id === Number(b.dataset.id));
  if (!r || !(await confirmDanger(t('Excluir a regra "{name}"?', { name: r.name }), t('Excluir')))) return;
  if (await attempt(() => api(`/api/projects/${ctx.project.id}/inbox/rules/${r.id}`, { method: 'DELETE' }), t('Regra excluída'))) await refresh(ctx, { reload: false });
}

// ---------- 7. Importar e exportar ----------

// Cabeçalhos aceitos pelo importador (src/importers.js): sem diferenciar maiúsculas e acentos.
const CSV_COLUMNS = [
  [() => t('Título (obrigatório)'), 'Título, Title, Summary, Resumo, Nome, Name, Tarefa, Task'],
  [() => t('Descrição'), 'Descrição, Description, Detalhes, Details'],
  [() => t('Status'), 'Status, Estado, Coluna, Column, Situação'],
  [() => t('Prioridade'), 'Prioridade, Priority'],
  [() => t('Tipo'), 'Tipo, Type, Issue Type, Tipo de item'],
  [() => t('Tags'), 'Tags, Labels, Label, Etiquetas, Rótulos'],
  [() => t('Responsáveis'), 'Responsável, Responsáveis, Assignee, Assignees, Atribuído a'],
  [() => t('Relator'), 'Relator, Reporter'],
  [() => t('Início'), 'Início, Start, Start date, Data de início'],
  [() => t('Prazo'), 'Prazo, Due, Due date, Vencimento, Data limite'],
  [() => t('Estimativa'), 'Estimativa, Estimate, Original estimate, Tempo estimado'],
  [() => t('Story points'), 'Story points, Pontos, Points, Story point estimate'],
  [() => t('Sprint'), 'Sprint'],
  [() => t('ID externo'), 'ID externo, External ID, Key, Chave, Issue key'],
  [() => t('Tarefa-mãe'), 'Parent, Parent ID, Tarefa-mãe, Parent summary'],
];

const resultSummary = (r) => [
  tn(r.created, '{n} criada', '{n} criadas'),
  tn(r.updated, '{n} atualizada', '{n} atualizadas'),
  tn(r.skipped, '{n} ignorada', '{n} ignoradas'),
  ...(r.errors?.length ? [tn(r.errors.length, '{n} erro', '{n} erros')] : []),
].join(' · ');

function resultCard(p) {
  if (!importResult || importResult.projectId !== p.id) return '';
  const { title, result: r } = importResult;
  const stat = (n, label) => `<div><b>${n}</b><span>${esc(label)}</span></div>`;
  return `
    <section class="card-box ps-result">
      <h3>${r.errors.length ? ICON.blocked : ICON.check} ${esc(title)}<span class="spacer"></span>
        <button type="button" class="icon-btn small" data-act="dismiss-result" aria-label="${esc(t('Fechar'))}">${ICON.close}</button></h3>
      <div class="ps-stats">
        ${stat(r.created, t('criadas'))}${stat(r.updated, t('atualizadas'))}${stat(r.skipped, t('ignoradas'))}${stat(r.errors.length, t('erros'))}
      </div>
      ${r.errors.length ? `
        <ul class="ps-errors">${r.errors.slice(0, 30).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
        ${r.errors.length > 30 ? `<p class="hint">${esc(t('e mais {n} erros', { n: r.errors.length - 30 }))}</p>` : ''}` : ''}
    </section>`;
}

function importHtml({ project: p, data, manage }) {
  return `
    ${resultCard(p)}
    <section class="card-box">
      <h3>${ICON.download} ${esc(t('Exportar'))}</h3>
      <p class="hint ps-gap">${esc(t('Planilha com todas as tarefas do projeto (abertas e concluídas), incluindo os campos personalizados. Abre no Excel, Numbers ou Google Planilhas.'))}</p>
      <a class="btn bordered" href="/api/export.csv?project=${p.id}" download>${ICON.download} ${esc(t('Baixar CSV'))}</a>
    </section>

    <section class="card-box">
      <h3>${ICON.upload} ${esc(t('Importar arquivo'))}</h3>
      ${readOnly(manage, t('Só gerentes e donos do projeto podem importar tarefas.'))}
      <div class="ps-import-grid">
        <div class="ps-import">
          <b>${esc(t('Planilha CSV'))}</b>
          <p class="hint">${esc(t('CSV com cabeçalho na primeira linha. O CSV exportado do Jira também é reconhecido.'))}</p>
          <div><button type="button" class="btn bordered" data-act="import-csv" ${dis(manage)}>${ICON.upload} ${esc(t('Escolher CSV'))}</button></div>
        </div>
        <div class="ps-import">
          <b>${esc(t('Quadro do Trello (JSON)'))}</b>
          <p class="hint">${esc(t('No Trello: Menu → Imprimir, exportar e compartilhar → Exportar como JSON. Cada lista vira uma coluna, as etiquetas viram labels e os checklists viram subtarefas.'))}</p>
          <div><button type="button" class="btn bordered" data-act="import-trello-file" ${dis(manage)}>${ICON.upload} ${esc(t('Escolher JSON'))}</button></div>
        </div>
      </div>
      <details class="ps-details">
        <summary>${esc(t('Colunas aceitas no CSV'))}</summary>
        <div class="ps-table-wrap">
          <table class="mini-table">
            <thead><tr><th>${esc(t('Campo'))}</th><th>${esc(t('Nomes de coluna aceitos'))}</th></tr></thead>
            <tbody>${CSV_COLUMNS.map(([label, names]) => `<tr><td class="ps-nowrap"><b>${esc(label())}</b></td><td class="muted">${esc(names)}</td></tr>`).join('')}</tbody>
          </table>
        </div>
        <ul class="ps-howto">
          <li>${esc(t('Os nomes de coluna não diferenciam maiúsculas nem acentos. Separador: vírgula ou ponto e vírgula. Colunas desconhecidas são ignoradas.'))}</li>
          <li>${esc(t('Status: “concluído”, “feito” ou “done” vira Concluída; “bloqueado” ou “aguardando” vira Bloqueada; “andamento”, “revisão” ou “teste” vira Em andamento; o resto fica A fazer.'))}</li>
          <li>${esc(t('Prioridade: urgente, alta, média, baixa ou mínima (também highest, high, low, lowest e P0 a P4). Tipo: tarefa, bug, história ou épico.'))}</li>
          <li>${esc(t('Datas em AAAA-MM-DD ou DD/MM/AAAA. Estimativa em minutos ou como “2h30m”. Tags e responsáveis separados por vírgula.'))}</li>
          <li>${esc(t('Responsáveis e relator precisam bater com o nome ou o e-mail de uma conta do quadro. Sprints que não existem são criadas.'))}</li>
          <li>${esc(t('Com a coluna de ID externo, importar o mesmo arquivo de novo atualiza as tarefas em vez de duplicar.'))}</li>
        </ul>
      </details>
    </section>

    <section class="card-box">
      <h3>${ICON.link} ${esc(t('Importar do Jira'))}</h3>
      <p class="hint ps-gap">${esc(t('Busca as issues pela API do Jira Cloud. Crie o token em id.atlassian.com → Segurança → Tokens de API. Por padrão só endereços *.atlassian.net são aceitos (variável CLAUDE_TASKS_JIRA_HOSTS no servidor).'))}</p>
      <form data-form="import-jira">
        ${fieldset(manage, `
          <div class="field-row">
            <label class="field"><span>${esc(t('Endereço do Jira'))}</span><input class="input" type="url" name="site" required placeholder="https://empresa.atlassian.net"></label>
            <label class="field"><span>${esc(t('E-mail da conta'))}</span><input class="input" type="email" name="email" required autocomplete="off"></label>
          </div>
          <div class="field-row">
            <label class="field"><span>${esc(t('Token de API'))}</span><input class="input" type="password" name="token" required autocomplete="new-password"></label>
            <label class="field"><span>${esc(t('Filtro JQL (opcional)'))}</span><input class="input" name="jql" placeholder="project = WEB ORDER BY created DESC" spellcheck="false"></label>
          </div>
          <label class="check"><input type="checkbox" name="save"><span>${esc(t('Salvar para sincronizar de novo depois (o token fica guardado criptografado)'))}</span></label>
          <div><button class="btn primary" type="submit">${ICON.download} ${esc(t('Importar do Jira'))}</button></div>`)}
      </form>
    </section>

    <section class="card-box">
      <h3>${ICON.link} ${esc(t('Importar do Trello'))}</h3>
      <p class="hint ps-gap">${esc(t('Busca o quadro pela API do Trello. Pegue a chave e o token em trello.com/app-key.'))}</p>
      <form data-form="import-trello">
        ${fieldset(manage, `
          <label class="field"><span>${esc(t('Link ou id do quadro'))}</span><input class="input" name="board" required placeholder="https://trello.com/b/abc123/…" spellcheck="false"></label>
          <div class="field-row">
            <label class="field"><span>${esc(t('Chave da API'))}</span><input class="input" name="key" required autocomplete="off" spellcheck="false"></label>
            <label class="field"><span>${esc(t('Token'))}</span><input class="input" type="password" name="token" required autocomplete="new-password"></label>
          </div>
          <label class="check"><input type="checkbox" name="save"><span>${esc(t('Salvar para sincronizar de novo depois (o token fica guardado criptografado)'))}</span></label>
          <div><button class="btn primary" type="submit">${ICON.download} ${esc(t('Importar do Trello'))}</button></div>`)}
      </form>
    </section>

    ${syncsCard({ data, manage })}`;
}

function syncsCard({ data, manage }) {
  const list = data.syncs;
  return `
    <section class="card-box">
      <h3>${ICON.repeat} ${esc(t('Sincronizações salvas'))} <span class="count">${list.length}</span></h3>
      <p class="hint ps-gap">${esc(t('Rodar de novo traz as novidades e atualiza as tarefas já importadas, sem duplicar.'))}</p>
      ${list.length ? `
        <div class="ps-table-wrap">
          <table class="mini-table">
            <thead><tr><th>${esc(t('Origem'))}</th><th class="hide-sm">${esc(t('Última vez'))}</th><th>${esc(t('Resultado'))}</th><th></th></tr></thead>
            <tbody>${list.map((s) => `
              <tr>
                <td><b>${s.kind === 'jira' ? 'Jira' : 'Trello'}</b><br><span class="muted small ps-break">${esc(s.kind === 'jira' ? [s.config.site, s.config.jql].filter(Boolean).join(' · ') : s.config.board)}</span></td>
                <td class="hide-sm muted small">${esc(s.last_sync_at ? ago(s.last_sync_at) : t('nunca'))}</td>
                <td class="small">${esc(s.last_result ? resultSummary(s.last_result) : '—')}</td>
                <td class="ps-nowrap">
                  ${manage ? `
                    <button type="button" class="btn ghost small" data-act="sync-run" data-id="${s.id}">${ICON.repeat} ${esc(t('Rodar'))}</button>
                    <button type="button" class="icon-btn small" data-act="sync-delete" data-id="${s.id}" aria-label="${esc(t('Excluir sincronização'))}">${ICON.trash}</button>` : ''}
                </td>
              </tr>`).join('')}</tbody>
          </table>
        </div>`
      : `<p class="empty-small">${esc(t('Nenhuma sincronização salva. Marque “Salvar para sincronizar de novo” ao importar do Jira ou do Trello.'))}</p>`}
    </section>`;
}

async function runImport(ctx, title, fn) {
  const result = await attempt(fn);
  if (!result) return;
  importResult = { projectId: ctx.project.id, title, result };
  toast(resultSummary(result), result.errors?.length > 0);
  await refresh(ctx);
}

async function importFile(ctx, b, { accept, path, title }) {
  const file = await pickFile(accept);
  if (!file) return;
  await busy(b, () => runImport(ctx, title(file.name), () => uploadTo(`/api/projects/${ctx.project.id}/import/${path}`, file)));
}

async function importApi(ctx, form, kind) {
  const f = form.elements;
  const body = kind === 'jira'
    ? { site: f.site.value.trim(), email: f.email.value.trim(), token: f.token.value, jql: f.jql.value.trim(), save: f.save.checked }
    : { board: f.board.value.trim(), key: f.key.value.trim(), token: f.token.value, save: f.save.checked };
  await runImport(ctx, kind === 'jira' ? t('Importação do Jira') : t('Importação do Trello'),
    () => api(`/api/projects/${ctx.project.id}/import/${kind}`, { method: 'POST', body }));
}

async function runSync(ctx, b) {
  const s = ctx.data.syncs.find((x) => x.id === Number(b.dataset.id));
  if (!s) return;
  await busy(b, () => runImport(ctx, s.kind === 'jira' ? t('Sincronização do Jira') : t('Sincronização do Trello'),
    () => api(`/api/syncs/${s.id}/run`, { method: 'POST', body: {} })));
}

async function deleteSync(ctx, b) {
  if (!(await confirmDanger(t('Excluir esta sincronização salva? As tarefas importadas continuam no projeto.'), t('Excluir')))) return;
  if (await attempt(() => api(`/api/syncs/${b.dataset.id}`, { method: 'DELETE' }), t('Sincronização excluída'))) await refresh(ctx, { reload: false });
}

// ---------- 8. Links públicos ----------

function sharesHtml({ data, manage }) {
  const list = data.shares;
  return `
    <section class="card-box">
      <h3>${ICON.globe} ${esc(t('Links públicos de leitura'))}</h3>
      <p class="hint ps-gap">${esc(t('Quem tiver o link vê o quadro do projeto sem precisar de conta: colunas, tarefas abertas e as concluídas nos últimos 30 dias. Não mostra e-mails nem horas registradas. Revogue quando não precisar mais.'))}</p>
      ${manage ? `
        <form data-form="share-new" class="ps-row">
          <label class="inline-field">${esc(t('Validade em dias'))}
            <input type="number" name="days" min="1" max="3650" placeholder="${esc(t('sem limite'))}" aria-label="${esc(t('Validade em dias (vazio = sem validade)'))}"></label>
          <button class="btn primary" type="submit">${ICON.link} ${esc(t('Gerar link'))}</button>
        </form>` : readOnly(false, t('Só gerentes e donos do projeto geram e revogam links.'))}
      ${list.length ? `<div class="ps-list ps-gap-top">${list.map((s) => `
        <div class="ps-item">
          <div class="ps-item-main">
            <code class="ps-url">${esc(shareUrl(s.token))}</code>
            <p class="muted small">${esc(s.created_by_name
              ? t('Criado {quando} por {nome}', { quando: ago(s.created_at), nome: s.created_by_name })
              : t('Criado {quando}', { quando: ago(s.created_at) }))} · ${esc(s.expires_at ? t('expira em {data}', { data: fmtDate(s.expires_at.slice(0, 10), { year: true }) }) : t('sem validade'))}</p>
          </div>
          <div class="ps-item-actions">
            <button type="button" class="btn ghost small" data-act="share-copy" data-token="${esc(s.token)}">${ICON.copy} ${esc(t('Copiar'))}</button>
            <a class="icon-btn small" href="${esc(shareUrl(s.token))}" target="_blank" rel="noopener" aria-label="${esc(t('Abrir link'))}" title="${esc(t('Abrir link'))}">${ICON.eye}</a>
            ${manage ? `<button type="button" class="icon-btn small" data-act="share-revoke" data-token="${esc(s.token)}" aria-label="${esc(t('Revogar link'))}">${ICON.trash}</button>` : ''}
          </div>
        </div>`).join('')}</div>`
      : `<p class="empty-small">${esc(t('Nenhum link ativo.'))}</p>`}
    </section>`;
}

async function createShare(ctx, form) {
  const days = form.elements.days.value ? Number(form.elements.days.value) : null;
  const s = await attempt(() => api(`/api/projects/${ctx.project.id}/shares`, { method: 'POST', body: { days } }));
  if (!s) return;
  await copy(shareUrl(s.token), t('Link criado e copiado'));
  await refresh(ctx, { reload: false });
}

async function revokeShare(ctx, b) {
  if (!(await confirmDanger(t('Revogar este link? Quem tiver o endereço deixa de conseguir abrir.'), t('Revogar')))) return;
  if (await attempt(() => api(`/api/shares/${encodeURIComponent(b.dataset.token)}`, { method: 'DELETE' }), t('Link revogado'))) await refresh(ctx, { reload: false });
}

// ---------- 9. Zona de perigo ----------

function dangerHtml({ project: p, own }) {
  const archived = !!p.archived_at;
  return `
    ${own ? '' : readOnly(false, t('Só donos do projeto e administradores podem arquivar ou excluir o projeto.'))}
    <section class="card-box ps-danger">
      <h3>${ICON.archive} ${esc(archived ? t('Desarquivar projeto') : t('Arquivar projeto'))}</h3>
      <p class="ps-text">${esc(archived
        ? t('Este projeto está arquivado desde {data}. Desarquivar faz ele voltar para a barra lateral e o dashboard.', { data: fmtDate(p.archived_at.slice(0, 10), { year: true }) })
        : t('Projetos arquivados somem da barra lateral e do dashboard, mas nada é apagado. Dá para desarquivar a qualquer momento.'))}</p>
      <div><button type="button" class="btn bordered" data-act="archive" ${dis(own)}>${ICON.archive} ${esc(archived ? t('Desarquivar') : t('Arquivar projeto'))}</button></div>
    </section>
    <section class="card-box ps-danger">
      <h3>${ICON.trash} ${esc(t('Excluir projeto'))}</h3>
      <p class="ps-text">${esc(t('Apaga o projeto com todas as tarefas, comentários, anexos, colunas, labels, campos e a caixa de entrada. Não dá para desfazer. Para só tirar da frente, arquive.'))}</p>
      <div><button type="button" class="btn danger-solid" data-act="delete-project" ${dis(own)}>${ICON.trash} ${esc(t('Excluir projeto'))}</button></div>
    </section>`;
}

async function toggleArchive(ctx) {
  const archived = !ctx.project.archived_at;
  if (await attempt(() => api(`/api/projects/${ctx.project.id}`, { method: 'PATCH', body: { archived } }), archived ? t('Projeto arquivado') : t('Projeto desarquivado'))) await refresh(ctx);
}

async function deleteProject(ctx) {
  const p = ctx.project;
  const n = taskCount(p);
  const msg = n
    ? tn(n, 'Excluir o projeto "{name}" e a {n} tarefa dele? Isso não pode ser desfeito.', 'Excluir o projeto "{name}" e as {n} tarefas dele? Isso não pode ser desfeito.', { name: p.name })
    : t('Excluir o projeto "{name}"? Isso não pode ser desfeito.', { name: p.name });
  if (!(await confirmDanger(msg, t('Excluir projeto'), t('Excluir projeto')))) return;
  if (!(await attempt(() => api(`/api/projects/${p.id}`, { method: 'DELETE' }), t('Projeto excluído')))) return;
  section = 'general';
  // navigate recarrega o estado quando o projeto muda.
  navigate({ projectId: null, view: 'board' });
}

// ---------- tabelas de eventos ----------

const VIEWS = {
  general: { html: generalHtml },
  members: { load: async (p) => ({ members: await api(`/api/projects/${p.id}/members`) }), html: membersHtml },
  workflow: { load: loadWorkflow, html: workflowHtml },
  labels: { load: async (p) => ({ labels: await api(`/api/labels?project=${p.id}`) }), html: labelsHtml },
  fields: { load: async (p) => ({ fields: await api(`/api/fields?project=${p.id}`) }), html: fieldsHtml },
  inbox: { load: (p) => api(`/api/projects/${p.id}/inbox`), html: inboxHtml },
  import: { load: async (p) => ({ syncs: await api(`/api/projects/${p.id}/syncs`) }), html: importHtml },
  shares: { load: async (p) => ({ shares: await api(`/api/projects/${p.id}/shares`) }), html: sharesHtml },
  danger: { html: dangerHtml },
};

const byId = (list, b) => list.find((x) => x.id === Number(b.dataset.id));

const ACTIONS = {
  retry: (ctx) => ctx.rerender(),
  'avatar-upload': uploadAvatar,
  'avatar-remove': removeAvatar,
  'member-remove': removeMember,
  'col-move': moveColumn,
  'col-delete': deleteColumn,
  'transitions-clear': clearTransitions,
  'workflow-apply': applyWorkflow,
  'workflow-delete': deleteWorkflow,
  'label-new': (ctx, b) => labelDialog(ctx, null, { global: !!b.dataset.global }),
  'label-edit': (ctx, b) => labelDialog(ctx, byId(ctx.data.labels, b)),
  'label-delete': deleteLabel,
  'field-new': (ctx) => fieldDialog(ctx, null),
  'field-edit': (ctx, b) => fieldDialog(ctx, byId(ctx.data.fields, b)),
  'field-delete': deleteField,
  'inbox-test': testInbox,
  'inbox-sync': syncInbox,
  'inbox-delete': deleteInbox,
  'rule-new': (ctx) => ruleDialog(ctx, null),
  'rule-edit': (ctx, b) => ruleDialog(ctx, byId(ctx.data.rules, b)),
  'rule-delete': deleteRule,
  'open-task': (ctx, b) => openTask(Number(b.dataset.id)),
  'open-settings': () => navigate({ projectId: null, view: 'settings' }),
  'import-csv': (ctx, b) => importFile(ctx, b, { accept: '.csv,text/csv', path: 'csv', title: (name) => t('Importação de {arquivo}', { arquivo: name }) }),
  'import-trello-file': (ctx, b) => importFile(ctx, b, { accept: '.json,application/json', path: 'trello-file', title: (name) => t('Importação de {arquivo}', { arquivo: name }) }),
  'dismiss-result': (ctx) => { importResult = null; ctx.rerender(); },
  'sync-run': runSync,
  'sync-delete': deleteSync,
  'share-copy': (ctx, b) => copy(shareUrl(b.dataset.token), t('Link copiado')),
  'share-revoke': revokeShare,
  archive: toggleArchive,
  'delete-project': deleteProject,
};

const FORMS = {
  general: saveGeneral,
  'member-add': addMember,
  'column-add': addColumn,
  transitions: saveTransitions,
  'workflow-save': saveWorkflow,
  inbox: saveInbox,
  'import-jira': (ctx, form) => importApi(ctx, form, 'jira'),
  'import-trello': (ctx, form) => importApi(ctx, form, 'trello'),
  'share-new': createShare,
};

const CHANGES = {
  'member-role': (ctx, s) => setMember(ctx, Number(s.dataset.user), s.value, t('Papel atualizado')),
  'col-name': renameColumn,
  'col-status': changeColumnStatus,
  'rule-toggle': toggleRule,
};

const INPUTS = {
  key: (ctx, input) => {
    const k = input.value.trim().toUpperCase();
    const hint = $('[data-key-hint]', ctx.el);
    if (!hint) return;
    const valid = /^[A-Z][A-Z0-9]{1,9}$/.test(k);
    hint.textContent = !k || valid ? keyHint(k) : t('Use de 2 a 10 letras ou números, começando por letra (ex.: WEB).');
  },
  'member-filter': filterMembers,
};
