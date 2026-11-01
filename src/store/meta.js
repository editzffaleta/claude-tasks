// Labels, campos personalizados, observadores, modelos de workflow e busca universal.
import { COLUMN_NAME, FIELD_TYPES, STATUSES, cleanColor, cleanDate, cleanEnum, cleanId, cleanText, fail, now } from '../util.js';

const LABEL_COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6', '#e34948', '#008300', '#7c7c84'];

function parseField(row) {
  return row && { ...row, options: JSON.parse(row.options || '[]'), required: !!row.required };
}

function parseWorkflow(row) {
  return row && { ...row, columns: JSON.parse(row.columns), transitions: JSON.parse(row.transitions || '[]'), is_default: !!row.is_default };
}

export const metaMethods = {
  // ---- labels (tags com cor e descrição; project_id null = de todos os projetos) ----
  // As tarefas continuam guardando os nomes em tasks.tags; o label só dá cor e descrição.

  labels(project_id) {
    return this.db.prepare(`
      SELECT l.*, (SELECT COUNT(*) FROM tasks t, json_each(t.tags) j
                   WHERE lower(j.value) = lower(l.name) AND (l.project_id IS NULL OR t.project_id = l.project_id)) AS usage
      FROM labels l WHERE l.project_id IS NULL ${project_id ? 'OR l.project_id = ?' : ''}
      ORDER BY l.project_id IS NULL, l.name COLLATE NOCASE`).all(...(project_id ? [project_id] : []));
  },

  label(id) {
    return this.db.prepare('SELECT * FROM labels WHERE id = ?').get(id);
  },

  createLabel({ project_id = null, name, color, description }) {
    const n = cleanText(name, 'name', { required: true, max: 40 });
    if (project_id && !this.project(project_id)) fail('Projeto não encontrado');
    if (this.db.prepare('SELECT 1 FROM labels WHERE project_id IS ? AND lower(name) = lower(?)').get(project_id || null, n)) fail(`Já existe o label "${n}"`);
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM labels').get().n;
    const r = this.transaction(() => this.db.prepare('INSERT INTO labels (project_id, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(project_id || null, n, cleanColor(color) || LABEL_COLORS[count % LABEL_COLORS.length], cleanText(description, 'description', { max: 300 }) || '', now()));
    return this.label(Number(r.lastInsertRowid));
  },

  // Renomear atualiza as tarefas que usam o nome antigo.
  updateLabel(id, patch) {
    const l = this.label(id);
    if (!l) fail('Label não encontrado');
    const name = patch.name === undefined ? l.name : cleanText(patch.name, 'name', { required: true, max: 40 });
    this.transaction(() => {
      if (name.toLowerCase() !== l.name.toLowerCase()) {
        if (this.db.prepare('SELECT 1 FROM labels WHERE project_id IS ? AND lower(name) = lower(?) AND id != ?').get(l.project_id, name, id)) fail(`Já existe o label "${name}"`);
        this._renameTag(l.project_id, l.name, name);
      }
      this.db.prepare('UPDATE labels SET name = ?, color = ?, description = ? WHERE id = ?').run(
        name, patch.color === undefined ? l.color : (cleanColor(patch.color) || l.color),
        patch.description === undefined ? l.description : (cleanText(patch.description, 'description', { max: 300 }) || ''), id);
    });
    return this.label(id);
  },

  deleteLabel(id, { remove_from_tasks = true } = {}) {
    const l = this.label(id);
    if (!l) fail('Label não encontrado');
    this.transaction(() => {
      if (remove_from_tasks) this._renameTag(l.project_id, l.name, null);
      this.db.prepare('DELETE FROM labels WHERE id = ?').run(id);
    });
  },

  _renameTag(project_id, from, to) {
    const rows = this.db.prepare(`
      SELECT DISTINCT t.id, t.tags FROM tasks t, json_each(t.tags) j
      WHERE lower(j.value) = lower(?) ${project_id ? 'AND t.project_id = ?' : ''}`).all(from, ...(project_id ? [project_id] : []));
    const update = this.db.prepare('UPDATE tasks SET tags = ?, updated_at = ? WHERE id = ?');
    for (const r of rows) {
      const tags = JSON.parse(r.tags).flatMap((t) => (t.toLowerCase() === from.toLowerCase() ? (to ? [to] : []) : [t]));
      update.run(JSON.stringify([...new Set(tags)]), now(), r.id);
    }
  },

  // ---- campos personalizados (project_id null = todos os projetos) ----

  customFields(project_id) {
    return this.db.prepare(`SELECT * FROM custom_fields WHERE project_id IS NULL ${project_id ? 'OR project_id = ?' : ''} ORDER BY position, id`)
      .all(...(project_id ? [project_id] : [])).map(parseField);
  },

  customField(id) {
    return parseField(this.db.prepare('SELECT * FROM custom_fields WHERE id = ?').get(id));
  },

  _cleanOptions(type, options) {
    if (type !== 'select' && type !== 'multi_select') return [];
    const list = [...new Set((Array.isArray(options) ? options : String(options || '').split(',')).map((o) => String(o).trim()).filter(Boolean))];
    if (!list.length) fail('Campos de seleção precisam de opções');
    return list.slice(0, 50);
  },

  createField({ project_id = null, name, type, options, required = false }) {
    const t = cleanEnum(type, 'type', FIELD_TYPES) || fail('Escolha o tipo do campo');
    if (project_id && !this.project(project_id)) fail('Projeto não encontrado');
    const last = this.db.prepare('SELECT MAX(position) AS p FROM custom_fields').get().p ?? 0;
    const r = this.transaction(() => this.db.prepare('INSERT INTO custom_fields (project_id, name, type, options, required, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(project_id || null, cleanText(name, 'name', { required: true, max: 60 }), t, JSON.stringify(this._cleanOptions(t, options)), required ? 1 : 0, last + 1, now()));
    return this.customField(Number(r.lastInsertRowid));
  },

  updateField(id, patch) {
    const f = this.customField(id);
    if (!f) fail('Campo não encontrado');
    this.transaction(() => this.db.prepare('UPDATE custom_fields SET name = ?, options = ?, required = ?, position = ? WHERE id = ?').run(
      patch.name === undefined ? f.name : cleanText(patch.name, 'name', { required: true, max: 60 }),
      JSON.stringify(patch.options === undefined ? f.options : this._cleanOptions(f.type, patch.options)),
      (patch.required ?? f.required) ? 1 : 0,
      patch.position == null ? f.position : Number(patch.position),
      id,
    ));
    return this.customField(id);
  },

  deleteField(id) {
    if (!this.customField(id)) fail('Campo não encontrado');
    this.transaction(() => this.db.prepare('DELETE FROM custom_fields WHERE id = ?').run(id));
  },

  cleanFieldValue(field, value) {
    if (value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)) return null;
    const bad = (msg) => fail(`Campo "${field.name}": ${msg}`);
    switch (field.type) {
      case 'text': return String(value).slice(0, 2000);
      case 'number': {
        const n = Number(String(value).replace(',', '.'));
        return Number.isFinite(n) ? n : bad('número inválido');
      }
      case 'date': return cleanDate(value, field.name);
      case 'boolean': return value === true || value === 'true' || value === 1 || value === '1' || value === 'sim';
      case 'select': {
        const opt = field.options.find((o) => o.toLowerCase() === String(value).toLowerCase());
        return opt ?? bad(`use uma das opções: ${field.options.join(', ')}`);
      }
      case 'multi_select': {
        const list = (Array.isArray(value) ? value : String(value).split(',')).map((v) => String(v).trim()).filter(Boolean);
        return list.map((v) => field.options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? bad(`"${v}" não é uma opção`));
      }
      case 'user': {
        const u = this.findUser(value);
        return u ? u.id : bad(`usuário "${value}" não encontrado`);
      }
      case 'url': {
        const s = String(value).trim();
        return /^https?:\/\/\S+$/i.test(s) ? s : bad('URL deve começar com http:// ou https://');
      }
      default: return null;
    }
  },

  // values: { idOuNome: valor }. Valor vazio apaga.
  setFieldValues(task_id, values) {
    const task = this.task(task_id);
    if (!task) fail(`Tarefa #${task_id} não encontrada`);
    const fields = this.customFields(task.project_id);
    this.transaction(() => {
      for (const [ref, value] of Object.entries(values || {})) {
        const field = fields.find((f) => String(f.id) === String(ref) || f.name.toLowerCase() === String(ref).toLowerCase());
        if (!field) fail(`Campo "${ref}" não existe neste projeto`);
        const clean = this.cleanFieldValue(field, value);
        if (clean === null) this.db.prepare('DELETE FROM task_field_values WHERE task_id = ? AND field_id = ?').run(task_id, field.id);
        else {
          this.db.prepare(`INSERT INTO task_field_values (task_id, field_id, value) VALUES (?, ?, ?)
            ON CONFLICT(task_id, field_id) DO UPDATE SET value = excluded.value`).run(task_id, field.id, JSON.stringify(clean));
        }
      }
      this.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(now(), task_id);
    });
  },

  fieldsWithValues(task) {
    return this.customFields(task.project_id).map((f) => ({ ...f, value: task.field_values?.[f.id] ?? null }));
  },

  // ---- observadores ----

  watchersOf(task_id) {
    return this.db.prepare('SELECT u.id, u.name, u.email, u.color, u.avatar FROM task_watchers w JOIN users u ON u.id = w.user_id WHERE w.task_id = ? ORDER BY u.name').all(task_id);
  },

  setWatchers(task_id, refs) {
    const ids = [...new Set((Array.isArray(refs) ? refs : String(refs).split(',')).filter((r) => String(r).trim()).map((r) => {
      const u = this.findUser(r);
      if (!u) fail(`Usuário "${r}" não encontrado`);
      return u.id;
    }))];
    this.transaction(() => {
      this.db.prepare('DELETE FROM task_watchers WHERE task_id = ?').run(task_id);
      const insert = this.db.prepare('INSERT INTO task_watchers (task_id, user_id) VALUES (?, ?)');
      for (const id of ids) insert.run(task_id, id);
    });
  },

  watch(task_id, user_id, on = true) {
    this.transaction(() => {
      if (on) this.db.prepare('INSERT OR IGNORE INTO task_watchers (task_id, user_id) VALUES (?, ?)').run(task_id, user_id);
      else this.db.prepare('DELETE FROM task_watchers WHERE task_id = ? AND user_id = ?').run(task_id, user_id);
    });
  },

  // Quem acompanha a tarefa: responsáveis, observadores e relator.
  followersOf(task) {
    return [...new Set([...(task.assignee_ids || []), ...(task.watcher_ids || []), task.reporter_id].filter(Boolean))];
  },

  // ---- modelos de workflow (colunas + transições reaproveitáveis entre projetos) ----

  workflows() {
    return this.db.prepare('SELECT * FROM workflows ORDER BY is_default DESC, name COLLATE NOCASE').all().map(parseWorkflow);
  },

  workflow(id) {
    return parseWorkflow(this.db.prepare('SELECT * FROM workflows WHERE id = ?').get(id));
  },

  _cleanWorkflow(columns, transitions) {
    const cols = (columns || []).map((c) => ({
      name: cleanText(c.name, 'columns.name', { required: true, max: 60 }),
      status: cleanEnum(c.status, 'columns.status', STATUSES) || fail('Toda coluna precisa de uma categoria'),
      color: cleanColor(c.color) ?? null,
    }));
    for (const s of STATUSES) if (!cols.some((c) => c.status === s)) fail(`O workflow precisa de ao menos uma coluna "${COLUMN_NAME[s]}"`);
    const pairs = (transitions || []).map(([a, b]) => [Number(a), Number(b)])
      .filter(([a, b]) => Number.isInteger(a) && Number.isInteger(b) && a !== b && cols[a] && cols[b]);
    return { cols, pairs };
  },

  createWorkflow({ name, description, columns, transitions, is_default = false }) {
    const { cols, pairs } = this._cleanWorkflow(columns, transitions);
    return this.transaction(() => {
      if (is_default) this.db.prepare('UPDATE workflows SET is_default = 0').run();
      const r = this.db.prepare('INSERT INTO workflows (name, description, columns, transitions, is_default, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(cleanText(name, 'name', { required: true, max: 80 }), cleanText(description, 'description') || '', JSON.stringify(cols), JSON.stringify(pairs), is_default ? 1 : 0, now());
      return this.workflow(Number(r.lastInsertRowid));
    });
  },

  // Salva as colunas e transições de um projeto como modelo.
  workflowFromProject(project_id, { name, description, is_default } = {}) {
    const cols = this.columns(project_id);
    const index = new Map(cols.map((c, i) => [c.id, i]));
    const pairs = this.transitions(project_id).map((t) => [index.get(t.from_column_id), index.get(t.to_column_id)]);
    return this.createWorkflow({
      name: name || `Workflow de ${this.project(project_id).name}`, description, is_default,
      columns: cols.map((c) => ({ name: c.name, status: c.status, color: c.color })), transitions: pairs,
    });
  },

  updateWorkflow(id, patch) {
    const w = this.workflow(id);
    if (!w) fail('Workflow não encontrado');
    const { cols, pairs } = this._cleanWorkflow(patch.columns ?? w.columns, patch.transitions ?? w.transitions);
    this.transaction(() => {
      if (patch.is_default) this.db.prepare('UPDATE workflows SET is_default = 0').run();
      this.db.prepare('UPDATE workflows SET name = ?, description = ?, columns = ?, transitions = ?, is_default = ? WHERE id = ?').run(
        patch.name === undefined ? w.name : cleanText(patch.name, 'name', { required: true, max: 80 }),
        patch.description === undefined ? w.description : (cleanText(patch.description, 'description') || ''),
        JSON.stringify(cols), JSON.stringify(pairs), (patch.is_default ?? w.is_default) ? 1 : 0, id);
    });
    return this.workflow(id);
  },

  deleteWorkflow(id) {
    if (!this.workflow(id)) fail('Workflow não encontrado');
    this.transaction(() => this.db.prepare('DELETE FROM workflows WHERE id = ?').run(id));
  },

  // Troca as colunas do projeto pelas do modelo. Tarefas vão para a coluna de mesmo nome
  // ou para a primeira coluna da mesma categoria.
  applyWorkflow(project_id, workflow_id) {
    const w = this.workflow(cleanId(workflow_id, 'workflow_id'));
    if (!w) fail('Workflow não encontrado');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM columns WHERE project_id = ?').all(project_id);
      const insert = this.db.prepare('INSERT INTO columns (project_id, name, status, color, position) VALUES (?, ?, ?, ?, ?)');
      const created = w.columns.map((c, i) => ({ ...c, id: Number(insert.run(project_id, c.name, c.status, c.color, 100 + i).lastInsertRowid) }));
      for (const o of old) {
        const target = created.find((c) => c.name.toLowerCase() === o.name.toLowerCase() && c.status === o.status);
        this.db.prepare('UPDATE tasks SET column_id = ? WHERE column_id = ?').run(target?.id ?? null, o.id);
      }
      if (old.length) this.db.prepare(`DELETE FROM columns WHERE id IN (${old.map((o) => o.id).join(',')})`).run();
      const tr = this.db.prepare('INSERT OR IGNORE INTO column_transitions (project_id, from_column_id, to_column_id) VALUES (?, ?, ?)');
      for (const [a, b] of w.transitions) tr.run(project_id, created[a].id, created[b].id);
      this.db.prepare('UPDATE columns SET position = position - 100 WHERE project_id = ?').run(project_id);
      return this.columns(project_id);
    });
  },

  // ---- busca universal (⌘K) ----

  search(q, { project_ids, limit = 8 } = {}) {
    const s = String(q || '').trim();
    if (!s) return { tasks: [], comments: [], projects: [], sprints: [], labels: [], people: [], workspaces: [] };
    const like = `%${s.replace(/^#/, '')}%`;
    const scope = Array.isArray(project_ids) ? (project_ids.length ? `IN (${project_ids.map(Number).join(',')})` : 'IN (-1)') : null;
    const inScope = (col) => (scope ? `AND ${col} ${scope}` : '');
    const tasks = this.listTasks({ q: s, status: 'all', project_ids, limit, include_archived: true });
    const comments = this.db.prepare(`
      SELECT n.id, n.task_id, n.body, n.created_at, t.title, p.name AS project_name FROM notes n
      JOIN tasks t ON t.id = n.task_id JOIN projects p ON p.id = t.project_id
      WHERE n.kind = 'note' AND n.body LIKE ? ${inScope('t.project_id')} ORDER BY n.created_at DESC LIMIT ?`).all(like, limit);
    const projects = this.db.prepare(`
      SELECT id, name, key, path, color, archived_at FROM projects
      WHERE (name LIKE ? OR key LIKE ? OR description LIKE ?) ${inScope('id')} ORDER BY archived_at IS NOT NULL, name LIMIT ?`).all(like, like, like, limit);
    const sprints = this.db.prepare(`
      SELECT s.id, s.name, s.status, s.project_id, p.name AS project_name FROM sprints s JOIN projects p ON p.id = s.project_id
      WHERE (s.name LIKE ? OR s.goal LIKE ?) ${inScope('s.project_id')} ORDER BY s.created_at DESC LIMIT ?`).all(like, like, limit);
    const labels = this.db.prepare(`SELECT id, name, color, project_id FROM labels WHERE name LIKE ? AND (project_id IS NULL ${scope ? `OR project_id ${scope}` : 'OR 1'}) LIMIT ?`).all(like, limit);
    const people = this.db.prepare('SELECT id, name, email, color, avatar FROM users WHERE (name LIKE ? OR email LIKE ?) AND disabled_at IS NULL LIMIT ?').all(like, like, limit);
    const workspaces = this.db.prepare(`SELECT id, name, organization_id FROM workspaces w WHERE name LIKE ?
      ${scope ? `AND EXISTS (SELECT 1 FROM projects p WHERE p.workspace_id = w.id AND p.id ${scope})` : ''} LIMIT ?`).all(like, limit);
    return { tasks, comments, projects, sprints, labels, people, workspaces };
  },
};
