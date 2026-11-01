// Exportação CSV e importação de CSV, Jira (CSV ou API) e Trello (JSON exportado ou API).
// Reimportar atualiza as tarefas já trazidas (casadas pelo id externo), sem duplicar.
import { COLUMN_NAME, PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL, cleanText, fail, formatDuration } from './db.js';

// ---------- CSV ----------

export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  row.push(field);
  if (row.some((v) => v !== '')) rows.push(row);
  return rows;
}

const csvCell = (v) => {
  const s = v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
  return /[",;\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function exportCsv(store, tasks) {
  const projectIds = [...new Set(tasks.map((t) => t.project_id))];
  const fields = projectIds.length === 1 ? store.customFields(projectIds[0]) : store.customFields(null);
  const head = ['ID', 'Código', 'Título', 'Descrição', 'Projeto', 'Status', 'Coluna', 'Prioridade', 'Tipo', 'Tags', 'Responsáveis',
    'Relator', 'Início', 'Prazo', 'Estimativa', 'Gasto', 'Story points', 'Sprint', 'Tarefa-mãe', 'Criada em', 'Concluída em',
    ...fields.map((f) => f.name)];
  const user = (id) => store.user(id)?.name || '';
  const lines = tasks.map((t) => [
    t.id, t.ref || '', t.title, t.description, t.project_name, STATUS_LABEL[t.status], t.column_name || COLUMN_NAME[t.status],
    PRIORITY_LABEL[t.priority], TYPE_LABEL[t.type], t.tags, t.assignee_ids.map(user), t.reporter_id ? user(t.reporter_id) : '',
    t.start_date || '', t.due_date || '', t.estimate_minutes ? formatDuration(t.estimate_minutes) : '',
    t.spent_minutes ? formatDuration(t.spent_minutes) : '', t.story_points ?? '', t.sprint_name || '', t.parent_id || '',
    t.created_at, t.completed_at || '',
    ...fields.map((f) => {
      const v = t.field_values?.[f.id];
      if (v == null) return '';
      if (f.type === 'user') return user(v);
      if (f.type === 'boolean') return v ? 'sim' : 'não';
      return v;
    }),
  ].map(csvCell).join(','));
  return `﻿${[head.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
}

// ---------- mapeamento de valores ----------

const norm = (s) => String(s ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function mapStatus(value, category) {
  const s = norm(value);
  if (category === 'done' || /^(done|concluid|feito|closed|resolved|fechad|complete|finaliz|entregue)/.test(s)) return 'done';
  if (/(block|bloque|impedid|waiting|aguard)/.test(s)) return 'blocked';
  if (category === 'indeterminate' || /(progress|andamento|doing|fazendo|review|revis|test|homolog|qa|dev)/.test(s)) return 'doing';
  return 'todo';
}

const PRIORITY_NAMES = {
  urgent: ['highest', 'blocker', 'critical', 'critica', 'urgent', 'urgente', 'p0', '1'],
  high: ['high', 'alta', 'major', 'p1', '2'],
  low: ['low', 'baixa', 'minor', 'p3', '4'],
  lowest: ['lowest', 'trivial', 'minima', 'p4', '5'],
};

export function mapPriority(value) {
  const s = norm(value);
  return Object.keys(PRIORITY_NAMES).find((p) => PRIORITY_NAMES[p].includes(s)) || 'medium';
}

export function mapType(value) {
  const s = norm(value);
  if (/^(bug|defeito|erro|defect)/.test(s)) return 'bug';
  if (/^(story|historia|user story)/.test(s)) return 'story';
  if (/^(epic|epico)/.test(s)) return 'epic';
  return 'task';
}

function cleanDay(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ---------- importação genérica (CSV / Jira CSV) ----------

const HEADERS = {
  title: ['titulo', 'title', 'summary', 'resumo', 'nome', 'name', 'task', 'tarefa'],
  description: ['descricao', 'description', 'detalhes', 'details'],
  status: ['status', 'estado', 'coluna', 'column', 'situacao'],
  priority: ['prioridade', 'priority'],
  type: ['tipo', 'type', 'issue type', 'tipo de item'],
  tags: ['tags', 'labels', 'etiquetas', 'rotulos', 'label'],
  assignees: ['responsavel', 'responsaveis', 'assignee', 'assignees', 'atribuido a'],
  reporter: ['relator', 'reporter'],
  due_date: ['prazo', 'due date', 'due', 'vencimento', 'data limite'],
  start_date: ['inicio', 'start date', 'start', 'data de inicio'],
  estimate: ['estimativa', 'original estimate', 'estimate', 'tempo estimado'],
  story_points: ['story points', 'pontos', 'story point estimate', 'points'],
  sprint: ['sprint'],
  external_id: ['issue key', 'key', 'chave', 'id externo', 'external id'],
  parent: ['parent', 'parent id', 'tarefa-mae', 'tarefa mae', 'parent summary'],
  // Colunas da própria exportação: reimportar um CSV exportado daqui atualiza as tarefas.
  task_id: ['id'],
  created_at: ['criada em', 'created at', 'created'],
};

function headerMap(head) {
  const map = {};
  head.forEach((h, i) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(HEADERS)) {
      if (names.includes(n)) (map[field] ||= []).push(i);
    }
  });
  return map;
}

// Importa linhas já lidas. source: 'csv' ou 'jira' (no Jira, estimativa vem em segundos).
export function importRows(store, project_id, rows, { source = 'csv', actor } = {}) {
  if (rows.length < 2) fail('O arquivo não tem linhas de dados');
  const [head, ...data] = rows;
  const map = headerMap(head);
  if (!map.title) fail(`Não encontrei a coluna de título. Cabeçalhos aceitos: ${HEADERS.title.join(', ')}`);
  const get = (row, field) => (map[field] || []).map((i) => row[i]).filter((v) => v != null && String(v).trim() !== '');
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const byExternal = new Map();
  const pendingParents = [];
  store.transaction(() => {
    data.forEach((row, n) => {
      try {
        const title = get(row, 'title')[0];
        if (!title) { result.skipped++; return; }
        const estimateRaw = get(row, 'estimate')[0];
        const estimate = estimateRaw == null ? undefined
          : /^\d+$/.test(String(estimateRaw).trim()) ? Math.round(Number(estimateRaw) / (source === 'jira' ? 60 : 1)) : estimateRaw;
        const users = get(row, 'assignees').flatMap((v) => String(v).split(/[,;]/)).map((v) => v.trim()).filter((v) => v && store.findUser(v));
        const reporter = get(row, 'reporter').find((v) => store.findUser(v));
        const sprintName = get(row, 'sprint')[0];
        let sprint;
        if (sprintName) {
          sprint = store.sprints(project_id).find((s) => s.name.toLowerCase() === String(sprintName).toLowerCase())?.id
            ?? store.createSprint(project_id, { name: sprintName }).id;
        }
        const input = {
          title: cleanText(title, 'title', { max: 300 }),
          description: get(row, 'description')[0] || '',
          status: mapStatus(get(row, 'status')[0]),
          priority: mapPriority(get(row, 'priority')[0]),
          type: mapType(get(row, 'type')[0]),
          tags: get(row, 'tags').flatMap((v) => String(v).split(/[,;]/)).map((v) => v.trim()).filter(Boolean),
          due_date: cleanDay(get(row, 'due_date')[0]),
          start_date: cleanDay(get(row, 'start_date')[0]),
          estimate,
          story_points: get(row, 'story_points')[0] ?? undefined,
          assignees: users,
          reporter: reporter || undefined,
          sprint,
        };
        const external = get(row, 'external_id')[0];
        if (external) Object.assign(input, { external_source: source === 'jira' ? 'jira' : 'csv', external_id: external });
        // ID + "Criada em" iguais aos de uma tarefa deste projeto = linha exportada daqui.
        // Só o ID não basta: um CSV de outro sistema poderia ter números que colidem.
        const ownId = Number(get(row, 'task_id')[0]);
        const own = !external && Number.isInteger(ownId) && ownId > 0 ? store.task(ownId) : null;
        const sameTask = own && own.project_id === project_id && own.created_at === String(get(row, 'created_at')[0] || '').trim();
        const existing = sameTask ? { id: own.id }
          : external && store.db.prepare('SELECT id FROM tasks WHERE external_source = ? AND external_id = ?').get(input.external_source, String(external));
        let id;
        if (existing) {
          const { external_source: _s, external_id: _e, ...patch } = input;
          store.updateTask(existing.id, patch, actor);
          id = existing.id;
          result.updated++;
        } else {
          const r = store.addTask(project_id, input, actor);
          id = r.task.id;
          if (r.duplicate) result.skipped++; else result.created++;
        }
        if (external) byExternal.set(String(external), id);
        if (sameTask) byExternal.set(String(ownId), id);
        const parent = get(row, 'parent')[0];
        if (parent) pendingParents.push([id, String(parent)]);
      } catch (e) {
        result.errors.push(`linha ${n + 2}: ${e.message}`);
      }
    });
    // Tarefa-mãe pela chave externa (Jira) depois que todas existem.
    for (const [id, parentKey] of pendingParents) {
      const local = /^\d+$/.test(parentKey) && store.task(Number(parentKey));
      const parentId = byExternal.get(parentKey) ?? (local && local.project_id === project_id ? local.id : undefined);
      if (parentId && parentId !== id) {
        try { store.updateTask(id, { parent_id: parentId }, actor); } catch (e) { result.errors.push(`#${id}: ${e.message}`); }
      }
    }
  });
  return result;
}

export function importCsv(store, project_id, text, opts) {
  const rows = parseCsv(text);
  const head = (rows[0] || []).map(norm);
  const jira = head.includes('issue key') || head.includes('issue type');
  return importRows(store, project_id, rows, { ...opts, source: jira ? 'jira' : 'csv' });
}

// ---------- Jira (API) ----------

function jiraHostAllowed(host) {
  const allow = (process.env.CLAUDE_TASKS_JIRA_HOSTS || '*.atlassian.net').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const h = host.toLowerCase();
  return allow.some((a) => a === '*' || a === h || (a.startsWith('*.') && h.endsWith(a.slice(1))));
}

// Documento ADF (Jira Cloud v3) → texto simples.
export function adfToText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  const inner = (node.content || []).map(adfToText).join('');
  if (node.type === 'listItem') return `- ${inner.trim()}\n`;
  if (['paragraph', 'heading', 'blockquote', 'codeBlock'].includes(node.type)) return `${inner}\n\n`;
  return inner;
}

export async function fetchJira({ site, email, token, jql }) {
  let url;
  try { url = new URL(site); } catch { fail('Endereço do Jira inválido (ex.: https://empresa.atlassian.net)'); }
  if (url.protocol !== 'https:') fail('Use https:// no endereço do Jira');
  if (!jiraHostAllowed(url.hostname)) fail(`Host ${url.hostname} não permitido. Ajuste CLAUDE_TASKS_JIRA_HOSTS para Jira próprio.`);
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;
  const fields = 'summary,description,status,priority,issuetype,labels,assignee,reporter,duedate,created,parent,timeoriginalestimate';
  const issues = [];
  let next;
  for (let page = 0; page < 40; page++) {
    const q = new URL('/rest/api/3/search/jql', url.origin);
    q.searchParams.set('jql', jql || 'ORDER BY created DESC');
    q.searchParams.set('fields', fields);
    q.searchParams.set('maxResults', '100');
    if (next) q.searchParams.set('nextPageToken', next);
    const res = await fetch(q, { headers: { authorization: auth, accept: 'application/json' }, redirect: 'error' });
    if (!res.ok) fail(`Jira respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    issues.push(...(data.issues || []));
    next = data.nextPageToken;
    if (!next || data.isLast) break;
  }
  return issues;
}

export function importJiraIssues(store, project_id, issues, { actor } = {}) {
  const header = ['Issue key', 'Summary', 'Description', 'Status', 'Priority', 'Issue Type', 'Labels', 'Assignee', 'Reporter', 'Due Date', 'Original Estimate', 'Parent'];
  const rows = [header, ...issues.map((i) => {
    const f = i.fields || {};
    return [
      i.key, f.summary, adfToText(f.description).trim(),
      f.status?.statusCategory?.key === 'done' ? 'done' : f.status?.statusCategory?.key === 'indeterminate' ? 'in progress' : f.status?.name,
      f.priority?.name, f.issuetype?.name, (f.labels || []).join(','), f.assignee?.emailAddress || f.assignee?.displayName || '',
      f.reporter?.emailAddress || f.reporter?.displayName || '', f.duedate || '', f.timeoriginalestimate ?? '', f.parent?.key || '',
    ];
  })];
  return importRows(store, project_id, rows, { source: 'jira', actor });
}

// ---------- Trello ----------

const TRELLO_COLORS = {
  green: '#1baf7a', yellow: '#eda100', orange: '#eb6834', red: '#e34948', purple: '#6250d6', blue: '#2a78d6',
  sky: '#3b9bd1', lime: '#5d8a3a', pink: '#e87ba4', black: '#52514e',
};

export async function fetchTrello({ board, key, token }) {
  const id = String(board).match(/trello\.com\/b\/([^/]+)/)?.[1] || String(board).trim();
  if (!/^[\w-]+$/.test(id)) fail('Informe o link ou o id do quadro do Trello');
  const url = new URL(`https://api.trello.com/1/boards/${id}`);
  for (const [k, v] of Object.entries({ key, token, lists: 'all', cards: 'all', card_fields: 'all', checklists: 'all', labels: 'all', members: 'all' })) url.searchParams.set(k, v);
  const res = await fetch(url, { redirect: 'error' });
  if (!res.ok) fail(`Trello respondeu ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export function importTrelloBoard(store, project_id, board, { actor, create_columns = true } = {}) {
  if (!board || !Array.isArray(board.cards)) fail('JSON do Trello inválido: exporte o quadro em Menu → Imprimir, exportar e compartilhar → Exportar como JSON');
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  store.transaction(() => {
    // Uma coluna por lista do Trello (com a categoria adivinhada pelo nome).
    const listColumn = new Map();
    const lists = (board.lists || []).filter((l) => !l.closed);
    if (create_columns && lists.length) {
      store.materializeColumns(project_id);
      for (const l of lists) {
        const status = mapStatus(l.name);
        const existing = store.columns(project_id).find((c) => c.name.toLowerCase() === l.name.toLowerCase());
        listColumn.set(l.id, (existing || store.createColumn(project_id, { name: l.name.slice(0, 60), status })).id);
      }
    }
    for (const l of board.labels || []) {
      if (!l.name) continue;
      const exists = store.labels(project_id).some((x) => x.name.toLowerCase() === l.name.toLowerCase());
      if (!exists) {
        try { store.createLabel({ project_id, name: l.name, color: TRELLO_COLORS[l.color] }); } catch {}
      }
    }
    const members = new Map((board.members || []).map((m) => [m.id, m.fullName || m.username]));
    const checklists = new Map();
    for (const c of board.checklists || []) {
      if (!checklists.has(c.idCard)) checklists.set(c.idCard, []);
      checklists.get(c.idCard).push(...(c.checkItems || []));
    }
    for (const card of board.cards) {
      try {
        const column = listColumn.get(card.idList);
        const input = {
          title: (card.name || 'Sem título').slice(0, 300),
          description: card.desc || '',
          due_date: card.due ? card.due.slice(0, 10) : null,
          start_date: card.start ? card.start.slice(0, 10) : null,
          tags: (card.labels || []).map((l) => l.name).filter(Boolean),
          assignees: (card.idMembers || []).map((id) => members.get(id)).filter((n) => n && store.findUser(n)),
          ...(card.dueComplete ? { status: 'done' } : column ? { column } : {}),
          archived: !!card.closed,
        };
        const existing = store.db.prepare("SELECT id FROM tasks WHERE external_source = 'trello' AND external_id = ?").get(card.id);
        let id;
        if (existing) {
          store.updateTask(existing.id, input, actor);
          id = existing.id;
          result.updated++;
        } else {
          id = store.addTask(project_id, { ...input, external_source: 'trello', external_id: card.id }, actor).task.id;
          if (input.archived) store.updateTask(id, { archived: true }, actor);
          result.created++;
        }
        for (const item of checklists.get(card.id) || []) {
          const sub = store.addTask(project_id, { title: item.name.slice(0, 300), parent_id: id, external_source: 'trello', external_id: item.id }, actor).task;
          const done = item.state === 'complete';
          if ((sub.status === 'done') !== done) store.updateTask(sub.id, { status: done ? 'done' : 'todo' }, actor);
        }
      } catch (e) {
        result.errors.push(`${card.name}: ${e.message}`);
      }
    }
  });
  return result;
}

// ---------- sincronizações salvas ----------

export async function runSync(store, sync, actor) {
  const cfg = JSON.parse(sync.config);
  const secret = store.reveal(cfg.token);
  let result;
  if (sync.kind === 'jira') {
    const issues = await fetchJira({ site: cfg.site, email: cfg.email, token: secret, jql: cfg.jql });
    result = importJiraIssues(store, sync.project_id, issues, { actor });
  } else {
    const board = await fetchTrello({ board: cfg.board, key: cfg.key, token: secret });
    result = importTrelloBoard(store, sync.project_id, board, { actor });
  }
  store.db.prepare('UPDATE external_syncs SET last_sync_at = ?, last_result = ? WHERE id = ?')
    .run(new Date().toISOString(), JSON.stringify(result), sync.id);
  store.writes++;
  return result;
}
