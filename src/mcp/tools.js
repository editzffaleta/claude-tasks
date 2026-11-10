// Ferramentas do MCP "tarefas". Cada uma: título, descrição, esquema de entrada,
// anotações (dicas para o cliente) e run(args) → texto ou { content: [...] }.
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { AGENTS, agentName } from '../agents.js';
import {
  ACTIONS, DEPENDENCY_TYPES, FREQS, PRIORITIES, PRIORITY_LABEL, PROJECT_STATUSES, STATUSES, STATUS_LABEL, TRIGGERS, TYPES,
  VISIBILITIES, cleanDate, cleanId, formatDuration, formatTask, today,
} from '../db.js';
import { DEFAULT_SETTINGS } from '../store/insights.js';
import {
  AGENT, actingUser, boardLink, describeTask, guardAdmin, guardProject, guardTask, me, overviewText, projectFrom, requireProject,
  store, taskJson, taskLink, timeActor, userIds, visible,
} from './context.js';
import { EXTRA_TOOLS } from './tools-extra.js';

// ---------- esquemas reutilizados ----------

const projectProps = {
  project_path: {
    type: 'string',
    description: 'Absolute path inside the project (normally your current working directory). The project is the git repository containing it.',
  },
  project: {
    type: 'string',
    description: 'Project name or id. Use for projects not tied to a folder or to target another known project. Ignored when project_path is given.',
  },
};

const date = (description) => ({ type: ['string', 'null'], description: `${description} Format YYYY-MM-DD; null clears it.` });
const ids = (description) => ({ type: 'array', items: { type: 'integer' }, minItems: 1, description });
const format = { type: 'string', enum: ['text', 'json'], description: 'Output format. Default text (compact, human-readable); json returns structured data.' };

const recurrence = {
  type: ['object', 'null'],
  description: 'Repeat when completed: the next occurrence is created automatically with the deadline moved forward. null removes it.',
  properties: {
    freq: { type: 'string', enum: FREQS },
    interval: { type: 'integer', minimum: 1, description: 'Every N units. Default 1.' },
    weekdays: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 }, description: 'weekly: days of the week (0 = Sunday).' },
    monthday: { type: ['integer', 'string'], description: 'monthly/quarterly: day of the month 1-31 or "last".' },
    until: { type: 'string', description: 'Last date (YYYY-MM-DD), optional.' },
    count: { type: 'integer', minimum: 1, description: 'End after this many occurrences, optional.' },
  },
  required: ['freq'],
};

const taskFields = {
  title: { type: 'string', description: 'Short, actionable title.' },
  description: { type: 'string', description: 'Context to resume later: what, why, files involved, what is already done. Markdown allowed.' },
  priority: { type: 'string', enum: PRIORITIES, description: 'Default: medium.' },
  status: { type: 'string', enum: STATUSES, description: 'Status category. Default: todo.' },
  column: { type: 'string', description: 'Board column name of the project (e.g. "Revisão"); sets the status accordingly. See manage_columns.' },
  type: { type: 'string', enum: TYPES, description: 'Default: task.' },
  tags: { type: 'array', items: { type: 'string' }, description: 'e.g. bug, ui, backend, refactor. Replaces the list.' },
  start_date: date('When work should start.'),
  due_date: date('Deadline.'),
  estimate: { type: ['string', 'null'], description: 'Original effort estimate like "30m", "2h", "1h30m", "1d" (= 8h).' },
  parent_id: { type: ['integer', 'null'], description: 'Make this a subtask of another task (same project). null detaches.' },
  blocked_by: {
    type: 'array',
    description: 'Tasks that must come first. Replaces the list (cycles are rejected). Items: a task id, or { id, type } with type finish_start (default), start_start, finish_finish or start_finish.',
    items: { anyOf: [{ type: 'integer' }, { type: 'object', properties: { id: { type: 'integer' }, type: { type: 'string', enum: DEPENDENCY_TYPES } }, required: ['id'] }] },
  },
  sprint: { type: ['string', 'null'], description: 'Sprint name/id, "active" for the active sprint, or null for the backlog.' },
  assignees: { type: 'array', items: { type: 'string' }, description: 'Team members (name, e-mail or "me"). Replaces the list. See list_members.' },
  watchers: { type: 'array', items: { type: 'string' }, description: 'Members who follow the task and get notified (name, e-mail or "me"). Replaces the list.' },
  reporter: { type: ['string', 'null'], description: 'Who reported/requested the task (name, e-mail or "me").' },
  story_points: { type: ['number', 'null'], description: 'Story points (agile size estimate).' },
  remaining: { type: ['string', 'null'], description: 'Remaining effort, like "3h" (the original estimate stays in estimate).' },
  fields: { type: 'object', description: 'Custom field values by field name or id, e.g. {"Cliente": "ACME", "Valor": 1200}. null clears a value. See manage_fields.' },
  recurrence,
};

const editExtras = {
  note: { type: 'string', description: 'Note appended to the task history (progress, blocker, decision).' },
  archived: { type: 'boolean', description: 'Archive (true) or restore (false). Archived tasks are hidden from the board.' },
  add_tags: { type: 'array', items: { type: 'string' } },
  remove_tags: { type: 'array', items: { type: 'string' } },
  add_blocked_by: { type: 'array', items: { type: 'integer' }, description: 'Add blockers without replacing the existing ones.' },
  remove_blocked_by: { type: 'array', items: { type: 'integer' } },
  project_path: { type: 'string', description: 'Move to the project containing this path.' },
  project: { type: 'string', description: 'Move to the project with this name or id.' },
};

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

// ---------- helpers ----------

const json = (data) => JSON.stringify(data, null, 2);

// Aceita 12, "#12" ou o código do projeto ("WEB-12"); no chat do painel confere a permissão.
function requireTask(id, level = 'read') {
  return guardTask(id, level);
}

// Converte os argumentos de edição no patch aceito por store.updateTask.
function buildPatch(args, current) {
  const {
    id: _id, ids: _ids, note: _note, position: _pos, project_path, project, add_tags, remove_tags, add_blocked_by, remove_blocked_by, ...patch
  } = args;
  const target = projectFrom({ project_path, project }, { level: 'edit' });
  if (target) patch.project_id = target.id;
  if (add_tags || remove_tags) {
    const base = patch.tags ?? current.tags;
    patch.tags = [...new Set([...base, ...(add_tags || [])])].filter((t) => !(remove_tags || []).includes(t));
  }
  if (add_blocked_by || remove_blocked_by) {
    // Mantém o tipo (SS, FF…) das dependências que já existem.
    const base = (patch.blocked_by ?? store.blockers(current.id)).map((b) => (typeof b === 'object' ? { id: b.id, type: b.type } : { id: b }));
    const removed = new Set((remove_blocked_by || []).map(Number));
    const merged = new Map(base.map((b) => [Number(b.id), b]));
    for (const id of add_blocked_by || []) if (!merged.has(Number(id))) merged.set(Number(id), { id: Number(id) });
    patch.blocked_by = [...merged.values()].filter((b) => !removed.has(Number(b.id)));
  }
  if (patch.assignees) patch.assignees = userIds(patch.assignees);
  if (patch.watchers) patch.watchers = userIds(patch.watchers);
  if (patch.reporter === 'me' || patch.reporter === 'eu') patch.reporter = userIds(['me'])[0];
  return patch;
}

// Coloca a tarefa no topo ou no fim da coluna dela.
function reposition(id, position) {
  const t = store.task(id);
  const same = store.listTasks({ project_id: t.project_id, status: t.status, limit: 2000 })
    .filter((x) => x.id !== id && (x.column_id ?? null) === (t.column_id ?? null));
  if (!same.length) return;
  const ranks = same.map((x) => x.sort_rank);
  store.updateTask(id, { rank: position === 'top' ? Math.min(...ranks) - 1000 : Math.max(...ranks) + 1000 }, AGENT);
}

function applyEdit(id, args) {
  const current = requireTask(id, 'edit');
  store.updateTask(current.id, buildPatch(args, current), AGENT);
  if (args.position) reposition(current.id, args.position);
  if (args.note) store.addNote(current.id, args.note, AGENT);
  return store.task(current.id);
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|javascript|sql))/;
const TEXT_EXT = new Set(['.md', '.txt', '.log', '.csv', '.json', '.yml', '.yaml', '.xml', '.sql', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.swift', '.html', '.css', '.env.example']);

function describeAutomation(r) {
  const c = r.conditions || {};
  const cond = [
    c.to_status && `para ${STATUS_LABEL[c.to_status]}`,
    c.from_status && `saindo de ${STATUS_LABEL[c.from_status]}`,
    c.priority?.length && `prioridade ${c.priority.join('/')}`,
    c.type?.length && `tipo ${c.type.join('/')}`,
    c.tag && `tag ${c.tag}`,
    c.by_claude && 'criada por um agente (Claude ou Codex)',
    r.trigger === 'due_soon' && `${c.days ?? 1} dia(s) antes`,
  ].filter(Boolean).join(', ');
  const { type, value } = r.action;
  const shown = type === 'set_priority' ? PRIORITY_LABEL[value] : type === 'set_status' ? STATUS_LABEL[value] : value;
  return `#${r.id} [${r.enabled ? 'ativa' : 'pausada'}] ${r.name} — quando ${TRIGGERS[r.trigger].toLowerCase()}${cond ? ` (${cond})` : ''} → ${ACTIONS[type].toLowerCase()}${shown != null ? ` "${shown}"` : ''} · ${r.project_name || 'todos os projetos'} · executada ${r.run_count}x`;
}

function resolveWorkspace(ref) {
  const s = String(ref).trim().toLowerCase();
  const w = store.workspaces().find((x) => String(x.id) === s || x.name.toLowerCase() === s);
  if (!w) throw new Error(`Workspace "${ref}" não encontrado`);
  return w;
}

function resolveColumnRef(project_id, ref) {
  let col = store.resolveColumn(project_id, ref);
  if (col.id == null) col = store.materializeColumns(project_id).find((c) => c.status === col.status && c.name === col.name);
  return col;
}

// ---------- ferramentas ----------

export const TOOLS = {
  // ===== tarefas =====

  add_tasks: {
    title: 'Adicionar tarefas',
    description: 'Add one or more pending tasks to a project on the central board. Open tasks with the same title in the same place are not duplicated. Use parent_id for subtasks and blocked_by for ordering.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        tasks: { type: 'array', minItems: 1, items: { type: 'object', properties: taskFields, required: ['title'] } },
      },
      required: ['tasks'],
    },
    run(args) {
      if (!Array.isArray(args.tasks) || !args.tasks.length) throw new Error('"tasks" deve ser uma lista com ao menos uma tarefa');
      return store.transaction(() => {
        const project = requireProject(args);
        const lines = args.tasks.map((item) => {
          const input = {
            ...item,
            assignees: item.assignees ? userIds(item.assignees) : undefined,
            watchers: item.watchers ? userIds(item.watchers) : undefined,
            reporter: item.reporter ? userIds([item.reporter])[0] : (me()?.id ?? undefined),
          };
          const { task, duplicate } = store.addTask(project.id, input, AGENT);
          return `${duplicate ? 'já existia' : 'criada'}: ${formatTask(task)}`;
        });
        return [`Projeto: ${project.name}`, ...lines, `Quadro: ${boardLink(project)}`].join('\n');
      });
    },
  },

  list_tasks: {
    title: 'Listar tarefas',
    description: 'List tasks with filters. Without project_path/project it lists every project. Default status filter is "open" (everything not done).',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        status: { type: 'string', enum: ['open', 'all', ...STATUSES], description: 'Default: open.' },
        query: { type: 'string', description: 'Text search in title, description and tags (or "#12" for an id).' },
        due: { type: 'string', enum: ['overdue', 'today', 'week', 'any', 'none'], description: 'Filter by deadline. week = next 7 days.' },
        sprint: { type: 'string', description: 'Sprint name/id, "active" or "backlog". Needs a project.' },
        assignee: { type: 'string', description: 'Team member name/e-mail, or "me".' },
        reporter: { type: 'string', description: 'Reporter name/e-mail, or "me".' },
        watcher: { type: 'string', description: 'Tasks watched by this member, or "me".' },
        tag: { type: 'string', description: 'Only tasks with this tag/label.' },
        type: { type: 'string', enum: TYPES },
        column: { type: 'string', description: 'Only tasks in this board column (needs a project).' },
        parent_id: { type: 'integer', description: 'Only subtasks of this task.' },
        include_subtasks: { type: 'boolean', description: 'Default true.' },
        include_archived: { type: 'boolean', description: 'Default false.' },
        sort: { type: 'string', enum: ['board', 'priority', 'due', 'updated', 'created'], description: 'Default board order (status, then manual/priority order).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 100.' },
        format,
      },
    },
    run(args) {
      const project = projectFrom(args, { create: false });
      if ((args.project_path || args.project) && !project) return 'Esse projeto ainda não tem tarefas no quadro.';
      let sprint_id;
      if (args.sprint) {
        if (!project) throw new Error('Filtrar por sprint exige informar o projeto');
        sprint_id = args.sprint === 'backlog' ? 'none' : store.resolveSprint(project.id, args.sprint);
      }
      const assignee_id = args.assignee ? userIds([args.assignee])[0] : undefined;
      let tasks = store.listTasks({
        project_id: project?.id, project_ids: project ? undefined : visible(), status: args.status || 'open', q: args.query,
        due: args.due, sprint_id, assignee_id, type: args.type, parent_id: args.parent_id, top_level: args.include_subtasks === false,
        reporter_id: args.reporter ? userIds([args.reporter])[0] : undefined,
        watcher_id: args.watcher ? userIds([args.watcher])[0] : undefined,
        tag: args.tag, include_archived: !!args.include_archived, limit: 2000,
      });
      if (args.column) {
        if (!project) throw new Error('Filtrar por coluna exige informar o projeto');
        const col = store.resolveColumn(project.id, args.column);
        const cols = store.columns(project.id);
        tasks = tasks.filter((t) => (col.id != null && t.column_id === col.id) || (t.status === col.status && !t.column_id && cols.find((c) => c.status === t.status) === col));
      }
      const order = {
        priority: (a, b) => PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority) || a.sort_rank - b.sort_rank,
        due: (a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'),
        updated: (a, b) => b.updated_at.localeCompare(a.updated_at),
        created: (a, b) => b.created_at.localeCompare(a.created_at),
      }[args.sort];
      if (order) tasks.sort(order);
      const total = tasks.length;
      tasks = tasks.slice(0, args.limit || 100);
      if (args.format === 'json') return json({ total, tasks: tasks.map(taskJson) });
      if (!tasks.length) return project ? `Nenhuma tarefa (${args.status || 'open'}) em ${project.name}.` : 'Nenhuma tarefa encontrada.';
      const more = total > tasks.length ? `\n…e mais ${total - tasks.length} (aumente limit ou filtre).` : '';
      if (project) return [`Projeto: ${project.name} · ${total} tarefa(s)`, ...tasks.map((t) => formatTask(t))].join('\n') + more;
      const groups = Map.groupBy(tasks, (t) => t.project_name);
      return [...groups].map(([name, list]) => `## ${name}\n${list.map((t) => formatTask(t)).join('\n')}`).join('\n\n') + more;
    },
  },

  get_task: {
    title: 'Ver tarefa',
    description: 'Get one task with full description, subtasks, dependencies, time entries, attachments and history.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { id: { type: ['integer', 'string'], description: 'Task id, or project code like "WEB-12".' }, format }, required: ['id'] },
    run({ id, format: fmt }) {
      const t = store.taskWithNotes(requireTask(id).id);
      if (fmt === 'json') {
        return json({
          ...taskJson(t),
          description: t.description,
          subtasks: t.subtasks.map(taskJson),
          blocked_by: t.blockers,
          blocking: t.blocking,
          attachments: t.attachments.map(({ id: aid, name, mime, size, created_at }) => ({ id: aid, name, mime, size, created_at })),
          time_entries: t.time_entries,
          notes: t.notes.map(({ kind, author, user_name, body, created_at }) => ({ kind, author: AGENTS[author] ? author : user_name || author, body, created_at })),
        });
      }
      return describeTask(t);
    },
  },

  update_task: {
    title: 'Atualizar tarefa',
    description: 'Update a task: change any field, move it to another project or column, reorder it, archive it, and/or append a note.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        ...taskFields,
        ...editExtras,
        position: { type: 'string', enum: ['top', 'bottom'], description: 'Move to the top or bottom of its board column.' },
      },
      required: ['id'],
    },
    run(args) {
      return store.transaction(() => `Atualizada: ${formatTask(applyEdit(args.id, args), { withProject: true })}`);
    },
  },

  update_tasks: {
    title: 'Atualizar várias tarefas',
    description: 'Apply the same change to many tasks at once (e.g. move to a sprint, set priority, add a tag, archive).',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Task ids.'),
        status: taskFields.status,
        column: taskFields.column,
        priority: taskFields.priority,
        type: taskFields.type,
        start_date: taskFields.start_date,
        due_date: taskFields.due_date,
        sprint: taskFields.sprint,
        assignees: taskFields.assignees,
        ...editExtras,
      },
      required: ['ids'],
    },
    run(args) {
      const lines = store.transaction(() => args.ids.map((id) => `- ${formatTask(applyEdit(id, args), { withProject: true })}`));
      return [`Atualizadas ${lines.length} tarefa(s):`, ...lines].join('\n');
    },
  },

  complete_tasks: {
    title: 'Concluir tarefas',
    description: 'Mark tasks as done, optionally with a note and the time spent. Stops running timers. Recurring tasks spawn their next occurrence.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        ids: ids('Task ids.'),
        note: { type: 'string', description: 'What was done (added to each task history).' },
        time_spent: { type: 'string', description: 'Time to log on each task, e.g. "45m".' },
      },
      required: ['ids'],
    },
    run(args) {
      return store.transaction(() => args.ids.map((raw) => {
        const id = requireTask(raw, 'edit').id;
        store.stopTaskTimers(id, timeActor());
        if (args.time_spent) store.logTime(id, { duration: args.time_spent, note: args.note }, timeActor());
        const t = store.updateTask(id, { status: 'done' }, AGENT);
        if (args.note) store.addNote(id, args.note, AGENT);
        const next = t.recurrence_next_id ? ` → próxima ocorrência #${t.recurrence_next_id}` : '';
        return `concluída: ${formatTask(store.task(id), { withProject: true })}${next}`;
      }).join('\n'));
    },
  },

  delete_tasks: {
    title: 'Excluir tarefas',
    description: 'Permanently delete tasks (and their subtasks, history and attachments). Only when the user explicitly asks; prefer archived: true via update_task. Requires confirm: true.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: { ids: ids('Task ids.'), confirm: { type: 'boolean', description: 'Must be true.' } },
      required: ['ids', 'confirm'],
    },
    run(args) {
      if (args.confirm !== true) throw new Error('Exclusão não confirmada: envie confirm: true (só quando o usuário pediu para excluir)');
      const titles = args.ids.map((id) => { const t = requireTask(id, 'manage'); return `#${t.id} ${t.title}`; });
      // Excluir a tarefa-mãe já leva as subtarefas; ignora ids que sumiram assim.
      args.ids.forEach((id) => { if (store.task(cleanId(id))) store.deleteTask(cleanId(id)); });
      return `Excluídas: ${titles.join('; ')}`;
    },
  },

  add_comment: {
    title: 'Comentar',
    description: 'Add a comment to a task history (progress, decisions, findings). Markdown allowed.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['integer', 'string'] },
        body: { type: 'string', description: 'Markdown. Mention people with @Name to notify them.' },
        reply_to: { type: 'integer', description: 'Comment id to reply to (threads). See get_task.' },
      },
      required: ['id', 'body'],
    },
    run({ id, body, reply_to }) {
      const t = requireTask(id, 'edit');
      store.addNote(t.id, body, AGENT, { parent_id: reply_to });
      return `Comentário adicionado em #${t.id} ${t.title}.`;
    },
  },

  // ===== projetos, colunas e sprints =====

  list_projects: {
    title: 'Listar projetos',
    description: 'List all projects with task counts, overdue tasks and board columns.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { include_archived: { type: 'boolean', description: 'Default true.' }, format } },
    run(args) {
      const projects = store.listProjects({ include_archived: args.include_archived !== false, project_ids: visible() });
      if (args.format === 'json') {
        return json(projects.map((p) => ({ ...p, columns: store.columns(p.id).map((c) => ({ id: c.id, name: c.name, status: c.status })), url: boardLink(p) })));
      }
      if (!projects.length) return 'O quadro ainda está vazio.';
      return projects.map((p) => {
        const cols = store.columns(p.id).map((c) => c.name).join(' → ');
        const late = p.overdue ? `, ${p.overdue} atrasadas` : '';
        return `[${p.id}] ${p.name}${p.archived_at ? ' (arquivado)' : ''}: ${p.open} abertas (${p.doing} em andamento, ${p.blocked} bloqueadas${late}), ${p.done} concluídas — ${p.path || 'sem pasta'}\n  colunas: ${cols}`;
      }).join('\n');
    },
  },

  manage_project: {
    title: 'Gerenciar projeto',
    description: 'Create, update (name, description, color), archive, unarchive or delete a project. Folder projects are created automatically by add_tasks; use create for projects without a folder. Delete requires confirm: true and removes all its tasks.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'update', 'archive', 'unarchive', 'delete'] },
        ...projectProps,
        name: { type: 'string', description: 'Name for create, or new name for update.' },
        description: { type: 'string' },
        color: { type: 'string', description: 'Hex color, e.g. #2a78d6.' },
        key: { type: ['string', 'null'], description: 'Task code prefix, e.g. "WEB" makes tasks WEB-1, WEB-2…' },
        status: { type: 'string', enum: PROJECT_STATUSES },
        priority: { type: 'string', enum: PRIORITIES },
        visibility: { type: 'string', enum: VISIBILITIES, description: 'private: only members; internal (default): every account; public: also allows public share links.' },
        start_date: date('Project start.'),
        end_date: date('Project end.'),
        workspace: { type: 'string', description: 'Workspace name or id to place/move the project in.' },
        confirm: { type: 'boolean', description: 'Required (true) for delete.' },
      },
      required: ['action'],
    },
    run(args) {
      const workspace_id = args.workspace ? resolveWorkspace(args.workspace).id : undefined;
      const fields = {
        description: args.description, color: args.color, key: args.key, status: args.status, priority: args.priority,
        visibility: args.visibility, start_date: args.start_date, end_date: args.end_date, workspace_id,
      };
      if (args.action === 'create') {
        if (actingUser()?.role === 'viewer') throw new Error('Visualizadores não criam projetos');
        const p = store.createProject(args.name, null, { ...fields, actor: AGENT });
        return `Projeto criado: [${p.id}] ${p.name}${p.key ? ` (${p.key})` : ''} · ${boardLink(p)}`;
      }
      const p = projectFrom(args, { create: false }) || requireProject(args, { create: false, level: 'manage' });
      if (args.action === 'update') {
        // Mudar a visibilidade é coisa de dono, como na API.
        guardProject(p, args.visibility && args.visibility !== p.visibility ? 'own' : 'manage');
        const u = store.updateProject(p.id, { name: args.name, ...fields });
        return `Projeto atualizado: [${u.id}] ${u.name}${u.key ? ` (${u.key})` : ''} · ${u.status} · ${u.visibility}`;
      }
      if (args.action === 'archive' || args.action === 'unarchive') {
        guardProject(p, 'own');
        store.updateProject(p.id, { archived: args.action === 'archive' });
        return `Projeto ${p.name} ${args.action === 'archive' ? 'arquivado' : 'desarquivado'}.`;
      }
      if (args.action === 'delete') {
        if (args.confirm !== true) throw new Error('Exclusão não confirmada: envie confirm: true (só quando o usuário pediu)');
        guardProject(p, 'own');
        store.deleteProject(p.id);
        return `Projeto ${p.name} excluído com todas as tarefas.`;
      }
      throw new Error('Ação inválida');
    },
  },

  manage_columns: {
    title: 'Gerenciar colunas',
    description: 'List, create, rename/recategorize, move or delete the board columns of a project. Each column belongs to a status category (todo, doing, blocked, done); a project keeps at least one column per category.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        action: { type: 'string', enum: ['list', 'create', 'update', 'move', 'delete', 'set_transitions', 'save_workflow', 'apply_workflow', 'list_workflows'] },
        column: { type: 'string', description: 'Column name or id (update/move/delete).' },
        transitions: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 2 },
          description: 'set_transitions: allowed moves as [from, to] column names, e.g. [["A fazer","Em andamento"],["Em andamento","Revisão"]]. Empty list = any move allowed.',
        },
        workflow: { type: 'string', description: 'apply_workflow: workflow name or id. save_workflow: name for the new workflow.' },
        default: { type: 'boolean', description: 'save_workflow: use it for new projects.' },
        name: { type: 'string', description: 'Name (create) or new name (update).' },
        status: { type: 'string', enum: STATUSES, description: 'Status category (create/update). Default doing.' },
        color: { type: 'string' },
        direction: { type: 'string', enum: ['left', 'right'], description: 'For move.' },
      },
      required: ['action'],
    },
    run(args) {
      if (args.action === 'list_workflows') {
        const wfs = store.workflows();
        return wfs.length ? wfs.map((w) => `[${w.id}] ${w.name}${w.is_default ? ' (padrão)' : ''}: ${w.columns.map((c) => c.name).join(' → ')}${w.transitions.length ? ` · ${w.transitions.length} transições` : ''}`).join('\n') : 'Nenhum workflow salvo.';
      }
      const project = requireProject(args, { create: false, level: args.action === 'list' ? 'read' : 'manage' });
      const list = () => {
        const cols = store.columns(project.id);
        const tr = store.transitions(project.id);
        const names = new Map(cols.map((c) => [c.id, c.name]));
        return cols.map((c, i) => `${i + 1}. ${c.name} [${STATUS_LABEL[c.status]}]${c.id ? ` (id ${c.id})` : ' (padrão)'}`).join('\n')
          + (tr.length ? `\nTransições permitidas: ${tr.map((t) => `${names.get(t.from_column_id)} → ${names.get(t.to_column_id)}`).join('; ')}` : '\nTransições: livres');
      };
      switch (args.action) {
        case 'list': return `Colunas de ${project.name}:\n${list()}`;
        case 'set_transitions': store.setTransitions(project.id, args.transitions || []); break;
        case 'save_workflow': {
          guardAdmin();
          const w = store.workflowFromProject(project.id, { name: args.workflow, is_default: !!args.default });
          return `Workflow salvo: [${w.id}] ${w.name}${w.is_default ? ' (padrão para projetos novos)' : ''}`;
        }
        case 'apply_workflow': {
          const ref = String(args.workflow || '').toLowerCase();
          const w = store.workflows().find((x) => String(x.id) === ref || x.name.toLowerCase() === ref);
          if (!w) throw new Error(`Workflow "${args.workflow}" não encontrado (veja list_workflows)`);
          store.applyWorkflow(project.id, w.id);
          break;
        }
        case 'create': store.createColumn(project.id, args); break;
        case 'update': store.updateColumn(resolveColumnRef(project.id, args.column).id, { name: args.name, status: args.status, color: args.color }); break;
        case 'move': store.updateColumn(resolveColumnRef(project.id, args.column).id, { move: args.direction || 'right' }); break;
        case 'delete': store.deleteColumn(resolveColumnRef(project.id, args.column).id); break;
        default: throw new Error('Ação inválida');
      }
      return `Colunas de ${project.name}:\n${list()}`;
    },
  },

  manage_sprints: {
    title: 'Gerenciar sprints',
    description: 'List, show, create, update, start, complete or delete sprints of a project. Completing moves unfinished tasks to move_to (another sprint id) or to the backlog. Only one sprint can be active per project.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        action: { type: 'string', enum: ['list', 'show', 'create', 'update', 'start', 'complete', 'cancel', 'delete'] },
        id: { type: 'integer', description: 'Sprint id (show/update/start/complete/delete).' },
        name: { type: 'string' },
        goal: { type: 'string' },
        start_date: date('Sprint start.'),
        end_date: date('Sprint end.'),
        move_to: { type: 'integer', description: 'On complete: sprint id that receives unfinished tasks. Omit for backlog.' },
      },
      required: ['action'],
    },
    run(args) {
      const project = requireProject(args, { level: ['list', 'show'].includes(args.action) ? 'read' : 'manage' });
      const fmt = (s) => `#${s.id} ${s.name} [${{ planning: 'planejamento', active: 'ativa', completed: 'concluída', cancelled: 'cancelada' }[s.status]}]`
        + `${s.start_date || s.end_date ? ` ${s.start_date || '?'} → ${s.end_date || '?'}` : ''}${s.total !== undefined ? ` · ${s.done}/${s.total} concluídas` : ''}${s.goal ? ` — ${s.goal}` : ''}`;
      // A sprint informada tem de ser do projeto cuja permissão foi conferida.
      if (args.id != null && !['list', 'create'].includes(args.action)) {
        const s = store.sprint(cleanId(args.id));
        if (!s || s.project_id !== project.id) throw new Error('Sprint não encontrada neste projeto');
      }
      switch (args.action) {
        case 'list': {
          const list = store.sprints(project.id);
          return list.length ? [`Sprints de ${project.name}:`, ...list.map(fmt)].join('\n') : `${project.name} não tem sprints.`;
        }
        case 'show': {
          const s = store.sprints(project.id).find((x) => x.id === cleanId(args.id));
          if (!s) throw new Error('Sprint não encontrada neste projeto');
          const tasks = store.listTasks({ project_id: project.id, sprint_id: s.id, status: 'all', limit: 500 });
          return [fmt(s), ...tasks.map((t) => `- ${formatTask(t)}`)].join('\n');
        }
        case 'create': return `Criada: ${fmt(store.createSprint(project.id, args))}`;
        case 'update': return `Atualizada: ${fmt(store.updateSprint(cleanId(args.id), args))}`;
        case 'start': return `Iniciada: ${fmt(store.startSprint(cleanId(args.id), AGENT))}`;
        case 'complete': {
          const r = store.completeSprint(cleanId(args.id), { move_to: args.move_to }, AGENT);
          return `Concluída: ${fmt(r.sprint)}. ${r.moved} tarefa(s) pendente(s) movida(s) para ${r.moved_to ? r.moved_to.name : 'o backlog'}.`;
        }
        case 'cancel': {
          const r = store.cancelSprint(cleanId(args.id), { move_to: args.move_to }, AGENT);
          return `Cancelada: ${fmt(r.sprint)}. ${r.moved} tarefa(s) movida(s) para ${r.moved_to ? r.moved_to.name : 'o backlog'}.`;
        }
        case 'delete': store.deleteSprint(cleanId(args.id)); return 'Sprint excluída (as tarefas foram para o backlog).';
        default: throw new Error('Ação inválida');
      }
    },
  },

  // ===== tempo =====

  timer: {
    title: 'Timer',
    description: 'Start or stop a timer on a task, or see running timers. One timer per person: starting one stops the previous. Time counts for the board user (see list_members).',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'stop', 'status'] }, id: { type: 'integer', description: 'Task id (start/stop).' } },
      required: ['action'],
    },
    run(args) {
      const actor = timeActor();
      if (args.action === 'start') {
        const t = requireTask(args.id, 'edit');
        store.startTimer(t.id, actor);
        return `Timer iniciado em #${t.id} ${t.title}.`;
      }
      if (args.action === 'stop') {
        const t = requireTask(args.id, 'edit');
        store.stopTaskTimers(t.id, actor);
        return `Timer parado. #${t.id} soma ${formatDuration(store.task(t.id).spent_minutes)}.`;
      }
      const running = store.runningTimers(actor.user_id);
      if (!running.length) return 'Nenhum timer rodando.';
      return running.map((r) => `#${r.task_id} ${r.task_title}: ${formatDuration((Date.now() - Date.parse(r.started_at)) / 60000)} desde ${new Date(r.started_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`).join('\n');
    },
  },

  log_time: {
    title: 'Registrar tempo',
    description: 'Log time spent on a task (e.g. how long a work session took).',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        duration: { type: 'string', description: 'e.g. "45m", "1h30m".' },
        date: { type: 'string', description: 'YYYY-MM-DD, default today.' },
        note: { type: 'string' },
      },
      required: ['id', 'duration'],
    },
    run(args) {
      const t = requireTask(args.id, 'edit');
      store.logTime(t.id, args, timeActor());
      const after = store.task(t.id);
      return `Tempo registrado em #${t.id}. Total: ${formatDuration(after.spent_minutes)}${after.estimate_minutes ? ` de ${formatDuration(after.estimate_minutes)} estimados` : ''}.`;
    },
  },

  time_report: {
    title: 'Relatório de tempo',
    description: 'Time logged in a date range (inclusive), grouped by task, project, day or person. Default: the last 7 days, all projects.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        from: { type: 'string', description: 'YYYY-MM-DD.' },
        to: { type: 'string', description: 'YYYY-MM-DD, default today.' },
        group_by: { type: 'string', enum: ['task', 'project', 'day', 'person'], description: 'Default task.' },
        format,
      },
    },
    run(args) {
      const project = projectFrom(args, { create: false });
      const r = store.timeReport({
        project_id: project?.id, project_ids: project ? undefined : visible(), from: cleanDate(args.from, 'from') || undefined, to: cleanDate(args.to, 'to') || undefined, group_by: args.group_by || 'task',
      });
      if (args.format === 'json') return json({ ...r, project: project?.name ?? null });
      if (!r.entries.length) return `Nenhum tempo registrado de ${r.from} a ${r.to}${project ? ` em ${project.name}` : ''}.`;
      return [
        `Tempo de ${r.from} a ${r.to}${project ? ` · ${project.name}` : ''}: ${formatDuration(r.total)} em ${r.entries.length} registro(s)`,
        ...r.groups.map((g) => `- ${g.label}: ${formatDuration(g.minutes)} (${g.entries})`),
      ].join('\n');
    },
  },

  // ===== anexos =====

  attach_file: {
    title: 'Anexar arquivo',
    description: 'Attach a local file (screenshot, log, report, export) to a task. Max 25 MB.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        path: { type: 'string', description: 'Absolute path of the file.' },
        name: { type: 'string', description: 'Display name, default the file name.' },
      },
      required: ['id', 'path'],
    },
    run(args) {
      const a = store.attachFile(requireTask(args.id, 'edit').id, args.path, AGENT, args.name);
      return `Anexado em #${args.id}: ${a.name} (id ${a.id}, ${Math.ceil(a.size / 1024)} KB).`;
    },
  },

  get_attachment: {
    title: 'Ler anexo',
    description: 'Read an attachment: images come back as images you can see, text files as text (up to 200 KB); other files return their local path.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { id: { type: 'integer', description: 'Attachment id (see get_task).' } }, required: ['id'] },
    run({ id }) {
      const a = store.attachment(cleanId(id));
      if (!a) throw new Error(`Anexo ${id} não encontrado`);
      requireTask(a.task_id);
      const path = store.attachmentPath(a);
      const meta = `Anexo ${a.id} da tarefa #${a.task_id}: ${a.name} (${a.mime}, ${Math.ceil(a.size / 1024)} KB)\nArquivo local: ${path}`;
      if (/^image\/(png|jpeg|gif|webp)$/.test(a.mime) && a.size <= 5 * 1024 * 1024) {
        return { content: [{ type: 'text', text: meta }, { type: 'image', data: readFileSync(path).toString('base64'), mimeType: a.mime }] };
      }
      if ((TEXT_TYPES.test(a.mime) || TEXT_EXT.has(extname(a.name).toLowerCase())) && a.size <= 200 * 1024) {
        return `${meta}\n\n----- conteúdo -----\n${readFileSync(path, 'utf8')}`;
      }
      return `${meta}\n\nArquivo binário ou grande demais para mostrar aqui. Use a ferramenta Read com o caminho acima.`;
    },
  },

  // ===== visão geral =====

  get_overview: {
    title: 'Visão geral',
    description: 'Dashboard summary: totals, overdue, upcoming deadlines, tasks in progress and blocked, active sprint and last-7-days activity. For one project or all.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { ...projectProps, format } },
    run(args) {
      const project = projectFrom(args, { create: false });
      if ((args.project || args.project_path) && !project) return 'Esse projeto ainda não está no quadro.';
      if (args.format === 'json') {
        const s = store.stats({ project_id: project?.id, project_ids: project ? undefined : visible() });
        return json({ project: project?.name ?? null, today: today(), ...s, upcoming: s.upcoming.map(taskJson) });
      }
      return overviewText(project);
    },
  },

  get_activity: {
    title: 'Atividade recente',
    description: 'Recent activity feed: tasks created, status changes, comments and other events.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        since: { type: 'string', description: 'Only activity from this date (YYYY-MM-DD) on.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 30.' },
      },
    },
    run(args) {
      const project = projectFrom(args, { create: false });
      const since = cleanDate(args.since, 'since');
      let items = store.activity({ project_id: project?.id, project_ids: project ? undefined : visible(), limit: since ? 1000 : (args.limit || 30) });
      if (since) items = items.filter((a) => a.created_at.slice(0, 10) >= since).slice(0, args.limit || 30);
      if (!items.length) return 'Nenhuma atividade.';
      return items.map((a) => {
        const who = agentName(a.author) || a.user_name || a.author;
        const what = a.kind === 'created' ? 'criou' : a.kind === 'note' ? `comentou ("${a.body.slice(0, 80)}${a.body.length > 80 ? '…' : ''}") em` : `${a.body} em`;
        return `${a.created_at.slice(0, 16).replace('T', ' ')} · ${who} ${what} #${a.task_id} ${a.title} (${a.project_name})`;
      }).join('\n');
    },
  },

  // ===== equipe e notificações =====

  list_members: {
    title: 'Listar membros',
    description: 'List team members who can be assigned to tasks, and who "me" is.',
    annotations: READ,
    inputSchema: { type: 'object', properties: {} },
    run() {
      const users = store.listUsers();
      const self = me();
      if (!users.length) return 'Ainda não há membros cadastrados no painel.';
      if (actingUser()?.role === 'viewer') return users.map((u) => `${u.name}${self?.id === u.id ? ' ← "me"' : ''}`).join('\n');
      return users.map((u) => `${u.name} <${u.email}>${u.role === 'admin' ? ' (admin)' : ''}${self?.id === u.id ? ' ← "me"' : ''}`).join('\n');
    },
  },

  send_notification: {
    title: 'Enviar notificação',
    description: 'Send a notification to board members (bell in the dashboard and, if enabled, macOS). Use for things the user asked to be reminded of.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        task_id: { type: 'integer', description: 'Related task, optional.' },
        to: { type: 'array', items: { type: 'string' }, description: 'Members (name, e-mail or "me"). Default: everyone.' },
      },
      required: ['message'],
    },
    run(args) {
      if (args.task_id) requireTask(args.task_id);
      if (actingUser()?.role === 'viewer') throw new Error('Visualizadores não enviam notificações');
      const n = store.notify({ user_ids: args.to?.length ? userIds(args.to) : null, task_id: args.task_id ?? null, body: `${agentName(AGENT.author) || 'Claude'}: ${args.message}`, type: 'claude' });
      return `Notificação enviada (${n} destinatário(s)).`;
    },
  },

  list_notifications: {
    title: 'Ver notificações',
    description: 'List the board notifications of the current user ("me"), optionally marking them as read.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Default true.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
        mark_read: { type: 'boolean', description: 'Mark the listed ones as read. Default false.' },
      },
    },
    run(args) {
      const uid = me()?.id ?? null;
      let items = store.notifications(uid, { limit: 200 });
      if (args.unread_only !== false) items = items.filter((n) => !n.read_at);
      items = items.slice(0, args.limit || 20);
      if (args.mark_read && items.length) store.markRead(uid, items.map((n) => n.id));
      if (!items.length) return 'Nenhuma notificação.';
      return items.map((n) => `${n.created_at.slice(0, 16).replace('T', ' ')}${n.read_at ? '' : ' [nova]'} ${n.body}${n.task_id ? ` · ${taskLink(n.task_id)}` : ''}`).join('\n');
    },
  },

  // ===== automações e configurações =====

  manage_automations: {
    title: 'Gerenciar automações',
    description: 'List, create, update, enable, disable or delete automation rules ("when X → do Y"). Rules apply to changes made by anyone, including you; changes made by rules never trigger other rules.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'enable', 'disable', 'delete'] },
        id: { type: 'integer', description: 'Rule id (update/enable/disable/delete).' },
        name: { type: 'string' },
        ...projectProps,
        all_projects: { type: 'boolean', description: 'Apply to every project (default when no project is given on create).' },
        trigger: { type: 'string', enum: Object.keys(TRIGGERS) },
        conditions: {
          type: 'object',
          description: 'Optional filters.',
          properties: {
            to_status: { type: 'string', enum: STATUSES, description: 'status_changed: new status.' },
            from_status: { type: 'string', enum: STATUSES, description: 'status_changed: previous status.' },
            priority: { type: 'array', items: { type: 'string', enum: PRIORITIES } },
            type: { type: 'array', items: { type: 'string', enum: TYPES } },
            tag: { type: 'string' },
            by_claude: { type: 'boolean', description: 'Only tasks created by an agent through this server (Claude or Codex).' },
            days: { type: 'integer', description: 'due_soon: how many days before the deadline. Default 1.' },
            field: { type: 'string', description: 'task_updated: only when this task column changed, e.g. status, priority, due_date, tags, story_points, sprint_id, column_id, reporter_id (assignee changes use the "assigned" trigger).' },
          },
        },
        action_type: { type: 'string', enum: Object.keys(ACTIONS) },
        action_value: {
          type: ['string', 'number', 'null'],
          description: 'set_status: status · set_column: column name · set_priority: priority · add_tag/remove_tag: tag · add_comment/notify/send_email: text with {id} {ref} {titulo} {projeto} {prazo} {status} {prioridade} {sprint} · set_due_in_days: number · assign: member name/e-mail · move_to_sprint: sprint name/id, "active" or "next" · move_to_active_sprint: none.',
        },
        email_to: { type: 'string', description: 'send_email: "followers" (default), "assignees" or comma-separated e-mails.' },
        email_subject: { type: 'string', description: 'send_email: subject (same variables as the text).' },
        enabled: { type: 'boolean' },
      },
      required: ['action'],
    },
    run(args) {
      // Regras globais: só administradores. Regras de um projeto: gerentes dele (como na API).
      const project = args.all_projects ? null : projectFrom(args, { create: false });
      const ruleGuard = (rule) => (rule?.project_id ? guardProject(rule.project_id, 'manage') : guardAdmin());
      if (args.action === 'create') ruleGuard({ project_id: project?.id });
      if (!['list', 'create'].includes(args.action)) {
        const rule = store.automation(cleanId(args.id));
        if (!rule) throw new Error(`Automação #${args.id} não encontrada`);
        ruleGuard(rule);
        if (project || args.all_projects) ruleGuard({ project_id: project?.id });
      }
      const body = () => {
        const b = {};
        if (args.name !== undefined) b.name = args.name;
        if (args.trigger) b.trigger = args.trigger;
        if (args.conditions) b.conditions = args.conditions;
        if (args.action_type) {
          b.action = { type: args.action_type, value: args.action_value ?? null };
          if (args.email_to) b.action.to = args.email_to;
          if (args.email_subject) b.action.subject = args.email_subject;
        }
        if (args.enabled !== undefined) b.enabled = args.enabled;
        if (project || args.all_projects) b.project_id = project?.id ?? null;
        return b;
      };
      switch (args.action) {
        case 'list': {
          const ids = visible();
          const rules = store.listAutomations().filter((r) => !r.project_id || !ids || ids.includes(r.project_id));
          return rules.length ? rules.map(describeAutomation).join('\n') : 'Nenhuma automação.';
        }
        case 'create': {
          const created = store.createAutomation(body());
          return `Criada: ${describeAutomation(store.listAutomations().find((r) => r.id === created.id))}`;
        }
        case 'update': store.updateAutomation(cleanId(args.id), body()); break;
        case 'enable': store.updateAutomation(cleanId(args.id), { enabled: true }); break;
        case 'disable': store.updateAutomation(cleanId(args.id), { enabled: false }); break;
        case 'delete': store.deleteAutomation(cleanId(args.id)); return `Automação #${args.id} excluída.`;
        default: throw new Error('Ação inválida');
      }
      return describeAutomation(store.listAutomations().find((r) => r.id === cleanId(args.id)));
    },
  },

  manage_settings: {
    title: 'Configurações do quadro',
    description: 'Read or change board preferences: macOS notifications, how many days before a deadline to warn, and the model used by the dashboard chat.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update'] },
        notify_macos: { type: 'boolean' },
        due_soon_days: { type: 'integer', minimum: 0, maximum: 30 },
        chat_model: { type: 'string', enum: ['sonnet', 'opus', 'haiku'] },
      },
      required: ['action'],
    },
    run(args) {
      if (args.action === 'update') {
        guardAdmin();
        const patch = {};
        for (const k of Object.keys(DEFAULT_SETTINGS)) if (args[k] !== undefined) patch[k] = args[k];
        if (patch.due_soon_days !== undefined && !(Number.isInteger(patch.due_soon_days) && patch.due_soon_days >= 0 && patch.due_soon_days <= 30)) {
          throw new Error('due_soon_days deve ser um inteiro de 0 a 30');
        }
        store.updateSettings(patch);
      }
      const s = store.settings();
      return `Notificações do macOS: ${s.notify_macos ? 'ligadas' : 'desligadas'}\nAvisar prazos com ${s.due_soon_days} dia(s) de antecedência\nModelo do chat do painel: ${s.chat_model}`;
    },
  },
};

Object.assign(TOOLS, EXTRA_TOOLS);
