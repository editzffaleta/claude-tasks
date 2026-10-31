// Telas de primeiro acesso, login e aceite de convite.
import { api } from './api.js';
import { $, esc } from './util.js';

const LOGO = '<span class="brand-mark big" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8"/><path d="M9 16.5l4.5 4.5L23 11.5"/></svg></span>';

export async function renderAuth(root, { setup, invite, onDone }) {
  let mode = setup ? 'setup' : invite ? 'invite' : 'login';
  let inviteInfo = null;
  if (mode === 'invite') {
    try {
      inviteInfo = await api(`/api/invites/${encodeURIComponent(invite)}`);
    } catch (e) {
      mode = 'login';
      inviteInfo = { error: e.message };
    }
  }

  const copy = {
    setup: ['Crie sua conta', 'Primeiro acesso: esta será a conta de administrador. Depois você pode convidar outras pessoas.', 'Criar conta'],
    login: ['Entrar', 'Use o e-mail e a senha da sua conta.', 'Entrar'],
    invite: ['Aceitar convite', 'Você foi convidado para o quadro de tarefas. Crie sua conta para entrar.', 'Criar conta e entrar'],
  }[mode];

  root.innerHTML = `
    <div class="auth">
      <form class="auth-card" novalidate>
        ${LOGO}
        <h1>${copy[0]}</h1>
        <p class="auth-sub">${copy[1]}</p>
        ${inviteInfo?.error ? `<p class="auth-error">${esc(inviteInfo.error)}</p>` : ''}
        ${mode !== 'login' ? '<label class="field"><span>Nome</span><input class="input" name="name" autocomplete="name" required maxlength="80"></label>' : ''}
        <label class="field"><span>E-mail</span>
          <input class="input" name="email" type="email" autocomplete="email" required value="${esc(inviteInfo?.email || '')}" ${inviteInfo?.email ? 'readonly' : ''}>
        </label>
        <label class="field"><span>Senha</span>
          <input class="input" name="password" type="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required minlength="8">
        </label>
        ${mode !== 'login' ? '<p class="hint">Mínimo de 8 caracteres.</p>' : ''}
        <p class="auth-error" id="auth-error" hidden></p>
        <button class="btn primary big" type="submit">${copy[2]}</button>
      </form>
    </div>`;

  const form = $('form', root);
  $('input', form).focus();
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = { email: f.email.value, password: f.password.value, name: f.name?.value };
    const path = { setup: '/api/auth/setup', login: '/api/auth/login', invite: `/api/invites/${encodeURIComponent(invite)}/accept` }[mode];
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const { user } = await api(path, { method: 'POST', body });
      if (mode === 'invite') history.replaceState(null, '', location.pathname);
      onDone(user);
    } catch (err) {
      const box = $('#auth-error', form);
      box.textContent = err.message;
      box.hidden = false;
      btn.disabled = false;
    }
  });
}
