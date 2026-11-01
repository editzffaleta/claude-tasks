// Ferramentas do MCP para o que veio na paridade com o Taskosaur: comentários, labels,
// campos personalizados, membros, organizações/workspaces, links públicos, busca,
// importação/exportação, caixa de entrada por e-mail e "abrir no painel".
import { readFileSync, writeFileSync } from 'node:fs';
import { FIELD_TYPES, ROLES, ROLE_LABEL, cleanId, formatTask } from '../db.js';
import { exportCsv, fetchJira, fetchTrello, importCsv, importJiraIssues, importTrelloBoard } from '../importers.js';
import { mapStatus, queryMap, readSimulation, simulationTasks } from '../mapa.js';
import {
  CLAUDE, actingUser, boardLink, guardAdmin, guardProject, guardTask, me, projectFrom, requireProject, store, taskLink, userIds, visible,
} from './context.js';

const READ = { readOnlyHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
// Falam com servidores externos (Jira, Trello, IMAP).
const EXTERNAL = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const projectProps = {
  project_path: { type: 'string', description: 'Absolute path inside the project (normally your current working directory).' },
  project: { type: 'string', description: 'Project name, id or code prefix.' },
};

const pctText = (v) => (v == null ? '?' : `${Math.round(v * 1000) / 10}%`);
const msText = (v) => (v == null ? '?' : v >= 1000 ? `${Math.round(v / 100) / 10} s` : `${Math.round(v)} ms`);
const SEVERITY_TEXT = { alta: 'urgente', media: 'atenção', baixa: 'pode esperar' };

// A última simulação do Breakscale, em texto para o Claude.
function simulationText(project) {
  const sim = readSimulation(project);
  if (!sim) return `${project.name} ainda não tem simulação no Breakscale. Para fazer, use o skill mapa-do-codigo na pasta ${project.path} ("simule este projeto no Breakscale").`;
  const tasks = simulationTasks(store, project);
  const guessed = sim.premissas.filter((p) => p.origem !== 'código').length;
  const lines = [
    `Simulação no Breakscale de ${project.name}, feita em ${sim.geradoEm?.slice(0, 16).replace('T', ' ') || '?'} (${sim.origem === 'hospedado' ? 'servidor do Breakscale' : 'neste computador'}).`,
    `Premissas: ${sim.premissas.length}, das quais ${guessed} ainda são estimativas.`,
    '',
    'Cenários:',
    ...sim.cenarios.map((c) => `- ${c.nome || `${c.fator}×`}: ${c.oferecido ?? '?'}/s chegando, ${c.servido ?? '?'}/s atendidos, ${pctText(c.falhas)} falham, p95 ${msText(c.p95)}, p99 ${msText(c.p99)}${c.interrompido ? ' (parcial)' : ''}`),
    '',
    sim.gargalos.length ? 'Gargalos:' : 'Nenhum gargalo nos cenários simulados.',
    ...sim.gargalos.map((g) => {
      const t = tasks[g.id];
      return `- [${SEVERITY_TEXT[g.severidade]}] ${g.titulo}. ${g.porque || ''}${g.sugestao ? ` Sugestão: ${g.sugestao}` : ''}${t ? ` (tarefa ${t.ref}, ${t.status})` : ' (sem tarefa)'}`;
    }),
  ];
  if (sim.deixadoDeFora.length) lines.push('', 'Fora do modelo:', ...sim.deixadoDeFora.map((x) => `- ${x.texto}`));
  if (sim.link) lines.push('', `Abrir no Breakscale: ${sim.link}`);
  lines.push(`No painel: ${boardLink(project)}&view=mapa (aba Simulação)`);
  return lines.join('\n');
}

export const EXTRA_TOOLS = {
  manage_comment: {
    title: 'Editar ou excluir comentário',
    description: 'Edit or delete a comment you or the user made (ids appear in get_task as [comentário N]). Delete requires confirm: true.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['edit', 'delete'] },
        id: { type: 'integer', description: 'Comment id.' },
        body: { type: 'string', description: 'New text (edit).' },
        confirm: { type: 'boolean', description: 'Must be true to delete.' },
      },
      required: ['action', 'id'],
    },
    run(args) {
      const note = store.note(cleanId(args.id));
      if (!note || note.kind !== 'note') throw new Error('Comentário não encontrado');
      guardTask(note.task_id, 'edit');
      const user = actingUser();
      if (user && note.user_id !== user.id && !store.can(user, store.task(note.task_id).project_id, 'manage')) {
        throw new Error('Só o autor ou gerentes do projeto mudam este comentário');
      }
      if (args.action === 'edit') {
        store.updateNote(note.id, args.body, CLAUDE);
        return `Comentário ${note.id} editado em #${note.task_id}.`;
      }
      if (args.confirm !== true) throw new Error('Exclusão não confirmada: envie confirm: true');
      store.deleteNote(note.id);
      return `Comentário ${note.id} excluído de #${note.task_id}.`;
    },
  },

  manage_labels: {
    title: 'Gerenciar labels',
    description: 'List, create, update (rename/recolor) or delete labels — colored tags. Labels without a project apply to all projects. Renaming updates every task that uses it.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        ...projectProps,
        global: { type: 'boolean', description: 'create: label for all projects (admin).' },
        label: { type: 'string', description: 'Existing label name or id (update/delete).' },
        name: { type: 'string', description: 'Name (create) or new name (update).' },
        color: { type: 'string', description: 'Hex color, e.g. #e34948.' },
        description: { type: 'string' },
      },
      required: ['action'],
    },
    run(args) {
      const project = args.global ? null : projectFrom(args, { create: false });
      const list = store.labels(project?.id);
      const find = () => {
        const s = String(args.label || '').toLowerCase();
        const l = list.find((x) => String(x.id) === s || x.name.toLowerCase() === s);
        if (!l) throw new Error(`Label "${args.label}" não encontrado`);
        return l;
      };
      const guard = (l) => (l.project_id ? guardProject(l.project_id, 'manage') : guardAdmin());
      switch (args.action) {
        case 'list':
          return list.length ? list.map((l) => `[${l.id}] ${l.name} ${l.color}${l.project_id ? '' : ' (todos os projetos)'} · ${l.usage} tarefa(s)${l.description ? ` — ${l.description}` : ''}`).join('\n') : 'Nenhum label.';
        case 'create': {
          if (project) guardProject(project, 'manage'); else guardAdmin();
          const l = store.createLabel({ project_id: project?.id ?? null, name: args.name, color: args.color, description: args.description });
          return `Label criado: [${l.id}] ${l.name} ${l.color}`;
        }
        case 'update': { const l = find(); guard(l); const u = store.updateLabel(l.id, args); return `Label atualizado: ${u.name} ${u.color}`; }
        case 'delete': { const l = find(); guard(l); store.deleteLabel(l.id); return `Label "${l.name}" excluído e removido das tarefas.`; }
        default: throw new Error('Ação inválida');
      }
    },
  },

  manage_fields: {
    title: 'Gerenciar campos personalizados',
    description: 'List, create, update or delete custom fields (text, number, date, boolean, select, multi_select, user, url). Fields without a project apply to all projects. Set values on tasks with the "fields" parameter of add_tasks/update_task.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        ...projectProps,
        global: { type: 'boolean', description: 'create: field for all projects (admin).' },
        field: { type: 'string', description: 'Existing field name or id (update/delete).' },
        name: { type: 'string' },
        type: { type: 'string', enum: FIELD_TYPES },
        options: { type: 'array', items: { type: 'string' }, description: 'select/multi_select options.' },
        required: { type: 'boolean' },
      },
      required: ['action'],
    },
    run(args) {
      const project = args.global ? null : projectFrom(args, { create: false });
      const list = store.customFields(project?.id);
      const find = () => {
        const s = String(args.field || '').toLowerCase();
        const f = list.find((x) => String(x.id) === s || x.name.toLowerCase() === s);
        if (!f) throw new Error(`Campo "${args.field}" não encontrado`);
        return f;
      };
      const guard = (f) => (f.project_id ? guardProject(f.project_id, 'manage') : guardAdmin());
      switch (args.action) {
        case 'list':
          return list.length ? list.map((f) => `[${f.id}] ${f.name} (${f.type}${f.options.length ? `: ${f.options.join(' | ')}` : ''})${f.required ? ' obrigatório' : ''}${f.project_id ? '' : ' · todos os projetos'}`).join('\n') : 'Nenhum campo personalizado.';
        case 'create': {
          if (project) guardProject(project, 'manage'); else guardAdmin();
          const f = store.createField({ project_id: project?.id ?? null, name: args.name, type: args.type, options: args.options, required: args.required });
          return `Campo criado: [${f.id}] ${f.name} (${f.type})`;
        }
        case 'update': { const f = find(); guard(f); const u = store.updateField(f.id, args); return `Campo atualizado: ${u.name}`; }
        case 'delete': { const f = find(); guard(f); store.deleteField(f.id); return `Campo "${f.name}" excluído (e os valores nas tarefas).`; }
        default: throw new Error('Ação inválida');
      }
    },
  },

  manage_members: {
    title: 'Gerenciar membros e papéis',
    description: 'List or set who has which role (owner, manager, member, viewer) in a project, workspace or organization. Roles cascade: an organization or workspace role applies to the projects inside it. Private projects are visible only to members.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'set', 'remove'] },
        scope: { type: 'string', enum: ['project', 'workspace', 'organization'], description: 'Default project.' },
        ...projectProps,
        target: { type: 'string', description: 'Workspace or organization name/id (when scope is not project).' },
        user: { type: 'string', description: 'Member name, e-mail or "me".' },
        role: { type: 'string', enum: ROLES },
      },
      required: ['action'],
    },
    run(args) {
      const scope = args.scope || 'project';
      let id;
      let label;
      if (scope === 'project') {
        const p = requireProject(args, { create: false, level: args.action === 'list' ? 'read' : 'manage' });
        [id, label] = [p.id, `projeto ${p.name}`];
      } else {
        const s = String(args.target || '').toLowerCase();
        const row = scope === 'workspace'
          ? store.workspaces().find((w) => String(w.id) === s || w.name.toLowerCase() === s)
          : store.organizations().find((o) => String(o.id) === s || o.name.toLowerCase() === s);
        if (!row) throw new Error(`${scope === 'workspace' ? 'Workspace' : 'Organização'} "${args.target}" não encontrado(a)`);
        const orgId = scope === 'workspace' ? row.organization_id : row.id;
        if (args.action !== 'list' && !store.canManageOrg(actingUser(), orgId)) throw new Error('Só administradores e gerentes da organização mudam membros aqui');
        [id, label] = [row.id, `${scope === 'workspace' ? 'workspace' : 'organização'} ${row.name}`];
      }
      if (args.action !== 'list') {
        const uid = userIds([args.user])[0];
        const role = args.action === 'remove' ? null : (args.role || 'member');
        store.assertOwnerChange(actingUser(), scope, id, uid, role);
        store.setMember(scope, id, uid, role);
      }
      const members = store.members(scope, id);
      return members.length
        ? `Membros do ${label}:\n${members.map((m) => `- ${m.name} <${m.email}>: ${ROLE_LABEL[m.role]}`).join('\n')}`
        : `Ninguém com papel explícito no ${label} (vale o papel da conta de cada pessoa).`;
    },
  },

  manage_workspaces: {
    title: 'Gerenciar organizações e workspaces',
    description: 'List, create, update or delete organizations and workspaces (workspaces can be nested). Projects live in workspaces; move a project with manage_project workspace.',
    annotations: DESTRUCTIVE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        kind: { type: 'string', enum: ['workspace', 'organization'], description: 'Default workspace.' },
        target: { type: 'string', description: 'Existing workspace/organization name or id (update/delete).' },
        name: { type: 'string' },
        description: { type: 'string' },
        color: { type: 'string' },
        organization: { type: 'string', description: 'create workspace: organization name/id (default the first).' },
        parent: { type: ['string', 'null'], description: 'Workspace parent name/id (nesting); null moves to the top.' },
        website: { type: 'string', description: 'Organization website.' },
      },
      required: ['action'],
    },
    run(args) {
      const kind = args.kind || 'workspace';
      const orgs = store.organizations();
      const wss = store.workspaces();
      const findOrg = (ref) => {
        const s = String(ref ?? '').toLowerCase();
        const o = orgs.find((x) => String(x.id) === s || x.name.toLowerCase() === s);
        if (!o) throw new Error(`Organização "${ref}" não encontrada`);
        return o;
      };
      const findWs = (ref) => {
        const s = String(ref ?? '').toLowerCase();
        const w = wss.find((x) => String(x.id) === s || x.name.toLowerCase() === s);
        if (!w) throw new Error(`Workspace "${ref}" não encontrado`);
        return w;
      };
      if (args.action === 'list') {
        const tree = (org, parent, depth) => wss.filter((w) => w.organization_id === org && (w.parent_id ?? null) === parent)
          .flatMap((w) => [`${'  '.repeat(depth)}- [${w.id}] ${w.name} (${w.project_count} projeto(s))${w.archived_at ? ' arquivado' : ''}`, ...tree(org, w.id, depth + 1)]);
        return orgs.map((o) => [`# [${o.id}] ${o.name}`, ...tree(o.id, null, 0)].join('\n')).join('\n\n');
      }
      if (kind === 'organization') {
        if (args.action === 'create') { guardAdmin(); const o = store.createOrganization(args); return `Organização criada: [${o.id}] ${o.name} (com o workspace "Geral")`; }
        const o = findOrg(args.target);
        if (!store.canManageOrg(actingUser(), o.id)) throw new Error('Sem permissão para gerenciar esta organização');
        if (args.action === 'update') return `Organização atualizada: ${store.updateOrganization(o.id, args).name}`;
        guardAdmin();
        store.deleteOrganization(o.id);
        return `Organização "${o.name}" excluída.`;
      }
      if (args.action === 'create') {
        const org = args.organization ? findOrg(args.organization) : orgs[0];
        if (!store.canManageOrg(actingUser(), org.id)) throw new Error('Sem permissão para criar workspaces nesta organização');
        const w = store.createWorkspace({ ...args, organization_id: org.id, parent_id: args.parent ? findWs(args.parent).id : null });
        return `Workspace criado: [${w.id}] ${w.name} em ${org.name}`;
      }
      const w = findWs(args.target);
      if (!store.canManageOrg(actingUser(), w.organization_id)) throw new Error('Sem permissão para gerenciar este workspace');
      if (args.action === 'update') {
        const patch = { ...args };
        if (args.parent !== undefined) patch.parent_id = args.parent ? findWs(args.parent).id : null;
        return `Workspace atualizado: ${store.updateWorkspace(w.id, patch).name}`;
      }
      store.deleteWorkspace(w.id);
      return `Workspace "${w.name}" excluído (projetos e sub-workspaces subiram um nível).`;
    },
  },

  share_link: {
    title: 'Link público',
    description: 'Create, list or revoke a public read-only link for a task or project (anyone with the link can view it without logging in).',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'revoke'] },
        task_id: { type: ['integer', 'string'], description: 'Task to share.' },
        ...projectProps,
        days: { type: ['integer', 'null'], description: 'Validity in days; omit for no expiration.' },
        token: { type: 'string', description: 'revoke: the link token.' },
      },
      required: ['action'],
    },
    run(args) {
      const base = store.publicUrl();
      let kind;
      let target;
      if (args.task_id) {
        kind = 'task';
        const t = guardTask(args.task_id, args.action === 'list' ? 'read' : 'edit');
        if (args.action === 'create' && store.project(t.project_id).visibility === 'private') guardProject(t.project_id, 'manage');
        target = t.id;
      }
      else if (args.action !== 'revoke') { kind = 'project'; target = requireProject(args, { create: false, level: 'manage' }).id; }
      if (args.action === 'revoke') {
        const s = store.share(args.token) || store.db.prepare('SELECT * FROM shares WHERE token = ?').get(args.token);
        if (!s) throw new Error('Link não encontrado');
        if (s.kind === 'task') guardTask(s.target_id, 'edit'); else guardProject(s.target_id, 'manage');
        store.revokeShare(args.token);
        return 'Link revogado.';
      }
      if (args.action === 'create') {
        if (kind === 'project' && store.project(target).visibility !== 'public') throw new Error('Para compartilhar um projeto inteiro, mude a visibilidade dele para "public" (manage_project).');
        const s = store.createShare(kind, target, { days: args.days }, { user_id: me()?.id });
        return `Link público: ${base}/s/${s.token}${s.expires_at ? ` (expira em ${s.expires_at.slice(0, 10)})` : ' (sem validade)'}`;
      }
      const list = store.shares(kind, target);
      return list.length ? list.map((s) => `${base}/s/${s.token} · criado ${s.created_at.slice(0, 10)}${s.expires_at ? ` · expira ${s.expires_at.slice(0, 10)}` : ''}`).join('\n') : 'Nenhum link ativo.';
    },
  },

  search: {
    title: 'Busca universal',
    description: 'Search everything at once: tasks (also by code like WEB-12), comments, projects, sprints, labels, people and workspaces.',
    annotations: READ,
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Per group, default 8.' } }, required: ['query'] },
    run({ query, limit }) {
      const r = store.search(query, { project_ids: visible(), limit: limit || 8 });
      const out = [];
      if (r.tasks.length) out.push('## Tarefas', ...r.tasks.map((t) => `- ${formatTask(t, { withProject: true })}`));
      if (r.comments.length) out.push('## Comentários', ...r.comments.map((c) => `- em #${c.task_id} ${c.title}: "${c.body.slice(0, 100)}${c.body.length > 100 ? '…' : ''}"`));
      if (r.projects.length) out.push('## Projetos', ...r.projects.map((p) => `- [${p.id}] ${p.name}${p.key ? ` (${p.key})` : ''}${p.archived_at ? ' arquivado' : ''}`));
      if (r.sprints.length) out.push('## Sprints', ...r.sprints.map((s) => `- #${s.id} ${s.name} (${s.project_name}) [${s.status}]`));
      if (r.labels.length) out.push('## Labels', ...r.labels.map((l) => `- ${l.name} ${l.color}`));
      if (r.people.length) out.push('## Pessoas', ...r.people.map((u) => `- ${u.name} <${u.email}>`));
      if (r.workspaces.length) out.push('## Workspaces', ...r.workspaces.map((w) => `- [${w.id}] ${w.name}`));
      return out.length ? out.join('\n') : `Nada encontrado para "${query}".`;
    },
  },

  export_tasks: {
    title: 'Exportar tarefas',
    description: 'Export tasks as CSV (opens in Excel/Sheets) or JSON. Writes to a file when path is given; otherwise returns the content.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        status: { type: 'string', enum: ['open', 'all', 'todo', 'doing', 'blocked', 'done'], description: 'Default all.' },
        format: { type: 'string', enum: ['csv', 'json'], description: 'Default csv.' },
        path: { type: 'string', description: 'Absolute file path to write (recommended for big exports).' },
      },
    },
    run(args) {
      const project = projectFrom(args, { create: false });
      const tasks = store.listTasks({ project_id: project?.id, project_ids: project ? undefined : visible(), status: args.status || 'all', limit: 5000 });
      const content = args.format === 'json' ? JSON.stringify(tasks, null, 2) : exportCsv(store, tasks);
      if (args.path) {
        writeFileSync(args.path, content);
        return `${tasks.length} tarefa(s) exportada(s) para ${args.path}`;
      }
      return content.length > 60000 ? `${content.slice(0, 60000)}\n… (cortado: use path para exportar tudo)` : content;
    },
  },

  import_tasks: {
    title: 'Importar tarefas',
    description: 'Import tasks into a project from a CSV file (generic or Jira export), a Trello board JSON export, the Jira Cloud API or the Trello API. Re-importing updates tasks already imported (matched by external id) instead of duplicating.',
    annotations: EXTERNAL,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        source: { type: 'string', enum: ['csv', 'trello_file', 'jira_api', 'trello_api'] },
        path: { type: 'string', description: 'csv / trello_file: absolute path of the file.' },
        site: { type: 'string', description: 'jira_api: https://empresa.atlassian.net' },
        email: { type: 'string', description: 'jira_api: account e-mail.' },
        token: { type: 'string', description: 'jira_api: API token · trello_api: token.' },
        jql: { type: 'string', description: 'jira_api: filter, e.g. project = WEB AND statusCategory != Done' },
        board: { type: 'string', description: 'trello_api: board URL or id.' },
        key: { type: 'string', description: 'trello_api: API key.' },
        save: { type: 'boolean', description: 'API sources: save the connection to re-sync later from the dashboard.' },
      },
      required: ['source'],
    },
    async run(args) {
      const project = requireProject(args, { level: 'manage' });
      let r;
      if (args.source === 'csv') r = importCsv(store, project.id, readFileSync(args.path, 'utf8'), { actor: CLAUDE });
      else if (args.source === 'trello_file') r = importTrelloBoard(store, project.id, JSON.parse(readFileSync(args.path, 'utf8')), { actor: CLAUDE });
      else if (args.source === 'jira_api') r = importJiraIssues(store, project.id, await fetchJira(args), { actor: CLAUDE });
      else r = importTrelloBoard(store, project.id, await fetchTrello(args), { actor: CLAUDE });
      if (args.save && (args.source === 'jira_api' || args.source === 'trello_api')) {
        const kind = args.source === 'jira_api' ? 'jira' : 'trello';
        const config = kind === 'jira'
          ? { site: args.site, email: args.email, jql: args.jql, token: store.secret(args.token) }
          : { board: args.board, key: args.key, token: store.secret(args.token) };
        store.db.prepare('INSERT INTO external_syncs (project_id, kind, config, last_sync_at, last_result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(project.id, kind, JSON.stringify(config), new Date().toISOString(), JSON.stringify(r), new Date().toISOString());
      }
      return `Importação em ${project.name}: ${r.created} criada(s), ${r.updated} atualizada(s), ${r.skipped} ignorada(s)${r.errors.length ? `\nErros:\n- ${r.errors.slice(0, 20).join('\n- ')}` : ''}\n${boardLink(project)}`;
    },
  },

  code_map: {
    title: 'Mapa do código',
    description: 'Look things up in a project\'s code map (made by the "mapa-do-codigo" plugin into the mapa-do-codigo/ folder): status, an overview of the parts, find a part/file/endpoint/function by name or text, show one item with what uses it and what it uses, the path between two items, or the last Breakscale load simulation (where the system breaks as traffic grows). Use it before searching the code from scratch when the project has a map. To create or update the map, use the mapa-do-codigo skill ("faça o mapa do código"); to simulate, ask it to "simule este projeto no Breakscale". Answers are in Portuguese.',
    annotations: READ,
    inputSchema: {
      type: 'object',
      properties: {
        ...projectProps,
        action: { type: 'string', enum: ['status', 'overview', 'find', 'show', 'path', 'simulacao'], description: 'Default status. simulacao = the last Breakscale simulation: scenarios, bottlenecks, assumptions.' },
        query: { type: 'string', description: 'find: text to look for · show: id, file path or "METHOD /path" of the item.' },
        from: { type: 'string', description: 'path: starting item (id, file or endpoint).' },
        to: { type: 'string', description: 'path: target item.' },
      },
    },
    async run(args) {
      const project = requireProject(args, { create: false, level: 'read' });
      const s = mapStatus(project);
      const action = args.action || 'status';
      if (!s.available) return `${project.name}: ${s.reason}.`;
      if (!s.exists) return `${project.name} ainda não tem mapa do código. Para criar, use o skill mapa-do-codigo na pasta ${project.path} ("faça o mapa do código deste projeto"). Depois ele aparece na aba "Mapa do código" do painel: ${boardLink(project)}&view=mapa`;
      if (action === 'status') {
        return [
          `Mapa do código de ${project.name}${s.blueprint ? ' (planta: planejado a partir de um documento)' : ''}`,
          `Pasta: ${s.folder}`,
          `Gerado em ${s.generated_at?.slice(0, 16).replace('T', ' ') || '?'} pelo ${s.agent === 'codex' ? 'Codex' : 'Claude'}`,
          `${s.parts ?? '?'} partes · ${s.files ?? '?'} arquivos · ${s.endpoints ?? 0} endpoints · ${s.screens ?? 0} telas`,
          `Saúde: ${s.health.total} aviso(s), ${s.health.high} importante(s)${s.recent ? ` · ${s.recent} item(ns) de trabalho recente` : ''}`,
          s.simulation ? `Simulação no Breakscale: ${s.simulation.bottlenecks} gargalo(s), ${s.simulation.urgent} urgente(s), feita em ${s.simulation.generated_at?.slice(0, 16).replace('T', ' ') || '?'} (action "simulacao" para ver)` : 'Simulação no Breakscale: nenhuma ainda',
          `No painel: ${boardLink(project)}&view=mapa`,
        ].join('\n');
      }
      if (action === 'simulacao') return simulationText(project);
      const cmd = { overview: ['overview'], find: ['find', args.query], show: ['show', args.query], path: ['path', args.from, args.to] }[action];
      if (cmd.slice(1).some((x) => !String(x ?? '').trim())) throw new Error(action === 'path' ? 'Informe from e to' : 'Informe query');
      return queryMap(project, cmd);
    },
  },

  show_in_dashboard: {
    title: 'Abrir no painel',
    description: 'Open a task, project or view on the user\'s dashboard screen (if it is open). Use when the user asks to "show" or "open" something.',
    annotations: WRITE,
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: ['integer', 'string'] },
        ...projectProps,
        view: { type: 'string', enum: ['board', 'list', 'calendar', 'gantt', 'dashboard', 'activity', 'mapa'], description: 'mapa = the project\'s "Mapa do código" tab.' },
      },
    },
    run(args) {
      const cmd = {};
      if (args.task_id) { const t = guardTask(args.task_id); cmd.task = t.id; cmd.project = t.project_id; }
      const p = projectFrom(args, { create: false });
      if (p) cmd.project = p.id;
      if (args.view) cmd.view = args.view;
      if (!Object.keys(cmd).length) throw new Error('Diga o que abrir: task_id, project ou view');
      store.pushUiCommand(me()?.id ?? null, cmd);
      return `Pedido enviado ao painel${cmd.task ? `: tarefa #${cmd.task}` : ''}. Se o painel não estiver aberto: ${cmd.task ? taskLink(cmd.task) : p ? boardLink(p) : boardLink()}`;
    },
  },

  manage_inbox: {
    title: 'Caixa de entrada por e-mail',
    description: 'Configure a project inbox that turns incoming e-mails into tasks (IMAP), see received messages or sync now. Replies to task e-mails ("[#12]" in the subject) become comments.',
    annotations: EXTERNAL,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'configure', 'sync', 'messages'] },
        ...projectProps,
        enabled: { type: 'boolean' },
        address: { type: 'string', description: 'The inbox e-mail address shown to people.' },
        imap_host: { type: 'string' },
        imap_port: { type: 'integer' },
        imap_secure: { type: 'boolean', description: 'TLS (default true).' },
        imap_user: { type: 'string' },
        imap_pass: { type: 'string' },
        mailbox: { type: 'string', description: 'Default INBOX.' },
        default_priority: { type: 'string' },
        default_type: { type: 'string' },
        auto_reply: { type: 'boolean' },
        auto_reply_template: { type: 'string', description: 'Text with {id} {titulo} {link}.' },
        sync_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
      },
      required: ['action'],
    },
    async run(args) {
      const { inboxSummary, saveInbox, syncInbox } = await import('../inbox.js');
      const project = requireProject(args, { create: false, level: args.action === 'messages' || args.action === 'get' ? 'read' : 'manage' });
      if (args.action === 'configure') {
        saveInbox(store, project.id, args);
        return inboxSummary(store, project.id);
      }
      if (args.action === 'sync') {
        const r = await syncInbox(store, project.id);
        return `Sincronizado: ${r.tasks} tarefa(s) e ${r.comments} comentário(s) novos, ${r.ignored} ignorada(s), ${r.errors} erro(s).`;
      }
      if (args.action === 'messages') {
        const inbox = store.db.prepare('SELECT id FROM inboxes WHERE project_id = ?').get(project.id);
        if (!inbox) return 'Este projeto não tem caixa de entrada configurada.';
        const rows = store.db.prepare('SELECT * FROM inbox_messages WHERE inbox_id = ? ORDER BY id DESC LIMIT 30').all(inbox.id);
        return rows.length ? rows.map((m) => `- ${m.received_at?.slice(0, 16) || ''} ${m.from_name || m.from_address}: ${m.subject} → ${m.status}${m.task_id ? ` #${m.task_id}` : ''}${m.error ? ` (${m.error})` : ''}`).join('\n') : 'Nenhuma mensagem recebida ainda.';
      }
      return inboxSummary(store, project.id);
    },
  },
};

