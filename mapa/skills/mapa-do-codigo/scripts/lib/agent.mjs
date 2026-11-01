// Qual agente de código está rodando a skill: Claude Code ou Codex. O mapa guarda isso, para que a barra de
// perguntas e os botões "Corrigir com …" citem o certo, e o servidor.mjs responda pela mesma CLI.
// --agent <nome> (ou a variável FLOORPLAN_AGENT) decide; senão, cada agente é reconhecido pelas variáveis que
// ele define em todo comando que roda, e qualquer outro caso é tratado como Claude Code. Para acrescentar um
// agente, basta uma entrada aqui.
const DETECT = {
  claude: () => false, // o padrão
  codex: (env) => !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID),
};
export const AGENTS = Object.keys(DETECT);

export function detectAgent(args = {}, env = process.env) {
  const v = String(args.agent || env.FLOORPLAN_AGENT || '').toLowerCase();
  if (AGENTS.includes(v)) return v;
  return AGENTS.find((a) => DETECT[a](env)) || 'claude';
}
