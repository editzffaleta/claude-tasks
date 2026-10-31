// Configurações, estatísticas do dashboard, feed de atividade e cadastro de automações.
import { ACTIONS, PRIORITIES, STATUSES, TRIGGERS, addDays, cleanEnum, cleanText, fail, localDate, now, today } from '../util.js';

export const DEFAULT_SETTINGS = {
  notify_macos: true,
  due_soon_days: 1,
  chat_model: 'sonnet',
};

function mondayOf(date) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localDate(d);
}

function parseAutomation(row) {
  if (!row) return row;
  return { ...row, enabled: !!row.enabled, conditions: JSON.parse(row.conditions || '{}'), action: JSON.parse(row.action) };
}

function cleanAutomation(input, current = {}) {
  const trigger = cleanEnum(input.trigger, 'trigger', Object.keys(TRIGGERS)) || current.trigger;
  if (!trigger) fail('Escolha o gatilho');
  const action = input.action ?? current.action;
  if (!action || !ACTIONS[action.type]) fail('Escolha uma ação válida');
  if (action.type === 'set_status') cleanEnum(action.value, 'action.value', STATUSES);
  if (action.type === 'set_priority') cleanEnum(action.value, 'action.value', PRIORITIES);
  if (['add_tag', 'remove_tag', 'add_comment', 'notify', 'assign'].includes(action.type) && !String(action.value ?? '').trim()) {
    fail('Preencha o valor da ação');
  }
  if (action.type === 'set_due_in_days' && !(Number(action.value) >= 0)) fail('Informe em quantos dias');
  if (trigger === 'status_changed' && action.type === 'set_status') fail('Gatilho e ação não podem ser ambos de status (entraria em ciclo)');
  return { trigger, action };
}

export const insightMethods = {
  // ---- configurações ----

  settings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)])) };
  },

  setting(key) {
    return this.settings()[key];
  },

  updateSettings(patch) {
    this.transaction(() => {
      for (const [key, value] of Object.entries(patch)) {
        if (!(key in DEFAULT_SETTINGS) && !key.startsWith('chat_session:')) continue;
        this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
          .run(key, JSON.stringify(value));
      }
    });
    return this.settings();
  },

  // ---- dashboard ----

  stats({ project_id } = {}) {
    const d = today();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const scope = project_id ? 'AND t.project_id = ?' : '';
    const args = project_id ? [project_id] : [];

    const totals = this.db.prepare(`
      SELECT COUNT(CASE WHEN status != 'done' THEN 1 END) AS open,
             COUNT(CASE WHEN status = 'doing' THEN 1 END) AS doing,
             COUNT(CASE WHEN status = 'blocked' THEN 1 END) AS blocked,
             COUNT(CASE WHEN status != 'done' AND due_date < ? THEN 1 END) AS overdue,
             COUNT(CASE WHEN status != 'done' AND due_date BETWEEN ? AND ? THEN 1 END) AS due_week,
             COUNT(CASE WHEN status = 'done' AND completed_at >= ? THEN 1 END) AS done_7d,
             COUNT(CASE WHEN created_at >= ? THEN 1 END) AS created_7d,
             COUNT(CASE WHEN created_at >= ? AND source = 'claude' THEN 1 END) AS claude_7d,
             COUNT(*) AS total
      FROM tasks t WHERE archived_at IS NULL ${scope}`).get(d, d, addDays(d, 7), weekAgo, weekAgo, weekAgo, ...args);

    totals.minutes_7d = this.db.prepare(`
      SELECT COALESCE(SUM(COALESCE(e.minutes, (unixepoch('now') - unixepoch(e.started_at)) / 60)), 0) AS m
      FROM time_entries e JOIN tasks t ON t.id = e.task_id WHERE e.started_at >= ? ${scope}`).get(weekAgo, ...args).m;

    // Criadas x concluídas nas últimas 8 semanas (semana começando na segunda).
    const firstWeek = addDays(mondayOf(d), -7 * 7);
    const weeks = Array.from({ length: 8 }, (_, i) => ({ week: addDays(firstWeek, i * 7), created: 0, done: 0 }));
    const index = new Map(weeks.map((w, i) => [w.week, i]));
    const since = new Date(`${firstWeek}T00:00:00`).toISOString();
    for (const r of this.db.prepare(`
      SELECT created_at, completed_at FROM tasks t WHERE archived_at IS NULL AND (created_at >= ? OR completed_at >= ?) ${scope}`)
      .all(since, since, ...args)) {
      const c = index.get(mondayOf(localDate(new Date(r.created_at))));
      if (c !== undefined) weeks[c].created++;
      if (r.completed_at) {
        const k = index.get(mondayOf(localDate(new Date(r.completed_at))));
        if (k !== undefined) weeks[k].done++;
      }
    }

    const byPriority = Object.fromEntries(PRIORITIES.map((p) => [p, 0]));
    for (const r of this.db.prepare(`
      SELECT priority, COUNT(*) AS n FROM tasks t WHERE status != 'done' AND archived_at IS NULL ${scope} GROUP BY priority`).all(...args)) {
      byPriority[r.priority] = r.n;
    }

    const byProject = project_id ? [] : this.listProjects({ include_archived: false })
      .filter((p) => p.open + p.done > 0)
      .map((p) => ({ id: p.id, name: p.name, color: p.color, todo: p.todo, doing: p.doing, blocked: p.blocked, open: p.open, overdue: p.overdue }));

    const timeByProject = this.db.prepare(`
      SELECT p.id, p.name, p.color, SUM(COALESCE(e.minutes, (unixepoch('now') - unixepoch(e.started_at)) / 60)) AS minutes
      FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
      WHERE e.started_at >= ? ${scope} GROUP BY p.id ORDER BY minutes DESC LIMIT 8`).all(weekAgo, ...args);

    const upcoming = this.listTasks({ project_id, status: 'open', due: 'any', limit: 500 })
      .sort((a, b) => a.due_date.localeCompare(b.due_date) || a.sort_rank - b.sort_rank)
      .slice(0, 10);

    const sprint = project_id
      ? this.db.prepare(`
          SELECT s.*, (SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL) AS total,
                 (SELECT COUNT(*) FROM tasks t WHERE t.sprint_id = s.id AND t.archived_at IS NULL AND t.status = 'done') AS done
          FROM sprints s WHERE s.project_id = ? AND s.status = 'active'`).get(project_id) || null
      : null;

    return { totals, weeks, byPriority, byProject, timeByProject, upcoming, sprint, activity: this.activity({ project_id, limit: 20 }) };
  },

  // Tempo registrado num período (datas locais, inclusivas), agrupado por tarefa, projeto, dia ou pessoa.
  timeReport({ project_id, from, to, group_by = 'task' } = {}) {
    const end = to || today();
    const start = from || addDays(end, -6);
    const scope = project_id ? 'AND t.project_id = ?' : '';
    const entries = this.db.prepare(`
      SELECT e.id, e.task_id, e.author, e.note, e.started_at, e.ended_at, t.title, t.project_id, p.name AS project_name,
             u.name AS user_name, date(e.started_at, 'localtime') AS day,
             COALESCE(e.minutes, (unixepoch('now') - unixepoch(e.started_at)) / 60) AS minutes
      FROM time_entries e JOIN tasks t ON t.id = e.task_id JOIN projects p ON p.id = t.project_id
      LEFT JOIN users u ON u.id = e.user_id
      WHERE date(e.started_at, 'localtime') BETWEEN ? AND ? ${scope}
      ORDER BY e.started_at`).all(start, end, ...(project_id ? [project_id] : []));
    const keyOf = {
      task: (e) => [`#${e.task_id}`, `#${e.task_id} ${e.title} (${e.project_name})`],
      project: (e) => [String(e.project_id), e.project_name],
      day: (e) => [e.day, e.day],
      person: (e) => [e.user_name || e.author, e.user_name || (e.author === 'claude' ? 'Claude' : e.author)],
    }[group_by];
    if (!keyOf) fail('"group_by" deve ser task, project, day ou person');
    const groups = new Map();
    for (const e of entries) {
      const [key, label] = keyOf(e);
      if (!groups.has(key)) groups.set(key, { key, label, minutes: 0, entries: 0 });
      const g = groups.get(key);
      g.minutes += e.minutes;
      g.entries++;
    }
    return {
      from: start,
      to: end,
      total: entries.reduce((n, e) => n + e.minutes, 0),
      groups: [...groups.values()].sort((a, b) => (group_by === 'day' ? a.key.localeCompare(b.key) : b.minutes - a.minutes)),
      entries,
    };
  },

  activity({ project_id, limit = 30 } = {}) {
    const scope = project_id ? 'AND t.project_id = ?' : '';
    const args = project_id ? [project_id, project_id] : [];
    return this.db.prepare(`
      SELECT * FROM (
        SELECT 'created' AS kind, t.id AS task_id, t.title, p.name AS project_name, t.source AS author, u.name AS user_name,
               NULL AS body, t.created_at
        FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.created_by
        WHERE t.archived_at IS NULL ${scope}
        UNION ALL
        SELECT n.kind, t.id, t.title, p.name, n.author, u.name, n.body, n.created_at
        FROM notes n JOIN tasks t ON t.id = n.task_id JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = n.user_id
        WHERE 1 = 1 ${scope}
      ) ORDER BY created_at DESC LIMIT ?`).all(...args, limit);
  },

  // ---- automações ----

  listAutomations() {
    return this.db.prepare(`
      SELECT a.*, p.name AS project_name FROM automations a LEFT JOIN projects p ON p.id = a.project_id
      ORDER BY a.created_at`).all().map(parseAutomation);
  },

  automation(id) {
    return parseAutomation(this.db.prepare('SELECT * FROM automations WHERE id = ?').get(id));
  },

  automationsFor(trigger, project_id) {
    return this.db.prepare(`
      SELECT * FROM automations WHERE enabled = 1 AND trigger = ? AND (project_id IS NULL OR project_id = ?)`)
      .all(trigger, project_id).map(parseAutomation);
  },

  createAutomation(input) {
    const { trigger, action } = cleanAutomation(input);
    const project_id = input.project_id ? Number(input.project_id) : null;
    if (project_id && !this.project(project_id)) fail('Projeto não encontrado');
    const r = this.transaction(() => this.db.prepare(`
      INSERT INTO automations (project_id, name, trigger, conditions, action, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(project_id, cleanText(input.name, 'name', { required: true, max: 120 }), trigger,
        JSON.stringify(input.conditions || {}), JSON.stringify(action), input.enabled === false ? 0 : 1, now()));
    return this.automation(Number(r.lastInsertRowid));
  },

  updateAutomation(id, patch) {
    const current = this.automation(id);
    if (!current) fail('Automação não encontrada');
    const { trigger, action } = cleanAutomation(patch, current);
    const project_id = patch.project_id === undefined ? current.project_id : (patch.project_id ? Number(patch.project_id) : null);
    this.transaction(() => this.db.prepare(`
      UPDATE automations SET name = ?, project_id = ?, trigger = ?, conditions = ?, action = ?, enabled = ? WHERE id = ?`)
      .run(patch.name === undefined ? current.name : cleanText(patch.name, 'name', { required: true, max: 120 }), project_id, trigger,
        JSON.stringify(patch.conditions ?? current.conditions), JSON.stringify(action),
        (patch.enabled ?? current.enabled) ? 1 : 0, id));
    return this.automation(id);
  },

  deleteAutomation(id) {
    const r = this.transaction(() => this.db.prepare('DELETE FROM automations WHERE id = ?').run(id));
    if (!r.changes) fail('Automação não encontrada');
  },

  recordAutomationRun(id, task_id = null) {
    this.db.prepare('UPDATE automations SET run_count = run_count + 1, last_run_at = ? WHERE id = ?').run(now(), id);
    if (task_id) this.db.prepare('INSERT OR IGNORE INTO automation_fired (automation_id, task_id, fired_at) VALUES (?, ?, ?)').run(id, task_id, now());
  },

  alreadyFired(automation_id, task_id) {
    return !!this.db.prepare('SELECT 1 FROM automation_fired WHERE automation_id = ? AND task_id = ?').get(automation_id, task_id);
  },

  // ---- chat ----

  chatHistory(user_id, limit = 60) {
    return this.db.prepare('SELECT * FROM chat_messages WHERE user_id IS ? ORDER BY id DESC LIMIT ?').all(user_id ?? null, limit)
      .reverse().map((m) => ({ ...m, tools: JSON.parse(m.tools) }));
  },

  addChatMessage(user_id, role, body, tools = []) {
    this.transaction(() => this.db.prepare('INSERT INTO chat_messages (user_id, role, body, tools, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(user_id ?? null, role, body, JSON.stringify(tools), now()));
  },

  clearChat(user_id) {
    this.transaction(() => {
      this.db.prepare('DELETE FROM chat_messages WHERE user_id IS ?').run(user_id ?? null);
      this.db.prepare('DELETE FROM settings WHERE key = ?').run(`chat_session:${user_id ?? 0}`);
    });
  },
};
