// Caixa de entrada por e-mail: lê a caixa IMAP do projeto e transforma e-mails em tarefas.
// Respostas com "[#12]" no assunto viram comentários na tarefa 12. Regras ajustam ou ignoram.
import { fetchUnseen, verifyImap } from './mail/imap.js';
import { parseMessage } from './mail/mime.js';
import { mailEnabled, sendLater } from './mailer.js';
import { PRIORITIES, TYPES, cleanEnum, cleanText, fail, now } from './util.js';

const EMAIL = { author: 'e-mail' };
const MASK = '••••••••';

function row(store, project_id) {
  return store.db.prepare('SELECT * FROM inboxes WHERE project_id = ?').get(project_id);
}

export function inboxConfig(store, project_id) {
  const r = row(store, project_id);
  if (!r) return null;
  return { ...r, enabled: !!r.enabled, imap_secure: !!r.imap_secure, auto_reply: !!r.auto_reply, imap_pass: r.imap_pass ? MASK : '' };
}

function imapConfig(store, r) {
  if (!r?.imap_host || !r.imap_user) fail('Configure o servidor IMAP da caixa de entrada');
  return {
    host: r.imap_host,
    port: r.imap_port || (r.imap_secure ? 993 : 143),
    secure: !!r.imap_secure,
    user: r.imap_user,
    pass: store.reveal(r.imap_pass) || '',
    // Sem TLS só por escolha explícita na configuração (senha trafega em claro).
    allowInsecureAuth: !r.imap_secure,
  };
}

export function saveInbox(store, project_id, patch) {
  const current = row(store, project_id);
  const value = (k, fallback) => (patch[k] === undefined ? (current ? current[k] : fallback) : patch[k]);
  const pass = patch.imap_pass === undefined || patch.imap_pass === MASK ? current?.imap_pass ?? null : (patch.imap_pass ? store.secret(patch.imap_pass) : null);
  const fields = {
    enabled: value('enabled', 1) ? 1 : 0,
    address: cleanText(value('address', null), 'address', { max: 200 }) || null,
    imap_host: cleanText(value('imap_host', null), 'imap_host', { max: 200 }) || null,
    imap_port: Number(value('imap_port', 993)) || 993,
    imap_secure: value('imap_secure', 1) ? 1 : 0,
    imap_user: cleanText(value('imap_user', null), 'imap_user', { max: 200 }) || null,
    imap_pass: pass,
    mailbox: cleanText(value('mailbox', 'INBOX'), 'mailbox', { max: 100 }) || 'INBOX',
    default_type: cleanEnum(value('default_type', 'task'), 'default_type', TYPES) || 'task',
    default_priority: cleanEnum(value('default_priority', 'medium'), 'default_priority', PRIORITIES) || 'medium',
    default_column_id: value('default_column_id', null) || null,
    default_assignee_id: value('default_assignee_id', null) || null,
    auto_reply: value('auto_reply', 0) ? 1 : 0,
    auto_reply_template: cleanText(value('auto_reply_template', ''), 'auto_reply_template') || '',
    signature: cleanText(value('signature', ''), 'signature') || '',
    sync_minutes: Math.max(1, Math.min(1440, Number(value('sync_minutes', 5)) || 5)),
  };
  if (patch.default_assignee !== undefined) fields.default_assignee_id = patch.default_assignee ? store.findUser(patch.default_assignee)?.id ?? fail('Responsável padrão não encontrado') : null;
  if (patch.default_column !== undefined) fields.default_column_id = patch.default_column ? store.resolveColumn(project_id, patch.default_column).id : null;
  store.transaction(() => {
    if (current) {
      const keys = Object.keys(fields);
      store.db.prepare(`UPDATE inboxes SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE project_id = ?`).run(...keys.map((k) => fields[k]), project_id);
    } else {
      const keys = Object.keys(fields);
      store.db.prepare(`INSERT INTO inboxes (project_id, ${keys.join(', ')}, created_at) VALUES (?, ${keys.map(() => '?').join(', ')}, ?)`)
        .run(project_id, ...keys.map((k) => fields[k]), now());
    }
  });
  return inboxConfig(store, project_id);
}

export function deleteInbox(store, project_id) {
  store.transaction(() => store.db.prepare('DELETE FROM inboxes WHERE project_id = ?').run(project_id));
}

export function inboxSummary(store, project_id) {
  const c = inboxConfig(store, project_id);
  if (!c) return 'Este projeto ainda não tem caixa de entrada. Configure com action "configure" (imap_host, imap_user, imap_pass…).';
  return [
    `Caixa de entrada ${c.enabled ? 'ativa' : 'pausada'}${c.address ? ` · ${c.address}` : ''}`,
    `IMAP: ${c.imap_user || '?'}@${c.imap_host || '?'}:${c.imap_port} (${c.imap_secure ? 'TLS' : 'sem TLS'}) · pasta ${c.mailbox} · a cada ${c.sync_minutes} min`,
    `Novas tarefas: tipo ${c.default_type}, prioridade ${c.default_priority}${c.auto_reply ? ' · resposta automática ligada' : ''}`,
    `Última sincronização: ${c.last_sync_at || 'nunca'}${c.last_error ? ` · último erro: ${c.last_error}` : ''}`,
  ].join('\n');
}

export async function testInbox(store, project_id) {
  await verifyImap(imapConfig(store, row(store, project_id)));
  return true;
}

// ---- regras ----

const parseRule = (r) => r && { ...r, enabled: !!r.enabled, stop: !!r.stop, conditions: JSON.parse(r.conditions || '{}'), actions: JSON.parse(r.actions || '{}') };

export function listRules(store, project_id) {
  const inbox = row(store, project_id);
  if (!inbox) return [];
  return store.db.prepare('SELECT * FROM inbox_rules WHERE inbox_id = ? ORDER BY position, id').all(inbox.id).map(parseRule);
}

export function saveRule(store, project_id, input, id = null) {
  const inbox = row(store, project_id) || fail('Configure a caixa de entrada antes das regras');
  const conditions = {};
  for (const k of ['from_contains', 'subject_contains', 'body_contains']) if (input.conditions?.[k]) conditions[k] = String(input.conditions[k]).slice(0, 200);
  const a = input.actions || {};
  const actions = {
    ignore: !!a.ignore,
    priority: cleanEnum(a.priority, 'priority', PRIORITIES),
    type: cleanEnum(a.type, 'type', TYPES),
    tags: Array.isArray(a.tags) ? a.tags.map(String).slice(0, 12) : undefined,
    assignee: a.assignee || undefined,
    column: a.column || undefined,
  };
  const values = [cleanText(input.name, 'name', { required: true, max: 120 }), Number(input.position ?? 0), input.enabled === false ? 0 : 1,
    JSON.stringify(conditions), JSON.stringify(actions), input.stop ? 1 : 0];
  store.transaction(() => {
    if (id) {
      const r = store.db.prepare('UPDATE inbox_rules SET name = ?, position = ?, enabled = ?, conditions = ?, actions = ?, stop = ? WHERE id = ? AND inbox_id = ?').run(...values, id, inbox.id);
      if (!r.changes) fail('Regra não encontrada');
    }
    else store.db.prepare('INSERT INTO inbox_rules (inbox_id, name, position, enabled, conditions, actions, stop, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(inbox.id, ...values, now());
  });
  return listRules(store, project_id);
}

export function deleteRule(store, project_id, id) {
  const inbox = row(store, project_id) || fail('Caixa de entrada não encontrada');
  store.transaction(() => store.db.prepare('DELETE FROM inbox_rules WHERE id = ? AND inbox_id = ?').run(id, inbox.id));
}

function matches(rule, mail) {
  const c = rule.conditions;
  const has = (hay, needle) => !needle || String(hay || '').toLowerCase().includes(String(needle).toLowerCase());
  return has(`${mail.from?.name} ${mail.from?.address}`, c.from_contains) && has(mail.subject, c.subject_contains) && has(mail.text, c.body_contains);
}

// ---- sincronização ----

const cleanSubject = (s) => String(s || '(sem assunto)').replace(/^\s*((re|fw|fwd|enc|res)\s*:\s*)+/i, '').trim() || '(sem assunto)';

// Corta a parte citada de respostas ("Em … escreveu:", "On … wrote:", linhas com ">").
function replyText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^(em|on) .+(escreveu|wrote):\s*$/i.test(l.trim()) || /^-{2,}\s*(original|mensagem original)/i.test(l.trim()));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

function processMail(store, inbox, raw) {
  const mail = parseMessage(raw);
  const messageId = mail.messageId || null;
  if (messageId && store.db.prepare('SELECT 1 FROM inbox_messages WHERE inbox_id = ? AND message_id = ?').get(inbox.id, messageId)) return 'dup';
  const from = mail.from || { name: '', address: '' };
  const record = (status, task_id = null, error = null) => store.db.prepare(`
    INSERT OR IGNORE INTO inbox_messages (inbox_id, message_id, from_address, from_name, subject, received_at, status, task_id, error, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(inbox.id, messageId, from.address, from.name, mail.subject, mail.date || now(), status, task_id, error, now());
  const sender = from.name ? `${from.name} <${from.address}>` : from.address;
  // O remetente de um e-mail pode ser forjado: nada é registrado em nome da conta; ela
  // só aparece como relatora da tarefa e o remetente fica visível no texto.
  const user = store.findUser(from.address);
  const actor = EMAIL;

  // Resposta a um e-mail do quadro: comentário na tarefa.
  const ref = String(mail.subject || '').match(/\[#(\d+)\]/)?.[1];
  const target = ref && store.task(Number(ref));
  if (target && target.project_id === inbox.project_id) {
    const body = replyText(mail.text) || '(resposta sem texto)';
    store.addNote(target.id, `**${sender}** respondeu por e-mail:\n\n${body}`, actor);
    for (const a of mail.attachments) store.addAttachment(target.id, { name: a.filename, data: a.content, mime: a.contentType }, actor);
    record('comment', target.id);
    return 'comment';
  }

  const rules = listRules(store, inbox.project_id).filter((r) => r.enabled);
  const input = {
    title: cleanSubject(mail.subject).slice(0, 300),
    description: `${(mail.text || '').trim().slice(0, 18000)}\n\n— Recebido por e-mail de ${sender}`,
    type: inbox.default_type,
    priority: inbox.default_priority,
    column: inbox.default_column_id || undefined,
    assignees: inbox.default_assignee_id ? [inbox.default_assignee_id] : undefined,
    reporter: user?.id,
    tags: ['e-mail'],
  };
  for (const rule of rules) {
    if (!matches(rule, mail)) continue;
    const a = rule.actions;
    if (a.ignore) { record('ignored'); return 'ignored'; }
    if (a.priority) input.priority = a.priority;
    if (a.type) input.type = a.type;
    if (a.tags?.length) input.tags = [...new Set([...input.tags, ...a.tags])];
    if (a.assignee) input.assignees = [a.assignee];
    if (a.column) input.column = a.column;
    if (rule.stop) break;
  }
  const { task } = store.addTask(inbox.project_id, { ...input, external_source: messageId ? 'email' : undefined, external_id: messageId || undefined }, actor);
  for (const a of mail.attachments) store.addAttachment(task.id, { name: a.filename, data: a.content, mime: a.contentType }, actor);
  record('task', task.id);

  if (inbox.auto_reply && from.address && mailEnabled(store) && !/^(no-?reply|mailer-daemon|postmaster)@/i.test(from.address)) {
    const link = `${store.publicUrl()}/?task=${task.id}`;
    const text = (inbox.auto_reply_template || 'Recebemos sua mensagem e abrimos a tarefa {id}: {titulo}. Responda este e-mail para acrescentar informações.')
      .replaceAll('{id}', `#${task.id}`).replaceAll('{titulo}', task.title).replaceAll('{link}', link);
    sendLater(store, {
      to: from.address,
      subject: `Re: [#${task.id}] ${task.title}`,
      text: inbox.signature ? `${text}\n\n${inbox.signature}` : text,
      inReplyTo: messageId || undefined,
      references: messageId ? [messageId] : undefined,
    });
  }
  return 'task';
}

export async function syncInbox(store, project_id) {
  const inbox = row(store, project_id) || fail('Este projeto não tem caixa de entrada');
  const counts = { tasks: 0, comments: 0, ignored: 0, errors: 0 };
  try {
    const messages = await fetchUnseen(imapConfig(store, inbox), { mailbox: inbox.mailbox, limit: 50, markSeen: true });
    for (const { raw } of messages) {
      try {
        const r = processMail(store, inbox, raw);
        if (r === 'task') counts.tasks++;
        else if (r === 'comment') counts.comments++;
        else if (r === 'ignored') counts.ignored++;
      } catch (e) {
        counts.errors++;
        store.db.prepare(`INSERT INTO inbox_messages (inbox_id, status, error, created_at) VALUES (?, 'error', ?, ?)`).run(inbox.id, e.message.slice(0, 300), now());
      }
    }
    store.db.prepare('UPDATE inboxes SET last_sync_at = ?, last_error = NULL WHERE id = ?').run(now(), inbox.id);
  } catch (e) {
    store.db.prepare('UPDATE inboxes SET last_sync_at = ?, last_error = ? WHERE id = ?').run(now(), e.message.slice(0, 300), inbox.id);
    throw e;
  } finally {
    store.writes++;
  }
  return counts;
}

// Chamado pelo agendador do servidor: sincroniza as caixas cujo intervalo venceu.
let syncing = false;
export async function syncDueInboxes(store) {
  if (syncing) return;
  syncing = true;
  try {
    const due = store.db.prepare(`
      SELECT project_id FROM inboxes WHERE enabled = 1 AND imap_host IS NOT NULL
      AND (last_sync_at IS NULL OR unixepoch(last_sync_at) + sync_minutes * 60 <= unixepoch('now'))`).all();
    for (const { project_id } of due) {
      try { await syncInbox(store, project_id); } catch (e) { console.error(`caixa de entrada do projeto ${project_id}:`, e.message); }
    }
  } finally {
    syncing = false;
  }
}

// Exposto para os testes: processa uma mensagem crua como se tivesse chegado pela caixa.
export function ingestRaw(store, project_id, raw) {
  const inbox = row(store, project_id) || fail('Este projeto não tem caixa de entrada');
  return store.transaction(() => processMail(store, inbox, raw));
}
