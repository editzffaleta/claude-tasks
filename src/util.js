// Validação, datas e rótulos compartilhados pelo banco, MCP, servidor e motor de automações.

export const STATUSES = ['todo', 'doing', 'blocked', 'done'];
export const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
export const TYPES = ['task', 'bug', 'story', 'epic'];
export const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
export const SPRINT_STATUSES = ['planning', 'active', 'completed'];

export const STATUS_LABEL = { todo: 'a fazer', doing: 'em andamento', blocked: 'bloqueada', done: 'concluída' };
export const COLUMN_NAME = { todo: 'A fazer', doing: 'Em andamento', blocked: 'Bloqueadas', done: 'Concluídas' };
export const PRIORITY_LABEL = { low: 'baixa', medium: 'média', high: 'alta', urgent: 'urgente' };
export const TYPE_LABEL = { task: 'tarefa', bug: 'bug', story: 'história', epic: 'épico' };
export const FREQ_LABEL = { daily: 'diária', weekly: 'semanal', monthly: 'mensal', yearly: 'anual' };

export class ValidationError extends Error {
  status = 400;
}

export const fail = (msg) => { throw new ValidationError(msg); };

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

// ---- recorrência ----

export function cleanRecurrence(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === false || value === 'none') return null;
  let r = value;
  if (typeof r === 'string') {
    try { r = FREQS.includes(r) ? { freq: r } : JSON.parse(r); } catch { fail('Recorrência inválida'); }
  }
  if (!FREQS.includes(r?.freq)) fail(`"recurrence.freq" deve ser um de: ${FREQS.join(', ')}`);
  const interval = Math.max(1, Math.min(365, Math.round(Number(r.interval) || 1)));
  const until = r.until ? cleanDate(r.until, 'recurrence.until') : null;
  return JSON.stringify(until ? { freq: r.freq, interval, until } : { freq: r.freq, interval });
}

export function nextOccurrence(date, { freq, interval = 1 }) {
  if (freq === 'daily') return addDays(date, interval);
  if (freq === 'weekly') return addDays(date, 7 * interval);
  const [y, m, d] = date.split('-').map(Number);
  const months = freq === 'monthly' ? interval : 12 * interval;
  const target = new Date(y, m - 1 + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  return localDate(target);
}

export function describeRecurrence(json) {
  if (!json) return '';
  const r = typeof json === 'string' ? JSON.parse(json) : json;
  const unit = { daily: ['dia', 'dias'], weekly: ['semana', 'semanas'], monthly: ['mês', 'meses'], yearly: ['ano', 'anos'] }[r.freq];
  const base = r.interval > 1 ? `a cada ${r.interval} ${unit[1]}` : FREQ_LABEL[r.freq];
  return r.until ? `${base} até ${r.until}` : base;
}

// ---- automações ----

export const TRIGGERS = {
  task_created: 'Tarefa criada',
  status_changed: 'Status mudou',
  priority_changed: 'Prioridade mudou',
  comment_added: 'Comentário adicionado',
  assigned: 'Responsável adicionado',
  due_soon: 'Prazo chegando',
  overdue: 'Prazo vencido',
};

export const ACTIONS = {
  set_status: 'Mudar status',
  set_priority: 'Mudar prioridade',
  add_tag: 'Adicionar tag',
  remove_tag: 'Remover tag',
  add_comment: 'Comentar',
  notify: 'Notificar',
  set_due_in_days: 'Definir prazo (em dias)',
  move_to_active_sprint: 'Mover para a sprint ativa',
  assign: 'Atribuir a',
};
