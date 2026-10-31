// Páginas Equipe (membros e convites) e Minha conta.
import { api, attempt, toast } from './api.js';
import { swatches } from './shell.js';
import { state, load } from './state.js';
import { confirmAction } from './ui.js';
import { ICON, ago, avatar, esc, fmtDate } from './util.js';

const isAdmin = () => state.me?.role === 'admin';
const inviteLink = (token) => `${location.origin}/?invite=${token}`;

export async function renderTeam(el) {
  const admin = isAdmin();
  const [users, invites] = await Promise.all([
    attempt(() => api('/api/users')),
    admin ? attempt(() => api('/api/invites')) : Promise.resolve([]),
  ]);
  if (!users) return;
  el.innerHTML = `
    <div class="page">
      <section class="card-box">
        <h3>${ICON.users} Membros <span class="count">${users.length}</span></h3>
        <table class="mini-table members">
          <thead><tr><th>Pessoa</th><th>Papel</th><th>Visto por último</th><th></th></tr></thead>
          <tbody>${users.map((u) => `
            <tr>
              <td><span class="person-cell">${avatar(u, { size: 28 })}<span><b>${esc(u.name)}</b>${u.id === state.me?.id ? ' <span class="chip">você</span>' : ''}<br><span class="muted small">${esc(u.email)}</span></span></span></td>
              <td>${admin && u.id !== state.me?.id
                ? `<select class="input small" data-role="${u.id}"><option value="member" ${u.role === 'member' ? 'selected' : ''}>Membro</option><option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Administrador</option></select>`
                : u.role === 'admin' ? 'Administrador' : 'Membro'}</td>
              <td class="muted">${u.last_seen_at ? ago(u.last_seen_at) : 'nunca'}</td>
              <td>${admin && u.id !== state.me?.id ? `<button class="icon-btn small" data-remove="${u.id}" aria-label="Remover ${esc(u.name)}">${ICON.trash}</button>` : ''}</td>
            </tr>`).join('')}</tbody>
        </table>
      </section>

      ${admin ? `
      <section class="card-box">
        <h3>${ICON.plus} Convidar pessoa</h3>
        <form class="invite-form" data-form="invite">
          <input class="input" name="email" type="email" placeholder="E-mail (opcional: trava o convite neste e-mail)">
          <select class="input" name="role"><option value="member">Membro</option><option value="admin">Administrador</option></select>
          <button class="btn primary" type="submit">Gerar link de convite</button>
        </form>
        <p class="hint">O link vale por 14 dias e só pode ser usado uma vez. Envie para a pessoa por onde preferir.
        Para alguém de outro computador acessar, o painel precisa estar disponível na rede (veja “Usar em equipe” no README).</p>
        ${invites?.length ? `
          <div class="invite-list">
            ${invites.map((i) => `
              <div class="invite-row">
                <span>${i.email ? esc(i.email) : '<span class="muted">qualquer e-mail</span>'} · ${i.role === 'admin' ? 'administrador' : 'membro'}</span>
                <span class="muted small">expira em ${fmtDate(i.expires_at.slice(0, 10))}</span>
                <span class="spacer"></span>
                <button class="btn ghost small" data-copy="${i.token}">${ICON.copy} Copiar link</button>
                <button class="icon-btn small" data-revoke="${i.token}" aria-label="Revogar convite">${ICON.trash}</button>
              </div>`).join('')}
          </div>` : ''}
      </section>` : ''}
    </div>`;

  el.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const inv = await attempt(() => api('/api/invites', { method: 'POST', body: { email: f.email.value || null, role: f.role.value } }));
    if (!inv) return;
    await navigator.clipboard.writeText(inviteLink(inv.token)).catch(() => {});
    toast('Convite criado e link copiado');
    renderTeam(el);
  };
  el.onchange = async (e) => {
    const id = e.target.dataset.role;
    if (!id) return;
    if (await attempt(() => api(`/api/users/${id}`, { method: 'PATCH', body: { role: e.target.value } }), 'Papel atualizado')) load();
    else renderTeam(el);
  };
  el.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) {
      await navigator.clipboard.writeText(inviteLink(b.dataset.copy));
      toast('Link copiado');
    }
    if (b.dataset.revoke && await attempt(() => api(`/api/invites/${b.dataset.revoke}`, { method: 'DELETE' }), 'Convite revogado')) renderTeam(el);
    if (b.dataset.remove) {
      const u = users.find((x) => x.id === Number(b.dataset.remove));
      if (await confirmAction(`Remover ${u.name}? As tarefas continuam, mas sem essa pessoa como responsável.`, { okLabel: 'Remover' })) {
        if (await attempt(() => api(`/api/users/${u.id}`, { method: 'DELETE' }), 'Membro removido')) { await load(); renderTeam(el); }
      }
    }
  };
}

export function renderAccount(el) {
  const me = state.me;
  el.innerHTML = `
    <div class="page narrow">
      <section class="card-box">
        <h3>${ICON.user} Perfil</h3>
        <form data-form="profile" class="stack">
          <div class="person-cell">${avatar(me, { size: 40 })}<span><b>${esc(me.name)}</b><br><span class="muted small">${me.role === 'admin' ? 'Administrador' : 'Membro'}</span></span></div>
          <label class="field"><span>Nome</span><input class="input" name="name" value="${esc(me.name)}" required maxlength="80"></label>
          <label class="field"><span>E-mail</span><input class="input" name="email" type="email" value="${esc(me.email)}" required></label>
          <div class="field"><span>Cor</span>${swatches(me.color)}</div>
          <div><button class="btn primary" type="submit">Salvar perfil</button></div>
        </form>
      </section>
      <section class="card-box">
        <h3>${ICON.lock} Senha</h3>
        <form data-form="password" class="stack">
          <label class="field"><span>Senha atual</span><input class="input" name="current_password" type="password" autocomplete="current-password" required></label>
          <label class="field"><span>Nova senha</span><input class="input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
          <div><button class="btn primary" type="submit">Trocar senha</button></div>
        </form>
      </section>
    </div>`;
  el.onclick = null;
  el.onchange = null;
  el.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (e.target.dataset.form === 'profile') {
      const u = await attempt(() => api(`/api/users/${me.id}`, { method: 'PATCH', body: { name: f.name.value, email: f.email.value, color: f.color?.value } }), 'Perfil salvo');
      if (u) { state.me = u; await load(); }
    } else {
      const ok = await attempt(() => api(`/api/users/${me.id}`, { method: 'PATCH', body: { current_password: f.current_password.value, password: f.password.value } }), 'Senha trocada');
      if (ok) e.target.reset();
    }
  };
}
