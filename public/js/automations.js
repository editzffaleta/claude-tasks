// Página de automações: regras "quando X → faça Y", com modelos prontos.
import { api, attempt } from './api.js';
import { state } from './state.js';
import { confirmAction, openDialog } from './ui.js';
import { ICON, PRIORITIES, PRIORITY_LABEL, STATUSES, STATUS_LABEL, TYPES, TYPE_LABEL, ago, esc } from './util.js';

const TRIGGERS = {
  task_created: 'uma tarefa for criada',
  status_changed: 'o status mudar',
  priority_changed: 'a prioridade mudar',
  comment_added: 'alguém comentar',
  assigned: 'alguém for atribuído',
  due_soon: 'o prazo estiver chegando',
  overdue: 'o prazo vencer',
};

const ACTIONS = {
  set_status: 'Mudar status para',
  set_priority: 'Mudar prioridade para',
  add_tag: 'Adicionar a tag',
  remove_tag: 'Remover a tag',
  add_comment: 'Comentar',
  notify: 'Notificar',
  set_due_in_days: 'Definir prazo para daqui a',
  move_to_active_sprint: 'Mover para a sprint ativa',
  assign: 'Atribuir a',
};

const TEMPLATES = [
  { name: 'Bloqueou → prioridade alta', trigger: 'status_changed', conditions: { to_status: 'blocked' }, action: { type: 'set_priority', value: 'high' } },
  { name: 'Avisar 1 dia antes do prazo', trigger: 'due_soon', conditions: { days: 1 }, action: { type: 'notify', value: 'Vence logo: {id} {titulo} ({prazo})' } },
  { name: 'Atrasou → tag "atrasada"', trigger: 'overdue', conditions: {}, action: { type: 'add_tag', value: 'atrasada' } },
  { name: 'Bug novo → prioridade alta', trigger: 'task_created', conditions: { type: ['bug'] }, action: { type: 'set_priority', value: 'high' } },
  { name: 'Tarefa do Claude → sprint ativa', trigger: 'task_created', conditions: { by_claude: true }, action: { type: 'move_to_active_sprint' } },
];

const isAdmin = () => !state.me || state.me.role === 'admin';

function describe(r) {
  const c = r.conditions || {};
  const cond = [];
  if (c.to_status) cond.push(`para <b>${STATUS_LABEL[c.to_status]}</b>`);
  if (c.from_status) cond.push(`saindo de <b>${STATUS_LABEL[c.from_status]}</b>`);
  if (c.priority?.length) cond.push(`com prioridade <b>${c.priority.map((p) => PRIORITY_LABEL[p]).join('/')}</b>`);
  if (c.type?.length) cond.push(`do tipo <b>${c.type.map((t) => TYPE_LABEL[t]).join('/')}</b>`);
  if (c.tag) cond.push(`com a tag <b>${esc(c.tag)}</b>`);
  if (c.by_claude) cond.push('<b>criada pelo Claude</b>');
  if (r.trigger === 'due_soon') cond.push(`(<b>${c.days ?? 1}</b> dia(s) antes)`);
  const a = r.action;
  let value = '';
  if (a.type === 'set_status') value = STATUS_LABEL[a.value];
  else if (a.type === 'set_priority') value = PRIORITY_LABEL[a.value];
  else if (a.type === 'set_due_in_days') value = `${a.value} dia(s)`;
  else if (a.type === 'assign') value = a.value;
  else if (a.type !== 'move_to_active_sprint') value = `“${a.value}”`;
  return `Quando ${TRIGGERS[r.trigger]} ${cond.join(' ')} em <b>${r.project_name ? esc(r.project_name) : 'todos os projetos'}</b> → ${ACTIONS[a.type]} <b>${esc(value)}</b>`;
}

export async function renderAutomations(el) {
  const rules = await attempt(() => api('/api/automations'));
  if (!rules) return;
  const admin = isAdmin();
  el.innerHTML = `
    <div class="page">
      ${admin ? '' : '<p class="notice">Só administradores podem criar ou editar automações.</p>'}
      <div class="page-actions">
        ${admin ? `<button class="btn primary" data-new>${ICON.plus} Nova automação</button>` : ''}
        <span class="hint">As regras valem para mudanças feitas por você, pela equipe e pelo Claude. Mudanças feitas por automações não disparam outras automações.</span>
      </div>
      ${admin ? `
        <div class="templates">
          <span class="muted small">Modelos:</span>
          ${TEMPLATES.map((t, i) => `<button class="chip-btn" data-template="${i}">${ICON.zap}${esc(t.name)}</button>`).join('')}
        </div>` : ''}
      <div class="rule-list">
        ${rules.map((r) => `
          <div class="rule ${r.enabled ? '' : 'off'}">
            <label class="switch" title="${r.enabled ? 'Ativa' : 'Pausada'}"><input type="checkbox" data-toggle="${r.id}" ${r.enabled ? 'checked' : ''} ${admin ? '' : 'disabled'}><span></span></label>
            <div class="rule-main">
              <b>${esc(r.name)}</b>
              <p>${describe(r)}</p>
              <span class="muted small">${r.run_count ? `executada ${r.run_count} vez(es) · última ${ago(r.last_run_at)}` : 'ainda não executou'}</span>
            </div>
            ${admin ? `
              <button class="icon-btn small" data-edit="${r.id}" aria-label="Editar">${ICON.edit}</button>
              <button class="icon-btn small" data-delete="${r.id}" aria-label="Excluir">${ICON.trash}</button>` : ''}
          </div>`).join('') || `<div class="empty-box">${ICON.zap}<p>Nenhuma automação ainda.</p><p class="muted small">Comece por um modelo acima ou crie a sua.</p></div>`}
      </div>
    </div>`;

  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.new !== undefined) editor(el);
    if (b.dataset.template) editor(el, TEMPLATES[Number(b.dataset.template)]);
    if (b.dataset.edit) editor(el, rules.find((r) => r.id === Number(b.dataset.edit)));
    if (b.dataset.delete) {
      if (await confirmAction('Excluir esta automação?', { okLabel: 'Excluir' })) {
        if (await attempt(() => api(`/api/automations/${b.dataset.delete}`, { method: 'DELETE' }), 'Automação excluída')) renderAutomations(el);
      }
    }
  };
  el.onchange = async (e) => {
    const id = e.target.dataset.toggle;
    if (!id) return;
    if (await attempt(() => api(`/api/automations/${id}`, { method: 'PATCH', body: { enabled: e.target.checked } }))) renderAutomations(el);
  };
}

function editor(el, rule = {}) {
  const c = rule.conditions || {};
  const a = rule.action || { type: 'set_priority', value: 'high' };
  const opt = (v, l, sel) => `<option value="${v}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(l)}</option>`;
  openDialog({
    title: rule.id ? 'Editar automação' : 'Nova automação',
    submitLabel: rule.id ? 'Salvar' : 'Criar automação',
    wide: true,
    body: `
      <label class="field"><span>Nome</span><input class="input" name="name" required maxlength="120" value="${esc(rule.name || '')}" placeholder="ex.: Bloqueou → prioridade alta"></label>
      <div class="field-row">
        <label class="field"><span>Projeto</span><select class="input" name="project_id">${opt('', 'Todos os projetos', rule.project_id || '')}${state.projects.filter((p) => !p.archived_at).map((p) => opt(p.id, p.name, rule.project_id)).join('')}</select></label>
        <label class="field"><span>Quando</span><select class="input" name="trigger">${Object.entries(TRIGGERS).map(([k, l]) => opt(k, l[0].toUpperCase() + l.slice(1), rule.trigger || 'status_changed')).join('')}</select></label>
      </div>
      <fieldset class="conditions">
        <legend>Condições (opcionais)</legend>
        <div class="field-row">
          <label class="field" data-for="status_changed"><span>Novo status</span><select class="input" name="to_status">${opt('', 'Qualquer', c.to_status)}${STATUSES.map((s) => opt(s, STATUS_LABEL[s], c.to_status)).join('')}</select></label>
          <label class="field" data-for="status_changed"><span>Status anterior</span><select class="input" name="from_status">${opt('', 'Qualquer', c.from_status)}${STATUSES.map((s) => opt(s, STATUS_LABEL[s], c.from_status)).join('')}</select></label>
          <label class="field" data-for="due_soon"><span>Dias antes do prazo</span><input class="input" type="number" min="0" max="60" name="days" value="${c.days ?? 1}"></label>
          <label class="field"><span>Prioridade</span><select class="input" name="priority">${opt('', 'Qualquer', c.priority?.[0])}${PRIORITIES.map((p) => opt(p, PRIORITY_LABEL[p], c.priority?.[0])).join('')}</select></label>
          <label class="field"><span>Tipo</span><select class="input" name="type">${opt('', 'Qualquer', c.type?.[0])}${TYPES.map((t) => opt(t, TYPE_LABEL[t], c.type?.[0])).join('')}</select></label>
          <label class="field"><span>Com a tag</span><input class="input" name="tag" value="${esc(c.tag || '')}"></label>
        </div>
        <label class="check"><input type="checkbox" name="by_claude" ${c.by_claude ? 'checked' : ''}><span>Só tarefas criadas pelo Claude</span></label>
      </fieldset>
      <div class="field-row">
        <label class="field"><span>Então</span><select class="input" name="action">${Object.entries(ACTIONS).map(([k, l]) => opt(k, l, a.type)).join('')}</select></label>
        <label class="field" data-act="set_status"><span>Status</span><select class="input" name="v_status">${STATUSES.map((s) => opt(s, STATUS_LABEL[s], a.value)).join('')}</select></label>
        <label class="field" data-act="set_priority"><span>Prioridade</span><select class="input" name="v_priority">${PRIORITIES.map((p) => opt(p, PRIORITY_LABEL[p], a.value)).join('')}</select></label>
        <label class="field" data-act="add_tag remove_tag"><span>Tag</span><input class="input" name="v_tag" value="${esc(['add_tag', 'remove_tag'].includes(a.type) ? a.value : '')}"></label>
        <label class="field" data-act="set_due_in_days"><span>Dias</span><input class="input" type="number" min="0" max="365" name="v_days" value="${a.type === 'set_due_in_days' ? a.value : 3}"></label>
        <label class="field" data-act="assign"><span>Pessoa</span><select class="input" name="v_user">${state.users.map((u) => opt(u.email, u.name, a.value)).join('')}</select></label>
      </div>
      <label class="field" data-act="add_comment notify"><span>Mensagem</span>
        <textarea class="input" name="v_text" rows="2">${esc(['add_comment', 'notify'].includes(a.type) ? a.value : '')}</textarea>
        <small class="hint">Use {id}, {titulo}, {projeto}, {prazo}, {status} e {prioridade}.</small>
      </label>`,
    onOpen: (form) => {
      const sync = () => {
        const trigger = form.elements.trigger.value;
        const action = form.elements.action.value;
        form.querySelectorAll('[data-for]').forEach((n) => { n.hidden = n.dataset.for !== trigger; });
        form.querySelectorAll('[data-act]').forEach((n) => { n.hidden = !n.dataset.act.split(' ').includes(action); });
      };
      form.elements.trigger.onchange = sync;
      form.elements.action.onchange = sync;
      sync();
    },
    onSubmit: async (form) => {
      const f = form.elements;
      const type = f.action.value;
      const value = {
        set_status: f.v_status.value,
        set_priority: f.v_priority.value,
        add_tag: f.v_tag.value.trim(),
        remove_tag: f.v_tag.value.trim(),
        add_comment: f.v_text.value.trim(),
        notify: f.v_text.value.trim(),
        set_due_in_days: Number(f.v_days.value),
        assign: f.v_user?.value,
        move_to_active_sprint: null,
      }[type];
      const conditions = {};
      if (f.trigger.value === 'status_changed') {
        if (f.to_status.value) conditions.to_status = f.to_status.value;
        if (f.from_status.value) conditions.from_status = f.from_status.value;
      }
      if (f.trigger.value === 'due_soon') conditions.days = Number(f.days.value);
      if (f.priority.value) conditions.priority = [f.priority.value];
      if (f.type.value) conditions.type = [f.type.value];
      if (f.tag.value.trim()) conditions.tag = f.tag.value.trim();
      if (f.by_claude.checked) conditions.by_claude = true;
      const body = { name: f.name.value, project_id: f.project_id.value ? Number(f.project_id.value) : null, trigger: f.trigger.value, conditions, action: { type, value } };
      const ok = await attempt(() => (rule.id
        ? api(`/api/automations/${rule.id}`, { method: 'PATCH', body })
        : api('/api/automations', { method: 'POST', body })), rule.id ? 'Automação salva' : 'Automação criada');
      if (!ok) return false;
      renderAutomations(el);
    },
  });
}
