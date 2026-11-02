// Páginas Equipe (membros, papéis e convites) e Minha conta (perfil, senha e preferências).
import { api, attempt, pickFile, toast, uploadTo } from './api.js';
import { LANGUAGES, t } from './i18n.js';
import { emit, load, state } from './state.js';
import { swatches } from './shell.js';
import { confirmAction, openDialog } from './ui.js';
import { ICON, ROLES, ROLE_LABEL, USER_ROLE_LABEL, ago, applyTheme, avatar, esc, fmtDate } from './util.js';

const isAdmin = () => state.me?.role === 'admin';
const inviteLink = (token) => `${location.origin}/?invite=${token}`;
const USER_ROLES = ['member', 'viewer', 'admin'];

const copy = (text, message) => navigator.clipboard.writeText(text).then(() => toast(message)).catch(() => toast(text));

export async function renderTeam(el) {
  const admin = isAdmin();
  const [users, invites] = await Promise.all([
    attempt(() => api(`/api/users${admin ? '?all=1' : ''}`)),
    admin ? attempt(() => api('/api/invites')) : Promise.resolve([]),
  ]);
  if (!users) return;
  const roleSelect = (u) => `<select class="input small" data-role="${u.id}">${USER_ROLES.map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${esc(USER_ROLE_LABEL[r])}</option>`).join('')}</select>`;
  const writable = state.projects.filter((p) => !p.archived_at);
  el.innerHTML = `
    <div class="page team-page">
      <section class="card-box">
        <h3>${ICON.users} ${t('Membros')} <span class="count">${users.filter((u) => !u.disabled).length}</span></h3>
        <div class="table-wrap"><table class="mini-table members">
          <thead><tr><th>${t('Pessoa')}</th><th>${t('Papel')}</th><th>${t('Visto por último')}</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr class="${u.disabled ? 'disabled' : ''}">
              <td><span class="person-cell">${avatar(u, { size: 28 })}<span><b>${esc(u.name)}</b>${u.id === state.me?.id ? ` <span class="chip">${t('você')}</span>` : ''}${u.disabled ? ` <span class="chip">${t('desativada')}</span>` : ''}<br><span class="muted small">${esc(u.email)}</span></span></span></td>
              <td>${admin && u.id !== state.me?.id ? roleSelect(u) : esc(USER_ROLE_LABEL[u.role])}</td>
              <td class="muted">${u.last_seen_at ? ago(u.last_seen_at) : t('nunca')}</td>
              <td class="row-actions">${admin && u.id !== state.me?.id ? `
                <button class="icon-btn small" data-reset="${u.id}" title="${esc(t('Gerar link para redefinir a senha'))}" aria-label="${esc(t('Gerar link para redefinir a senha'))}">${ICON.key}</button>
                <button class="icon-btn small" data-disable="${u.id}" title="${esc(u.disabled ? t('Reativar') : t('Desativar (bloqueia o acesso, mantém o histórico)'))}" aria-label="${esc(u.disabled ? t('Reativar') : t('Desativar'))}">${u.disabled ? ICON.play : ICON.lock}</button>
                <button class="icon-btn small" data-remove="${u.id}" aria-label="${esc(t('Remover {name}', { name: u.name }))}">${ICON.trash}</button>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table></div>
        <p class="hint">${t('Administradores veem e gerenciam tudo. Membros veem os projetos internos e públicos e os privados de que participam. Visualizadores só leem. Papéis por projeto, workspace ou organização ficam nas páginas de cada um.')}</p>
      </section>

      ${admin ? `
      <section class="card-box">
        <h3>${ICON.plus} ${t('Convidar pessoa')}</h3>
        <form class="invite-form" data-form="invite">
          <input class="input" name="email" type="email" placeholder="${esc(t('E-mail (opcional: trava o convite neste e-mail)'))}">
          <select class="input" name="role">${USER_ROLES.map((r) => `<option value="${r}">${esc(USER_ROLE_LABEL[r])}</option>`).join('')}</select>
          <select class="input" name="project_id"><option value="">${t('Sem projeto específico')}</option>${writable.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
          <select class="input" name="project_role" hidden>${ROLES.map((r) => `<option value="${r}" ${r === 'member' ? 'selected' : ''}>${esc(t('no projeto: {role}', { role: ROLE_LABEL[r] }))}</option>`).join('')}</select>
          ${state.mailEnabled ? `<label class="check"><input type="checkbox" name="send_email" checked><span>${t('Enviar por e-mail')}</span></label>` : ''}
          <button class="btn primary" type="submit">${t('Gerar convite')}</button>
        </form>
        <p class="hint">${t('O link vale por 14 dias e só pode ser usado uma vez. Para alguém de outro computador acessar, o painel precisa estar disponível na rede (veja “Usar em equipe” no README).')}</p>
        ${invites?.length ? `
          <div class="invite-list">
            ${invites.map((i) => `
              <div class="invite-row">
                <span>${i.email ? esc(i.email) : `<span class="muted">${t('qualquer e-mail')}</span>`} · ${esc(USER_ROLE_LABEL[i.role])}${i.project_name ? ` · ${esc(i.project_name)} (${esc(ROLE_LABEL[i.project_role || 'member'])})` : ''}</span>
                <span class="muted small">${t('expira em {d}', { d: fmtDate(i.expires_at.slice(0, 10)) })}</span>
                <span class="spacer"></span>
                <button class="btn ghost small" data-copy="${i.token}">${ICON.copy} ${t('Copiar link')}</button>
                <button class="icon-btn small" data-revoke="${i.token}" aria-label="${esc(t('Revogar convite'))}">${ICON.trash}</button>
              </div>`).join('')}
          </div>` : ''}
      </section>` : ''}
    </div>`;

  el.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { email: f.email.value || null, role: f.role.value, send_email: !!f.send_email?.checked };
    if (f.project_id.value) { body.project_id = Number(f.project_id.value); body.project_role = f.project_role.value; }
    const inv = await attempt(() => api('/api/invites', { method: 'POST', body }));
    if (!inv) return;
    await navigator.clipboard.writeText(inv.link || inviteLink(inv.token)).catch(() => {});
    toast(inv.emailed ? t('Convite enviado por e-mail e link copiado') : t('Convite criado e link copiado'));
    renderTeam(el);
  };
  el.onchange = async (e) => {
    if (e.target.name === 'project_id') { el.querySelector('[name="project_role"]').hidden = !e.target.value; return; }
    const id = e.target.dataset.role;
    if (!id) return;
    if (await attempt(() => api(`/api/users/${id}`, { method: 'PATCH', body: { role: e.target.value } }), t('Papel atualizado'))) load();
    else renderTeam(el);
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) copy(inviteLink(b.dataset.copy), t('Link copiado'));
    if (b.dataset.revoke && await attempt(() => api(`/api/invites/${b.dataset.revoke}`, { method: 'DELETE' }), t('Convite revogado'))) renderTeam(el);
    const u = users.find((x) => x.id === Number(b.dataset.remove || b.dataset.disable || b.dataset.reset));
    if (b.dataset.reset) {
      const r = await attempt(() => api(`/api/users/${u.id}/reset-link`, { method: 'POST', body: {} }));
      if (!r) return;
      openDialog({
        title: t('Redefinir senha de {name}', { name: u.name }),
        cancelLabel: t('Fechar'),
        body: `<p class="dialog-text">${r.emailed ? t('Enviamos o link para {email}. Você também pode mandar este:', { email: u.email }) : t('Envie este link para a pessoa. Ele vale por {h} horas e só funciona uma vez.', { h: r.expires_in_hours })}</p>
          <div class="copy-row"><input class="input" readonly value="${esc(r.link)}"><button type="button" class="btn ghost bordered" data-copylink>${ICON.copy} ${t('Copiar')}</button></div>`,
        onOpen: (form) => { form.querySelector('[data-copylink]').onclick = () => copy(r.link, t('Link copiado')); },
      });
    }
    if (b.dataset.disable) {
      if (!u.disabled && !(await confirmAction(t('Desativar {name}? A pessoa perde o acesso na hora; tarefas e histórico continuam.', { name: u.name }), { okLabel: t('Desativar') }))) return;
      if (await attempt(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }), u.disabled ? t('Conta reativada') : t('Conta desativada'))) { await load(); renderTeam(el); }
    }
    if (b.dataset.remove) {
      if (await confirmAction(t('Remover {name}? As tarefas continuam, mas sem essa pessoa como responsável.', { name: u.name }), { okLabel: t('Remover') })) {
        if (await attempt(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), t('Membro removido'))) { await load(); renderTeam(el); }
      }
    }
  };
}

const NOTIFY_LABEL = /* i18n */ {
  assigned: 'Atribuíram uma tarefa a mim',
  comment: 'Comentários em tarefas que acompanho',
  mention: 'Alguém me mencionou (@)',
  status: 'Mudança de status em tarefas que acompanho',
  due: 'Prazo chegando',
  overdue: 'Prazo vencido',
  automation: 'Avisos de automações',
  claude: 'Avisos do Claude',
  system: 'Avisos do sistema',
};
const VIEWS = /* i18n */ { board: 'Quadro', list: 'Lista', calendar: 'Calendário', gantt: 'Gantt', dashboard: 'Dashboard' };
const THEMES = /* i18n */ { system: 'Igual ao sistema', light: 'Claro', dark: 'Escuro' };
// Canais de notificação (colunas da tabela de preferências).
const CHANNELS = /* i18n */ { app: 'No painel', email: 'E-mail', os: 'macOS' };
const translated = (map) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k, t(v)]));

export async function renderAccount(el) {
  const me = state.me;
  const prefs = (await attempt(() => api('/api/me/settings'))) || state.prefs;
  state.prefs = prefs;
  // options já traduzidas (os nomes dos idiomas ficam sempre na própria língua).
  const sel = (name, options, value) => `<select class="input" name="${name}">${Object.entries(options).map(([k, l]) => `<option value="${k}" ${String(value) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const channels = translated(CHANNELS);
  el.innerHTML = `
    <div class="page narrow account-page">
      <section class="card-box">
        <h3>${ICON.user} ${t('Perfil')}</h3>
        <form data-form="profile" class="stack">
          <div class="person-cell avatar-edit">${avatar(me, { size: 48 })}
            <span><b>${esc(me.name)}</b><br><span class="muted small">${esc(USER_ROLE_LABEL[me.role])}</span><br>
              <button type="button" class="link-btn" data-avatar>${t('Trocar foto')}</button>${me.avatar ? ` · <button type="button" class="link-btn" data-noavatar>${t('Remover foto')}</button>` : ''}</span></div>
          <label class="field"><span>${t('Nome')}</span><input class="input" name="name" value="${esc(me.name)}" required maxlength="80"></label>
          <label class="field"><span>${t('E-mail')}</span><input class="input" name="email" type="email" value="${esc(me.email)}" required></label>
          <div class="field"><span>${t('Cor')}</span>${swatches(me.color)}</div>
          <div><button class="btn primary" type="submit">${t('Salvar perfil')}</button></div>
        </form>
      </section>

      <section class="card-box">
        <h3>${ICON.sliders} ${t('Preferências')}</h3>
        <form data-form="prefs" class="stack">
          <div class="row-3">
            <label class="field"><span>${t('Idioma')}</span>${sel('language', { '': t('Padrão do quadro'), ...LANGUAGES }, prefs.language || '')}</label>
            <label class="field"><span>${t('Tema')}</span>${sel('theme', translated(THEMES), prefs.theme)}</label>
            <label class="field"><span>${t('Abrir em')}</span>${sel('default_view', translated(VIEWS), prefs.default_view)}</label>
          </div>
          <div class="field">
            <label class="check"><input type="checkbox" name="single_keys" ${prefs.single_keys !== false ? 'checked' : ''}><span>${t('Atalhos de uma tecla (N, C, K, / e 1 a 5)')}</span></label>
            <p class="hint">${t('Desligue se você usa comandos de voz ou se as teclas disparam ações sem querer. ⌘K continua funcionando.')}</p>
          </div>
          <div class="field"><span>${t('Notificações')}</span>
            <div class="table-wrap"><table class="mini-table notify-matrix">
              <thead><tr><th></th>${Object.values(channels).map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
              <tbody>${Object.entries(prefs.notify).map(([type, ch]) => `
                <tr><td>${esc(NOTIFY_LABEL[type] ? t(NOTIFY_LABEL[type]) : type)}</td>
                  ${Object.keys(channels).map((k) => `<td><input type="checkbox" data-notify="${type}:${k}" ${ch[k] ? 'checked' : ''} ${k === 'email' && !state.mailEnabled ? `disabled title="${esc(t('O envio de e-mails não está configurado'))}"` : ''} aria-label="${esc(`${NOTIFY_LABEL[type] ? t(NOTIFY_LABEL[type]) : type} · ${channels[k]}`)}"></td>`).join('')}</tr>`).join('')}
              </tbody>
            </table></div>
          </div>
          <div><button class="btn primary" type="submit">${t('Salvar preferências')}</button></div>
        </form>
      </section>

      <section class="card-box">
        <h3>${ICON.lock} ${t('Senha')}</h3>
        <form data-form="password" class="stack">
          <label class="field"><span>${t('Senha atual')}</span><input class="input" name="current_password" type="password" autocomplete="current-password" required></label>
          <label class="field"><span>${t('Nova senha')}</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
          <div><button class="btn primary" type="submit">${t('Trocar senha')}</button></div>
        </form>
      </section>
    </div>`;

  el.onchange = null;
  el.onclick = async (e) => {
    if (e.target.closest('[data-avatar]')) {
      const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
      if (!file) return;
      const r = await attempt(() => uploadTo('/api/me/avatar', file), t('Foto atualizada'));
      if (r) { state.me = { ...state.me, avatar: r.avatar }; await load(); renderAccount(el); }
    }
    if (e.target.closest('[data-noavatar]')) {
      const r = await attempt(() => api('/api/me/avatar', { method: 'DELETE' }), t('Foto removida'));
      if (r) { state.me = { ...state.me, avatar: null }; await load(); renderAccount(el); }
    }
  };
  el.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    const kind = form.dataset.form;
    if (kind === 'profile') {
      const u = await attempt(() => api(`/api/users/${me.id}`, { method: 'PATCH', body: { name: f.name.value, email: f.email.value, color: f.color?.value } }), t('Perfil salvo'));
      if (u) { state.me = u; await load(); }
    }
    if (kind === 'password') {
      const ok = await attempt(() => api(`/api/users/${me.id}`, { method: 'PATCH', body: { current_password: f.current_password.value, password: f.password.value } }), t('Senha trocada'));
      if (ok) form.reset();
    }
    if (kind === 'prefs') {
      const notify = {};
      for (const box of form.querySelectorAll('[data-notify]')) {
        const [type, k] = box.dataset.notify.split(':');
        (notify[type] ||= {})[k] = box.checked;
      }
      const before = prefs.language;
      const saved = await attempt(() => api('/api/me/settings', {
        method: 'PATCH', body: { language: f.language.value || null, theme: f.theme.value, default_view: f.default_view.value, single_keys: f.single_keys.checked, notify },
      }), t('Preferências salvas'));
      if (!saved) return;
      state.prefs = saved;
      applyTheme(saved.theme);
      if ((saved.language || '') !== (before || '')) location.reload();
      // Redesenha a estrutura, que mostra ou esconde as dicas de atalho.
      emit('prefs');
    }
  };
}
