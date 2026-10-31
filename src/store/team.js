// Usuários, sessões de login, convites, responsáveis e notificações.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { cleanEnum, cleanId, cleanText, fail, now } from '../util.js';

const SESSION_DAYS = 90;
const INVITE_DAYS = 14;
const USER_COLORS = ['#d97757', '#6f7ae0', '#2f9e6b', '#c9900e', '#b55fc4', '#3b9bd1', '#d64545', '#5d8a3a'];

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

const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, color: u.color, created_at: u.created_at, last_seen_at: u.last_seen_at };

export const teamMethods = {
  hasUsers() {
    return !!this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
  },

  user(id) {
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  },

  listUsers() {
    return this.db.prepare('SELECT * FROM users ORDER BY name COLLATE NOCASE').all().map(publicUser);
  },

  // Aceita id, e-mail ou nome (para o MCP: "atribuir ao Bruno").
  findUser(ref) {
    const s = String(ref).trim();
    const row = /^\d+$/.test(s)
      ? this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(s))
      : this.db.prepare('SELECT * FROM users WHERE lower(email) = lower(?) OR lower(name) = lower(?) OR lower(name) LIKE lower(?) ORDER BY lower(name) = lower(?) DESC LIMIT 1')
        .get(s, s, `${s} %`, s);
    return publicUser(row);
  },

  createUser({ name, email, password, role = 'member' }) {
    name = cleanText(name, 'name', { required: true, max: 80 });
    email = cleanEmail(email);
    if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail('Já existe uma conta com esse e-mail');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const r = this.transaction(() => this.db.prepare(`
      INSERT INTO users (name, email, password_hash, role, color, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(name, email, hashPassword(cleanPassword(password)), cleanEnum(role, 'role', ['admin', 'member']) || 'member',
        USER_COLORS[count % USER_COLORS.length], now()));
    return this.user(Number(r.lastInsertRowid));
  },

  verifyLogin(email, password) {
    const row = this.db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
    if (!row || !checkPassword(String(password || ''), row.password_hash)) fail('E-mail ou senha incorretos');
    return publicUser(row);
  },

  updateUser(id, patch, by) {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!row) fail('Usuário não encontrado');
    const self = by?.id === id;
    if (!self && by?.role !== 'admin') fail('Só administradores podem editar outros usuários');
    const fields = {};
    if (patch.name !== undefined) fields.name = cleanText(patch.name, 'name', { required: true, max: 80 });
    if (patch.color !== undefined) fields.color = patch.color || null;
    if (patch.email !== undefined) {
      fields.email = cleanEmail(patch.email);
      if (this.db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(fields.email, id)) fail('Já existe uma conta com esse e-mail');
    }
    if (patch.role !== undefined && patch.role !== row.role) {
      if (by?.role !== 'admin') fail('Só administradores mudam papéis');
      fields.role = cleanEnum(patch.role, 'role', ['admin', 'member']);
      if (row.role === 'admin' && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n <= 1) {
        fail('É preciso ter ao menos um administrador');
      }
    }
    if (patch.password !== undefined) {
      if (self && !checkPassword(String(patch.current_password || ''), row.password_hash)) fail('Senha atual incorreta');
      fields.password_hash = hashPassword(cleanPassword(patch.password));
    }
    const entries = Object.entries(fields);
    if (entries.length) {
      this.transaction(() => this.db.prepare(`UPDATE users SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => v), id));
    }
    return this.user(id);
  },

  deleteUser(id, by) {
    if (by?.role !== 'admin') fail('Só administradores removem usuários');
    const row = this.user(id);
    if (!row) fail('Usuário não encontrado');
    if (row.role === 'admin' && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n <= 1) {
      fail('É preciso ter ao menos um administrador');
    }
    this.transaction(() => this.db.prepare('DELETE FROM users WHERE id = ?').run(id));
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
      SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`).get(token, now());
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

  // ---- convites ----

  createInvite({ email, role = 'member' }, by) {
    if (by?.role !== 'admin') fail('Só administradores convidam pessoas');
    const token = randomBytes(24).toString('base64url');
    this.transaction(() => this.db.prepare(`
      INSERT INTO invites (token, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(token, email ? cleanEmail(email) : null, cleanEnum(role, 'role', ['admin', 'member']) || 'member', by.id, now(), daysFromNow(INVITE_DAYS)));
    return this.invite(token);
  },

  invite(token) {
    return this.db.prepare('SELECT * FROM invites WHERE token = ?').get(token);
  },

  validInvite(token) {
    const inv = this.invite(String(token || ''));
    if (!inv || inv.used_at || inv.expires_at < now()) fail('Convite inválido ou expirado');
    return inv;
  },

  listInvites() {
    return this.db.prepare(`
      SELECT i.*, u.name AS created_by_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
      WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC`).all(now());
  },

  acceptInvite(token, { name, email, password }) {
    const inv = this.validInvite(token);
    return this.transaction(() => {
      const user = this.createUser({ name, email: inv.email || email, password, role: inv.role });
      this.db.prepare('UPDATE invites SET used_at = ?, used_by = ? WHERE token = ?').run(now(), user.id, token);
      return user;
    });
  },

  revokeInvite(token, by) {
    if (by?.role !== 'admin') fail('Só administradores revogam convites');
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
  // user_id null = todos (ou o modo sem contas). key evita duplicar o mesmo aviso.

  notify({ user_ids = null, task_id = null, body, key = null }) {
    const targets = user_ids ?? (this.hasUsers() ? this.listUsers().map((u) => u.id) : [null]);
    let created = 0;
    this.transaction(() => {
      for (const user_id of targets) {
        if (key && this.db.prepare('SELECT 1 FROM notifications WHERE key = ? AND user_id IS ?').get(key, user_id)) continue;
        this.db.prepare('INSERT INTO notifications (user_id, task_id, key, body, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(user_id, task_id, key, body, now());
        created++;
      }
    });
    if (created) this.emit('notification', { task_id, body });
    return created;
  },

  notifications(user_id, { limit = 50 } = {}) {
    return this.db.prepare(`
      SELECT n.*, t.title AS task_title, t.project_id FROM notifications n LEFT JOIN tasks t ON t.id = n.task_id
      WHERE n.user_id IS ? ORDER BY n.created_at DESC, n.id DESC LIMIT ?`).all(user_id ?? null, limit);
  },

  unreadCount(user_id) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id IS ? AND read_at IS NULL').get(user_id ?? null).n;
  },

  markRead(user_id, ids) {
    this.transaction(() => {
      if (ids === 'all') this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id IS ? AND read_at IS NULL').run(now(), user_id ?? null);
      else for (const id of ids) this.db.prepare('UPDATE notifications SET read_at = ? WHERE id = ? AND user_id IS ?').run(now(), cleanId(id), user_id ?? null);
    });
  },
};
