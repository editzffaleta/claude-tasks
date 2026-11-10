#!/usr/bin/env node
// Servidor MCP (stdio) do quadro de tarefas. O Claude Code inicia um destes por sessão;
// todos gravam no mesmo banco SQLite. Implementa tools, resources, prompts e completions.
import { createInterface } from 'node:readline';
import { BOARD_URL } from './db.js';
import { PROMPTS, complete, getPrompt } from './mcp/prompts.js';
import { RESOURCE_TEMPLATES, listResources, readResource } from './mcp/resources.js';
import { TOOLS } from './mcp/tools.js';

const SERVER_INFO = { name: 'tarefas', title: 'Quadro de tarefas', version: '4.3.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = `Central task board shared across ALL of the user's projects (dashboard: ${BOARD_URL}). Keep it current:
- Record pending work with add_tasks: follow-ups you propose, bugs or problems you notice but don't fix, steps left unfinished when you stop, and anything the user says to do later. Don't record steps you will finish in this same turn.
- Always pass project_path = your current working directory so the task lands in the right project (git worktrees map to their main repository).
- Check list_tasks for the project first and update an existing task instead of adding a near-duplicate.
- Short, actionable titles. Descriptions must let someone resume cold: what, why, relevant files, what is already done.
- Break big work into subtasks (parent_id) and record ordering with blocked_by. Set due_date only when there is a real deadline.
- When you start a task from the board, set status "doing" (and start the timer if the user tracks time); "blocked" with a note when stuck. When you finish, call complete_tasks with a one-line note (it stops the timer).
- Use get_overview for "how are things?", time_report for time questions, get_attachment to see screenshots attached to a task.
- Never delete (delete_tasks, manage_project delete) unless the user explicitly asks; prefer archiving.
- Write titles, descriptions and notes in Brazilian Portuguese.`;

const toolList = () => Object.entries(TOOLS).map(([name, t]) => ({
  name,
  title: t.title,
  description: t.description,
  inputSchema: t.inputSchema,
  annotations: { title: t.title, ...t.annotations },
}));

async function callTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) throw Object.assign(new Error(`Ferramenta desconhecida: ${name}`), { code: -32602 });
  try {
    const result = await tool.run(args || {});
    return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result;
  } catch (e) {
    return { content: [{ type: 'text', text: `Erro: ${e.message}` }], isError: true };
  }
}

// ---- JSON-RPC sobre stdio (uma mensagem por linha) ----

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

function handle(msg) {
  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          completions: {},
        },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    }
    case 'ping':
    case 'logging/setLevel':
      return {};
    case 'tools/list':
      return { tools: toolList() };
    case 'tools/call':
      return callTool(params.name, params.arguments);
    case 'resources/list':
      return { resources: listResources() };
    case 'resources/templates/list':
      return { resourceTemplates: RESOURCE_TEMPLATES };
    case 'resources/read':
      return readResource(params.uri);
    case 'prompts/list':
      return {
        prompts: Object.entries(PROMPTS).map(([name, p]) => ({ name, title: p.title, description: p.description, arguments: p.arguments })),
      };
    case 'prompts/get':
      return getPrompt(params.name, params.arguments || {});
    case 'completion/complete':
      return { completion: complete(params) };
    default:
      if (id === undefined) return undefined; // notificação (ex.: notifications/initialized)
      throw Object.assign(new Error(`Método não suportado: ${method}`), { code: -32601 });
  }
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'JSON inválido' } });
  }
  try {
    const result = await handle(msg);
    if (msg.id !== undefined && result !== undefined) send({ id: msg.id, result });
  } catch (e) {
    if (msg.id !== undefined) send({ id: msg.id, error: { code: e.code || -32603, message: e.message } });
  }
});
