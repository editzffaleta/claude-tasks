// Usuários, sessões, convites, redefinição de senha, preferências, avatares, responsáveis e notificações.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROLES, USER_ROLES, cleanEnum, cleanId, cleanText, fail, forbid, now } from '../util.js';

const SESSION_DAYS = 90;
const INVITE_DAYS = 14;
const RESET_HOURS = 2;
const USER_COLORS = ['#d97757', '#6f7ae0', '#2f9e6b', '#c9900e', '#b55fc4', '#3b9bd1', '#d64545', '#5d8a3a'];
const AVATAR_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

// Tipos de notificação e canais. Padrão: tudo no painel; e-mail desligado; macOS segue a configuração geral.
export const NOTIFY_TYPES = ['assigned', 'comment', 'mention', 'status', 'due', 'overdue', 'automation', 'claude', 'system'];
export const DEFAULT_USER_SETTINGS = {
  language: null,
  theme: 'system',
  default_view: 'board',
  single_keys: true,
  notify: Object.fromEntries(NOTIFY_TYPES.map((t) => [t, { app: true, email: false, os: true }])),
};

const daysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString();

function hashPassword(password) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(password, salt, 64).toString('hex')}`;
}

function checkPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

function cleanPassword(password) {
  if (typeof password !== 'string' || password.length < 8) fail('A senha precisa ter pelo menos 8 caracteres');
  return password;
}

function cleanEmail(email) {
  const e = cleanText(email, 'email', { required: true, max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) fail('E-mail inválido');
  return e;
}

const publicUser = (u) => u && {
  id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, avatar: u.avatar,
  disabled: !!u.disabled_at, created_at: u.created_at, last_seen_at: u.last_seen_at,
};

export const teamMethods = {
  hasUsers() {
    return !!this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
  },

  user(id) {
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  },

  listUsers({ include_disabled = false } = {}) {
    return this.db.prepare(`SELECT * FROM users ${include_disabled ? '' : 'WHERE disabled_at IS NULL'} ORDER BY name COLLATE NOCASE`).all().map(publicUser);
  },

  // Aceita id, e-mail ou nome (para o MCP: "atribuir ao Bruno").
  findUser(ref) {
    const s = String(ref ?? '').trim();
    if (!s) return null;
    const row = /^\d+$/.test(s)
      ? this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(s))
      : this.db.prepare(`SELECT * FROM users WHERE disabled_at IS NULL AND (lower(email) = lower(?) OR lower(name) = lower(?) OR lower(name) LIKE lower(?))
          ORDER BY lower(name) = lower(?) DESC LIMIT 1`).get(s, s, `${s} %`, s);
    return publicUser(row);
  },

  createUser({ name, email, password, role = 'member' }) {
    name = cleanText(name, 'name', { required: true, max: 80 });
    email = cleanEmail(email);
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail('Já existe uma conta com esse e-mail');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const r = this.transaction(() => this.db.prepare(`
      INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(name, email, hashPassword(cleanPassword(password)), cleanEnum(role, 'role', USER_ROLES) || 'member',
        USER_COLORS[count % USER_COLORS.length], now()));
    return this.user(Number(r.lastInsertRowid));
  },

  verifyLogin(email, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
    if (!row || !checkPassword(String(password || ''), row.password_hash)) fail('E-mail ou senha incorretos');
    if (row.disabled_at) forbid('Esta conta foi desativada. Fale com um administrador.');
    return publicUser(row);
  },

  updateUser(id, patch, by) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) fail('Usuário não encontrado');
    const self = by?.id === id;
    const admin = by?.role === 'admin';
    if (!self && !admin) forbid('Só administradores podem editar outros usuários');
    const fields = {};
    if (patch.name !== undefined) fields.name = cleanText(patch.name, 'name', { required: true, max: 80 });
    if (patch.color !== undefined) fields.color = patch.color || null;
    if (patch.email !== undefined) {
      fields.email = cleanEmail(patch.email);
      if (this.db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(fields.email, id)) fail('Já existe uma conta com esse e-mail');
    }
    const lastAdmin = row.role === 'admin' && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled_at IS NULL").get().n <= 1;
    if (patch.role !== undefined && patch.role !== row.role) {
      if (!admin) forbid('Só administradores mudam papéis');
      fields.role = cleanEnum(patch.role, 'role', USER_ROLES);
      if (lastAdmin) fail('É preciso ter ao menos um administrador');
    }
    if (patch.disabled !== undefined) {
      if (!admin) forbid('Só administradores desativam contas');
      if (self) fail('Você não pode desativar a própria conta');
      if (patch.disabled && lastAdmin) fail('É preciso ter ao menos um administrador ativo');
      fields.disabled_at = patch.disabled ? (row.disabled_at || now()) : null;
    }
    if (patch.password !== undefined) {
      if (self && !checkPassword(String(patch.current_password || ''), row.password_hash)) fail('Senha atual incorreta');
      if (!self && !admin) forbid();
      fields.password_hash = hashPassword(cleanPassword(patch.password));
    }
    const entries = Object.entries(fields);
    if (entries.length) {
      this.transaction(() => {
        this.db.prepare(`UPDATE users SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v), id);
        if (fields.disabled_at || fields.password_hash) this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND ? = 0').run(id, self ? 1 : 0);
      });
    }
    return this.user(id);
  },

  deleteUser(id, by) {
    if (by?.role !== 'admin') forbid('Só administradores removem usuários');
    const row = this.user(id);
    if (!row) fail('Usuário não encontrado');
    if (row.role === 'admin' && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n <= 1) {
      fail('É preciso ter ao menos um administrador');
    }
    this.transaction(() => this.db.prepare('DELETE FROM users WHERE id = ?').run(id));
    if (row.avatar) this._removeAvatar(row.avatar);
  },

  // ---- sessões ----

  createSession(user_id) {
    const token = randomBytes(32).toString('base64url');
    this.transaction(() => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
      this.db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(token, user_id, now(), daysFromNow(SESSION_DAYS));
    });
    return token;
  },

  sessionUser(token) {
    if (!token) return null;
    const row = this.db.prepare(`
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ? AND s.expires_at > ? AND u.disabled_at IS NULL`).get(token, now());
    if (!row) return null;
    // Atualiza "visto por último" no máximo a cada 10 min para não gravar a cada requisição.
    if (!row.last_seen_at || Date.now() - Date.parse(row.last_seen_at) > 600000) {
      this.db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now(), row.id);
    }
    return publicUser(row);
  },

  deleteSession(token) {
    this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  },

  // ---- redefinição de senha ----

  createPasswordReset(user_id) {
    const user = this.user(user_id);
    if (!user) fail('Usuário não encontrado');
    if (user.disabled) fail('Conta desativada: reative antes de gerar o link de senha');
    const token = randomBytes(24).toString('base64url');
    this.transaction(() => this.db.prepare('INSERT INTO password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(token, user_id, now(), new Date(Date.now() + RESET_HOURS * 3600000).toISOString()));
    return { token, user, expires_in_hours: RESET_HOURS };
  },

  passwordReset(token) {
    const r = this.db.prepare('SELECT * FROM password_resets WHERE token = ?').get(String(token || ''));
    if (!r || r.used_at || r.expires_at < now()) fail('Link de redefinição inválido ou expirado');
    return r;
  },

  resetPassword(token, password) {
    const r = this.passwordReset(token);
    this.transaction(() => {
      this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(cleanPassword(password)), r.user_id);
      this.db.prepare('UPDATE password_resets SET used_at = ? WHERE token = ?').run(now(), token);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(r.user_id);
    });
    return this.user(r.user_id);
  },

  // ---- preferências por usuário ----

  userSettings(user_id) {
    const rows = user_id ? this.db.prepare('SELECT key, value FROM user_settings WHERE user_id = ?').all(user_id) : [];
    const saved = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]));
    // Cópia profunda: updateUserSettings altera o objeto devolvido.
    const notify = Object.fromEntries(Object.entries(DEFAULT_USER_SETTINGS.notify).map(([k, v]) => [k, { ...v }]));
    for (const [type, ch] of Object.entries(saved.notify || {})) if (notify[type]) notify[type] = { ...notify[type], ...ch };
    return { ...DEFAULT_USER_SETTINGS, ...saved, notify };
  },

  updateUserSettings(user_id, patch) {
    const clean = {};
    if (patch.language !== undefined) clean.language = cleanEnum(patch.language, 'language', ['pt', 'en', 'es', 'fr', 'de']) ?? null;
    if (patch.theme !== undefined) clean.theme = cleanEnum(patch.theme, 'theme', ['system', 'light', 'dark']) || 'system';
    if (patch.default_view !== undefined) clean.default_view = cleanEnum(patch.default_view, 'default_view', ['board', 'list', 'calendar', 'gantt', 'dashboard']) || 'board';
    if (patch.single_keys !== undefined) clean.single_keys = !!patch.single_keys;
    if (patch.notify !== undefined) {
      const current = this.userSettings(user_id).notify;
      for (const [type, ch] of Object.entries(patch.notify || {})) {
        if (!current[type]) continue;
        for (const k of ['app', 'email', 'os']) if (ch[k] !== undefined) current[type][k] = !!ch[k];
      }
      clean.notify = current;
    }
    this.transaction(() => {
      for (const [key, value] of Object.entries(clean)) {
        this.db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, ?, ?)
          ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`).run(user_id, key, JSON.stringify(value));
      }
    });
    return this.userSettings(user_id);
  },

  // ---- avatares (usuário, projeto, organização) ----

  avatarPath(file) {
    return join(this.avatarDir, String(file).replace(/[^\w.-]/g, ''));
  },

  _removeAvatar(file) {
    try { unlinkSync(this.avatarPath(file)); } catch {}
  },

  setAvatar(kind, id, { data, mime } = {}) {
    const table = { user: 'users', project: 'projects', organization: 'organizations' }[kind] || fail('Tipo de avatar inválido');
    const row = this.db.prepare(`SELECT avatar FROM ${table} WHERE id = ?`).get(id);
    if (!row) fail('Não encontrado');
    let file = null;
    if (data?.length) {
      const ext = AVATAR_TYPES[mime] || fail('Use uma imagem PNG, JPEG, WebP ou GIF');
      if (data.length > 2 * 1024 * 1024) fail('Imagem maior que 2 MB');
      mkdirSync(this.avatarDir, { recursive: true });
      file = `${kind}-${id}-${Date.now()}${ext}`;
      writeFileSync(this.avatarPath(file), data);
    }
    this.transaction(() => this.db.prepare(`UPDATE ${table} SET avatar = ? WHERE id = ?`).run(file, id));
    if (row.avatar) this._removeAvatar(row.avatar);
    return file;
  },

  // ---- convites ----

  createInvite({ email, role = 'member', project_id = null, project_role = null }, by) {
    if (by?.role !== 'admin') forbid('Só administradores convidam pessoas');
    if (project_id && !this.project(project_id)) fail('Projeto não encontrado');
    const token = randomBytes(24).toString('base64url');
    this.transaction(() => this.db.prepare(`
      INSERT INTO invites (token, email, role, project_id, project_role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(token, email ? cleanEmail(email) : null, cleanEnum(role, 'role', USER_ROLES) || 'member', project_id || null,
        project_id ? (cleanEnum(project_role, 'project_role', ROLES) || 'member') : null, by.id, now(), daysFromNow(INVITE_DAYS)));
    return this.invite(token);
  },

  invite(token) {
    return this.db.prepare('SELECT i.*, p.name AS project_name FROM invites i LEFT JOIN projects p ON p.id = i.project_id WHERE token = ?').get(token);
  },

  validInvite(token) {
    const inv = this.invite(String(token || ''));
    if (!inv || inv.used_at || inv.expires_at < now()) fail('Convite inválido ou expirado');
    return inv;
  },

  listInvites() {
    return this.db.prepare(`
      SELECT i.*, u.name AS created_by_name, p.name AS project_name FROM invites i
      LEFT JOIN users u ON u.id = i.created_by LEFT JOIN projects p ON p.id = i.project_id
      WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`).all(now());
  },

  acceptInvite(token, { name, email, password }) {
    const inv = this.validInvite(token);
    return this.transaction(() => {
      const user = this.createUser({ name, email: inv.email || email, password, role: inv.role });
      if (inv.project_id) this.setMember('project', inv.project_id, user.id, inv.project_role || 'member');
      this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token = ?').run(now(), user.id, token);
      return user;
    });
  },

  revokeInvite(token, by) {
    if (by?.role !== 'admin') forbid('Só administradores revogam convites');
    this.transaction(() => this.db.prepare('DELETE FROM invites WHERE token = ?').run(token));
  },

  // ---- responsáveis ----

  assigneesOf(task_id) {
    return this.db.prepare('SELECT u.* FROM assignees a JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY u.name')
      .all(task_id).map(publicUser);
  },

  // Substitui a lista. Aceita ids, e-mails ou nomes.
  setAssignees(task_id, refs, by) {
    const list = Array.isArray(refs) ? refs : String(refs).split(',');
    const ids = [...new Set(list.filter((r) => String(r).trim()).map((r) => {
      const u = this.findUser(r);
      if (!u) fail(`Usuário "${r}" não encontrado`);
      return u.id;
    }))];
    this.transaction(() => {
      const before = new Set(this.db.prepare('SELECT user_id FROM assignees WHERE task_id = ?').all(task_id).map((r) => r.user_id));
      this.db.prepare('DELETE FROM assignees WHERE task_id = ?').run(task_id);
      const insert = this.db.prepare('INSERT INTO assignees (task_id, user_id) VALUES (?, ?)');
      for (const id of ids) insert.run(task_id, id);
      const added = ids.filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !ids.includes(id));
      const name = (id) => this.user(id)?.name;
      if (added.length) this.logEvent(task_id, by, `atribuída a ${added.map(name).join(', ')}`);
      if (removed.length) this.logEvent(task_id, by, `${removed.map(name).join(', ')} removido(s)`);
      for (const user_id of added) this.queue('task.assigned', { task_id, user_id, actor: by });
    });
  },

  // ---- notificações ----
  // user_ids null = todos (ou o modo sem contas). key evita duplicar o mesmo aviso.
  // Cada pessoa escolhe por tipo os canais: painel (app), e-mail e macOS (os).

  notify({ user_ids = null, task_id = null, body, key = null, type = 'system' }) {
    const targets = user_ids ?? (this.hasUsers() ? this.listUsers().map((u) => u.id) : [null]);
    const delivered = [];
    this.transaction(() => {
      for (const user_id of targets) {
        if (key && this.db.prepare('SELECT 1 FROM notifications WHERE key = ? AND user_id IS ?').get(key, user_id)) continue;
        const prefs = this.userSettings(user_id).notify[type] || { app: true, email: false, os: true };
        // Com o canal "no painel" desligado, avisos com chave (prazo, atraso) ficam guardados
        // escondidos: sem isso o e-mail/macOS se repetiria a cada minuto.
        if (prefs.app || key) {
          this.db.prepare('INSERT INTO notifications (user_id, task_id, key, body, type, hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(user_id, task_id, key, body, type, prefs.app ? 0 : 1, now());
        }
        delivered.push({ user_id, email: prefs.email, os: prefs.os });
      }
    });
    if (delivered.length) this.emit('notification', { task_id, body, type, delivered });
    return delivered.length;
  },

  notifications(user_id, { limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT n.*, t.title AS task_title, t.project_id FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id
      WHERE n.user_id IS ? AND n.hidden = 0 ORDER BY n.created_at DESC, n.id DESC LIMIT ?`).all(user_id ?? null, limit);
  },

  unreadCount(user_id) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id IS ? AND read_at IS NULL AND hidden = 0').get(user_id ?? null).n;
  },

  markRead(user_id, ids) {
    this.transaction(() => {
      if (ids === 'all') this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id IS ? AND read_at IS NULL').run(now(), user_id ?? null);
      else for (const id of ids) this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id IS ?').run(now(), cleanId(id), user_id ?? null);
    });
  },
};
