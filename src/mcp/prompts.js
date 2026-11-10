// Prompts do MCP. No Claude Code viram comandos: /mcp__tarefas__<nome>.
// Cada prompt já embute os dados do quadro que importam, para o Claude começar sem consultas extras.
import { addDays, formatDuration, formatTask, today } from '../db.js';
import { describeTask, overviewText, projectBoard, store, visible } from './context.js';

// Projeto do argumento ou, sem argumento, o da pasta onde a sessão está.
function projectArg(value) {
  if (value) {
    const p = store.resolveProject({ project: value, create: false });
    if (!p) throw Object.assign(new Error(`Projeto "${value}" não encontrado no quadro`), { code: -32602 });
    return p;
  }
  return store.resolveProject({ project_path: process.cwd(), create: false });
}

// Aceita 12, "#12", o código do projeto ("WEB-12") e a sugestão do autocompletar ("12 Título").
function taskArg(value) {
  const text = String(value || '').trim();
  const code = text.match(/^#?([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![\w-])/)?.[1];
  let id = null;
  try {
    id = code ? store.resolveTaskRef(code) : Number(text.match(/\d+/)?.[0]);
  } catch {
    // Código que não existe: cai no erro abaixo.
  }
  const t = id && store.taskWithNotes(id);
  if (!t) throw Object.assign(new Error(`Tarefa "${value}" não encontrada`), { code: -32602 });
  return t;
}

const scopeLine = (p) => (p ? `Projeto: ${p.name}${p.path ? ` (project_path: ${p.path})` : ''}` : 'Escopo: todos os projetos');

export const PROMPTS = {
  pendencias: {
    title: 'Pendências do projeto',
    description: 'Mostra o que está aberto no projeto (ou em todos), destacando atrasadas e bloqueadas, e sugere a próxima tarefa.',
    arguments: [{ name: 'projeto', description: 'Nome do projeto. Padrão: o da pasta atual.', required: false }],
    build({ projeto }) {
      const p = projectArg(projeto);
      return `${scopeLine(p)}

Resuma as pendências abaixo em português, de forma curta: agrupe por prioridade, destaque o que está atrasado, bloqueado ou em andamento, e termine sugerindo a próxima tarefa a atacar (e por quê, em uma frase). Não altere nada no quadro.

${p ? projectBoard(p) : overviewText(null)}`;
    },
  },

  proxima: {
    title: 'Pegar a próxima tarefa',
    description: 'Escolhe a tarefa mais importante e desbloqueada, marca como em andamento, inicia o timer e começa a trabalhar nela.',
    arguments: [{ name: 'projeto', description: 'Nome do projeto. Padrão: o da pasta atual.', required: false }],
    build({ projeto }) {
      const p = projectArg(projeto);
      const order = { urgent: 0, high: 1, medium: 2, low: 3 };
      const candidates = store.listTasks({ project_id: p?.id, project_ids: p ? undefined : visible(), status: 'open', limit: 1000 })
        .filter((t) => !t.open_blockers && t.status !== 'blocked' && !t.subtask_count)
        .sort((a, b) => (b.status === 'doing') - (a.status === 'doing') || order[a.priority] - order[b.priority]
          || (a.due_date || '9999').localeCompare(b.due_date || '9999'))
        .slice(0, 15);
      return `${scopeLine(p)}

Escolha a próxima tarefa para trabalhar agora entre as candidatas abaixo (já sem bloqueios, ordenadas por andamento, prioridade e prazo). Prefira continuar o que já está em andamento.
Depois:
1. Diga qual escolheu e por quê, em uma frase.
2. Marque como "doing" com update_task e inicie o timer (timer start).
3. Leia os detalhes com get_task e comece o trabalho.
4. Ao terminar, use complete_tasks com uma nota do que foi feito (isso também para o timer).

Candidatas:
${candidates.map((t) => `- ${formatTask(t, { withProject: !p })}`).join('\n') || '(nenhuma tarefa disponível — avise o usuário)'}`;
    },
  },

  resolver: {
    title: 'Resolver tarefa',
    description: 'Pega uma tarefa específica do quadro, marca como em andamento, faz o trabalho e conclui com uma nota do que foi feito.',
    arguments: [{ name: 'tarefa', description: 'Número ou código da tarefa, ex.: 28 ou WEB-12', required: true }],
    build({ tarefa }) {
      const t = taskArg(tarefa);
      const open = t.subtasks.filter((s) => s.status !== 'done');
      const blockers = t.blockers.filter((b) => b.status !== 'done');
      const warnings = [];
      if (t.status === 'done') warnings.push('Esta tarefa já está concluída. Pergunte se é para reabrir antes de mexer em qualquer coisa.');
      if (t.archived_at) warnings.push('Esta tarefa está arquivada. Pergunte se é para desarquivar antes de trabalhar nela.');
      if (blockers.length) warnings.push(`${blockers.length} tarefa(s) precisam vir antes desta (veja "Bloqueada por"). Pergunte se é para resolver essas primeiro.`);
      // O código da tarefa mora na pasta do projeto dela; worktrees contam como o mesmo projeto.
      const here = store.resolveProject({ project_path: process.cwd(), create: false });
      if (t.project_path && here?.id !== t.project_id) {
        warnings.push(`Esta sessão está em ${process.cwd()}, e o projeto da tarefa fica em ${t.project_path}. Avise o usuário e não mexa em arquivos daqui sem ele confirmar.`);
      }
      return [
        `Resolva a tarefa #${t.id} do quadro, do começo ao fim.`,
        ...warnings.map((w) => `Atenção: ${w}`),
        '',
        '1. Marque como "doing" com update_task.',
        '2. Os detalhes estão abaixo; use get_attachment se precisar ver um anexo.',
        `3. Faça o trabalho.${open.length ? ` Ela tem ${open.length} subtarefa(s) aberta(s): resolva na ordem e conclua cada uma ao terminar.` : ''}`,
        '4. Se travar em algo que depende do usuário ou de terceiros, marque como "blocked" com uma nota dizendo o que falta, e pare.',
        '5. Ao terminar, use complete_tasks com uma nota curta do que foi feito, e registre com add_tasks o que ficar pendente.',
        '',
        describeTask(t),
      ].join('\n');
    },
  },

  registrar_pendencias: {
    title: 'Registrar pendências desta conversa',
    description: 'Revisa a conversa atual e registra no quadro tudo que ficou para depois, sem duplicar.',
    arguments: [],
    build() {
      const p = store.resolveProject({ project_path: process.cwd(), create: false });
      return `Revise esta conversa inteira e registre no quadro de tarefas tudo o que ficou pendente: follow-ups sugeridos, bugs encontrados e não corrigidos, etapas que ficaram para depois, decisões em aberto e qualquer coisa que eu disse para fazer mais tarde.

Regras:
- Use project_path = ${process.cwd()}${p ? ` (projeto "${p.name}")` : ''}.
- Antes, rode list_tasks nesse projeto e não duplique: se já existe algo parecido, atualize com update_task (note).
- Títulos curtos e acionáveis; descrição com contexto para retomar do zero (o quê, por quê, arquivos, o que já foi feito).
- Trabalho grande vira tarefa-mãe com subtarefas (parent_id) e ordem (blocked_by).
- Se algo que estava no quadro foi resolvido nesta conversa, conclua com complete_tasks.
- No fim, liste em poucas linhas o que foi criado, atualizado e concluído.`;
    },
  },

  concluir: {
    title: 'Concluir tarefa',
    description: 'Conclui uma tarefa registrando o que foi feito nesta sessão (e para o timer).',
    arguments: [
      { name: 'tarefa', description: 'Número da tarefa, ex.: 12', required: true },
      { name: 'resumo', description: 'O que foi feito (opcional; senão o Claude resume a sessão).', required: false },
    ],
    build({ tarefa, resumo }) {
      const t = taskArg(tarefa);
      const open = t.subtasks.filter((s) => s.status !== 'done');
      return `Conclua a tarefa #${t.id} com complete_tasks.
- Nota: ${resumo ? `"${resumo}"` : 'escreva um resumo curto do que foi feito nesta sessão (arquivos e decisões principais).'}
- Se você souber quanto tempo levou e não havia timer rodando, informe time_spent.
${open.length ? `- Atenção: ${open.length} subtarefa(s) ainda aberta(s). Pergunte se devem ser concluídas também ou ficar como pendência.` : ''}
- Se surgiu trabalho novo, registre com add_tasks.

${describeTask(t)}`;
    },
  },

  quebrar_tarefa: {
    title: 'Quebrar tarefa em subtarefas',
    description: 'Divide uma tarefa grande em subtarefas com ordem (dependências) e estimativas.',
    arguments: [{ name: 'tarefa', description: 'Número da tarefa, ex.: 12', required: true }],
    build({ tarefa }) {
      const t = taskArg(tarefa);
      return `Quebre a tarefa #${t.id} em subtarefas concretas (de 30 minutos a 1 dia cada), lendo o código do projeto se precisar entender o escopo.
- Crie com add_tasks usando parent_id: ${t.id}, com descrição e estimate em cada uma.
- Registre a ordem obrigatória com blocked_by (ids das subtarefas criadas antes).
- Se a tarefa-mãe não tinha estimativa, atualize com a soma.
- Mostre no fim a lista criada, na ordem de execução.

${describeTask(t)}`;
    },
  },

  planejar_sprint: {
    title: 'Planejar sprint',
    description: 'Cria uma sprint e escolhe as tarefas que cabem nela, respeitando prioridades, prazos e dependências.',
    arguments: [
      { name: 'projeto', description: 'Nome do projeto. Padrão: o da pasta atual.', required: false },
      { name: 'dias', description: 'Duração em dias (padrão 14).', required: false },
      { name: 'objetivo', description: 'Objetivo da sprint (opcional).', required: false },
    ],
    build({ projeto, dias, objetivo }) {
      const p = projectArg(projeto);
      if (!p) throw Object.assign(new Error('Informe o projeto (esta pasta não está no quadro)'), { code: -32602 });
      const n = Number(dias) || 14;
      const sprints = store.sprints(p.id);
      return `${scopeLine(p)}

Planeje uma sprint de ${n} dias, de ${today()} a ${addDays(today(), n - 1)}${objetivo ? `, com o objetivo: "${objetivo}"` : ''}.
1. Crie a sprint com manage_sprints (action create, com datas e objetivo).
2. Escolha as tarefas: urgentes e de alta prioridade primeiro, prazos dentro do período, e inclua os bloqueadores do que for escolhido. Use as estimativas para não passar de ~6h de trabalho por dia útil.
3. Mova as escolhidas com update_tasks (sprint = id da nova sprint).
4. Mostre o plano (tarefas, estimativa total, riscos) e pergunte se deve iniciar a sprint antes de usar action start.
${sprints.some((s) => s.status === 'active') ? '\nObs.: já existe uma sprint ativa; pergunte se ela deve ser concluída antes.' : ''}

Sprints existentes:
${sprints.map((s) => `- #${s.id} ${s.name} [${s.status}] ${s.done}/${s.total}`).join('\n') || '(nenhuma)'}

${projectBoard(p)}`;
    },
  },

  triagem: {
    title: 'Triagem do quadro',
    description: 'Revisa as tarefas abertas: ajusta prioridade, tipo e tags, aponta duplicatas, descrições vagas e dependências faltando.',
    arguments: [{ name: 'projeto', description: 'Nome do projeto. Padrão: o da pasta atual.', required: false }],
    build({ projeto }) {
      const p = projectArg(projeto);
      const tasks = store.listTasks({ project_id: p?.id, project_ids: p ? undefined : visible(), status: 'open', limit: 300 });
      return `${scopeLine(p)}

Faça a triagem das tarefas abertas abaixo:
- Corrija prioridade, tipo (task/bug/story/epic) e tags quando estiverem claramente erradas ou faltando (use update_tasks para mudanças em lote).
- Aponte duplicatas e proponha qual manter. Não exclua nada sem eu confirmar; prefira arquivar.
- Liste tarefas com título vago ou sem descrição e proponha uma reescrita.
- Identifique dependências óbvias e registre com add_blocked_by.
- No fim, mostre um resumo do que mudou e o que precisa da minha decisão.

${tasks.map((t) => `- ${formatTask(t, { withProject: !p })}${t.description ? '' : ' · (sem descrição)'}`).join('\n') || '(nenhuma tarefa aberta)'}`;
    },
  },

  relatorio: {
    title: 'Relatório de progresso',
    description: 'Relatório do período: concluídas, criadas, atrasadas, tempo gasto, riscos e próximos passos.',
    arguments: [
      { name: 'periodo', description: 'hoje, semana (padrão) ou mes', required: false },
      { name: 'projeto', description: 'Nome do projeto (padrão: todos).', required: false },
    ],
    build({ periodo = 'semana', projeto }) {
      const p = projeto ? projectArg(projeto) : null;
      const days = { hoje: 1, semana: 7, mes: 30 }[periodo] || 7;
      const from = addDays(today(), -(days - 1));
      const time = store.timeReport({ project_id: p?.id, from, group_by: 'project' });
      const activity = store.activity({ project_id: p?.id, limit: 400 }).filter((a) => a.created_at.slice(0, 10) >= from);
      const done = store.listTasks({ project_id: p?.id, project_ids: p ? undefined : visible(), status: 'done', done_since: new Date(`${from}T00:00:00`).toISOString(), limit: 300 })
        .filter((t) => t.completed_at?.slice(0, 10) >= from);
      return `Escreva um relatório em português do período ${from} a ${today()} (${p ? p.name : 'todos os projetos'}), com as seções: Resumo, Concluído, Em andamento, Atrasado/bloqueado, Tempo gasto, Riscos e Próximos passos. Seja objetivo e cite tarefas como #id.

## Concluídas no período (${done.length})
${done.map((t) => `- ${formatTask(t, { withProject: !p })}`).join('\n') || '(nenhuma)'}

## Tempo registrado: ${formatDuration(time.total)}
${time.groups.map((g) => `- ${g.label}: ${formatDuration(g.minutes)}`).join('\n') || '(nenhum)'}

## Atividade (${activity.length} eventos)
${activity.slice(0, 80).map((a) => `- ${a.created_at.slice(0, 10)} ${a.author === 'claude' ? 'Claude' : a.user_name || a.author}: ${a.kind === 'created' ? 'criou' : a.kind === 'note' ? 'comentou em' : a.body} #${a.task_id} ${a.title}`).join('\n')}

${overviewText(p)}`;
    },
  },

  revisar_prazos: {
    title: 'Revisar prazos',
    description: 'Olha o que está atrasado ou vencendo e propõe novas datas ou repriorização.',
    arguments: [{ name: 'projeto', description: 'Nome do projeto (padrão: todos).', required: false }],
    build({ projeto }) {
      const p = projeto ? projectArg(projeto) : null;
      const overdue = store.listTasks({ project_id: p?.id, project_ids: p ? undefined : visible(), due: 'overdue', limit: 200 });
      const week = store.listTasks({ project_id: p?.id, project_ids: p ? undefined : visible(), status: 'open', due: 'week', limit: 200 });
      return `Hoje é ${today()}. Revise os prazos abaixo (${p ? p.name : 'todos os projetos'}):
- Para cada atrasada, proponha: nova data realista, subir prioridade, quebrar em partes ou arquivar.
- Aponte conflitos (muitas tarefas no mesmo dia, dependências que terminam depois do prazo de quem depende delas).
- Mostre a proposta em tabela e só aplique (update_task/update_tasks) depois que eu confirmar.

## Atrasadas (${overdue.length})
${overdue.map((t) => `- ${formatTask(t, { withProject: !p })}`).join('\n') || '(nenhuma)'}

## Vencem nos próximos 7 dias (${week.length})
${week.map((t) => `- ${formatTask(t, { withProject: !p })}`).join('\n') || '(nenhuma)'}`;
    },
  },
};

export function getPrompt(name, args) {
  const prompt = PROMPTS[name];
  if (!prompt) throw Object.assign(new Error(`Prompt desconhecido: ${name}`), { code: -32602 });
  for (const a of prompt.arguments) {
    if (a.required && !String(args[a.name] ?? '').trim()) throw Object.assign(new Error(`Argumento obrigatório: ${a.name}`), { code: -32602 });
  }
  return {
    description: prompt.description,
    messages: [{ role: 'user', content: { type: 'text', text: prompt.build(args) } }],
  };
}

// Autocompletar argumentos de prompts e de templates de resource.
export function complete({ ref, argument }) {
  const value = String(argument?.value || '').toLowerCase();
  let values = [];
  const projects = () => store.listProjects({ include_archived: false, project_ids: visible() });
  const openTasks = () => store.listTasks({ status: 'open', project_ids: visible(), limit: 1000 })
    .filter((t) => !value || String(t.id).startsWith(value.replace('#', '')) || t.title.toLowerCase().includes(value));

  if (ref?.type === 'ref/prompt') {
    if (argument.name === 'projeto') values = projects().map((p) => p.name).filter((n) => n.toLowerCase().includes(value));
    if (argument.name === 'tarefa') values = openTasks().map((t) => `${t.id} ${t.title}`.slice(0, 80));
    if (argument.name === 'periodo') values = ['hoje', 'semana', 'mes'].filter((v) => v.startsWith(value));
    if (argument.name === 'dias') values = ['7', '10', '14', '21', '30'].filter((v) => v.startsWith(value));
  }
  if (ref?.type === 'ref/resource' && argument.name === 'id') {
    if (ref.uri?.startsWith('tarefas://tasks/')) values = openTasks().map((t) => String(t.id));
    if (ref.uri?.startsWith('tarefas://projects/')) values = projects().filter((p) => !value || String(p.id).startsWith(value) || p.name.toLowerCase().includes(value)).map((p) => String(p.id));
  }
  return { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 };
}
