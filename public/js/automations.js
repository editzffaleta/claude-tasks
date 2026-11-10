// Página de automações: regras "quando X → faça Y", com modelos prontos.
import { api, attempt } from './api.js';
import { N_, t, tn } from './i18n.js';
import { can, isAdmin, state } from './state.js';
import { confirmAction, openDialog } from './ui.js';
import { ICON, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, TYPES, TYPE_LABEL, ago, columnLabel, esc } from './util.js';

// Textos completam a frase "Quando …" (veja describe()).
const TRIGGERS = /* i18n */ {
  task_created: 'uma tarefa for criada',
  task_updated: 'uma tarefa for atualizada',
  status_changed: 'o status mudar',
  priority_changed: 'a prioridade mudar',
  comment_added: 'alguém comentar',
  assigned: 'alguém for atribuído',
  due_soon: 'o prazo estiver chegando',
  overdue: 'o prazo vencer',
  sprint_started: 'uma sprint começar',
  sprint_completed: 'uma sprint terminar',
  project_created: 'um projeto for criado',
};
const SPRINT_TRIGGERS = ['sprint_started', 'sprint_completed'];
const MESSAGE_ACTIONS = ['notify', 'send_email'];

// Seguidos do valor da ação: "Mudar status para Concluída".
const ACTIONS = /* i18n */ {
  set_status: 'Mudar status para',
  set_column: 'Mover para a coluna',
  set_priority: 'Mudar prioridade para',
  add_tag: 'Adicionar a label',
  remove_tag: 'Remover a label',
  add_comment: 'Comentar',
  notify: 'Notificar',
  send_email: 'Enviar e-mail',
  set_due_in_days: 'Definir prazo para daqui a',
  move_to_active_sprint: 'Mover para a sprint ativa',
  move_to_sprint: 'Mover para a sprint',
  assign: 'Atribuir a',
};

// Campos que o gatilho "tarefa atualizada" pode observar (nomes das colunas no banco).
const FIELDS = /* i18n */ {
  title: 'Título', description: 'Descrição', status: 'Status', priority: 'Prioridade', type: 'Tipo', tags: 'Labels', due_date: 'Prazo',
  start_date: 'Início', story_points: 'Pontos', estimate_minutes: 'Estimativa', sprint_id: 'Sprint', column_id: 'Coluna', reporter_id: 'Relator',
};

// Modelos: nome, label e mensagens são traduzidos ao abrir o editor (as variáveis {ref}, {titulo}…
// são do servidor e ficam como estão em qualquer idioma).
const TEMPLATES = [
  { name: N_('Bloqueou → prioridade alta'), trigger: 'status_changed', conditions: { to_status: 'blocked' }, action: { type: 'set_priority', value: 'high' } },
  { name: N_('Avisar 1 dia antes do prazo'), trigger: 'due_soon', conditions: { days: 1 }, action: { type: 'notify', value: N_('Vence logo: {ref} {titulo} ({prazo})') } },
  { name: N_('Atrasou → label "atrasada"'), trigger: 'overdue', conditions: {}, action: { type: 'add_tag', value: N_('atrasada') } },
  { name: N_('Bug novo → prioridade alta'), trigger: 'task_created', conditions: { type: ['bug'] }, action: { type: 'set_priority', value: 'high' } },
  { name: N_('Tarefa de um agente → sprint ativa'), trigger: 'task_created', conditions: { by_claude: true }, action: { type: 'move_to_active_sprint' } },
  { name: N_('Sprint terminou → avisar a equipe'), trigger: 'sprint_completed', conditions: {}, action: { type: 'notify', value: N_('A sprint {sprint} de {projeto} terminou') } },
  { name: N_('Concluída → e-mail para quem acompanha'), trigger: 'status_changed', conditions: { to_status: 'done' }, action: { type: 'send_email', to: 'followers', value: N_('{ref} {titulo} foi concluída.') } },
];

function describe(r) {
  const c = r.conditions || {};
  const b = (x) => `<b>${esc(x)}</b>`;
  const cond = [];
  if (c.to_status) cond.push(t('para {s}', { s: b(STATUS_LABEL[c.to_status]) }));
  if (c.from_status) cond.push(t('saindo de {s}', { s: b(STATUS_LABEL[c.from_status]) }));
  if (c.field) cond.push(t('no campo {f}', { f: b(t(FIELDS[c.field] || c.field)) }));
  if (c.priority?.length) cond.push(t('com prioridade {p}', { p: b(c.priority.map((p) => PRIORITY_LABEL[p]).join('/')) }));
  if (c.type?.length) cond.push(t('do tipo {x}', { x: b(c.type.map((x) => TYPE_LABEL[x]).join('/')) }));
  if (c.tag) cond.push(t('com a label {g}', { g: b(c.tag) }));
  if (c.by_claude) cond.push(b(t('criada por um agente')));
  if (r.trigger === 'due_soon') cond.push(`(${tn(c.days ?? 1, '{n} dia antes', '{n} dias antes')})`);
  const a = r.action;
  let value = '';
  if (a.type === 'set_status') value = STATUS_LABEL[a.value];
  else if (a.type === 'set_priority') value = PRIORITY_LABEL[a.value];
  else if (a.type === 'set_due_in_days') value = tn(Number(a.value), '{n} dia', '{n} dias');
  else if (a.type === 'set_column') {
    const col = state.columns?.find((x) => String(x.id) === String(a.value));
    value = col ? columnLabel(col.name, col.status) : a.value;
  }
  else if (a.type === 'send_email') value = `${a.to === 'assignees' ? t('responsáveis') : !a.to || a.to === 'followers' ? t('quem acompanha') : a.to}: “${a.value}”`;
  else if (['assign', 'move_to_sprint'].includes(a.type)) value = a.value;
  else if (a.type !== 'move_to_active_sprint') value = `“${a.value}”`;
  const where = r.project_name ? b(r.project_name) : b(t('todos os projetos'));
  return t('Quando {trigger} {conditions} em {where} → {action} {value}', {
    trigger: esc(t(TRIGGERS[r.trigger])), conditions: cond.join(' '), where, action: esc(t(ACTIONS[a.type])), value: value ? b(value) : '',
  });
}

// Projetos em que a pessoa pode criar regras (gerente ou dono); admin também cria regras globais.
const manageable = () => state.projects.filter((p) => !p.archived_at && can(p, 'manage'));

export async function renderAutomations(el) {
  const rules = await attempt(() => api('/api/automations'));
  if (!rules) return;
  const admin = isAdmin();
  const creator = admin || manageable().length > 0;
  const canEdit = (r) => (r.project_id ? can(r.project_id, 'manage') : admin);
  el.innerHTML = `
    <div class="page">
      ${creator ? '' : `<p class="notice">${t('Só administradores e gerentes de projeto criam ou editam automações.')}</p>`}
      <div class="page-actions">
        ${creator ? `<button class="btn primary" data-new>${ICON.plus} ${t('Nova automação')}</button>` : ''}
        <span class="hint">${t('As regras valem para mudanças feitas por você, pela equipe e pelo Claude. Mudanças feitas por automações não disparam outras automações.')}</span>
      </div>
      ${creator ? `
        <div class="templates">
          <span class="muted small">${t('Modelos:')}</span>
          ${TEMPLATES.map((x, i) => `<button class="chip-btn" data-template="${i}">${ICON.zap}${esc(t(x.name))}</button>`).join('')}
        </div>` : ''}
      <div class="rule-list">
        ${rules.map((r) => `
          <div class="rule ${r.enabled ? '' : 'off'}">
            <label class="switch" title="${esc(r.enabled ? t('Ativa') : t('Pausada'))}"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} ${canEdit(r) ? '' : 'disabled'}><span></span></label>
            <div class="rule-main">
              <b>${esc(r.name)}</b>
              <p>${describe(r)}</p>
              <span class="muted small">${r.run_count ? esc(tn(r.run_count, 'executada {n} vez · última {when}', 'executada {n} vezes · última {when}', { when: ago(r.last_run_at) })) : t('ainda não executou')}</span>
            </div>
            ${canEdit(r) ? `
              <button class="icon-btn small" data-edit="${r.id}" aria-label="${esc(t('Editar'))}">${ICON.edit}</button>
              <button class="icon-btn small" data-delete="${r.id}" aria-label="${esc(t('Excluir'))}">${ICON.trash}</button>` : ''}
          </div>`).join('') || `<div class="empty-box">${ICON.zap}<p>${t('Nenhuma automação ainda.')}</p><p class="muted small">${t('Comece por um modelo acima ou crie a sua.')}</p></div>`}
      </div>
    </div>`;

  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.new !== undefined) editor(el);
    if (b.dataset.template) editor(el, TEMPLATES[Number(b.dataset.template)]);
    if (b.dataset.edit) editor(el, rules.find((r) => r.id === Number(b.dataset.edit)));
    if (b.dataset.delete) {
      if (await confirmAction(t('Excluir esta automação?'), { okLabel: t('Excluir') })) {
        if (await attempt(() => api(`/api/automations/${b.dataset.delete}`, { method: 'DELETE' }), t('Automação excluída'))) renderAutomations(el);
      }
    }
  };
  el.onchange = async (e) => {
    const id = e.target.dataset.toggle;
    if (!id) return;
    if (await attempt(() => api(`/api/automations/${id}`, { method: 'PATCH', body: { enabled: e.target.checked } }))) renderAutomations(el);
  };
}

async function editor(el, rule = {}) {
  const c = rule.conditions || {};
  const a = rule.action || { type: 'set_priority', value: 'high' };
  const opt = (v, l, sel) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
  const admin = isAdmin();
  const projects = admin ? state.projects.filter((p) => !p.archived_at) : manageable();
  const firstProject = rule.project_id ?? (admin ? '' : projects[0]?.id);
  // Modelo (sem id): textos sugeridos no idioma atual. Regra salva: como foi gravada.
  const suggested = (s) => (!rule.id && rule.name ? t(s) : s);
  const columnsOf = async (pid) => (pid ? (await api(`/api/projects/${pid}/columns`).catch(() => [])).filter((x) => x.id != null) : []);
  const sprintsOf = async (pid) => (pid ? (await api(`/api/projects/${pid}/sprints`).catch(() => [])).filter((x) => !['completed', 'cancelled'].includes(x.status)) : []);
  openDialog({
    title: rule.id ? t('Editar automação') : t('Nova automação'),
    submitLabel: rule.id ? t('Salvar') : t('Criar automação'),
    wide: true,
    body: `
      <label class="field"><span>${t('Nome')}</span><input class="input" name="name" required maxlength="120" value="${esc(suggested(rule.name || ''))}" placeholder="${esc(t('ex.: Bloqueou → prioridade alta'))}"></label>
      <div class="field-row">
        <label class="field"><span>${t('Projeto')}</span><select class="input" name="project_id">${admin ? opt('', t('Todos os projetos'), firstProject) : ''}${projects.map((p) => opt(p.id, p.name, firstProject)).join('')}</select></label>
        <label class="field"><span>${t('Quando')}</span><select class="input" name="trigger">${Object.entries(TRIGGERS).map(([k, l]) => { const x = t(l); return opt(k, x[0].toUpperCase() + x.slice(1), rule.trigger || 'status_changed'); }).join('')}</select></label>
      </div>
      <fieldset class="conditions" data-hide-for="project_created">
        <legend>${t('Condições (opcionais)')}</legend>
        <div class="field-row">
          <label class="field" data-for="status_changed"><span>${t('Novo status')}</span><select class="input" name="to_status">${opt('', t('Qualquer'), c.to_status)}${STATUSES.map((x) => opt(x, STATUS_LABEL[x], c.to_status)).join('')}</select></label>
          <label class="field" data-for="status_changed"><span>${t('Status anterior')}</span><select class="input" name="from_status">${opt('', t('Qualquer'), c.from_status)}${STATUSES.map((x) => opt(x, STATUS_LABEL[x], c.from_status)).join('')}</select></label>
          <label class="field" data-for="task_updated"><span>${t('Campo alterado')}</span><select class="input" name="field">${opt('', t('Qualquer'), c.field)}${Object.entries(FIELDS).map(([k, l]) => opt(k, t(l), c.field)).join('')}</select></label>
          <label class="field" data-for="due_soon"><span>${t('Dias antes do prazo')}</span><input class="input" type="number" min="0" max="60" name="days" value="${c.days ?? 1}"></label>
          <label class="field"><span>${t('Prioridade')}</span><select class="input" name="priority">${opt('', t('Qualquer'), c.priority?.[0])}${PRIORITIES.map((p) => opt(p, PRIORITY_LABEL[p], c.priority?.[0])).join('')}</select></label>
          <label class="field"><span>${t('Tipo')}</span><select class="input" name="type">${opt('', t('Qualquer'), c.type?.[0])}${TYPES.map((x) => opt(x, TYPE_LABEL[x], c.type?.[0])).join('')}</select></label>
          <label class="field"><span>${t('Com a label')}</span><input class="input" name="tag" value="${esc(c.tag || '')}"></label>
        </div>
        <label class="check"><input type="checkbox" name="by_claude" ${c.by_claude ? 'checked' : ''}><span>${t('Só tarefas criadas por um agente (Claude ou Codex)')}</span></label>
        <p class="hint" data-for="sprint_started sprint_completed">${t('Em gatilhos de sprint, as ações de tarefa valem para cada tarefa aberta da sprint.')}</p>
      </fieldset>
      <div class="field-row">
        <label class="field"><span>${t('Então')}</span><select class="input" name="action">${Object.entries(ACTIONS).map(([k, l]) => opt(k, t(l), a.type)).join('')}</select></label>
        <label class="field" data-act="set_status"><span>${t('Status')}</span><select class="input" name="v_status">${STATUSES.map((x) => opt(x, STATUS_LABEL[x], a.value)).join('')}</select></label>
        <label class="field" data-act="set_column"><span>${t('Coluna')}</span><select class="input" name="v_column"></select></label>
        <label class="field" data-act="set_priority"><span>${t('Prioridade')}</span><select class="input" name="v_priority">${PRIORITIES.map((p) => opt(p, PRIORITY_LABEL[p], a.value)).join('')}</select></label>
        <label class="field" data-act="add_tag remove_tag"><span>${t('Label')}</span><input class="input" name="v_tag" value="${esc(['add_tag', 'remove_tag'].includes(a.type) ? suggested(a.value) : '')}"></label>
        <label class="field" data-act="set_due_in_days"><span>${t('Dias')}</span><input class="input" type="number" min="0" max="365" name="v_days" value="${a.type === 'set_due_in_days' ? a.value : 3}"></label>
        <label class="field" data-act="move_to_sprint"><span>${t('Sprint')}</span><select class="input" name="v_sprint"></select></label>
        <label class="field" data-act="assign"><span>${t('Pessoa')}</span><select class="input" name="v_user">${state.users.map((u) => opt(u.email, u.name, a.value)).join('')}</select></label>
        <label class="field" data-act="send_email"><span>${t('Para')}</span><select class="input" name="v_to">
          ${opt('followers', t('Quem acompanha a tarefa'), a.to || 'followers')}${opt('assignees', t('Responsáveis'), a.to)}${opt('custom', t('Endereços específicos…'), a.to && !['followers', 'assignees'].includes(a.to) ? 'custom' : '')}
        </select></label>
      </div>
      <label class="field" data-act="send_email" data-custom-to><span>${t('Endereços (separados por vírgula)')}</span><input class="input" name="v_emails" value="${esc(a.to && !['followers', 'assignees'].includes(a.to) ? a.to : '')}"></label>
      <label class="field" data-act="send_email"><span>${t('Assunto')}</span><input class="input" name="v_subject" value="${esc(a.subject || '')}" placeholder="${esc(t('[{ref}] {titulo}'))}"></label>
      <label class="field" data-act="add_comment notify send_email"><span>${t('Mensagem')}</span>
        <textarea class="input" name="v_text" rows="2">${esc(['add_comment', 'notify', 'send_email'].includes(a.type) ? suggested(a.value || '') : '')}</textarea>
        <small class="hint">${t('Use {ref}, {titulo}, {projeto}, {prazo}, {status}, {prioridade} e {sprint}.')}</small>
      </label>
      ${state.mailEnabled ? '' : `<p class="notice" data-act="send_email">${t('O envio de e-mail ainda não está configurado (Configurações → E-mail). A regra fica salva, mas só envia depois disso.')}</p>`}`,
    onOpen: async (form) => {
      const f = form.elements;
      const fillProjectLists = async () => {
        const pid = f.project_id.value;
        const [cols, sprints] = await Promise.all([columnsOf(pid), sprintsOf(pid)]);
        f.v_column.innerHTML = cols.length ? cols.map((x) => opt(x.id, columnLabel(x.name, x.status), a.type === 'set_column' ? a.value : '')).join('') : opt('', t('Escolha um projeto com colunas próprias'), '');
        f.v_sprint.innerHTML = [opt('active', t('Sprint ativa'), a.value), opt('next', t('Próxima sprint planejada'), a.value), ...sprints.map((x) => opt(x.name, x.name, a.value))].join('');
      };
      const sync = () => {
        const trigger = f.trigger.value;
        const action = f.action.value;
        form.querySelectorAll('[data-for]').forEach((n) => { n.hidden = !n.dataset.for.split(' ').includes(trigger); });
        form.querySelectorAll('[data-hide-for]').forEach((n) => { n.hidden = n.dataset.hideFor === trigger; });
        form.querySelectorAll('[data-act]').forEach((n) => { n.hidden = !n.dataset.act.split(' ').includes(action); });
        form.querySelector('[data-custom-to]').hidden = action !== 'send_email' || f.v_to.value !== 'custom';
        // "Projeto criado" só aceita avisos; gatilhos de sprint não combinam com prazo/sprint ativa.
        for (const o of f.action.options) {
          o.disabled = (trigger === 'project_created' && !MESSAGE_ACTIONS.includes(o.value))
            || (SPRINT_TRIGGERS.includes(trigger) && ['set_due_in_days', 'move_to_active_sprint'].includes(o.value));
        }
        if (f.action.selectedOptions[0]?.disabled) { f.action.value = 'notify'; sync(); }
      };
      f.trigger.onchange = sync;
      f.action.onchange = sync;
      f.v_to.onchange = sync;
      f.project_id.onchange = fillProjectLists;
      sync();
      await fillProjectLists();
    },
    onSubmit: async (form) => {
      const f = form.elements;
      const type = f.action.value;
      const value = {
        set_status: f.v_status.value,
        set_column: f.v_column.value ? Number(f.v_column.value) : '',
        set_priority: f.v_priority.value,
        add_tag: f.v_tag.value.trim(),
        remove_tag: f.v_tag.value.trim(),
        add_comment: f.v_text.value.trim(),
        notify: f.v_text.value.trim(),
        send_email: f.v_text.value.trim(),
        set_due_in_days: Number(f.v_days.value),
        move_to_sprint: f.v_sprint.value,
        assign: f.v_user?.value,
        move_to_active_sprint: null,
      }[type];
      const action = { type, value };
      if (type === 'send_email') {
        action.to = f.v_to.value === 'custom' ? f.v_emails.value.trim() : f.v_to.value;
        if (f.v_subject.value.trim()) action.subject = f.v_subject.value.trim();
      }
      const trigger = f.trigger.value;
      const conditions = {};
      if (trigger === 'status_changed') {
        if (f.to_status.value) conditions.to_status = f.to_status.value;
        if (f.from_status.value) conditions.from_status = f.from_status.value;
      }
      if (trigger === 'task_updated' && f.field.value) conditions.field = f.field.value;
      if (trigger === 'due_soon') conditions.days = Number(f.days.value);
      if (trigger !== 'project_created') {
        if (f.priority.value) conditions.priority = [f.priority.value];
        if (f.type.value) conditions.type = [f.type.value];
        if (f.tag.value.trim()) conditions.tag = f.tag.value.trim();
        if (f.by_claude.checked) conditions.by_claude = true;
      }
      const body = { name: f.name.value, project_id: f.project_id.value ? Number(f.project_id.value) : null, trigger, conditions, action };
      const ok = await attempt(() => (rule.id
        ? api(`/api/automations/${rule.id}`, { method: 'PATCH', body })
        : api('/api/automations', { method: 'POST', body })), rule.id ? t('Automação salva') : t('Automação criada'));
      if (!ok) return false;
      renderAutomations(el);
    },
  });
}
