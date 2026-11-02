// Dashboard: indicadores, tendências por semana, distribuição, portfólio, equipe, sprint, prazos e atividade.
// Gráficos feitos à mão (HTML/CSS e SVG inline), um eixo só. Cores: --series-1/2 para identidade,
// rampa azul ordinal para prioridade, rampa sequencial na alocação; status sempre com ícone + rótulo.
import { api } from './api.js';
import { openTask } from './drawer.js';
import { t, tn } from './i18n.js';
import { navigate, state, userById } from './state.js';
import {
  $, ICON, PRIORITIES, PRIORITY_LABEL, PROJECT_STATUS_LABEL, STATUS_LABEL, TYPES, TYPE_LABEL,
  ago, avatar, columnLabel, daysBetween, dueInfo, esc, eventText, fmtDate, fmtDuration, fmtNumber, prioIcon, projectBadge, statusIcon, taskRef, typeIcon,
} from './util.js';

// Estado do módulo: sobrevive às atualizações ao vivo (dados, tabelas abertas, medida da carga).
let stats = null;
let loadedFor = null;
let seq = 0;
let workloadBy = 'tasks';
const openTables = new Set();
const tips = new Map(); // id → { title, rows } (tooltips da renderização atual)
const lines = new Map(); // id → gráfico de linha (crosshair)

// ---------- formatação ----------

const num = (n) => fmtNumber(n, Math.abs(n) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 1 });
const pct = (x) => fmtNumber(x || 0, { style: 'percent', maximumFractionDigits: 0 });
const empty = (msg) => `<div class="empty-small">${msg}</div>`;

// Escala "redonda" para eixos de contagem: topo e marcas inteiras (0, 2, 4… / 0, 10, 20…).
function scale(max, count = 4) {
  const raw = Math.max(max, 1) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * p).find((m) => m >= raw));
  const top = Math.max(step, Math.ceil(max / step) * step);
  return { top, ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step) };
}

// Tooltip estruturado (valor em destaque, rótulo depois); o texto entra via textContent ao exibir.
function tipAttr(title, rows = []) {
  const id = `t${tips.size + 1}`;
  tips.set(id, { title, rows });
  return `data-tipid="${id}"`;
}

const card = (title, body, { icon = '', span = false, extra = '' } = {}) => `
  <section class="card-box${span ? ' span-2' : ''}">
    <div class="card-head"><h3>${icon}${title}</h3>${extra}</div>
    ${body}
  </section>`;

// Legenda: retângulo para barras, traço para linhas (espelha a marca). Texto sempre na cor de texto.
const legend = (series) => `
  <div class="legend">${series.map((s) => `<span class="key ${s.key}${s.line ? ' line' : ''}"></span><span>${esc(s.label)}</span>`).join('')}</div>`;

// Tabela equivalente ao gráfico; aberta/fechada fica em openTables entre atualizações.
function tableToggle(key, head, rows) {
  return `
    <details class="table-toggle" data-table="${key}"${openTables.has(key) ? ' open' : ''}>
      <summary>${t('Ver como tabela')}</summary>
      <div class="table-scroll"><table class="mini-table">
        <thead><tr>${head.map((h, i) => `<th${i ? ' class="num"' : ''}>${h}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="num"' : ''}>${c}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
    </details>`;
}

// Marcadores de status ao lado das barras: ícone + número, com o rótulo no title.
const flag = (icon, n, label) => (n ? `<span class="flag" title="${esc(label)}" aria-label="${esc(label)}">${icon}${num(n)}</span>` : '');
const blockedFlag = (n) => flag(statusIcon('blocked'), n, tn(n, '{n} bloqueada', '{n} bloqueadas', { n: num(n) }));
const overdueFlag = (n) => flag(`<span class="od">${ICON.calendar}</span>`, n, tn(n, '{n} atrasada', '{n} atrasadas', { n: num(n) }));
const flagsKey = () => `<div class="legend flags-key">${statusIcon('blocked')}<span>${t('bloqueadas')}</span><span class="od">${ICON.calendar}</span><span>${t('atrasadas')}</span></div>`;

const statusRows = (x) => [
  { value: num(x.open), label: t('abertas') },
  { value: num(x.todo), label: STATUS_LABEL.todo },
  { value: num(x.doing), label: STATUS_LABEL.doing },
  { value: num(x.blocked), label: STATUS_LABEL.blocked },
  { value: num(x.overdue), label: t('atrasadas') },
];

// ---------- gráficos ----------

function tile(label, value, { tone = '', icon = '', hint = '', go = '' } = {}) {
  return `
    <button class="stat-tile ${tone}" ${go ? `data-go="${go}"` : 'disabled'}>
      <span class="stat-label">${icon}${label}</span>
      <b class="stat-value">${value}</b>
      ${hint ? `<span class="stat-hint">${hint}</span>` : ''}
    </button>`;
}

// Barras horizontais de uma série: rótulo, barra proporcional com o valor na ponta e marcadores opcionais.
// A área da barra reserva --lab à direita para o valor, então as larguras ficam proporcionais entre linhas.
function hbars(items, { format = num, emptyMsg = t('Sem dados'), lab = '2.6em' } = {}) {
  if (!items.some((i) => i.value)) return empty(emptyMsg);
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="hb" style="--lab:${lab}">${items.map((i) => {
    const w = (i.value / max) * 100;
    const tag = i.go ? 'button' : 'div';
    const tip = tipAttr(i.tipTitle ?? i.text, i.tipRows ?? [{ value: format(i.value), label: i.tipLabel || '' }]);
    return `
      <${tag} class="hb-row" ${i.go ? `data-go="${esc(i.go)}"` : ''} ${tip}>
        <span class="hb-label">${i.icon || ''}<span class="name">${esc(i.text)}</span></span>
        <span class="hb-area"><span class="hb-bar ${i.cls || ''}" style="width:${w}%"></span><b class="hb-val" style="left:${w}%">${esc(format(i.value))}</b></span>
        <span class="hb-meta">${i.meta || ''}</span>
      </${tag}>`;
  }).join('')}</div>`;
}

// Colunas agrupadas (2 séries, um eixo). Rótulo direto só no grupo mais recente; o resto vai no tooltip e na tabela.
function columns(groups, series, { tableKey, firstHead, emptyMsg }) {
  const max = Math.max(0, ...groups.flatMap((g) => g.values));
  if (!max) return empty(emptyMsg);
  const { top, ticks } = scale(max);
  const last = groups.length - 1;
  const h = (v) => `${(v / top) * 100}%`;
  return `
    ${legend(series)}
    <div class="cols">
      <div class="cols-grid">${ticks.map((v) => `<div class="cols-line${v ? '' : ' base'}" style="bottom:${h(v)}"><span>${num(v)}</span></div>`).join('')}</div>
      <div class="cols-body${groups.length > 6 ? ' many' : ''}">${groups.map((g, gi) => `
        <div class="cols-group" tabindex="0" ${tipAttr(g.title, g.values.map((v, i) => ({ key: series[i].key, value: num(v), label: series[i].label })))}>
          <div class="cols-bars">${g.values.map((v, i) => `<span class="cb ${series[i].key}" style="height:${h(v)}">${gi === last && v ? `<i class="cap">${num(v)}</i>` : ''}</span>`).join('')}</div>
          <span class="cols-label" title="${esc(g.title)}"><span>${esc(g.label)}</span></span>
        </div>`).join('')}
      </div>
    </div>
    ${tableToggle(tableKey, [esc(firstHead), ...series.map((s) => esc(s.label))], groups.map((g) => [esc(g.title), ...g.values.map(num)]))}`;
}

// Linha (burndown): SVG esticável em viewBox 0–100 com traço que não deforma; pontos e rótulos em HTML.
function lineChart(id, { labels, series, max }) {
  const n = labels.length;
  const { top, ticks } = scale(max);
  const X = (i) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const Y = (v) => 100 - (v / top) * 100;
  const points = (vals) => vals.map((v, i) => (v == null ? '' : `${X(i).toFixed(2)},${Y(v).toFixed(2)}`)).filter(Boolean).join(' ');
  const ends = series.map((s) => {
    const i = s.values.findLastIndex((v) => v != null);
    if (i < 0) return '';
    const pos = `left:${X(i)}%;top:${Y(s.values[i])}%`;
    const side = s.up ? ' up' : X(i) > 70 ? ' left' : '';
    return `${s.dot ? `<span class="lc-dot" style="${pos}"></span>` : ''}<span class="lc-lab${side}" style="${pos}">${esc(s.endLabel(s.values[i]))}</span>`;
  }).join('');
  const xs = [...new Set([0, Math.round((n - 1) / 2), n - 1])];
  const lastValue = Math.max(0, series[0].values.findLastIndex((v) => v != null));
  lines.set(id, { n, X, labels, series, last: lastValue });
  return `
    ${legend(series.map((s) => ({ key: s.key, label: s.label, line: true })))}
    <div class="lc-plot" data-lc="${id}" tabindex="0" aria-label="${esc(t('Gráfico de linha; use as setas para percorrer os dias'))}">
      <div class="cols-grid">${ticks.map((v) => `<div class="cols-line${v ? '' : ' base'}" style="bottom:${(v / top) * 100}%"><span>${num(v)}</span></div>`).join('')}</div>
      <svg class="lc-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        ${series.map((s) => `<polyline class="lc-line ${s.key}" points="${points(s.values)}" vector-effect="non-scaling-stroke"/>`).join('')}
      </svg>
      ${ends}
      <span class="lc-cross" hidden></span>
    </div>
    <div class="lc-x">${xs.map((i) => `<span style="left:${X(i)}%">${esc(labels[i].short)}</span>`).join('')}</div>`;
}

// ---------- cards ----------

function tiles(k) {
  const created = k.claude_7d
    ? t('{c} criadas · {k} pelo Claude', { c: num(k.created_7d), k: num(k.claude_7d) })
    : t('{c} criadas', { c: num(k.created_7d) });
  return `
    <div class="tiles">
      ${tile(t('Abertas'), num(k.open), { icon: ICON.grid, hint: t('de {n} no total', { n: num(k.total) }), go: 'board' })}
      ${tile(t('Em andamento'), num(k.doing), { icon: statusIcon('doing'), go: 'board' })}
      ${tile(t('Bloqueadas'), num(k.blocked), { icon: statusIcon('blocked'), hint: k.blocked ? t('esperando algo') : t('nada bloqueado'), go: 'board' })}
      ${tile(t('Atrasadas'), num(k.overdue), { tone: k.overdue ? 'critical' : '', icon: ICON.calendar, hint: k.overdue ? t('precisam de atenção') : t('nada atrasado'), go: 'filter:due:overdue' })}
      ${tile(t('Vencem em 7 dias'), num(k.due_week), { tone: k.due_week ? 'warning' : '', icon: ICON.bell, go: 'filter:due:week' })}
      ${tile(t('Concluídas · 7 dias'), num(k.done_7d), { icon: ICON.check, hint: created })}
      ${tile(t('Bugs abertos'), num(k.open_bugs), { icon: typeIcon('bug', { always: true }), go: 'filter:type:bug' })}
      ${tile(t('Pontos em aberto'), num(k.open_points), { icon: ICON.points, go: 'board' })}
      ${tile(t('Tempo registrado · 7 dias'), fmtDuration(k.minutes_7d), { icon: ICON.clock })}
    </div>`;
}

const weekGroups = (weeks, a, b) => weeks.map((w, i) => ({
  label: fmtDate(w.week),
  title: i === weeks.length - 1 ? t('Esta semana (desde {d})', { d: fmtDate(w.week) }) : t('Semana de {d}', { d: fmtDate(w.week) }),
  values: [w[a] || 0, w[b] || 0],
}));

function weeklyCard(weeks) {
  const series = [{ key: 's1', label: t('Criadas') }, { key: 's2', label: t('Concluídas') }];
  return card(t('Criadas × concluídas por semana'), columns(weekGroups(weeks, 'created', 'done'), series, {
    tableKey: 'weekly', firstHead: t('Semana'), emptyMsg: t('Nenhuma tarefa criada ou concluída nas últimas semanas.'),
  }), { span: true, extra: `<span class="card-sub">${tn(weeks.length, 'última semana', 'últimas {n} semanas')}</span>` });
}

function bugsCard(weeks, openBugs) {
  const series = [{ key: 's1', label: t('Abertos') }, { key: 's2', label: t('Corrigidos') }];
  return card(t('Qualidade · bugs abertos × corrigidos'), columns(weekGroups(weeks, 'bugs_created', 'bugs_done'), series, {
    tableKey: 'bugs', firstHead: t('Semana'), emptyMsg: t('Nenhum bug aberto ou corrigido nas últimas semanas.'),
  }), { icon: typeIcon('bug', { always: true }), extra: `<span class="card-sub">${t('{n} em aberto', { n: num(openBugs) })}</span>` });
}

// Prioridade é ordinal: rampa de um tom só, mais escura (ou mais clara no tema escuro) quanto mais urgente.
function priorityCard(byPriority) {
  const items = PRIORITIES.map((p, i) => ({
    text: PRIORITY_LABEL[p], icon: prioIcon(p), value: byPriority[p] || 0, cls: `o${PRIORITIES.length - i}`,
    go: `filter:prio:${p}`, tipLabel: t('abertas'),
  }));
  return card(t('Abertas por prioridade'), hbars(items, { emptyMsg: t('Nenhuma tarefa aberta.') }));
}

function typeCard(byType) {
  const items = TYPES.map((type) => ({
    text: TYPE_LABEL[type], icon: typeIcon(type, { always: true }), value: byType[type] || 0, go: `filter:type:${type}`, tipLabel: t('abertas'),
  }));
  return card(t('Abertas por tipo'), hbars(items, { emptyMsg: t('Nenhuma tarefa aberta.') }));
}

function projectsCard(byProject) {
  const rows = byProject.filter((p) => p.open).sort((a, b) => b.open - a.open);
  if (!rows.length) return card(t('Abertas por projeto'), empty(t('Nenhuma tarefa aberta.')));
  // Até 8 projetos; o resto vira "Outros".
  const list = rows.length > 9 ? [...rows.slice(0, 8), rows.slice(8).reduce((o, p) => {
    for (const k of ['todo', 'doing', 'blocked', 'open', 'overdue']) o[k] += p[k];
    return o;
  }, { other: rows.length - 8, name: t('Outros ({n})', { n: rows.length - 8 }), todo: 0, doing: 0, blocked: 0, open: 0, overdue: 0 })] : rows;
  const items = list.map((p) => ({
    text: p.name, icon: p.other ? '' : projectBadge(p), value: p.open, go: p.other ? '' : `project:${p.id}`,
    meta: blockedFlag(p.blocked) + overdueFlag(p.overdue), tipTitle: p.name, tipRows: statusRows(p),
  }));
  const head = [t('Projeto'), STATUS_LABEL.todo, STATUS_LABEL.doing, STATUS_LABEL.blocked, t('Atrasadas')].map(esc);
  return card(t('Abertas por projeto'), `
    ${items.some((i) => i.meta) ? flagsKey() : ''}
    ${hbars(items)}
    ${tableToggle('projects', head, list.map((p) => [esc(p.name), num(p.todo), num(p.doing), num(p.blocked), num(p.overdue)]))}`);
}

// Projeto escolhido: mesma regra do quadro (coluna própria da tarefa ou a primeira coluna do status dela).
function columnCard() {
  const cols = (state.columns || []).filter((c) => c.status !== 'done');
  const counts = new Map(cols.map((c) => [c, 0]));
  for (const task of state.tasks) {
    if (task.status === 'done' || task.archived_at) continue;
    const col = cols.find((c) => c.id != null && c.id === task.column_id) || cols.find((c) => c.status === task.status);
    if (col) counts.set(col, counts.get(col) + 1);
  }
  const items = cols.map((c) => ({ text: columnLabel(c.name, c.status), icon: statusIcon(c.status), value: counts.get(c), tipLabel: t('abertas') }));
  return card(t('Abertas por coluna'), hbars(items, { emptyMsg: t('Nenhuma tarefa aberta.') }));
}

const isLate = (p) => !!p.end_date && p.end_date < state.today && p.progress < 1 && !['completed', 'cancelled'].includes(p.status);

function portfolioCard(list) {
  if (!list.length) return '';
  const rank = { active: 0, planning: 1, on_hold: 2, completed: 3, cancelled: 4 };
  const rows = [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (a.end_date || '9999').localeCompare(b.end_date || '9999'));
  const row = (p) => {
    const late = isLate(p);
    const due = p.end_date
      ? `<td class="${late ? 'late' : ''}" ${late ? `title="${esc(t('Prazo do projeto vencido'))}"` : ''}>${late ? ICON.calendar : ''}${fmtDate(p.end_date)}</td>`
      : '<td class="muted">—</td>';
    return `
      <tr>
        <td><button class="pf-name" data-go="project:${p.id}">${projectBadge(p)}<span>${esc(p.name)}</span></button></td>
        <td><div class="pf-prog" ${tipAttr(p.name, [{ value: pct(p.progress), label: t('concluído') }, { value: num(p.done), label: t('concluídas') }, { value: num(p.open), label: t('abertas') }])}>
          <span class="meter${late ? ' late' : ''}"><span style="width:${p.progress * 100}%"></span></span><b>${pct(p.progress)}</b>
        </div></td>
        ${due}
        <td class="num">${p.overdue ? overdueFlag(p.overdue) : '<span class="muted">0</span>'}</td>
        <td class="pf-status">${esc(PROJECT_STATUS_LABEL[p.status] || p.status || '')}</td>
      </tr>`;
  };
  return card(t('Portfólio'), `
    <div class="table-scroll"><table class="mini-table pf">
      <thead><tr><th>${t('Projeto')}</th><th>${t('Progresso')}</th><th>${t('Prazo')}</th><th class="num"><span class="wide">${t('Atrasadas')}</span><span class="od narrow" title="${esc(t('Atrasadas'))}" aria-label="${esc(t('Atrasadas'))}">${ICON.calendar}</span></th><th class="pf-status">${t('Status')}</th></tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table></div>`, { span: true, icon: ICON.layers });
}

function progressCard(p) {
  if (!p) return '';
  const late = isLate(p);
  const when = p.end_date ? (late ? t('prazo vencido em {d}', { d: fmtDate(p.end_date) }) : t('prazo {d}', { d: fmtDate(p.end_date) })) : t('sem prazo definido');
  return card(t('Progresso do projeto'), `
    <div class="meter-big"><b>${pct(p.progress)}</b><span>${t('{a} de {b} concluídas', { a: num(p.done), b: num(p.open + p.done) })}</span></div>
    <span class="meter${late ? ' late' : ''}"><span style="width:${p.progress * 100}%"></span></span>
    <p class="small ${late ? 'late-text' : 'muted'}">${esc(PROJECT_STATUS_LABEL[p.status] || '')} · ${late ? ICON.calendar : ''}${when}${p.overdue ? ` · ${tn(p.overdue, '{n} tarefa atrasada', '{n} tarefas atrasadas', { n: num(p.overdue) })}` : ''}</p>`, { icon: ICON.layers });
}

function workloadCard(list) {
  const title = t('Carga por pessoa');
  if (!list.length) return card(title, empty(t('Nenhuma tarefa aberta atribuída a alguém.')), { icon: ICON.users });
  const byPoints = workloadBy === 'points';
  const seg = `<div class="seg" role="group" aria-label="${esc(t('Medir por'))}">${[['tasks', t('Tarefas')], ['points', t('Pontos')]]
    .map(([k, label]) => `<button data-wl="${k}" aria-pressed="${workloadBy === k}">${label}</button>`).join('')}</div>`;
  const people = list.map((u) => ({ ...u, open: u.todo + u.doing + u.blocked }));
  const items = people.map((u) => ({
    text: u.name, icon: avatar(userById(u.id) || u, { size: 18 }), value: byPoints ? u.points : u.open, go: `filter:assignee:${u.id}`,
    meta: byPoints ? '' : blockedFlag(u.blocked) + overdueFlag(u.overdue),
    tipTitle: u.name, tipRows: [...statusRows(u), { value: num(u.points), label: t('pontos') }],
  })).sort((a, b) => b.value - a.value);
  const head = [t('Pessoa'), STATUS_LABEL.todo, STATUS_LABEL.doing, STATUS_LABEL.blocked, t('Atrasadas'), t('Pontos')].map(esc);
  return card(title, `
    ${!byPoints && items.some((i) => i.meta) ? flagsKey() : ''}
    ${hbars(items, { emptyMsg: byPoints ? t('Nenhuma tarefa aberta com pontos.') : t('Nenhuma tarefa aberta.') })}
    ${tableToggle('workload', head, people.map((u) => [esc(u.name), num(u.todo), num(u.doing), num(u.blocked), num(u.overdue), num(u.points)]))}`,
  { icon: ICON.users, extra: seg });
}

// Tempo registrado por pessoa em 30 dias (o servidor não calcula estimativa nem capacidade).
function utilizationCard(list) {
  const items = list.map((u) => {
    const user = state.users.find((x) => x.name === u.name);
    const icon = user ? avatar(user, { size: 18 }) : u.name === 'Claude' ? `<span class="avatar claude" style="--s:18px">${ICON.claude}</span>` : '';
    return { text: u.name, icon, value: u.minutes, tipLabel: t('registrado em 30 dias') };
  });
  return card(t('Tempo por pessoa · 30 dias'), hbars(items, { format: fmtDuration, lab: '4.4em', emptyMsg: t('Nenhum tempo registrado nos últimos 30 dias.') }), { icon: ICON.clock });
}

function timeCard(list) {
  const items = list.map((p) => ({ text: p.name, icon: projectBadge(p), value: p.minutes, go: `project:${p.id}`, tipLabel: t('registrado em 7 dias') }));
  return card(t('Tempo por projeto · 7 dias'), hbars(items, { format: fmtDuration, lab: '4.4em', emptyMsg: t('Nenhum tempo registrado. Use o timer nas tarefas.') }), { icon: ICON.clock });
}

// Alocação pessoa × projeto: mapa de calor sequencial (um tom), número dentro de cada célula.
function allocationCard(list) {
  const title = t('Alocação · pessoas × projetos');
  if (!list.length) return card(title, empty(t('Nenhuma tarefa aberta atribuída a alguém.')), { span: true, icon: ICON.grid });
  const totals = new Map();
  const names = new Map();
  for (const a of list) {
    totals.set(a.project_id, (totals.get(a.project_id) || 0) + a.n);
    names.set(a.project_id, a.project);
  }
  const ids = [...totals.keys()].sort((a, b) => totals.get(b) - totals.get(a));
  const cols = ids.length > 8 ? [...ids.slice(0, 7), 'other'] : ids;
  names.set('other', t('Outros ({n})', { n: ids.length - 7 }));
  const people = [...new Set(list.map((a) => a.person))];
  const cell = new Map();
  for (const a of list) {
    const k = `${a.person}\u0000${cols.includes(a.project_id) ? a.project_id : 'other'}`;
    cell.set(k, (cell.get(k) || 0) + a.n);
  }
  const max = Math.max(...cell.values(), 1);
  const bin = (n) => (n ? Math.max(1, Math.ceil((n / max) * 5)) : 0);
  const rows = people.map((p) => {
    let total = 0;
    const tds = cols.map((c) => {
      const n = cell.get(`${p}\u0000${c}`) || 0;
      total += n;
      return `<td class="h${bin(n)}" ${tipAttr(`${p} · ${names.get(c)}`, [{ value: num(n), label: t('abertas') }])}>${n ? num(n) : '·'}</td>`;
    }).join('');
    return `<tr><th title="${esc(p)}">${esc(p)}</th>${tds}<td class="total">${num(total)}</td></tr>`;
  }).join('');
  return card(title, `
    <div class="table-scroll"><table class="heat">
      <thead><tr><th></th>${cols.map((c) => `<th title="${esc(names.get(c))}">${esc(names.get(c))}</th>`).join('')}<th class="num">${t('Total')}</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="scale-key"><span>${t('Menos')}</span><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i><i class="h5"></i><span>${t('Mais')}</span></div>`,
  { span: true, icon: ICON.grid, extra: `<span class="card-sub">${t('tarefas abertas')}</span>` });
}

function sprintCard(sp) {
  const bd = sp.burndown;
  const pts = bd?.unit === 'pontos';
  const done = pts ? sp.points_done : sp.done;
  const total = pts ? sp.points_total : sp.total;
  const left = sp.end_date ? daysBetween(state.today, sp.end_date) : null;
  const leftText = left == null ? '' : left > 0 ? tn(left, 'falta {n} dia', 'faltam {n} dias') : left === 0 ? t('termina hoje') : t('passou do fim');
  const when = `${sp.start_date ? fmtDate(sp.start_date) : '?'} → ${sp.end_date ? fmtDate(sp.end_date) : t('sem fim definido')}`;
  let chart = empty(t('A sprint ainda não tem tarefas.'));
  if (bd?.total && bd.days.length) {
    const unit = pts ? t('pontos') : t('tarefas');
    const series = [
      { key: 's1', label: t('Restante'), values: bd.days.map((d) => d.remaining), dot: true, endLabel: (v) => `${num(v)} ${unit}` },
      { key: 'ideal', label: t('Ideal'), values: bd.days.map((d) => d.ideal), up: true, endLabel: () => t('ideal') },
    ];
    const max = Math.max(bd.total, ...bd.days.map((d) => d.remaining || 0));
    chart = `
      <h4 class="sub">${t('Burndown · {u} restantes', { u: unit })}</h4>
      ${lineChart(`burn${sp.id}`, { labels: bd.days.map((d) => ({ short: fmtDate(d.day), long: fmtDate(d.day, { year: false }) })), series, max })}
      ${tableToggle('burndown', [t('Dia'), t('Ideal'), t('Restante')].map(esc), bd.days.map((d) => [esc(fmtDate(d.day)), num(d.ideal), d.remaining == null ? '—' : num(d.remaining)]))}`;
  }
  return card(`${t('Sprint ativa')} · ${esc(sp.name)}`, `
    <div class="meter-big"><b>${pct(total ? done / total : 0)}</b><span>${pts
    ? t('{a} de {b} pontos concluídos', { a: num(done), b: num(total) })
    : t('{a} de {b} tarefas concluídas', { a: num(done), b: num(total) })}</span></div>
    <span class="meter"><span style="width:${total ? (done / total) * 100 : 0}%"></span></span>
    <p class="muted small">${when}${leftText ? ` · ${leftText}` : ''}${sp.goal ? ` · ${esc(sp.goal)}` : ''}</p>
    ${chart}`, { icon: ICON.target });
}

function velocityCard(list) {
  if (!list.length) return state.sprints?.length ? card(t('Velocidade'), empty(t('Conclua uma sprint para ver a velocidade.')), { icon: ICON.zap }) : '';
  const pts = list.some((v) => v.planned_points);
  const series = [{ key: 's1', label: t('Planejado') }, { key: 's2', label: t('Concluído') }];
  const groups = list.map((v) => ({ label: v.name, title: v.name, values: pts ? [v.planned_points, v.points] : [v.planned, v.tasks] }));
  const avg = groups.reduce((n, g) => n + g.values[1], 0) / groups.length;
  return card(t('Velocidade'), columns(groups, series, {
    tableKey: 'velocity', firstHead: t('Sprint'), emptyMsg: t('As sprints concluídas não tiveram itens.'),
  }), { icon: ICON.zap, extra: `<span class="card-sub">${pts ? t('média {n} pontos', { n: num(avg) }) : t('média {n} tarefas', { n: num(avg) })}</span>` });
}

function upcomingCard(list) {
  const rows = list.map((x) => {
    const d = dueInfo(x, state.today);
    return `
      <button class="due-row" data-task="${x.id}">${statusIcon(x.status)}${prioIcon(x.priority)}<span class="tid">${esc(taskRef(x))}</span><span class="t">${esc(x.title)}</span>
        ${state.projectId ? '' : `<span class="muted small proj">${esc(x.project_name)}</span>`}
        ${d ? `<span class="due ${d.cls}" title="${esc(d.title)}">${esc(d.text)}</span>` : ''}</button>`;
  }).join('');
  return card(t('Próximos prazos'), `<div class="due-list">${rows || empty(t('Nenhuma tarefa com prazo.'))}</div>`, { icon: ICON.calendar });
}

function activityItem(a) {
  const who = a.user_name || { claude: 'Claude', 'automação': t('Automação'), 'você': t('Você') }[a.author] || t('Alguém');
  const task = `<span class="tid">${esc(taskRef({ id: a.task_id, ref: a.ref }))}</span> ${esc(a.title)}`;
  const what = a.kind === 'created' ? t('criou {task}', { task })
    : a.kind === 'note' ? t('comentou em {task}', { task })
      : t('{change} em {task}', { change: esc(eventText(a.body)), task });
  return `
    <button class="feed-item" data-task="${a.task_id}">
      <span class="feed-who ${a.author === 'claude' ? 'claude' : ''}">${a.author === 'claude' ? ICON.claude : ''}<b>${esc(who)}</b></span>
      <span class="feed-what">${what}</span>
      <span class="feed-meta">${state.projectId ? '' : `${esc(a.project_name)} · `}${ago(a.created_at)}</span>
    </button>`;
}

function activityCard(list) {
  const items = list.slice(0, 8).map(activityItem).join('');
  return card(t('Atividade recente'), `
    <div class="feed">${items || empty(t('Nada ainda.'))}</div>
    ${list.length ? `<div class="card-foot"><button class="link-btn" data-go="activity">${t('Ver toda a atividade')}</button></div>` : ''}`,
  { span: true, icon: ICON.history });
}

function view(s) {
  const single = !!state.projectId;
  const cards = [
    weeklyCard(s.weeks),
    single && s.sprint ? sprintCard(s.sprint) : '',
    single ? velocityCard(s.velocity) : '',
    priorityCard(s.byPriority),
    typeCard(s.byType),
    single ? columnCard() : projectsCard(s.byProject),
    bugsCard(s.weeks, s.totals.open_bugs),
    single ? progressCard(s.portfolio[0]) : portfolioCard(s.portfolio),
    workloadCard(s.workload),
    utilizationCard(s.utilization),
    single ? '' : timeCard(s.timeByProject),
    single ? '' : allocationCard(s.allocation),
    upcomingCard(s.upcoming),
    activityCard(s.activity),
  ];
  return `<div class="dashboard dash">${tiles(s.totals)}<div class="dash-grid">${cards.join('')}</div></div>`;
}

// ---------- renderização ----------

function paint(el) {
  tips.clear();
  lines.clear();
  const top = el.scrollTop;
  el.innerHTML = view(stats);
  el.scrollTop = top;
  bind(el);
}

export async function renderDashboard(el, { refresh = false } = {}) {
  const key = String(state.projectId || 'all');
  const my = ++seq;
  const cached = stats && loadedFor === key;
  // Com cache: mostra na hora e atualiza em silêncio. Sem cache: "Carregando…".
  if (cached && !refresh) paint(el);
  else if (!cached) el.innerHTML = `<div class="skeleton" aria-busy="true" aria-label="${t('Carregando…')}"><div class="row">${'<div class="sk"></div>'.repeat(6)}</div><div class="row"><div class="sk tall"></div><div class="sk tall"></div></div></div>`;
  const slow = cached ? setTimeout(() => $('.dash', el)?.classList.add('refreshing'), 300) : null;
  try {
    const data = await api(`/api/stats${state.projectId ? `?project=${state.projectId}` : ''}`);
    if (my !== seq || !el.isConnected) return;
    stats = data;
    loadedFor = key;
  } catch (e) {
    if (my !== seq || !el.isConnected) return;
    if (!cached) {
      el.innerHTML = `<div class="empty-small pad">${esc(e.message)}</div>`;
      return;
    }
  } finally {
    clearTimeout(slow);
  }
  paint(el);
}

// Navegação a partir dos cards: projeto, lista filtrada, atividade ou quadro.
function follow(go) {
  const [kind, a, b] = go.split(':');
  if (kind === 'project') return navigate({ projectId: Number(a), view: 'board' });
  if (kind === 'activity') return navigate({ view: 'activity' });
  if (kind === 'filter') {
    Object.assign(state, { prio: '', type: '', assignee: '', due: '', tag: '' }, { [a]: b });
    return navigate({ view: 'list' });
  }
  return navigate({ view: 'board' });
}

function bind(el) {
  el.onclick = (e) => {
    const wl = e.target.closest('[data-wl]');
    if (wl) {
      workloadBy = wl.dataset.wl;
      return paint(el);
    }
    // O <details> alterna depois do clique: guarda o estado novo.
    const summary = e.target.closest('details[data-table] > summary');
    if (summary) {
      const d = summary.parentElement;
      if (d.open) openTables.delete(d.dataset.table);
      else openTables.add(d.dataset.table);
      return;
    }
    const task = e.target.closest('[data-task]');
    if (task) return openTask(Number(task.dataset.task));
    const go = e.target.closest('[data-go]')?.dataset.go;
    if (go) follow(go);
  };
  bindTooltips(el);
}

// ---------- tooltip e crosshair ----------

function tipNode() {
  let node = $('.viz-tip');
  if (!node) {
    node = document.createElement('div');
    node.className = 'viz-tip';
    node.setAttribute('role', 'tooltip');
    document.body.append(node);
  }
  return node;
}

function fillTip(node, { title, rows }) {
  node.replaceChildren();
  if (title) {
    const h = document.createElement('div');
    h.className = 'tip-title';
    h.textContent = title;
    node.append(h);
  }
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    if (r.key) {
      const k = document.createElement('span');
      k.className = `tip-key ${r.key}`;
      row.append(k);
    }
    const b = document.createElement('b');
    b.textContent = r.value;
    row.append(b);
    if (r.label) {
      const s = document.createElement('span');
      s.textContent = r.label;
      row.append(s);
    }
    node.append(row);
  }
  node.classList.add('show');
}

function placeTip(node, x, y) {
  const tx = Math.max(8, Math.min(x + 14, innerWidth - node.offsetWidth - 8));
  const ty = y - node.offsetHeight - 12 < 8 ? y + 18 : y - node.offsetHeight - 12;
  node.style.transform = `translate(${tx}px, ${ty}px)`;
}

// Crosshair: linha vertical no dia mais próximo e um tooltip com todas as séries.
function showLine(plot, i, y, node) {
  const c = lines.get(plot.dataset.lc);
  if (!c) return;
  i = Math.max(0, Math.min(c.n - 1, i));
  plot.dataset.i = i;
  const cross = $('.lc-cross', plot);
  cross.hidden = false;
  cross.style.left = `${c.X(i)}%`;
  fillTip(node, {
    title: c.labels[i].long,
    rows: c.series.map((s) => ({ key: s.key, value: s.values[i] == null ? '—' : num(s.values[i]), label: s.label })),
  });
  const r = plot.getBoundingClientRect();
  placeTip(node, r.left + (c.X(i) / 100) * r.width, y ?? r.top + r.height / 2);
}

function bindTooltips(el) {
  const node = tipNode();
  const hide = () => {
    node.classList.remove('show');
    for (const c of el.querySelectorAll('.lc-cross:not([hidden])')) c.hidden = true;
  };
  hide();
  const move = (e) => {
    const plot = e.target.closest('.lc-plot');
    if (plot) {
      const c = lines.get(plot.dataset.lc);
      const r = plot.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      return showLine(plot, Math.round(f * ((c?.n || 1) - 1)), e.clientY, node);
    }
    const target = e.target.closest('[data-tipid]');
    const data = target && tips.get(target.dataset.tipid);
    if (!data) return hide();
    for (const c of el.querySelectorAll('.lc-cross:not([hidden])')) c.hidden = true;
    fillTip(node, data);
    placeTip(node, e.clientX, e.clientY);
  };
  el.onpointermove = move;
  el.onpointerdown = (e) => { if (e.pointerType !== 'mouse') move(e); };
  el.onpointerleave = hide;
  el.onscroll = hide;
  // Teclado: o foco mostra o mesmo tooltip; no gráfico de linha, as setas mudam o dia.
  el.onfocusin = (e) => {
    const plot = e.target.closest('.lc-plot');
    if (plot) return showLine(plot, Number(plot.dataset.i ?? lines.get(plot.dataset.lc)?.last ?? 0), null, node);
    const data = tips.get(e.target.dataset?.tipid);
    if (!data || !e.target.matches(':focus-visible')) return hide();
    fillTip(node, data);
    const r = e.target.getBoundingClientRect();
    placeTip(node, r.left + r.width / 2, r.top);
  };
  el.onfocusout = hide;
  el.onkeydown = (e) => {
    const plot = e.target.closest?.('.lc-plot');
    if (!plot || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    showLine(plot, Number(plot.dataset.i ?? 0) + (e.key === 'ArrowRight' ? 1 : -1), null, node);
  };
}
