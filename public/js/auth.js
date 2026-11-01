// Telas de primeiro acesso, login, convite, "esqueci a senha" e redefinição de senha.
import { api } from './api.js';
import { t } from './i18n.js';
import { $, esc } from './util.js';

const LOGO = '<span class="brand-mark big" aria-hidden="true"><svg viewBox="0 0 32 32"><rect width="32" height="32" rx="8"/><path d="M9 16.5l4.5 4.5L23 11.5"/></svg></span>';

export async function renderAuth(root, { setup, invite, reset, mailEnabled, onDone }) {
  let mode = setup ? 'setup' : invite ? 'invite' : reset ? 'reset' : 'login';
  let info = null;
  let notice = '';
  if (mode === 'invite') {
    try {
      info = await api(`/api/invites/${encodeURIComponent(invite)}`);
    } catch (e) {
      mode = 'login';
      notice = e.message;
    }
  }
  if (mode === 'reset') {
    try {
      info = await api(`/api/auth/reset/${encodeURIComponent(reset)}`);
    } catch (e) {
      mode = 'login';
      notice = e.message;
    }
  }

  const draw = () => {
    const copy = {
      setup: [t('Crie sua conta'), t('Primeiro acesso: esta será a conta de administrador. Depois você pode convidar outras pessoas.'), t('Criar conta')],
      login: [t('Entrar'), t('Use o e-mail e a senha da sua conta.'), t('Entrar')],
      invite: [t('Aceitar convite'), info?.project
        ? t('Você foi convidado para o projeto “{project}” no quadro de tarefas. Crie sua conta para entrar.', { project: info.project })
        : t('Você foi convidado para o quadro de tarefas. Crie sua conta para entrar.'), t('Criar conta e entrar')],
      forgot: [t('Esqueci a senha'), mailEnabled
        ? t('Informe seu e-mail. Se houver uma conta, enviamos um link para criar uma senha nova.')
        : t('O envio de e-mails não está configurado neste quadro. Peça a um administrador um link de redefinição (Equipe ou Administração).'), t('Enviar link')],
      reset: [t('Criar nova senha'), t('Olá, {name}. Escolha uma senha nova para {email}.', { name: info?.name || '', email: info?.email || '' }), t('Salvar senha e entrar')],
      sent: [t('Verifique seu e-mail'), t('Se houver uma conta com esse e-mail, o link para criar uma senha nova chega em alguns minutos. Ele vale por algumas horas.'), ''],
    }[mode];
    const needsName = mode === 'setup' || mode === 'invite';
    const needsEmail = ['setup', 'login', 'invite', 'forgot'].includes(mode);
    const needsPassword = ['setup', 'login', 'invite', 'reset'].includes(mode);
    const newPassword = mode !== 'login';
    root.innerHTML = `
      <div class="auth">
        <form class="auth-card" novalidate>
          ${LOGO}
          <h1>${esc(copy[0])}</h1>
          <p class="auth-sub">${esc(copy[1])}</p>
          ${notice ? `<p class="auth-error">${esc(notice)}</p>` : ''}
          ${needsName ? `<label class="field"><span>${t('Nome')}</span><input class="input" name="name" autocomplete="name" required maxlength="80"></label>` : ''}
          ${needsEmail && (mode !== 'forgot' || mailEnabled) ? `<label class="field"><span>${t('E-mail')}</span>
            <input class="input" name="email" type="email" autocomplete="email" required value="${esc(info?.email && mode === 'invite' ? info.email : '')}" ${info?.email && mode === 'invite' ? 'readonly' : ''}>
          </label>` : ''}
          ${needsPassword ? `<label class="field"><span>${newPassword ? t('Nova senha') : t('Senha')}</span>
            <input class="input" name="password" type="password" autocomplete="${newPassword ? 'new-password' : 'current-password'}" required minlength="8">
          </label>` : ''}
          ${needsPassword && newPassword ? `<p class="hint">${t('Mínimo de 8 caracteres.')}</p>` : ''}
          <p class="auth-error" id="auth-error" hidden></p>
          ${copy[2] && (mode !== 'forgot' || mailEnabled) ? `<button class="btn primary big" type="submit">${esc(copy[2])}</button>` : ''}
          ${mode === 'login' ? `<button class="link-btn auth-link" type="button" data-mode="forgot">${t('Esqueci a senha')}</button>` : ''}
          ${['forgot', 'sent', 'reset'].includes(mode) ? `<button class="link-btn auth-link" type="button" data-mode="login">${t('Voltar para o login')}</button>` : ''}
        </form>
      </div>`;
    $('input', root)?.focus();
  };

  draw();

  root.onclick = (e) => {
    const b = e.target.closest('[data-mode]');
    if (!b) return;
    mode = b.dataset.mode;
    notice = '';
    if (mode === 'login' && (reset || invite)) history.replaceState(null, '', location.pathname);
    draw();
  };

  root.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    const body = { email: f.email?.value, password: f.password?.value, name: f.name?.value };
    const path = {
      setup: '/api/auth/setup',
      login: '/api/auth/login',
      invite: `/api/invites/${encodeURIComponent(invite)}/accept`,
      forgot: '/api/auth/forgot',
      reset: `/api/auth/reset/${encodeURIComponent(reset)}`,
    }[mode];
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    try {
      const r = await api(path, { method: 'POST', body });
      if (mode === 'forgot') { mode = 'sent'; return draw(); }
      if (mode === 'invite' || mode === 'reset') history.replaceState(null, '', location.pathname);
      onDone(r.user);
    } catch (err) {
      const box = $('#auth-error', form);
      box.textContent = err.message;
      box.hidden = false;
      btn.disabled = false;
    }
  };
}
