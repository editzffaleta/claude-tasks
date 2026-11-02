// Documento OpenAPI 3.1 da API REST, servido em /api/openapi.json e exibido em /docs/api.
// Toda rota de src/routes.js precisa de uma operação aqui: ao criar ou mudar rota, atualize este arquivo.
import {
  ACTIONS, DEPENDENCY_TYPES, FIELD_TYPES, FREQS, PRIORITIES, PROJECT_STATUSES, ROLES, SPRINT_STATUSES, STATUSES, TRIGGERS,
  TYPES, USER_ROLES, VISIBILITIES,
} from './util.js';
import { DEFAULT_SETTINGS, SECRET_SETTINGS } from './store/insights.js';
import { NOTIFY_TYPES } from './store/team.js';

// ---------- atalhos de schema ----------

const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const str = { type: 'string' };
const int = { type: 'integer' };
const num = { type: 'number' };
const bool = { type: 'boolean' };
const date = { type: 'string', format: 'date' };
const time = { type: 'string', format: 'date-time' };
const ID = { type: 'integer', minimum: 1 };
const binary = { type: 'string', format: 'binary' };
const d = (schema, description) => ({ ...schema, description });
const arr = (items, description) => ({ type: 'array', items, ...(description ? { description } : {}) });
const enm = (values, description) => ({ type: 'string', enum: values, ...(description ? { description } : {}) });
const obj = (properties, required = [], description) => ({
  type: 'object',
  ...(description ? { description } : {}),
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: true,
});
// Aceita null além do tipo.
const nul = (s) => {
  if (s.$ref || s.oneOf || s.allOf) return { oneOf: [s, { type: 'null' }] };
  return { ...s, type: [].concat(s.type, 'null'), ...(s.enum ? { enum: [...s.enum, null] } : {}) };
};
const userRef = (description) => d({ type: ['integer', 'string'] }, description || 'Pessoa por id, e-mail ou nome');
const listed = (labels) => Object.entries(labels).map(([k, v]) => `\`${k}\` (${v})`).join(', ');

// ---------- schemas ----------

const RECURRENCE = obj({
  freq: enm(FREQS),
  interval: { type: 'integer', minimum: 1, maximum: 365, default: 1, description: 'A cada quantas unidades' },
  weekdays: arr({ type: 'integer', minimum: 0, maximum: 6 }, 'Só semanal: 0 = domingo … 6 = sábado'),
  monthday: d({ oneOf: [{ type: 'integer', minimum: 1, maximum: 31 }, { const: 'last' }] }, 'Só mensal/trimestral: dia do mês ou "last"'),
  until: d(date, 'Não cria ocorrências depois desta data'),
  count: { type: 'integer', minimum: 1, maximum: 1000, description: 'Total de ocorrências' },
  n: { type: 'integer', minimum: 1, description: 'Ocorrência atual (com count)' },
}, ['freq'], 'Regra de recorrência: ao concluir a tarefa, a próxima ocorrência é criada');

const TASK = obj({
  id: ID,
  project_id: ID,
  number: d(nul(int), 'Número sequencial dentro do projeto'),
  ref: d(nul(str), 'Código PREFIXO-número (ex.: WEB-12); null se o projeto não tem prefixo'),
  title: str,
  description: d(str, 'Markdown'),
  status: enm(STATUSES),
  priority: enm(PRIORITIES),
  type: enm(TYPES),
  tags: arr(str),
  source: d(str, 'Quem criou: claude, user, você, automação, e-mail, ia…'),
  parent_id: d(nul(int), 'Tarefa-mãe (subtarefa)'),
  sprint_id: nul(int),
  column_id: d(nul(int), 'Coluna personalizada; null = primeira coluna da categoria do status'),
  reporter_id: d(nul(int), 'Relator'),
  start_date: nul(date),
  due_date: d(nul(date), 'Prazo'),
  estimate_minutes: d(nul(int), 'Estimativa original, em minutos'),
  remaining_minutes: d(nul(int), 'Estimativa restante, em minutos'),
  story_points: nul(num),
  rank: d(nul(num), 'Ordem manual'),
  recurrence: nul(ref('Recurrence')),
  recurrence_next_id: d(nul(int), 'Próxima ocorrência, já criada'),
  external_source: d(nul(str), 'Origem da importação: jira, trello, csv, email'),
  external_id: nul(str),
  archived_at: nul(time),
  created_by: nul(int),
  created_at: time,
  updated_at: time,
  completed_at: nul(time),
  project_name: str,
  project_path: nul(str),
  project_color: nul(str),
  project_key: nul(str),
  workspace_id: nul(int),
  sprint_name: nul(str),
  sprint_status: nul(enm(SPRINT_STATUSES)),
  column_name: nul(str),
  parent_title: nul(str),
  sort_rank: num,
  note_count: d(int, 'Comentários (sem eventos)'),
  subtask_count: int,
  subtask_done: int,
  open_blockers: d(int, 'Bloqueadores que ainda impedem começar'),
  spent_minutes: d(int, 'Tempo registrado (inclui timers em andamento)'),
  timers_running: int,
  attachment_count: int,
  assignee_ids: arr(int, 'Responsáveis'),
  watcher_ids: arr(int, 'Observadores'),
  field_values: d({ type: 'object', additionalProperties: true }, 'Campos personalizados: { id_do_campo: valor }'),
  overdue: d(bool, 'Prazo vencido e não concluída'),
  timer_running: bool,
});

// Campos aceitos ao criar e ao atualizar tarefas (db.js addTask/updateTask).
const TASK_WRITE = {
  title: { type: 'string', maxLength: 300 },
  description: d(str, 'Markdown'),
  status: enm(STATUSES),
  column: d({ type: ['integer', 'string'] }, 'Coluna por id, nome ou categoria (todo, doing, blocked, done); define também o status'),
  priority: enm(PRIORITIES),
  type: enm(TYPES),
  tags: d({ type: ['array', 'string'], items: str }, 'Lista ou texto separado por vírgulas (até 12)'),
  parent_id: d({ type: ['integer', 'string', 'null'] }, 'Tarefa-mãe por id, "#12" ou código "WEB-12"'),
  sprint: d({ type: ['integer', 'string', 'null'] }, 'Sprint por id ou nome, "active" ou "next"; null ou "backlog" tira da sprint'),
  sprint_id: d({ type: ['integer', 'string', 'null'] }, 'Mesmo que sprint'),
  reporter: d({ type: ['integer', 'string', 'null'] }, 'Relator por id, e-mail ou nome'),
  reporter_id: d({ type: ['integer', 'string', 'null'] }, 'Mesmo que reporter'),
  assignees: arr({ type: ['integer', 'string'] }, 'Responsáveis (substitui a lista): ids, e-mails ou nomes'),
  assignee_ids: arr({ type: ['integer', 'string'] }, 'Mesmo que assignees'),
  watchers: arr({ type: ['integer', 'string'] }, 'Observadores (substitui a lista)'),
  start_date: nul(date),
  due_date: d(nul(date), 'Prazo'),
  estimate: d({ type: ['integer', 'string', 'null'] }, 'Minutos ou duração: "90m", "2h", "1h30m", "1d" (= 8h)'),
  estimate_minutes: d({ type: ['integer', 'string', 'null'] }, 'Mesmo que estimate'),
  remaining: d({ type: ['integer', 'string', 'null'] }, 'Estimativa restante, no mesmo formato'),
  remaining_minutes: d({ type: ['integer', 'string', 'null'] }, 'Mesmo que remaining'),
  story_points: { type: ['number', 'null'], minimum: 0, maximum: 1000 },
  recurrence: d({ oneOf: [ref('Recurrence'), enm(FREQS), { type: 'null' }] }, 'Regra completa ou só a frequência; null remove'),
  blocked_by: arr({ oneOf: [{ type: ['integer', 'string'] }, obj({ id: { type: ['integer', 'string'] }, type: enm(DEPENDENCY_TYPES) }, ['id'])] },
    'Bloqueadores (substitui a lista): ids, códigos ou { id, type }'),
  fields: d({ type: 'object', additionalProperties: true }, 'Campos personalizados: { id_ou_nome: valor }; valor vazio apaga'),
};

const DEPENDENCY = obj({
  id: ID, title: str, status: enm(STATUSES), priority: enm(PRIORITIES), due_date: nul(date), start_date: nul(date),
  project_id: ID, project_name: str, type: enm(DEPENDENCY_TYPES),
});

const NOTE = obj({
  id: ID,
  task_id: ID,
  kind: enm(['note', 'event'], 'note = comentário; event = registro automático (mudança de status, prazo…)'),
  author: d(str, 'claude, user, você, automação, e-mail…'),
  user_id: nul(int),
  body: d(str, 'Markdown'),
  parent_id: d(nul(int), 'Comentário respondido'),
  edited_at: nul(time),
  created_at: time,
  user_name: d(nul(str), 'Só nos detalhes da tarefa'),
  user_color: nul(str),
  user_avatar: nul(str),
});

const TIME_ENTRY = obj({
  id: ID, task_id: ID, user_id: nul(int), author: str, started_at: time, ended_at: d(nul(time), 'null = timer em andamento'),
  minutes: nul(int), note: str, created_at: time, user_name: nul(str), user_color: nul(str),
  duration: d(int, 'Minutos (calculado também para o timer em andamento)'),
});

const RUNNING_TIMER = obj({
  id: ID, task_id: ID, user_id: nul(int), author: str, started_at: time, ended_at: { type: 'null' }, minutes: { type: 'null' },
  note: str, created_at: time, task_title: str, project_id: ID,
});

const ATTACHMENT = obj({
  id: ID, task_id: ID, name: str, mime: str, size: d(int, 'Bytes'), author: str, user_id: nul(int), created_at: time,
  user_name: d(nul(str), 'Só na lista da tarefa'),
  stored: d(str, 'Nome do arquivo no disco (só na resposta do upload)'),
});

const SHARE = obj({
  token: d(str, 'Abra em /s/{token}'),
  kind: enm(['task', 'project']),
  target_id: d(ID, 'Id da tarefa ou do projeto'),
  created_by: nul(int),
  created_at: time,
  expires_at: d(nul(time), 'null = sem validade'),
  revoked_at: nul(time),
  created_by_name: d(nul(str), 'Só nas listas'),
});

const PUBLIC_TASK = obj({
  id: ID, ref: nul(str), title: str, description: str, status: enm(STATUSES), column: nul(str), priority: enm(PRIORITIES),
  type: enm(TYPES), tags: arr(str), due_date: nul(date), start_date: nul(date), story_points: nul(num),
  assignees: arr(str, 'Nomes dos responsáveis'), subtask_done: int, subtask_count: int, updated_at: time,
});

const PROJECT_FIELDS = {
  id: ID,
  name: str,
  path: d(nul(str), 'Pasta do repositório (projetos criados pelo Claude)'),
  key: d(nul(str), 'Prefixo dos códigos das tarefas (ex.: WEB)'),
  description: str,
  color: nul(str),
  status: enm(PROJECT_STATUSES),
  priority: enm(PRIORITIES),
  visibility: enm(VISIBILITIES, 'private = só membros; internal = todos da conta; public = permite link público'),
  start_date: nul(date),
  end_date: nul(date),
  workspace_id: nul(int),
  avatar: d(nul(str), 'Arquivo em /api/avatars/{file}'),
  archived_at: nul(time),
  next_number: d(int, 'Próximo número de tarefa'),
  created_at: time,
};

const PROJECT_WRITE = {
  name: { type: 'string', maxLength: 120 },
  description: str,
  color: d(nul(str), 'Cor #rrggbb'),
  key: d(nul(str), 'Prefixo de 2 a 10 letras ou números, começando por letra (ex.: WEB)'),
  status: enm(PROJECT_STATUSES),
  priority: enm(PRIORITIES),
  visibility: enm(VISIBILITIES),
  start_date: nul(date),
  end_date: nul(date),
  workspace_id: nul(int),
};

const COLUMN = obj({
  id: d(nul(int), 'null = coluna padrão (o projeto ainda não personalizou as colunas)'),
  project_id: ID,
  name: str,
  status: enm(STATUSES, 'Categoria de status da coluna'),
  color: nul(str),
  position: num,
});

const SPRINT = obj({
  id: ID, project_id: ID, name: str, goal: str, status: enm(SPRINT_STATUSES), start_date: nul(date), end_date: nul(date),
  created_at: time, completed_at: nul(time),
  total: d(int, 'Só nas listas: tarefas na sprint'), done: d(int, 'Só nas listas: concluídas'),
  points_total: d(num, 'Só nas listas'), points_done: d(num, 'Só nas listas'),
});

const USER = obj({
  id: ID, name: str, email: str, role: enm(USER_ROLES, 'Papel na conta'), color: nul(str), avatar: nul(str),
  disabled: bool, created_at: time, last_seen_at: nul(time),
});

const MEMBER = obj({
  id: ID, name: str, email: str, color: nul(str), avatar: nul(str), account_role: enm(USER_ROLES), role: enm(ROLES, 'Papel neste escopo'),
  created_at: time,
});

const LABEL = obj({
  id: ID, project_id: d(nul(int), 'null = vale para todos os projetos'), name: str, color: str, description: str, created_at: time,
  usage: d(int, 'Só nas listas: tarefas com essa tag'),
});

const CUSTOM_FIELD = obj({
  id: ID, project_id: d(nul(int), 'null = vale para todos os projetos'), name: str, type: enm(FIELD_TYPES),
  options: arr(str, 'Opções de select/multi_select'), required: bool, position: num, created_at: time,
});

const AUTOMATION_CONDITIONS = obj({
  to_status: enm(STATUSES, 'Status da tarefa (ou para onde ela foi)'),
  from_status: enm(STATUSES, 'Status de onde a tarefa saiu'),
  priority: arr(enm(PRIORITIES)),
  type: arr(enm(TYPES)),
  tag: str,
  by_claude: d(bool, 'Só tarefas criadas pelo Claude'),
  field: d(str, 'Só quando esse campo mudou (task_updated)'),
  days: d(int, 'due_soon: dias de antecedência (padrão 1)'),
}, [], 'Todas as condições informadas precisam valer');

const AUTOMATION_ACTION = obj({
  type: enm(Object.keys(ACTIONS), listed(ACTIONS)),
  value: d({ type: ['string', 'number'] }, 'Valor da ação: status, coluna, prioridade, tag, texto do comentário ou aviso, dias, sprint, pessoa'),
  to: d(str, 'send_email: followers (padrão), assignees ou e-mails separados por vírgula'),
  subject: d(str, 'send_email: assunto'),
}, ['type']);

const AUTOMATION_WRITE = {
  project_id: d(nul(int), 'null = automação global (exige administrador)'),
  name: { type: 'string', maxLength: 120 },
  trigger: enm(Object.keys(TRIGGERS), listed(TRIGGERS)),
  conditions: ref('AutomationConditions'),
  action: ref('AutomationAction'),
  enabled: { type: 'boolean', default: true },
};

const NOTIFY_CHANNELS = obj({ app: bool, email: bool, os: d(bool, 'Notificação do macOS') });

const USER_SETTINGS = obj({
  language: nul(enm(['pt', 'en', 'es', 'fr', 'de'], 'null = idioma padrão da conta')),
  theme: enm(['system', 'light', 'dark']),
  default_view: enm(['board', 'list', 'calendar', 'gantt', 'dashboard']),
  single_keys: d(bool, 'Atalhos de uma tecla no painel (N, C, K, / e 1 a 5)'),
  notify: d({ type: 'object', additionalProperties: ref('NotifyChannels') }, `Canais por tipo: ${NOTIFY_TYPES.join(', ')}`),
});

const SETTING_NOTES = {
  notify_macos: 'Notificações do macOS',
  due_soon_days: 'Dias de antecedência do aviso de prazo',
  chat_model: 'Modelo da CLI do Claude no chat (ex.: sonnet)',
  base_url: 'Endereço público do painel, usado nos links dos e-mails',
  default_language: 'Idioma padrão',
  smtp_pass: 'Volta mascarada',
  smtp_allow_insecure: 'Aceita SMTP sem TLS',
  ai_provider: 'Provedor do chat: claude-cli (assinatura, sem chave), anthropic ou openai (compatível)',
  ai_api_key: 'Volta mascarada',
};
const SETTINGS_PROPS = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).map(([k, v]) => [k, {
  type: typeof v === 'number' ? 'integer' : typeof v,
  default: v,
  ...(SETTING_NOTES[k] ? { description: SETTING_NOTES[k] } : {}),
}]));
SETTINGS_PROPS.ai_provider.enum = ['claude-cli', 'anthropic', 'openai'];
SETTINGS_PROPS.default_language.enum = ['pt', 'en', 'es', 'fr', 'de'];

const INBOX_WRITE = {
  enabled: bool,
  address: d(nul(str), 'Endereço exibido'),
  imap_host: nul(str),
  imap_port: { type: 'integer', default: 993 },
  imap_secure: d({ type: 'boolean', default: true }, 'TLS'),
  imap_user: nul(str),
  imap_pass: d(nul(str), 'Senha (guardada cifrada); "••••••••" ou ausente mantém a atual'),
  mailbox: { type: 'string', default: 'INBOX' },
  default_type: enm(TYPES),
  default_priority: enm(PRIORITIES),
  default_column_id: nul(int),
  default_assignee_id: nul(int),
  auto_reply: bool,
  auto_reply_template: d(str, 'Aceita {id}, {titulo} e {link}'),
  signature: str,
  sync_minutes: { type: 'integer', minimum: 1, maximum: 1440, default: 5 },
};

const INBOX_RULE_WRITE = {
  name: { type: 'string', maxLength: 120 },
  position: num,
  enabled: { type: 'boolean', default: true },
  conditions: obj({ from_contains: str, subject_contains: str, body_contains: str }, [], 'Todas as informadas precisam bater'),
  actions: obj({
    ignore: d(bool, 'Ignora o e-mail'),
    priority: enm(PRIORITIES),
    type: enm(TYPES),
    tags: arr(str),
    assignee: userRef('Responsável por id, e-mail ou nome'),
    column: d({ type: ['integer', 'string'] }, 'Coluna por id, nome ou categoria'),
  }),
  stop: d(bool, 'Não avalia as regras seguintes'),
};

const WORKFLOW_COLUMN = obj({ name: str, status: enm(STATUSES), color: nul(str) }, ['name', 'status']);
const WORKFLOW_WRITE = {
  name: { type: 'string', maxLength: 80 },
  description: str,
  columns: arr(WORKFLOW_COLUMN, 'Precisa de ao menos uma coluna de cada categoria'),
  transitions: arr(arr(int), 'Pares [de, para] com os índices das colunas; vazio = qualquer movimento'),
  is_default: d(bool, 'Aplicado a projetos novos'),
};

const IMPORT_RESULT = obj({ created: int, updated: int, skipped: int, errors: arr(str) });

const schemas = {
  Error: obj({ error: d(str, 'Mensagem em português') }, ['error']),
  Ok: obj({ ok: { const: true } }, ['ok']),

  // ----- tarefas -----
  Recurrence: RECURRENCE,
  Task: TASK,
  TaskDetail: {
    description: 'Tarefa com comentários, subtarefas, dependências, tempos, anexos e contexto do projeto',
    allOf: [ref('Task'), obj({
      notes: arr(ref('Note'), 'Comentários e eventos, do mais antigo ao mais novo'),
      subtasks: arr(ref('Task')),
      blockers: arr(ref('Dependency'), 'Tarefas que bloqueiam esta'),
      blocking: arr(ref('Dependency'), 'Tarefas que esta bloqueia'),
      time_entries: arr(ref('TimeEntry')),
      attachments: arr(ref('Attachment')),
      columns: arr(ref('Column'), 'Colunas do projeto'),
      allowed_columns: d({ type: ['array', 'null'], items: { type: ['integer', 'null'] } }, 'Colunas para onde pode ir; null = qualquer uma'),
      fields: arr(ref('CustomFieldValue'), 'Campos do projeto com o valor desta tarefa'),
      watchers: arr(ref('UserRef')),
      reporter: nul(ref('User')),
      labels: arr(ref('Label'), 'Labels disponíveis no projeto'),
      assignees: arr(ref('User')),
      sprints: arr(ref('Sprint'), 'Sprints do projeto'),
      my_role: nul(enm(ROLES)),
      shares: arr(ref('Share'), 'Links públicos ativos da tarefa'),
    })],
  },
  TaskWrite: obj(TASK_WRITE, [], 'Campos aceitos ao criar e ao atualizar; só os enviados contam'),
  TaskCreate: {
    allOf: [ref('TaskWrite'), obj({
      project_id: ID,
      project_name: d(str, 'Sem project_id: nome, prefixo ou id do projeto (cria se não existir)'),
    }, ['title'])],
  },
  TaskPatch: {
    allOf: [ref('TaskWrite'), obj({
      project_id: d(ID, 'Move para outro projeto (zera coluna, sprint e número; subtarefas vão junto)'),
      rank: d(num, 'Ordem manual'),
      archived: bool,
    })],
  },
  BulkInput: obj({
    ids: arr({ type: ['integer', 'string'] }, 'Ids das tarefas'),
    patch: ref('TaskPatch'),
    delete: d(bool, 'Exclui em vez de alterar'),
  }, ['ids']),
  Dependency: DEPENDENCY,
  DependencyPair: obj({ task_id: ID, blocked_by: ID, type: enm(DEPENDENCY_TYPES) }),
  BlockerInput: obj({
    blocked_by: d({ type: ['integer', 'string'] }, 'Tarefa bloqueadora por id, "#12" ou código "WEB-12"'),
    type: { ...enm(DEPENDENCY_TYPES), default: 'finish_start' },
  }, ['blocked_by']),
  BoardState: obj({
    version: d(str, 'Muda a cada gravação no banco'),
    today: date,
    projects: arr(ref('ProjectSummary')),
    tasks: arr(ref('Task')),
    dependencies: arr(ref('DependencyPair')),
    users: arr(ref('User')),
    organizations: arr(ref('Organization')),
    workspaces: arr(ref('Workspace')),
    labels: arr(ref('Label')),
    fields: arr(ref('CustomField')),
    columns: d(nul(arr(ref('Column'))), 'Só com project'),
    transitions: arr(ref('Transition')),
    sprints: arr(ref('Sprint')),
    timers: arr(ref('RunningTimer'), 'Seus timers em andamento'),
    unread: int,
    my_role: d(nul(enm(ROLES)), 'Seu papel no projeto (com project)'),
  }),
  SearchResult: obj({
    tasks: arr(ref('Task')),
    comments: arr(obj({ id: ID, task_id: ID, body: str, created_at: time, title: str, project_name: str })),
    projects: arr(obj({ id: ID, name: str, key: nul(str), path: nul(str), color: nul(str), archived_at: nul(time) })),
    sprints: arr(obj({ id: ID, name: str, status: enm(SPRINT_STATUSES), project_id: ID, project_name: str })),
    labels: arr(obj({ id: ID, name: str, color: str, project_id: nul(int) })),
    people: arr(obj({ id: ID, name: str, email: str, color: nul(str), avatar: nul(str) })),
    workspaces: arr(obj({ id: ID, name: str, organization_id: ID })),
  }),

  // ----- comentários, tempo, anexos, links -----
  Note: NOTE,
  NoteInput: obj({
    body: d(str, 'Markdown; @Nome menciona alguém'),
    parent_id: d(ID, 'Responde a outro comentário (as respostas ficam num nível só)'),
  }, ['body']),
  TimeEntry: TIME_ENTRY,
  RunningTimer: RUNNING_TIMER,
  TimerInput: obj({ action: d(enm(['start', 'stop']), 'stop para o seu timer nesta tarefa; qualquer outro valor inicia') }),
  TimeLogInput: obj({
    minutes: d({ type: ['integer', 'string'] }, 'Minutos ou duração ("45m", "1h30m", "1d")'),
    duration: d({ type: ['integer', 'string'] }, 'Mesmo que minutes'),
    date: d(date, 'Dia do trabalho (padrão: hoje)'),
    note: { type: 'string', maxLength: 500 },
  }),
  TimeReport: obj({
    from: date,
    to: date,
    total: d(int, 'Minutos'),
    groups: arr(obj({ key: str, label: str, minutes: int, entries: int })),
    entries: arr(obj({
      id: ID, task_id: ID, author: str, note: str, started_at: time, ended_at: nul(time), title: str, project_id: ID,
      project_name: str, user_name: nul(str), day: date, minutes: int,
    })),
  }),
  Attachment: ATTACHMENT,
  Share: SHARE,
  ShareInput: obj({ days: d({ type: ['integer', 'null'], minimum: 1, maximum: 3650 }, 'Validade em dias; vazio = sem validade') }),
  PublicShare: {
    description: 'Conteúdo somente leitura de um link público',
    oneOf: [
      { title: 'Link de tarefa', ...obj({
        kind: { const: 'task' },
        project: obj({ name: str, color: nul(str) }),
        task: { allOf: [ref('PublicTask'), obj({
          subtasks: arr(obj({ id: ID, title: str, status: enm(STATUSES) })),
          attachments: arr(obj({ id: ID, name: str, mime: str, size: int }), 'Baixe em /api/public/{token}/attachments/{id}'),
          comments: arr(obj({ id: ID, parent_id: nul(int), body: str, created_at: time, author: d(str, 'Nome de quem comentou') })),
        })] },
      }, ['kind', 'project', 'task']) },
      { title: 'Link de projeto', ...obj({
        kind: { const: 'project' },
        project: obj({ name: str, color: nul(str), description: str, status: enm(PROJECT_STATUSES), start_date: nul(date), end_date: nul(date) }),
        columns: arr(obj({ id: nul(int), name: str, status: enm(STATUSES) })),
        tasks: arr({ allOf: [ref('PublicTask'), obj({ column_id: nul(int) })] }, 'Primeiro nível, abertas ou concluídas nos últimos 30 dias'),
      }, ['kind', 'project', 'columns', 'tasks']) },
    ],
  },
  PublicTask: PUBLIC_TASK,

  // ----- projetos, colunas, sprints -----
  Project: obj(PROJECT_FIELDS),
  ProjectSummary: {
    description: 'Projeto com contadores (lista do /api/state)',
    allOf: [ref('Project'), obj({
      workspace_name: nul(str), organization_id: nul(int), todo: int, doing: int, blocked: int, done: int, open: int, overdue: int,
      points_done: num, points_total: num, last_activity: nul(time), my_role: nul(enm(ROLES)),
    })],
  },
  ProjectCreate: obj(PROJECT_WRITE, ['name']),
  ProjectPatch: obj({ ...PROJECT_WRITE, archived: d(bool, 'Exige papel de dono (como visibility)') }),
  Member: MEMBER,
  MemberInput: obj({
    user: userRef(),
    role: d(nul(enm(ROLES)), 'null remove a pessoa deste escopo'),
  }, ['user']),
  AvatarResult: obj({ avatar: d(nul(str), 'Arquivo em /api/avatars/{file}; null = removido') }, ['avatar']),
  Column: COLUMN,
  ColumnInput: obj({
    name: { type: 'string', maxLength: 60 },
    status: { ...enm(STATUSES), default: 'doing' },
    color: d(nul(str), 'Cor #rrggbb'),
  }, ['name']),
  ColumnPatch: obj({
    name: { type: 'string', maxLength: 60 },
    status: d(enm(STATUSES), 'Muda a categoria e o status das tarefas da coluna'),
    color: nul(str),
    move: d(enm(['left', 'right']), 'Troca de lugar com a coluna vizinha'),
  }),
  Transition: obj({ from_column_id: ID, to_column_id: ID }),
  TransitionsInput: obj({
    transitions: arr({ oneOf: [
      arr({ type: ['integer', 'string'] }, '[de, para]'),
      obj({ from: { type: ['integer', 'string'] }, to: { type: ['integer', 'string'] } }, ['from', 'to']),
    ] }, 'Colunas por id, nome ou categoria; lista vazia libera qualquer movimento'),
  }, ['transitions']),
  Sprint: SPRINT,
  SprintInput: obj({ name: { type: 'string', maxLength: 80 }, goal: str, start_date: nul(date), end_date: nul(date) }),
  SprintCloseInput: obj({ move_to: d(nul(int), 'Sprint que recebe as tarefas não concluídas; vazio = backlog') }),
  SprintCloseResult: obj({ sprint: ref('Sprint'), moved: d(int, 'Tarefas movidas'), moved_to: nul(ref('Sprint')) }),

  // ----- labels, campos, workflows -----
  Label: LABEL,
  LabelInput: obj({
    project_id: d(nul(int), 'Sem projeto = label global (exige administrador)'),
    name: { type: 'string', maxLength: 40 },
    color: d(str, 'Cor #rrggbb (padrão: uma da paleta)'),
    description: { type: 'string', maxLength: 300 },
  }, ['name']),
  LabelPatch: obj({ name: { type: 'string', maxLength: 40 }, color: str, description: { type: 'string', maxLength: 300 } }),
  CustomField: CUSTOM_FIELD,
  CustomFieldValue: { allOf: [ref('CustomField'), obj({ value: d({}, 'Valor nesta tarefa (null se vazio)') })] },
  CustomFieldInput: obj({
    project_id: d(nul(int), 'Sem projeto = campo global (exige administrador)'),
    name: { type: 'string', maxLength: 60 },
    type: enm(FIELD_TYPES),
    options: d({ type: ['array', 'string'], items: str }, 'Obrigatório em select/multi_select: lista ou texto separado por vírgulas'),
    required: bool,
  }, ['name', 'type']),
  CustomFieldPatch: obj({
    name: { type: 'string', maxLength: 60 },
    options: { type: ['array', 'string'], items: str },
    required: bool,
    position: num,
  }, [], 'O tipo não muda depois de criado'),
  Workflow: obj({
    id: ID, name: str, description: str, columns: arr(WORKFLOW_COLUMN), transitions: arr(arr(int), 'Pares [de, para] de índices em columns'),
    is_default: bool, created_at: time,
  }),
  WorkflowInput: obj(WORKFLOW_WRITE, ['name', 'columns']),
  WorkflowPatch: obj(WORKFLOW_WRITE),
  WorkflowFromProjectInput: obj({
    name: d(str, 'Padrão: "Workflow de <projeto>"'),
    description: str,
    is_default: d(bool, 'Exige administrador'),
  }),

  // ----- importação e caixa de entrada -----
  ImportResult: IMPORT_RESULT,
  JiraImportInput: obj({
    site: d(str, 'https://empresa.atlassian.net (outros hosts: CLAUDE_TASKS_JIRA_HOSTS)'),
    email: str,
    token: d(str, 'Token de API do Jira'),
    jql: d(str, 'Padrão: ORDER BY created DESC'),
    save: d(bool, 'Guarda a configuração (token cifrado) para sincronizar de novo'),
  }, ['site', 'email', 'token'], 'kind = jira'),
  TrelloImportInput: obj({
    board: d(str, 'Link ou id do quadro'),
    key: d(str, 'Chave de API do Trello'),
    token: str,
    save: d(bool, 'Guarda a configuração (token cifrado) para sincronizar de novo'),
  }, ['board', 'key', 'token'], 'kind = trello'),
  ExternalSync: obj({
    id: ID, kind: enm(['jira', 'trello']), config: d({ type: 'object', additionalProperties: true }, 'site/email/jql ou board/key; token mascarado'),
    last_sync_at: nul(time), last_result: nul(ref('ImportResult')), created_at: time,
  }),
  Inbox: obj({
    id: ID, project_id: ID, ...INBOX_WRITE, imap_pass: d(str, 'Mascarada ("••••••••") ou vazia'),
    last_sync_at: nul(time), last_error: nul(str), created_at: time,
  }),
  InboxInput: obj({
    ...INBOX_WRITE,
    default_column: d({ type: ['integer', 'string', 'null'] }, 'Coluna das novas tarefas por id, nome ou categoria'),
    default_assignee: d({ type: ['integer', 'string', 'null'] }, 'Responsável das novas tarefas por id, e-mail ou nome'),
  }),
  InboxRule: obj({ id: ID, inbox_id: ID, ...INBOX_RULE_WRITE, created_at: time }),
  InboxRuleInput: obj(INBOX_RULE_WRITE, ['name']),
  InboxMessage: obj({
    id: ID, inbox_id: ID, uid: nul(int), message_id: nul(str), from_address: nul(str), from_name: nul(str), subject: nul(str),
    received_at: nul(str), status: enm(['task', 'comment', 'ignored', 'error']), task_id: nul(int), error: nul(str), created_at: time,
  }),
  InboxState: obj({
    inbox: nul(ref('Inbox')),
    rules: arr(ref('InboxRule')),
    messages: arr(ref('InboxMessage'), 'Últimas 50'),
    mail_enabled: d(bool, 'SMTP configurado (respostas automáticas)'),
  }),
  InboxSyncResult: obj({ tasks: int, comments: int, ignored: int, errors: int }),

  // ----- organizações -----
  Organization: obj({
    id: ID, name: str, description: str, website: nul(str), color: nul(str), avatar: nul(str), archived_at: nul(time), created_at: time,
    workspace_count: d(int, 'Só na lista'), project_count: d(int, 'Só na lista'),
  }),
  OrganizationInput: obj({ name: { type: 'string', maxLength: 120 }, description: str, website: nul(str), color: nul(str) }, ['name']),
  OrganizationPatch: obj({ name: { type: 'string', maxLength: 120 }, description: str, website: nul(str), color: nul(str), archived: bool }),
  Workspace: obj({
    id: ID, organization_id: ID, parent_id: d(nul(int), 'Workspace-pai (aninhados)'), name: str, description: str, color: nul(str),
    position: num, archived_at: nul(time), created_at: time, project_count: d(int, 'Só na lista'),
  }),
  WorkspaceInput: obj({
    organization_id: { ...ID, default: 1 },
    parent_id: nul(int),
    name: { type: 'string', maxLength: 120 },
    description: str,
    color: nul(str),
  }, ['name']),
  WorkspacePatch: obj({
    name: { type: 'string', maxLength: 120 }, description: str, color: nul(str), position: num,
    parent_id: d(nul(int), 'Da mesma organização; null = raiz'), archived: bool,
  }),

  // ----- dashboard -----
  Stats: obj({
    totals: obj({
      open: int, doing: int, blocked: int, overdue: int, due_week: int, done_7d: int, created_7d: int, claude_7d: int, open_bugs: int,
      open_points: num, total: int, minutes_7d: int,
    }),
    weeks: arr(obj({ week: d(date, 'Segunda-feira'), created: int, done: int, bugs_created: int, bugs_done: int }), 'Últimas 8 semanas'),
    byPriority: d({ type: 'object', additionalProperties: int }, 'Abertas por prioridade'),
    byType: d({ type: 'object', additionalProperties: int }, 'Abertas por tipo'),
    byProject: arr(obj({ id: ID, name: str, color: nul(str), todo: int, doing: int, blocked: int, open: int, overdue: int })),
    portfolio: arr(obj({
      id: ID, name: str, color: nul(str), status: enm(PROJECT_STATUSES), priority: enm(PRIORITIES), end_date: nul(date),
      progress: d(num, '0 a 1'), open: int, done: int, overdue: int,
    })),
    workload: arr(obj({ id: ID, name: str, color: nul(str), todo: int, doing: int, blocked: int, overdue: int, points: num })),
    utilization: arr(obj({ name: str, minutes: int }), 'Tempo por pessoa em 30 dias'),
    allocation: arr(obj({ person: str, project: str, project_id: ID, n: int })),
    timeByProject: arr(obj({ id: ID, name: str, color: nul(str), minutes: int }), 'Últimos 7 dias'),
    upcoming: arr(ref('Task'), 'Próximos prazos'),
    sprint: d(nul({ allOf: [ref('Sprint'), obj({ burndown: obj({ unit: enm(['pontos', 'tarefas']), total: num, days: arr(obj({ day: date, ideal: num, remaining: nul(num) })) }) })] }),
      'Sprint ativa (só com project)'),
    velocity: arr(obj({ id: ID, name: str, points: num, tasks: int, planned_points: num, planned: int }), 'Últimas sprints concluídas (só com project)'),
    activity: arr(ref('ActivityItem')),
  }),
  ActivityItem: obj({
    kind: enm(['created', 'note', 'event'], 'created = tarefa criada; note = comentário; event = mudança registrada'),
    task_id: ID, title: str, project_id: ID, project_name: str, author: str, user_id: nul(int), user_name: nul(str), body: nul(str),
    created_at: time,
  }),

  // ----- automações -----
  Automation: obj({
    id: ID, project_id: nul(int), project_name: d(nul(str), 'Só na lista'), name: str, trigger: enm(Object.keys(TRIGGERS)),
    conditions: ref('AutomationConditions'), action: ref('AutomationAction'), enabled: bool, run_count: int, last_run_at: nul(time),
    created_at: time,
  }),
  AutomationConditions: AUTOMATION_CONDITIONS,
  AutomationAction: AUTOMATION_ACTION,
  AutomationInput: obj(AUTOMATION_WRITE, ['name', 'trigger', 'action']),
  AutomationPatch: obj(AUTOMATION_WRITE, [], 'Só os campos enviados mudam'),

  // ----- equipe e autenticação -----
  User: USER,
  UserRef: obj({ id: ID, name: str, email: str, color: nul(str), avatar: nul(str) }),
  UserEnvelope: obj({ user: ref('User') }, ['user']),
  UserCreate: obj({
    name: { type: 'string', maxLength: 80 },
    email: str,
    password: { type: 'string', minLength: 8 },
    role: { ...enm(USER_ROLES), default: 'member' },
  }, ['name', 'email', 'password']),
  UserPatch: obj({
    name: { type: 'string', maxLength: 80 },
    email: str,
    color: nul(str),
    role: d(enm(USER_ROLES), 'Só administradores'),
    disabled: d(bool, 'Só administradores; não vale para a própria conta'),
    password: { type: 'string', minLength: 8 },
    current_password: d(str, 'Obrigatória ao trocar a própria senha'),
  }),
  SetupInput: obj({ name: { type: 'string', maxLength: 80 }, email: str, password: { type: 'string', minLength: 8 } }, ['name', 'email', 'password']),
  LoginInput: obj({ email: str, password: str }, ['email', 'password']),
  ForgotInput: obj({ email: str }, ['email']),
  PasswordInput: obj({ password: { type: 'string', minLength: 8 } }, ['password']),
  AuthMe: obj({
    user: d(nul(ref('User')), 'null sem login'),
    setup: d(bool, 'true enquanto não existe nenhuma conta (falta criar o administrador)'),
    unread: int,
    settings: ref('UserSettings'),
    default_language: str,
    mail_enabled: d(bool, 'SMTP configurado'),
  }),
  Invite: obj({
    token: str, email: nul(str), role: enm(USER_ROLES), project_id: nul(int), project_role: nul(enm(ROLES)), created_by: nul(int),
    created_at: time, expires_at: time, used_at: nul(time), used_by: nul(int), project_name: nul(str),
    created_by_name: d(nul(str), 'Só na lista'),
  }),
  InviteInput: obj({
    email: d(nul(str), 'Opcional: se informado, a conta usa esse e-mail'),
    role: { ...enm(USER_ROLES), default: 'member' },
    project_id: d(nul(int), 'Já entra como membro deste projeto'),
    project_role: { ...enm(ROLES), default: 'member' },
    send_email: d(bool, 'Envia o link por e-mail (com SMTP configurado)'),
  }),
  InviteCreated: { allOf: [ref('Invite'), obj({ link: d(str, 'Link do convite'), emailed: bool })] },
  InviteInfo: obj({ email: nul(str), role: enm(USER_ROLES), project: d(nul(str), 'Nome do projeto') }),
  AcceptInviteInput: obj({
    name: { type: 'string', maxLength: 80 },
    email: d(str, 'Usado só se o convite não tiver e-mail'),
    password: { type: 'string', minLength: 8 },
  }, ['name', 'password']),
  ResetLink: obj({ link: str, emailed: bool, expires_in_hours: int }),

  // ----- notificações e configurações -----
  Notification: obj({
    id: ID, user_id: nul(int), task_id: nul(int), key: d(nul(str), 'Evita avisos repetidos'), body: str, type: enm(NOTIFY_TYPES),
    read_at: nul(time), created_at: time, task_title: nul(str), project_id: nul(int),
  }),
  NotificationList: obj({ items: arr(ref('Notification'), 'As 50 mais recentes'), unread: int, types: arr(enm(NOTIFY_TYPES)) }),
  MarkReadInput: obj({ ids: d({ oneOf: [{ const: 'all' }, arr(int)] }, '"all" ou lista de ids') }, ['ids']),
  NotifyChannels: NOTIFY_CHANNELS,
  UserSettings: USER_SETTINGS,
  Settings: obj({
    ...SETTINGS_PROPS,
    mail_enabled: d(bool, 'SMTP configurado'),
    smtp_last_error: d(str, 'Só administradores'),
  }, [], `Quem não é administrador recebe só notify_macos, due_soon_days, default_language, ai_provider e mail_enabled. ${SECRET_SETTINGS.join(' e ')} voltam mascarados.`),
  SettingsInput: obj(SETTINGS_PROPS, [], 'Só as chaves enviadas mudam; chaves desconhecidas são ignoradas. Segredo mascarado ("••••") mantém o valor atual.'),

  // ----- administração e chat -----
  AdminOverview: obj({
    app_version: str, schema_version: int, node: str, uptime_seconds: int, data_dir: str, database_bytes: int, attachments_bytes: int,
    counts: obj({
      users: int, organizations: int, workspaces: int, projects: int, tasks: int, open_tasks: int, comments: int, attachments: int,
      automations: int, inboxes: int, sessions: int,
    }),
    backups: arr(obj({ file: str, bytes: int, created_at: time }), 'Do mais novo ao mais antigo'),
    mail_enabled: bool,
    ai_provider: str,
  }),
  MaintenanceInput: obj({ action: enm(['vacuum', 'cleanup']) }, ['action']),
  ChatMessage: obj({ id: ID, user_id: nul(int), role: enm(['user', 'assistant']), body: str, tools: arr(str, 'Ferramentas usadas'), created_at: time }),
  ChatHistory: obj({ messages: arr(ref('ChatMessage'), 'Últimas 60'), provider: enm(['claude-cli', 'anthropic', 'openai']) }),
  ChatInput: obj({
    message: { type: 'string', maxLength: 8000 },
    project_id: d(nul(int), 'Projeto aberto na tela (contexto)'),
  }, ['message']),
  ChatEvent: {
    description: 'Uma linha JSON por evento; a última é sempre { "type": "done" }',
    oneOf: [
      { title: 'text', ...obj({ type: { const: 'text' }, text: str }, ['type', 'text'], 'Trecho da resposta') },
      { title: 'tool', ...obj({ type: { const: 'tool' }, name: d(str, 'Ferramenta do quadro (ex.: add_tasks)') }, ['type', 'name'], 'O assistente usou uma ferramenta') },
      { title: 'error', ...obj({ type: { const: 'error' }, message: str }, ['type', 'message'], 'Falha do provedor') },
      { title: 'done', ...obj({ type: { const: 'done' } }, ['type'], 'Fim da resposta') },
    ],
  },

  // ----- tempo real -----
  Version: obj({ version: d(str, 'Muda a cada gravação no banco (de qualquer processo)'), unread: int }),
  UiCommand: obj({
    task: d(ID, 'Abrir esta tarefa'),
    project: d(ID, 'Ir para este projeto'),
    view: enm(['board', 'list', 'calendar', 'gantt', 'dashboard', 'activity']),
  }, [], 'Pedido para o painel (ex.: o Claude mostrando uma tarefa na tela)'),
  SseEvent: {
    description: 'Cada mensagem tem as linhas `event:` e `data:` (JSON). Comentários `: ping` a cada 25 s mantêm a conexão.',
    oneOf: [
      { title: 'hello', ...obj({ event: { const: 'hello' }, data: obj({ version: str, unread: int }) }, ['event', 'data'], 'Logo ao conectar') },
      { title: 'change', ...obj({ event: { const: 'change' }, data: obj({ version: str }) }, ['event', 'data'], 'O banco mudou: recarregue o que está na tela') },
      { title: 'unread', ...obj({ event: { const: 'unread' }, data: obj({ unread: int }) }, ['event', 'data'], 'Mudou o número de notificações não lidas') },
      { title: 'ui', ...obj({ event: { const: 'ui' }, data: ref('UiCommand') }, ['event', 'data'], 'Comando para o painel') },
    ],
  },
};

// ---------- operações ----------

const T = {
  auth: 'Autenticação', tasks: 'Tarefas', notes: 'Comentários', time: 'Tempo', files: 'Anexos', shares: 'Links públicos',
  projects: 'Projetos', flow: 'Colunas e fluxo', sprints: 'Sprints', meta: 'Labels e campos', io: 'Importação e exportação',
  inbox: 'Caixa de entrada', workflows: 'Workflows', org: 'Organizações e workspaces', dash: 'Dashboard e atividade',
  automations: 'Automações', team: 'Equipe', notifications: 'Notificações', settings: 'Configurações', admin: 'Administração',
  chat: 'Chat', live: 'Tempo real', docs: 'Documentação',
};

const TAGS = [
  [T.auth, 'Conta de administrador, login, redefinição de senha e aceite de convites.'],
  [T.tasks, 'Estado do quadro, busca, tarefas, dependências e observadores.'],
  [T.notes, 'Comentários em thread, com menções @Nome.'],
  [T.time, 'Timer, registros manuais e relatório de horas.'],
  [T.files, 'Arquivos anexados às tarefas (até 25 MB cada).'],
  [T.shares, 'Links somente leitura de tarefas e de projetos públicos, abertos sem login.'],
  [T.projects, 'Projetos, imagem e membros.'],
  [T.flow, 'Colunas personalizadas (cada uma numa categoria de status), transições permitidas e aplicação de modelos.'],
  [T.sprints, 'Planejamento, início e encerramento de sprints.'],
  [T.meta, 'Labels (cor e descrição das tags) e campos personalizados.'],
  [T.io, 'Exportação CSV e importação de CSV, Jira e Trello, com sincronizações salvas.'],
  [T.inbox, 'Caixa IMAP do projeto: e-mails viram tarefas e respostas viram comentários.'],
  [T.workflows, 'Modelos de colunas e transições reaproveitáveis entre projetos.'],
  [T.org, 'Organizações, workspaces (aninháveis) e seus membros.'],
  [T.dash, 'Números do dashboard e feed de atividade.'],
  [T.automations, 'Regras gatilho → ação que rodam no servidor.'],
  [T.team, 'Pessoas, convites e avatares.'],
  [T.notifications, 'Avisos do painel para a pessoa logada.'],
  [T.settings, 'Preferências pessoais e configurações gerais (e-mail, IA).'],
  [T.admin, 'Saúde do sistema, backups e manutenção do banco.'],
  [T.chat, 'Assistente do painel, com as ferramentas do quadro.'],
  [T.live, 'Eventos em tempo real (SSE), versão do banco e comandos para o painel.'],
  [T.docs, 'Este documento e a página que o exibe.'],
];

const ok = ref('Ok');
const q = (name, schema, description, required = false) => ({ name, in: 'query', required, description, schema });
const projectQuery = (description = 'Só este projeto') => q('project', ID, description);
const IMAGES = {
  types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  desc: 'A imagem (PNG, JPEG, WebP ou GIF, até 2 MB), com o Content-Type dela.',
};

const PERM = {
  read: 'Leitura no projeto',
  edit: 'Edição no projeto (membro, gerente ou dono)',
  manage: 'Gerente ou dono do projeto',
  own: 'Dono do projeto',
  admin: 'Administrador',
  org: 'Administrador, ou dono/gerente da organização',
  writer: 'Administrador ou membro (visualizadores não)',
};

// [método, caminho, tag, resumo, opções]
// Opções: pub (sem login), body/optional, raw, query, headers, res, file/fileTypes, page, sse, ndjson,
// cookie ('set' | 'clear'), perm, desc, more (erros extras) e errors (lista fechada de erros).
const OPS = [
  // ===== autenticação =====
  ['GET', '/api/auth/me', T.auth, 'Sessão atual e estado inicial', {
    pub: true, res: ref('AuthMe'), desc: 'Funciona sem login: `user` vem null e `setup` diz se ainda falta criar a conta de administrador.',
  }],
  ['POST', '/api/auth/setup', T.auth, 'Criar a conta de administrador', {
    pub: true, body: ref('SetupInput'), res: ref('UserEnvelope'), cookie: 'set', more: [409],
    desc: 'Só no primeiro acesso, enquanto não existe nenhuma conta. Já devolve a sessão.',
  }],
  ['POST', '/api/auth/login', T.auth, 'Entrar', {
    pub: true, body: ref('LoginInput'), res: ref('UserEnvelope'), cookie: 'set', desc: 'E-mail ou senha incorretos: 400. Conta desativada: 403.',
  }],
  ['POST', '/api/auth/logout', T.auth, 'Sair', { pub: true, res: ok, cookie: 'clear', desc: 'Sem corpo, mas com `Content-Type: application/json`.' }],
  ['POST', '/api/auth/forgot', T.auth, 'Pedir link para redefinir a senha', {
    pub: true, body: ref('ForgotInput'), res: obj({ ok: { const: true }, mail_enabled: bool }),
    desc: 'Sempre responde ok (não revela se o e-mail existe). O e-mail só sai com o SMTP configurado; o link vale 2 horas.',
  }],
  ['GET', '/api/auth/reset/{token}', T.auth, 'Conferir link de redefinição', { pub: true, res: obj({ name: str, email: str }), desc: 'Link inválido ou vencido: 400.' }],
  ['POST', '/api/auth/reset/{token}', T.auth, 'Definir nova senha pelo link', {
    pub: true, body: ref('PasswordInput'), res: ref('UserEnvelope'), cookie: 'set', desc: 'Encerra as outras sessões da pessoa e entra com uma nova.',
  }],
  ['GET', '/api/invites/{token}', T.auth, 'Conferir convite', { pub: true, res: ref('InviteInfo'), desc: 'Convite inválido, usado ou vencido: 400.' }],
  ['POST', '/api/invites/{token}/accept', T.auth, 'Aceitar convite e criar a conta', {
    pub: true, body: ref('AcceptInviteInput'), res: ref('UserEnvelope'), cookie: 'set', desc: 'Com convite de projeto, a pessoa já entra como membro dele.',
  }],

  // ===== links públicos =====
  ['GET', '/api/public/{token}', T.shares, 'Conteúdo de um link público', {
    pub: true, res: ref('PublicShare'),
    desc: 'Somente leitura, sem e-mails nem tempos. O link de projeto deixa de funcionar se o projeto sair da visibilidade pública.',
  }],
  ['GET', '/api/public/{token}/attachments/{attachment_id}', T.shares, 'Baixar anexo de um link público', {
    pub: true, file: 'O arquivo (inline para imagens, PDF e vídeo)', desc: 'O anexo precisa ser da tarefa (ou do projeto) do link.',
  }],
  ['GET', '/s/{token}', T.shares, 'Página do link público', {
    pub: true, page: true, desc: 'Página HTML que exibe o conteúdo de `GET /api/public/{token}`.',
  }],
  ['POST', '/api/tasks/{id}/shares', T.shares, 'Criar link público da tarefa', { body: ref('ShareInput'), optional: true, res: ref('Share'), perm: PERM.edit }],
  ['POST', '/api/projects/{id}/shares', T.shares, 'Criar link público do projeto', {
    body: ref('ShareInput'), optional: true, res: ref('Share'), perm: PERM.manage, desc: 'O projeto precisa estar com visibilidade `public`.',
  }],
  ['GET', '/api/projects/{id}/shares', T.shares, 'Links públicos ativos do projeto', { res: arr(ref('Share')), perm: PERM.read }],
  ['DELETE', '/api/shares/{token}', T.shares, 'Revogar link público', {
    res: ok, perm: 'Edição no projeto (link de tarefa) ou gerente do projeto (link de projeto)',
  }],

  // ===== tempo real =====
  ['GET', '/api/events', T.live, 'Eventos em tempo real (SSE)', {
    sse: true, errors: [401],
    desc: 'Server-Sent Events. Ao conectar chega `hello`; depois `change` quando o banco muda (inclusive por outro processo, como o MCP), '
      + '`unread` quando muda o número de notificações não lidas e `ui` com comandos para o painel. O servidor confere a cada 0,7 s, '
      + 'manda `: ping` a cada 25 s e sugere `retry: 3000`. Use com `new EventSource(\'/api/events\')`.',
  }],
  ['GET', '/api/version', T.live, 'Versão do banco e notificações não lidas', {
    res: ref('Version'), desc: 'Alternativa ao SSE para consultar de tempos em tempos: se `version` mudou, recarregue com `GET /api/state`.',
  }],
  ['GET', '/api/ui-commands', T.live, 'Pegar comandos pendentes para o painel', {
    res: arr(ref('UiCommand')),
    desc: 'Devolve e marca como consumidos os comandos dos últimos 2 minutos. O SSE entrega os mesmos comandos como evento `ui`.',
  }],

  // ===== sessão e preferências =====
  ['GET', '/api/me/settings', T.settings, 'Minhas preferências', { res: ref('UserSettings') }],
  ['PATCH', '/api/me/settings', T.settings, 'Atualizar minhas preferências', {
    body: ref('UserSettings'), res: ref('UserSettings'), desc: 'Só os campos enviados mudam; em `notify`, só os canais enviados.',
  }],
  ['POST', '/api/me/avatar', T.team, 'Enviar minha foto', { raw: IMAGES, res: ref('AvatarResult') }],
  ['DELETE', '/api/me/avatar', T.team, 'Remover minha foto', { res: ref('AvatarResult') }],
  ['GET', '/api/avatars/{file}', T.team, 'Imagem de avatar', { pub: true, file: 'A imagem', fileTypes: IMAGES.types }],

  // ===== quadro, busca e tarefas =====
  ['GET', '/api/state', T.tasks, 'Estado completo do quadro', {
    query: [projectQuery('Só este projeto (traz também colunas, transições e sprints)'), q('archived', enm(['1']), '1 inclui tarefas arquivadas')],
    res: ref('BoardState'),
    desc: 'Tarefas abertas e as concluídas nos últimos 60 dias (até 5000) dos projetos que você vê, com projetos, pessoas, labels, campos e timers.',
  }],
  ['GET', '/api/search', T.tasks, 'Busca universal', {
    query: [q('q', str, 'Texto, #id ou código (WEB-12)', true)], res: ref('SearchResult'), desc: 'Até 8 resultados por tipo, só nos projetos que você vê.',
  }],
  ['GET', '/api/tasks/{id}', T.tasks, 'Detalhes da tarefa', { res: ref('TaskDetail'), perm: PERM.read }],
  ['POST', '/api/tasks', T.tasks, 'Criar tarefa', {
    body: ref('TaskCreate'), res: ref('Task'), perm: PERM.edit,
    desc: 'Informe `project_id` ou `project_name`. Se já houver uma tarefa aberta com o mesmo título no mesmo lugar, devolve a existente em vez de duplicar. '
      + 'Com `parent_id`, a subtarefa fica no projeto da tarefa-mãe.',
  }],
  ['PATCH', '/api/tasks/{id}', T.tasks, 'Atualizar tarefa', {
    body: ref('TaskPatch'), res: ref('Task'), perm: `${PERM.edit}; ao mover, também no projeto de destino`,
    desc: 'Só os campos enviados mudam; null limpa. Mudar coluna ou status respeita as transições do projeto. '
      + 'Concluir uma tarefa recorrente cria a próxima ocorrência.',
  }],
  ['POST', '/api/tasks/bulk', T.tasks, 'Alterar ou excluir várias tarefas', {
    body: ref('BulkInput'), res: obj({ ok: { const: true }, count: int }), perm: 'Edição em cada tarefa (gerente, para excluir)',
    desc: 'Tudo numa transação: se uma falhar, nenhuma muda.',
  }],
  ['DELETE', '/api/tasks/{id}', T.tasks, 'Excluir tarefa', {
    res: ok, perm: PERM.manage, desc: 'Apaga também subtarefas, comentários, tempos, anexos e links públicos da tarefa.',
  }],
  ['POST', '/api/tasks/{id}/blockers', T.tasks, 'Adicionar dependência', {
    body: ref('BlockerInput'), res: ok, perm: PERM.edit, desc: 'A tarefa passa a ser bloqueada por `blocked_by`. Ciclos são recusados.',
  }],
  ['DELETE', '/api/tasks/{id}/blockers/{blocker_id}', T.tasks, 'Remover dependência', { res: ok, perm: PERM.edit }],
  ['POST', '/api/tasks/{id}/watch', T.tasks, 'Acompanhar ou deixar de acompanhar', {
    body: obj({ on: { type: 'boolean', default: true } }), optional: true, res: ok, perm: PERM.read,
  }],

  // ===== comentários =====
  ['POST', '/api/tasks/{id}/notes', T.notes, 'Comentar', {
    body: ref('NoteInput'), res: obj({ id: d(ID, 'Id do comentário criado') }, ['id']), perm: PERM.edit,
    desc: 'Menções com @Nome (ou primeiro nome) notificam a pessoa.',
  }],
  ['PATCH', '/api/notes/{id}', T.notes, 'Editar comentário', {
    body: obj({ body: str }, ['body']), res: ref('Note'), perm: 'Autor do comentário ou gerente do projeto',
  }],
  ['DELETE', '/api/notes/{id}', T.notes, 'Excluir comentário', { res: ok, perm: 'Autor do comentário ou gerente do projeto' }],

  // ===== tempo =====
  ['POST', '/api/tasks/{id}/timer', T.time, 'Iniciar ou parar o timer', {
    body: ref('TimerInput'), optional: true, res: obj({ timers: arr(ref('RunningTimer'), 'Seus timers em andamento') }), perm: PERM.edit,
    desc: 'Cada pessoa tem um timer por vez: iniciar outro para o anterior.',
  }],
  ['POST', '/api/tasks/{id}/time', T.time, 'Registrar tempo', { body: ref('TimeLogInput'), res: ok, perm: PERM.edit }],
  ['DELETE', '/api/time/{id}', T.time, 'Excluir registro de tempo', { res: ok, perm: PERM.edit }],
  ['GET', '/api/time-report', T.time, 'Relatório de tempo', {
    query: [
      projectQuery(),
      q('from', date, 'Início, inclusive (padrão: 6 dias antes do fim)'),
      q('to', date, 'Fim, inclusive (padrão: hoje)'),
      q('group_by', { ...enm(['task', 'project', 'day', 'person']), default: 'task' }, 'Agrupamento'),
    ],
    res: ref('TimeReport'),
  }],

  // ===== anexos =====
  ['POST', '/api/tasks/{id}/attachments', T.files, 'Enviar anexo', {
    raw: { types: ['*/*'], desc: 'O arquivo (até 25 MB), com o Content-Type dele. Com application/octet-stream, o tipo é deduzido pela extensão.' },
    headers: [{ name: 'x-filename', in: 'header', required: false, description: 'Nome do arquivo, codificado com encodeURIComponent (padrão: "arquivo")', schema: str }],
    res: ref('Attachment'), perm: PERM.edit,
  }],
  ['GET', '/api/attachments/{id}', T.files, 'Baixar anexo', { file: 'O arquivo (inline para imagens, PDF e vídeo)', perm: PERM.read }],
  ['DELETE', '/api/attachments/{id}', T.files, 'Excluir anexo', { res: ok, perm: PERM.edit }],

  // ===== projetos =====
  ['POST', '/api/projects', T.projects, 'Criar projeto', {
    body: ref('ProjectCreate'), res: ref('Project'), perm: PERM.writer,
    desc: 'Quem cria (sem ser administrador) vira dono. Sem `workspace_id`, vai para o primeiro workspace. O workflow padrão, se houver, define as colunas.',
  }],
  ['PATCH', '/api/projects/{id}', T.projects, 'Atualizar projeto', {
    body: ref('ProjectPatch'), res: ref('Project'), perm: 'Gerente ou dono; `archived` e `visibility` só o dono',
  }],
  ['DELETE', '/api/projects/{id}', T.projects, 'Excluir projeto', { res: ok, perm: PERM.own, desc: 'Apaga tarefas, colunas, sprints e anexos do projeto.' }],
  ['POST', '/api/projects/{id}/avatar', T.projects, 'Enviar imagem do projeto', { raw: IMAGES, res: ref('AvatarResult'), perm: PERM.manage }],
  ['GET', '/api/projects/{id}/members', T.projects, 'Membros do projeto', {
    res: arr(ref('Member')), perm: PERM.read, desc: 'Só papéis dados no projeto (não lista os herdados do workspace ou da organização).',
  }],
  ['POST', '/api/projects/{id}/members', T.projects, 'Definir o papel de alguém no projeto', {
    body: ref('MemberInput'), res: arr(ref('Member')), perm: 'Gerente ou dono; dar o papel `owner` exige dono', desc: '`role` null remove a pessoa.',
  }],

  // ===== mapa do código =====
  ['GET', '/api/projects/{id}/mapa', T.projects, 'Situação do mapa do código do projeto', {
    perm: PERM.read,
    res: obj({
      available: { type: 'boolean', description: 'O projeto tem uma pasta que existe neste computador' },
      exists: { type: 'boolean', description: 'Já há um mapa em mapa-do-codigo/' },
      reason: { type: 'string', description: 'Por que não dá para ter mapa (sem pasta)' },
      folder: { type: 'string' }, generated_at: { type: ['string', 'null'] }, agent: { type: ['string', 'null'] },
      blueprint: { type: 'boolean' }, files: { type: ['integer', 'null'] }, parts: { type: ['integer', 'null'] },
      screens: { type: ['integer', 'null'] }, endpoints: { type: ['integer', 'null'] },
      health: obj({ total: { type: 'integer' }, high: { type: 'integer' } }), recent: { type: 'integer' },
      simulation: {
        type: ['object', 'null'], description: 'Resumo da última simulação no Breakscale, ou null',
        properties: { generated_at: { type: 'string' }, scenarios: { type: 'integer' }, bottlenecks: { type: 'integer' }, urgent: { type: 'integer' } },
      },
    }),
    desc: 'O mapa em si é servido em `/mapa/{id}/` (página com login) e a API dele em `/mapa/{id}/api/*`.',
  }],
  ['GET', '/api/projects/{id}/mapa/simulacao', T.projects, 'Simulação do projeto no Breakscale', {
    perm: PERM.read,
    res: obj({
      nome: { type: 'string' }, geradoEm: { type: 'string' }, origem: { type: 'string', enum: ['local', 'hospedado'] },
      link: { type: ['string', 'null'], description: 'Link de breakscale.tech com o modelo no fragmento (#)' },
      temArquivo: { type: 'boolean', description: 'Há um simulacao.breakscale para baixar' },
      componentes: arr(obj({ id: str, nome: str, tipo: str })),
      cenarios: arr(obj({
        fator: { type: 'number', description: 'Múltiplo do tráfego de base' }, nome: str, oferecido: { type: 'number' }, servido: { type: 'number' },
        falhas: { type: 'number', description: 'Fração de 0 a 1' }, p50: { type: 'number' }, p95: { type: 'number' }, p99: { type: 'number' },
        interrompido: { type: 'boolean' }, motivos: arr(obj({ motivo: str, texto: str, n: { type: 'integer' } })),
        componentes: arr(obj({ id: str, entrada: { type: 'number' }, concluidas: { type: 'number' }, ocupacao: { type: 'number' }, esperando: { type: 'number' }, p99: { type: 'number' }, falhas: { type: 'number' }, recusadas: { type: 'number' }, tempoEsgotado: { type: 'number' } })),
      })),
      gargalos: arr(obj({
        id: str, componente: str, nome: str, tipo: str, fator: { type: 'number' }, trafego: { type: 'number' },
        severidade: { type: 'string', enum: ['alta', 'media', 'baixa'] }, titulo: str, porque: str, sugestao: { type: ['string', 'null'] },
      })),
      premissas: arr(obj({ componente: str, texto: str, origem: { type: 'string', enum: ['código', 'chute'] } })),
      deixadoDeFora: arr(obj({ texto: str })),
      tarefas: { type: 'object', description: 'id do gargalo → tarefa já criada a partir dele ({ id, ref, title, status })' },
    }),
    desc: 'Lê `mapa-do-codigo/simulacao.json`, gravado pelo `breakscale.mjs` do plugin do mapa. 404 quando ainda não há simulação.',
  }],
  ['GET', '/api/projects/{id}/mapa/simulacao/arquivo', T.projects, 'Baixar o modelo do Breakscale', {
    perm: PERM.read,
    desc: 'Devolve `simulacao.breakscale` como anexo; abre em breakscale.tech (Settings › Open a file) e na extensão do VS Code.',
  }],
  ['POST', '/api/projects/{id}/mapa/simulacao/tarefas', T.projects, 'Transformar gargalos em tarefas', {
    perm: PERM.edit,
    body: obj({ id: { type: 'string', description: 'Um gargalo' }, ids: arr(str) }),
    res: obj({ tasks: arr(obj({ gargalo: str, duplicate: { type: 'boolean' }, task: obj({ id: { type: 'integer' }, ref: str, title: str, status: str }) })) }),
    desc: 'Cada gargalo vira uma tarefa só (as repetições devolvem a existente com `duplicate: true`). Título, texto e prioridade vêm do resultado gravado.',
  }],
  ['GET', '/api/projects/{id}/mapa/consulta', T.projects, 'Consultar o mapa do código', {
    perm: PERM.read,
    query: [q('arg', str, 'Argumentos da consulta, repetidos em ordem: `arg=find&arg=pedidos`, `arg=show&arg=<id>`, `arg=path&arg=<de>&arg=<para>`, `arg=overview`', true)],
    res: obj({ text: { type: 'string', description: 'Resposta em JSON (texto), com ids' } }),
    desc: 'A mesma consulta que a ferramenta `code_map` do MCP usa; roda o código do plugin sobre o `grafo.json` do projeto.',
  }],

  // ===== colunas e fluxo =====
  ['GET', '/api/projects/{id}/columns', T.flow, 'Colunas do projeto', {
    res: arr(ref('Column')), perm: PERM.read, desc: 'Sem colunas próprias, devolve as 4 padrão (uma por status) com `id` null.',
  }],
  ['POST', '/api/projects/{id}/columns', T.flow, 'Criar coluna', {
    body: ref('ColumnInput'), res: ref('Column'), perm: PERM.manage, desc: 'Na primeira coluna criada, as 4 padrão viram colunas reais.',
  }],
  ['PATCH', '/api/columns/{id}', T.flow, 'Atualizar ou mover coluna', { body: ref('ColumnPatch'), res: ref('Column'), perm: PERM.manage }],
  ['DELETE', '/api/columns/{id}', T.flow, 'Excluir coluna', {
    res: ok, perm: PERM.manage, desc: 'Cada categoria precisa manter ao menos uma coluna. As tarefas vão para a primeira coluna da categoria.',
  }],
  ['GET', '/api/projects/{id}/transitions', T.flow, 'Transições permitidas', {
    res: arr(ref('Transition')), perm: PERM.read, desc: 'Lista vazia: qualquer movimento vale.',
  }],
  ['PUT', '/api/projects/{id}/transitions', T.flow, 'Substituir as transições permitidas', {
    body: ref('TransitionsInput'), res: arr(ref('Transition')), perm: PERM.manage,
  }],
  ['POST', '/api/projects/{id}/workflow', T.flow, 'Aplicar um modelo de workflow', {
    body: obj({ workflow_id: ID }, ['workflow_id']), res: arr(ref('Column')), perm: PERM.manage,
    desc: 'Troca colunas e transições pelas do modelo. Cada tarefa vai para a coluna de mesmo nome e categoria, ou para a primeira da categoria.',
  }],

  // ===== sprints =====
  ['GET', '/api/projects/{id}/sprints', T.sprints, 'Sprints do projeto', { res: arr(ref('Sprint')), perm: PERM.read }],
  ['POST', '/api/projects/{id}/sprints', T.sprints, 'Criar sprint', {
    body: ref('SprintInput'), optional: true, res: ref('Sprint'), perm: PERM.manage, desc: 'Sem nome, vira "Sprint N".',
  }],
  ['PATCH', '/api/sprints/{id}', T.sprints, 'Atualizar sprint', { body: ref('SprintInput'), res: ref('Sprint'), perm: PERM.manage }],
  ['POST', '/api/sprints/{id}/start', T.sprints, 'Iniciar sprint', {
    res: ref('Sprint'), perm: PERM.manage, desc: 'Só uma sprint ativa por projeto. Sem corpo, mas com `Content-Type: application/json`.',
  }],
  ['POST', '/api/sprints/{id}/complete', T.sprints, 'Concluir sprint', {
    body: ref('SprintCloseInput'), optional: true, res: ref('SprintCloseResult'), perm: PERM.manage,
    desc: 'As tarefas não concluídas vão para `move_to` ou para o backlog.',
  }],
  ['POST', '/api/sprints/{id}/cancel', T.sprints, 'Cancelar sprint', {
    body: ref('SprintCloseInput'), optional: true, res: ref('SprintCloseResult'), perm: PERM.manage,
    desc: 'Como concluir, mas com status `cancelled` e sem disparar automações de sprint concluída.',
  }],
  ['DELETE', '/api/sprints/{id}', T.sprints, 'Excluir sprint', { res: ok, perm: PERM.manage, desc: 'As tarefas ficam sem sprint.' }],

  // ===== labels e campos =====
  ['GET', '/api/labels', T.meta, 'Labels', {
    query: [projectQuery('Inclui os labels deste projeto')], res: arr(ref('Label')), desc: 'Os labels globais e, com `project`, os do projeto.',
  }],
  ['POST', '/api/labels', T.meta, 'Criar label', { body: ref('LabelInput'), res: ref('Label'), perm: 'Gerente do projeto; administrador para label global' }],
  ['PATCH', '/api/labels/{id}', T.meta, 'Atualizar label', {
    body: ref('LabelPatch'), res: ref('Label'), perm: 'Gerente do projeto; administrador para label global', desc: 'Renomear atualiza a tag nas tarefas.',
  }],
  ['DELETE', '/api/labels/{id}', T.meta, 'Excluir label', {
    res: ok, perm: 'Gerente do projeto; administrador para label global', desc: 'Também tira a tag das tarefas.',
  }],
  ['GET', '/api/fields', T.meta, 'Campos personalizados', {
    query: [projectQuery('Inclui os campos deste projeto')], res: arr(ref('CustomField')), desc: 'Os campos globais e, com `project`, os do projeto.',
  }],
  ['POST', '/api/fields', T.meta, 'Criar campo personalizado', {
    body: ref('CustomFieldInput'), res: ref('CustomField'), perm: 'Gerente do projeto; administrador para campo global',
  }],
  ['PATCH', '/api/fields/{id}', T.meta, 'Atualizar campo personalizado', {
    body: ref('CustomFieldPatch'), res: ref('CustomField'), perm: 'Gerente do projeto; administrador para campo global',
  }],
  ['DELETE', '/api/fields/{id}', T.meta, 'Excluir campo personalizado', {
    res: ok, perm: 'Gerente do projeto; administrador para campo global', desc: 'Apaga também os valores nas tarefas.',
  }],

  // ===== exportação e importação =====
  ['GET', '/api/export.csv', T.io, 'Exportar tarefas em CSV', {
    query: [projectQuery(), q('status', { ...enm(['all', 'open', ...STATUSES]), default: 'all' }, 'open = tudo que não está concluído')],
    file: 'CSV em UTF-8 (com BOM), com os campos personalizados como colunas', fileTypes: ['text/csv'], desc: 'Até 5000 tarefas.',
  }],
  ['POST', '/api/projects/{id}/import/csv', T.io, 'Importar CSV (ou CSV do Jira)', {
    raw: {
      types: ['text/csv'],
      desc: 'O CSV (UTF-8; vírgula ou ponto e vírgula). Cabeçalhos em português ou inglês (título/title/summary, status, prioridade…); '
        + 'o CSV do Jira é reconhecido pelo cabeçalho "Issue key".',
    },
    res: ref('ImportResult'), perm: PERM.manage, desc: 'Reimportar atualiza as tarefas casadas pelo id externo, sem duplicar.',
  }],
  ['POST', '/api/projects/{id}/import/trello-file', T.io, 'Importar o JSON exportado do Trello', {
    raw: { types: ['application/json'], desc: 'O arquivo JSON do quadro (Menu → Imprimir, exportar e compartilhar → Exportar como JSON).' },
    res: ref('ImportResult'), perm: PERM.manage, desc: 'Cria uma coluna por lista, os labels e subtarefas a partir dos checklists.',
  }],
  ['POST', '/api/projects/{id}/import/{kind}', T.io, 'Importar do Jira ou do Trello pela API', {
    body: { oneOf: [ref('JiraImportInput'), ref('TrelloImportInput')] }, res: ref('ImportResult'), perm: PERM.manage,
    desc: '`kind=jira` usa site, email, token e jql; `kind=trello` usa board, key e token. Com `save: true`, guarda a configuração para sincronizar de novo.',
  }],
  ['GET', '/api/projects/{id}/syncs', T.io, 'Sincronizações salvas do projeto', { res: arr(ref('ExternalSync')), perm: PERM.read }],
  ['POST', '/api/syncs/{id}/run', T.io, 'Sincronizar agora', { res: ref('ImportResult'), perm: PERM.manage }],
  ['DELETE', '/api/syncs/{id}', T.io, 'Excluir sincronização salva', { res: ok, perm: PERM.manage }],

  // ===== caixa de entrada =====
  ['GET', '/api/projects/{id}/inbox', T.inbox, 'Caixa de entrada do projeto', {
    res: ref('InboxState'), perm: PERM.read, desc: 'Configuração (senha mascarada), regras e as últimas 50 mensagens processadas.',
  }],
  ['PUT', '/api/projects/{id}/inbox', T.inbox, 'Configurar a caixa de entrada', {
    body: ref('InboxInput'), res: ref('Inbox'), perm: PERM.manage, desc: 'Cria ou atualiza. Campos ausentes mantêm o valor atual.',
  }],
  ['DELETE', '/api/projects/{id}/inbox', T.inbox, 'Remover a caixa de entrada', { res: ok, perm: PERM.manage }],
  ['POST', '/api/projects/{id}/inbox/test', T.inbox, 'Testar a conexão IMAP', { res: ok, perm: PERM.manage }],
  ['POST', '/api/projects/{id}/inbox/sync', T.inbox, 'Ler a caixa agora', {
    res: ref('InboxSyncResult'), perm: PERM.manage,
    desc: 'Lê até 50 e-mails não lidos: os novos viram tarefas; respostas com `[#id]` no assunto viram comentários.',
  }],
  ['POST', '/api/projects/{id}/inbox/rules', T.inbox, 'Criar regra', { body: ref('InboxRuleInput'), res: arr(ref('InboxRule')), perm: PERM.manage }],
  ['PATCH', '/api/projects/{id}/inbox/rules/{rule_id}', T.inbox, 'Atualizar regra', {
    body: ref('InboxRuleInput'), res: arr(ref('InboxRule')), perm: PERM.manage, desc: 'Substitui a regra inteira (`name` é obrigatório).',
  }],
  ['DELETE', '/api/projects/{id}/inbox/rules/{rule_id}', T.inbox, 'Excluir regra', { res: ok, perm: PERM.manage }],

  // ===== workflows =====
  ['GET', '/api/workflows', T.workflows, 'Modelos de workflow', { res: arr(ref('Workflow')) }],
  ['POST', '/api/workflows', T.workflows, 'Criar modelo de workflow', { body: ref('WorkflowInput'), res: ref('Workflow'), perm: PERM.admin }],
  ['POST', '/api/workflows/from-project/{project_id}', T.workflows, 'Salvar as colunas de um projeto como modelo', {
    body: ref('WorkflowFromProjectInput'), optional: true, res: ref('Workflow'), perm: 'Gerente do projeto; administrador para `is_default`',
  }],
  ['PATCH', '/api/workflows/{id}', T.workflows, 'Atualizar modelo de workflow', { body: ref('WorkflowPatch'), res: ref('Workflow'), perm: PERM.admin }],
  ['DELETE', '/api/workflows/{id}', T.workflows, 'Excluir modelo de workflow', {
    res: ok, perm: PERM.admin, desc: 'Projetos que já usaram o modelo não mudam.',
  }],

  // ===== organizações e workspaces =====
  ['GET', '/api/organizations', T.org, 'Organizações', { res: arr(ref('Organization')) }],
  ['POST', '/api/organizations', T.org, 'Criar organização', {
    body: ref('OrganizationInput'), res: ref('Organization'), perm: PERM.admin, desc: 'Já cria um workspace "Geral".',
  }],
  ['PATCH', '/api/organizations/{id}', T.org, 'Atualizar organização', { body: ref('OrganizationPatch'), res: ref('Organization'), perm: PERM.org }],
  ['DELETE', '/api/organizations/{id}', T.org, 'Excluir organização', {
    res: ok, perm: PERM.admin, desc: 'Só sem projetos, e sempre fica ao menos uma organização.',
  }],
  ['POST', '/api/organizations/{id}/avatar', T.org, 'Enviar imagem da organização', { raw: IMAGES, res: ref('AvatarResult'), perm: PERM.org }],
  ['GET', '/api/organizations/{id}/members', T.org, 'Membros da organização', { res: arr(ref('Member')) }],
  ['POST', '/api/organizations/{id}/members', T.org, 'Definir o papel de alguém na organização', {
    body: ref('MemberInput'), res: arr(ref('Member')), perm: PERM.org, desc: 'O papel vale para todos os projetos da organização. `role` null remove.',
  }],
  ['GET', '/api/workspaces', T.org, 'Workspaces', { query: [q('organization', ID, 'Só desta organização')], res: arr(ref('Workspace')) }],
  ['POST', '/api/workspaces', T.org, 'Criar workspace', { body: ref('WorkspaceInput'), res: ref('Workspace'), perm: PERM.org }],
  ['PATCH', '/api/workspaces/{id}', T.org, 'Atualizar workspace', { body: ref('WorkspacePatch'), res: ref('Workspace'), perm: PERM.org }],
  ['DELETE', '/api/workspaces/{id}', T.org, 'Excluir workspace', {
    res: ok, perm: PERM.org, desc: 'Projetos e sub-workspaces sobem para o workspace-pai (ou para outro da organização).',
  }],
  ['GET', '/api/workspaces/{id}/members', T.org, 'Membros do workspace', { res: arr(ref('Member')) }],
  ['POST', '/api/workspaces/{id}/members', T.org, 'Definir o papel de alguém no workspace', {
    body: ref('MemberInput'), res: arr(ref('Member')), perm: PERM.org, desc: 'O papel vale para os projetos do workspace e dos sub-workspaces.',
  }],

  // ===== dashboard e atividade =====
  ['GET', '/api/stats', T.dash, 'Números do dashboard', {
    query: [projectQuery()], res: ref('Stats'), desc: 'Com `project`, inclui a sprint ativa (com burndown) e a velocidade das últimas sprints.',
  }],
  ['GET', '/api/activity', T.dash, 'Feed de atividade', {
    query: [
      projectQuery(),
      q('user', ID, 'Só ações desta pessoa'),
      q('author', str, 'claude, user, automação, e-mail…'),
      q('kind', enm(['created', 'note', 'event']), 'Tipo de item'),
      q('since', date, 'A partir do dia'),
      q('until', date, 'Até o dia, inclusive'),
      q('q', str, 'Texto no título ou no conteúdo'),
      q('limit', { type: 'integer', default: 50, maximum: 500 }, 'Quantidade'),
      q('offset', { type: 'integer', default: 0 }, 'Paginação'),
    ],
    res: arr(ref('ActivityItem')),
  }],

  // ===== automações =====
  ['GET', '/api/automations', T.automations, 'Automações', { res: arr(ref('Automation')), desc: 'As globais e as dos projetos que você vê.' }],
  ['POST', '/api/automations', T.automations, 'Criar automação', {
    body: ref('AutomationInput'), res: ref('Automation'), perm: 'Gerente do projeto; administrador para automação global',
  }],
  ['PATCH', '/api/automations/{id}', T.automations, 'Atualizar automação', {
    body: ref('AutomationPatch'), res: ref('Automation'), perm: 'Gerente do projeto; administrador para automação global (ou para torná-la global)',
  }],
  ['DELETE', '/api/automations/{id}', T.automations, 'Excluir automação', { res: ok, perm: 'Gerente do projeto; administrador para automação global' }],

  // ===== equipe =====
  ['GET', '/api/users', T.team, 'Pessoas', {
    query: [q('all', enm(['1']), '1 inclui contas desativadas (só para administradores)')], res: arr(ref('User')),
  }],
  ['POST', '/api/users', T.team, 'Criar usuário', { body: ref('UserCreate'), res: ref('User'), perm: PERM.admin }],
  ['PATCH', '/api/users/{id}', T.team, 'Atualizar usuário', {
    body: ref('UserPatch'), res: ref('User'), perm: 'A própria pessoa ou administrador; papel e desativação só administrador',
    desc: 'Desativar ou trocar a senha de outra pessoa encerra as sessões dela. Sempre fica ao menos um administrador ativo.',
  }],
  ['DELETE', '/api/users/{id}', T.team, 'Remover usuário', {
    res: ok, perm: PERM.admin, desc: 'Não remove a própria conta nem o último administrador.',
  }],
  ['POST', '/api/users/{id}/reset-link', T.team, 'Gerar link de redefinição de senha', {
    res: ref('ResetLink'), perm: PERM.admin, desc: 'Também envia por e-mail se o SMTP estiver configurado. Vale 2 horas.',
  }],
  ['POST', '/api/users/{id}/avatar', T.team, 'Enviar a foto de alguém', { raw: IMAGES, res: ref('AvatarResult'), perm: 'A própria pessoa ou administrador' }],
  ['GET', '/api/invites', T.team, 'Convites pendentes', { res: arr(ref('Invite')), perm: PERM.admin }],
  ['POST', '/api/invites', T.team, 'Criar convite', {
    body: ref('InviteInput'), optional: true, res: ref('InviteCreated'), perm: PERM.admin,
    desc: 'Vale 14 dias. Com `send_email` e SMTP configurado, envia o link por e-mail.',
  }],
  ['DELETE', '/api/invites/{token}', T.team, 'Revogar convite', { res: ok, perm: PERM.admin }],

  // ===== notificações e configurações =====
  ['GET', '/api/notifications', T.notifications, 'Minhas notificações', { res: ref('NotificationList') }],
  ['POST', '/api/notifications/read', T.notifications, 'Marcar notificações como lidas', {
    body: ref('MarkReadInput'), res: obj({ unread: int }, ['unread']),
  }],
  ['GET', '/api/settings', T.settings, 'Configurações gerais', { res: ref('Settings') }],
  ['PATCH', '/api/settings', T.settings, 'Atualizar configurações gerais', { body: ref('SettingsInput'), res: ref('Settings'), perm: PERM.admin }],
  ['POST', '/api/settings/test-email', T.settings, 'Enviar e-mail de teste', {
    body: obj({ to: d(str, 'Destinatário (padrão: o seu e-mail)') }), optional: true, res: ok, perm: PERM.admin, desc: 'Falha de SMTP: 400 com a mensagem do servidor.',
  }],

  // ===== administração =====
  ['GET', '/api/admin/overview', T.admin, 'Visão geral do sistema', { res: ref('AdminOverview'), perm: PERM.admin }],
  ['POST', '/api/admin/backup', T.admin, 'Fazer backup agora', {
    res: obj({ file: d(str, 'backup-manual-….db, na pasta de dados') }, ['file']), perm: PERM.admin,
  }],
  ['GET', '/api/admin/backups/{file}', T.admin, 'Baixar backup', { file: 'O banco SQLite', fileTypes: ['application/vnd.sqlite3'], perm: PERM.admin }],
  ['DELETE', '/api/admin/backups/{file}', T.admin, 'Excluir backup', { res: ok, perm: PERM.admin }],
  ['POST', '/api/admin/maintenance', T.admin, 'Manutenção do banco', {
    body: ref('MaintenanceInput'), res: ref('AdminOverview'), perm: PERM.admin,
    desc: '`vacuum` compacta o banco. `cleanup` apaga sessões, convites e links de senha vencidos, comandos do painel com mais de 1 dia '
      + 'e notificações lidas há mais de 90 dias.',
  }],

  // ===== chat =====
  ['GET', '/api/chat', T.chat, 'Histórico do chat', { res: ref('ChatHistory') }],
  ['DELETE', '/api/chat', T.chat, 'Limpar o chat', { res: ok, desc: 'Apaga o histórico e a sessão do assistente.' }],
  ['POST', '/api/chat', T.chat, 'Enviar mensagem ao assistente', {
    body: ref('ChatInput'), ndjson: true, more: [409], perm: PERM.writer,
    desc: 'Resposta em streaming (`application/x-ndjson`): uma linha JSON por evento — `text`, `tool`, `error` — e sempre termina com `done`. '
      + 'O provedor (claude-cli, anthropic ou openai) vem das configurações. 409 se a mensagem anterior ainda está sendo respondida.',
  }],

  // ===== documentação =====
  ['GET', '/api/openapi.json', T.docs, 'Este documento OpenAPI', { pub: true, res: d({ type: 'object' }, 'Documento OpenAPI 3.1') }],
  ['GET', '/docs/api', T.docs, 'Página da documentação', { pub: true, page: true, desc: '`/api/docs` redireciona para cá.' }],
];

// ---------- montagem ----------

const OWNER = {
  tasks: 'da tarefa', notes: 'do comentário', time: 'do registro de tempo', attachments: 'do anexo', projects: 'do projeto',
  columns: 'da coluna', sprints: 'da sprint', labels: 'do label', fields: 'do campo', syncs: 'da sincronização',
  workflows: 'do modelo de workflow', organizations: 'da organização', workspaces: 'do workspace', automations: 'da automação',
  users: 'do usuário',
};

function pathParam(name, path) {
  const segs = path.split('/');
  const before = segs[segs.indexOf(`{${name}}`) - 1];
  const token = { type: 'string', pattern: '^[\\w-]+$' };
  const spec = {
    id: [ID, `Id ${OWNER[before] || ''}`.trim()],
    token: [token, path.startsWith('/api/auth/') ? 'Token do link de redefinição' : path.startsWith('/api/invites/') ? 'Token do convite' : 'Token do link público'],
    attachment_id: [ID, 'Id do anexo'],
    blocker_id: [ID, 'Id da tarefa bloqueadora'],
    rule_id: [ID, 'Id da regra'],
    project_id: [ID, 'Id do projeto'],
    kind: [enm(['jira', 'trello']), 'Origem da importação'],
    file: [{ type: 'string', pattern: '^[\\w.-]+$' }, path.includes('/avatars/') ? 'Nome do arquivo do avatar' : 'Nome do arquivo de backup (backup-….db)'],
  }[name];
  return { name, in: 'path', required: true, description: spec[1], schema: spec[0] };
}

const ERROR_RESPONSES = {
  400: ['BadRequest', 'Dados inválidos. Alguns recursos inexistentes também respondem 400 (erro de validação).'],
  401: ['Unauthorized', 'Sem login: "Faça login" (ou "Crie a conta de administrador" no primeiro acesso).'],
  403: ['Forbidden', 'Sem permissão, ou Origin/Host não permitido.'],
  404: ['NotFound', 'Não encontrado.'],
  409: ['Conflict', 'Conflito com o estado atual.'],
  413: ['PayloadTooLarge', 'Corpo grande demais (JSON até 1 MB; uploads até 26 MB).'],
  415: ['UnsupportedMediaType', 'Faltou `Content-Type: application/json`.'],
};

function errorCodes(method, path, o) {
  if (o.errors) return o.errors;
  const codes = new Set(o.more || []);
  const withBody = ['POST', 'PATCH', 'PUT'].includes(method);
  const params = path.includes('{');
  if (o.page) return [404];
  if (withBody || params || o.query?.length) codes.add(400);
  if (!o.pub) codes.add(401);
  if (!o.pub || method !== 'GET') codes.add(403);
  if (params) codes.add(404);
  if (withBody) codes.add(413);
  if (withBody && !o.raw) codes.add(415);
  return [...codes].sort((a, b) => a - b);
}

function success(o) {
  if (o.sse) {
    return {
      description: 'Fluxo de eventos',
      content: { 'text/event-stream': { schema: ref('SseEvent'), example: 'retry: 3000\n\nevent: hello\ndata: {"version":"42.3","unread":0}\n\nevent: change\ndata: {"version":"43.3"}\n\n' } },
    };
  }
  if (o.ndjson) {
    return {
      description: 'Uma linha JSON por evento',
      content: { 'application/x-ndjson': { schema: ref('ChatEvent'), example: '{"type":"tool","name":"list_tasks"}\n{"type":"text","text":"Você tem 3 tarefas abertas."}\n{"type":"done"}\n' } },
    };
  }
  if (o.page) return { description: 'Página HTML', content: { 'text/html': { schema: str } } };
  if (o.file) {
    return {
      description: o.file,
      headers: { 'Content-Disposition': { description: 'inline ou attachment, com o nome do arquivo', schema: str } },
      content: Object.fromEntries((o.fileTypes || ['*/*']).map((t) => [t, { schema: binary }])),
    };
  }
  const res = { description: 'OK', content: { 'application/json': { schema: o.res || { type: 'object' } } } };
  if (o.cookie) {
    res.headers = {
      'Set-Cookie': {
        description: o.cookie === 'set' ? 'tk_session=<token>; HttpOnly; SameSite=Lax; Max-Age de 90 dias' : 'tk_session vazio com Max-Age=0',
        schema: str,
      },
    };
  }
  return res;
}

function operationId(method, path) {
  const words = path.replace(/^\/api\//, '/').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  return method.toLowerCase() + words.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
}

function buildPaths() {
  const paths = {};
  for (const [method, path, tag, summary, o] of OPS) {
    const op = { tags: [tag], summary, operationId: operationId(method, path) };
    if (o.desc) op.description = o.desc;
    if (o.pub) op.security = [];
    if (o.perm) op['x-permission'] = o.perm;
    const params = [
      ...[...path.matchAll(/\{(\w+)\}/g)].map((m) => pathParam(m[1], path)),
      ...(o.query || []),
      ...(o.headers || []),
      ...(o.raw ? [{ name: 'Origin', in: 'header', required: true, description: 'Endereço do painel (obrigatório nos uploads)', schema: str }] : []),
    ];
    if (params.length) op.parameters = params;
    if (o.raw) {
      op.requestBody = { required: true, description: o.raw.desc, content: Object.fromEntries(o.raw.types.map((t) => [t, { schema: binary }])) };
      op['x-raw-body'] = true;
    } else if (o.body) {
      op.requestBody = { required: !o.optional, content: { 'application/json': { schema: o.body } } };
    }
    op.responses = { 200: success(o) };
    for (const code of errorCodes(method, path, o)) op.responses[code] = { $ref: `#/components/responses/${ERROR_RESPONSES[code][0]}` };
    (paths[path] ||= {})[method.toLowerCase()] = op;
  }
  return paths;
}

const DESCRIPTION = `API REST do painel do quadro de tarefas. Os caminhos são relativos ao endereço do painel (padrão \`http://localhost:4317\`). A página \`/docs/api\` mostra este documento.

**Autenticação**: sessão no cookie \`tk_session\` (HttpOnly, 90 dias), criado por \`/api/auth/setup\`, \`/api/auth/login\`, \`/api/auth/reset/{token}\` e \`/api/invites/{token}/accept\`. As operações marcadas como públicas funcionam sem login. Nos projetos, o papel efetivo (visualizador, membro, gerente ou dono) é o maior entre projeto, workspace e organização; administradores podem tudo.

**Requisições que alteram dados**:
- POST, PATCH e PUT enviam \`Content-Type: application/json\`, mesmo sem corpo (senão 415). A exceção são os uploads binários. DELETE não leva corpo nem precisa do cabeçalho.
- Envie o cabeçalho \`Origin\` com o endereço do próprio painel: um Origin de outro host recebe 403, e nos uploads binários ele é obrigatório.
- O corpo JSON vai até 1 MB.

**Uploads binários** (anexos, avatares e importação de CSV ou de arquivo do Trello): o corpo é o próprio arquivo, com o \`Content-Type\` dele (até 26 MB no total; anexos até 25 MB, avatares até 2 MB). Nos anexos, mande o nome no cabeçalho \`x-filename\`, codificado com \`encodeURIComponent\`.

**Erros** voltam como \`{ "error": "mensagem" }\`, com status 400 (validação; alguns recursos inexistentes também caem aqui), 401 (sem login), 403 (sem permissão, ou origem/host não permitidos), 404, 409 (conflito), 413 (corpo grande demais) ou 415 (Content-Type errado).

**Tempo real**: \`GET /api/events\` (Server-Sent Events) avisa quando o banco muda; o cliente então recarrega o que precisa com \`GET /api/state\`.`;

export function openapi(version) {
  return {
    openapi: '3.1.0',
    info: { title: 'API do quadro de tarefas', version: String(version || '0.0.0'), description: DESCRIPTION },
    tags: TAGS.map(([name, description]) => ({ name, description })),
    security: [{ cookieAuth: [] }],
    paths: buildPaths(),
    components: {
      securitySchemes: {
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tk_session', description: 'Token de sessão criado no login (HttpOnly; vale 90 dias).' },
      },
      responses: Object.fromEntries(Object.values(ERROR_RESPONSES).map(([name, description]) => [name, {
        description,
        content: { 'application/json': { schema: ref('Error') } },
      }])),
      schemas,
    },
  };
}
