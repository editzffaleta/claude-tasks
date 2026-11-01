// Validação, datas e rótulos compartilhados pelo banco, MCP, servidor e motor de automações.

export const STATUSES = ['todo', 'doing', 'blocked', 'done'];
export const PRIORITIES = ['lowest', 'low', 'medium', 'high', 'urgent'];
export const TYPES = ['task', 'bug', 'story', 'epic'];
export const FREQS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
export const SPRINT_STATUSES = ['planning', 'active', 'completed', 'cancelled'];
export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'];
export const VISIBILITIES = ['private', 'internal', 'public'];
export const ROLES = ['owner', 'manager', 'member', 'viewer'];
export const USER_ROLES = ['admin', 'member', 'viewer'];
export const DEPENDENCY_TYPES = ['finish_start', 'start_start', 'finish_finish', 'start_finish'];
export const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multi_select', 'user', 'url'];

export const STATUS_LABEL = { todo: 'a fazer', doing: 'em andamento', blocked: 'bloqueada', done: 'concluída' };
export const COLUMN_NAME = { todo: 'A fazer', doing: 'Em andamento', blocked: 'Bloqueadas', done: 'Concluídas' };
export const PRIORITY_LABEL = { lowest: 'mínima', low: 'baixa', medium: 'média', high: 'alta', urgent: 'urgente' };
export const TYPE_LABEL = { task: 'tarefa', bug: 'bug', story: 'história', epic: 'épico' };
export const FREQ_LABEL = { daily: 'diária', weekly: 'semanal', monthly: 'mensal', quarterly: 'trimestral', yearly: 'anual' };
export const PROJECT_STATUS_LABEL = { planning: 'planejamento', active: 'ativo', on_hold: 'em espera', completed: 'concluído', cancelled: 'cancelado' };
export const DEPENDENCY_LABEL = {
  finish_start: 'termina → começa',
  start_start: 'começa → começa',
  finish_finish: 'termina → termina',
  start_finish: 'começa → termina',
};
export const ROLE_LABEL = { owner: 'dono', manager: 'gerente', member: 'membro', viewer: 'visualizador' };

export class ValidationError extends Error {
  status = 400;
}

export class ForbiddenError extends Error {
  status = 403;
}

export const fail = (msg) => { throw new ValidationError(msg); };
export const forbid = (msg = 'Você não tem permissão para isso') => { throw new ForbiddenError(msg); };

export const now = () => new Date().toISOString();

export function cleanText(value, field, { required = false, max = 20000 } = {}) {
  if (value == null) return required ? fail(`O campo "${field}" é obrigatório`) : undefined;
  const text = String(value).trim();
  if (required && !text) fail(`O campo "${field}" não pode ficar vazio`);
  return text.slice(0, max);
}

export function cleanEnum(value, field, allowed) {
  if (value == null || value === '') return undefined;
  if (!allowed.includes(value)) fail(`"${field}" deve ser um de: ${allowed.join(', ')}`);
  return value;
}

export function cleanTags(tags) {
  if (tags == null) return undefined;
  const list = Array.isArray(tags) ? tags : String(tags).split(',');
  return [...new Set(list.map((t) => String(t).trim()).filter(Boolean))].slice(0, 12);
}

export function cleanId(value, field = 'id') {
  const n = Number(String(value).replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) fail(`"${field}" inválido: ${value}`);
  return n;
}

export function cleanColor(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const c = String(value).trim();
  if (!/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c)) fail('Cor inválida: use o formato #rrggbb');
  return c.toLowerCase();
}

// ---- datas (sempre AAAA-MM-DD no fuso local) ----

export function localDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export const today = () => localDate();

export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 86400000);
}

// undefined = não mexer; null = limpar.
export function cleanDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const s = String(value).trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) fail(`"${field}" deve ser uma data AAAA-MM-DD`);
  return s;
}

// ---- durações ("90m", "2h", "1h30m", "1,5h", "1d" = 8h) ----

export function parseDuration(value, field = 'duração') {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value === 'number') return Math.max(0, Math.round(value));
  const s = String(value).toLowerCase().replace(/\s+/g, '');
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let rest = s;
  for (const [match, n, unit] of s.matchAll(/(\d+(?:[.,]\d+)?)(d|h|min|m)/g)) {
    const x = parseFloat(n.replace(',', '.'));
    total += unit === 'd' ? x * 480 : unit === 'h' ? x * 60 : x;
    rest = rest.replace(match, '');
  }
  if (rest || !total) fail(`"${field}" inválida: use 90m, 2h, 1h30m ou 1d`);
  return Math.round(total);
}

export function formatDuration(min) {
  if (!min) return '0m';
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`;
}

export function cleanPoints(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 1000) fail('"story_points" deve ser um número entre 0 e 1000');
  return n;
}

// ---- recorrência ----
// { freq, interval, weekdays?: [0-6] (semanal), monthday?: 1-31 | 'last' (mensal/trimestral),
//   until?: data, count?: total de ocorrências, n?: ocorrência atual }

export function cleanRecurrence(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === false || value === 'none') return null;
  let r = value;
  if (typeof r === 'string') {
    try { r = FREQS.includes(r) ? { freq: r } : JSON.parse(r); } catch { fail('Recorrência inválida'); }
  }
  if (!FREQS.includes(r?.freq)) fail(`"recurrence.freq" deve ser um de: ${FREQS.join(', ')}`);
  const out = { freq: r.freq, interval: Math.max(1, Math.min(365, Math.round(Number(r.interval) || 1))) };
  if (r.freq === 'weekly' && Array.isArray(r.weekdays) && r.weekdays.length) {
    const days = [...new Set(r.weekdays.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) fail('"recurrence.weekdays" deve ter dias de 0 (domingo) a 6 (sábado)');
    out.weekdays = days;
  }
  if ((r.freq === 'monthly' || r.freq === 'quarterly') && r.monthday != null && r.monthday !== '') {
    if (r.monthday !== 'last' && !(Number.isInteger(Number(r.monthday)) && r.monthday >= 1 && r.monthday <= 31)) {
      fail('"recurrence.monthday" deve ser de 1 a 31 ou "last"');
    }
    out.monthday = r.monthday === 'last' ? 'last' : Number(r.monthday);
  }
  if (r.until) out.until = cleanDate(r.until, 'recurrence.until');
  if (r.count != null && r.count !== '') {
    const c = Math.round(Number(r.count));
    if (!(c >= 1 && c <= 1000)) fail('"recurrence.count" deve ser de 1 a 1000');
    out.count = c;
    out.n = Math.max(1, Math.round(Number(r.n) || 1));
  }
  return JSON.stringify(out);
}

function addMonths(date, months, monthday) {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(y, m - 1 + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  const day = monthday === 'last' ? lastDay : Math.min(monthday ?? d, lastDay);
  target.setDate(day);
  return localDate(target);
}

export function nextOccurrence(date, { freq, interval = 1, weekdays, monthday }) {
  if (freq === 'daily') return addDays(date, interval);
  if (freq === 'weekly') {
    if (!weekdays?.length) return addDays(date, 7 * interval);
    // Próximo dia marcado; ao virar a semana, pula (interval - 1) semanas.
    const base = new Date(`${date}T12:00:00`);
    const weekStart = (d) => { const x = new Date(d); x.setDate(x.getDate() - x.getDay()); return x; };
    const startWeek = weekStart(base);
    for (let i = 1; i <= 7 * interval + 7; i++) {
      const c = new Date(base);
      c.setDate(c.getDate() + i);
      const weeks = Math.round((weekStart(c) - startWeek) / (7 * 86400000));
      if (weekdays.includes(c.getDay()) && (weeks === 0 || weeks % interval === 0)) return localDate(c);
    }
    return addDays(date, 7 * interval);
  }
  if (freq === 'monthly') return addMonths(date, interval, monthday);
  if (freq === 'quarterly') return addMonths(date, 3 * interval, monthday);
  return addMonths(date, 12 * interval, monthday);
}

const WEEKDAY_SHORT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

export function describeRecurrence(json) {
  if (!json) return '';
  const r = typeof json === 'string' ? JSON.parse(json) : json;
  const unit = { daily: ['dia', 'dias'], weekly: ['semana', 'semanas'], monthly: ['mês', 'meses'], quarterly: ['trimestre', 'trimestres'], yearly: ['ano', 'anos'] }[r.freq];
  let base = r.interval > 1 ? `a cada ${r.interval} ${unit[1]}` : FREQ_LABEL[r.freq];
  if (r.weekdays?.length) base += ` (${r.weekdays.map((d) => WEEKDAY_SHORT[d]).join(', ')})`;
  if (r.monthday) base += r.monthday === 'last' ? ' (último dia)' : ` (dia ${r.monthday})`;
  if (r.count) base += `, ${r.n || 1} de ${r.count}`;
  return r.until ? `${base} até ${r.until}` : base;
}

// ---- automações ----

export const TRIGGERS = {
  task_created: 'Tarefa criada',
  task_updated: 'Tarefa atualizada',
  status_changed: 'Status mudou',
  priority_changed: 'Prioridade mudou',
  comment_added: 'Comentário adicionado',
  assigned: 'Responsável adicionado',
  due_soon: 'Prazo chegando',
  overdue: 'Prazo vencido',
  sprint_started: 'Sprint iniciada',
  sprint_completed: 'Sprint concluída',
  project_created: 'Projeto criado',
};

export const ACTIONS = {
  set_status: 'Mudar status',
  set_column: 'Mover para a coluna',
  set_priority: 'Mudar prioridade',
  add_tag: 'Adicionar tag',
  remove_tag: 'Remover tag',
  add_comment: 'Comentar',
  notify: 'Notificar',
  send_email: 'Enviar e-mail',
  set_due_in_days: 'Definir prazo (em dias)',
  move_to_active_sprint: 'Mover para a sprint ativa',
  move_to_sprint: 'Mover para a sprint',
  assign: 'Atribuir a',
};

// Gatilhos sem tarefa: as ações de tarefa valem para cada tarefa aberta da sprint;
// em "projeto criado" só fazem sentido avisos.
export const SPRINT_TRIGGERS = ['sprint_started', 'sprint_completed'];
export const MESSAGE_ACTIONS = ['notify', 'send_email'];
