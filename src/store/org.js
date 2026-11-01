// Organizações, workspaces (aninháveis), membros com papel por escopo, permissões,
// links públicos e comandos para o painel.
import { randomBytes } from 'node:crypto';
import { ROLES, ROLE_LABEL, cleanColor, cleanEnum, cleanId, cleanText, fail, forbid, now } from '../util.js';

const RANK = { viewer: 1, member: 2, manager: 3, owner: 4 };
const LEVEL = { read: 1, edit: 2, manage: 3, own: 4 };
const LEVEL_MSG = {
  read: 'Você não tem acesso a este projeto',
  edit: 'Seu papel neste projeto é só de leitura',
  manage: 'Só gerentes e donos do projeto podem fazer isso',
  own: 'Só donos do projeto podem fazer isso',
};
const best = (roles) => roles.filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0] || null;
const SCOPES = ['organization', 'workspace', 'project'];

export const orgMethods = {
  // ---- organizações ----

  organizations() {
    return this.db.prepare(`
      SELECT o.*,
        (SELECT COUNT(*) FROM workspaces w WHERE w.organization_id = o.id) AS workspace_count,
        (SELECT COUNT(*) FROM projects p JOIN workspaces w ON w.id = p.workspace_id WHERE w.organization_id = o.id) AS project_count
      FROM organizations o ORDER BY o.archived_at IS NOT NULL, o.id`).all();
  },

  organization(id) {
    return this.db.prepare('SELECT * FROM organizations WHERE id = ?').get(id);
  },

  createOrganization(input) {
    return this.transaction(() => {
      const r = this.db.prepare('INSERT INTO organizations (name, description, website, color, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(cleanText(input.name, 'name', { required: true, max: 120 }), cleanText(input.description, 'description') || '',
          cleanText(input.website, 'website', { max: 300 }) || null, cleanColor(input.color) ?? null, now());
      const id = Number(r.lastInsertRowid);
      this.db.prepare('INSERT INTO workspaces (organization_id, name, created_at) VALUES (?, ?, ?)').run(id, 'Geral', now());
      return this.organization(id);
    });
  },

  updateOrganization(id, patch) {
    const o = this.organization(id);
    if (!o) fail('Organização não encontrada');
    const fields = {
      name: patch.name === undefined ? undefined : cleanText(patch.name, 'name', { required: true, max: 120 }),
      description: cleanText(patch.description, 'description'),
      website: patch.website === undefined ? undefined : (cleanText(patch.website, 'website', { max: 300 }) || null),
      color: cleanColor(patch.color),
      archived_at: patch.archived === undefined ? undefined : (patch.archived ? (o.archived_at || now()) : null),
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length) {
      this.transaction(() => this.db.prepare(`UPDATE organizations SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => v), id));
    }
    return this.organization(id);
  },

  deleteOrganization(id) {
    const o = this.organizations().find((x) => x.id === id);
    if (!o) fail('Organização não encontrada');
    if (this.organizations().length <= 1) fail('É preciso manter ao menos uma organização');
    if (o.project_count) fail('Mova ou exclua os projetos dessa organização antes');
    this.transaction(() => {
      this.db.prepare("DELETE FROM memberships WHERE scope = 'organization' AND scope_id = ?").run(id);
      // Os workspaces somem em cascata; os papéis neles não (memberships não tem chave estrangeira).
      this.db.prepare("DELETE FROM memberships WHERE scope = 'workspace' AND scope_id IN (SELECT id FROM workspaces WHERE organization_id = ?)").run(id);
      this.db.prepare('DELETE FROM organizations WHERE id = ?').run(id);
    });
  },

  // ---- workspaces ----

  workspaces(organization_id) {
    return this.db.prepare(`
      SELECT w.*, (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS project_count
      FROM workspaces w ${organization_id ? 'WHERE w.organization_id = ?' : ''}
      ORDER BY w.organization_id, w.position, w.name COLLATE NOCASE`).all(...(organization_id ? [organization_id] : []));
  },

  workspace(id) {
    return this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  },

  // O workspace e os ancestrais dele (mais próximo primeiro).
  workspaceChain(id) {
    const chain = [];
    for (let w = this.workspace(id); w && chain.length < 20; w = w.parent_id ? this.workspace(w.parent_id) : null) chain.push(w.id);
    return chain;
  },

  createWorkspace(input) {
    const organization_id = cleanId(input.organization_id ?? 1, 'organization_id');
    if (!this.organization(organization_id)) fail('Organização não encontrada');
    let parent_id = null;
    if (input.parent_id) {
      const parent = this.workspace(cleanId(input.parent_id, 'parent_id'));
      if (!parent || parent.organization_id !== organization_id) fail('Workspace-pai inválido');
      parent_id = parent.id;
    }
    const r = this.transaction(() => this.db.prepare(`
      INSERT INTO workspaces (organization_id, parent_id, name, description, color, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(organization_id, parent_id, cleanText(input.name, 'name', { required: true, max: 120 }),
        cleanText(input.description, 'description') || '', cleanColor(input.color) ?? null, now()));
    return this.workspace(Number(r.lastInsertRowid));
  },

  updateWorkspace(id, patch) {
    const w = this.workspace(id);
    if (!w) fail('Workspace não encontrado');
    const fields = {
      name: patch.name === undefined ? undefined : cleanText(patch.name, 'name', { required: true, max: 120 }),
      description: cleanText(patch.description, 'description'),
      color: cleanColor(patch.color),
      position: patch.position == null ? undefined : Number(patch.position),
      archived_at: patch.archived === undefined ? undefined : (patch.archived ? (w.archived_at || now()) : null),
    };
    if (patch.parent_id !== undefined) {
      if (!patch.parent_id) fields.parent_id = null;
      else {
        const parent = this.workspace(cleanId(patch.parent_id, 'parent_id'));
        if (!parent || parent.organization_id !== w.organization_id) fail('Workspace-pai inválido');
        if (this.workspaceChain(parent.id).includes(id)) fail('Um workspace não pode ficar dentro dele mesmo');
        fields.parent_id = parent.id;
      }
    }
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length) {
      this.transaction(() => this.db.prepare(`UPDATE workspaces SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => v), id));
    }
    return this.workspace(id);
  },

  // Projetos e sub-workspaces sobem para o pai (ou para outro workspace da organização).
  deleteWorkspace(id) {
    const w = this.workspace(id);
    if (!w) fail('Workspace não encontrado');
    const target = w.parent_id
      ?? this.db.prepare('SELECT id FROM workspaces WHERE organization_id = ? AND id != ? AND parent_id IS NOT ? ORDER BY parent_id IS NOT NULL, id LIMIT 1')
        .get(w.organization_id, id, id)?.id;
    const hasContent = this.db.prepare('SELECT 1 FROM projects WHERE workspace_id = ? UNION SELECT 1 FROM workspaces WHERE parent_id = ?').get(id, id);
    if (hasContent && !target) fail('Esse é o único workspace da organização: crie outro antes de excluir este');
    this.transaction(() => {
      this.db.prepare('UPDATE projects SET workspace_id = ? WHERE workspace_id = ?').run(target ?? null, id);
      this.db.prepare('UPDATE workspaces SET parent_id = ? WHERE parent_id = ?').run(w.parent_id, id);
      this.db.prepare("DELETE FROM memberships WHERE scope = 'workspace' AND scope_id = ?").run(id);
      this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
    });
  },

  // ---- membros ----

  members(scope, scope_id) {
    cleanEnum(scope, 'scope', SCOPES);
    return this.db.prepare(`
      SELECT u.id, u.name, u.email, u.color, u.avatar, u.role AS account_role, m.role, m.created_at
      FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.scope = ? AND m.scope_id = ? ORDER BY u.name`).all(scope, scope_id);
  },

  // role null remove a pessoa do escopo.
  setMember(scope, scope_id, user_ref, role) {
    cleanEnum(scope, 'scope', SCOPES);
    const user = this.findUser(user_ref);
    if (!user) fail(`Usuário "${user_ref}" não encontrado`);
    const exists = { organization: 'organizations', workspace: 'workspaces', project: 'projects' }[scope];
    if (!this.db.prepare(`SELECT 1 FROM ${exists} WHERE id = ?`).get(scope_id)) fail('Escopo não encontrado');
    this.transaction(() => {
      if (!role) this.db.prepare('DELETE FROM memberships WHERE scope = ? AND scope_id = ? AND user_id = ?').run(scope, scope_id, user.id);
      else {
        this.db.prepare(`
          INSERT INTO memberships (scope, scope_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(scope, scope_id, user_id) DO UPDATE SET role = excluded.role`)
          .run(scope, scope_id, user.id, cleanEnum(role, 'role', ROLES), now());
      }
    });
    return this.members(scope, scope_id);
  },

  // ---- permissões ----
  // Papel efetivo num projeto: o maior entre projeto, workspaces (e ancestrais) e organização.
  // Sem papel explícito: projetos privados ficam invisíveis; nos demais vale o papel da conta.
  // user null = processo local (MCP, hook): acesso total.

  projectRole(user, project) {
    if (!user || user.role === 'admin') return 'owner';
    const p = typeof project === 'object' ? project : this.project(project);
    if (!p) return null;
    const role = (scope, id) => this.db.prepare('SELECT role FROM memberships WHERE scope = ? AND scope_id = ? AND user_id = ?').get(scope, id, user.id)?.role;
    const roles = [role('project', p.id)];
    if (p.workspace_id) {
      for (const wid of this.workspaceChain(p.workspace_id)) roles.push(role('workspace', wid));
      const ws = this.workspace(p.workspace_id);
      if (ws) roles.push(role('organization', ws.organization_id));
    }
    const explicit = best(roles);
    // Conta de visualizador só lê, mesmo com papel maior num projeto.
    if (explicit) return user.role === 'viewer' ? 'viewer' : explicit;
    if (p.visibility === 'private') return null;
    return user.role === 'viewer' ? 'viewer' : 'member';
  },

  can(user, project, level = 'read') {
    const role = this.projectRole(user, project);
    return !!role && RANK[role] >= LEVEL[level];
  },

  assertCan(user, project, level = 'read') {
    if (!this.can(user, project, level)) forbid(LEVEL_MSG[level]);
  },

  // Dar ou tirar o papel de dono exige ser dono: do projeto, ou da organização (para
  // papéis na organização e nos workspaces dela). Administradores sempre podem.
  assertOwnerChange(user, scope, scope_id, user_ref, role) {
    if (!user || user.role === 'admin') return;
    const target = this.findUser(user_ref);
    const current = target && this.db.prepare('SELECT role FROM memberships WHERE scope = ? AND scope_id = ? AND user_id = ?').get(scope, scope_id, target.id)?.role;
    if (role !== 'owner' && current !== 'owner') return;
    const org = scope === 'organization' ? scope_id : scope === 'workspace' ? this.workspace(scope_id)?.organization_id : null;
    const isOwner = scope === 'project'
      ? this.can(user, scope_id, 'own')
      : this.db.prepare("SELECT role FROM memberships WHERE scope = 'organization' AND scope_id = ? AND user_id = ?").get(org, user.id)?.role === 'owner';
    if (!isOwner) forbid('Só donos podem dar ou tirar o papel de dono');
  },

  assertTask(user, task_id, level = 'read') {
    const t = this.db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(task_id);
    if (!t) fail(`Tarefa #${task_id} não encontrada`);
    this.assertCan(user, t.project_id, level);
    return t.project_id;
  },

  // undefined = todos (admin ou processo local).
  visibleProjectIds(user) {
    if (!user || user.role === 'admin') return undefined;
    return this.db.prepare('SELECT * FROM projects').all().filter((p) => this.projectRole(user, p)).map((p) => p.id);
  },

  // Gerenciar organização/workspaces: administradores ou donos/gerentes da organização.
  canManageOrg(user, organization_id) {
    if (!user || user.role === 'admin') return true;
    const r = this.db.prepare("SELECT role FROM memberships WHERE scope = 'organization' AND scope_id = ? AND user_id = ?").get(organization_id, user.id)?.role;
    return r === 'owner' || r === 'manager';
  },

  roleLabel: (role) => ROLE_LABEL[role] || role,

  // ---- links públicos (somente leitura) ----

  createShare(kind, target_id, { days = null } = {}, by) {
    cleanEnum(kind, 'kind', ['task', 'project']);
    const exists = kind === 'task' ? this.task(target_id) : this.project(target_id);
    if (!exists) fail(kind === 'task' ? 'Tarefa não encontrada' : 'Projeto não encontrado');
    const token = randomBytes(18).toString('base64url');
    const n = days == null || days === '' ? null : Math.round(Number(days));
    if (n != null && !(n >= 1 && n <= 3650)) fail('Validade deve ser de 1 a 3650 dias');
    const expires = n ? new Date(Date.now() + n * 86400000).toISOString() : null;
    this.transaction(() => this.db.prepare('INSERT INTO shares (token, kind, target_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(token, kind, target_id, by?.user_id ?? by?.id ?? null, now(), expires));
    return this.db.prepare('SELECT * FROM shares WHERE token = ?').get(token);
  },

  shares(kind, target_id) {
    return this.db.prepare(`
      SELECT s.*, u.name AS created_by_name FROM shares s LEFT JOIN users u ON u.id = s.created_by
      WHERE s.kind = ? AND s.target_id = ? AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > ?)
      ORDER BY s.created_at DESC`).all(kind, target_id, now());
  },

  share(token) {
    const s = this.db.prepare('SELECT * FROM shares WHERE token = ?').get(String(token || ''));
    if (!s || s.revoked_at || (s.expires_at && s.expires_at < now())) return null;
    return s;
  },

  revokeShare(token) {
    const r = this.transaction(() => this.db.prepare('UPDATE shares SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL').run(now(), token));
    if (!r.changes) fail('Link não encontrado');
  },

  // ---- comandos para o painel (ex.: "abra a tarefa 12 na tela") ----

  pushUiCommand(user_id, command) {
    this.transaction(() => this.db.prepare('INSERT INTO ui_commands (user_id, command, created_at) VALUES (?, ?, ?)')
      .run(user_id ?? null, JSON.stringify(command), now()));
  },

  takeUiCommands(user_id) {
    const since = new Date(Date.now() - 2 * 60000).toISOString();
    const rows = this.db.prepare('SELECT * FROM ui_commands WHERE consumed_at IS NULL AND (user_id IS ? OR user_id IS NULL) AND created_at > ? ORDER BY id')
      .all(user_id ?? null, since);
    if (rows.length) {
      this.db.prepare(`UPDATE ui_commands SET consumed_at = ? WHERE id IN (${rows.map((r) => r.id).join(',')})`).run(now());
      this.writes++;
    }
    return rows.map((r) => JSON.parse(r.command));
  },
};
