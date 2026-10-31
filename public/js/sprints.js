// Gerenciador de sprints de um projeto: criar, editar, iniciar, concluir e excluir.
import { api, attempt } from './api.js';
import { state, load, navigate } from './state.js';
import { confirmAction, openDialog } from './ui.js';
import { $, ICON, esc, fmtDate } from './util.js';

const STATUS = { planning: 'Planejamento', active: 'Ativa', completed: 'Concluída' };

export async function openSprints(projectId) {
  const project = state.projects.find((p) => p.id === projectId);
  let editing = null;

  const { dialog } = openDialog({
    title: `Sprints · ${project?.name || ''}`,
    wide: true,
    cancelLabel: 'Fechar',
    body: '<div id="sprint-body"><div class="empty-small">Carregando…</div></div>',
  });
  const body = $('#sprint-body', dialog);

  async function refresh() {
    const sprints = await api(`/api/projects/${projectId}/sprints`);
    const form = (s = {}) => `
      <form class="sprint-form" data-form="${s.id || 'new'}">
        <input class="input" name="name" placeholder="Nome (ex.: Sprint ${sprints.length + 1})" value="${esc(s.name || '')}" maxlength="80">
        <input class="input" name="goal" placeholder="Objetivo" value="${esc(s.goal || '')}">
        <label class="inline-field">Início <input class="input" type="date" name="start_date" value="${s.start_date || ''}"></label>
        <label class="inline-field">Fim <input class="input" type="date" name="end_date" value="${s.end_date || ''}"></label>
        <button class="btn primary small" type="submit">${s.id ? 'Salvar' : `${ICON.plus} Criar sprint`}</button>
        ${s.id ? '<button class="btn ghost small" type="button" data-cancel>Cancelar</button>' : ''}
      </form>`;
    body.innerHTML = `
      ${form()}
      <div class="sprint-list">
        ${sprints.map((s) => (editing === s.id ? form(s) : `
          <div class="sprint-row ${s.status}">
            <div class="sprint-main">
              <div><b>${esc(s.name)}</b> <span class="pill ${s.status}">${STATUS[s.status]}</span></div>
              <div class="muted small">${s.start_date || s.end_date ? `${fmtDate(s.start_date) || '?'} → ${fmtDate(s.end_date) || '?'}` : 'Sem datas'}${s.goal ? ` · ${esc(s.goal)}` : ''}</div>
              <div class="progress small"><span style="width:${s.total ? (s.done / s.total) * 100 : 0}%"></span></div>
              <div class="muted small">${s.done}/${s.total} concluídas</div>
            </div>
            <div class="sprint-actions">
              <button class="btn ghost small" data-view="${s.id}">Ver tarefas</button>
              ${s.status === 'planning' ? `<button class="btn ghost bordered small" data-start="${s.id}">${ICON.play} Iniciar</button>` : ''}
              ${s.status === 'active' ? `<button class="btn primary small" data-complete="${s.id}">${ICON.check} Concluir</button>` : ''}
              <button class="icon-btn small" data-edit="${s.id}" aria-label="Editar">${ICON.edit}</button>
              <button class="icon-btn small" data-delete="${s.id}" aria-label="Excluir">${ICON.trash}</button>
            </div>
          </div>`)).join('') || '<div class="empty-small">Nenhuma sprint ainda. Crie a primeira acima.</div>'}
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
        if (await attempt(() => api(`/api/sprints/${b.dataset.start}/start`, { method: 'POST', body: {} }), 'Sprint iniciada')) await Promise.all([refresh(), load()]);
      }
      if (b.dataset.complete) completeSprint(sprints.find((s) => s.id === Number(b.dataset.complete)), sprints);
      if (b.dataset.delete) {
        const ok = await confirmAction('Excluir esta sprint? As tarefas dela voltam para o backlog.', { okLabel: 'Excluir' });
        if (ok && await attempt(() => api(`/api/sprints/${b.dataset.delete}`, { method: 'DELETE' }), 'Sprint excluída')) await Promise.all([refresh(), load()]);
      }
    };
  }

  function completeSprint(sprint, sprints) {
    const pending = sprint.total - sprint.done;
    const targets = sprints.filter((s) => s.id !== sprint.id && s.status !== 'completed');
    openDialog({
      title: `Concluir ${sprint.name}`,
      submitLabel: 'Concluir sprint',
      body: `
        <p class="dialog-text">${pending ? `${pending} tarefa(s) ainda não foram concluídas. Para onde elas vão?` : 'Todas as tarefas desta sprint foram concluídas.'}</p>
        ${pending ? `<label class="field"><span>Mover pendentes para</span>
          <select class="input" name="move_to"><option value="">Backlog</option>${targets.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>` : ''}`,
      onSubmit: async (form) => {
        const move_to = form.elements.move_to?.value || null;
        const r = await attempt(() => api(`/api/sprints/${sprint.id}/complete`, { method: 'POST', body: { move_to: move_to ? Number(move_to) : null } }), 'Sprint concluída');
        if (!r) return false;
        await Promise.all([refresh(), load()]);
      },
    });
  }

  await refresh();
}
