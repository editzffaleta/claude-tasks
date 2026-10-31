// Configurações: do projeto atual (nome, cor, colunas) e gerais (notificações, chat).
import { api, attempt } from './api.js';
import { swatches } from './shell.js';
import { state, load, currentProject, navigate } from './state.js';
import { confirmAction } from './ui.js';
import { ICON, STATUSES, STATUS_LABEL, esc, projectColor, statusIcon, tilde } from './util.js';

const MODELS = { sonnet: 'Sonnet (equilibrado)', opus: 'Opus (mais capaz)', haiku: 'Haiku (mais rápido)' };

export async function renderSettings(el) {
  const project = currentProject();
  const [settings, columns] = await Promise.all([
    attempt(() => api('/api/settings')),
    project ? attempt(() => api(`/api/projects/${project.id}/columns`)) : Promise.resolve(null),
  ]);
  if (!settings) return;
  const admin = !state.me || state.me.role === 'admin';
  const custom = columns?.some((c) => c.id != null);

  el.innerHTML = `
    <div class="page narrow">
      ${project ? `
      <section class="card-box">
        <h3><span class="dot" style="--c:${projectColor(project)}"></span> Projeto · ${esc(project.name)}</h3>
        <form data-form="project" class="stack">
          <label class="field"><span>Nome</span><input class="input" name="name" value="${esc(project.name)}" required maxlength="120"></label>
          <label class="field"><span>Descrição</span><textarea class="input" name="description" rows="2">${esc(project.description || '')}</textarea></label>
          <div class="field"><span>Cor</span>${swatches(project.color || '')}</div>
          ${project.path ? `<div class="field"><span>Pasta</span><code class="path">${esc(tilde(project.path))}</code></div>` : ''}
          <div><button class="btn primary" type="submit">Salvar projeto</button></div>
        </form>
      </section>

      <section class="card-box">
        <h3>${ICON.board} Colunas do quadro</h3>
        <p class="hint">Cada coluna pertence a uma categoria (a fazer, em andamento, bloqueada ou concluída). Você pode ter várias colunas por categoria, como “Revisão” e “Homologação” dentro de “em andamento”. O Claude também consegue mover tarefas entre elas.</p>
        <div class="col-editor">
          ${columns.map((c, i) => `
            <div class="col-row">
              ${statusIcon(c.status)}
              ${c.id != null ? `
                <input class="input small" data-colname="${c.id}" value="${esc(c.name)}" maxlength="60">
                <select class="input small" data-colstatus="${c.id}">${STATUSES.map((s) => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
                <button class="icon-btn small" data-move="${c.id}:left" ${i === 0 ? 'disabled' : ''} aria-label="Mover para a esquerda">${ICON.left}</button>
                <button class="icon-btn small" data-move="${c.id}:right" ${i === columns.length - 1 ? 'disabled' : ''} aria-label="Mover para a direita">${ICON.right}</button>
                <button class="icon-btn small" data-delcol="${c.id}" aria-label="Excluir coluna">${ICON.trash}</button>`
              : `<span>${esc(c.name)}</span><span class="muted small">padrão</span>`}
            </div>`).join('')}
        </div>
        <form data-form="column" class="inline-form">
          <input class="input" name="name" placeholder="Nova coluna (ex.: Revisão)" required maxlength="60">
          <select class="input" name="status">${STATUSES.map((s) => `<option value="${s}" ${s === 'doing' ? 'selected' : ''}>${STATUS_LABEL[s]}</option>`).join('')}</select>
          <button class="btn primary" type="submit">${ICON.plus} Adicionar coluna</button>
        </form>
        ${custom ? '' : '<p class="hint">Este projeto usa as 4 colunas padrão. Ao adicionar a primeira coluna, elas viram editáveis.</p>'}
      </section>` : `
      <section class="card-box">
        <h3>${ICON.board} Configurações de projeto</h3>
        <p class="hint">Escolha um projeto para editar o nome, a cor e as colunas do quadro dele.</p>
        <div class="project-picks">${state.projects.filter((p) => !p.archived_at).map((p) => `<button class="chip-btn" data-project="${p.id}"><span class="dot" style="--c:${projectColor(p)}"></span>${esc(p.name)}</button>`).join('')}</div>
      </section>`}

      <section class="card-box">
        <h3>${ICON.bell} Notificações</h3>
        <form data-form="settings" class="stack">
          <label class="check"><input type="checkbox" name="notify_macos" ${settings.notify_macos ? 'checked' : ''} ${admin ? '' : 'disabled'}><span>Mostrar também como notificação do macOS</span></label>
          <label class="field"><span>Avisar sobre prazos com quantos dias de antecedência</span>
            <input class="input small" type="number" name="due_soon_days" min="0" max="30" value="${settings.due_soon_days}" ${admin ? '' : 'disabled'}></label>
          <h3>${ICON.sparkles} Chat com o Claude</h3>
          <label class="field"><span>Modelo usado no chat do painel</span>
            <select class="input" name="chat_model" ${admin ? '' : 'disabled'}>${Object.entries(MODELS).map(([k, l]) => `<option value="${k}" ${settings.chat_model === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          ${admin ? '<div><button class="btn primary" type="submit">Salvar preferências</button></div>' : '<p class="notice">Só administradores mudam estas preferências.</p>'}
        </form>
      </section>
    </div>`;

  el.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    const kind = form.dataset.form;
    if (kind === 'project') {
      if (await attempt(() => api(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: f.name.value, description: f.description.value, color: f.color?.value || null } }), 'Projeto salvo')) await load();
    }
    if (kind === 'column') {
      if (await attempt(() => api(`/api/projects/${project.id}/columns`, { method: 'POST', body: { name: f.name.value, status: f.status.value } }), 'Coluna criada')) { await load(); renderSettings(el); }
    }
    if (kind === 'settings') {
      await attempt(() => api('/api/settings', { method: 'PATCH', body: { notify_macos: f.notify_macos.checked, due_soon_days: Number(f.due_soon_days.value), chat_model: f.chat_model.value } }), 'Preferências salvas');
    }
  };
  el.onchange = async (e) => {
    const t = e.target;
    if (t.dataset.colstatus) {
      if (await attempt(() => api(`/api/columns/${t.dataset.colstatus}`, { method: 'PATCH', body: { status: t.value } }))) await load();
      renderSettings(el);
    }
  };
  el.onfocusout = async (e) => {
    const t = e.target;
    if (!t.dataset?.colname) return;
    const current = columns.find((c) => String(c.id) === t.dataset.colname);
    if (t.value.trim() && t.value.trim() !== current.name) {
      if (await attempt(() => api(`/api/columns/${t.dataset.colname}`, { method: 'PATCH', body: { name: t.value.trim() } }), 'Coluna renomeada')) load();
    }
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.project) return navigate({ projectId: Number(b.dataset.project), view: 'settings' });
    if (b.dataset.move) {
      const [id, move] = b.dataset.move.split(':');
      if (await attempt(() => api(`/api/columns/${id}`, { method: 'PATCH', body: { move } }))) { await load(); renderSettings(el); }
    }
    if (b.dataset.delcol) {
      if (!(await confirmAction('Excluir esta coluna? As tarefas dela vão para a primeira coluna da mesma categoria.', { okLabel: 'Excluir' }))) return;
      if (await attempt(() => api(`/api/columns/${b.dataset.delcol}`, { method: 'DELETE' }), 'Coluna excluída')) { await load(); renderSettings(el); }
    }
  };
}
