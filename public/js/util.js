// Helpers de DOM, datas, formatação, markdown e ícones.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const tilde = (p) => String(p || '').replace(/^\/Users\/[^/]+/, '~');

export const STATUSES = ['todo', 'doing', 'blocked', 'done'];
export const STATUS_LABEL = { todo: 'A fazer', doing: 'Em andamento', blocked: 'Bloqueada', done: 'Concluída' };
export const COLUMN_LABEL = { todo: 'A fazer', doing: 'Em andamento', blocked: 'Bloqueadas', done: 'Concluídas' };
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
export const PRIORITY_LABEL = { urgent: 'Urgente', high: 'Alta', medium: 'Média', low: 'Baixa' };
export const PRIORITY_ORDER = { urgent: 0, high: 1, medium: 2, low: 3 };
export const TYPES = ['task', 'bug', 'story', 'epic'];
export const TYPE_LABEL = { task: 'Tarefa', bug: 'Bug', story: 'História', epic: 'Épico' };
export const FREQ_LABEL = { daily: 'Diária', weekly: 'Semanal', monthly: 'Mensal', yearly: 'Anual' };

// ---------- cores ----------

export function color(name = '') {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `hsl(${h} 58% 56%)`;
}

export const projectColor = (p) => p?.color || p?.project_color || color(p?.name || p?.project_name || '');

// ---------- datas (AAAA-MM-DD, fuso local) ----------

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export const MONTHS_LONG = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

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
  return `${d} ${MONTHS[m - 1]}${showYear ? ` ${y}` : ''}`;
}

const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
export const dtf = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium', timeStyle: 'short' });

export function ago(iso) {
  if (!iso) return '';
  const s = (new Date(iso) - Date.now()) / 1000;
  for (const [unit, n] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= n) return rtf.format(Math.round(s / n), unit);
  }
  return 'agora';
}

// Rótulo e classe do prazo: overdue / today / soon / ''.
export function dueInfo(t, today) {
  if (!t.due_date) return null;
  const diff = daysBetween(today, t.due_date);
  const done = t.status === 'done';
  const text = diff === 0 ? 'Hoje' : diff === 1 ? 'Amanhã' : diff === -1 ? 'Ontem' : fmtDate(t.due_date);
  const cls = done ? '' : diff < 0 ? 'overdue' : diff === 0 ? 'today' : diff <= 2 ? 'soon' : '';
  const title = done ? `Prazo ${fmtDate(t.due_date, { year: true })}` : diff < 0 ? `Atrasada há ${-diff} dia(s)` : diff === 0 ? 'Vence hoje' : `Vence em ${diff} dia(s)`;
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

export function describeRecurrence(r) {
  if (!r) return '';
  const unit = { daily: ['dia', 'dias'], weekly: ['semana', 'semanas'], monthly: ['mês', 'meses'], yearly: ['ano', 'anos'] }[r.freq];
  const base = r.interval > 1 ? `A cada ${r.interval} ${unit[1]}` : FREQ_LABEL[r.freq];
  return r.until ? `${base} até ${fmtDate(r.until)}` : base;
}

// ---------- markdown mínimo ----------
// Parágrafos, listas, títulos, `código`, **negrito**, [links](url) e ![imagens](url).

export function md(src) {
  const safeUrl = (u) => (/^(https?:|\/api\/attachments\/)/.test(u) ? u : '#');
  const inline = (s) => s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => `<img src="${safeUrl(url)}" alt="${alt}" loading="lazy">`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => `<a href="${safeUrl(url)}" target="_blank" rel="noopener">${text}</a>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  let html = '';
  let para = [];
  let inList = false;
  const flush = () => {
    if (para.length) html += `<p>${para.map(inline).join('<br>')}</p>`;
    para = [];
  };
  for (const line of esc(src).split('\n')) {
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*)/);
    const head = line.match(/^#{1,4}\s+(.*)/);
    if (item) {
      flush();
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(item[1].replace(/^\[( |x)\]\s*/i, (_, x) => (x.trim() ? '☑ ' : '☐ ')))}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (head) { flush(); html += `<h4>${inline(head[1])}</h4>`; }
    else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();
  if (inList) html += '</ul>';
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
  const title = `Prioridade ${PRIORITY_LABEL[priority].toLowerCase()}`;
  if (priority === 'urgent') {
    return `<span class="prio urgent" title="${title}"><svg viewBox="0 0 14 14"><rect x="1" y="1" width="12" height="12" rx="3"/><path d="M7 4v3.8M7 10v.1"/></svg></span>`;
  }
  const n = { low: 1, medium: 2, high: 3 }[priority];
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
  const initials = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  return `<span class="avatar" style="--c:${user.color || color(user.name)};--s:${size}px" title="${esc(user.name)}">${esc(initials)}</span>`;
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
