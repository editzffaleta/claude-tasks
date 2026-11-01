// Chat com o Claude dentro do painel. O servidor usa o provedor escolhido em Configurações
// (CLI do Claude Code, API da Anthropic ou compatível com OpenAI) com as ferramentas do MCP.
import { api, attempt, stream } from './api.js';
import { openTask } from './drawer.js';
import { t } from './i18n.js';
import { state, load, currentProject } from './state.js';
import { $, ICON, esc, md } from './util.js';

// Sugestões são enviadas ao Claude já traduzidas (ele responde no idioma da pergunta).
const SUGGESTIONS = /* i18n */ [
  'O que está atrasado ou vence esta semana?',
  'Resuma o que ficou pendente em cada projeto',
  'Cria uma tarefa urgente: revisar o deploy de sexta',
  'Organiza as tarefas abertas deste projeto numa sprint de 2 semanas',
];

// Ferramentas do MCP usadas numa resposta (completam a frase "o Claude …").
const TOOL_LABEL = /* i18n */ {
  add_tasks: 'criou tarefas',
  list_tasks: 'consultou tarefas',
  get_task: 'leu uma tarefa',
  update_task: 'atualizou uma tarefa',
  complete_tasks: 'concluiu tarefas',
  list_projects: 'consultou projetos',
  manage_sprints: 'mexeu nas sprints',
  log_time: 'registrou tempo',
  attach_file: 'anexou arquivo',
  list_members: 'consultou a equipe',
  update_tasks: 'atualizou tarefas',
  delete_tasks: 'excluiu tarefas',
  add_comment: 'comentou',
  manage_comment: 'mexeu num comentário',
  get_overview: 'leu o resumo',
  get_activity: 'consultou a atividade',
  search: 'buscou no quadro',
  manage_project: 'mexeu no projeto',
  manage_columns: 'mexeu nas colunas',
  manage_labels: 'mexeu nas labels',
  manage_fields: 'mexeu nos campos',
  manage_members: 'mexeu nos membros',
  manage_workspaces: 'mexeu nos workspaces',
  manage_automations: 'mexeu nas automações',
  manage_settings: 'mexeu nas configurações',
  manage_inbox: 'mexeu na caixa de entrada',
  share_link: 'criou um link público',
  export_tasks: 'exportou tarefas',
  import_tasks: 'importou tarefas',
  show_in_dashboard: 'abriu no painel',
  timer: 'mexeu no timer',
  time_report: 'leu o relatório de tempo',
  send_notification: 'enviou uma notificação',
  list_notifications: 'leu as notificações',
  get_attachment: 'leu um anexo',
};

let messages = [];
let busy = false;
let controller = null;

const linkify = (html) => html.replace(/(^|[\s(>])#(\d+)\b/g, '$1<button class="task-link" data-task="$2">#$2</button>');

function bubble(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.body)}</div></div>`;
  const tools = (m.tools || []).map((name) => `<span class="tool-chip">${ICON.check}${esc(TOOL_LABEL[name] ? t(TOOL_LABEL[name]) : name)}</span>`).join('');
  return `
    <div class="msg assistant">
      <span class="avatar claude">${ICON.claude}</span>
      <div class="assistant-body">
        ${tools ? `<div class="tools">${tools}</div>` : ''}
        ${m.body ? `<div class="md">${linkify(md(m.body))}</div>` : ''}
        ${m.error ? `<div class="chat-error">${linkify(md(m.error))}</div>` : ''}
        ${m.pending ? '<div class="typing"><span></span><span></span><span></span></div>' : ''}
      </div>
    </div>`;
}

function renderMessages() {
  const box = $('#chat-messages');
  if (!box) return;
  const project = currentProject();
  box.innerHTML = messages.length ? messages.map(bubble).join('') : `
    <div class="chat-empty">
      <span class="avatar claude big">${ICON.claude}</span>
      <p><b>${t('Peça ao Claude para mexer no quadro.')}</b><br>${project
    ? t('Ele cria, organiza, prioriza e conclui tarefas em {project} usando as mesmas ferramentas das suas sessões.', { project: `<b>${esc(project.name)}</b>` })
    : t('Ele cria, organiza, prioriza e conclui tarefas usando as mesmas ferramentas das suas sessões.')}</p>
      <div class="suggestions">${SUGGESTIONS.map((s) => t(s)).map((s) => `<button class="chip-btn" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  box.scrollTop = box.scrollHeight;
}

function render() {
  $('#chat').innerHTML = `
    <div class="chat-head">
      <span class="avatar claude">${ICON.claude}</span>
      <div><b>Claude</b><div class="muted small">${t('usa o MCP do quadro')}</div></div>
      <span class="spacer"></span>
      <button class="icon-btn small" data-action="reset" title="${esc(t('Nova conversa'))}" aria-label="${esc(t('Nova conversa'))}">${ICON.plus}</button>
      <button class="icon-btn small" data-action="close" title="${esc(t('Fechar (C)'))}" aria-label="${esc(t('Fechar'))}">${ICON.close}</button>
    </div>
    <div class="chat-messages" id="chat-messages"></div>
    <form class="chat-input" data-form="chat">
      <textarea name="message" rows="2" placeholder="${esc(t('Ex.: move as tarefas de UI do SIRAC para a próxima sprint'))}" aria-label="${esc(t('Mensagem para o Claude'))}" ${busy ? 'disabled' : ''}></textarea>
      <button class="btn primary icon-only" type="submit" aria-label="${esc(t('Enviar'))}" ${busy ? 'disabled' : ''}>${ICON.send}</button>
    </form>`;
  renderMessages();
}

export async function toggleChat(force) {
  const open = force ?? !document.body.classList.contains('chat-open');
  document.body.classList.toggle('chat-open', open);
  try { localStorage.setItem('chat-open', open ? '1' : ''); } catch {}
  $('[data-action="chat"]')?.classList.toggle('on', open);
  if (!open) return;
  if (!$('#chat-messages')) {
    render();
    const r = await attempt(() => api('/api/chat'));
    if (r) { messages = r.messages; renderMessages(); }
  }
  $('#chat textarea')?.focus();
}

async function send(text) {
  const message = text.trim();
  if (!message || busy) return;
  busy = true;
  messages.push({ role: 'user', body: message });
  const reply = { role: 'assistant', body: '', tools: [], pending: true };
  messages.push(reply);
  render();
  controller = new AbortController();
  try {
    await stream('/api/chat', { message, project_id: state.projectId }, (ev) => {
      if (ev.type === 'text') reply.body += (reply.body ? '\n\n' : '') + ev.text;
      if (ev.type === 'tool') { reply.tools.push(ev.name); load(); }
      if (ev.type === 'error') reply.error = t(ev.message);
      renderMessages();
    }, controller.signal);
  } catch (e) {
    if (e.name !== 'AbortError') reply.error = e.message;
  }
  reply.pending = false;
  if (!reply.body && !reply.tools.length && !reply.error) reply.error = t('Sem resposta.');
  busy = false;
  controller = null;
  render();
  $('#chat textarea')?.focus();
  load();
}

export function mountChat() {
  const el = $('#chat');
  el.onclick = async (e) => {
    const link = e.target.closest('[data-task]');
    if (link) return openTask(Number(link.dataset.task));
    const s = e.target.closest('[data-suggest]');
    if (s) return send(s.dataset.suggest);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'close') toggleChat(false);
    if (action === 'reset') {
      controller?.abort();
      if (await attempt(() => api('/api/chat', { method: 'DELETE' }))) { messages = []; busy = false; render(); }
    }
  };
  el.onsubmit = (e) => {
    e.preventDefault();
    const box = e.target.elements.message;
    const text = box.value;
    box.value = '';
    send(text);
  };
  el.onkeydown = (e) => {
    if (e.target.name === 'message' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
    if (e.key === 'Escape') toggleChat(false);
  };
  let reopen = false;
  try { reopen = localStorage.getItem('chat-open') === '1'; } catch {}
  if (reopen && innerWidth > 1100) toggleChat(true);
}
