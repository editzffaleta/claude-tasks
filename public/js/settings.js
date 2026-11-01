// Configurações gerais do quadro (administradores): endereço, idioma, avisos, e-mail (SMTP) e IA do chat.
// As configurações de cada projeto ficam em projectsettings.js.
import { api, attempt } from './api.js';
import { LANGUAGES, t } from './i18n.js';
import { isAdmin, navigate, state } from './state.js';
import { ICON, esc } from './util.js';

const CLI_MODELS = /* i18n */ { sonnet: 'Sonnet (equilibrado)', opus: 'Opus (mais capaz)', haiku: 'Haiku (mais rápido)' };
// Provedor do chat: [nome, explicação].
const PROVIDERS = /* i18n */ {
  'claude-cli': ['Claude Code (assinatura, sem chave)', 'Usa a CLI do Claude Code instalada neste computador e o seu login. Nada a configurar.'],
  anthropic: ['API da Anthropic', 'Chave da Claude Platform (console.anthropic.com). Funciona em qualquer servidor, inclusive no Docker.'],
  openai: ['Compatível com OpenAI', 'OpenAI, OpenRouter, Ollama, LM Studio ou qualquer servidor com a API /v1/chat/completions.'],
};

export async function renderSettings(el) {
  if (!isAdmin()) {
    el.innerHTML = `<div class="page narrow"><section class="card-box"><p class="notice">${t('Só administradores mudam as configurações gerais.')}</p>
      <button class="btn ghost bordered" data-account>${ICON.user} ${t('Minhas preferências')}</button></section></div>`;
    el.onclick = (e) => { if (e.target.closest('[data-account]')) navigate({ view: 'account' }); };
    return;
  }
  const s = await attempt(() => api('/api/settings'));
  if (!s) return;
  // options já traduzidas (os nomes dos idiomas ficam sempre na própria língua).
  const sel = (name, options, value) => `<select class="input" name="${name}">${Object.entries(options).map(([k, l]) => `<option value="${k}" ${String(value) === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const models = Object.fromEntries(Object.entries(CLI_MODELS).map(([k, v]) => [k, t(v)]));
  const provider = s.ai_provider || 'claude-cli';

  el.innerHTML = `
    <div class="page narrow settings-page">
      <form data-form="general" class="card-box stack">
        <h3>${ICON.globe} ${t('Geral')}</h3>
        <label class="field"><span>${t('Endereço público do painel')}</span>
          <input class="input" name="base_url" type="url" value="${esc(s.base_url)}" placeholder="http://localhost:4317">
          <small class="hint">${t('Usado nos links de convites, e-mails e links públicos. Preencha quando o painel for acessado por outro endereço (rede, domínio, proxy).')}</small></label>
        <label class="field"><span>${t('Idioma padrão')}</span>${sel('default_language', LANGUAGES, s.default_language)}
          <small class="hint">${t('Cada pessoa pode escolher outro idioma em Minha conta.')}</small></label>
        <label class="field"><span>${t('Avisar sobre prazos com quantos dias de antecedência')}</span>
          <input class="input small" type="number" name="due_soon_days" min="0" max="30" value="${s.due_soon_days}"></label>
        <label class="check"><input type="checkbox" name="notify_macos" ${s.notify_macos ? 'checked' : ''}><span>${t('Permitir notificações do macOS neste computador')}</span></label>
        <div><button class="btn primary" type="submit">${t('Salvar')}</button></div>
      </form>

      <form data-form="smtp" class="card-box stack">
        <h3>${ICON.mail} ${t('E-mail (SMTP)')} ${s.mail_enabled ? `<span class="chip ok">${t('ativo')}</span>` : `<span class="chip">${t('desligado')}</span>`}</h3>
        <p class="hint">${t('Usado para convites, redefinição de senha, notificações por e-mail, automações “Enviar e-mail” e respostas automáticas da caixa de entrada.')}</p>
        <div class="row-2">
          <label class="field"><span>${t('Servidor')}</span><input class="input" name="smtp_host" value="${esc(s.smtp_host)}" placeholder="smtp.gmail.com"></label>
          <label class="field"><span>${t('Porta')}</span><input class="input" type="number" name="smtp_port" value="${esc(s.smtp_port)}" placeholder="587"></label>
        </div>
        <label class="check"><input type="checkbox" name="smtp_secure" ${s.smtp_secure ? 'checked' : ''}><span>${t('TLS direto (porta 465). Desmarcado: STARTTLS na 587.')}</span></label>
        <div class="row-2">
          <label class="field"><span>${t('Usuário')}</span><input class="input" name="smtp_user" value="${esc(s.smtp_user)}" autocomplete="off"></label>
          <label class="field"><span>${t('Senha')}</span><input class="input" type="password" name="smtp_pass" value="${esc(s.smtp_pass)}" autocomplete="new-password" placeholder="${esc(t('senha de app'))}"></label>
        </div>
        <label class="field"><span>${t('Remetente')}</span><input class="input" name="smtp_from" value="${esc(s.smtp_from)}" placeholder="${esc(t('Quadro de tarefas <tarefas@exemplo.com>'))}"></label>
        <label class="check"><input type="checkbox" name="smtp_allow_insecure" ${s.smtp_allow_insecure ? 'checked' : ''}><span>${t('Permitir login sem criptografia (só para servidores na rede local)')}</span></label>
        ${s.smtp_last_error ? `<p class="notice error">${ICON.blocked} ${t('Último erro de envio:')} ${esc(s.smtp_last_error)}</p>` : ''}
        <div class="row"><button class="btn primary" type="submit">${t('Salvar')}</button>
          <button class="btn ghost bordered" type="button" data-test-email ${s.mail_enabled ? '' : 'disabled'}>${ICON.send} ${t('Enviar e-mail de teste para mim')}</button></div>
      </form>

      <form data-form="ai" class="card-box stack">
        <h3>${ICON.sparkles} ${t('IA do chat do painel')}</h3>
        <div class="provider-picks">
          ${Object.entries(PROVIDERS).map(([k, [label, hint]]) => `
            <label class="provider ${provider === k ? 'on' : ''}"><input type="radio" name="ai_provider" value="${k}" ${provider === k ? 'checked' : ''}>
              <b>${esc(t(label))}</b><small>${esc(t(hint))}</small></label>`).join('')}
        </div>
        <div data-for="claude-cli" ${provider === 'claude-cli' ? '' : 'hidden'}>
          <label class="field"><span>${t('Modelo')}</span>${sel('chat_model', models, s.chat_model)}</label>
        </div>
        <div data-for="anthropic openai" ${provider === 'claude-cli' ? 'hidden' : ''} class="stack">
          <label class="field" data-for="openai" ${provider === 'openai' ? '' : 'hidden'}><span>${t('Endereço da API')}</span>
            <input class="input" name="ai_base_url" value="${esc(s.ai_base_url)}" placeholder="https://api.openai.com/v1 · http://localhost:11434/v1"></label>
          <label class="field"><span>${t('Chave da API')}</span><input class="input" type="password" name="ai_api_key" value="${esc(s.ai_api_key)}" autocomplete="new-password" placeholder="${esc(t('deixe vazio para servidores locais sem chave'))}"></label>
          <label class="field"><span>${t('Modelo')}</span><input class="input" name="ai_model" value="${esc(s.ai_model)}" placeholder="${provider === 'anthropic' ? 'claude-opus-5-5' : 'gpt-4.1, llama3.1…'}"></label>
        </div>
        <p class="hint">${t('O chat usa as mesmas ferramentas do MCP e respeita as permissões de quem está conversando. Visualizadores não usam o chat.')}</p>
        <div><button class="btn primary" type="submit">${t('Salvar')}</button></div>
      </form>
    </div>`;

  el.onchange = (e) => {
    if (e.target.name !== 'ai_provider') return;
    const p = e.target.value;
    el.querySelectorAll('.provider').forEach((x) => x.classList.toggle('on', x.querySelector('input').value === p));
    el.querySelectorAll('[data-for]').forEach((x) => { x.hidden = !x.dataset.for.split(' ').includes(p); });
    const model = el.querySelector('[name="ai_model"]');
    if (model) model.placeholder = p === 'anthropic' ? 'claude-opus-5-5' : 'gpt-4.1, llama3.1…';
  };

  el.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.target;
    const f = form.elements;
    const kind = form.dataset.form;
    let body;
    if (kind === 'general') {
      body = { base_url: f.base_url.value.trim(), default_language: f.default_language.value, due_soon_days: Number(f.due_soon_days.value), notify_macos: f.notify_macos.checked };
    }
    if (kind === 'smtp') {
      body = {
        smtp_host: f.smtp_host.value.trim(), smtp_port: Number(f.smtp_port.value) || 0, smtp_secure: f.smtp_secure.checked, smtp_user: f.smtp_user.value.trim(),
        smtp_pass: f.smtp_pass.value, smtp_from: f.smtp_from.value.trim(), smtp_allow_insecure: f.smtp_allow_insecure.checked,
      };
    }
    if (kind === 'ai') {
      body = { ai_provider: f.ai_provider.value, chat_model: f.chat_model.value, ai_base_url: f.ai_base_url.value.trim(), ai_api_key: f.ai_api_key.value, ai_model: f.ai_model.value.trim() };
    }
    if (await attempt(() => api('/api/settings', { method: 'PATCH', body }), t('Configurações salvas'))) {
      if (kind === 'general' && f.default_language.value !== state.prefs?.language && !state.prefs?.language) location.reload();
      else renderSettings(el);
    }
  };

  el.onclick = async (e) => {
    if (!e.target.closest('[data-test-email]')) return;
    const b = e.target.closest('[data-test-email]');
    b.disabled = true;
    await attempt(() => api('/api/settings/test-email', { method: 'POST', body: { to: state.me?.email } }), t('E-mail de teste enviado para {email}', { email: state.me?.email || '' }));
    b.disabled = false;
  };
}
