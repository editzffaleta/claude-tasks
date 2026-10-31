// Chat com o Claude dentro do painel. O servidor roda a CLI do Claude Code só com o MCP "tarefas".
import { api, attempt, stream } from './api.js';
import { openTask } from './drawer.js';
import { state, load, currentProject } from './state.js';
import { $, ICON, esc, md } from './util.js';

const SUGGESTIONS = [
  'O que está atrasado ou vence esta semana?',
  'Resuma o que ficou pendente em cada projeto',
  'Cria uma tarefa urgente: revisar o deploy de sexta',
  'Organiza as tarefas abertas deste projeto numa sprint de 2 semanas',
];

const TOOL_LABEL = {
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
};

let messages = [];
let busy = false;
let controller = null;

const linkify = (html) => html.replace(/(^|[\s(>])#(\d+)\b/g, '$1<button class="task-link" data-task="$2">#$2</button>');

function bubble(m) {
  if (m.role === 'user') return `<div class="msg user"><div class="bubble">${esc(m.body)}</div></div>`;
  const tools = (m.tools || []).map((t) => `<span class="tool-chip">${ICON.check}${TOOL_LABEL[t] || t}</span>`).join('');
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
      <p><b>Peça ao Claude para mexer no quadro.</b><br>Ele cria, organiza, prioriza e conclui tarefas${project ? ` em <b>${esc(project.name)}</b>` : ''} usando as mesmas ferramentas das suas sessões.</p>
      <div class="suggestions">${SUGGESTIONS.map((s) => `<button class="chip-btn" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>
    </div>`;
  box.scrollTop = box.scrollHeight;
}

function render() {
  $('#chat').innerHTML = `
    <div class="chat-head">
      <span class="avatar claude">${ICON.claude}</span>
      <div><b>Claude</b><div class="muted small">usa o MCP do quadro</div></div>
      <span class="spacer"></span>
      <button class="icon-btn small" data-action="reset" title="Nova conversa">${ICON.plus}</button>
      <button class="icon-btn small" data-action="close" title="Fechar (C)">${ICON.close}</button>
    </div>
    <div class="chat-messages" id="chat-messages"></div>
    <form class="chat-input" data-form="chat">
      <textarea name="message" rows="2" placeholder="Ex.: move as tarefas de UI do SIRAC para a próxima sprint" ${busy ? 'disabled' : ''}></textarea>
      <button class="btn primary icon-only" type="submit" aria-label="Enviar" ${busy ? 'disabled' : ''}>${ICON.send}</button>
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
      if (ev.type === 'error') reply.error = ev.message;
      renderMessages();
    }, controller.signal);
  } catch (e) {
    if (e.name !== 'AbortError') reply.error = e.message;
  }
  reply.pending = false;
  if (!reply.body && !reply.tools.length && !reply.error) reply.error = 'Sem resposta.';
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
