#!/usr/bin/env node
// Servidor MCP (stdio) do quadro de tarefas. O Claude Code inicia um destes por sessão;
// todos gravam no mesmo banco SQLite.
import { createInterface } from 'node:readline';
import {
  BOARD_URL, FREQS, PRIORITIES, STATUSES, STATUS_LABEL, Store, TYPES,
  cleanId, describeRecurrence, formatDuration, formatTask,
} from './db.js';
import { attachEngine } from './engine.js';

const store = new Store();
attachEngine(store);
const CLAUDE = { author: 'claude' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Central task board shared across ALL of the user's projects (dashboard: ${BOARD_URL}). Keep it current:
- Record pending work with add_tasks: follow-ups you propose, bugs or problems you notice but don't fix, steps left unfinished when you stop, and anything the user says to do later. Don't record steps you will finish in this same turn.
- Always pass project_path = your current working directory so the task lands in the right project (git worktrees map to their main repository).
- Check list_tasks for the project first and update an existing task instead of adding a near-duplicate.
- Short, actionable titles. Descriptions must let someone resume cold: what, why, relevant files, what is already done.
- Break big work into subtasks (parent_id) and record ordering with blocked_by. Set due_date only when there is a real deadline.
- Set status to "doing" when you start a task and "blocked" (with a note) when stuck. When you finish work that matches an open task, call complete_tasks with a one-line note of what was done.
- Write titles, descriptions and notes in Brazilian Portuguese.`;

const projectProps = {
  project_path: {
    type: 'string',
    description: 'Absolute path inside the project (normally your current working directory). The project is the git repository containing it.',
  },
  project: {
    type: 'string',
    description: 'Project name or id, for work not tied to a folder or to target another known project. Ignored when project_path is given.',
  },
};

const date = (description) => ({ type: ['string', 'null'], description: `${description} Format YYYY-MM-DD; null clears it.` });

const taskFields = {
  title: { type: 'string', description: 'Short, actionable title.' },
  description: { type: 'string', description: 'Context to resume later: what, why, files involved, what is already done. Markdown allowed.' },
  priority: { type: 'string', enum: PRIORITIES, description: 'Default: medium.' },
  status: { type: 'string', enum: STATUSES, description: 'Default: todo.' },
  column: { type: 'string', description: 'Custom board column name of the project (e.g. "Revisão"). Sets status accordingly.' },
  type: { type: 'string', enum: TYPES, description: 'Default: task.' },
  tags: { type: 'array', items: { type: 'string' }, description: 'e.g. bug, ui, backend, refactor.' },
  start_date: date('When work should start.'),
  due_date: date('Deadline.'),
  estimate: { type: ['string', 'null'], description: 'Effort estimate like "30m", "2h", "1h30m", "1d" (= 8h).' },
  parent_id: { type: ['integer', 'null'], description: 'Make this a subtask of another task (same project).' },
  blocked_by: { type: 'array', items: { type: 'integer' }, description: 'Ids of tasks that must be done first.' },
  sprint: { type: ['string', 'null'], description: 'Sprint name/id, "active" for the active sprint, or null for backlog.' },
  assignees: { type: 'array', items: { type: 'string' }, description: 'Team members (name or e-mail). See list_members.' },
  recurrence: {
    type: ['object', 'null'],
    description: 'Repeat when completed: the next occurrence is created automatically. null removes it.',
    properties: {
      freq: { type: 'string', enum: FREQS },
      interval: { type: 'integer', minimum: 1, description: 'Every N units. Default 1.' },
      until: { type: 'string', description: 'Last date (YYYY-MM-DD), optional.' },
    },
    required: ['freq'],
  },
};

const idList = (ids) => {
  const list = (Array.isArray(ids) ? ids : [ids]).map((x) => cleanId(x));
  if (!list.length) throw new Error('Informe ao menos um id de tarefa');
  return list;
};

const boardLink = (project) => (project ? `${BOARD_URL}/?project=${project.id}` : BOARD_URL);

function projectFrom(args, { create = true } = {}) {
  if (args.project_path || args.project) return store.resolveProject({ ...args, create });
  return null;
}

function requireProject(args) {
  return projectFrom(args) || store.resolveProject({ project_path: process.cwd() });
}

function describeTask(t) {
  const lines = [
    formatTask(t),
    `Projeto: ${t.project_name}${t.project_path ? ` (${t.project_path})` : ''} · coluna: ${t.column_name || STATUS_LABEL[t.status]}`,
  ];
  const facts = [];
  if (t.start_date) facts.push(`início ${t.start_date}`);
  if (t.due_date) facts.push(`prazo ${t.due_date}${t.overdue ? ' (atrasada)' : ''}`);
  if (t.estimate_minutes || t.spent_minutes) facts.push(`tempo ${formatDuration(t.spent_minutes)} de ${t.estimate_minutes ? formatDuration(t.estimate_minutes) : 'sem estimativa'}`);
  if (t.recurrence) facts.push(`repete ${describeRecurrence(t.recurrence)}`);
  if (t.sprint_name) facts.push(`sprint ${t.sprint_name}`);
  const people = store.assigneesOf(t.id).map((u) => u.name);
  if (people.length) facts.push(`responsáveis: ${people.join(', ')}`);
  if (facts.length) lines.push(facts.join(' · '));
  lines.push(`Criada: ${t.created_at} por ${t.source} · Atualizada: ${t.updated_at}`, '', t.description || '(sem descrição)');
  if (t.parent_id) lines.push('', `Subtarefa de #${t.parent_id} ${t.parent_title}`);
  if (t.subtasks.length) lines.push('', 'Subtarefas:', ...t.subtasks.map((s) => `- ${formatTask(s)}`));
  if (t.blockers.length) lines.push('', 'Bloqueada por:', ...t.blockers.map((b) => `- #${b.id} [${STATUS_LABEL[b.status]}] ${b.title}`));
  if (t.blocking.length) lines.push('', 'Bloqueia:', ...t.blocking.map((b) => `- #${b.id} [${STATUS_LABEL[b.status]}] ${b.title}`));
  if (t.attachments.length) lines.push('', 'Anexos:', ...t.attachments.map((a) => `- ${a.name} (${Math.ceil(a.size / 1024)} KB) ${BOARD_URL}/api/attachments/${a.id}`));
  const notes = t.notes.map((n) => `- ${n.created_at.slice(0, 16).replace('T', ' ')} ${n.user_name || n.author}${n.kind === 'event' ? ' ·' : ':'} ${n.body}`);
  if (notes.length) lines.push('', 'Histórico:', ...notes);
  return lines.join('\n');
}

const TOOLS = {
  add_tasks: {
    description: 'Add one or more pending tasks to a project on the central board. Open tasks with the same title in the same place are not duplicated.',
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
          const { task, duplicate } = store.addTask(project.id, item, CLAUDE);
          return `${duplicate ? 'já existia' : 'criada'}: ${formatTask(task)}`;
        });
        return [`Projeto: ${project.name}`, ...lines, `Quadro: ${boardLink(project)}`].join('\n');
      });
    },
  },

  list_tasks: {
    description: 'List tasks on the board. Without project_path/project it lists every project. Default status filter is "open" (everything not done).',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        status: { type: 'string', enum: ['open', 'all', ...STATUSES], description: 'Default: open.' },
        query: { type: 'string', description: 'Text search in title, description and tags.' },
        due: { type: 'string', enum: ['overdue', 'today', 'week', 'any', 'none'], description: 'Filter by deadline.' },
        sprint: { type: 'string', description: 'Sprint name/id, "active" or "backlog". Needs a project.' },
        assignee: { type: 'string', description: 'Team member name or e-mail.' },
        type: { type: 'string', enum: TYPES },
        include_subtasks: { type: 'boolean', description: 'Default true.' },
        include_archived: { type: 'boolean', description: 'Default false.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Default: 100.' },
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
      let assignee_id;
      if (args.assignee) {
        assignee_id = store.findUser(args.assignee)?.id;
        if (!assignee_id) throw new Error(`Membro "${args.assignee}" não encontrado`);
      }
      const tasks = store.listTasks({
        project_id: project?.id, status: args.status || 'open', q: args.query, due: args.due, sprint_id, assignee_id,
        type: args.type, top_level: args.include_subtasks === false, include_archived: !!args.include_archived, limit: args.limit || 100,
      });
      if (!tasks.length) return project ? `Nenhuma tarefa (${args.status || 'open'}) em ${project.name}.` : 'Nenhuma tarefa encontrada.';
      if (project) return [`Projeto: ${project.name}`, ...tasks.map((t) => formatTask(t))].join('\n');
      const groups = Map.groupBy(tasks, (t) => t.project_name);
      return [...groups].map(([name, list]) => `## ${name}\n${list.map((t) => formatTask(t)).join('\n')}`).join('\n\n');
    },
  },

  get_task: {
    description: 'Get one task with full description, subtasks, dependencies, time, attachments and history.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    run({ id }) {
      const t = store.taskWithNotes(cleanId(id));
      if (!t) throw new Error(`Tarefa #${id} não encontrada`);
      return describeTask(t);
    },
  },

  update_task: {
    description: 'Update a task: change any field, move it to another project, archive it, and/or append a note.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        ...taskFields,
        note: { type: 'string', description: 'Note appended to the task history (progress, blocker, decision).' },
        archived: { type: 'boolean' },
        project_path: { type: 'string', description: 'Move the task to the project containing this path.' },
        project: { type: 'string', description: 'Move the task to the project with this name.' },
      },
      required: ['id'],
    },
    run(args) {
      const id = cleanId(args.id);
      return store.transaction(() => {
        const { id: _, note, project_path, project, ...patch } = args;
        const target = projectFrom({ project_path, project });
        if (target) patch.project_id = target.id;
        store.updateTask(id, patch, CLAUDE);
        if (note) store.addNote(id, note, CLAUDE);
        return `Atualizada: ${formatTask(store.task(id), { withProject: true })}`;
      });
    },
  },

  complete_tasks: {
    description: 'Mark one or more tasks as done, optionally with a note about what was done. Recurring tasks spawn their next occurrence.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'integer' }, minItems: 1 },
        note: { type: 'string', description: 'What was done (added to each task history).' },
      },
      required: ['ids'],
    },
    run(args) {
      return store.transaction(() => idList(args.ids).map((id) => {
        store.stopTaskTimers(id, CLAUDE);
        const t = store.updateTask(id, { status: 'done' }, CLAUDE);
        if (args.note) store.addNote(id, args.note, CLAUDE);
        const next = t.recurrence_next_id ? ` → próxima ocorrência #${t.recurrence_next_id}` : '';
        return `concluída: ${formatTask(store.task(id), { withProject: true })}${next}`;
      }).join('\n'));
    },
  },

  list_projects: {
    description: 'List all projects on the board with their task counts and board columns.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const projects = store.listProjects();
      if (!projects.length) return 'O quadro ainda está vazio.';
      return projects.map((p) => {
        const cols = store.columns(p.id).map((c) => c.name).join(' → ');
        const late = p.overdue ? `, ${p.overdue} atrasadas` : '';
        return `${p.name}${p.archived_at ? ' (arquivado)' : ''}: ${p.open} abertas (${p.doing} em andamento, ${p.blocked} bloqueadas${late}), ${p.done} concluídas — ${p.path || 'sem pasta'}\n  colunas: ${cols}`;
      }).join('\n');
    },
  },

  manage_sprints: {
    description: 'List, create, update, start or complete sprints of a project. Completing moves unfinished tasks to move_to (another sprint id) or to the backlog.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        action: { type: 'string', enum: ['list', 'create', 'update', 'start', 'complete', 'delete'] },
        id: { type: 'integer', description: 'Sprint id (update/start/complete/delete).' },
        name: { type: 'string' },
        goal: { type: 'string' },
        start_date: date('Sprint start.'),
        end_date: date('Sprint end.'),
        move_to: { type: 'integer', description: 'On complete: sprint id that receives unfinished tasks. Omit for backlog.' },
      },
      required: ['action'],
    },
    run(args) {
      const project = requireProject(args);
      const fmt = (s) => `#${s.id} ${s.name} [${{ planning: 'planejamento', active: 'ativa', completed: 'concluída' }[s.status]}]`
        + `${s.start_date || s.end_date ? ` ${s.start_date || '?'} → ${s.end_date || '?'}` : ''}${s.total !== undefined ? ` · ${s.done}/${s.total} concluídas` : ''}${s.goal ? ` — ${s.goal}` : ''}`;
      switch (args.action) {
        case 'list': {
          const list = store.sprints(project.id);
          return list.length ? [`Sprints de ${project.name}:`, ...list.map(fmt)].join('\n') : `${project.name} não tem sprints.`;
        }
        case 'create': return `Criada: ${fmt(store.createSprint(project.id, args))}`;
        case 'update': return `Atualizada: ${fmt(store.updateSprint(cleanId(args.id), args))}`;
        case 'start': return `Iniciada: ${fmt(store.startSprint(cleanId(args.id)))}`;
        case 'complete': {
          const r = store.completeSprint(cleanId(args.id), { move_to: args.move_to });
          return `Concluída: ${fmt(r.sprint)}. ${r.moved} tarefa(s) pendente(s) movida(s) para ${r.moved_to ? r.moved_to.name : 'o backlog'}.`;
        }
        case 'delete': store.deleteSprint(cleanId(args.id)); return 'Sprint excluída (as tarefas foram para o backlog).';
        default: throw new Error('Ação inválida');
      }
    },
  },

  log_time: {
    description: 'Log time spent on a task (e.g. how long a work session took).',
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
      const id = cleanId(args.id);
      store.logTime(id, args, CLAUDE);
      const t = store.task(id);
      return `Tempo registrado em #${id}. Total: ${formatDuration(t.spent_minutes)}${t.estimate_minutes ? ` de ${formatDuration(t.estimate_minutes)} estimados` : ''}.`;
    },
  },

  attach_file: {
    description: 'Attach a local file (screenshot, log, report) to a task.',
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
      const a = store.attachFile(cleanId(args.id), args.path, CLAUDE, args.name);
      return `Anexado em #${args.id}: ${a.name} (${Math.ceil(a.size / 1024)} KB).`;
    },
  },

  list_members: {
    description: 'List team members who can be assigned to tasks.',
    inputSchema: { type: 'object', properties: {} },
    run() {
      const users = store.listUsers();
      return users.length
        ? users.map((u) => `${u.name} <${u.email}>${u.role === 'admin' ? ' (admin)' : ''}`).join('\n')
        : 'Ainda não há membros cadastrados no painel.';
    },
  },
};

// ---- JSON-RPC sobre stdio (uma mensagem por linha) ----

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'tarefas', title: 'Quadro de tarefas', version: '2.0.0' },
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) };
    case 'tools/call': {
      const tool = TOOLS[params.name];
      if (!tool) throw Object.assign(new Error(`Ferramenta desconhecida: ${params.name}`), { code: -32602 });
      try {
        return { content: [{ type: 'text', text: tool.run(params.arguments || {}) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true };
      }
    }
    default:
      if (id === undefined) return undefined; // notificação (ex.: notifications/initialized)
      throw Object.assign(new Error(`Método não suportado: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'JSON inválido' } });
  }
  try {
    const result = handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
