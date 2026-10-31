// Camada de dados compartilhada pelo servidor MCP, pelo painel e pelo hook.
// Usa o SQLite embutido no Node (node:sqlite) em modo WAL, então vários
// processos (uma sessão do Claude por projeto + o painel) podem escrever ao mesmo tempo.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { insightMethods } from './store/insights.js';
import { teamMethods } from './store/team.js';
import { workMethods } from './store/work.js';
import {
  COLUMN_NAME, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, TYPES, TYPE_LABEL,
  addDays, cleanDate, cleanEnum, cleanId, cleanRecurrence, cleanTags, cleanText, daysBetween,
  fail, nextOccurrence, now, parseDuration, today,
} from './util.js';

export * from './util.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const DB_PATH = process.env.CLAUDE_TASKS_DB || join(ROOT, 'data', 'tasks.db');
export const PORT = Number(process.env.CLAUDE_TASKS_PORT || 4317);
export const BOARD_URL = `http://localhost:${PORT}`;

const MIGRATIONS = [
  // 1: quadro original
  (db) => db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id          INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      path        TEXT UNIQUE,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id           INTEGER PRIMARY KEY,
      project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title        TEXT NOT NULL,
      description  TEXT NOT NULL DEFAULT '',
      status       TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','blocked','done')),
      priority     TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
      tags         TEXT NOT NULL DEFAULT '[]',
      source       TEXT NOT NULL DEFAULT 'claude',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS notes (
      id          INTEGER PRIMARY KEY,
      task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note','event')),
      author      TEXT NOT NULL DEFAULT 'claude',
      body        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_project_status ON tasks(project_id, status);
    CREATE INDEX IF NOT EXISTS notes_task ON notes(task_id);
  `),

  // 2: planejamento, colunas, tempo, anexos, equipe, notificações, automações e chat.
  // Só adiciona tabelas e colunas: nada existente é reconstruído.
  (db) => db.exec(`
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      color         TEXT,
      created_at    TEXT NOT NULL,
      last_seen_at  TEXT
    );
    CREATE TABLE sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE invites (
      token      TEXT PRIMARY KEY,
      email      TEXT,
      role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE columns (
      id         INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      status     TEXT NOT NULL CHECK (status IN ('todo','doing','blocked','done')),
      color      TEXT,
      position   REAL NOT NULL
    );
    CREATE TABLE sprints (
      id         INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      goal       TEXT NOT NULL DEFAULT '',
      status     TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','completed')),
      start_date TEXT,
      end_date   TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE TABLE dependencies (
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      blocked_by INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (task_id, blocked_by),
      CHECK (task_id != blocked_by)
    );
    CREATE TABLE assignees (
      task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, user_id)
    );
    CREATE TABLE time_entries (
      id         INTEGER PRIMARY KEY,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      author     TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at   TEXT,
      minutes    INTEGER,
      note       TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE attachments (
      id         INTEGER PRIMARY KEY,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      stored     TEXT NOT NULL,
      mime       TEXT NOT NULL,
      size       INTEGER NOT NULL,
      author     TEXT NOT NULL,
      user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE notifications (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      task_id    INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
      key        TEXT,
      body       TEXT NOT NULL,
      read_at    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE automations (
      id          INTEGER PRIMARY KEY,
      project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      trigger     TEXT NOT NULL,
      conditions  TEXT NOT NULL DEFAULT '{}',
      action      TEXT NOT NULL,
      enabled     INTEGER NOT NULL DEFAULT 1,
      run_count   INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE automation_fired (
      automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      fired_at      TEXT NOT NULL,
      PRIMARY KEY (automation_id, task_id)
    );
    CREATE TABLE settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE chat_messages (
      id         INTEGER PRIMARY KEY,
      user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
      body       TEXT NOT NULL,
      tools      TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN color TEXT;
    ALTER TABLE projects ADD COLUMN archived_at TEXT;

    ALTER TABLE tasks ADD COLUMN type TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task','bug','story','epic'));
    ALTER TABLE tasks ADD COLUMN parent_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;
    ALTER TABLE tasks ADD COLUMN sprint_id INTEGER REFERENCES sprints(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN column_id INTEGER REFERENCES columns(id) ON DELETE SET NULL;
    ALTER TABLE tasks ADD COLUMN start_date TEXT;
    ALTER TABLE tasks ADD COLUMN due_date TEXT;
    ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER;
    ALTER TABLE tasks ADD COLUMN rank REAL;
    ALTER TABLE tasks ADD COLUMN recurrence TEXT;
    ALTER TABLE tasks ADD COLUMN recurrence_next_id INTEGER;
    ALTER TABLE tasks ADD COLUMN archived_at TEXT;
    ALTER TABLE tasks ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

    ALTER TABLE notes ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

    UPDATE tasks SET rank = (CASE priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END) * 1e10
                            + unixepoch(created_at);

    CREATE INDEX tasks_parent ON tasks(parent_id);
    CREATE INDEX tasks_sprint ON tasks(sprint_id);
    CREATE INDEX tasks_due ON tasks(due_date);
    CREATE INDEX deps_blocked_by ON dependencies(blocked_by);
    CREATE INDEX time_task ON time_entries(task_id);
    CREATE INDEX attachments_task ON attachments(task_id);
    CREATE INDEX notifications_user ON notifications(user_id, read_at);
    CREATE INDEX notifications_key ON notifications(key);
  `),
];

const PRIORITY_RANK = { urgent: 1, high: 2, medium: 3, low: 4 };
const RANK_SQL = `(CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END) * 1e10 + unixepoch(t.created_at)`;
const defaultRank = (priority) => PRIORITY_RANK[priority] * 1e10 + Date.now() / 1000;

const TASK_SELECT = `
SELECT t.*, p.name AS project_name, p.path AS project_path, p.color AS project_color,
       s.name AS sprint_name, s.status AS sprint_status, c.name AS column_name, pt.title AS parent_title,
       COALESCE(t.rank, ${RANK_SQL}) AS sort_rank,
       (SELECT COUNT(*) FROM notes n WHERE n.task_id = t.id AND n.kind = 'note') AS note_count,
       (SELECT COUNT(*) FROM tasks st WHERE st.parent_id = t.id AND st.archived_at IS NULL) AS subtask_count,
       (SELECT COUNT(*) FROM tasks st WHERE st.parent_id = t.id AND st.archived_at IS NULL AND st.status = 'done') AS subtask_done,
       (SELECT COUNT(*) FROM dependencies d JOIN tasks b ON b.id = d.blocked_by
         WHERE d.task_id = t.id AND b.status != 'done') AS open_blockers,
       (SELECT COALESCE(SUM(COALESCE(e.minutes, (unixepoch('now') - unixepoch(e.started_at)) / 60)), 0)
          FROM time_entries e WHERE e.task_id = t.id) AS spent_minutes,
       (SELECT COUNT(*) FROM time_entries e WHERE e.task_id = t.id AND e.ended_at IS NULL) AS timers_running,
       (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count,
       (SELECT json_group_array(a.user_id) FROM assignees a WHERE a.task_id = t.id) AS assignee_ids
FROM tasks t
JOIN projects p ON p.id = t.project_id
LEFT JOIN sprints s ON s.id = t.sprint_id
LEFT JOIN columns c ON c.id = t.column_id
LEFT JOIN tasks pt ON pt.id = t.parent_id`;

const ORDER_SQL = `
ORDER BY CASE t.status WHEN 'doing' THEN 0 WHEN 'blocked' THEN 1 WHEN 'todo' THEN 2 ELSE 3 END,
         CASE WHEN t.status = 'done' THEN t.completed_at END DESC,
         sort_rank, t.id`;

export const actorOf = (by) => (typeof by === 'string' ? { author: by } : by || { author: 'claude' });

function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
    assignee_ids: JSON.parse(row.assignee_ids || '[]'),
    overdue: !!row.due_date && row.status !== 'done' && row.due_date < today(),
    timer_running: row.timers_running > 0,
  };
}

// Raiz do projeto: o repositório git que contém o caminho. Worktrees (.git em
// arquivo apontando para .../.git/worktrees/x) contam como o repositório principal.
export function findProjectRoot(path) {
  const start = resolve(path);
  for (let dir = start; ; dir = dirname(dir)) {
    const git = join(dir, '.git');
    if (existsSync(git)) {
      try {
        if (statSync(git).isFile()) {
          const target = readFileSync(git, 'utf8').match(/gitdir:\s*(.+)/)?.[1]?.trim();
          const marker = `${sep}.git${sep}worktrees${sep}`;
          const gitdir = target && resolve(dir, target);
          if (gitdir?.includes(marker)) return gitdir.slice(0, gitdir.indexOf(marker));
        }
      } catch {}
      return dir;
    }
    if (dirname(dir) === dir) return start;
  }
}

export function formatTask(t, { withProject = false } = {}) {
  const head = [`#${t.id}`];
  if (t.type && t.type !== 'task') head.push(`[${TYPE_LABEL[t.type]}]`);
  head.push(`[${STATUS_LABEL[t.status]}]`, `[${PRIORITY_LABEL[t.priority]}]`, t.title);
  let line = head.join(' ');
  if (t.tags?.length) line += ` (${t.tags.join(', ')})`;
  const extra = [];
  if (t.due_date) extra.push(`prazo ${t.due_date}${t.overdue ? ' (atrasada)' : ''}`);
  if (t.subtask_count) extra.push(`subtarefas ${t.subtask_done}/${t.subtask_count}`);
  if (t.open_blockers) extra.push(`bloqueada por ${t.open_blockers}`);
  if (t.sprint_name) extra.push(`sprint ${t.sprint_name}`);
  if (t.parent_id) extra.push(`subtarefa de #${t.parent_id}`);
  if (t.archived_at) extra.push('arquivada');
  if (extra.length) line += ` · ${extra.join(' · ')}`;
  if (withProject) line += ` — ${t.project_name}`;
  return line;
}

export class Store extends EventEmitter {
  constructor(path = DB_PATH) {
    super();
    mkdirSync(dirname(path), { recursive: true });
    this.path = path;
    this.attachDir = join(dirname(path), 'attachments');
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.writes = 0;
    this.depth = 0;
    this.queued = [];
    this.migrate();
  }

  migrate() {
    const version = () => this.db.prepare('PRAGMA user_version').get().user_version;
    if (version() >= MIGRATIONS.length) return;
    // Backup antes de mexer num banco que já tem dados.
    if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'tasks'").get()) {
      const backup = join(dirname(this.path), `backup-v${version()}-${Date.now()}.db`);
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let v = version(); v < MIGRATIONS.length; v++) MIGRATIONS[v](this.db);
      this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Muda sempre que qualquer processo grava no banco; o painel usa para se atualizar sozinho.
  version() {
    const { data_version } = this.db.prepare('PRAGMA data_version').get();
    return `${data_version}.${this.writes}`;
  }

  // Reentrante: só a transação mais externa abre e fecha. Os eventos (usados pelas
  // automações e notificações) só disparam depois do COMMIT.
  transaction(fn) {
    if (this.depth++) {
      try { return fn(); } finally { this.depth--; }
    }
    this.db.exec('BEGIN IMMEDIATE');
    let ok = false;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      ok = true;
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.depth--;
      this.writes++;
      const events = this.queued;
      this.queued = [];
      if (ok) {
        for (const [name, payload] of events) {
          try { this.emit(name, payload); } catch (e) { console.error(`[${name}]`, e); }
        }
      }
    }
  }

  queue(name, payload) {
    this.queued.push([name, payload]);
  }

  logEvent(task_id, by, body, ts = now()) {
    const actor = actorOf(by);
    this.db.prepare("INSERT INTO notes (task_id, kind, author, user_id, body, created_at) VALUES (?, 'event', ?, ?, ?, ?)")
      .run(task_id, actor.author, actor.user_id ?? null, body, ts);
  }

  // ---- projetos ----

  project(id) {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  }

  listProjects({ include_archived = true } = {}) {
    return this.db.prepare(`
      SELECT p.*,
        COUNT(CASE WHEN t.status = 'todo' THEN 1 END)    AS todo,
        COUNT(CASE WHEN t.status = 'doing' THEN 1 END)   AS doing,
        COUNT(CASE WHEN t.status = 'blocked' THEN 1 END) AS blocked,
        COUNT(CASE WHEN t.status = 'done' THEN 1 END)    AS done,
        COUNT(CASE WHEN t.status != 'done' THEN 1 END)   AS open,
        COUNT(CASE WHEN t.status != 'done' AND t.due_date < ? THEN 1 END) AS overdue,
        MAX(t.updated_at) AS last_activity
      FROM projects p LEFT JOIN tasks t ON t.project_id = p.id AND t.archived_at IS NULL
      ${include_archived ? '' : 'WHERE p.archived_at IS NULL'}
      GROUP BY p.id
      ORDER BY p.archived_at IS NOT NULL, open > 0 DESC, last_activity DESC, p.name COLLATE NOCASE`).all(today());
  }

  // Encontra (ou cria) o projeto a partir de um caminho no disco ou de um nome.
  resolveProject({ project_path, project, create = true } = {}) {
    if (project_path) {
      const root = findProjectRoot(project_path);
      const row = this.db.prepare('SELECT * FROM projects WHERE path = ?').get(root);
      return row || (create ? this.createProject(basename(root) || root, root) : null);
    }
    if (project) {
      if (/^#?\d+$/.test(String(project))) {
        const row = this.project(cleanId(project, 'project'));
        if (row) return row;
      }
      const name = cleanText(project, 'project', { required: true, max: 120 });
      const row = this.db
        .prepare('SELECT * FROM projects WHERE lower(name) = lower(?) ORDER BY path IS NOT NULL DESC LIMIT 1')
        .get(name);
      return row || (create ? this.createProject(name, null) : null);
    }
    return null;
  }

  createProject(name, path = null, extra = {}) {
    name = cleanText(name, 'name', { required: true, max: 120 });
    const r = this.db.prepare('INSERT INTO projects (name, path, description, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, path, cleanText(extra.description, 'description') || '', extra.color || null, now());
    this.writes++;
    return this.project(Number(r.lastInsertRowid));
  }

  updateProject(id, patch) {
    const current = this.project(id);
    if (!current) fail(`Projeto ${id} não encontrado`);
    const fields = {
      name: patch.name === undefined ? undefined : cleanText(patch.name, 'name', { required: true, max: 120 }),
      description: cleanText(patch.description, 'description'),
      color: patch.color === undefined ? undefined : (patch.color || null),
      archived_at: patch.archived === undefined ? undefined : (patch.archived ? (current.archived_at || now()) : null),
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length) {
      this.db.prepare(`UPDATE projects SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => v), id);
      this.writes++;
    }
    return this.project(id);
  }

  renameProject(id, name) {
    return this.updateProject(id, { name });
  }

  deleteProject(id) {
    const files = this.db.prepare('SELECT a.stored FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?').all(id);
    const r = this.transaction(() => this.db.prepare('DELETE FROM projects WHERE id = ?').run(id));
    if (!r.changes) fail(`Projeto ${id} não encontrado`);
    this.#removeFiles(files);
  }

  #removeFiles(rows) {
    for (const { stored } of rows) {
      try { unlinkSync(join(this.attachDir, stored)); } catch {}
    }
  }

  // ---- colunas (workflow por projeto) ----
  // Sem colunas próprias, o projeto usa as 4 padrão (virtuais, id null). Cada coluna
  // pertence a uma das 4 categorias de status; a tarefa guarda a categoria em
  // tasks.status e, se estiver numa coluna personalizada, o id em tasks.column_id.

  columns(project_id) {
    const rows = this.db.prepare('SELECT * FROM columns WHERE project_id = ? ORDER BY position, id').all(project_id);
    if (rows.length) return rows;
    return STATUSES.map((status, i) => ({ id: null, project_id, name: COLUMN_NAME[status], status, color: null, position: i }));
  }

  column(id) {
    return this.db.prepare('SELECT * FROM columns WHERE id = ?').get(id);
  }

  #seedColumns(project_id) {
    if (this.db.prepare('SELECT 1 FROM columns WHERE project_id = ?').get(project_id)) return;
    const insert = this.db.prepare('INSERT INTO columns (project_id, name, status, position) VALUES (?, ?, ?, ?)');
    STATUSES.forEach((status, i) => insert.run(project_id, COLUMN_NAME[status], status, i));
  }

  #renumberColumns(project_id) {
    const rows = this.db.prepare('SELECT id FROM columns WHERE project_id = ? ORDER BY position, id').all(project_id);
    const update = this.db.prepare('UPDATE columns SET position = ? WHERE id = ?');
    rows.forEach((r, i) => update.run(i, r.id));
  }

  resolveColumn(project_id, ref) {
    const cols = this.columns(project_id);
    const s = String(ref).trim().toLowerCase();
    const col = cols.find((c) => c.id != null && String(c.id) === s)
      || cols.find((c) => c.name.toLowerCase() === s)
      || cols.find((c) => c.status === s);
    if (!col) fail(`Coluna "${ref}" não existe. Colunas: ${cols.map((c) => c.name).join(', ')}`);
    return col;
  }

  createColumn(project_id, { name, status, color }) {
    if (!this.project(project_id)) fail(`Projeto ${project_id} não encontrado`);
    return this.transaction(() => {
      this.#seedColumns(project_id);
      status = cleanEnum(status, 'status', STATUSES) || 'doing';
      const last = this.db.prepare('SELECT MAX(position) AS p FROM columns WHERE project_id = ? AND status = ?').get(project_id, status);
      const r = this.db.prepare('INSERT INTO columns (project_id, name, status, color, position) VALUES (?, ?, ?, ?, ?)')
        .run(project_id, cleanText(name, 'name', { required: true, max: 60 }), status, color || null, (last.p ?? 99) + 0.5);
      this.#renumberColumns(project_id);
      return this.column(Number(r.lastInsertRowid));
    });
  }

  updateColumn(id, patch) {
    const col = this.column(id);
    if (!col) fail(`Coluna ${id} não encontrada`);
    return this.transaction(() => {
      const name = patch.name === undefined ? col.name : cleanText(patch.name, 'name', { required: true, max: 60 });
      const status = cleanEnum(patch.status, 'status', STATUSES) || col.status;
      if (status !== col.status) {
        const siblings = this.db.prepare('SELECT COUNT(*) AS n FROM columns WHERE project_id = ? AND status = ?').get(col.project_id, col.status).n;
        if (siblings <= 1) fail(`O projeto precisa de ao menos uma coluna "${STATUS_LABEL[col.status]}"`);
        this.db.prepare('UPDATE tasks SET status = ?, updated_at = ?, completed_at = ? WHERE column_id = ?')
          .run(status, now(), status === 'done' ? now() : null, id);
      }
      const color = patch.color === undefined ? col.color : (patch.color || null);
      this.db.prepare('UPDATE columns SET name = ?, status = ?, color = ? WHERE id = ?').run(name, status, color, id);
      if (patch.move) {
        const cols = this.db.prepare('SELECT id FROM columns WHERE project_id = ? ORDER BY position, id').all(col.project_id).map((c) => c.id);
        const i = cols.indexOf(id);
        const j = i + (patch.move === 'left' ? -1 : 1);
        if (j >= 0 && j < cols.length) [cols[i], cols[j]] = [cols[j], cols[i]];
        const update = this.db.prepare('UPDATE columns SET position = ? WHERE id = ?');
        cols.forEach((cid, k) => update.run(k, cid));
      }
      return this.column(id);
    });
  }

  deleteColumn(id) {
    const col = this.column(id);
    if (!col) fail(`Coluna ${id} não encontrada`);
    const siblings = this.db.prepare('SELECT COUNT(*) AS n FROM columns WHERE project_id = ? AND status = ?').get(col.project_id, col.status).n;
    if (siblings <= 1) fail(`O projeto precisa de ao menos uma coluna "${STATUS_LABEL[col.status]}"`);
    this.transaction(() => this.db.prepare('DELETE FROM columns WHERE id = ?').run(id));
  }

  // ---- sprints ----

  sprints(project_id) {
    return this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL) AS total,
        (SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL AND t.status = 'done') AS done
      FROM sprints s WHERE s.project_id = ?
      ORDER BY CASE s.status WHEN 'active' THEN 0 WHEN 'planning' THEN 1 ELSE 2 END, COALESCE(s.start_date, s.created_at)`)
      .all(project_id);
  }

  sprint(id) {
    return this.db.prepare('SELECT * FROM sprints WHERE id = ?').get(id);
  }

  resolveSprint(project_id, ref) {
    if (ref === undefined) return undefined;
    if (ref === null || ref === '' || ref === 'none' || ref === 'backlog') return null;
    const s = String(ref).trim();
    const row = s === 'active'
      ? this.db.prepare("SELECT * FROM sprints WHERE project_id = ? AND status = 'active'").get(project_id)
      : this.db.prepare('SELECT * FROM sprints WHERE project_id = ? AND (CAST(id AS TEXT) = ? OR lower(name) = lower(?))').get(project_id, s.replace(/^#/, ''), s);
    if (!row) fail(s === 'active' ? 'O projeto não tem sprint ativa' : `Sprint "${ref}" não encontrada neste projeto`);
    return row.id;
  }

  createSprint(project_id, input) {
    if (!this.project(project_id)) fail(`Projeto ${project_id} não encontrado`);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM sprints WHERE project_id = ?').get(project_id).n;
    const r = this.transaction(() => this.db.prepare(`
      INSERT INTO sprints (project_id, name, goal, start_date, end_date, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      project_id,
      cleanText(input.name, 'name', { max: 80 }) || `Sprint ${count + 1}`,
      cleanText(input.goal, 'goal') || '',
      cleanDate(input.start_date, 'start_date') ?? null,
      cleanDate(input.end_date, 'end_date') ?? null,
      now(),
    ));
    return this.sprint(Number(r.lastInsertRowid));
  }

  updateSprint(id, patch) {
    const s = this.sprint(id);
    if (!s) fail(`Sprint ${id} não encontrada`);
    const fields = {
      name: patch.name === undefined ? undefined : cleanText(patch.name, 'name', { required: true, max: 80 }),
      goal: cleanText(patch.goal, 'goal'),
      start_date: cleanDate(patch.start_date, 'start_date'),
      end_date: cleanDate(patch.end_date, 'end_date'),
    };
    const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
    if (entries.length) {
      this.transaction(() => this.db.prepare(`UPDATE sprints SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => v), id));
    }
    return this.sprint(id);
  }

  startSprint(id) {
    const s = this.sprint(id);
    if (!s) fail(`Sprint ${id} não encontrada`);
    const active = this.db.prepare("SELECT name FROM sprints WHERE project_id = ? AND status = 'active' AND id != ?").get(s.project_id, id);
    if (active) fail(`A sprint "${active.name}" já está ativa. Conclua ela antes.`);
    this.transaction(() => this.db.prepare("UPDATE sprints SET status = 'active', start_date = COALESCE(start_date, ?) WHERE id = ?").run(today(), id));
    return this.sprint(id);
  }

  // Tarefas não concluídas vão para outra sprint (move_to) ou para o backlog.
  completeSprint(id, { move_to = null } = {}) {
    const s = this.sprint(id);
    if (!s) fail(`Sprint ${id} não encontrada`);
    let target = null;
    if (move_to != null && move_to !== '') {
      target = this.sprint(cleanId(move_to, 'move_to'));
      if (!target || target.project_id !== s.project_id || target.status === 'completed' || target.id === id) fail('Sprint de destino inválida');
    }
    return this.transaction(() => {
      const moved = this.db.prepare("UPDATE tasks SET sprint_id = ?, updated_at = ? WHERE sprint_id = ? AND status != 'done'")
        .run(target?.id ?? null, now(), id).changes;
      this.db.prepare("UPDATE sprints SET status = 'completed', completed_at = ?, end_date = COALESCE(end_date, ?) WHERE id = ?").run(now(), today(), id);
      return { sprint: this.sprint(id), moved, moved_to: target };
    });
  }

  deleteSprint(id) {
    if (!this.sprint(id)) fail(`Sprint ${id} não encontrada`);
    this.transaction(() => this.db.prepare('DELETE FROM sprints WHERE id = ?').run(id));
  }

  // ---- tarefas ----

  task(id) {
    return hydrate(this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
  }

  taskWithNotes(id) {
    const task = this.task(id);
    if (!task) return null;
    task.notes = this.db.prepare(`
      SELECT n.*, u.name AS user_name, u.color AS user_color FROM notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.task_id = ? ORDER BY n.created_at, n.id`).all(id);
    task.subtasks = this.listTasks({ parent_id: id, status: 'all', include_archived: false, limit: 500 })
      .sort((a, b) => a.sort_rank - b.sort_rank || a.id - b.id);
    task.blockers = this.blockers(id);
    task.blocking = this.blocking(id);
    task.time_entries = this.timeEntries(id);
    task.attachments = this.attachments(id);
    task.columns = this.columns(task.project_id);
    return task;
  }

  // status: 'open' (tudo que não está concluído), 'all' ou um status específico.
  listTasks({
    project_id, status = 'open', q, limit = 200, sprint_id, assignee_id, type, parent_id,
    top_level = false, due, include_archived = false, done_since,
  } = {}) {
    const where = [];
    const args = [];
    if (project_id) { where.push('t.project_id = ?'); args.push(project_id); }
    if (status === 'open') where.push("t.status != 'done'");
    else if (status !== 'all') { where.push('t.status = ?'); args.push(cleanEnum(status, 'status', STATUSES)); }
    if (done_since) { where.push("(t.status != 'done' OR t.completed_at >= ?)"); args.push(done_since); }
    if (!include_archived) where.push('t.archived_at IS NULL');
    if (sprint_id === 'none') where.push('t.sprint_id IS NULL');
    else if (sprint_id) { where.push('t.sprint_id = ?'); args.push(sprint_id); }
    if (assignee_id) { where.push('EXISTS (SELECT 1 FROM assignees a WHERE a.task_id = t.id AND a.user_id = ?)'); args.push(assignee_id); }
    if (type) { where.push('t.type = ?'); args.push(cleanEnum(type, 'type', TYPES)); }
    if (parent_id) { where.push('t.parent_id = ?'); args.push(parent_id); }
    if (top_level) where.push('t.parent_id IS NULL');
    if (due) {
      const d = today();
      if (due === 'overdue') { where.push("t.due_date < ? AND t.status != 'done'"); args.push(d); }
      else if (due === 'today') { where.push('t.due_date = ?'); args.push(d); }
      else if (due === 'week') { where.push('t.due_date BETWEEN ? AND ?'); args.push(d, addDays(d, 7)); }
      else if (due === 'none') where.push('t.due_date IS NULL');
      else if (due === 'any') where.push('t.due_date IS NOT NULL');
      else fail('"due" deve ser overdue, today, week, none ou any');
    }
    if (q) {
      const like = `%${q.replace(/^#/, '')}%`;
      where.push('(t.title LIKE ? OR t.description LIKE ? OR t.tags LIKE ? OR CAST(t.id AS TEXT) = ?)');
      args.push(like, like, like, q.replace(/^#/, ''));
    }
    const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER_SQL} LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 5000)).map(hydrate);
  }

  // Não duplica: se já houver uma tarefa aberta com o mesmo título no mesmo lugar, devolve ela.
  addTask(project_id, input, by = 'claude') {
    const actor = actorOf(by);
    return this.transaction(() => {
      const title = cleanText(input.title, 'title', { required: true, max: 300 });
      let parent_id = null;
      if (input.parent_id != null && input.parent_id !== '') {
        const parent = this.task(cleanId(input.parent_id, 'parent_id'));
        if (!parent) fail(`Tarefa-mãe #${input.parent_id} não encontrada`);
        parent_id = parent.id;
        project_id = parent.project_id;
      }
      const existing = this.db.prepare(`
        SELECT id FROM tasks WHERE project_id = ? AND parent_id IS ? AND status != 'done' AND archived_at IS NULL
        AND lower(title) = lower(?)`).get(project_id, parent_id, title);
      if (existing) return { task: this.task(existing.id), duplicate: true };

      const column = input.column != null && input.column !== '' ? this.resolveColumn(project_id, input.column) : null;
      const status = column?.status || cleanEnum(input.status, 'status', STATUSES) || 'todo';
      const priority = cleanEnum(input.priority, 'priority', PRIORITIES) || 'medium';
      const ts = now();
      const r = this.db.prepare(`
        INSERT INTO tasks (project_id, title, description, status, priority, type, tags, source, parent_id, sprint_id,
          column_id, start_date, due_date, estimate_minutes, rank, recurrence, created_by, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project_id,
        title,
        cleanText(input.description, 'description') || '',
        status,
        priority,
        cleanEnum(input.type, 'type', TYPES) || 'task',
        JSON.stringify(cleanTags(input.tags) || []),
        actor.author,
        parent_id,
        this.resolveSprint(project_id, input.sprint ?? input.sprint_id) ?? null,
        column?.id ?? null,
        cleanDate(input.start_date, 'start_date') ?? null,
        cleanDate(input.due_date, 'due_date') ?? null,
        parseDuration(input.estimate ?? input.estimate_minutes, 'estimate') ?? null,
        defaultRank(priority),
        cleanRecurrence(input.recurrence) ?? null,
        actor.user_id ?? null,
        ts,
        ts,
        status === 'done' ? ts : null,
      );
      const id = Number(r.lastInsertRowid);
      if (input.blocked_by?.length) this.setBlockers(id, input.blocked_by);
      if (input.assignees?.length || input.assignee_ids?.length) this.setAssignees(id, input.assignees ?? input.assignee_ids, actor);
      const task = this.task(id);
      this.queue('task.created', { task, actor });
      return { task, duplicate: false };
    });
  }

  updateTask(id, patch, by = 'claude') {
    return this.transaction(() => this.#updateTask(id, patch, actorOf(by)));
  }

  #updateTask(id, patch, actor) {
    const current = this.task(id);
    if (!current) fail(`Tarefa #${id} não encontrada`);

    const fields = {
      title: patch.title === undefined ? undefined : cleanText(patch.title, 'title', { required: true, max: 300 }),
      description: cleanText(patch.description, 'description'),
      status: cleanEnum(patch.status, 'status', STATUSES),
      priority: cleanEnum(patch.priority, 'priority', PRIORITIES),
      type: cleanEnum(patch.type, 'type', TYPES),
      tags: patch.tags === undefined ? undefined : JSON.stringify(cleanTags(patch.tags)),
      project_id: patch.project_id == null ? undefined : cleanId(patch.project_id, 'project_id'),
      start_date: cleanDate(patch.start_date, 'start_date'),
      due_date: cleanDate(patch.due_date, 'due_date'),
      estimate_minutes: parseDuration(patch.estimate ?? patch.estimate_minutes, 'estimate'),
      recurrence: cleanRecurrence(patch.recurrence),
      rank: patch.rank == null ? undefined : Number(patch.rank),
      archived_at: patch.archived === undefined ? undefined : (patch.archived ? (current.archived_at || now()) : null),
    };

    const projectId = fields.project_id ?? current.project_id;
    if (fields.project_id && fields.project_id !== current.project_id) {
      if (!this.project(fields.project_id)) fail(`Projeto ${fields.project_id} não encontrado`);
      fields.column_id = null;
      fields.sprint_id = null;
      if (current.parent_id) fields.parent_id = null;
    }

    if (patch.column != null && patch.column !== '') {
      const col = this.resolveColumn(projectId, patch.column);
      fields.status = col.status;
      fields.column_id = col.id;
    } else if (fields.status && fields.status !== current.status) {
      fields.column_id = null;
    }

    const sprint = patch.sprint !== undefined ? patch.sprint : patch.sprint_id;
    if (sprint !== undefined && !(fields.project_id && fields.project_id !== current.project_id && sprint == null)) {
      fields.sprint_id = this.resolveSprint(projectId, sprint);
    }

    if (patch.parent_id !== undefined) {
      if (patch.parent_id === null || patch.parent_id === '') fields.parent_id = null;
      else {
        const parentId = cleanId(patch.parent_id, 'parent_id');
        for (let p = this.task(parentId); p; p = p.parent_id ? this.task(p.parent_id) : null) {
          if (p.id === id) fail('Uma tarefa não pode ser subtarefa dela mesma ou das próprias subtarefas');
        }
        const parent = this.task(parentId);
        if (!parent) fail(`Tarefa-mãe #${parentId} não encontrada`);
        if (parent.project_id !== projectId) fail('A tarefa-mãe precisa estar no mesmo projeto');
        fields.parent_id = parentId;
      }
    }

    if (fields.priority && fields.priority !== current.priority && fields.rank === undefined) {
      fields.rank = defaultRank(fields.priority);
    }

    const sets = [];
    const args = [];
    const changes = {};
    for (const [key, value] of Object.entries(fields)) {
      const old = key === 'tags' ? JSON.stringify(current.tags) : key === 'recurrence' ? (current.recurrence && JSON.stringify(current.recurrence)) : current[key];
      if (value === undefined || value === old) continue;
      sets.push(`${key} = ?`);
      args.push(value);
      changes[key] = [old, value];
    }

    const ts = now();
    if (changes.status) {
      sets.push('completed_at = ?');
      args.push(fields.status === 'done' ? ts : null);
      this.logEvent(id, actor, `${STATUS_LABEL[current.status]} → ${STATUS_LABEL[fields.status]}`, ts);
    }
    if (changes.priority) this.logEvent(id, actor, `prioridade ${PRIORITY_LABEL[current.priority]} → ${PRIORITY_LABEL[fields.priority]}`, ts);
    if (changes.due_date) this.logEvent(id, actor, fields.due_date ? `prazo definido para ${fields.due_date}` : 'prazo removido', ts);
    if (changes.project_id) this.logEvent(id, actor, `movida de ${current.project_name} para ${this.project(fields.project_id).name}`, ts);
    if (changes.sprint_id) this.logEvent(id, actor, fields.sprint_id ? `sprint: ${this.sprint(fields.sprint_id).name}` : 'removida da sprint', ts);
    if (changes.archived_at) this.logEvent(id, actor, fields.archived_at ? 'arquivada' : 'desarquivada', ts);

    if (sets.length) {
      sets.push('updated_at = ?');
      args.push(ts);
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    // Subtarefas acompanham a mãe quando ela muda de projeto.
    if (changes.project_id) {
      this.db.prepare('UPDATE tasks SET project_id = ?, column_id = NULL, sprint_id = NULL, updated_at = ? WHERE parent_id = ?')
        .run(fields.project_id, ts, id);
    }
    if (patch.blocked_by !== undefined) this.setBlockers(id, patch.blocked_by || []);
    if (patch.assignees !== undefined || patch.assignee_ids !== undefined) {
      this.setAssignees(id, patch.assignees ?? patch.assignee_ids ?? [], actor);
    }

    let task = this.task(id);
    if (changes.status && task.status === 'done' && task.recurrence && !task.recurrence_next_id) {
      this.#spawnNext(task, actor);
      task = this.task(id);
    }
    if (Object.keys(changes).length) this.queue('task.updated', { task, before: current, changes, actor });
    return task;
  }

  // Tarefa recorrente concluída: cria a próxima ocorrência.
  #spawnNext(task, actor) {
    const rule = task.recurrence;
    const base = task.due_date || today();
    let due = nextOccurrence(base, rule);
    while (due < today()) due = nextOccurrence(due, rule);
    if (rule.until && due > rule.until) {
      this.logEvent(task.id, actor, 'recorrência encerrada');
      return null;
    }
    const start = task.start_date ? addDays(due, -daysBetween(task.start_date, base)) : null;
    const ts = now();
    const r = this.db.prepare(`
      INSERT INTO tasks (project_id, title, description, status, priority, type, tags, source, parent_id, column_id,
        start_date, due_date, estimate_minutes, rank, recurrence, created_by, created_at, updated_at)
      VALUES (?, ?, ?, 'todo', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.project_id, task.title, task.description, task.priority, task.type, JSON.stringify(task.tags), 'automação',
      task.parent_id, start, due, task.estimate_minutes, defaultRank(task.priority), JSON.stringify(rule), task.created_by, ts, ts,
    );
    const nextId = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO assignees (task_id, user_id) SELECT ?, user_id FROM assignees WHERE task_id = ?').run(nextId, task.id);
    this.db.prepare('UPDATE tasks SET recurrence_next_id = ? WHERE id = ?').run(nextId, task.id);
    this.logEvent(task.id, actor, `próxima ocorrência: #${nextId} com prazo ${due}`);
    this.logEvent(nextId, { author: 'automação' }, `criada pela recorrência de #${task.id}`);
    this.queue('task.created', { task: this.task(nextId), actor: { author: 'automação' } });
    return nextId;
  }

  deleteTask(id) {
    const files = this.db.prepare(`
      WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT t.id FROM tasks t JOIN tree ON t.parent_id = tree.id)
      SELECT stored FROM attachments WHERE task_id IN (SELECT id FROM tree)`).all(id);
    const r = this.transaction(() => this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id));
    if (!r.changes) fail(`Tarefa #${id} não encontrada`);
    this.#removeFiles(files);
  }

  addNote(task_id, body, by = 'claude') {
    const actor = actorOf(by);
    body = cleanText(body, 'body', { required: true });
    const task = this.task(task_id);
    if (!task) fail(`Tarefa #${task_id} não encontrada`);
    const ts = now();
    this.transaction(() => {
      const r = this.db.prepare("INSERT INTO notes (task_id, kind, author, user_id, body, created_at) VALUES (?, 'note', ?, ?, ?, ?)")
        .run(task_id, actor.author, actor.user_id ?? null, body, ts);
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, task_id);
      this.queue('task.commented', { task, note: { id: Number(r.lastInsertRowid), body }, actor });
    });
  }

  // ---- dependências ("bloqueada por") ----

  blockers(task_id) {
    return this.db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.start_date, t.project_id, p.name AS project_name
      FROM dependencies d JOIN tasks t ON t.id = d.blocked_by JOIN projects p ON p.id = t.project_id
      WHERE d.task_id = ? ORDER BY t.id`).all(task_id);
  }

  blocking(task_id) {
    return this.db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.start_date, t.project_id, p.name AS project_name
      FROM dependencies d JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
      WHERE d.blocked_by = ? ORDER BY t.id`).all(task_id);
  }

  allDependencies(task_ids) {
    if (!task_ids.length) return [];
    const marks = task_ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT task_id, blocked_by FROM dependencies WHERE task_id IN (${marks}) OR blocked_by IN (${marks})`)
      .all(...task_ids, ...task_ids);
  }

  #dependsOn(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.db.prepare('SELECT blocked_by FROM dependencies WHERE task_id = ?').all(from)
      .some((r) => this.#dependsOn(r.blocked_by, target, seen));
  }

  setBlockers(task_id, ids) {
    const list = [...new Set((Array.isArray(ids) ? ids : String(ids).split(',')).filter((x) => String(x).trim()).map((x) => cleanId(x, 'blocked_by')))];
    this.transaction(() => {
      for (const b of list) {
        if (b === task_id) fail('Uma tarefa não pode bloquear ela mesma');
        if (!this.task(b)) fail(`Tarefa #${b} não encontrada`);
        if (this.#dependsOn(b, task_id)) fail(`#${b} já depende de #${task_id}: isso criaria um ciclo`);
      }
      this.db.prepare('DELETE FROM dependencies WHERE task_id = ?').run(task_id);
      const insert = this.db.prepare('INSERT INTO dependencies (task_id, blocked_by, created_at) VALUES (?, ?, ?)');
      for (const b of list) insert.run(task_id, b, now());
    });
  }

  addBlocker(task_id, blocked_by) {
    const ids = this.blockers(task_id).map((b) => b.id);
    this.setBlockers(task_id, [...ids, blocked_by]);
  }

  removeBlocker(task_id, blocked_by) {
    this.transaction(() => this.db.prepare('DELETE FROM dependencies WHERE task_id = ? AND blocked_by = ?').run(task_id, blocked_by));
  }
}

Object.assign(Store.prototype, teamMethods, workMethods, insightMethods);
