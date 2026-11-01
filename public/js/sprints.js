// Gerenciador de sprints de um projeto: criar, editar, iniciar, concluir e excluir.
import { api, attempt } from './api.js';
import { t, tn } from './i18n.js';
import { can, load, navigate, state } from './state.js';
import { confirmAction, openDialog } from './ui.js';
import { $, ICON, SPRINT_STATUS_LABEL, esc, fmtDate, fmtNumber } from './util.js';

export async function openSprints(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  let editing = null;

  const { dialog } = openDialog({
    title: `${t('Sprints')} · ${project?.name || ''}`,
    wide: true,
    cancelLabel: t('Fechar'),
    body: `<div id="sprint-body"><div class="empty-small">${t('Carregando…')}</div></div>`,
  });
  const manage = can(projectId, 'manage');
  const body = $('#sprint-body', dialog);

  async function refresh() {
    const sprints = await api(`/api/projects/${projectId}/sprints`);
    const form = (s = {}) => `
      <form class="sprint-form" data-form="${s.id || 'new'}">
        <input class="input" name="name" placeholder="${esc(t('Nome (ex.: Sprint {n})', { n: sprints.length + 1 }))}" value="${esc(s.name || '')}" maxlength="80">
        <input class="input" name="goal" placeholder="${esc(t('Objetivo'))}" value="${esc(s.goal || '')}">
        <label class="inline-field">${t('Início')} <input class="input" type="date" name="start_date" value="${s.start_date || ''}"></label>
        <label class="inline-field">${t('Fim')} <input class="input" type="date" name="end_date" value="${s.end_date || ''}"></label>
        <button class="btn primary small" type="submit">${s.id ? t('Salvar') : `${ICON.plus} ${t('Criar sprint')}`}</button>
        ${s.id ? `<button class="btn ghost small" type="button" data-cancel>${t('Cancelar')}</button>` : ''}
      </form>`;
    body.innerHTML = `
      ${manage ? form() : ''}
      <div class="sprint-list">
        ${sprints.map((s) => (editing === s.id ? form(s) : `
          <div class="sprint-row ${s.status}">
            <div class="sprint-main">
              <div><b>${esc(s.name)}</b> <span class="pill ${s.status}">${esc(SPRINT_STATUS_LABEL[s.status])}</span></div>
              <div class="muted small">${s.start_date || s.end_date ? `${fmtDate(s.start_date) || '?'} → ${fmtDate(s.end_date) || '?'}` : t('Sem datas')}${s.goal ? ` · ${esc(s.goal)}` : ''}</div>
              <div class="progress small"><span style="width:${s.total ? (s.done / s.total) * 100 : 0}%"></span></div>
              <div class="muted small">${esc(t('{done}/{total} concluídas', { done: s.done, total: s.total }))}${s.points_total ? ` · ${esc(t('{done}/{total} pontos', { done: fmtNumber(s.points_done || 0), total: fmtNumber(s.points_total) }))}` : ''}</div>
            </div>
            <div class="sprint-actions">
              <button class="btn ghost small" data-view="${s.id}">${t('Ver tarefas')}</button>
              ${manage && s.status === 'planning' ? `<button class="btn ghost bordered small" data-start="${s.id}">${ICON.play} ${t('Iniciar')}</button>` : ''}
              ${manage && s.status === 'active' ? `<button class="btn primary small" data-complete="${s.id}">${ICON.check} ${t('Concluir')}</button>` : ''}
              ${manage && ['planning', 'active'].includes(s.status) ? `<button class="btn ghost small" data-cancelsprint="${s.id}">${t('Cancelar sprint')}</button>` : ''}
              ${manage ? `<button class="icon-btn small" data-edit="${s.id}" aria-label="${esc(t('Editar'))}">${ICON.edit}</button>
              <button class="icon-btn small" data-delete="${s.id}" aria-label="${esc(t('Excluir'))}">${ICON.trash}</button>` : ''}
            </div>
          </div>`)).join('') || `<div class="empty-small">${manage ? t('Nenhuma sprint ainda. Crie a primeira acima.') : t('Nenhuma sprint ainda.')}</div>`}
      </div>`;

    body.onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const data = { name: f.name.value, goal: f.goal.value, start_date: f.start_date.value || null, end_date: f.end_date.value || null };
      const id = e.target.dataset.form;
      const ok = await attempt(() => (id === 'new'
        ? api(`/api/projects/${projectId}/sprints`, { method: 'POST', body: data })
        : api(`/api/sprints/${id}`, { method: 'PATCH', body: data })));
      if (ok) { editing = null; await Promise.all([refresh(), load()]); }
    };
    body.onclick = async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.cancel !== undefined) { editing = null; return refresh(); }
      if (b.dataset.edit) { editing = Number(b.dataset.edit); return refresh(); }
      if (b.dataset.view) {
        dialog.close(); dialog.remove();
        return navigate({ projectId, sprint: b.dataset.view, view: 'board' });
      }
      if (b.dataset.start) {
        if (await attempt(() => api(`/api/sprints/${b.dataset.start}/start`, { method: 'POST', body: {} }), t('Sprint iniciada'))) await Promise.all([refresh(), load()]);
      }
      if (b.dataset.complete) completeSprint(sprints.find((s) => s.id === Number(b.dataset.complete)), sprints);
      if (b.dataset.cancelsprint) completeSprint(sprints.find((s) => s.id === Number(b.dataset.cancelsprint)), sprints, { cancel: true });
      if (b.dataset.delete) {
        const ok = await confirmAction(t('Excluir esta sprint? As tarefas dela voltam para o backlog.'), { okLabel: t('Excluir') });
        if (ok && await attempt(() => api(`/api/sprints/${b.dataset.delete}`, { method: 'DELETE' }), t('Sprint excluída'))) await Promise.all([refresh(), load()]);
      }
    };
  }

  function completeSprint(sprint, sprints, { cancel = false } = {}) {
    const pending = sprint.total - sprint.done;
    const targets = sprints.filter((s) => s.id !== sprint.id && !['completed', 'cancelled'].includes(s.status));
    openDialog({
      title: cancel ? t('Cancelar {name}', { name: sprint.name }) : t('Concluir {name}', { name: sprint.name }),
      submitLabel: cancel ? t('Cancelar sprint') : t('Concluir sprint'),
      cancelLabel: t('Voltar'),
      danger: cancel,
      body: `
        ${cancel ? `<p class="dialog-text">${t('A sprint fica registrada como cancelada (não entra na velocidade).')}</p>` : ''}
        <p class="dialog-text">${pending ? esc(tn(pending, '{n} tarefa ainda não foi concluída. Para onde ela vai?', '{n} tarefas ainda não foram concluídas. Para onde elas vão?')) : t('Todas as tarefas desta sprint foram concluídas.')}</p>
        ${pending ? `<label class="field"><span>${t('Mover pendentes para')}</span>
          <select class="input" name="move_to"><option value="">${t('Backlog')}</option>${targets.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}`,
      onSubmit: async (form) => {
        const move_to = form.elements.move_to?.value || null;
        const path = `/api/sprints/${sprint.id}/${cancel ? 'cancel' : 'complete'}`;
        const r = await attempt(() => api(path, { method: 'POST', body: { move_to: move_to ? Number(move_to) : null } }), cancel ? t('Sprint cancelada') : t('Sprint concluída'));
        if (!r) return false;
        await Promise.all([refresh(), load()]);
      },
    });
  }

  await refresh();
}
