// Chat do painel com três provedores:
// - claude-cli: a CLI do Claude Code (sua assinatura), só com o MCP "tarefas";
// - anthropic: API da Anthropic pelo SDK oficial, com as ferramentas do MCP rodando aqui dentro;
// - openai: qualquer API compatível com OpenAI (OpenAI, OpenRouter, Ollama local…), idem.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { cleanText, today } from './db.js';

const SRC = dirname(fileURLToPath(import.meta.url));
const MAX_STEPS = 15;
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

export const CLAUDE_BIN = process.env.CLAUDE_BIN
  || [join(homedir(), '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(existsSync)
  || 'claude';

function systemPrompt(store, user, project, provider) {
  return [
    'Você é o assistente embutido no painel do quadro de tarefas do usuário.',
    `Use somente as ferramentas do quadro${provider === 'claude-cli' ? ' (MCP "tarefas")' : ''} para consultar e alterar as tarefas. Execute as ações pedidas em vez de só sugerir.`,
    'Quando fizer sentido mostrar algo, use show_in_dashboard para abrir a tarefa, o projeto ou a visão na tela do usuário.',
    `Hoje é ${today()}.${user ? ` Quem está falando: ${user.name} <${user.email}>.` : ''}`,
    project
      ? `O usuário está olhando o projeto "${project.name}" (id ${project.id}${project.path ? `, project_path ${project.path}` : ''}). Use esse projeto quando ele não disser outro.`
      : 'O usuário está na visão de todos os projetos.',
    'Responda em português do Brasil, curto e direto. Cite tarefas como #id.',
  ].join('\n');
}

function chatError(text) {
  if (/auth|login|oauth|credential|api key|401/i.test(text)) {
    return 'A CLI do Claude não está logada. Abra o Terminal, rode `claude` e use /login. Depois tente de novo.';
  }
  return String(text || 'O assistente encerrou sem responder').trim().slice(0, 500);
}

// Ferramentas do MCP executadas no próprio processo (provedores de API).
async function inProcessTools(user) {
  const [{ TOOLS }, ctx] = await Promise.all([import('./mcp/tools.js'), import('./mcp/context.js')]);
  return {
    list: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, schema: t.inputSchema })),
    async run(name, args, author) {
      const tool = TOOLS[name];
      if (!tool) return { content: [{ type: 'text', text: `Erro: ferramenta desconhecida ${name}` }], isError: true };
      const previous = ctx.AGENT.author;
      ctx.AGENT.author = author;
      ctx.setCurrentUser(user);
      try {
        const out = await tool.run(args || {});
        return typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
      } catch (e) {
        return { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true };
      } finally {
        ctx.AGENT.author = previous;
        ctx.setCurrentUser(null);
      }
    },
  };
}

const historyMessages = (store, user) => store.chatHistory(user?.id, 20).map((m) => ({ role: m.role, content: m.body }));

// ---------- provedor: API da Anthropic (SDK oficial) ----------

async function runAnthropic({ store, user, settings, system, message, emit }) {
  let Anthropic;
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default;
  } catch {
    throw new Error('O SDK da Anthropic não está instalado. Rode `npm install` na pasta do quadro.');
  }
  if (!settings.ai_api_key) throw new Error('Informe a chave da API da Anthropic em Configurações → IA.');
  const client = new Anthropic({ apiKey: settings.ai_api_key, ...(settings.ai_base_url ? { baseURL: settings.ai_base_url } : {}) });
  const tools = await inProcessTools(user);
  const messages = [...historyMessages(store, user), { role: 'user', content: message }];
  let text = '';
  const used = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    let response;
    try {
      response = await client.beta.messages.create({
        model: settings.ai_model || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 16000,
        // Se o modelo recusar por política, a API repete a chamada num modelo alternativo.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system,
        tools: tools.list.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
        messages,
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new Error('Chave da API da Anthropic inválida.');
      if (e instanceof Anthropic.RateLimitError) throw new Error('Limite de uso da API atingido. Tente de novo em instantes.');
      if (e instanceof Anthropic.APIError) throw new Error(`API da Anthropic respondeu ${e.status}: ${e.message}`);
      throw e;
    }
    if (response.stop_reason === 'refusal') {
      throw new Error('O modelo recusou este pedido.');
    }
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        text += `${text ? '\n\n' : ''}${block.text}`;
        emit({ type: 'text', text: block.text });
      }
      if (block.type === 'tool_use') {
        used.push(block.name);
        emit({ type: 'tool', name: block.name });
      }
    }
    // O conteúdo completo volta para a conversa (inclui os blocos de raciocínio).
    messages.push({ role: 'assistant', content: response.content });
    if (response.stop_reason !== 'tool_use') break;
    const results = [];
    for (const b of response.content.filter((x) => x.type === 'tool_use')) {
      const out = await tools.run(b.name, b.input, 'claude');
      results.push({
        type: 'tool_result',
        tool_use_id: b.id,
        is_error: !!out.isError,
        content: out.content.map((c) => (c.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }
          : { type: 'text', text: c.text })),
      });
    }
    // Todos os resultados numa única mensagem do usuário.
    messages.push({ role: 'user', content: results });
  }
  return { text, tools: used };
}

// ---------- provedor: compatível com OpenAI ----------

async function runOpenAI({ store, user, settings, system, message, emit }) {
  const base = (settings.ai_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (!settings.ai_model) throw new Error('Informe o modelo em Configurações → IA (ex.: gpt-4.1, openai/gpt-4o no OpenRouter, llama3.1 no Ollama).');
  const tools = await inProcessTools(user);
  const messages = [{ role: 'system', content: system }, ...historyMessages(store, user), { role: 'user', content: message }];
  let text = '';
  const used = [];
  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.ai_api_key ? { authorization: `Bearer ${settings.ai_api_key}` } : {}),
        'x-title': 'Quadro de tarefas',
      },
      body: JSON.stringify({
        model: settings.ai_model,
        messages,
        tools: tools.list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.schema } })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`O provedor respondeu ${res.status}: ${data.error?.message || JSON.stringify(data).slice(0, 200)}`);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new Error('Resposta vazia do provedor');
    if (msg.content?.trim()) {
      text += `${text ? '\n\n' : ''}${msg.content}`;
      emit({ type: 'text', text: msg.content });
    }
    messages.push(msg);
    if (!msg.tool_calls?.length) break;
    for (const call of msg.tool_calls) {
      used.push(call.function.name);
      emit({ type: 'tool', name: call.function.name });
      let args = {};
      try { args = JSON.parse(call.function.arguments || '{}'); } catch {}
      const out = await tools.run(call.function.name, args, 'ia');
      const content = out.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}: ${c.mimeType}]`)).join('\n');
      messages.push({ role: 'tool', tool_call_id: call.id, content });
    }
  }
  return { text, tools: used };
}

// ---------- provedor: CLI do Claude Code ----------

function runCli({ store, user, settings, system, message, emit, res, sessionKey }) {
  return new Promise((resolve, reject) => {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        tarefas: {
          command: process.execPath,
          args: ['--no-warnings', join(SRC, 'mcp.js')],
          // Com usuário logado, o MCP aplica as permissões dele (sem isso teria acesso total).
          env: { CLAUDE_TASKS_DB: store.path, ...(user ? { CLAUDE_TASKS_USER: user.email, CLAUDE_TASKS_ENFORCE: '1' } : {}) },
        },
      },
    });
    const args = [
      '-p', message, '--output-format', 'stream-json', '--verbose', '--model', String(settings.chat_model || 'sonnet'),
      '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig, '--allowedTools', 'mcp__tarefas',
      '--append-system-prompt', system,
    ];
    if (settings[sessionKey]) args.push('--resume', settings[sessionKey]);
    const child = spawn(CLAUDE_BIN, args, { cwd: store.dataDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let text = '';
    let stderr = '';
    let sessionId = null;
    let failure = null;
    const used = [];
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.session_id) sessionId = ev.session_id;
      // Mensagens "<synthetic>" são erros da própria CLI (ex.: login expirado), não respostas.
      if (ev.type === 'assistant' && ev.message?.model !== '<synthetic>') {
        for (const block of ev.message?.content || []) {
          if (block.type === 'text' && block.text.trim()) {
            text += `${text ? '\n\n' : ''}${block.text}`;
            emit({ type: 'text', text: block.text });
          }
          if (block.type === 'tool_use') {
            const name = block.name.replace(/^mcp__tarefas__/, '');
            used.push(name);
            emit({ type: 'tool', name });
          }
        }
      }
      if (ev.type === 'result' && ev.is_error) failure = ev.result || ev.subtype;
    });
    child.stderr.on('data', (c) => { stderr += c; });
    res.on('close', () => { if (child.exitCode === null) child.kill('SIGTERM'); });
    child.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? 'Não encontrei a CLI do Claude (defina CLAUDE_BIN).' : e.message)));
    child.on('close', (code) => {
      if (failure || (code !== 0 && !text)) return reject(new Error(chatError(`${failure || ''}\n${stderr}`)));
      if (sessionId) store.updateSettings({ [sessionKey]: sessionId });
      resolve({ text, tools: used });
    });
  });
}

// ---------- entrada única ----------

const running = new Map();

export async function handleChat({ store, body, user, res }) {
  const key = user?.id ?? 0;
  if (running.has(key)) {
    const err = new Error('O assistente ainda está respondendo a mensagem anterior');
    err.status = 409;
    throw err;
  }
  const message = cleanText(body.message, 'message', { required: true, max: 8000 });
  const project = body.project_id ? store.project(Number(body.project_id)) : null;
  if (project && !store.can(user, project, 'read')) project.id = null;
  const settings = store.settings({ reveal: true });
  const provider = settings.ai_provider || 'claude-cli';
  const system = systemPrompt(store, user, project?.id ? project : null, provider);

  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const emit = (o) => { if (!res.writableEnded) res.write(`${JSON.stringify(o)}\n`); };
  running.set(key, true);
  try {
    const args = { store, user, settings, system, message, emit, res, sessionKey: `chat_session:${key}` };
    const out = provider === 'anthropic' ? await runAnthropic(args) : provider === 'openai' ? await runOpenAI(args) : await runCli(args);
    store.addChatMessage(user?.id, 'user', message);
    store.addChatMessage(user?.id, 'assistant', out.text || 'Feito.', out.tools);
  } catch (e) {
    emit({ type: 'error', message: e.message });
  } finally {
    running.delete(key);
    emit({ type: 'done' });
    res.end();
  }
}
