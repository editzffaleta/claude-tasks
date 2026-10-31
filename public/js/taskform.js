// Diálogo de nova tarefa com todos os campos.
import { api, attempt } from './api.js';
import { state, load } from './state.js';
import { openDialog } from './ui.js';
import { $, FREQ_LABEL, PRIORITIES, PRIORITY_LABEL, TYPES, TYPE_LABEL, avatar, esc } from './util.js';

export function openNewTask(preset = {}) {
  const projects = state.projects.filter((p) => !p.archived_at);
  const projectId = preset.project_id || state.projectId || projects[0]?.id || 'new';
  const opt = (v, l, sel) => `<option value="${v}" ${String(v) === String(sel) ? 'selected' : ''}>${esc(l)}</option>`;

  openDialog({
    title: preset.parent_id ? 'Nova subtarefa' : 'Nova tarefa',
    submitLabel: 'Criar tarefa',
    wide: true,
    footer: '<span class="hint"><kbd>⌘</kbd><kbd>↵</kbd> para criar</span>',
    body: `
      <input name="title" class="input title-input" placeholder="O que precisa ser feito?" required maxlength="300" autocomplete="off">
      <textarea name="description" class="input" rows="4" placeholder="Contexto, arquivos envolvidos, critérios de pronto… (Markdown simples)"></textarea>
      <div class="field-row">
        <label class="field"><span>Projeto</span>
          <select name="project_id" class="input">${projects.map((p) => opt(p.id, p.name, projectId)).join('')}${opt('new', '+ Novo projeto…', projectId)}</select>
        </label>
        <label class="field" data-newproject hidden><span>Nome do projeto</span><input name="project_name" class="input" maxlength="120" placeholder="ex.: Pessoal"></label>
        <label class="field"><span>Status</span><select name="column" class="input"></select></label>
        <label class="field"><span>Prioridade</span>
          <select name="priority" class="input">${PRIORITIES.map((p) => opt(p, PRIORITY_LABEL[p], preset.priority || 'medium')).join('')}</select>
        </label>
        <label class="field"><span>Tipo</span>
          <select name="type" class="input">${TYPES.map((t) => opt(t, TYPE_LABEL[t], preset.type || 'task')).join('')}</select>
        </label>
      </div>
      <div class="field-row">
        <label class="field"><span>Início</span><input type="date" name="start_date" class="input" value="${preset.start_date || ''}"></label>
        <label class="field"><span>Prazo</span><input type="date" name="due_date" class="input" value="${preset.due_date || ''}"></label>
        <label class="field"><span>Estimativa</span><input name="estimate" class="input" placeholder="2h, 1h30m, 1d"></label>
        <label class="field"><span>Sprint</span><select name="sprint_id" class="input"><option value="">Backlog</option></select></label>
      </div>
      <div class="field-row">
        <label class="field"><span>Tags</span><input name="tags" class="input" placeholder="bug, ui, backend" autocomplete="off"></label>
        <label class="field"><span>Repetir</span>
          <select name="recurrence" class="input"><option value="">Não repete</option>${Object.entries(FREQ_LABEL).map(([k, l]) => opt(k, l, '')).join('')}</select>
        </label>
      </div>
      ${state.users.length ? `
        <div class="field"><span>Responsáveis</span>
          <div class="pick-people">${state.users.map((u) => `
            <label class="pick"><input type="checkbox" name="assignee" value="${u.id}"><span>${avatar(u, { size: 18 })}${esc(u.name)}</span></label>`).join('')}
          </div>
        </div>` : ''}`,
    onOpen: (form) => {
      const f = form.elements;
      const refresh = async () => {
        const isNew = f.project_id.value === 'new';
        $('[data-newproject]', form).hidden = !isNew;
        f.project_name.required = isNew;
        let columns = [{ ref: 'todo', name: 'A fazer' }, { ref: 'doing', name: 'Em andamento' }, { ref: 'blocked', name: 'Bloqueada' }];
        let sprints = [];
        if (!isNew) {
          const [cols, sp] = await Promise.all([
            api(`/api/projects/${f.project_id.value}/columns`).catch(() => null),
            api(`/api/projects/${f.project_id.value}/sprints`).catch(() => []),
          ]);
          if (cols) columns = cols.filter((c) => c.status !== 'done').map((c) => ({ ref: c.id ?? c.status, name: c.name, status: c.status }));
          sprints = sp.filter((s) => s.status !== 'completed');
        }
        const want = String(preset.column ?? preset.status ?? 'todo');
        f.column.innerHTML = columns.map((c) => opt(c.ref, c.name, columns.some((x) => String(x.ref) === want) ? want : columns.find((x) => x.status === want)?.ref ?? columns[0].ref)).join('');
        // Dentro de um filtro de sprint, a nova tarefa já nasce nela.
        const sameProject = state.projectId === Number(f.project_id.value);
        const wantSprint = preset.sprint_id ?? (sameProject && state.sprint && state.sprint !== 'none' ? state.sprint : '');
        f.sprint_id.innerHTML = `<option value="">Backlog</option>${sprints.map((s) => opt(s.id, `${s.name}${s.status === 'active' ? ' · ativa' : ''}`, wantSprint || '')).join('')}`;
        f.sprint_id.closest('.field').hidden = !sprints.length;
      };
      f.project_id.onchange = refresh;
      refresh();
      f.title.focus();
    },
    onSubmit: async (form) => {
      const f = form.elements;
      const body = {
        title: f.title.value,
        description: f.description.value,
        priority: f.priority.value,
        type: f.type.value,
        start_date: f.start_date.value || null,
        due_date: f.due_date.value || null,
        estimate: f.estimate.value.trim() || null,
        tags: f.tags.value,
        sprint_id: f.sprint_id.value ? Number(f.sprint_id.value) : null,
        recurrence: f.recurrence.value ? { freq: f.recurrence.value } : null,
        assignee_ids: [...form.querySelectorAll('[name=assignee]:checked')].map((c) => Number(c.value)),
        parent_id: preset.parent_id || null,
      };
      const col = f.column.value;
      body.column = /^\d+$/.test(col) ? Number(col) : col;
      if (f.project_id.value === 'new') body.project_name = f.project_name.value;
      else body.project_id = Number(f.project_id.value);
      const task = await attempt(() => api('/api/tasks', { method: 'POST', body }), 'Tarefa criada');
      if (!task) return false;
      await load();
    },
  });
}
