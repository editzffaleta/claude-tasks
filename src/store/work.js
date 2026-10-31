// Controle de tempo e anexos.
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { cleanDate, cleanText, fail, now, parseDuration, today } from '../util.js';

const MAX_ATTACHMENT = 25 * 1024 * 1024;

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.log': 'text/plain',
  '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
};

export const mimeFor = (name) => MIME[extname(name).toLowerCase()] || 'application/octet-stream';

const actorFields = (by) => {
  const a = typeof by === 'string' ? { author: by } : by || { author: 'claude' };
  return [a.author, a.user_id ?? null];
};

export const workMethods = {
  // ---- tempo ----

  timeEntries(task_id) {
    return this.db.prepare(`
      SELECT e.*, u.name AS user_name, u.color AS user_color,
        COALESCE(e.minutes, (unixepoch('now') - unixepoch(e.started_at)) / 60) AS duration
      FROM time_entries e LEFT JOIN users u ON u.id = e.user_id
      WHERE e.task_id = ? ORDER BY e.started_at DESC, e.id DESC`).all(task_id);
  },

  runningTimers(user_id) {
    return this.db.prepare(`
      SELECT e.*, t.title AS task_title, t.project_id FROM time_entries e JOIN tasks t ON t.id = e.task_id
      WHERE e.ended_at IS NULL AND e.user_id IS ? ORDER BY e.started_at`).all(user_id ?? null);
  },

  // Um timer por pessoa: iniciar um novo para o anterior.
  startTimer(task_id, by) {
    if (!this.task(task_id)) fail(`Tarefa #${task_id} não encontrada`);
    const [author, user_id] = actorFields(by);
    return this.transaction(() => {
      for (const t of this.runningTimers(user_id)) this.stopTimer(t.id);
      const r = this.db.prepare('INSERT INTO time_entries (task_id, user_id, author, started_at, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(task_id, user_id, author, now(), now());
      return Number(r.lastInsertRowid);
    });
  },

  stopTimer(entry_id) {
    const e = this.db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entry_id);
    if (!e) fail('Registro de tempo não encontrado');
    if (e.ended_at) return e;
    const minutes = Math.max(1, Math.round((Date.now() - Date.parse(e.started_at)) / 60000));
    this.transaction(() => this.db.prepare('UPDATE time_entries SET ended_at = ?, minutes = ? WHERE id = ?').run(now(), minutes, entry_id));
    return this.db.prepare('SELECT * FROM time_entries WHERE id = ?').get(entry_id);
  },

  stopTaskTimers(task_id, by) {
    const [, user_id] = actorFields(by);
    for (const e of this.db.prepare('SELECT id FROM time_entries WHERE task_id = ? AND ended_at IS NULL AND user_id IS ?').all(task_id, user_id)) {
      this.stopTimer(e.id);
    }
  },

  logTime(task_id, { minutes, duration, date, note }, by) {
    if (!this.task(task_id)) fail(`Tarefa #${task_id} não encontrada`);
    const total = parseDuration(minutes ?? duration, 'duração');
    if (!total) fail('Informe a duração (ex.: 45m, 1h30m)');
    const day = cleanDate(date, 'date') || today();
    const started = new Date(`${day}T12:00:00`).toISOString();
    const [author, user_id] = actorFields(by);
    const r = this.transaction(() => this.db.prepare(`
      INSERT INTO time_entries (task_id, user_id, author, started_at, ended_at, minutes, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(task_id, user_id, author, started, started, total, cleanText(note, 'note', { max: 500 }) || '', now()));
    return Number(r.lastInsertRowid);
  },

  deleteTimeEntry(id) {
    const r = this.transaction(() => this.db.prepare('DELETE FROM time_entries WHERE id = ?').run(id));
    if (!r.changes) fail('Registro de tempo não encontrado');
  },

  // ---- anexos ----

  attachments(task_id) {
    return this.db.prepare(`
      SELECT a.id, a.task_id, a.name, a.mime, a.size, a.author, a.user_id, a.created_at, u.name AS user_name
      FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.task_id = ? ORDER BY a.created_at, a.id`).all(task_id);
  },

  attachment(id) {
    return this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id);
  },

  attachmentPath(row) {
    return join(this.attachDir, row.stored);
  },

  addAttachment(task_id, { name, data, mime }, by) {
    if (!this.task(task_id)) fail(`Tarefa #${task_id} não encontrada`);
    if (!data?.length) fail('Arquivo vazio');
    if (data.length > MAX_ATTACHMENT) fail('Arquivo maior que 25 MB');
    const clean = basename(cleanText(name, 'name', { required: true, max: 200 })).replace(/[^\p{L}\p{N}._ -]+/gu, '_') || 'arquivo';
    const stored = `${task_id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extname(clean).toLowerCase()}`;
    mkdirSync(this.attachDir, { recursive: true });
    writeFileSync(join(this.attachDir, stored), data);
    const [author, user_id] = actorFields(by);
    const r = this.transaction(() => {
      const res = this.db.prepare(`
        INSERT INTO attachments (task_id, name, stored, mime, size, author, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task_id, clean, stored, mime || mimeFor(clean), data.length, author, user_id, now());
      this.logEvent(task_id, by, `anexou ${clean}`);
      return res;
    });
    return this.attachment(Number(r.lastInsertRowid));
  },

  // Para o MCP: anexar um arquivo do disco (print, log, relatório).
  attachFile(task_id, path, by, name) {
    let st;
    try { st = statSync(path); } catch { fail(`Arquivo não encontrado: ${path}`); }
    if (!st.isFile()) fail(`Não é um arquivo: ${path}`);
    if (st.size > MAX_ATTACHMENT) fail('Arquivo maior que 25 MB');
    return this.addAttachment(task_id, { name: name || basename(path), data: readFileSync(path) }, by);
  },

  deleteAttachment(id) {
    const row = this.attachment(id);
    if (!row) fail('Anexo não encontrado');
    this.transaction(() => this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id));
    try { unlinkSync(this.attachmentPath(row)); } catch {}
  },
};
