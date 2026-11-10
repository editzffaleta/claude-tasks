// Estado e formatação compartilhados pelas ferramentas, resources e prompts do MCP.
import {
  BOARD_URL, COLUMN_NAME, DEPENDENCY_LABEL, PRIORITY_LABEL, STATUS_LABEL, Store,
  describeRecurrence, formatDuration, formatTask, today,
} from '../db.js';
import { agentName } from '../agents.js';
import { attachEngine } from '../engine.js';

export const store = new Store();
attachEngine(store);

// Agente que está escrevendo. O cliente MCP diz quem é no initialize (Claude ou Codex), e o chat
// do painel com outro provedor troca para "ia" durante a execução.
export const AGENT = { author: 'claude' };

// Pessoa conversando no chat do painel (provedores de API rodam as ferramentas aqui dentro).
let currentUser = null;
export const setCurrentUser = (user) => { currentUser = user; };

// Quem está usando o Claude: CLAUDE_TASKS_USER (e-mail ou nome) ou, se o quadro tem
// uma única conta, essa conta. Usado para "minhas tarefas", timers e notificações.
export function me() {
  if (currentUser) return currentUser;
  const ref = process.env.CLAUDE_TASKS_USER;
  if (ref) return store.findUser(ref);
  const users = store.listUsers();
  return users.length === 1 ? users[0] : null;
}

// Permissões só valem no chat do painel (usuário definido ou CLAUDE_TASKS_ENFORCE=1).
// Nas suas sessões locais do Claude o MCP tem acesso total, como o próprio arquivo do banco.
export const actingUser = () => currentUser || (process.env.CLAUDE_TASKS_ENFORCE ? me() : null);
export const visible = () => store.visibleProjectIds(actingUser());

export function guardProject(project, level = 'read') {
  const user = actingUser();
  if (user && project) store.assertCan(user, project, level);
}

export function guardTask(ref, level = 'read') {
  const id = store.resolveTaskRef(ref);
  const t = store.task(id);
  if (!t) throw new Error(`Tarefa #${id} não encontrada`);
  guardProject(t.project_id, level);
  return t;
}

export function guardAdmin() {
  const user = actingUser();
  if (user && user.role !== 'admin') throw new Error('Só administradores podem fazer isso');
}

// Tempo registrado pelo agente conta para a pessoa que está usando ele.
export const timeActor = () => ({ author: AGENT.author, user_id: me()?.id ?? null });

export const boardLink = (project) => (project ? `${BOARD_URL}/?project=${project.id}` : BOARD_URL);
export const taskLink = (id) => `${BOARD_URL}/?task=${id}`;

export function projectFrom(args, { create = true, level = 'read' } = {}) {
  if (!args.project_path && !args.project) return null;
  const user = actingUser();
  if (user && create && user.role === 'viewer') create = false;
  const p = store.resolveProject({ project_path: args.project_path, project: args.project, create });
  if (p) guardProject(p, level);
  return p;
}

// Sem projeto informado, usa o diretório em que a sessão do Claude está.
export function requireProject(args, { create = true, level = 'edit' } = {}) {
  const p = projectFrom(args, { create, level }) || (actingUser() ? null : store.resolveProject({ project_path: process.cwd(), create }));
  if (!p) throw new Error('Informe o projeto (project ou project_path)');
  guardProject(p, level);
  return p;
}

export function userIds(refs) {
  return (Array.isArray(refs) ? refs : [refs]).filter(Boolean).map((r) => {
    if (r === 'me' || r === 'eu') {
      const u = me();
      if (!u) throw new Error('Não sei quem é "eu": defina CLAUDE_TASKS_USER na configuração do MCP');
      return u.id;
    }
    const u = store.findUser(r);
    if (!u) throw new Error(`Membro "${r}" não encontrado (veja list_members)`);
    return u.id;
  });
}

// Versão enxuta da tarefa para respostas em JSON.
export function taskJson(t) {
  return {
    id: t.id,
    ref: t.ref,
    title: t.title,
    project: t.project_name,
    project_id: t.project_id,
    status: t.status,
    column: t.column_name || COLUMN_NAME[t.status],
    priority: t.priority,
    type: t.type,
    tags: t.tags,
    start_date: t.start_date,
    due_date: t.due_date,
    overdue: t.overdue,
    estimate_minutes: t.estimate_minutes,
    remaining_minutes: t.remaining_minutes,
    spent_minutes: t.spent_minutes,
    story_points: t.story_points,
    sprint: t.sprint_name,
    parent_id: t.parent_id,
    subtasks: t.subtask_count ? { done: t.subtask_done, total: t.subtask_count } : null,
    open_blockers: t.open_blockers,
    assignees: t.assignee_ids.map((id) => store.user(id)?.name).filter(Boolean),
    watchers: t.watcher_ids.map((id) => store.user(id)?.name).filter(Boolean),
    reporter: t.reporter_id ? store.user(t.reporter_id)?.name ?? null : null,
    fields: Object.fromEntries(store.customFields(t.project_id).filter((f) => t.field_values?.[f.id] != null).map((f) => [f.name, t.field_values[f.id]])),
    recurrence: t.recurrence,
    archived: !!t.archived_at,
    source: t.source,
    created_at: t.created_at,
    updated_at: t.updated_at,
    completed_at: t.completed_at,
    url: taskLink(t.id),
  };
}

export function describeTask(t) {
  const lines = [
    formatTask(t),
    `Projeto: ${t.project_name}${t.project_path ? ` (${t.project_path})` : ''} · coluna: ${t.column_name || COLUMN_NAME[t.status]}`,
  ];
  const facts = [];
  if (t.start_date) facts.push(`início ${t.start_date}`);
  if (t.due_date) facts.push(`prazo ${t.due_date}${t.overdue ? ' (atrasada)' : ''}`);
  if (t.estimate_minutes || t.spent_minutes) {
    facts.push(`tempo ${formatDuration(t.spent_minutes)} de ${t.estimate_minutes ? formatDuration(t.estimate_minutes) : 'sem estimativa'}${t.timer_running ? ' (timer rodando)' : ''}`);
  }
  if (t.remaining_minutes != null) facts.push(`restante ${formatDuration(t.remaining_minutes)}`);
  if (t.story_points != null) facts.push(`${t.story_points} story points`);
  if (t.recurrence) facts.push(`repete ${describeRecurrence(t.recurrence)}`);
  if (t.sprint_name) facts.push(`sprint ${t.sprint_name}`);
  const people = store.assigneesOf(t.id).map((u) => u.name);
  if (people.length) facts.push(`responsáveis: ${people.join(', ')}`);
  if (t.reporter_id) facts.push(`relator: ${store.user(t.reporter_id)?.name}`);
  const watchers = (t.watchers || store.watchersOf(t.id)).map((u) => u.name);
  if (watchers.length) facts.push(`observadores: ${watchers.join(', ')}`);
  if (facts.length) lines.push(facts.join(' · '));
  const fields = (t.fields || store.fieldsWithValues(t)).filter((f) => f.value != null);
  if (fields.length) {
    lines.push(`Campos: ${fields.map((f) => `${f.name} = ${f.type === 'user' ? store.user(f.value)?.name : Array.isArray(f.value) ? f.value.join(', ') : f.value}`).join(' · ')}`);
  }
  if (t.allowed_columns) {
    const names = t.allowed_columns.slice(1).map((id) => store.column(id)?.name).filter(Boolean);
    lines.push(`Pode ir para: ${names.join(', ') || 'nenhuma coluna (transições restritas)'}`);
  }
  lines.push(`Criada: ${t.created_at} por ${t.source} · Atualizada: ${t.updated_at} · ${taskLink(t.id)}`, '', t.description || '(sem descrição)');
  if (t.parent_id) lines.push('', `Subtarefa de #${t.parent_id} ${t.parent_title}`);
  if (t.subtasks?.length) lines.push('', 'Subtarefas:', ...t.subtasks.map((s) => `- ${formatTask(s)}`));
  const dep = (b) => `- #${b.id} [${STATUS_LABEL[b.status]}] ${b.title}${b.type && b.type !== 'finish_start' ? ` (${DEPENDENCY_LABEL[b.type]})` : ''}`;
  if (t.blockers?.length) lines.push('', 'Bloqueada por:', ...t.blockers.map(dep));
  if (t.blocking?.length) lines.push('', 'Bloqueia:', ...t.blocking.map(dep));
  if (t.attachments?.length) {
    lines.push('', 'Anexos (leia com get_attachment):', ...t.attachments.map((a) => `- id ${a.id}: ${a.name} (${a.mime}, ${Math.ceil(a.size / 1024)} KB)`));
  }
  if (t.time_entries?.length) {
    lines.push('', 'Tempo registrado:', ...t.time_entries.slice(0, 10).map((e) => `- ${e.started_at.slice(0, 10)} ${e.user_name || e.author}: ${e.ended_at ? formatDuration(e.minutes) : 'rodando'}${e.note ? ` — ${e.note}` : ''}`));
  }
  const notes = (t.notes || []).map((n) => `${n.parent_id ? '  ↳ ' : '- '}${n.created_at.slice(0, 16).replace('T', ' ')} ${agentName(n.author) || n.user_name || n.author}${n.kind === 'note' ? ` [comentário ${n.id}${n.edited_at ? ', editado' : ''}]` : ''}${n.kind === 'event' ? ' ·' : ':'} ${n.body}`);
  if (notes.length) lines.push('', 'Histórico:', ...notes);
  return lines.join('\n');
}

// Quadro do projeto em texto: colunas com as tarefas abertas (subtarefas recuadas).
export function projectBoard(project) {
  const cols = store.columns(project.id);
  const tasks = store.listTasks({ project_id: project.id, status: 'open', limit: 1000 });
  const sprints = store.sprints(project.id).filter((s) => s.status === 'active' || s.status === 'planning');
  const lines = [`# ${project.name}`, project.path ? `Pasta: ${project.path}` : 'Sem pasta vinculada', boardLink(project)];
  if (project.description) lines.push('', project.description);
  for (const s of sprints) {
    lines.push('', `Sprint ${s.status === 'active' ? 'ativa' : 'planejada'}: ${s.name} (${s.done}/${s.total} concluídas)${s.goal ? ` — ${s.goal}` : ''}`);
  }
  for (const col of cols.filter((c) => c.status !== 'done')) {
    const list = tasks.filter((t) => (t.column_id ? t.column_id === col.id : cols.find((c) => c.status === t.status) === col));
    lines.push('', `## ${col.name} (${list.length})`);
    for (const t of list) lines.push(`${t.parent_id ? '  - ' : '- '}${formatTask(t)}`);
  }
  const done = store.listTasks({ project_id: project.id, status: 'done', limit: 10 });
  if (done.length) lines.push('', '## Concluídas recentemente', ...done.map((t) => `- ${formatTask(t)}`));
  return lines.join('\n');
}

export function overviewText(project) {
  const s = store.stats({ project_id: project?.id, project_ids: project ? undefined : visible() });
  const t = s.totals;
  const lines = [
    project ? `# Visão geral · ${project.name}` : '# Visão geral de todos os projetos',
    `Hoje: ${today()}`,
    '',
    `Abertas: ${t.open} (${t.doing} em andamento, ${t.blocked} bloqueadas) · Atrasadas: ${t.overdue} · Vencem em 7 dias: ${t.due_week}`,
    `Últimos 7 dias: ${t.done_7d} concluídas, ${t.created_7d} criadas (${t.claude_7d} pelo Claude${t.codex_7d ? `, ${t.codex_7d} pelo Codex` : ''}), ${formatDuration(t.minutes_7d)} registradas`,
  ];
  if (!project && s.byProject.length) {
    lines.push('', '## Por projeto', ...s.byProject.sort((a, b) => b.open - a.open)
      .map((p) => `- ${p.name}: ${p.open} abertas${p.doing ? `, ${p.doing} em andamento` : ''}${p.blocked ? `, ${p.blocked} bloqueadas` : ''}${p.overdue ? `, ${p.overdue} ATRASADAS` : ''}`));
  }
  lines.push('', '## Por prioridade (abertas)', ['urgent', 'high', 'medium', 'low', 'lowest'].map((k) => `${PRIORITY_LABEL[k]}: ${s.byPriority[k]}`).join(' · '));
  if (s.sprint) lines.push('', `## Sprint ativa: ${s.sprint.name} — ${s.sprint.done}/${s.sprint.total} concluídas${s.sprint.end_date ? `, termina ${s.sprint.end_date}` : ''}`);
  const overdue = store.listTasks({ project_id: project?.id, project_ids: project ? undefined : visible(), due: 'overdue', limit: 15 });
  if (overdue.length) lines.push('', '## Atrasadas', ...overdue.map((x) => `- ${formatTask(x, { withProject: !project })}`));
  if (s.upcoming.length) lines.push('', '## Próximos prazos', ...s.upcoming.map((x) => `- ${formatTask(x, { withProject: !project })}`));
  const doing = store.listTasks({ project_id: project?.id, project_ids: project ? undefined : visible(), status: 'doing', limit: 15 });
  if (doing.length) lines.push('', '## Em andamento', ...doing.map((x) => `- ${formatTask(x, { withProject: !project })}`));
  const blocked = store.listTasks({ project_id: project?.id, project_ids: project ? undefined : visible(), status: 'blocked', limit: 15 });
  if (blocked.length) lines.push('', '## Bloqueadas', ...blocked.map((x) => `- ${formatTask(x, { withProject: !project })}`));
  return lines.join('\n');
}

