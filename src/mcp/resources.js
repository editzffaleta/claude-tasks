// Resources do MCP: conteúdo que dá para citar numa conversa com @ (ex.: @tarefas:tarefas://tasks/12).
import { cleanId, formatTask } from '../db.js';
import { describeTask, me, overviewText, projectBoard, store } from './context.js';

const MD = 'text/markdown';

export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'tarefas://tasks/{id}',
    name: 'task',
    title: 'Tarefa',
    description: 'Tarefa completa: descrição, subtarefas, dependências, tempo, anexos e histórico.',
    mimeType: MD,
  },
  {
    uriTemplate: 'tarefas://projects/{id}',
    name: 'project-board',
    title: 'Quadro do projeto',
    description: 'Colunas do projeto com as tarefas abertas, sprints e concluídas recentes.',
    mimeType: MD,
  },
  {
    uriTemplate: 'tarefas://projects/{id}/overview',
    name: 'project-overview',
    title: 'Visão geral do projeto',
    description: 'Totais, atrasadas, próximos prazos, em andamento e bloqueadas do projeto.',
    mimeType: MD,
  },
];

export function listResources() {
  return [
    { uri: 'tarefas://overview', name: 'overview', title: 'Visão geral do quadro', description: 'Totais, atrasadas, prazos e andamento de todos os projetos.', mimeType: MD },
    { uri: 'tarefas://my-tasks', name: 'my-tasks', title: 'Minhas tarefas', description: 'Tarefas abertas atribuídas a você.', mimeType: MD },
    ...store.listProjects({ include_archived: false }).map((p) => ({
      uri: `tarefas://projects/${p.id}`,
      name: `project-${p.id}`,
      title: `Projeto ${p.name}`,
      description: `${p.open} abertas${p.overdue ? `, ${p.overdue} atrasadas` : ''}. Quadro com colunas e tarefas.`,
      mimeType: MD,
    })),
  ];
}

function myTasks() {
  const user = me();
  if (!user) return 'Não sei quem é você no quadro: defina CLAUDE_TASKS_USER (e-mail) na configuração do MCP.';
  const tasks = store.listTasks({ assignee_id: user.id, status: 'open', limit: 500 });
  if (!tasks.length) return `# Tarefas de ${user.name}\n\nNada atribuído a você.`;
  return [`# Tarefas de ${user.name} (${tasks.length})`, '', ...tasks.map((t) => `- ${formatTask(t, { withProject: true })}`)].join('\n');
}

export function readResource(uri) {
  let text;
  let m;
  if (uri === 'tarefas://overview') text = overviewText(null);
  else if (uri === 'tarefas://my-tasks') text = myTasks();
  else if ((m = uri.match(/^tarefas:\/\/tasks\/#?(\d+)$/))) {
    const t = store.taskWithNotes(cleanId(m[1]));
    if (t) text = describeTask(t);
  } else if ((m = uri.match(/^tarefas:\/\/projects\/(\d+)\/overview$/))) {
    const p = store.project(Number(m[1]));
    if (p) text = overviewText(p);
  } else if ((m = uri.match(/^tarefas:\/\/projects\/(\d+)$/))) {
    const p = store.project(Number(m[1]));
    if (p) text = projectBoard(p);
  }
  if (text === undefined) throw Object.assign(new Error(`Resource não encontrado: ${uri}`), { code: -32002 });
  return { contents: [{ uri, mimeType: MD, text }] };
}
