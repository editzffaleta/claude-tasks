#!/usr/bin/env node
// Hook SessionStart do Claude Code: coloca no contexto da sessão as tarefas abertas
// do projeto atual. Nunca bloqueia a sessão: qualquer erro termina em silêncio.
import { BOARD_URL, Store, formatTask } from '../src/db.js';

const LIMIT = 15;

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const { cwd } = JSON.parse(input || '{}');
    const store = new Store();
    const project = store.resolveProject({ project_path: cwd || process.cwd(), create: false });
    if (!project) return;
    const tasks = store.listTasks({ project_id: project.id, status: 'open', limit: 500 });
    if (!tasks.length) return;

    const lines = [
      `Tarefas abertas de "${project.name}" no quadro central de tarefas (${BOARD_URL}/?project=${project.id}):`,
      ...tasks.slice(0, LIMIT).map((t) => `- ${formatTask(t)}`),
    ];
    if (tasks.length > LIMIT) lines.push(`- …e mais ${tasks.length - LIMIT} (use list_tasks para ver todas).`);
    lines.push('Use o MCP "tarefas" para atualizar ou concluir quando trabalhar nelas.');

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') },
    }));
  } catch {}
});
