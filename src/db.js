// Camada de dados compartilhada pelo servidor MCP, pelo painel e pelo hook.
// Usa o SQLite embutido no Node (node:sqlite) em modo WAL, então vários
// processos (uma sessão do Claude por projeto + o painel) podem escrever ao mesmo tempo.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { decrypt, encrypt } from './secret.js';
import { insightMethods } from './store/insights.js';
import { metaMethods } from './store/meta.js';
import { orgMethods } from './store/org.js';
import { teamMethods } from './store/team.js';
import { workMethods } from './store/work.js';
import {
  COLUMN_NAME, DEPENDENCY_TYPES, PRIORITIES, PRIORITY_LABEL, PROJECT_STATUSES, STATUSES, STATUS_LABEL, TYPES, TYPE_LABEL,
  VISIBILITIES, addDays, cleanColor, cleanDate, cleanEnum, cleanId, cleanPoints, cleanRecurrence, cleanTags, cleanText,
  daysBetween, fail, nextOccurrence, now, parseDuration, today,
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

  // 3: paridade com o Taskosaur. Reconstrói users, invites, sprints e tasks (o SQLite não
  // altera CHECK de tabela existente) com as chaves estrangeiras desligadas; o resto só adiciona.
  {
    rebuild: true,
    run: (db) => db.exec(`
      CREATE TABLE users_new (
        id            INTEGER PRIMARY KEY,
        name          TEXT NOT NULL,
        email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
        color         TEXT,
        avatar        TEXT,
        disabled_at   TEXT,
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT
      );
      INSERT INTO users_new (id, name, email, password_hash, role, color, created_at, last_seen_at)
        SELECT id, name, email, password_hash, role, color, created_at, last_seen_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_new RENAME TO users;

      CREATE TABLE invites_new (
        token        TEXT PRIMARY KEY,
        email        TEXT,
        role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member','viewer')),
        project_id   INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        project_role TEXT CHECK (project_role IN ('owner','manager','member','viewer')),
        created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        used_at      TEXT,
        used_by      INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
      INSERT INTO invites_new (token, email, role, created_by, created_at, expires_at, used_at, used_by)
        SELECT token, email, role, created_by, created_at, expires_at, used_at, used_by FROM invites;
      DROP TABLE invites;
      ALTER TABLE invites_new RENAME TO invites;

      CREATE TABLE sprints_new (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        goal         TEXT NOT NULL DEFAULT '',
        status       TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','active','completed','cancelled')),
        start_date   TEXT,
        end_date     TEXT,
        created_at   TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO sprints_new SELECT id, project_id, name, goal, status, start_date, end_date, created_at, completed_at FROM sprints;
      DROP TABLE sprints;
      ALTER TABLE sprints_new RENAME TO sprints;

      CREATE TABLE tasks_new (
        id                 INTEGER PRIMARY KEY,
        project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number             INTEGER,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL DEFAULT '',
        status             TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','blocked','done')),
        priority           TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('lowest','low','medium','high','urgent')),
        type               TEXT NOT NULL DEFAULT 'task' CHECK (type IN ('task','bug','story','epic')),
        tags               TEXT NOT NULL DEFAULT '[]',
        source             TEXT NOT NULL DEFAULT 'claude',
        parent_id          INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        sprint_id          INTEGER REFERENCES sprints(id) ON DELETE SET NULL,
        column_id          INTEGER REFERENCES columns(id) ON DELETE SET NULL,
        reporter_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
        start_date         TEXT,
        due_date           TEXT,
        estimate_minutes   INTEGER,
        remaining_minutes  INTEGER,
        story_points       REAL,
        rank               REAL,
        recurrence         TEXT,
        recurrence_next_id INTEGER,
        external_source    TEXT,
        external_id        TEXT,
        archived_at        TEXT,
        created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        completed_at       TEXT
      );
      INSERT INTO tasks_new (id, project_id, title, description, status, priority, type, tags, source, parent_id, sprint_id,
        column_id, start_date, due_date, estimate_minutes, rank, recurrence, recurrence_next_id, archived_at, created_by,
        created_at, updated_at, completed_at)
        SELECT id, project_id, title, description, status, priority, type, tags, source, parent_id, sprint_id,
          column_id, start_date, due_date, estimate_minutes, rank, recurrence, recurrence_next_id, archived_at, created_by,
          created_at, updated_at, completed_at FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      UPDATE tasks SET number = (SELECT COUNT(*) FROM tasks t2 WHERE t2.project_id = tasks.project_id AND t2.id <= tasks.id);
      CREATE INDEX tasks_project_status ON tasks(project_id, status);
      CREATE INDEX tasks_parent ON tasks(parent_id);
      CREATE INDEX tasks_sprint ON tasks(sprint_id);
      CREATE INDEX tasks_due ON tasks(due_date);
      CREATE UNIQUE INDEX tasks_number ON tasks(project_id, number);
      CREATE UNIQUE INDEX tasks_external ON tasks(external_source, external_id) WHERE external_id IS NOT NULL;

      -- organizações, workspaces (aninháveis) e papéis por escopo
      CREATE TABLE organizations (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        website     TEXT,
        color       TEXT,
        avatar      TEXT,
        archived_at TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE workspaces (
        id              INTEGER PRIMARY KEY,
        organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        parent_id       INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        color           TEXT,
        position        REAL NOT NULL DEFAULT 0,
        archived_at     TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE memberships (
        scope      TEXT NOT NULL CHECK (scope IN ('organization','workspace','project')),
        scope_id   INTEGER NOT NULL,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role       TEXT NOT NULL CHECK (role IN ('owner','manager','member','viewer')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id, user_id)
      );
      INSERT INTO organizations (id, name, created_at) VALUES (1, 'Minha organização', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      INSERT INTO workspaces (id, organization_id, name, created_at) VALUES (1, 1, 'Geral', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

      ALTER TABLE projects ADD COLUMN workspace_id INTEGER REFERENCES workspaces(id) ON DELETE SET NULL;
      ALTER TABLE projects ADD COLUMN key TEXT;
      ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('planning','active','on_hold','completed','cancelled'));
      ALTER TABLE projects ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'
        CHECK (priority IN ('lowest','low','medium','high','urgent'));
      ALTER TABLE projects ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal'
        CHECK (visibility IN ('private','internal','public'));
      ALTER TABLE projects ADD COLUMN start_date TEXT;
      ALTER TABLE projects ADD COLUMN end_date TEXT;
      ALTER TABLE projects ADD COLUMN avatar TEXT;
      ALTER TABLE projects ADD COLUMN next_number INTEGER NOT NULL DEFAULT 1;
      UPDATE projects SET workspace_id = 1,
        next_number = COALESCE((SELECT MAX(number) FROM tasks WHERE project_id = projects.id), 0) + 1;
      CREATE UNIQUE INDEX projects_key ON projects(key COLLATE NOCASE) WHERE key IS NOT NULL;

      -- comentários em thread, editáveis
      ALTER TABLE notes ADD COLUMN parent_id INTEGER REFERENCES notes(id) ON DELETE CASCADE;
      ALTER TABLE notes ADD COLUMN edited_at TEXT;

      ALTER TABLE dependencies ADD COLUMN type TEXT NOT NULL DEFAULT 'finish_start'
        CHECK (type IN ('finish_start','start_start','finish_finish','start_finish'));
      ALTER TABLE notifications ADD COLUMN type TEXT NOT NULL DEFAULT 'system';

      CREATE TABLE labels (
        id          INTEGER PRIMARY KEY,
        project_id  INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        color       TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE UNIQUE INDEX labels_name ON labels(COALESCE(project_id, 0), name COLLATE NOCASE);

      CREATE TABLE custom_fields (
        id         INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        type       TEXT NOT NULL CHECK (type IN ('text','number','date','boolean','select','multi_select','user','url')),
        options    TEXT NOT NULL DEFAULT '[]',
        required   INTEGER NOT NULL DEFAULT 0,
        position   REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE task_field_values (
        task_id  INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        field_id INTEGER NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
        value    TEXT NOT NULL,
        PRIMARY KEY (task_id, field_id)
      );
      CREATE TABLE task_watchers (
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, user_id)
      );

      CREATE TABLE workflows (
        id          INTEGER PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        columns     TEXT NOT NULL,
        transitions TEXT NOT NULL DEFAULT '[]',
        is_default  INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE column_transitions (
        project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_column_id INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
        to_column_id   INTEGER NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
        PRIMARY KEY (from_column_id, to_column_id)
      );

      CREATE TABLE shares (
        token      TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('task','project')),
        target_id  INTEGER NOT NULL,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );
      CREATE TABLE user_settings (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key     TEXT NOT NULL,
        value   TEXT NOT NULL,
        PRIMARY KEY (user_id, key)
      );
      CREATE TABLE password_resets (
        token      TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        used_at    TEXT
      );

      -- caixa de entrada por e-mail (IMAP) por projeto
      CREATE TABLE inboxes (
        id                  INTEGER PRIMARY KEY,
        project_id          INTEGER NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        enabled             INTEGER NOT NULL DEFAULT 1,
        address             TEXT,
        imap_host           TEXT,
        imap_port           INTEGER NOT NULL DEFAULT 993,
        imap_secure         INTEGER NOT NULL DEFAULT 1,
        imap_user           TEXT,
        imap_pass           TEXT,
        mailbox             TEXT NOT NULL DEFAULT 'INBOX',
        default_type        TEXT NOT NULL DEFAULT 'task',
        default_priority    TEXT NOT NULL DEFAULT 'medium',
        default_column_id   INTEGER REFERENCES columns(id) ON DELETE SET NULL,
        default_assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        auto_reply          INTEGER NOT NULL DEFAULT 0,
        auto_reply_template TEXT NOT NULL DEFAULT '',
        signature           TEXT NOT NULL DEFAULT '',
        sync_minutes        INTEGER NOT NULL DEFAULT 5,
        last_sync_at        TEXT,
        last_error          TEXT,
        created_at          TEXT NOT NULL
      );
      CREATE TABLE inbox_rules (
        id         INTEGER PRIMARY KEY,
        inbox_id   INTEGER NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
        name       TEXT NOT NULL,
        position   REAL NOT NULL DEFAULT 0,
        enabled    INTEGER NOT NULL DEFAULT 1,
        conditions TEXT NOT NULL DEFAULT '{}',
        actions    TEXT NOT NULL DEFAULT '{}',
        stop       INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE inbox_messages (
        id           INTEGER PRIMARY KEY,
        inbox_id     INTEGER NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
        uid          INTEGER,
        message_id   TEXT,
        from_address TEXT,
        from_name    TEXT,
        subject      TEXT,
        received_at  TEXT,
        status       TEXT NOT NULL CHECK (status IN ('task','comment','ignored','error')),
        task_id      INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        error        TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE UNIQUE INDEX inbox_messages_mid ON inbox_messages(inbox_id, message_id) WHERE message_id IS NOT NULL;

      -- importações (Jira/Trello) que podem ser sincronizadas de novo
      CREATE TABLE external_syncs (
        id           INTEGER PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind         TEXT NOT NULL CHECK (kind IN ('jira','trello')),
        config       TEXT NOT NULL,
        last_sync_at TEXT,
        last_result  TEXT,
        created_at   TEXT NOT NULL
      );

      -- comandos para o painel (ex.: o Claude pedindo para abrir uma tarefa na tela)
      CREATE TABLE ui_commands (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        command     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        consumed_at TEXT
      );
    `),
  },

  // 4: o que a sprint tinha ao terminar. As pendentes saem dela na conclusão, então sem
  // guardar isto a velocidade mostraria planejado = feito.
  (db) => db.exec(`
    ALTER TABLE sprints ADD COLUMN committed_tasks INTEGER;
    ALTER TABLE sprints ADD COLUMN committed_points REAL;
  `),

  // 5: aviso registrado só para não se repetir (quando a pessoa desligou o canal "no painel").
  (db) => db.exec('ALTER TABLE notifications ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0'),
];


const PRIORITY_RANK = { urgent: 1, high: 2, medium: 3, low: 4, lowest: 5 };
const RANK_SQL = `(CASE t.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5 END) * 1e10
  + unixepoch(t.created_at)`;
const defaultRank = (priority) => PRIORITY_RANK[priority] * 1e10 + Date.now() / 1000;

// Bloqueia de verdade: "termina → começa" com o bloqueador aberto, ou "começa → começa"
// com o bloqueador ainda não iniciado.
const OPEN_BLOCKER_SQL = `((d.type = 'finish_start' AND b.status != 'done') OR (d.type = 'start_start' AND b.status = 'todo'))`;

const TASK_SELECT = `
SELECT t.*, p.name AS project_name, p.path AS project_path, p.color AS project_color, p.key AS project_key,
       p.workspace_id, s.name AS sprint_name, s.status AS sprint_status, c.name AS column_name, pt.title AS parent_title,
       COALESCE(t.rank, ${RANK_SQL}) AS sort_rank,
       (SELECT COUNT(*) FROM notes n WHERE n.task_id = t.id AND n.kind = 'note') AS note_count,
       (SELECT COUNT(*) FROM tasks st WHERE st.parent_id = t.id AND st.archived_at IS NULL) AS subtask_count,
       (SELECT COUNT(*) FROM tasks st WHERE st.parent_id = t.id AND st.archived_at IS NULL AND st.status = 'done') AS subtask_done,
       (SELECT COUNT(*) FROM dependencies d JOIN tasks b ON b.id = d.blocked_by WHERE d.task_id = t.id AND ${OPEN_BLOCKER_SQL}) AS open_blockers,
       (SELECT COALESCE(SUM(COALESCE(e.minutes, (unixepoch('now') - unixepoch(e.started_at)) / 60)), 0)
          FROM time_entries e WHERE e.task_id = t.id) AS spent_minutes,
       (SELECT COUNT(*) FROM time_entries e WHERE e.task_id = t.id AND e.ended_at IS NULL) AS timers_running,
       (SELECT COUNT(*) FROM attachments a WHERE a.task_id = t.id) AS attachment_count,
       (SELECT json_group_array(a.user_id) FROM assignees a WHERE a.task_id = t.id) AS assignee_ids,
       (SELECT json_group_array(w.user_id) FROM task_watchers w WHERE w.task_id = t.id) AS watcher_ids,
       (SELECT json_group_object(v.field_id, json(v.value)) FROM task_field_values v WHERE v.task_id = t.id) AS field_values
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

const REF_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d+)$/;

function hydrate(row) {
  if (!row) return row;
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    recurrence: row.recurrence ? JSON.parse(row.recurrence) : null,
    assignee_ids: JSON.parse(row.assignee_ids || '[]'),
    watcher_ids: JSON.parse(row.watcher_ids || '[]'),
    field_values: JSON.parse(row.field_values || '{}'),
    ref: row.project_key && row.number ? `${row.project_key}-${row.number}` : null,
    overdue: !!row.due_date && row.status !== 'done' && row.due_date < today(),
    timer_running: row.timers_running > 0,
  };
}

function cleanKey(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const k = String(value).trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(k)) fail('O prefixo deve ter de 2 a 10 letras ou números, começando por letra (ex.: WEB)');
  return k;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  const head = [`#${t.id}${t.ref ? ` ${t.ref}` : ''}`];
  if (t.type && t.type !== 'task') head.push(`[${TYPE_LABEL[t.type]}]`);
  head.push(`[${STATUS_LABEL[t.status]}]`, `[${PRIORITY_LABEL[t.priority]}]`, t.title);
  let line = head.join(' ');
  if (t.tags?.length) line += ` (${t.tags.join(', ')})`;
  const extra = [];
  if (t.due_date) extra.push(`prazo ${t.due_date}${t.overdue ? ' (atrasada)' : ''}`);
  if (t.story_points != null) extra.push(`${t.story_points} pts`);
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
    this.dataDir = dirname(path);
    this.attachDir = join(this.dataDir, 'attachments');
    this.avatarDir = join(this.dataDir, 'avatars');
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
      const backup = join(this.dataDir, `backup-v${version()}-${Date.now()}.db`);
      this.db.exec(`VACUUM INTO '${backup.replaceAll("'", "''")}'`);
    }
    // Reconstruir tabelas exige as chaves estrangeiras desligadas (senão o DROP apagaria
    // em cascata). O PRAGMA só vale fora de transação; a integridade é conferida antes do COMMIT.
    const rebuild = MIGRATIONS.slice(version()).some((m) => m.rebuild);
    if (rebuild) this.db.exec('PRAGMA foreign_keys = OFF');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (let v = version(); v < MIGRATIONS.length; v++) {
        const m = MIGRATIONS[v];
        (typeof m === 'function' ? m : m.run)(this.db);
      }
      if (rebuild) {
        const broken = this.db.prepare('PRAGMA foreign_key_check').all();
        if (broken.length) throw new Error(`A migração deixou referências quebradas: ${JSON.stringify(broken.slice(0, 5))}`);
      }
      this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      if (rebuild) this.db.exec('PRAGMA foreign_keys = ON');
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

  secret(text) {
    return encrypt(text, this.dataDir);
  }

  // Sem a chave (data/secret.key apagada ou trocada) o segredo vira vazio em vez de derrubar o painel.
  reveal(value) {
    try {
      return decrypt(value, this.dataDir);
    } catch (e) {
      console.error('segredo ilegível (data/secret.key mudou?):', e.message);
      return '';
    }
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

  // project_ids: só esses (permissões); undefined = todos.
  listProjects({ include_archived = true, project_ids } = {}) {
    if (Array.isArray(project_ids) && !project_ids.length) return [];
    const where = [];
    if (!include_archived) where.push('p.archived_at IS NULL');
    if (project_ids) where.push(`p.id IN (${project_ids.map(Number).join(',')})`);
    return this.db.prepare(`
      SELECT p.*, w.name AS workspace_name, w.organization_id,
        COUNT(CASE WHEN t.status = 'todo' THEN 1 END)    AS todo,
        COUNT(CASE WHEN t.status = 'doing' THEN 1 END)   AS doing,
        COUNT(CASE WHEN t.status = 'blocked' THEN 1 END) AS blocked,
        COUNT(CASE WHEN t.status = 'done' THEN 1 END)    AS done,
        COUNT(CASE WHEN t.status != 'done' THEN 1 END)   AS open,
        COUNT(CASE WHEN t.status != 'done' AND t.due_date < ? THEN 1 END) AS overdue,
        COALESCE(SUM(CASE WHEN t.status = 'done' THEN t.story_points END), 0) AS points_done,
        COALESCE(SUM(t.story_points), 0) AS points_total,
        MAX(t.updated_at) AS last_activity
      FROM projects p
      LEFT JOIN workspaces w ON w.id = p.workspace_id
      LEFT JOIN tasks t ON t.project_id = p.id AND t.archived_at IS NULL
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY p.id
      ORDER BY p.archived_at IS NOT NULL, open > 0 DESC, last_activity DESC, p.name COLLATE NOCASE`).all(today());
  }

  // Encontra (ou cria) o projeto a partir de um caminho no disco, do nome, do id ou do prefixo.
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
        .prepare('SELECT * FROM projects WHERE lower(name) = lower(?) OR lower(key) = lower(?) ORDER BY lower(name) = lower(?) DESC, path IS NOT NULL DESC LIMIT 1')
        .get(name, name, name);
      return row || (create ? this.createProject(name, null) : null);
    }
    return null;
  }

  #projectFields(patch, current = {}) {
    const fields = {
      name: patch.name === undefined ? undefined : cleanText(patch.name, 'name', { required: true, max: 120 }),
      description: cleanText(patch.description, 'description'),
      color: cleanColor(patch.color),
      key: cleanKey(patch.key),
      status: cleanEnum(patch.status, 'status', PROJECT_STATUSES),
      priority: cleanEnum(patch.priority, 'priority', PRIORITIES),
      visibility: cleanEnum(patch.visibility, 'visibility', VISIBILITIES),
      start_date: cleanDate(patch.start_date, 'start_date'),
      end_date: cleanDate(patch.end_date, 'end_date'),
      workspace_id: patch.workspace_id === undefined ? undefined : (patch.workspace_id ? cleanId(patch.workspace_id, 'workspace_id') : null),
      archived_at: patch.archived === undefined ? undefined : (patch.archived ? (current.archived_at || now()) : null),
    };
    if (fields.key) {
      const other = this.db.prepare('SELECT name FROM projects WHERE lower(key) = lower(?) AND id IS NOT ?').get(fields.key, current.id ?? null);
      if (other) fail(`O prefixo ${fields.key} já é usado pelo projeto "${other.name}"`);
    }
    if (fields.workspace_id && !this.workspace(fields.workspace_id)) fail('Workspace não encontrado');
    const start = fields.start_date ?? current.start_date;
    const end = fields.end_date ?? current.end_date;
    if (start && end && end < start) fail('A data de fim do projeto não pode ser antes do início');
    return fields;
  }

  createProject(name, path = null, extra = {}) {
    return this.transaction(() => {
      const f = this.#projectFields({ ...extra, name });
      const workspace_id = f.workspace_id ?? this.db.prepare('SELECT id FROM workspaces WHERE archived_at IS NULL ORDER BY id LIMIT 1').get()?.id ?? null;
      const r = this.db.prepare(`
        INSERT INTO projects (name, path, description, color, key, status, priority, visibility, start_date, end_date, workspace_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        f.name, path, f.description || '', f.color ?? null, f.key ?? null, f.status || 'active', f.priority || 'medium',
        f.visibility || 'internal', f.start_date ?? null, f.end_date ?? null, workspace_id, now(),
      );
      const id = Number(r.lastInsertRowid);
      const workflow = this.db.prepare('SELECT id FROM workflows WHERE is_default = 1 LIMIT 1').get();
      if (workflow) this.applyWorkflow(id, workflow.id);
      const project = this.project(id);
      this.queue('project.created', { project, actor: extra.actor });
      return project;
    });
  }

  updateProject(id, patch) {
    const current = this.project(id);
    if (!current) fail(`Projeto ${id} não encontrado`);
    const entries = Object.entries(this.#projectFields(patch, current)).filter(([, v]) => v !== undefined);
    if (entries.length) {
      this.transaction(() => this.db.prepare(`UPDATE projects SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...entries.map(([, v]) => v), id));
    }
    return this.project(id);
  }

  renameProject(id, name) {
    return this.updateProject(id, { name });
  }

  deleteProject(id) {
    const files = this.db.prepare('SELECT a.stored FROM attachments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?').all(id);
    const r = this.transaction(() => {
      this.db.prepare("DELETE FROM memberships WHERE scope = 'project' AND scope_id = ?").run(id);
      this.db.prepare("DELETE FROM shares WHERE kind = 'project' AND target_id = ?").run(id);
      return this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
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

  // Transforma as 4 colunas padrão (virtuais) em colunas reais, para poder editá-las.
  materializeColumns(project_id) {
    if (!this.project(project_id)) fail(`Projeto ${project_id} não encontrado`);
    this.transaction(() => this.#seedColumns(project_id));
    return this.columns(project_id);
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

  // Coluna em que a tarefa aparece: a dela ou a primeira da categoria do status.
  columnOfTask(task) {
    const cols = this.columns(task.project_id);
    return cols.find((c) => c.id != null && c.id === task.column_id) || cols.find((c) => c.status === task.status);
  }

  createColumn(project_id, { name, status, color }) {
    if (!this.project(project_id)) fail(`Projeto ${project_id} não encontrado`);
    return this.transaction(() => {
      this.#seedColumns(project_id);
      status = cleanEnum(status, 'status', STATUSES) || 'doing';
      const last = this.db.prepare('SELECT MAX(position) AS p FROM columns WHERE project_id = ? AND status = ?').get(project_id, status);
      const r = this.db.prepare('INSERT INTO columns (project_id, name, status, color, position) VALUES (?, ?, ?, ?, ?)')
        .run(project_id, cleanText(name, 'name', { required: true, max: 60 }), status, cleanColor(color) ?? null, (last.p ?? 99) + 0.5);
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
      const color = patch.color === undefined ? col.color : cleanColor(patch.color);
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

  // ---- transições permitidas entre colunas ----
  // Sem transições cadastradas, qualquer movimento vale. Com transições, só os pares listados.

  transitions(project_id) {
    return this.db.prepare('SELECT from_column_id, to_column_id FROM column_transitions WHERE project_id = ?').all(project_id);
  }

  setTransitions(project_id, pairs) {
    return this.transaction(() => {
      this.#seedColumns(project_id);
      const list = (pairs || []).map(([from, to]) => [this.resolveColumn(project_id, from), this.resolveColumn(project_id, to)]);
      this.db.prepare('DELETE FROM column_transitions WHERE project_id = ?').run(project_id);
      const insert = this.db.prepare('INSERT OR IGNORE INTO column_transitions (project_id, from_column_id, to_column_id) VALUES (?, ?, ?)');
      for (const [a, b] of list) if (a.id !== b.id) insert.run(project_id, a.id, b.id);
      return this.transitions(project_id);
    });
  }

  allowedColumns(task) {
    const rules = this.transitions(task.project_id);
    if (!rules.length) return null;
    const from = this.columnOfTask(task);
    return [from.id, ...rules.filter((r) => r.from_column_id === from.id).map((r) => r.to_column_id)];
  }

  #checkTransition(task, target) {
    const allowed = this.allowedColumns(task);
    if (!allowed || allowed.includes(target.id)) return;
    const from = this.columnOfTask(task);
    const names = allowed.slice(1).map((cid) => this.column(cid)?.name).filter(Boolean);
    fail(`Transição não permitida: "${from.name}" → "${target.name}". A partir de "${from.name}" só pode ir para: ${names.join(', ') || 'nenhuma coluna'}`);
  }

  // ---- sprints ----

  sprints(project_id) {
    return this.db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL) AS total,
        (SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL AND t.status = 'done') AS done,
        (SELECT COALESCE(SUM(t.story_points), 0) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL) AS points_total,
        (SELECT COALESCE(SUM(t.story_points), 0) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL AND t.status = 'done') AS points_done
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
    let row;
    if (s === 'active') row = this.db.prepare("SELECT * FROM sprints WHERE project_id = ? AND status = 'active'").get(project_id);
    else if (s === 'next') {
      row = this.db.prepare("SELECT * FROM sprints WHERE project_id = ? AND status = 'planning' ORDER BY COALESCE(start_date, created_at) LIMIT 1").get(project_id);
    } else row = this.db.prepare('SELECT * FROM sprints WHERE project_id = ? AND (CAST(id AS TEXT) = ? OR lower(name) = lower(?))').get(project_id, s.replace(/^#/, ''), s);
    if (!row) fail(s === 'active' ? 'O projeto não tem sprint ativa' : s === 'next' ? 'O projeto não tem sprint planejada' : `Sprint "${ref}" não encontrada neste projeto`);
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

  startSprint(id, by) {
    const s = this.sprint(id);
    if (!s) fail(`Sprint ${id} não encontrada`);
    if (s.status === 'completed' || s.status === 'cancelled') fail('Essa sprint já foi encerrada');
    const active = this.db.prepare("SELECT name FROM sprints WHERE project_id = ? AND status = 'active' AND id != ?").get(s.project_id, id);
    if (active) fail(`A sprint "${active.name}" já está ativa. Conclua ela antes.`);
    this.transaction(() => {
      this.db.prepare("UPDATE sprints SET status = 'active', start_date = COALESCE(start_date, ?) WHERE id = ?").run(today(), id);
      this.queue('sprint.started', { sprint: this.sprint(id), actor: actorOf(by) });
    });
    return this.sprint(id);
  }

  // Tarefas não concluídas vão para outra sprint (move_to) ou para o backlog.
  completeSprint(id, { move_to = null, cancel = false } = {}, by) {
    const s = this.sprint(id);
    if (!s) fail(`Sprint ${id} não encontrada`);
    let target = null;
    if (move_to != null && move_to !== '') {
      target = this.sprint(cleanId(move_to, 'move_to'));
      if (!target || target.project_id !== s.project_id || ['completed', 'cancelled'].includes(target.status) || target.id === id) fail('Sprint de destino inválida');
    }
    return this.transaction(() => {
      const committed = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(story_points), 0) AS points FROM tasks WHERE sprint_id = ? AND archived_at IS NULL').get(id);
      const moved = this.db.prepare("UPDATE tasks SET sprint_id = ?, updated_at = ? WHERE sprint_id = ? AND status != 'done'")
        .run(target?.id ?? null, now(), id).changes;
      this.db.prepare('UPDATE sprints SET status = ?, completed_at = ?, end_date = COALESCE(end_date, ?), committed_tasks = ?, committed_points = ? WHERE id = ?')
        .run(cancel ? 'cancelled' : 'completed', now(), today(), committed.n, committed.points, id);
      const sprint = this.sprint(id);
      if (!cancel) this.queue('sprint.completed', { sprint, moved, actor: actorOf(by) });
      return { sprint, moved, moved_to: target };
    });
  }

  cancelSprint(id, opts = {}, by) {
    return this.completeSprint(id, { ...opts, cancel: true }, by);
  }

  deleteSprint(id) {
    if (!this.sprint(id)) fail(`Sprint ${id} não encontrada`);
    this.transaction(() => this.db.prepare('DELETE FROM sprints WHERE id = ?').run(id));
  }

  // ---- tarefas ----

  task(id) {
    return hydrate(this.db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id));
  }

  // Aceita 12, "#12" ou o código do projeto "WEB-12".
  resolveTaskRef(ref) {
    const s = String(ref ?? '').trim();
    const m = s.match(REF_RE);
    if (m) {
      const row = this.db.prepare('SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE lower(p.key) = lower(?) AND t.number = ?').get(m[1], Number(m[2]));
      if (!row) fail(`Tarefa ${s.toUpperCase()} não encontrada`);
      return row.id;
    }
    return cleanId(s);
  }

  taskWithNotes(id) {
    const task = this.task(id);
    if (!task) return null;
    task.notes = this.db.prepare(`
      SELECT n.*, u.name AS user_name, u.color AS user_color, u.avatar AS user_avatar FROM notes n LEFT JOIN users u ON u.id = n.user_id
      WHERE n.task_id = ? ORDER BY n.created_at, n.id`).all(id);
    task.subtasks = this.listTasks({ parent_id: id, status: 'all', include_archived: false, limit: 500 })
      .sort((a, b) => a.sort_rank - b.sort_rank || a.id - b.id);
    task.blockers = this.blockers(id);
    task.blocking = this.blocking(id);
    task.time_entries = this.timeEntries(id);
    task.attachments = this.attachments(id);
    task.columns = this.columns(task.project_id);
    task.allowed_columns = this.allowedColumns(task);
    task.fields = this.fieldsWithValues(task);
    task.watchers = this.watchersOf(id);
    task.reporter = task.reporter_id ? this.user(task.reporter_id) : null;
    task.labels = this.labels(task.project_id);
    return task;
  }

  // status: 'open' (tudo que não está concluído), 'all' ou um status específico.
  listTasks({
    project_id, project_ids, status = 'open', q, limit = 200, sprint_id, assignee_id, reporter_id, watcher_id, type, parent_id,
    top_level = false, due, include_archived = false, done_since, tag,
  } = {}) {
    if (Array.isArray(project_ids) && !project_ids.length) return [];
    const where = [];
    const args = [];
    if (project_id) { where.push('t.project_id = ?'); args.push(project_id); }
    if (project_ids) where.push(`t.project_id IN (${project_ids.map(Number).join(',')})`);
    if (status === 'open') where.push("t.status != 'done'");
    else if (status !== 'all') { where.push('t.status = ?'); args.push(cleanEnum(status, 'status', STATUSES)); }
    if (done_since) { where.push("(t.status != 'done' OR t.completed_at >= ?)"); args.push(done_since); }
    if (!include_archived) where.push('t.archived_at IS NULL');
    if (sprint_id === 'none') where.push('t.sprint_id IS NULL');
    else if (sprint_id) { where.push('t.sprint_id = ?'); args.push(sprint_id); }
    if (assignee_id) { where.push('EXISTS (SELECT 1 FROM assignees a WHERE a.task_id = t.id AND a.user_id = ?)'); args.push(assignee_id); }
    if (watcher_id) { where.push('EXISTS (SELECT 1 FROM task_watchers w WHERE w.task_id = t.id AND w.user_id = ?)'); args.push(watcher_id); }
    if (reporter_id) { where.push('t.reporter_id = ?'); args.push(reporter_id); }
    if (type) { where.push('t.type = ?'); args.push(cleanEnum(type, 'type', TYPES)); }
    if (tag) { where.push('EXISTS (SELECT 1 FROM json_each(t.tags) j WHERE lower(j.value) = lower(?))'); args.push(tag); }
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
      const s = String(q).trim();
      const ref = s.match(REF_RE);
      if (ref) { where.push('(lower(p.key) = lower(?) AND t.number = ?)'); args.push(ref[1], Number(ref[2])); }
      else {
        const like = `%${s.replace(/^#/, '')}%`;
        where.push('(t.title LIKE ? OR t.description LIKE ? OR t.tags LIKE ? OR CAST(t.id AS TEXT) = ?)');
        args.push(like, like, like, s.replace(/^#/, ''));
      }
    }
    const sql = `${TASK_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ${ORDER_SQL} LIMIT ?`;
    return this.db.prepare(sql).all(...args, Math.min(Number(limit) || 200, 5000)).map(hydrate);
  }

  #nextNumber(project_id) {
    const { next_number: n } = this.db.prepare('SELECT next_number FROM projects WHERE id = ?').get(project_id);
    this.db.prepare('UPDATE projects SET next_number = next_number + 1 WHERE id = ?').run(project_id);
    return n;
  }

  #userRef(ref, field) {
    if (ref === undefined) return undefined;
    if (ref === null || ref === '') return null;
    const u = this.findUser(ref);
    if (!u) fail(`"${field}": usuário "${ref}" não encontrado`);
    return u.id;
  }

  // Não duplica: se já houver uma tarefa aberta com o mesmo título no mesmo lugar, devolve ela.
  addTask(project_id, input, by = 'claude') {
    const actor = actorOf(by);
    return this.transaction(() => {
      const title = cleanText(input.title, 'title', { required: true, max: 300 });
      let parent_id = null;
      if (input.parent_id != null && input.parent_id !== '') {
        const parent = this.task(this.resolveTaskRef(input.parent_id));
        if (!parent) fail(`Tarefa-mãe #${input.parent_id} não encontrada`);
        parent_id = parent.id;
        project_id = parent.project_id;
      }
      if (input.external_source && input.external_id) {
        const ext = this.db.prepare('SELECT id FROM tasks WHERE external_source = ? AND external_id = ?').get(input.external_source, String(input.external_id));
        if (ext) return { task: this.task(ext.id), duplicate: true };
      } else {
        const existing = this.db.prepare(`
          SELECT id FROM tasks WHERE project_id = ? AND parent_id IS ? AND status != 'done' AND archived_at IS NULL
          AND lower(title) = lower(?)`).get(project_id, parent_id, title);
        if (existing) return { task: this.task(existing.id), duplicate: true };
      }

      const column = input.column != null && input.column !== '' ? this.resolveColumn(project_id, input.column) : null;
      const status = column?.status || cleanEnum(input.status, 'status', STATUSES) || 'todo';
      const priority = cleanEnum(input.priority, 'priority', PRIORITIES) || 'medium';
      const ts = input.created_at || now();
      const r = this.db.prepare(`
        INSERT INTO tasks (project_id, number, title, description, status, priority, type, tags, source, parent_id, sprint_id,
          column_id, reporter_id, start_date, due_date, estimate_minutes, remaining_minutes, story_points, rank, recurrence,
          external_source, external_id, created_by, created_at, updated_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project_id,
        this.#nextNumber(project_id),
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
        this.#userRef(input.reporter ?? input.reporter_id, 'reporter') ?? actor.user_id ?? null,
        cleanDate(input.start_date, 'start_date') ?? null,
        cleanDate(input.due_date, 'due_date') ?? null,
        parseDuration(input.estimate ?? input.estimate_minutes, 'estimate') ?? null,
        parseDuration(input.remaining ?? input.remaining_minutes, 'remaining') ?? null,
        cleanPoints(input.story_points) ?? null,
        defaultRank(priority),
        cleanRecurrence(input.recurrence) ?? null,
        input.external_source || null,
        input.external_id != null ? String(input.external_id) : null,
        actor.user_id ?? null,
        ts,
        input.updated_at || ts,
        status === 'done' ? (input.completed_at || ts) : null,
      );
      const id = Number(r.lastInsertRowid);
      if (input.blocked_by?.length) this.setBlockers(id, input.blocked_by);
      if (input.assignees?.length || input.assignee_ids?.length) this.setAssignees(id, input.assignees ?? input.assignee_ids, actor);
      if (input.watchers?.length) this.setWatchers(id, input.watchers);
      if (input.fields && Object.keys(input.fields).length) this.setFieldValues(id, input.fields);
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
      remaining_minutes: parseDuration(patch.remaining ?? patch.remaining_minutes, 'remaining'),
      story_points: cleanPoints(patch.story_points),
      reporter_id: this.#userRef(patch.reporter ?? patch.reporter_id, 'reporter'),
      recurrence: cleanRecurrence(patch.recurrence),
      rank: patch.rank == null ? undefined : Number(patch.rank),
      archived_at: patch.archived === undefined ? undefined : (patch.archived ? (current.archived_at || now()) : null),
    };

    const projectId = fields.project_id ?? current.project_id;
    const moving = fields.project_id && fields.project_id !== current.project_id;
    if (moving) {
      if (!this.project(fields.project_id)) fail(`Projeto ${fields.project_id} não encontrado`);
      fields.column_id = null;
      fields.sprint_id = null;
      fields.number = this.#nextNumber(fields.project_id);
      if (current.parent_id) fields.parent_id = null;
    }

    if (patch.column != null && patch.column !== '') {
      const col = this.resolveColumn(projectId, patch.column);
      if (!moving) this.#checkTransition(current, col);
      fields.status = col.status;
      fields.column_id = col.id;
    } else if (fields.status && fields.status !== current.status) {
      if (!moving) this.#checkTransition(current, this.columns(projectId).find((c) => c.status === fields.status));
      fields.column_id = null;
    }

    const sprint = patch.sprint !== undefined ? patch.sprint : patch.sprint_id;
    if (sprint !== undefined && !(moving && sprint == null)) fields.sprint_id = this.resolveSprint(projectId, sprint);

    if (patch.parent_id !== undefined) {
      if (patch.parent_id === null || patch.parent_id === '') fields.parent_id = null;
      else {
        const parentId = this.resolveTaskRef(patch.parent_id);
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
    if (changes.reporter_id) this.logEvent(id, actor, fields.reporter_id ? `relator: ${this.user(fields.reporter_id)?.name}` : 'relator removido', ts);

    if (sets.length) {
      sets.push('updated_at = ?');
      args.push(ts);
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    // Subtarefas acompanham a mãe quando ela muda de projeto (com numeração nova).
    if (moving) {
      for (const sub of this.db.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(id)) {
        this.db.prepare('UPDATE tasks SET project_id = ?, number = ?, column_id = NULL, sprint_id = NULL, updated_at = ? WHERE id = ?')
          .run(fields.project_id, this.#nextNumber(fields.project_id), ts, sub.id);
      }
    }
    if (patch.blocked_by !== undefined) this.setBlockers(id, patch.blocked_by || []);
    if (patch.assignees !== undefined || patch.assignee_ids !== undefined) {
      this.setAssignees(id, patch.assignees ?? patch.assignee_ids ?? [], actor);
    }
    if (patch.watchers !== undefined) this.setWatchers(id, patch.watchers || []);
    if (patch.fields !== undefined) this.setFieldValues(id, patch.fields || {});

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
    const n = rule.n || 1;
    if (rule.count && n >= rule.count) {
      this.logEvent(task.id, actor, `recorrência encerrada (${rule.count} ocorrências)`);
      return null;
    }
    const base = task.due_date || today();
    let due = nextOccurrence(base, rule);
    while (due < today()) due = nextOccurrence(due, rule);
    if (rule.until && due > rule.until) {
      this.logEvent(task.id, actor, 'recorrência encerrada');
      return null;
    }
    const nextRule = rule.count ? { ...rule, n: n + 1 } : rule;
    const start = task.start_date ? addDays(due, -daysBetween(task.start_date, base)) : null;
    const ts = now();
    const r = this.db.prepare(`
      INSERT INTO tasks (project_id, number, title, description, status, priority, type, tags, source, parent_id, column_id,
        reporter_id, start_date, due_date, estimate_minutes, story_points, rank, recurrence, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      task.project_id, this.#nextNumber(task.project_id), task.title, task.description, task.priority, task.type, JSON.stringify(task.tags),
      'automação', task.parent_id, task.reporter_id, start, due, task.estimate_minutes, task.story_points, defaultRank(task.priority),
      JSON.stringify(nextRule), task.created_by, ts, ts,
    );
    const nextId = Number(r.lastInsertRowid);
    this.db.prepare('INSERT INTO assignees (task_id, user_id) SELECT ?, user_id FROM assignees WHERE task_id = ?').run(nextId, task.id);
    this.db.prepare('INSERT INTO task_watchers (task_id, user_id) SELECT ?, user_id FROM task_watchers WHERE task_id = ?').run(nextId, task.id);
    this.db.prepare('INSERT INTO task_field_values (task_id, field_id, value) SELECT ?, field_id, value FROM task_field_values WHERE task_id = ?').run(nextId, task.id);
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
    const r = this.transaction(() => {
      this.db.prepare("DELETE FROM shares WHERE kind = 'task' AND target_id = ?").run(id);
      return this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    });
    if (!r.changes) fail(`Tarefa #${id} não encontrada`);
    this.#removeFiles(files);
  }

  // ---- comentários (com respostas e menções) ----

  note(id) {
    return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  }

  // Quem foi citado com @Nome (nome completo ou primeiro nome).
  // Pessoas mencionadas com @ que enxergam o projeto (as outras não são avisadas).
  mentionsIn(body, project_id) {
    const text = String(body || '');
    if (!text.includes('@')) return [];
    return this.listUsers().filter((u) => !project_id || this.can(u, project_id, 'read')).filter((u) => {
      const names = [u.name, u.name.split(/\s+/)[0]];
      return names.some((n) => new RegExp(`(^|\\s)@${escapeRe(n)}(?![\\p{L}\\p{N}])`, 'iu').test(text));
    }).map((u) => u.id);
  }

  addNote(task_id, body, by = 'claude', { parent_id = null } = {}) {
    const actor = actorOf(by);
    body = cleanText(body, 'body', { required: true });
    const task = this.task(task_id);
    if (!task) fail(`Tarefa #${task_id} não encontrada`);
    if (parent_id) {
      const parent = this.note(cleanId(parent_id, 'parent_id'));
      if (!parent || parent.task_id !== task.id || parent.kind !== 'note') fail('Comentário de origem não encontrado nesta tarefa');
      parent_id = parent.parent_id || parent.id;
    }
    const ts = now();
    return this.transaction(() => {
      const r = this.db.prepare("INSERT INTO notes (task_id, kind, author, user_id, body, parent_id, created_at) VALUES (?, 'note', ?, ?, ?, ?, ?)")
        .run(task_id, actor.author, actor.user_id ?? null, body, parent_id, ts);
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, task_id);
      const note = { id: Number(r.lastInsertRowid), body, parent_id };
      this.queue('task.commented', { task, note, actor, mentions: this.mentionsIn(body, task.project_id) });
      return note.id;
    });
  }

  updateNote(id, body, by) {
    const note = this.note(id);
    if (!note || note.kind !== 'note') fail('Comentário não encontrado');
    body = cleanText(body, 'body', { required: true });
    const projectId = this.task(note.task_id)?.project_id;
    const before = new Set(this.mentionsIn(note.body, projectId));
    this.transaction(() => {
      this.db.prepare('UPDATE notes SET body = ?, edited_at = ? WHERE id = ?').run(body, now(), id);
      const added = this.mentionsIn(body, projectId).filter((u) => !before.has(u));
      if (added.length) this.queue('task.commented', { task: this.task(note.task_id), note: { id, body }, actor: actorOf(by), mentions: added, edited: true });
    });
    return this.note(id);
  }

  deleteNote(id) {
    const note = this.note(id);
    if (!note || note.kind !== 'note') fail('Comentário não encontrado');
    this.transaction(() => this.db.prepare('DELETE FROM notes WHERE id = ?').run(id));
  }

  // ---- dependências ----
  // "A bloqueada por B" com tipo: finish_start (padrão: B termina → A começa), start_start,
  // finish_finish, start_finish. Só finish_start e start_start impedem começar.

  blockers(task_id) {
    return this.db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.start_date, t.project_id, p.name AS project_name, d.type
      FROM dependencies d JOIN tasks t ON t.id = d.blocked_by JOIN projects p ON p.id = t.project_id
      WHERE d.task_id = ? ORDER BY t.id`).all(task_id);
  }

  blocking(task_id) {
    return this.db.prepare(`
      SELECT t.id, t.title, t.status, t.priority, t.due_date, t.start_date, t.project_id, p.name AS project_name, d.type
      FROM dependencies d JOIN tasks t ON t.id = d.task_id JOIN projects p ON p.id = t.project_id
      WHERE d.blocked_by = ? ORDER BY t.id`).all(task_id);
  }

  allDependencies(task_ids) {
    if (!task_ids.length) return [];
    const marks = task_ids.map(() => '?').join(',');
    return this.db.prepare(`SELECT task_id, blocked_by, type FROM dependencies WHERE task_id IN (${marks}) OR blocked_by IN (${marks})`)
      .all(...task_ids, ...task_ids);
  }

  #dependsOn(from, target, seen = new Set()) {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return this.db.prepare('SELECT blocked_by FROM dependencies WHERE task_id = ?').all(from)
      .some((r) => this.#dependsOn(r.blocked_by, target, seen));
  }

  // ids: [12, 13] ou [{ id: 12, type: 'start_start' }]. Substitui a lista.
  setBlockers(task_id, ids) {
    const raw = Array.isArray(ids) ? ids : String(ids).split(',');
    const list = [];
    for (const item of raw) {
      if (item == null || String(item.id ?? item).trim() === '') continue;
      const id = this.resolveTaskRef(item.id ?? item);
      const type = cleanEnum(item.type, 'type', DEPENDENCY_TYPES) || 'finish_start';
      if (!list.some((x) => x.id === id)) list.push({ id, type });
    }
    this.transaction(() => {
      for (const { id: b } of list) {
        if (b === task_id) fail('Uma tarefa não pode bloquear ela mesma');
        if (!this.task(b)) fail(`Tarefa #${b} não encontrada`);
        if (this.#dependsOn(b, task_id)) fail(`#${b} já depende de #${task_id}: isso criaria um ciclo`);
      }
      this.db.prepare('DELETE FROM dependencies WHERE task_id = ?').run(task_id);
      const insert = this.db.prepare('INSERT INTO dependencies (task_id, blocked_by, type, created_at) VALUES (?, ?, ?, ?)');
      for (const { id: b, type } of list) insert.run(task_id, b, type, now());
    });
  }

  addBlocker(task_id, blocked_by, type = 'finish_start') {
    const current = this.blockers(task_id).filter((b) => b.id !== blocked_by).map((b) => ({ id: b.id, type: b.type }));
    this.setBlockers(task_id, [...current, { id: blocked_by, type }]);
  }

  removeBlocker(task_id, blocked_by) {
    this.transaction(() => this.db.prepare('DELETE FROM dependencies WHERE task_id = ? AND blocked_by = ?').run(task_id, blocked_by));
  }
}

Object.assign(Store.prototype, teamMethods, workMethods, insightMethods, orgMethods, metaMethods);
