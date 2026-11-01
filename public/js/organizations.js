// Página Organizações: organizações → workspaces (aninhados) → projetos, com membros e papéis
// por escopo. Papéis dados na organização ou no workspace valem para os projetos dentro dele.
import { api, attempt, pickFile, toast, uploadTo } from './api.js';
import { t, tn } from './i18n.js';
import { can, isAdmin, load, navigate, projectById, state, workspaceById, workspaceTree } from './state.js';
import { confirmAction, openDialog, showMenu } from './ui.js';
import { ICON, ROLES, ROLE_LABEL, avatar, esc, projectBadge, projectColor } from './util.js';

const COLORS = ['#c8623f', '#d9772b', '#c9900e', '#2f9e6b', '#1f9aa5', '#2a78d6', '#6f7ae0', '#9a5fc4', '#d64545', '#8f8c86'];
const PATH = { organization: 'organizations', workspace: 'workspaces' };

// Workspaces com a lista de membros aberta (sobrevive a redesenhos).
const openMembers = new Set();
// 'organization:2' / 'workspace:5' → membros com papel naquele escopo.
let members = new Map();

const key = (scope, id) => `${scope}:${id}`;
const orgById = (id) => state.organizations.find((o) => o.id === id);
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const safeHref = (url) => (/^https?:\/\//i.test(url) ? url : `https://${url}`);

// Igual ao servidor (canManageOrg): administradores ou donos/gerentes da organização.
function canManageOrg(org) {
  if (isAdmin()) return true;
  const mine = (members.get(key('organization', org.id)) || []).find((m) => m.id === state.me?.id);
  return mine?.role === 'owner' || mine?.role === 'manager';
}

const isRoot = (w) => !w.parent_id || !state.workspaces.some((x) => x.id === w.parent_id && x.organization_id === w.organization_id);
const childrenOf = (w) => state.workspaces.filter((x) => x.parent_id === w.id && x.organization_id === w.organization_id);
const projectsIn = (wid) => state.projects.filter((p) => p.workspace_id === wid)
  .sort((a, b) => !!a.archived_at - !!b.archived_at || byName(a, b));

async function fetchMembers() {
  const scopes = [
    ...state.organizations.map((o) => ['organization', o.id]),
    ...state.workspaces.map((w) => ['workspace', w.id]),
  ];
  const lists = await Promise.all(scopes.map(([scope, id]) => api(`/api/${PATH[scope]}/${id}/members`).catch(() => [])));
  members = new Map(scopes.map(([scope, id], i) => [key(scope, id), lists[i]]));
}

export async function renderOrganizations(el) {
  await fetchMembers();
  if (!el.isConnected) return;
  paint(el);
  bind(el);
}

async function refresh(el) {
  await load();
  await renderOrganizations(el);
}

// ---------- HTML ----------

function paint(el) {
  const orgs = state.organizations;
  const orphans = state.projects.filter((p) => !p.workspace_id || !workspaceById(p.workspace_id)).sort(byName);
  el.innerHTML = `
    <div class="page orgs-page">
      <div class="orgs-intro">
        <p class="hint">${ICON.shield}<span>${t('Papéis dados numa organização ou num workspace valem para todos os projetos dentro dele, inclusive nos sub-workspaces. Se a pessoa tiver papéis em mais de um nível, vale o mais alto. Administradores do quadro sempre têm acesso total.')}</span></p>
        ${isAdmin() ? `<button class="btn primary" data-new-org>${ICON.plus}<span>${t('Nova organização')}</span></button>` : ''}
      </div>
      ${orgs.map(orgCard).join('')}
      ${orphans.length ? `
        <section class="card-box">
          <h3>${ICON.folder} ${t('Projetos sem workspace')} <span class="count">${orphans.length}</span></h3>
          <ul class="ws-children flat">${orphans.map(projectRow).join('')}</ul>
        </section>` : ''}
    </div>`;
}

function orgAvatar(o) {
  if (o.avatar) return `<img class="org-avatar" src="/api/avatars/${esc(o.avatar)}" alt="">`;
  const initials = o.name.split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return `<span class="org-avatar" style="--c:${esc(projectColor(o))}">${esc(initials)}</span>`;
}

function orgCard(o) {
  const manage = canManageOrg(o);
  const mem = members.get(key('organization', o.id)) || [];
  const roots = state.workspaces.filter((w) => w.organization_id === o.id && isRoot(w));
  const sub = [o.description && esc(o.description), o.website && `<a href="${esc(safeHref(o.website))}" target="_blank" rel="noopener">${esc(o.website)}</a>`].filter(Boolean);
  return `
    <section class="card-box org-card${o.archived_at ? ' archived' : ''}" data-org="${o.id}">
      <header class="org-head">
        ${orgAvatar(o)}
        <div class="org-title">
          <h2>${esc(o.name)}${o.archived_at ? ` <span class="chip">${t('arquivada')}</span>` : ''}</h2>
          ${sub.length ? `<p class="muted small">${sub.join(' · ')}</p>` : ''}
        </div>
        <span class="org-counts muted small">${tn(o.workspace_count, '{n} workspace', '{n} workspaces')} · ${tn(o.project_count, '{n} projeto', '{n} projetos')}</span>
        ${manage ? `<button class="icon-btn" data-org-more="${o.id}" aria-label="${esc(t('Opções da organização'))}">${ICON.more}</button>` : ''}
      </header>
      <div class="org-body">
        <div class="org-tree">
          <div class="section-label">${ICON.layers} ${t('Workspaces e projetos')}
            ${manage ? `<button data-new-ws="${o.id}">${ICON.plus}${t('Novo workspace')}</button>` : ''}</div>
          ${roots.length ? `<ul class="ws-tree">${roots.map((w) => wsNode(w, manage, new Set())).join('')}</ul>` : `<p class="empty-small">${t('Nenhum workspace ainda.')}</p>`}
        </div>
        <div class="org-members">
          <div class="section-label">${ICON.users} ${t('Membros da organização')} <span class="count">${mem.length}</span></div>
          ${membersPanel('organization', o.id, mem, manage)}
        </div>
      </div>
    </section>`;
}

function wsNode(w, manage, seen) {
  if (seen.has(w.id)) return '';
  seen.add(w.id);
  const projects = projectsIn(w.id);
  const kids = childrenOf(w);
  const mem = members.get(key('workspace', w.id)) || [];
  const open = openMembers.has(w.id);
  return `
    <li class="ws-node${w.archived_at ? ' archived' : ''}">
      <div class="ws-row">
        <span class="ws-icon" style="--c:${esc(w.color || 'var(--text-3)')}">${ICON.layers}</span>
        <button class="ws-name" data-ws-menu="${w.id}" aria-haspopup="menu" title="${esc(t('Opções do workspace'))}">${esc(w.name)}</button>
        ${w.archived_at ? `<span class="chip">${t('arquivado')}</span>` : ''}
        <span class="muted small ws-count">${tn(projects.length, '{n} projeto', '{n} projetos')}</span>
        <span class="spacer"></span>
        <button class="btn ghost small ws-members-btn${open ? ' on' : ''}" data-ws-members="${w.id}" aria-expanded="${open}"
          title="${esc(open ? t('Esconder membros') : t('Ver membros'))}">${ICON.users}<span>${mem.length}</span></button>
        <button class="icon-btn small" data-ws-menu="${w.id}" aria-label="${esc(t('Opções do workspace'))}">${ICON.more}</button>
      </div>
      ${w.description ? `<p class="ws-desc muted small">${esc(w.description)}</p>` : ''}
      ${open ? `<div class="ws-members">${membersPanel('workspace', w.id, mem, manage)}</div>` : ''}
      ${projects.length || kids.length ? `
        <ul class="ws-children">
          ${projects.map(projectRow).join('')}
          ${kids.map((k) => wsNode(k, manage, seen)).join('')}
        </ul>` : ''}
    </li>`;
}

function projectRow(p) {
  return `
    <li class="proj-row${p.archived_at ? ' archived' : ''}">
      ${projectBadge(p)}
      <button class="proj-name" data-open-project="${p.id}" title="${esc(t('Abrir o quadro do projeto'))}">${esc(p.name)}</button>
      ${p.key ? `<span class="tid">${esc(p.key)}</span>` : ''}
      ${p.archived_at ? `<span class="chip">${t('arquivado')}</span>` : ''}
      <span class="spacer"></span>
      <span class="muted small proj-open">${tn(p.open || 0, '{n} aberta', '{n} abertas')}</span>
      ${can(p, 'manage') ? `<button class="icon-btn small" data-move-project="${p.id}" title="${esc(t('Mover para outro workspace'))}" aria-label="${esc(t('Mover {name} para outro workspace', { name: p.name }))}">${ICON.folder}</button>` : ''}
    </li>`;
}

function roleOptions(selected) {
  return ROLES.map((r) => `<option value="${r}"${r === selected ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
}

function membersPanel(scope, id, list, manage) {
  const taken = new Set(list.map((m) => m.id));
  const candidates = state.users.filter((u) => !taken.has(u.id));
  return `
    <div class="members-panel" data-scope="${scope}" data-scope-id="${id}">
      ${list.length ? list.map((m) => `
        <div class="member-row">
          <span class="person-cell">${avatar(m, { size: 24 })}<span class="member-name"><b>${esc(m.name)}</b><span class="muted small">${esc(m.email)}</span></span></span>
          <span class="spacer"></span>
          ${manage ? `
            <select class="input small" data-member-role="${m.id}" aria-label="${esc(t('Papel de {name}', { name: m.name }))}">${roleOptions(m.role)}</select>
            <button class="icon-btn small" data-member-remove="${m.id}" aria-label="${esc(t('Tirar {name}', { name: m.name }))}" title="${esc(t('Tirar o papel'))}">${ICON.close}</button>`
            : `<span class="chip">${ROLE_LABEL[m.role]}</span>`}
        </div>`).join('') : `<p class="empty-small">${scope === 'organization' ? t('Ninguém tem papel na organização ainda.') : t('Ninguém tem papel neste workspace ainda.')}</p>`}
      ${manage && candidates.length ? `
        <form class="member-add" data-form="add-member">
          <select class="input small" name="user" required aria-label="${esc(t('Pessoa'))}">
            <option value="">${t('Adicionar pessoa…')}</option>
            ${candidates.map((u) => `<option value="${u.id}">${esc(u.name)}</option>`).join('')}
          </select>
          <select class="input small" name="role" aria-label="${esc(t('Papel'))}">${roleOptions('member')}</select>
          <button class="btn small primary" type="submit">${t('Adicionar')}</button>
        </form>` : ''}
    </div>`;
}

// ---------- formulários ----------

function colorField(current) {
  const colors = current && !COLORS.includes(current) ? [current, ...COLORS] : COLORS;
  return `
    <div class="field"><span>${t('Cor')}</span>
      <div class="orgs-swatches">
        <label class="swatch none" title="${esc(t('Sem cor'))}"><input type="radio" name="color" value=""${current ? '' : ' checked'} aria-label="${esc(t('Sem cor'))}"><span></span></label>
        ${colors.map((c) => `<label class="swatch" style="--c:${esc(c)}"><input type="radio" name="color" value="${esc(c)}"${c === current ? ' checked' : ''} aria-label="${esc(c)}"><span></span></label>`).join('')}
      </div>
    </div>`;
}

function orgDialog(el, org = null) {
  openDialog({
    title: org ? t('Editar organização') : t('Nova organização'),
    submitLabel: org ? t('Salvar') : t('Criar'),
    cancelLabel: t('Cancelar'),
    body: `
      <label class="field"><span>${t('Nome')}</span><input class="input" name="name" required maxlength="120" value="${esc(org?.name)}"></label>
      <label class="field"><span>${t('Descrição')}</span><textarea class="input" name="description" rows="2">${esc(org?.description)}</textarea></label>
      <label class="field"><span>${t('Site')}</span><input class="input" name="website" maxlength="300" placeholder="https://" value="${esc(org?.website)}"></label>
      ${colorField(org?.color)}
      ${org ? '' : `<p class="hint">${t('A organização já nasce com um workspace “Geral”.')}</p>`}`,
    onSubmit: async (form) => {
      const f = form.elements;
      const body = { name: f.name.value.trim(), description: f.description.value.trim(), website: f.website.value.trim(), color: f.color.value };
      const ok = await attempt(() => (org
        ? api(`/api/organizations/${org.id}`, { method: 'PATCH', body })
        : api('/api/organizations', { method: 'POST', body })), org ? t('Organização salva') : t('Organização criada'));
      if (!ok) return false;
      await refresh(el);
    },
  });
}

// Opções de "dentro de": workspaces da organização, menos o próprio e os que estão dentro dele.
function parentOptions(orgId, ws, selected) {
  const exclude = ws ? workspaceTree(ws.id) : new Set();
  const out = [`<option value="">${t('Direto na organização')}</option>`];
  const walk = (list, depth) => {
    for (const w of list.sort(byName)) {
      if (exclude.has(w.id)) continue;
      out.push(`<option value="${w.id}"${w.id === selected ? ' selected' : ''}>${'   '.repeat(depth)}${esc(w.name)}</option>`);
      walk(childrenOf(w), depth + 1);
    }
  };
  walk(state.workspaces.filter((w) => w.organization_id === orgId && isRoot(w)), 0);
  return out.join('');
}

function wsDialog(el, { orgId, ws = null, parentId = null }) {
  const org = orgById(orgId);
  openDialog({
    title: ws ? t('Editar workspace') : t('Novo workspace'),
    submitLabel: ws ? t('Salvar') : t('Criar'),
    cancelLabel: t('Cancelar'),
    body: `
      <p class="hint">${ICON.building}<span>${esc(org?.name)}</span></p>
      <label class="field"><span>${t('Nome')}</span><input class="input" name="name" required maxlength="120" value="${esc(ws?.name)}"></label>
      <label class="field"><span>${t('Descrição')}</span><textarea class="input" name="description" rows="2">${esc(ws?.description)}</textarea></label>
      <label class="field"><span>${t('Dentro de')}</span><select class="input" name="parent_id">${parentOptions(orgId, ws, ws ? ws.parent_id : parentId)}</select></label>
      ${colorField(ws?.color)}`,
    onSubmit: async (form) => {
      const f = form.elements;
      const body = { name: f.name.value.trim(), description: f.description.value.trim(), color: f.color.value, parent_id: Number(f.parent_id.value) || null };
      const ok = await attempt(() => (ws
        ? api(`/api/workspaces/${ws.id}`, { method: 'PATCH', body })
        : api('/api/workspaces', { method: 'POST', body: { ...body, organization_id: orgId } })), ws ? t('Workspace salvo') : t('Workspace criado'));
      if (!ok) return false;
      await refresh(el);
    },
  });
}

// Todos os workspaces, agrupados por organização e recuados pela profundidade.
function workspaceOptions(selected) {
  return state.organizations.map((o) => {
    const opts = [];
    const walk = (list, depth) => {
      for (const w of list.sort(byName)) {
        opts.push(`<option value="${w.id}"${w.id === selected ? ' selected' : ''}>${'   '.repeat(depth)}${esc(w.name)}</option>`);
        walk(childrenOf(w), depth + 1);
      }
    };
    walk(state.workspaces.filter((w) => w.organization_id === o.id && isRoot(w)), 0);
    return opts.length ? `<optgroup label="${esc(o.name)}">${opts.join('')}</optgroup>` : '';
  }).join('');
}

function moveDialog(el, p) {
  openDialog({
    title: t('Mover projeto'),
    submitLabel: t('Mover'),
    cancelLabel: t('Cancelar'),
    body: `
      <p class="dialog-text">${t('Escolha o workspace de destino de “{name}”.', { name: esc(p.name) })}</p>
      <label class="field"><span>${t('Workspace')}</span><select class="input" name="workspace_id" required>${workspaceOptions(p.workspace_id)}</select></label>
      <p class="hint">${t('Quem tem papel no workspace ou na organização de destino passa a ter esse papel no projeto. Os papéis dados direto no projeto continuam.')}</p>`,
    onSubmit: async (form) => {
      const workspace_id = Number(form.elements.workspace_id.value);
      if (workspace_id === p.workspace_id) return;
      const ok = await attempt(() => api(`/api/projects/${p.id}`, { method: 'PATCH', body: { workspace_id } }), t('Projeto movido'));
      if (!ok) return false;
      await refresh(el);
    },
  });
}

// ---------- menus ----------

function orgMenu(el, anchor, o) {
  const items = [
    { label: t('Editar…'), icon: ICON.edit, onClick: () => orgDialog(el, o) },
    { label: t('Novo workspace…'), icon: ICON.plus, onClick: () => wsDialog(el, { orgId: o.id }) },
    { label: o.avatar ? t('Trocar imagem…') : t('Enviar imagem…'), icon: ICON.upload, onClick: () => uploadAvatar(el, o) },
  ];
  if (o.avatar) items.push({ label: t('Remover imagem'), icon: ICON.close, onClick: () => removeAvatar(el, o) });
  items.push({
    label: o.archived_at ? t('Restaurar organização') : t('Arquivar organização'),
    icon: ICON.archive,
    onClick: async () => {
      const ok = await attempt(() => api(`/api/organizations/${o.id}`, { method: 'PATCH', body: { archived: !o.archived_at } }),
        o.archived_at ? t('Organização restaurada') : t('Organização arquivada'));
      if (ok) await refresh(el);
    },
  });
  if (isAdmin()) {
    items.push({ divider: true }, {
      label: t('Excluir organização…'),
      icon: ICON.trash,
      danger: true,
      onClick: async () => {
        const yes = await confirmAction(t('Excluir a organização “{name}”? Os workspaces dela e os papéis dados nela são apagados. Só dá para excluir uma organização sem projetos.', { name: o.name }),
          { title: t('Excluir organização'), okLabel: t('Excluir') });
        if (yes && await attempt(() => api(`/api/organizations/${o.id}`, { method: 'DELETE' }), t('Organização excluída'))) await refresh(el);
      },
    });
  }
  showMenu(anchor, items, { align: 'right' });
}

function wsMenu(el, anchor, w) {
  const org = orgById(w.organization_id);
  const manage = org && canManageOrg(org);
  const open = openMembers.has(w.id);
  const items = [
    { label: t('Ver tarefas deste workspace'), icon: ICON.board, onClick: () => navigate({ projectId: null, workspaceId: w.id, view: 'board' }) },
    { label: open ? t('Esconder membros') : t('Ver membros'), icon: ICON.users, onClick: () => toggleMembers(el, w.id) },
  ];
  if (manage) {
    items.push(
      { divider: true },
      { label: t('Editar ou mover…'), icon: ICON.edit, onClick: () => wsDialog(el, { orgId: w.organization_id, ws: w }) },
      { label: t('Novo sub-workspace…'), icon: ICON.plus, onClick: () => wsDialog(el, { orgId: w.organization_id, parentId: w.id }) },
      {
        label: w.archived_at ? t('Restaurar workspace') : t('Arquivar workspace'),
        icon: ICON.archive,
        onClick: async () => {
          const ok = await attempt(() => api(`/api/workspaces/${w.id}`, { method: 'PATCH', body: { archived: !w.archived_at } }),
            w.archived_at ? t('Workspace restaurado') : t('Workspace arquivado'));
          if (ok) await refresh(el);
        },
      },
      { divider: true },
      {
        label: t('Excluir workspace…'),
        icon: ICON.trash,
        danger: true,
        onClick: async () => {
          const yes = await confirmAction(t('Excluir o workspace “{name}”? Os projetos e sub-workspaces dele passam para o workspace de cima (ou para outro workspace da organização), e os papéis dados nele são apagados.', { name: w.name }),
            { title: t('Excluir workspace'), okLabel: t('Excluir') });
          if (yes && await attempt(() => api(`/api/workspaces/${w.id}`, { method: 'DELETE' }), t('Workspace excluído'))) await refresh(el);
        },
      },
    );
  }
  showMenu(anchor, items, { align: anchor.classList.contains('ws-name') ? 'left' : 'right' });
}

function toggleMembers(el, wid) {
  if (openMembers.has(wid)) openMembers.delete(wid); else openMembers.add(wid);
  paint(el);
}

async function uploadAvatar(el, o) {
  const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
  if (!file) return;
  if (await attempt(() => uploadTo(`/api/organizations/${o.id}/avatar`, file), t('Imagem atualizada'))) await refresh(el);
}

async function removeAvatar(el, o) {
  // Corpo vazio apaga a imagem.
  const empty = new Blob([], { type: 'image/png' });
  if (await attempt(() => uploadTo(`/api/organizations/${o.id}/avatar`, empty, { name: 'avatar.png', type: 'image/png' }), t('Imagem removida'))) await refresh(el);
}

// Grava (ou tira, com role null) o papel de alguém num escopo.
async function setMember(el, holder, user, role) {
  const { scope, scopeId } = holder.dataset;
  const list = await attempt(() => api(`/api/${PATH[scope]}/${scopeId}/members`, { method: 'POST', body: { user, role } }),
    role ? t('Papel salvo') : t('Papel removido'));
  if (list) members.set(key(scope, Number(scopeId)), list);
  // O papel da própria pessoa muda o que ela pode fazer nos projetos.
  if (list && user === state.me?.id) await load();
  paint(el);
}

// ---------- eventos ----------

function bind(el) {
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    const d = b.dataset;
    if ('newOrg' in d) return orgDialog(el);
    if (d.orgMore) return orgMenu(el, b, orgById(Number(d.orgMore)));
    if (d.newWs) return wsDialog(el, { orgId: Number(d.newWs) });
    if (d.wsMenu) return wsMenu(el, b, workspaceById(Number(d.wsMenu)));
    if (d.wsMembers) return toggleMembers(el, Number(d.wsMembers));
    if (d.openProject) return navigate({ projectId: Number(d.openProject), view: 'board' });
    if (d.moveProject) return moveDialog(el, projectById(Number(d.moveProject)));
    if (d.memberRemove) return setMember(el, b.closest('[data-scope]'), Number(d.memberRemove), null);
  };
  el.onchange = (e) => {
    const sel = e.target.closest('[data-member-role]');
    if (sel) setMember(el, sel.closest('[data-scope]'), Number(sel.dataset.memberRole), sel.value);
  };
  el.onsubmit = (e) => {
    const form = e.target.closest('[data-form="add-member"]');
    if (!form) return;
    e.preventDefault();
    const user = Number(form.elements.user.value);
    if (!user) return toast(t('Escolha uma pessoa'), true);
    setMember(el, form.closest('[data-scope]'), user, form.elements.role.value);
  };
}
