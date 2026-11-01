// Helpers de DOM, datas, formatação, markdown e ícones.
import { lang, locale, t, tn } from './i18n.js';

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

// Rótulos traduzidos na hora do uso: L.status.todo etc. (getters chamam t()).
const labels = (map) => new Proxy(map, { get: (m, k) => (k in m ? t(m[k]) : undefined) });

export const STATUSES = ['todo', 'doing', 'blocked', 'done'];
export const STATUS_LABEL = labels({ todo: 'A fazer', doing: 'Em andamento', blocked: 'Bloqueada', done: 'Concluída' });
// Nomes das colunas padrão (os mesmos que o servidor dá às colunas de um projeto sem colunas próprias).
const COLUMN_NAMES = /* i18n */ { todo: 'A fazer', doing: 'Em andamento', blocked: 'Bloqueadas', done: 'Concluídas' };
export const COLUMN_LABEL = labels(COLUMN_NAMES);
// Coluna com o nome padrão (vindo do servidor em português) aparece traduzida; nome próprio fica como está.
export const columnLabel = (name, status) => (!name || name === COLUMN_NAMES[status] ? COLUMN_LABEL[status] ?? name : name);
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'lowest'];
export const PRIORITY_LABEL = labels({ urgent: 'Urgente', high: 'Alta', medium: 'Média', low: 'Baixa', lowest: 'Mínima' });
export const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3, lowest: 4 };
export const TYPES = ['task', 'bug', 'story', 'epic'];
export const TYPE_LABEL = labels({ task: 'Tarefa', bug: 'Bug', story: 'História', epic: 'Épico' });
export const FREQS = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
export const FREQ_LABEL = labels({ daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal', quarterly: 'Trimestral', yearly: 'Anual' });
export const DEPENDENCY_TYPES = ['finish_start', 'start_start', 'finish_finish', 'start_finish'];
export const DEPENDENCY_LABEL = labels({
  finish_start: 'Termina → começa',
  start_start: 'Começa → começa',
  finish_finish: 'Termina → termina',
  start_finish: 'Começa → termina',
});
export const DEPENDENCY_HINT = labels({
  finish_start: 'Esta só começa quando a outra terminar',
  start_start: 'Esta só começa quando a outra começar',
  finish_finish: 'Esta só termina quando a outra terminar',
  start_finish: 'Esta só termina quando a outra começar',
});
export const ROLES = ['owner', 'manager', 'member', 'viewer'];
export const ROLE_LABEL = labels({ owner: 'Dono', manager: 'Gerente', member: 'Membro', viewer: 'Visualizador' });
export const USER_ROLE_LABEL = labels({ admin: 'Administrador', member: 'Membro', viewer: 'Visualizador' });
export const PROJECT_STATUSES = ['planning', 'active', 'on_hold', 'completed', 'cancelled'];
export const PROJECT_STATUS_LABEL = labels({ planning: 'Planejamento', active: 'Ativo', on_hold: 'Em espera', completed: 'Concluído', cancelled: 'Cancelado' });
export const VISIBILITIES = ['private', 'internal', 'public'];
export const VISIBILITY_LABEL = labels({ private: 'Privado', internal: 'Interno', public: 'Público' });
export const VISIBILITY_HINT = labels({
  private: 'Só os membros do projeto veem',
  internal: 'Todas as contas do quadro veem',
  public: 'Todos do quadro veem, e dá para gerar um link público de leitura',
});
export const FIELD_TYPES = ['text', 'number', 'date', 'boolean', 'select', 'multi_select', 'user', 'url'];
export const FIELD_TYPE_LABEL = labels({
  text: 'Texto', number: 'Número', date: 'Data', boolean: 'Sim/não', select: 'Lista', multi_select: 'Lista (várias)', user: 'Pessoa', url: 'Link',
});
export const SPRINT_STATUS_LABEL = labels({ planning: 'Planejada', active: 'Ativa', completed: 'Concluída', cancelled: 'Cancelada' });

// Referência curta da tarefa: chave do projeto (WEB-12) ou #id.
export const taskRef = (task) => task?.ref || `#${task?.id}`;

// ---------- cores ----------

export function color(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 58% 56%)`;
}

export const projectColor = (p) => p?.color || p?.project_color || color(p?.name || p?.project_name || '');

// ---------- datas (AAAA-MM-DD, fuso local) ----------

// Nomes de meses e dias no idioma atual (recalculados quando o idioma muda).
const cache = {};
function names(kind) {
  const key = `${kind}:${locale()}`;
  if (!cache[key]) {
    const fmt = {
      month: new Intl.DateTimeFormat(locale(), { month: 'short' }),
      monthLong: new Intl.DateTimeFormat(locale(), { month: 'long' }),
      weekday: new Intl.DateTimeFormat(locale(), { weekday: 'short' }),
    }[kind];
    cache[key] = kind === 'weekday'
      ? Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 7 + i)).replace('.', ''))
      : Array.from({ length: 12 }, (_, i) => fmt.format(new Date(2024, i, 15)).replace('.', ''));
  }
  return cache[key];
}
export const monthNames = () => names('month');
export const monthNamesLong = () => names('monthLong');
export const weekdayNames = () => names('weekday');

export function localDate(d = new Date()) {
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
export const toDate = (s) => new Date(`${s}T12:00:00`);
export const addDays = (s, n) => { const d = toDate(s); d.setDate(d.getDate() + n); return localDate(d); };
export const daysBetween = (a, b) => Math.round((toDate(b) - toDate(a)) / 86400000);

export function fmtDate(s, { year } = {}) {
  if (!s) return '';
  const [y, m, d] = s.split('-').map(Number);
  const showYear = year ?? y !== new Date().getFullYear();
  return `${d} ${monthNames()[m - 1]}${showYear ? ` ${y}` : ''}`;
}

export const dtf = { format: (d) => new Intl.DateTimeFormat(locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(d) };

export function ago(iso) {
  if (!iso) return '';
  const rtf = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
  const s = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  }
  return t('agora');
}

export const fmtNumber = (n, opts) => new Intl.NumberFormat(locale(), opts).format(n ?? 0);

// Rótulo e classe do prazo: overdue / today / soon / ''.
export function dueInfo(task, today) {
  if (!task.due_date) return null;
  const diff = daysBetween(today, task.due_date);
  const done = task.status === 'done';
  const text = diff === 0 ? t('Hoje') : diff === 1 ? t('Amanhã') : diff === -1 ? t('Ontem') : fmtDate(task.due_date);
  const cls = done ? '' : diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 2 ? 'soon' : '';
  const title = done ? t('Prazo {d}', { d: fmtDate(task.due_date, { year: true }) })
    : diff < 0 ? tn(-diff, 'Atrasada há {n} dia', 'Atrasada há {n} dias') : diff === 0 ? t('Vence hoje') : tn(diff, 'Vence em {n} dia', 'Vence em {n} dias');
  return { text, cls, title };
}

// ---------- duração ----------

export function fmtDuration(min) {
  min = Math.round(min || 0);
  if (!min) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h${m}m` : `${h}h`) : `${m}m`;
}

export function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s).padStart(2, '0')}`;
}

// "A cada 2 semanas (seg, qua), 1 de 5 até 3 nov": cada parte é uma frase própria com marcadores.
const EVERY = /* i18n */ {
  daily: 'A cada {n} dias', weekly: 'A cada {n} semanas', monthly: 'A cada {n} meses', quarterly: 'A cada {n} trimestres', yearly: 'A cada {n} anos',
};
export function describeRecurrence(r) {
  if (!r) return '';
  let base = r.interval > 1 && EVERY[r.freq] ? t(EVERY[r.freq], { n: r.interval }) : FREQ_LABEL[r.freq];
  if (r.weekdays?.length) base += ` (${r.weekdays.map((d) => weekdayNames()[d]).join(', ')})`;
  if (r.monthday) base += r.monthday === 'last' ? ` (${t('último dia')})` : ` (${t('dia {n}', { n: r.monthday })})`;
  if (r.count) base += `, ${t('{n} de {total}', { n: r.n || 1, total: r.count })}`;
  return r.until ? t('{base} até {d}', { base, d: fmtDate(r.until) }) : base;
}

// Texto de um evento do histórico. O servidor grava o evento já em português (src/db.js logEvent);
// aqui os formatos conhecidos são remontados no idioma atual, e o resto aparece como veio.
const SERVER_STATUS = { 'a fazer': 'todo', 'em andamento': 'doing', bloqueada: 'blocked', 'concluída': 'done' };
const SERVER_PRIORITY = { 'mínima': 'lowest', baixa: 'low', 'média': 'medium', alta: 'high', urgente: 'urgent' };
const EVENT_FIXED = /* i18n */ ['prazo removido', 'removida da sprint', 'arquivada', 'desarquivada', 'relator removido', 'recorrência encerrada'];
export function eventText(body) {
  const s = String(body ?? '');
  if (lang() === 'pt') return s;
  if (EVENT_FIXED.includes(s)) return t(s);
  let m = s.match(/^(.+) → (.+)$/);
  if (m && SERVER_STATUS[m[1]] && SERVER_STATUS[m[2]]) return `${STATUS_LABEL[SERVER_STATUS[m[1]]]} → ${STATUS_LABEL[SERVER_STATUS[m[2]]]}`;
  m = s.match(/^prioridade (.+) → (.+)$/);
  if (m && SERVER_PRIORITY[m[1]] && SERVER_PRIORITY[m[2]]) {
    return t('prioridade {from} → {to}', { from: PRIORITY_LABEL[SERVER_PRIORITY[m[1]]].toLowerCase(), to: PRIORITY_LABEL[SERVER_PRIORITY[m[2]]].toLowerCase() });
  }
  if ((m = s.match(/^prazo definido para (\d{4}-\d{2}-\d{2})$/))) return t('prazo definido para {d}', { d: fmtDate(m[1], { year: true }) });
  if ((m = s.match(/^movida de (.+) para (.+)$/))) return t('movida de {from} para {to}', { from: m[1], to: m[2] });
  if ((m = s.match(/^sprint: (.+)$/))) return t('sprint: {name}', { name: m[1] });
  if ((m = s.match(/^relator: (.+)$/))) return t('relator: {name}', { name: m[1] });
  if ((m = s.match(/^recorrência encerrada \((\d+) ocorrências\)$/))) return tn(Number(m[1]), 'recorrência encerrada ({n} ocorrência)', 'recorrência encerrada ({n} ocorrências)');
  if ((m = s.match(/^próxima ocorrência: #(\d+) com prazo (\d{4}-\d{2}-\d{2})$/))) return t('próxima ocorrência: #{id} com prazo {d}', { id: m[1], d: fmtDate(m[2], { year: true }) });
  if ((m = s.match(/^criada pela recorrência de #(\d+)$/))) return t('criada pela recorrência de #{id}', { id: m[1] });
  if ((m = s.match(/^automação “(.+)”$/))) return t('automação “{name}”', { name: m[1] });
  return s;
}

// Texto de uma notificação. Como os eventos, o servidor grava o aviso em português (src/engine.js);
// os formatos conhecidos são remontados no idioma atual, e os demais (mensagens de automações e do Claude) ficam como vieram.
const serverActor = (name) => (name === 'Alguém' ? t('Alguém') : name === 'Uma automação' ? t('Uma automação') : name);
const dayMonth = (dd, mm) => fmtDate(`${new Date().getFullYear()}-${mm}-${dd}`);
export function notificationText(body) {
  const s = String(body ?? '');
  if (lang() === 'pt') return s;
  let m;
  if ((m = s.match(/^(.+?) mudou #(\d+) para "(.+?)": (.*)$/s)) && SERVER_STATUS[m[3]]) {
    return t('{who} mudou #{id} para “{status}”: {title}', { who: serverActor(m[1]), id: m[2], status: STATUS_LABEL[SERVER_STATUS[m[3]]], title: m[4] });
  }
  if ((m = s.match(/^(.+?) mencionou você em #(\d+): (.*)$/s))) return t('{who} mencionou você em #{id}: {text}', { who: serverActor(m[1]), id: m[2], text: m[3] });
  if ((m = s.match(/^(.+?) comentou em #(\d+): (.*)$/s))) return t('{who} comentou em #{id}: {text}', { who: serverActor(m[1]), id: m[2], text: m[3] });
  if ((m = s.match(/^(.+?) atribuiu #(\d+) a você: (.*)$/s))) return t('{who} atribuiu #{id} a você: {title}', { who: serverActor(m[1]), id: m[2], title: m[3] });
  if ((m = s.match(/^Atrasada: #(\d+) (.*) \(prazo (\d{2})\/(\d{2})\)$/s))) return t('Atrasada: #{id} {title} (prazo {d})', { id: m[1], title: m[2], d: dayMonth(m[3], m[4]) });
  if ((m = s.match(/^Vence hoje: #(\d+) (.*)$/s))) return t('Vence hoje: #{id} {title}', { id: m[1], title: m[2] });
  if ((m = s.match(/^Vence amanhã: #(\d+) (.*)$/s))) return t('Vence amanhã: #{id} {title}', { id: m[1], title: m[2] });
  if ((m = s.match(/^Vence em (\d{2})\/(\d{2}): #(\d+) (.*)$/s))) return t('Vence em {d}: #{id} {title}', { d: dayMonth(m[1], m[2]), id: m[3], title: m[4] });
  return s;
}

// ---------- markdown ----------
// Títulos, parágrafos, listas (com caixas ☐/☑), citações, blocos de código, `código`,
// **negrito**, *itálico*, ~~riscado~~, [links](url), ![imagens](url), @menções e linhas ---.

const safeUrl = (u) => (/^(https?:|mailto:|\/api\/attachments\/|\/api\/public\/)/.test(u) ? u : '#');

function inline(s, { mentions = [] } = {}) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img src="${safeUrl(url)}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${text}</a>`)
    .replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)])/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~([^~]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])@([\p{L}\p{N}._-]+(?:\s[\p{Lu}][\p{L}]+)?)/gu, (m, pre, name) => {
      const hit = mentions.find((n) => name.toLowerCase().startsWith(n.toLowerCase().split(' ')[0]));
      return hit ? `${pre}<span class="mention">@${name}</span>` : m;
    });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function md(src, opts = {}) {
  let html = '';
  let para = [];
  let list = null;
  let quote = [];
  let code = null;
  const flush = () => {
    if (para.length) html += `<p>${para.map((l) => inline(l, opts)).join('<br>')}</p>`;
    para = [];
  };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  const closeQuote = () => {
    if (quote.length) html += `<blockquote>${quote.map((l) => inline(l, opts)).join('<br>')}</blockquote>`;
    quote = [];
  };
  for (const line of esc(src).split('\n')) {
    if (code !== null) {
      if (/^```/.test(line)) { html += `<pre><code>${code.join('\n')}</code></pre>`; code = null; } else code.push(line);
      continue;
    }
    if (/^```/.test(line)) { flush(); closeList(); closeQuote(); code = []; continue; }
    const q = line.match(/^&gt;\s?(.*)/);
    if (q) { flush(); closeList(); quote.push(q[1]); continue; }
    closeQuote();
    const bullet = line.match(/^\s*[-*+]\s+(.*)/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (bullet || num) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      if (list !== kind) { closeList(); html += `<${kind}>`; list = kind; }
      const text = (bullet || num)[1].replace(/^\[( |x)\]\s*/i, (_, x) => `<span class="md-check ${x.trim() ? 'on' : ''}">${x.trim() ? '☑' : '☐'}</span> `);
      html += `<li>${inline(text, opts)}</li>`;
      continue;
    }
    closeList();
    const head = line.match(/^(#{1,4})\s+(.*)/);
    if (head) { flush(); html += `<h4>${inline(head[2], opts)}</h4>`; } else if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); html += '<hr>'; } else if (!line.trim()) flush();
    else para.push(line);
  }
  if (code !== null) html += `<pre><code>${code.join('\n')}</code></pre>`;
  flush();
  closeList();
  closeQuote();
  return html;
}

// ---------- ícones ----------

const svg = (body, vb = 16) => `<svg viewBox="0 0 ${vb} ${vb}" aria-hidden="true">${body}</svg>`;

export const ICON = {
  plus: svg('<path d="M8 3v10M3 8h10"/>'),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>'),
  claude: svg('<path d="M8 1.8v12.4M1.8 8h12.4M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8"/>'),
  comment: svg('<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5V3a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5"/>'),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>'),
  dot: svg('<circle cx="8" cy="8" r="2" fill="currentColor" stroke="none"/>'),
  calendar: svg('<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>'),
  clock: svg('<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>'),
  play: svg('<path d="M5 3.5v9l7-4.5z" fill="currentColor"/>'),
  stop: svg('<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>'),
  clip: svg('<path d="M13 7.5l-5.3 5.3a3.2 3.2 0 0 1-4.5-4.5L8.9 2.6a2.1 2.1 0 0 1 3 3L6.3 11.2a1.1 1.1 0 0 1-1.5-1.5l5-5"/>'),
  link: svg('<path d="M6.5 9.5l3-3M7 4.5l1-1a2.8 2.8 0 0 1 4 4l-1 1M9 11.5l-1 1a2.8 2.8 0 0 1-4-4l1-1"/>'),
  archive: svg('<rect x="2" y="3" width="12" height="3" rx="1"/><path d="M3 6v6.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V6M6.5 9h3"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.5"/>'),
  left: svg('<path d="M10 3.5L5.5 8l4.5 4.5"/>'),
  right: svg('<path d="M6 3.5L10.5 8 6 12.5"/>'),
  down: svg('<path d="M4 6l4 4 4-4"/>'),
  board: svg('<rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/>'),
  list: svg('<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><circle cx="2.8" cy="4" r=".6" fill="currentColor"/><circle cx="2.8" cy="8" r=".6" fill="currentColor"/><circle cx="2.8" cy="12" r=".6" fill="currentColor"/>'),
  gantt: svg('<path d="M2 3v10.5h12"/><rect x="4" y="4" width="5" height="2" rx="1"/><rect x="6.5" y="7.5" width="6" height="2" rx="1"/><rect x="5" y="11" width="3.5" height="1" rx=".5"/>'),
  dashboard: svg('<rect x="2" y="2" width="5" height="6.5" rx="1.2"/><rect x="9" y="2" width="5" height="4" rx="1.2"/><rect x="2" y="10.5" width="5" height="3.5" rx="1.2"/><rect x="9" y="8" width="5" height="6" rx="1.2"/>'),
  grid: svg('<rect x="2" y="2" width="5" height="5" rx="1.2"/><rect x="9" y="2" width="5" height="5" rx="1.2"/><rect x="2" y="9" width="5" height="5" rx="1.2"/><rect x="9" y="9" width="5" height="5" rx="1.2"/>'),
  bell: svg('<path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1H3zM6.5 13.5a1.5 1.5 0 0 0 3 0"/>'),
  sparkles: svg('<path d="M6.5 2l1.2 3.3L11 6.5 7.7 7.7 6.5 11 5.3 7.7 2 6.5l3.3-1.2zM12 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>'),
  filter: svg('<path d="M2.5 3.5h11l-4.2 5v4l-2.6 1v-5z"/>'),
  users: svg('<circle cx="6" cy="5.5" r="2.3"/><path d="M1.8 13c.4-2.2 2.1-3.5 4.2-3.5s3.8 1.3 4.2 3.5"/><path d="M10.5 3.4a2.3 2.3 0 0 1 0 4.3M12 9.7c1.2.5 2 1.6 2.2 3.3"/>'),
  zap: svg('<path d="M9 1.8L3.5 9H8l-1 5.2L12.5 7H8z"/>'),
  gear: svg('<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6"/>'),
  logout: svg('<path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3M10.5 11l3-3-3-3M13.5 8h-7"/>'),
  repeat: svg('<path d="M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2"/>'),
  subtask: svg('<path d="M4 2.5v8a1.5 1.5 0 0 0 1.5 1.5h3M4 6.5h4.5"/><rect x="9" y="4.5" width="4.5" height="4" rx="1"/><rect x="9" y="10" width="4.5" height="4" rx="1"/>'),
  target: svg('<circle cx="8" cy="8" r="5.8"/><circle cx="8" cy="8" r="3"/><circle cx="8" cy="8" r=".6" fill="currentColor"/>'),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
  more: svg('<circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none"/>'),
  upload: svg('<path d="M8 10.5V2.5M5 5.5l3-3 3 3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>'),
  send: svg('<path d="M2.5 8L13.5 2.5 10 13.5 7.5 9z M7.5 9l6-6.5"/>'),
  lock: svg('<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>'),
  menu: svg('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
  folder: svg('<path d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>'),
  user: svg('<circle cx="8" cy="5.5" r="2.8"/><path d="M2.8 14c.5-2.8 2.6-4.3 5.2-4.3s4.7 1.5 5.2 4.3"/>'),
  blocked: svg('<circle cx="8" cy="8" r="5.6"/><path d="M4.1 11.9l7.8-7.8"/>'),
  up: svg('<path d="M8 13V3M4 7l4-4 4 4"/>'),
  edit: svg('<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/>'),
  building: svg('<rect x="3" y="2" width="10" height="12" rx="1"/><path d="M6 5h1M9 5h1M6 8h1M9 8h1M7 14v-3h2v3"/>'),
  layers: svg('<path d="M8 2l6 3-6 3-6-3z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/>'),
  share: svg('<circle cx="4" cy="8" r="1.8"/><circle cx="12" cy="4" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M5.6 7.1l4.8-2.3M5.6 8.9l4.8 2.3"/>'),
  history: svg('<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.6h2.6"/><path d="M8 5v3.2l2 1.3"/>'),
  shield: svg('<path d="M8 1.8l5 2v4.1c0 3-2.1 5.3-5 6.3-2.9-1-5-3.3-5-6.3V3.8z"/>'),
  mail: svg('<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2.5 4.5L8 9l5.5-4.5"/>'),
  download: svg('<path d="M8 2.5v8M5 7.5l3 3 3-3M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2"/>'),
  eye: svg('<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  at: svg('<circle cx="8" cy="8" r="2.6"/><path d="M10.6 8v1a1.9 1.9 0 0 0 3.8 0V8A6.4 6.4 0 1 0 11 13.6"/>'),
  tag: svg('<path d="M2.5 2.5h5.3l5.7 5.7-5.3 5.3-5.7-5.7z"/><circle cx="5.3" cy="5.3" r=".9" fill="currentColor"/>'),
  sliders: svg('<path d="M3 4h6M12 4h1M3 8h1M7 8h6M3 12h7M13 12h0"/><circle cx="10.5" cy="4" r="1.5"/><circle cx="5.5" cy="8" r="1.5"/><circle cx="11.5" cy="12" r="1.5"/>'),
  globe: svg('<circle cx="8" cy="8" r="5.8"/><path d="M2.2 8h11.6M8 2.2c1.6 1.6 2.4 3.5 2.4 5.8S9.6 12.2 8 13.8C6.4 12.2 5.6 10.3 5.6 8S6.4 3.8 8 2.2z"/>'),
  reply: svg('<path d="M6.5 4L2.5 8l4 4M2.5 8h7a4 4 0 0 1 4 4v.5"/>'),
  points: svg('<path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z"/>'),
  key: svg('<circle cx="5.5" cy="10.5" r="3"/><path d="M7.7 8.3L13.5 2.5M11.5 4.5l1.5 1.5M10 6l1.2 1.2"/>'),
  inbox: svg('<path d="M2 9.5l1.8-6h8.4L14 9.5v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/><path d="M2 9.5h3.5l1 1.5h3l1-1.5H14"/>'),
  command: svg('<path d="M5.5 5.5h5v5h-5zM5.5 5.5V4a1.5 1.5 0 1 0-1.5 1.5zM10.5 5.5H12A1.5 1.5 0 1 0 10.5 4zM10.5 10.5V12a1.5 1.5 0 1 0 1.5-1.5zM5.5 10.5H4A1.5 1.5 0 1 0 5.5 12z"/>'),
  bold: svg('<path d="M4.5 3h4a2.5 2.5 0 0 1 0 5h-4zM4.5 8h4.8a2.5 2.5 0 0 1 0 5H4.5z"/>'),
  italic: svg('<path d="M7 3h5M4 13h5M9.5 3l-3 10"/>'),
  code: svg('<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>'),
  checklist: svg('<rect x="2" y="2.5" width="4" height="4" rx="1"/><path d="M2.8 11.2l1.2 1.2 2-2.4M8.5 4.5h5.5M8.5 11.5h5.5"/>'),
  quote: svg('<path d="M3 4v8M6 5.5h7M6 8h7M6 10.5h5"/>'),
};

export function statusIcon(status) {
  const body = {
    todo: '<circle cx="7" cy="7" r="5.4" stroke-dasharray="2.4 1.8"/>',
    doing: '<circle cx="7" cy="7" r="5.4"/><path d="M7 3.6a3.4 3.4 0 0 1 0 6.8z" fill="currentColor" stroke="none"/>',
    blocked: '<circle cx="7" cy="7" r="5.4"/><path d="M4.9 9.1l4.2-4.2"/>',
    done: '<circle cx="7" cy="7" r="6" fill="currentColor" stroke="none"/><path d="M4.5 7.2l1.7 1.7 3.3-3.5" stroke="var(--panel)" stroke-width="1.7"/>',
  }[status];
  return `<svg class="status-icon ${status}" viewBox="0 0 14 14" aria-hidden="true">${body}</svg>`;
}

export function prioIcon(priority) {
  const title = t('Prioridade {p}', { p: PRIORITY_LABEL[priority].toLowerCase() });
  if (priority === 'urgent') {
    return `<span class="prio urgent" title="${title}"><svg viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="3"/><path d="M7 4v3.8M7 10v.1"/></svg></span>`;
  }
  const n = { lowest: 0, low: 1, medium: 2, high: 3 }[priority];
  const bar = (i, x, y, h) => `<rect class="${n >= i ? 'on' : ''}" x="${x}" y="${y}" width="2.6" height="${h}" rx="1"/>`;
  return `<span class="prio ${priority}" title="${title}"><svg viewBox="0 0 14 14">${bar(1, 1.5, 8, 4.5)}${bar(2, 5.7, 5, 7.5)}${bar(3, 9.9, 2, 10.5)}</svg></span>`;
}

export function typeIcon(type, { always = false } = {}) {
  if (type === 'task' && !always) return '';
  const body = {
    task: '<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="M5.3 8.2l1.8 1.8 3.6-3.8"/>',
    bug: '<ellipse cx="8" cy="9" rx="3.3" ry="4"/><path d="M8 5v8M4.7 9H2.5M13.5 9h-2.2M5.2 6.2L3.5 4.5M10.8 6.2l1.7-1.7M5 12l-1.6 1.6M11 12l1.6 1.6"/>',
    story: '<path d="M4 2.5h8v11l-4-2.8-4 2.8z"/>',
    epic: '<path d="M9 1.8L3.5 9H8l-1 5.2L12.5 7H8z"/>',
  }[type];
  return `<span class="type-icon ${type}" title="${TYPE_LABEL[type]}"><svg viewBox="0 0 16 16">${body}</svg></span>`;
}

export function avatar(user, { size = 20 } = {}) {
  if (!user) return '';
  if (user.avatar) return `<img class="avatar img" src="/api/avatars/${esc(user.avatar)}" alt="" style="--s:${size}px" title="${esc(user.name)}">`;
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar" style="--c:${user.color || color(user.name)};--s:${size}px" title="${esc(user.name)}">${esc(initials)}</span>`;
}

// Selo de projeto/organização: imagem enviada ou bolinha colorida.
export function projectBadge(p, { size = 10 } = {}) {
  if (p?.avatar) return `<img class="badge-img" src="/api/avatars/${esc(p.avatar)}" alt="" style="--s:${Math.max(size, 14)}px">`;
  return `<span class="dot" style="--c:${projectColor(p)}"></span>`;
}

export const fmtPoints = (n) => (n == null ? '' : tn(n, '{n} ponto', '{n} pontos', { n: fmtNumber(n) }));

// Tema: "system" segue o sistema operacional; light/dark fixam.
export function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
