// Rotas da API REST. Cada rota: [método, padrão, handler, opções]. public = sem login;
// raw = corpo binário (uploads). As permissões por projeto ficam em store.assertCan.
import { createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleChat } from './chat.js';
import { cleanId, forbid, now } from './db.js';
import { exportCsv, fetchJira, fetchTrello, importCsv, importJiraIssues, importTrelloBoard, runSync } from './importers.js';
import { deleteInbox, deleteRule, inboxConfig, listRules, saveInbox, saveRule, syncInbox, testInbox } from './inbox.js';
import { mailEnabled, sendLater, testSmtp } from './mailer.js';
import { mapStatus, queryMap } from './mapa.js';
import { DEFAULT_SETTINGS } from './store/insights.js';
import { NOTIFY_TYPES } from './store/team.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'video/mp4', 'video/quicktime']);
const STARTED = Date.now();

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const id = (value) => {
  try { return cleanId(value); } catch { throw new HttpError(400, 'id inválido'); }
};

// Falha de um servidor externo (IMAP, SMTP, Jira, Trello) é 502, não erro interno.
async function upstream(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e.status) throw e;
    throw new HttpError(502, e.message);
  }
}

const actorOf = (user) => (user ? { author: 'user', user_id: user.id } : { author: 'você' });
const requireAdmin = (user) => { if (user && user.role !== 'admin') forbid('Só administradores podem fazer isso'); };
const requireWriter = (user) => { if (user?.role === 'viewer') forbid('Visualizadores não podem fazer isso'); };

function sendFile(res, path, { mime, name, size, inline }) {
  res.writeHead(200, {
    'content-type': mime,
    ...(size ? { 'content-length': size } : {}),
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'cache-control': 'private, max-age=86400',
  });
  createReadStream(path).on('error', () => res.end()).pipe(res);
}

export function buildRoutes({ store, setSession, clearSession }) {
  const vis = (user) => store.visibleProjectIds(user);
  // Projeto inexistente é 404 também para administradores (projectRole não confere a existência).
  const guard = (user, project, level) => {
    const p = typeof project === 'object' ? project : store.project(project);
    if (!p) throw new HttpError(404, 'Projeto não encontrado');
    return store.assertCan(user, p, level);
  };
  const taskGuard = (user, taskId, level) => store.assertTask(user, taskId, level);
  // Referências a outras tarefas/projetos dentro de uma criação ou alteração de tarefa:
  // mover para outro projeto ou pendurar numa tarefa-mãe exige edição lá; depender de uma
  // tarefa exige ao menos ler o projeto dela (senão o título vazaria em "blockers").
  const refsGuard = (user, body = {}) => {
    if (body.project_id) guard(user, id(body.project_id), 'edit');
    if (body.parent_id != null && body.parent_id !== '') taskGuard(user, store.resolveTaskRef(body.parent_id), 'edit');
    const deps = body.blocked_by == null ? [] : Array.isArray(body.blocked_by) ? body.blocked_by : [body.blocked_by];
    for (const d of deps) taskGuard(user, store.resolveTaskRef(typeof d === 'object' ? d.id : d), 'read');
  };
  const labelGuard = (user, label) => (label.project_id ? guard(user, label.project_id, 'manage') : requireAdmin(user));
  const orgGuard = (user, organization_id) => { if (!store.canManageOrg(user, organization_id)) forbid('Só administradores e gerentes da organização podem fazer isso'); };

  function boardState(url, user) {
    const project_id = url.searchParams.get('project') ? id(url.searchParams.get('project')) : undefined;
    if (project_id) guard(user, project_id, 'read');
    const project_ids = vis(user);
    const include_archived = url.searchParams.get('archived') === '1';
    const since = new Date(Date.now() - 60 * 86400000).toISOString();
    const tasks = store.listTasks({ project_id, project_ids: project_id ? undefined : project_ids, status: 'all', done_since: since, include_archived, limit: 5000 });
    return {
      version: store.version(),
      today: new Date().toISOString().slice(0, 10),
      projects: store.listProjects({ project_ids }).map((p) => ({ ...p, my_role: store.projectRole(user, p) })),
      tasks,
      dependencies: store.allDependencies(tasks.map((t) => t.id)),
      users: store.listUsers(),
      organizations: store.organizations(),
      workspaces: store.workspaces(),
      labels: store.db.prepare('SELECT * FROM labels ORDER BY name COLLATE NOCASE').all()
        .filter((l) => !l.project_id || !project_ids || project_ids.includes(l.project_id)),
      fields: store.customFields(project_id),
      columns: project_id ? store.columns(project_id) : null,
      transitions: project_id ? store.transitions(project_id) : [],
      sprints: project_id ? store.sprints(project_id) : [],
      timers: store.runningTimers(user?.id),
      unread: store.unreadCount(user?.id),
      my_role: project_id ? store.projectRole(user, project_id) : null,
    };
  }

  // Dados do link público: só o necessário para ler, sem e-mails nem tempos.
  function publicPayload(share) {
    const people = (ids) => ids.map((uid) => store.user(uid)?.name).filter(Boolean);
    const taskView = (t) => ({
      id: t.id, ref: t.ref, title: t.title, description: t.description, status: t.status, column: t.column_name, priority: t.priority,
      type: t.type, tags: t.tags, due_date: t.due_date, start_date: t.start_date, story_points: t.story_points,
      assignees: people(t.assignee_ids), subtask_done: t.subtask_done, subtask_count: t.subtask_count, updated_at: t.updated_at,
    });
    if (share.kind === 'task') {
      const t = store.taskWithNotes(share.target_id);
      if (!t) throw new HttpError(404, 'Este link não existe mais');
      return {
        kind: 'task',
        project: { name: t.project_name, color: t.project_color },
        task: {
          ...taskView(t),
          subtasks: t.subtasks.map((s) => ({ id: s.id, title: s.title, status: s.status })),
          attachments: t.attachments.map((a) => ({ id: a.id, name: a.name, mime: a.mime, size: a.size })),
          comments: t.notes.filter((n) => n.kind === 'note').map((n) => ({
            id: n.id, parent_id: n.parent_id, body: n.body, created_at: n.created_at,
            author: n.author === 'claude' ? 'Claude' : n.user_name || (n.author === 'e-mail' ? 'E-mail' : 'Equipe'),
          })),
        },
      };
    }
    const p = store.project(share.target_id);
    if (!p || p.visibility !== 'public') throw new HttpError(404, 'Este projeto não está mais público');
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    return {
      kind: 'project',
      project: { name: p.name, color: p.color, description: p.description, status: p.status, start_date: p.start_date, end_date: p.end_date },
      columns: store.columns(p.id).map((c) => ({ id: c.id, name: c.name, status: c.status })),
      tasks: store.listTasks({ project_id: p.id, status: 'all', done_since: since, top_level: true, limit: 2000 })
        .map((t) => ({ ...taskView(t), column_id: t.column_id })),
    };
  }

  function settingsFor(user) {
    const s = store.settings();
    const base = { notify_macos: s.notify_macos, due_soon_days: s.due_soon_days, default_language: s.default_language, ai_provider: s.ai_provider, mail_enabled: mailEnabled(store) };
    if (user && user.role !== 'admin') return base;
    const full = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
    return { ...full, ...base, smtp_last_error: s.smtp_last_error || '' };
  }

  function adminOverview() {
    const dir = store.dataDir;
    const size = (f) => { try { return statSync(f).size; } catch { return 0; } };
    const dirSize = (d) => { try { return readdirSync(d).reduce((n, f) => n + size(join(d, f)), 0); } catch { return 0; } };
    const count = (sql) => store.db.prepare(sql).get().n;
    return {
      app_version: VERSION,
      schema_version: store.db.prepare('PRAGMA user_version').get().user_version,
      node: process.version,
      uptime_seconds: Math.round((Date.now() - STARTED) / 1000),
      data_dir: dir,
      database_bytes: size(store.path) + size(`${store.path}-wal`),
      attachments_bytes: dirSize(store.attachDir),
      counts: {
        users: count('SELECT COUNT(*) AS n FROM users'),
        organizations: count('SELECT COUNT(*) AS n FROM organizations'),
        workspaces: count('SELECT COUNT(*) AS n FROM workspaces'),
        projects: count('SELECT COUNT(*) AS n FROM projects'),
        tasks: count('SELECT COUNT(*) AS n FROM tasks'),
        open_tasks: count("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done'"),
        comments: count("SELECT COUNT(*) AS n FROM notes WHERE kind = 'note'"),
        attachments: count('SELECT COUNT(*) AS n FROM attachments'),
        automations: count('SELECT COUNT(*) AS n FROM automations'),
        inboxes: count('SELECT COUNT(*) AS n FROM inboxes'),
        sessions: count('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > datetime(\'now\')'),
      },
      backups: readdirSync(dir).filter((f) => /^backup-[\w.-]+\.db$/.test(f))
        .map((f) => ({ file: f, bytes: size(join(dir, f)), created_at: statSync(join(dir, f)).mtime.toISOString() }))
        .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      mail_enabled: mailEnabled(store),
      ai_provider: store.settings().ai_provider,
    };
  }

  const backupFile = (file) => {
    if (!/^backup-[\w.-]+\.db$/.test(file || '')) throw new HttpError(400, 'Arquivo de backup inválido');
    const path = join(store.dataDir, file);
    if (!existsSync(path)) throw new HttpError(404, 'Backup não encontrado');
    return path;
  };

  const raw = { raw: true };
  const pub = { public: true };

  return [
    // ===== autenticação =====
    ['GET', /^\/api\/auth\/me$/, ({ user }) => ({
      user,
      setup: !store.hasUsers(),
      unread: store.unreadCount(user?.id),
      settings: store.userSettings(user?.id),
      default_language: store.settings().default_language,
      mail_enabled: mailEnabled(store),
    }), pub],

    ['POST', /^\/api\/auth\/setup$/, ({ body, res }) => {
      if (store.hasUsers()) throw new HttpError(409, 'A conta de administrador já foi criada');
      const user = store.createUser({ ...body, role: 'admin' });
      store.db.prepare('UPDATE notifications SET user_id = ? WHERE user_id IS NULL').run(user.id);
      setSession(res, store.createSession(user.id));
      return { user };
    }, pub],

    ['POST', /^\/api\/auth\/login$/, ({ body, res }) => {
      const user = store.verifyLogin(body.email, body.password);
      setSession(res, store.createSession(user.id));
      return { user };
    }, pub],

    ['POST', /^\/api\/auth\/logout$/, ({ req, res, cookies }) => {
      store.deleteSession(cookies.tk_session);
      clearSession(res);
      return { ok: true };
    }, pub],

    // Sempre responde ok (não revela se o e-mail existe).
    ['POST', /^\/api\/auth\/forgot$/, ({ body }) => {
      const user = store.findUser(String(body.email || '').trim());
      if (user && mailEnabled(store) && user.email.toLowerCase() === String(body.email).trim().toLowerCase()) {
        const { token, expires_in_hours: hours } = store.createPasswordReset(user.id);
        sendLater(store, {
          to: user.email,
          subject: 'Redefinir sua senha do quadro de tarefas',
          text: `Olá, ${user.name}. Recebemos um pedido para redefinir sua senha. O link vale por ${hours} horas. Se não foi você, ignore este e-mail.`,
          link: `${store.publicUrl()}/?reset=${token}`,
          linkLabel: 'Criar nova senha',
        });
      }
      return { ok: true, mail_enabled: mailEnabled(store) };
    }, pub],

    ['GET', /^\/api\/auth\/reset\/([\w-]+)$/, ({ params }) => {
      const r = store.passwordReset(params[0]);
      const u = store.user(r.user_id);
      return { name: u.name, email: u.email };
    }, pub],

    ['POST', /^\/api\/auth\/reset\/([\w-]+)$/, ({ params, body, res }) => {
      const user = store.resetPassword(params[0], body.password);
      setSession(res, store.createSession(user.id));
      return { user };
    }, pub],

    ['GET', /^\/api\/invites\/([\w-]+)$/, ({ params }) => {
      const inv = store.validInvite(params[0]);
      return { email: inv.email, role: inv.role, project: inv.project_name };
    }, pub],

    ['POST', /^\/api\/invites\/([\w-]+)\/accept$/, ({ params, body, res }) => {
      const user = store.acceptInvite(params[0], body);
      setSession(res, store.createSession(user.id));
      return { user };
    }, pub],

    // ===== links públicos e avatares (sem login) =====
    ['GET', /^\/api\/public\/([\w-]+)$/, ({ params }) => {
      const share = store.share(params[0]);
      if (!share) throw new HttpError(404, 'Link inválido ou expirado');
      return publicPayload(share);
    }, pub],

    ['GET', /^\/api\/public\/([\w-]+)\/attachments\/(\d+)$/, ({ params, res }) => {
      const share = store.share(params[0]);
      const a = store.attachment(id(params[1]));
      const task = a && store.task(a.task_id);
      const allowed = share && task && (share.kind === 'task'
        ? share.target_id === task.id
        : share.target_id === task.project_id && store.project(task.project_id)?.visibility === 'public');
      if (!allowed) throw new HttpError(404, 'Anexo não encontrado');
      sendFile(res, store.attachmentPath(a), { mime: a.mime, name: a.name, size: a.size, inline: INLINE_TYPES.has(a.mime) });
    }, pub],

    ['GET', /^\/api\/avatars\/([\w.-]+)$/, ({ params, res }) => {
      const path = store.avatarPath(params[0]);
      if (!existsSync(path)) throw new HttpError(404, 'Avatar não encontrado');
      const ext = params[0].split('.').pop();
      sendFile(res, path, { mime: { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream', name: params[0], inline: true });
    }, pub],

    // ===== sessão e preferências =====
    ['GET', /^\/api\/version$/, ({ user }) => ({ version: store.version(), unread: store.unreadCount(user?.id) })],
    ['GET', /^\/api\/me\/settings$/, ({ user }) => store.userSettings(user?.id)],
    ['PATCH', /^\/api\/me\/settings$/, ({ user, body }) => store.updateUserSettings(user.id, body)],
    ['POST', /^\/api\/me\/avatar$/, ({ user, body, req }) => ({ avatar: store.setAvatar('user', user.id, { data: body, mime: req.headers['content-type'] }) }), raw],
    ['DELETE', /^\/api\/me\/avatar$/, ({ user }) => ({ avatar: store.setAvatar('user', user.id, {}) })],
    ['GET', /^\/api\/ui-commands$/, ({ user }) => store.takeUiCommands(user?.id)],

    // ===== quadro, busca e tarefas =====
    ['GET', /^\/api\/state$/, ({ url, user }) => boardState(url, user)],

    ['GET', /^\/api\/search$/, ({ url, user }) => store.search(url.searchParams.get('q'), { project_ids: vis(user), limit: 8 })],

    ['GET', /^\/api\/tasks\/(\d+)$/, ({ params, user }) => {
      taskGuard(user, id(params[0]), 'read');
      const task = store.taskWithNotes(id(params[0]));
      task.assignees = store.assigneesOf(task.id);
      task.sprints = store.sprints(task.project_id);
      task.my_role = store.projectRole(user, task.project_id);
      task.shares = store.shares('task', task.id);
      return task;
    }],

    ['POST', /^\/api\/tasks$/, ({ body, user }) => {
      let project = body.project_id ? store.project(id(body.project_id)) : null;
      if (!project && body.project_name) { requireWriter(user); project = store.resolveProject({ project: body.project_name }); }
      if (!project) throw new HttpError(400, 'Escolha um projeto');
      guard(user, project, 'edit');
      refsGuard(user, { ...body, project_id: undefined });
      return store.addTask(project.id, body, actorOf(user)).task;
    }],

    ['PATCH', /^\/api\/tasks\/(\d+)$/, ({ params, body, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      refsGuard(user, body);
      return store.updateTask(id(params[0]), body, actorOf(user));
    }],

    // Mesma mudança em várias tarefas (seleção múltipla da lista).
    ['POST', /^\/api\/tasks\/bulk$/, ({ body, user }) => {
      const ids = (body.ids || []).map(id);
      if (!ids.length) throw new HttpError(400, 'Selecione ao menos uma tarefa');
      for (const tid of ids) taskGuard(user, tid, body.delete ? 'manage' : 'edit');
      if (!body.delete) refsGuard(user, body.patch);
      store.transaction(() => {
        for (const tid of ids) {
          if (body.delete) { if (store.task(tid)) store.deleteTask(tid); } else store.updateTask(tid, body.patch || {}, actorOf(user));
        }
      });
      return { ok: true, count: ids.length };
    }],

    ['DELETE', /^\/api\/tasks\/(\d+)$/, ({ params, user }) => {
      taskGuard(user, id(params[0]), 'manage');
      store.deleteTask(id(params[0]));
      return { ok: true };
    }],

    ['POST', /^\/api\/tasks\/(\d+)\/notes$/, ({ params, body, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      return { id: store.addNote(id(params[0]), body.body, actorOf(user), { parent_id: body.parent_id }) };
    }],

    ['PATCH', /^\/api\/notes\/(\d+)$/, ({ params, body, user }) => {
      const note = store.note(id(params[0]));
      if (!note) throw new HttpError(404, 'Comentário não encontrado');
      const pid = taskGuard(user, note.task_id, 'edit');
      if (user && note.user_id !== user.id && !store.can(user, pid, 'manage')) forbid('Só o autor ou gerentes do projeto editam este comentário');
      return store.updateNote(note.id, body.body, actorOf(user));
    }],

    ['DELETE', /^\/api\/notes\/(\d+)$/, ({ params, user }) => {
      const note = store.note(id(params[0]));
      if (!note) throw new HttpError(404, 'Comentário não encontrado');
      const pid = taskGuard(user, note.task_id, 'edit');
      if (user && note.user_id !== user.id && !store.can(user, pid, 'manage')) forbid('Só o autor ou gerentes do projeto excluem este comentário');
      store.deleteNote(note.id);
      return { ok: true };
    }],

    ['POST', /^\/api\/tasks\/(\d+)\/blockers$/, ({ params, body, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      refsGuard(user, { blocked_by: body.blocked_by });
      store.addBlocker(id(params[0]), store.resolveTaskRef(body.blocked_by), body.type || 'finish_start');
      return { ok: true };
    }],

    ['DELETE', /^\/api\/tasks\/(\d+)\/blockers\/(\d+)$/, ({ params, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      store.removeBlocker(id(params[0]), id(params[1]));
      return { ok: true };
    }],

    ['POST', /^\/api\/tasks\/(\d+)\/watch$/, ({ params, body, user }) => {
      taskGuard(user, id(params[0]), 'read');
      if (!user) throw new HttpError(400, 'Entre com uma conta para acompanhar tarefas');
      store.watch(id(params[0]), user.id, body.on !== false);
      return { ok: true };
    }],

    // ----- tempo -----
    ['POST', /^\/api\/tasks\/(\d+)\/timer$/, ({ params, body, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      if (body.action === 'stop') store.stopTaskTimers(id(params[0]), actorOf(user));
      else store.startTimer(id(params[0]), actorOf(user));
      return { timers: store.runningTimers(user?.id) };
    }],

    ['POST', /^\/api\/tasks\/(\d+)\/time$/, ({ params, body, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      store.logTime(id(params[0]), body, actorOf(user));
      return { ok: true };
    }],

    ['DELETE', /^\/api\/time\/(\d+)$/, ({ params, user }) => {
      const entry = store.db.prepare('SELECT task_id FROM time_entries WHERE id = ?').get(id(params[0]));
      if (!entry) throw new HttpError(404, 'Registro não encontrado');
      taskGuard(user, entry.task_id, 'edit');
      store.deleteTimeEntry(id(params[0]));
      return { ok: true };
    }],

    ['GET', /^\/api\/time-report$/, ({ url, user }) => {
      const pid = url.searchParams.get('project') ? id(url.searchParams.get('project')) : undefined;
      if (pid) guard(user, pid, 'read');
      return store.timeReport({
        project_id: pid, project_ids: pid ? undefined : vis(user), from: url.searchParams.get('from') || undefined,
        to: url.searchParams.get('to') || undefined, group_by: url.searchParams.get('group_by') || 'task',
      });
    }],

    // ----- anexos e links públicos de tarefa -----
    ['POST', /^\/api\/tasks\/(\d+)\/attachments$/, ({ params, body, req, user }) => {
      taskGuard(user, id(params[0]), 'edit');
      const name = decodeURIComponent(req.headers['x-filename'] || 'arquivo');
      const mime = req.headers['content-type']?.split(';')[0] || undefined;
      return store.addAttachment(id(params[0]), { name, data: body, mime: mime === 'application/octet-stream' ? undefined : mime }, actorOf(user));
    }, raw],

    ['GET', /^\/api\/attachments\/(\d+)$/, ({ params, res, user }) => {
      const row = store.attachment(id(params[0]));
      if (!row) throw new HttpError(404, 'Anexo não encontrado');
      taskGuard(user, row.task_id, 'read');
      sendFile(res, store.attachmentPath(row), { mime: row.mime, name: row.name, size: row.size, inline: INLINE_TYPES.has(row.mime) });
    }],

    ['DELETE', /^\/api\/attachments\/(\d+)$/, ({ params, user }) => {
      const row = store.attachment(id(params[0]));
      if (!row) throw new HttpError(404, 'Anexo não encontrado');
      taskGuard(user, row.task_id, 'edit');
      store.deleteAttachment(row.id);
      return { ok: true };
    }],

    ['POST', /^\/api\/tasks\/(\d+)\/shares$/, ({ params, body, user }) => {
      const pid = taskGuard(user, id(params[0]), 'edit');
      // Em projeto privado, expor uma tarefa para fora é decisão de gerente.
      if (store.project(pid).visibility === 'private') guard(user, pid, 'manage');
      return store.createShare('task', id(params[0]), { days: body.days }, user);
    }],

    ['POST', /^\/api\/projects\/(\d+)\/shares$/, ({ params, body, user }) => {
      guard(user, id(params[0]), 'manage');
      if (store.project(id(params[0])).visibility !== 'public') throw new HttpError(400, 'Mude a visibilidade do projeto para "Público" antes de gerar o link');
      return store.createShare('project', id(params[0]), { days: body.days }, user);
    }],

    ['GET', /^\/api\/projects\/(\d+)\/shares$/, ({ params, user }) => {
      guard(user, id(params[0]), 'read');
      return store.shares('project', id(params[0]));
    }],

    ['DELETE', /^\/api\/shares\/([\w-]+)$/, ({ params, user }) => {
      const s = store.db.prepare('SELECT * FROM shares WHERE token = ?').get(params[0]);
      if (!s) throw new HttpError(404, 'Link não encontrado');
      if (s.kind === 'task') taskGuard(user, s.target_id, 'edit'); else guard(user, s.target_id, 'manage');
      store.revokeShare(params[0]);
      return { ok: true };
    }],

    // ===== projetos =====
    ['POST', /^\/api\/projects$/, ({ body, user }) => {
      requireWriter(user);
      if (body.workspace_id) {
        const ws = store.workspace(id(body.workspace_id));
        if (!ws) throw new HttpError(400, 'Workspace não encontrado');
      }
      const p = store.createProject(body.name, null, { ...body, actor: actorOf(user) });
      if (user && user.role !== 'admin') store.setMember('project', p.id, user.id, 'owner');
      return p;
    }],

    ['PATCH', /^\/api\/projects\/(\d+)$/, ({ params, body, user }) => {
      const pid = id(params[0]);
      guard(user, pid, body.archived !== undefined || body.visibility !== undefined ? 'own' : 'manage');
      return store.updateProject(pid, body);
    }],

    ['DELETE', /^\/api\/projects\/(\d+)$/, ({ params, user }) => {
      guard(user, id(params[0]), 'own');
      store.deleteProject(id(params[0]));
      return { ok: true };
    }],

    ['POST', /^\/api\/projects\/(\d+)\/avatar$/, ({ params, body, req, user }) => {
      guard(user, id(params[0]), 'manage');
      return { avatar: store.setAvatar('project', id(params[0]), { data: body, mime: req.headers['content-type'] }) };
    }, raw],

    // Mapa do código do projeto (gerado pelo plugin na pasta mapa-do-codigo/).
    ['GET', /^\/api\/projects\/(\d+)\/mapa$/, ({ params, user }) => {
      guard(user, id(params[0]), 'read');
      return mapStatus(store.project(id(params[0])));
    }],
    ['GET', /^\/api\/projects\/(\d+)\/mapa\/consulta$/, async ({ params, url, user }) => {
      guard(user, id(params[0]), 'read');
      const args = url.searchParams.getAll('arg').slice(0, 6);
      if (!args.length) throw new HttpError(400, 'Informe o que consultar (arg=find&arg=termo)');
      return { text: await queryMap(store.project(id(params[0])), args) };
    }],

    ['GET', /^\/api\/projects\/(\d+)\/members$/, ({ params, user }) => {
      guard(user, id(params[0]), 'read');
      return store.members('project', id(params[0]));
    }],

    ['POST', /^\/api\/projects\/(\d+)\/members$/, ({ params, body, user }) => {
      const pid = id(params[0]);
      guard(user, pid, 'manage');
      store.assertOwnerChange(user, 'project', pid, body.user, body.role);
      return store.setMember('project', pid, body.user, body.role || null);
    }],

    ['GET', /^\/api\/projects\/(\d+)\/columns$/, ({ params, user }) => { guard(user, id(params[0]), 'read'); return store.columns(id(params[0])); }],
    ['POST', /^\/api\/projects\/(\d+)\/columns$/, ({ params, body, user }) => { guard(user, id(params[0]), 'manage'); return store.createColumn(id(params[0]), body); }],
    ['PATCH', /^\/api\/columns\/(\d+)$/, ({ params, body, user }) => {
      const col = store.column(id(params[0]));
      if (!col) throw new HttpError(404, 'Coluna não encontrada');
      guard(user, col.project_id, 'manage');
      return store.updateColumn(col.id, body);
    }],
    ['DELETE', /^\/api\/columns\/(\d+)$/, ({ params, user }) => {
      const col = store.column(id(params[0]));
      if (!col) throw new HttpError(404, 'Coluna não encontrada');
      guard(user, col.project_id, 'manage');
      store.deleteColumn(col.id);
      return { ok: true };
    }],

    ['GET', /^\/api\/projects\/(\d+)\/transitions$/, ({ params, user }) => { guard(user, id(params[0]), 'read'); return store.transitions(id(params[0])); }],
    ['PUT', /^\/api\/projects\/(\d+)\/transitions$/, ({ params, body, user }) => {
      guard(user, id(params[0]), 'manage');
      return store.setTransitions(id(params[0]), (body.transitions || []).map((t) => (Array.isArray(t) ? t : [t.from, t.to])));
    }],
    ['POST', /^\/api\/projects\/(\d+)\/workflow$/, ({ params, body, user }) => {
      guard(user, id(params[0]), 'manage');
      return store.applyWorkflow(id(params[0]), body.workflow_id);
    }],

    ['GET', /^\/api\/projects\/(\d+)\/sprints$/, ({ params, user }) => { guard(user, id(params[0]), 'read'); return store.sprints(id(params[0])); }],
    ['POST', /^\/api\/projects\/(\d+)\/sprints$/, ({ params, body, user }) => { guard(user, id(params[0]), 'manage'); return store.createSprint(id(params[0]), body); }],
    ...[
      ['PATCH', /^\/api\/sprints\/(\d+)$/, (s, body) => store.updateSprint(s.id, body)],
      ['POST', /^\/api\/sprints\/(\d+)\/start$/, (s, body, user) => store.startSprint(s.id, actorOf(user))],
      ['POST', /^\/api\/sprints\/(\d+)\/complete$/, (s, body, user) => store.completeSprint(s.id, body, actorOf(user))],
      ['POST', /^\/api\/sprints\/(\d+)\/cancel$/, (s, body, user) => store.cancelSprint(s.id, body, actorOf(user))],
      ['DELETE', /^\/api\/sprints\/(\d+)$/, (s) => { store.deleteSprint(s.id); return { ok: true }; }],
    ].map(([method, pattern, fn]) => [method, pattern, ({ params, body, user }) => {
      const s = store.sprint(id(params[0]));
      if (!s) throw new HttpError(404, 'Sprint não encontrada');
      guard(user, s.project_id, 'manage');
      return fn(s, body, user);
    }]),

    // ----- labels e campos personalizados -----
    ['GET', /^\/api\/labels$/, ({ url, user }) => {
      const pid = url.searchParams.get('project') ? id(url.searchParams.get('project')) : null;
      if (pid) guard(user, pid, 'read');
      return store.labels(pid);
    }],
    ['POST', /^\/api\/labels$/, ({ body, user }) => {
      if (body.project_id) guard(user, id(body.project_id), 'manage'); else requireAdmin(user);
      return store.createLabel(body);
    }],
    ['PATCH', /^\/api\/labels\/(\d+)$/, ({ params, body, user }) => {
      const l = store.label(id(params[0]));
      if (!l) throw new HttpError(404, 'Label não encontrado');
      labelGuard(user, l);
      return store.updateLabel(l.id, body);
    }],
    ['DELETE', /^\/api\/labels\/(\d+)$/, ({ params, user }) => {
      const l = store.label(id(params[0]));
      if (!l) throw new HttpError(404, 'Label não encontrado');
      labelGuard(user, l);
      store.deleteLabel(l.id);
      return { ok: true };
    }],

    ['GET', /^\/api\/fields$/, ({ url, user }) => {
      const pid = url.searchParams.get('project') ? id(url.searchParams.get('project')) : null;
      if (pid) guard(user, pid, 'read');
      return store.customFields(pid);
    }],
    ['POST', /^\/api\/fields$/, ({ body, user }) => {
      if (body.project_id) guard(user, id(body.project_id), 'manage'); else requireAdmin(user);
      return store.createField(body);
    }],
    ['PATCH', /^\/api\/fields\/(\d+)$/, ({ params, body, user }) => {
      const f = store.customField(id(params[0]));
      if (!f) throw new HttpError(404, 'Campo não encontrado');
      labelGuard(user, f);
      return store.updateField(f.id, body);
    }],
    ['DELETE', /^\/api\/fields\/(\d+)$/, ({ params, user }) => {
      const f = store.customField(id(params[0]));
      if (!f) throw new HttpError(404, 'Campo não encontrado');
      labelGuard(user, f);
      store.deleteField(f.id);
      return { ok: true };
    }],

    // ----- exportação e importação -----
    ['GET', /^\/api\/export\.csv$/, ({ url, user, res }) => {
      const pid = url.searchParams.get('project') ? id(url.searchParams.get('project')) : undefined;
      if (pid) guard(user, pid, 'read');
      const tasks = store.listTasks({ project_id: pid, project_ids: pid ? undefined : vis(user), status: url.searchParams.get('status') || 'all', limit: 5000 });
      const name = pid ? store.project(pid).name : 'todas';
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`tarefas-${name}-${new Date().toISOString().slice(0, 10)}.csv`)}`,
      });
      res.end(exportCsv(store, tasks));
    }],
    ['POST', /^\/api\/projects\/(\d+)\/import\/csv$/, ({ params, body, user }) => {
      guard(user, id(params[0]), 'manage');
      return importCsv(store, id(params[0]), body.toString('utf8'), { actor: actorOf(user) });
    }, raw],
    ['POST', /^\/api\/projects\/(\d+)\/import\/trello-file$/, ({ params, body, user }) => {
      guard(user, id(params[0]), 'manage');
      let board;
      try { board = JSON.parse(body.toString('utf8')); } catch { throw new HttpError(400, 'O arquivo não é um JSON válido'); }
      return importTrelloBoard(store, id(params[0]), board, { actor: actorOf(user) });
    }, raw],
    ['POST', /^\/api\/projects\/(\d+)\/import\/(jira|trello)$/, async ({ params, body, user }) => {
      const pid = id(params[0]);
      guard(user, pid, 'manage');
      const kind = params[1];
      const result = kind === 'jira'
        ? importJiraIssues(store, pid, await upstream(() => fetchJira(body)), { actor: actorOf(user) })
        : importTrelloBoard(store, pid, await upstream(() => fetchTrello(body)), { actor: actorOf(user) });
      if (body.save) {
        const config = kind === 'jira'
          ? { site: body.site, email: body.email, jql: body.jql, token: store.secret(body.token) }
          : { board: body.board, key: body.key, token: store.secret(body.token) };
        store.db.prepare('INSERT INTO external_syncs (project_id, kind, config, last_sync_at, last_result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(pid, kind, JSON.stringify(config), now(), JSON.stringify(result), now());
        store.writes++;
      }
      return result;
    }],
    ['GET', /^\/api\/projects\/(\d+)\/syncs$/, ({ params, user }) => {
      guard(user, id(params[0]), 'read');
      return store.db.prepare('SELECT id, kind, config, last_sync_at, last_result, created_at FROM external_syncs WHERE project_id = ?').all(id(params[0]))
        .map((s) => { const c = JSON.parse(s.config); return { ...s, config: { ...c, token: c.token ? '••••••••' : '' }, last_result: s.last_result ? JSON.parse(s.last_result) : null }; });
    }],
    ['POST', /^\/api\/syncs\/(\d+)\/run$/, async ({ params, user }) => {
      const s = store.db.prepare('SELECT * FROM external_syncs WHERE id = ?').get(id(params[0]));
      if (!s) throw new HttpError(404, 'Sincronização não encontrada');
      guard(user, s.project_id, 'manage');
      return upstream(() => runSync(store, s, actorOf(user)));
    }],
    ['DELETE', /^\/api\/syncs\/(\d+)$/, ({ params, user }) => {
      const s = store.db.prepare('SELECT * FROM external_syncs WHERE id = ?').get(id(params[0]));
      if (!s) throw new HttpError(404, 'Sincronização não encontrada');
      guard(user, s.project_id, 'manage');
      store.transaction(() => store.db.prepare('DELETE FROM external_syncs WHERE id = ?').run(s.id));
      return { ok: true };
    }],

    // ----- caixa de entrada por e-mail -----
    ['GET', /^\/api\/projects\/(\d+)\/inbox$/, ({ params, user }) => {
      guard(user, id(params[0]), 'read');
      const inbox = inboxConfig(store, id(params[0]));
      return {
        inbox,
        rules: listRules(store, id(params[0])),
        messages: inbox ? store.db.prepare('SELECT * FROM inbox_messages WHERE inbox_id = ? ORDER BY id DESC LIMIT 50').all(inbox.id) : [],
        mail_enabled: mailEnabled(store),
      };
    }],
    ['PUT', /^\/api\/projects\/(\d+)\/inbox$/, ({ params, body, user }) => { guard(user, id(params[0]), 'manage'); return saveInbox(store, id(params[0]), body); }],
    ['DELETE', /^\/api\/projects\/(\d+)\/inbox$/, ({ params, user }) => { guard(user, id(params[0]), 'manage'); deleteInbox(store, id(params[0])); return { ok: true }; }],
    ['POST', /^\/api\/projects\/(\d+)\/inbox\/test$/, async ({ params, user }) => { guard(user, id(params[0]), 'manage'); await upstream(() => testInbox(store, id(params[0]))); return { ok: true }; }],
    ['POST', /^\/api\/projects\/(\d+)\/inbox\/sync$/, async ({ params, user }) => { guard(user, id(params[0]), 'manage'); return upstream(() => syncInbox(store, id(params[0]))); }],
    ['POST', /^\/api\/projects\/(\d+)\/inbox\/rules$/, ({ params, body, user }) => { guard(user, id(params[0]), 'manage'); return saveRule(store, id(params[0]), body); }],
    ['PATCH', /^\/api\/projects\/(\d+)\/inbox\/rules\/(\d+)$/, ({ params, body, user }) => { guard(user, id(params[0]), 'manage'); return saveRule(store, id(params[0]), body, id(params[1])); }],
    ['DELETE', /^\/api\/projects\/(\d+)\/inbox\/rules\/(\d+)$/, ({ params, user }) => { guard(user, id(params[0]), 'manage'); deleteRule(store, id(params[0]), id(params[1])); return { ok: true }; }],

    // ===== workflows =====
    ['GET', /^\/api\/workflows$/, () => store.workflows()],
    ['POST', /^\/api\/workflows$/, ({ body, user }) => { requireAdmin(user); return store.createWorkflow(body); }],
    ['POST', /^\/api\/workflows\/from-project\/(\d+)$/, ({ params, body, user }) => {
      guard(user, id(params[0]), 'manage');
      if (body.is_default) requireAdmin(user);
      return store.workflowFromProject(id(params[0]), body);
    }],
    ['PATCH', /^\/api\/workflows\/(\d+)$/, ({ params, body, user }) => { requireAdmin(user); return store.updateWorkflow(id(params[0]), body); }],
    ['DELETE', /^\/api\/workflows\/(\d+)$/, ({ params, user }) => { requireAdmin(user); store.deleteWorkflow(id(params[0])); return { ok: true }; }],

    // ===== organizações e workspaces =====
    ['GET', /^\/api\/organizations$/, () => store.organizations()],
    ['POST', /^\/api\/organizations$/, ({ body, user }) => { requireAdmin(user); return store.createOrganization(body); }],
    ['PATCH', /^\/api\/organizations\/(\d+)$/, ({ params, body, user }) => { orgGuard(user, id(params[0])); return store.updateOrganization(id(params[0]), body); }],
    ['DELETE', /^\/api\/organizations\/(\d+)$/, ({ params, user }) => { requireAdmin(user); store.deleteOrganization(id(params[0])); return { ok: true }; }],
    ['POST', /^\/api\/organizations\/(\d+)\/avatar$/, ({ params, body, req, user }) => {
      orgGuard(user, id(params[0]));
      return { avatar: store.setAvatar('organization', id(params[0]), { data: body, mime: req.headers['content-type'] }) };
    }, raw],
    ['GET', /^\/api\/organizations\/(\d+)\/members$/, ({ params }) => {
      if (!store.organization(id(params[0]))) throw new HttpError(404, 'Organização não encontrada');
      return store.members('organization', id(params[0]));
    }],
    ['POST', /^\/api\/organizations\/(\d+)\/members$/, ({ params, body, user }) => {
      const oid = id(params[0]);
      orgGuard(user, oid);
      store.assertOwnerChange(user, 'organization', oid, body.user, body.role);
      return store.setMember('organization', oid, body.user, body.role || null);
    }],

    ['GET', /^\/api\/workspaces$/, ({ url }) => store.workspaces(url.searchParams.get('organization') ? id(url.searchParams.get('organization')) : undefined)],
    ['POST', /^\/api\/workspaces$/, ({ body, user }) => { orgGuard(user, id(body.organization_id ?? 1)); return store.createWorkspace(body); }],
    ['PATCH', /^\/api\/workspaces\/(\d+)$/, ({ params, body, user }) => {
      const w = store.workspace(id(params[0]));
      if (!w) throw new HttpError(404, 'Workspace não encontrado');
      orgGuard(user, w.organization_id);
      return store.updateWorkspace(w.id, body);
    }],
    ['DELETE', /^\/api\/workspaces\/(\d+)$/, ({ params, user }) => {
      const w = store.workspace(id(params[0]));
      if (!w) throw new HttpError(404, 'Workspace não encontrado');
      orgGuard(user, w.organization_id);
      store.deleteWorkspace(w.id);
      return { ok: true };
    }],
    ['GET', /^\/api\/workspaces\/(\d+)\/members$/, ({ params }) => {
      if (!store.workspace(id(params[0]))) throw new HttpError(404, 'Workspace não encontrado');
      return store.members('workspace', id(params[0]));
    }],
    ['POST', /^\/api\/workspaces\/(\d+)\/members$/, ({ params, body, user }) => {
      const w = store.workspace(id(params[0]));
      if (!w) throw new HttpError(404, 'Workspace não encontrado');
      orgGuard(user, w.organization_id);
      store.assertOwnerChange(user, 'workspace', w.id, body.user, body.role);
      return store.setMember('workspace', w.id, body.user, body.role || null);
    }],

    // ===== dashboard e atividade =====
    ['GET', /^\/api\/stats$/, ({ url, user }) => {
      const pid = url.searchParams.get('project') ? id(url.searchParams.get('project')) : undefined;
      if (pid) guard(user, pid, 'read');
      return store.stats({ project_id: pid, project_ids: pid ? undefined : vis(user) });
    }],
    ['GET', /^\/api\/activity$/, ({ url, user }) => {
      const q = (k) => url.searchParams.get(k) || undefined;
      const pid = q('project') ? id(q('project')) : undefined;
      if (pid) guard(user, pid, 'read');
      return store.activity({
        project_id: pid, project_ids: pid ? undefined : vis(user), user_id: q('user') ? id(q('user')) : undefined,
        author: q('author'), kind: q('kind'), since: q('since'), until: q('until'), q: q('q'),
        limit: Number(q('limit')) || 50, offset: Number(q('offset')) || 0,
      });
    }],

    // ===== automações =====
    ['GET', /^\/api\/automations$/, ({ user }) => {
      const ids = vis(user);
      return store.listAutomations().filter((a) => !a.project_id || !ids || ids.includes(a.project_id));
    }],
    ['POST', /^\/api\/automations$/, ({ body, user }) => {
      if (body.project_id) guard(user, id(body.project_id), 'manage'); else requireAdmin(user);
      return store.createAutomation(body);
    }],
    ['PATCH', /^\/api\/automations\/(\d+)$/, ({ params, body, user }) => {
      const a = store.automation(id(params[0]));
      if (!a) throw new HttpError(404, 'Automação não encontrada');
      if (a.project_id) guard(user, a.project_id, 'manage'); else requireAdmin(user);
      if (body.project_id === null) requireAdmin(user);
      else if (body.project_id !== undefined) guard(user, id(body.project_id), 'manage');
      return store.updateAutomation(a.id, body);
    }],
    ['DELETE', /^\/api\/automations\/(\d+)$/, ({ params, user }) => {
      const a = store.automation(id(params[0]));
      if (!a) throw new HttpError(404, 'Automação não encontrada');
      if (a.project_id) guard(user, a.project_id, 'manage'); else requireAdmin(user);
      store.deleteAutomation(a.id);
      return { ok: true };
    }],

    // ===== equipe =====
    ['GET', /^\/api\/users$/, ({ url, user }) => store.listUsers({ include_disabled: url.searchParams.get('all') === '1' && user?.role === 'admin' })],
    ['POST', /^\/api\/users$/, ({ body, user }) => { requireAdmin(user); return store.createUser(body); }],
    ['PATCH', /^\/api\/users\/(\d+)$/, ({ params, body, user }) => store.updateUser(id(params[0]), body, user)],
    ['DELETE', /^\/api\/users\/(\d+)$/, ({ params, user }) => {
      if (user && id(params[0]) === user.id) throw new HttpError(400, 'Você não pode remover a própria conta');
      store.deleteUser(id(params[0]), user);
      return { ok: true };
    }],
    ['POST', /^\/api\/users\/(\d+)\/reset-link$/, ({ params, user }) => {
      requireAdmin(user);
      const { token, user: target, expires_in_hours: hours } = store.createPasswordReset(id(params[0]));
      const link = `${store.publicUrl()}/?reset=${token}`;
      if (mailEnabled(store)) {
        sendLater(store, { to: target.email, subject: 'Redefinir sua senha do quadro de tarefas', text: `Olá, ${target.name}. Um administrador pediu a redefinição da sua senha. O link vale por ${hours} horas.`, link, linkLabel: 'Criar nova senha' });
      }
      return { link, emailed: mailEnabled(store), expires_in_hours: hours };
    }],
    ['POST', /^\/api\/users\/(\d+)\/avatar$/, ({ params, body, req, user }) => {
      if (user && user.id !== id(params[0])) requireAdmin(user);
      return { avatar: store.setAvatar('user', id(params[0]), { data: body, mime: req.headers['content-type'] }) };
    }, raw],

    ['GET', /^\/api\/invites$/, ({ user }) => { requireAdmin(user); return store.listInvites(); }],
    ['POST', /^\/api\/invites$/, ({ body, user }) => {
      const inv = store.createInvite(body, user);
      const link = `${store.publicUrl()}/?invite=${inv.token}`;
      if (body.send_email && inv.email && mailEnabled(store)) {
        sendLater(store, {
          to: inv.email,
          subject: `${user?.name || 'Alguém'} convidou você para o quadro de tarefas`,
          text: `Você foi convidado para o quadro de tarefas${inv.project_name ? `, no projeto ${inv.project_name}` : ''}. O convite vale por 14 dias.`,
          link,
          linkLabel: 'Aceitar convite',
        });
      }
      return { ...inv, link, emailed: !!(body.send_email && inv.email && mailEnabled(store)) };
    }],
    ['DELETE', /^\/api\/invites\/([\w-]+)$/, ({ params, user }) => {
      store.revokeInvite(params[0], user);
      return { ok: true };
    }],

    // ===== notificações e configurações =====
    ['GET', /^\/api\/notifications$/, ({ user }) => ({ items: store.notifications(user?.id), unread: store.unreadCount(user?.id), types: NOTIFY_TYPES })],
    ['POST', /^\/api\/notifications\/read$/, ({ body, user }) => {
      store.markRead(user?.id, body.ids === 'all' ? 'all' : body.ids || []);
      return { unread: store.unreadCount(user?.id) };
    }],
    ['GET', /^\/api\/settings$/, ({ user }) => settingsFor(user)],
    ['PATCH', /^\/api\/settings$/, ({ body, user }) => { requireAdmin(user); store.updateSettings(body); return settingsFor(user); }],
    ['POST', /^\/api\/settings\/test-email$/, async ({ body, user }) => {
      requireAdmin(user);
      await upstream(() => testSmtp(store, body.to || user?.email));
      return { ok: true };
    }],

    // ===== administração =====
    ['GET', /^\/api\/admin\/overview$/, ({ user }) => { requireAdmin(user); return adminOverview(); }],
    ['POST', /^\/api\/admin\/backup$/, ({ user }) => {
      requireAdmin(user);
      const file = `backup-manual-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      store.db.exec(`VACUUM INTO '${join(store.dataDir, file).replaceAll("'", "''")}'`);
      return { file };
    }],
    ['GET', /^\/api\/admin\/backups\/([\w.-]+)$/, ({ params, user, res }) => {
      requireAdmin(user);
      const path = backupFile(params[0]);
      sendFile(res, path, { mime: 'application/vnd.sqlite3', name: params[0], size: statSync(path).size, inline: false });
    }],
    ['DELETE', /^\/api\/admin\/backups\/([\w.-]+)$/, ({ params, user }) => {
      requireAdmin(user);
      unlinkSync(backupFile(params[0]));
      return { ok: true };
    }],
    ['POST', /^\/api\/admin\/maintenance$/, ({ body, user }) => {
      requireAdmin(user);
      // Em WAL o VACUUM vai para o -wal; o checkpoint devolve o espaço ao arquivo principal.
      if (body.action === 'vacuum') { store.db.exec('VACUUM'); store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
      else if (body.action === 'cleanup') {
        store.transaction(() => {
          store.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
          store.db.prepare('DELETE FROM invites WHERE used_at IS NULL AND expires_at < ?').run(now());
          store.db.prepare('DELETE FROM password_resets WHERE expires_at < ? OR used_at IS NOT NULL').run(now());
          store.db.prepare('DELETE FROM ui_commands WHERE created_at < ?').run(new Date(Date.now() - 86400000).toISOString());
          store.db.prepare('DELETE FROM notifications WHERE read_at IS NOT NULL AND read_at < ?').run(new Date(Date.now() - 90 * 86400000).toISOString());
        });
      } else throw new HttpError(400, 'Ação de manutenção desconhecida');
      return adminOverview();
    }],

    // ===== chat =====
    ['GET', /^\/api\/chat$/, ({ user }) => ({ messages: store.chatHistory(user?.id), provider: store.settings().ai_provider })],
    ['DELETE', /^\/api\/chat$/, ({ user }) => { store.clearChat(user?.id); return { ok: true }; }],
    ['POST', /^\/api\/chat$/, async ({ body, user, res }) => {
      if (user?.role === 'viewer') forbid('Visualizadores não usam o chat (ele pode alterar o quadro)');
      await handleChat({ store, body, user, res });
    }],

    // ===== documentação da API =====
    ['GET', /^\/api\/openapi\.json$/, async () => (await import('./openapi.js')).openapi(VERSION), pub],

  ];
}
