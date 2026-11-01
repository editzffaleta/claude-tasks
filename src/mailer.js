// Envio de e-mails do quadro (convites, senha, notificações, automações, respostas da caixa de entrada)
// usando o SMTP configurado nas Configurações. Sem SMTP configurado, nada é enviado.
import { sendMail, verifySmtp } from './mail/smtp.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function smtpConfig(store) {
  const s = store.settings({ reveal: true });
  if (!s.smtp_host) return null;
  return {
    host: s.smtp_host,
    port: Number(s.smtp_port) || (s.smtp_secure ? 465 : 587),
    secure: !!s.smtp_secure,
    user: s.smtp_user || undefined,
    pass: s.smtp_pass || undefined,
    from: s.smtp_from || s.smtp_user,
    // Servidores sem TLS só por escolha explícita (a senha trafegaria em claro).
    allowInsecureAuth: !!s.smtp_allow_insecure,
  };
}

export const mailEnabled = (store) => !!smtpConfig(store);

// HTML simples e legível em qualquer cliente de e-mail.
export function layout({ title, body, link, linkLabel = 'Abrir no quadro' }) {
  const paragraphs = String(body).split(/\n{2,}/).map((p) => `<p style="margin:0 0 12px">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#1c1b19">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #e3e2de;border-radius:12px;padding:24px">
<div style="font-size:12px;color:#8f8c86;margin-bottom:8px">Quadro de tarefas</div>
<h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>
${paragraphs}
${link ? `<p style="margin:20px 0 0"><a href="${esc(link)}" style="background:#c8623f;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600;display:inline-block">${esc(linkLabel)}</a></p>` : ''}
</div></body></html>`;
}

export async function send(store, { to, subject, text, html, link, linkLabel, replyTo, inReplyTo, references, headers, attachments }) {
  const cfg = smtpConfig(store);
  if (!cfg) throw new Error('O envio de e-mail não está configurado (Configurações → E-mail)');
  const recipients = (Array.isArray(to) ? to : String(to || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
  if (!recipients.length) throw new Error('Sem destinatários');
  const body = link ? `${text}\n\n${linkLabel || 'Abrir no quadro'}: ${link}` : text;
  return sendMail(cfg, {
    from: cfg.from,
    to: recipients,
    replyTo,
    subject,
    text: body,
    html: html || layout({ title: subject, body: text, link, linkLabel }),
    inReplyTo,
    references,
    headers,
    attachments,
  });
}

// Envio sem esperar: falhas vão para o log e para "smtp_last_error" (mostrado na administração).
export function sendLater(store, message) {
  send(store, message)
    .then(() => { try { store.db.prepare("DELETE FROM settings WHERE key = 'smtp_last_error'").run(); } catch {} })
    .catch((e) => {
      console.error('e-mail:', e.message);
      try { store.db.prepare("INSERT INTO settings (key, value) VALUES ('smtp_last_error', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(`${new Date().toISOString()} ${e.message}`)); } catch {}
    });
}

export async function testSmtp(store, to) {
  const cfg = smtpConfig(store);
  if (!cfg) throw new Error('Preencha o servidor SMTP antes de testar');
  await verifySmtp(cfg);
  if (to) await send(store, { to, subject: 'Teste de e-mail do quadro de tarefas', text: 'Se você recebeu esta mensagem, o envio de e-mails está funcionando.' });
  return true;
}
