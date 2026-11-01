// Página Administração: números do quadro, sistema, backups, manutenção e contas.
import { api, attempt, toast } from './api.js';
import { t, tn } from './i18n.js';
import { isAdmin, load, navigate, state } from './state.js';
import { confirmAction } from './ui.js';
import { ICON, USER_ROLE_LABEL, ago, avatar, dtf, esc, fmtNumber } from './util.js';

const aiLabel = (provider) => ({
  'claude-cli': t('Claude Code no computador (assinatura)'),
  anthropic: t('API da Anthropic'),
  openai: t('API compatível com OpenAI'),
})[provider] || provider || '—';

// Último link de redefinição gerado: fica visível nos redesenhos internos, some ao voltar à página.
let lastReset = null;

function fmtBytes(n) {
  const units = [['gigabyte', 1e9], ['megabyte', 1e6], ['kilobyte', 1e3]];
  const [unit, size] = units.find(([, s]) => n >= s) || ['byte', 1];
  return fmtNumber(n / size, { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: unit === 'byte' ? 0 : 1 });
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return t('{d} d {h} h', { d, h });
  if (h) return t('{h} h {m} min', { h, m });
  return t('{m} min', { m });
}

const when = (iso) => (iso ? `<span title="${esc(dtf.format(new Date(iso)))}">${esc(ago(iso))}</span>` : `<span class="muted">${t('nunca')}</span>`);

function tile(icon, label, value, hint = '') {
  return `
    <div class="stat-tile">
      <span class="stat-label">${icon}${label}</span>
      <span class="stat-value">${fmtNumber(value)}</span>
      ${hint ? `<span class="stat-hint">${hint}</span>` : ''}
    </div>`;
}

export async function renderAdmin(el, { keepReset = false } = {}) {
  el.onclick = null;
  if (!keepReset) lastReset = null;
  if (!isAdmin()) {
    el.innerHTML = `
      <div class="page narrow admin-page">
        <div class="empty-box">${ICON.shield}<p>${t('Só administradores do quadro podem ver esta página.')}</p></div>
      </div>`;
    return;
  }
  const [ov, settings, users] = await Promise.all([
    attempt(() => api('/api/admin/overview')),
    api('/api/settings').catch(() => ({})),
    api('/api/users?all=1').catch(() => []),
  ]);
  if (!el.isConnected) return;
  if (!ov) {
    el.innerHTML = `<div class="page narrow admin-page"><div class="empty-box">${ICON.blocked}<p>${t('Não foi possível carregar a administração.')}</p></div></div>`;
    return;
  }
  paint(el, ov, settings, users);
  bind(el, users);
}

function paint(el, ov, settings, users) {
  const c = ov.counts;
  const mailError = settings.smtp_last_error;
  el.innerHTML = `
    <div class="page admin-page">
      <div class="tiles">
        ${tile(ICON.users, t('Pessoas'), c.users, tn(c.sessions, '{n} sessão ativa', '{n} sessões ativas'))}
        ${tile(ICON.building, t('Organizações'), c.organizations)}
        ${tile(ICON.layers, t('Workspaces'), c.workspaces)}
        ${tile(ICON.folder, t('Projetos'), c.projects)}
        ${tile(ICON.checklist, t('Tarefas'), c.tasks, tn(c.open_tasks, '{n} aberta', '{n} abertas'))}
        ${tile(ICON.comment, t('Comentários'), c.comments)}
        ${tile(ICON.clip, t('Anexos'), c.attachments, esc(fmtBytes(ov.attachments_bytes)))}
        ${tile(ICON.zap, t('Automações'), c.automations)}
        ${tile(ICON.inbox, t('Caixas de entrada'), c.inboxes)}
      </div>

      <div class="admin-grid">
        <section class="card-box">
          <h3>${ICON.gear} ${t('Sistema')}</h3>
          <dl class="admin-info">
            <dt>${t('Versão')}</dt><dd>${esc(ov.app_version)} <span class="muted small">${t('esquema {n}', { n: esc(ov.schema_version) })}</span></dd>
            <dt>${t('Node.js')}</dt><dd>${esc(ov.node)}</dd>
            <dt>${t('No ar há')}</dt><dd>${fmtUptime(ov.uptime_seconds)}</dd>
            <dt>${t('Pasta de dados')}</dt><dd class="admin-path"><code>${esc(ov.data_dir)}</code><button class="icon-btn tiny" data-copy="${esc(ov.data_dir)}" aria-label="${esc(t('Copiar caminho'))}">${ICON.copy}</button></dd>
            <dt>${t('Banco de dados')}</dt><dd>${esc(fmtBytes(ov.database_bytes))}</dd>
            <dt>${t('Anexos')}</dt><dd>${esc(fmtBytes(ov.attachments_bytes))}</dd>
            <dt>${t('E-mail (SMTP)')}</dt><dd>${ov.mail_enabled ? `<span class="admin-ok">${ICON.check}${t('Configurado')}</span>` : `<span class="muted">${t('Desligado')}</span>`}</dd>
            <dt>${t('Assistente do chat')}</dt><dd>${esc(aiLabel(ov.ai_provider))}</dd>
          </dl>
          ${mailError ? `
            <div class="admin-error">
              <b>${ICON.mail}${t('Último erro de envio de e-mail')}</b>
              <code>${esc(mailError)}</code>
            </div>` : ''}
        </section>

        <section class="card-box">
          <h3>${ICON.right} ${t('Atalhos')}</h3>
          <div class="admin-links">
            <button class="admin-link" data-go="team">${ICON.users}<span><b>${t('Equipe')}</b><small>${t('Convites, papéis e remoção de contas')}</small></span></button>
            <button class="admin-link" data-go="organizations">${ICON.building}<span><b>${t('Organizações')}</b><small>${t('Workspaces, projetos e papéis por nível')}</small></span></button>
            <button class="admin-link" data-go="settings">${ICON.gear}<span><b>${t('Configurações')}</b><small>${t('E-mail, idioma padrão e assistente do chat')}</small></span></button>
            <a class="admin-link" href="/docs/api" target="_blank" rel="noopener">${ICON.code}<span><b>${t('Documentação da API')}</b><small>${t('Abre numa nova aba')}</small></span></a>
          </div>
        </section>
      </div>

      <section class="card-box">
        <h3>${ICON.archive} ${t('Backups')} <span class="count">${ov.backups.length}</span>
          <span class="spacer"></span>
          <button class="btn primary small" data-backup>${ICON.plus}<span>${t('Criar backup agora')}</span></button></h3>
        <p class="hint">${t('Cópias completas do banco, salvas na pasta de dados. Para restaurar, pare o servidor e troque o arquivo do banco pela cópia.')}</p>
        ${ov.backups.length ? `
          <div class="admin-table-wrap">
            <table class="mini-table admin-backups">
              <thead><tr><th>${t('Arquivo')}</th><th>${t('Tamanho')}</th><th>${t('Criado')}</th><th></th></tr></thead>
              <tbody>${ov.backups.map((b) => `
                <tr>
                  <td><code class="admin-file">${esc(b.file)}</code></td>
                  <td>${esc(fmtBytes(b.bytes))}</td>
                  <td>${when(b.created_at)}</td>
                  <td class="admin-actions">
                    <a class="icon-btn small" href="/api/admin/backups/${encodeURIComponent(b.file)}" download="${esc(b.file)}" title="${esc(t('Baixar'))}" aria-label="${esc(t('Baixar {file}', { file: b.file }))}">${ICON.download}</a>
                    <button class="icon-btn small" data-del-backup="${esc(b.file)}" title="${esc(t('Excluir'))}" aria-label="${esc(t('Excluir {file}', { file: b.file }))}">${ICON.trash}</button>
                  </td>
                </tr>`).join('')}</tbody>
            </table>
          </div>` : `<p class="empty-small">${t('Nenhum backup na pasta de dados ainda.')}</p>`}
      </section>

      <section class="card-box">
        <h3>${ICON.sliders} ${t('Manutenção')}</h3>
        <div class="admin-maint">
          <div>
            <b>${t('Compactar o banco')}</b>
            <p class="hint">${t('Reescreve o arquivo do banco (VACUUM) e devolve ao disco o espaço de dados já apagados. Pode levar alguns segundos, e o quadro fica parado enquanto roda.')}</p>
          </div>
          <button class="btn bordered small" data-maint="vacuum">${t('Compactar')}</button>
        </div>
        <div class="admin-maint">
          <div>
            <b>${t('Limpar dados vencidos')}</b>
            <p class="hint">${t('Apaga sessões expiradas, convites vencidos que não foram usados, links de redefinição de senha usados ou vencidos, comandos antigos do painel e notificações lidas há mais de 90 dias.')}</p>
          </div>
          <button class="btn bordered small" data-maint="cleanup">${t('Limpar')}</button>
        </div>
      </section>

      <section class="card-box">
        <h3>${ICON.key} ${t('Contas')} <span class="count">${users.length}</span></h3>
        ${lastReset ? resetBox(lastReset) : ''}
        <div class="admin-table-wrap">
          <table class="mini-table admin-users">
            <thead><tr><th>${t('Pessoa')}</th><th>${t('Papel')}</th><th>${t('Situação')}</th><th>${t('Visto por último')}</th><th></th></tr></thead>
            <tbody>${users.map((u) => `
              <tr class="${u.disabled ? 'off' : ''}">
                <td><span class="person-cell">${avatar(u, { size: 26 })}<span class="admin-person"><b>${esc(u.name)}</b><span class="muted small">${esc(u.email)}</span></span></span></td>
                <td>${USER_ROLE_LABEL[u.role] || esc(u.role)}</td>
                <td>${u.disabled ? `<span class="chip admin-off">${t('Desativada')}</span>` : `<span class="chip">${t('Ativa')}</span>`}</td>
                <td>${when(u.last_seen_at)}</td>
                <td class="admin-actions">
                  ${u.disabled ? '' : `<button class="btn ghost small" data-reset="${u.id}" title="${esc(t('Gera um link para a pessoa criar uma senha nova'))}">${ICON.key}<span>${t('Link de senha')}</span></button>`}
                  ${u.id === state.me?.id ? '' : `<button class="btn ghost small${u.disabled ? '' : ' danger'}" data-toggle-user="${u.id}">${u.disabled ? t('Reativar') : t('Desativar')}</button>`}
                </td>
              </tr>`).join('')}</tbody>
          </table>
        </div>
      </section>
    </div>`;
}

function resetBox(r) {
  return `
    <div class="admin-reset">
      <p>${r.emailed
        ? t('Link para {name} criado e enviado para {email}. Vale por {h} horas e só funciona uma vez.', { name: esc(r.name), email: esc(r.email), h: r.expires_in_hours })
        : t('Link para {name} criado. Vale por {h} horas e só funciona uma vez: envie para a pessoa por onde preferir.', { name: esc(r.name), h: r.expires_in_hours })}</p>
      <div class="admin-reset-row">
        <input class="input small" readonly value="${esc(r.link)}" aria-label="${esc(t('Link de redefinição'))}" data-select>
        <button class="btn primary small" data-copy="${esc(r.link)}">${ICON.copy}<span>${t('Copiar')}</span></button>
        <button class="icon-btn small" data-dismiss-reset aria-label="${esc(t('Fechar'))}">${ICON.close}</button>
      </div>
    </div>`;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast(t('Copiado'));
  } catch {
    toast(t('Não deu para copiar: selecione e copie manualmente'), true);
  }
}

function bind(el, users) {
  el.onclick = async (e) => {
    const input = e.target.closest('[data-select]');
    if (input) return input.select();
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    const d = b.dataset;
    if (d.go) return navigate(d.go === 'team' ? { projectId: null, view: 'team' } : { view: d.go });
    if (d.copy) return copy(d.copy);
    if ('dismissReset' in d) return renderAdmin(el);

    if ('backup' in d) {
      b.disabled = true;
      const r = await attempt(() => api('/api/admin/backup', { method: 'POST', body: {} }));
      b.disabled = false;
      if (r) { toast(t('Backup criado: {file}', { file: r.file })); renderAdmin(el, { keepReset: true }); }
      return;
    }
    if (d.delBackup) {
      const yes = await confirmAction(t('Excluir o backup {file}? O arquivo é apagado da pasta de dados e não dá para desfazer.', { file: d.delBackup }),
        { title: t('Excluir backup'), okLabel: t('Excluir') });
      if (yes && await attempt(() => api(`/api/admin/backups/${encodeURIComponent(d.delBackup)}`, { method: 'DELETE' }), t('Backup excluído'))) renderAdmin(el, { keepReset: true });
      return;
    }
    if (d.maint) {
      b.disabled = true;
      const r = await attempt(() => api('/api/admin/maintenance', { method: 'POST', body: { action: d.maint } }));
      b.disabled = false;
      if (!r) return;
      toast(d.maint === 'vacuum' ? t('Banco compactado') : t('Dados vencidos apagados'));
      renderAdmin(el, { keepReset: true });
      return;
    }
    if (d.reset) {
      const u = users.find((x) => x.id === Number(d.reset));
      const r = await attempt(() => api(`/api/users/${u.id}/reset-link`, { method: 'POST', body: {} }));
      if (!r) return;
      lastReset = { ...r, name: u.name, email: u.email };
      await renderAdmin(el, { keepReset: true });
      return;
    }
    if (d.toggleUser) {
      const u = users.find((x) => x.id === Number(d.toggleUser));
      if (!u.disabled) {
        const yes = await confirmAction(t('Desativar a conta de {name}? A pessoa sai de todas as sessões e não consegue mais entrar até ser reativada. Tarefas e comentários dela continuam.', { name: u.name }),
          { title: t('Desativar conta'), okLabel: t('Desativar') });
        if (!yes) return;
      }
      const ok = await attempt(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { disabled: !u.disabled } }),
        u.disabled ? t('Conta reativada') : t('Conta desativada'));
      if (!ok) return;
      await load();
      renderAdmin(el, { keepReset: true });
    }
  };
}
