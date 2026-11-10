// Agentes que escrevem no quadro pelo MCP. A chave fica gravada em tasks.source,
// notes.author e time_entries.author; o nome é o que aparece para as pessoas.
export const AGENTS = { claude: 'Claude', codex: 'Codex' };

export const agentName = (key) => AGENTS[key] || null;

// Qual agente é o cliente MCP, pelo clientInfo do initialize. O Codex se apresenta como
// "codex-mcp-client" (title "Codex"). Qualquer outro cliente conta como Claude, como sempre contou.
export function agentFromClient(info) {
  const id = `${info?.name || ''} ${info?.title || ''}`.toLowerCase();
  return id.includes('codex') ? 'codex' : 'claude';
}

// Em SQL: troca a chave do agente pelo nome e deixa os outros autores como estão.
export const agentNameSql = (column) =>
  `CASE ${column} ${Object.entries(AGENTS).map(([key, name]) => `WHEN '${key}' THEN '${name}'`).join(' ')} ELSE ${column} END`;
