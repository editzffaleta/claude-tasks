// mapa-do-codigo/servidor-nucleo.mjs: o núcleo do servidor do mapa, sem HTTP próprio. Responde às perguntas
// feitas no mapa pela CLI do Claude Code ou pelo Codex, salva os fluxos pedidos, altera uma planta, exporta
// uma cópia e avisa as abas abertas quando o mapa é refeito. Copiado pelo build.mjs para a pasta do mapa.
//
// Quem usa: o servidor sozinho (mapa-do-codigo/servidor.mjs, que escuta em 127.0.0.1) e o quadro de tarefas,
// que monta o mesmo núcleo em /mapa/<projectId>/. Por isso o navegador chama a API por caminhos relativos
// (api/ask, api/flows…) e as duas formas funcionam igual.
//
//   const mapa = createMapServer({ root, mapDir, skillDir, engine, model, claudePath, codexPath, idleExit, onIdle, log });
//   mapa.info()                          o objeto injetado como window.FLOORPLAN_SERVER
//   mapa.page(extra)                     o index.html com window.FLOORPLAN_SERVER (mais `extra`) injetado
//   await mapa.handle(req, res, 'ask', { allowAsk, allowChange, allowFlows, user })   true = respondeu
//   mapa.close()                         para as CLIs em andamento, o observador e as abas conectadas
//
// Cada pergunta roda na raiz do código, na conta da própria pessoa: `claude -p` com ferramentas só de leitura
// (Read, Grep, Glob e Bash limitado a mapa-do-codigo/consulta.mjs) ou `codex exec` no sandbox só de leitura.
// Usa o agente que fez o mapa; se ele não estiver instalado, o outro.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MAP_FOLDER = 'mapa-do-codigo';
const FILES = {
  page: 'index.html', graph: 'grafo.json', query: 'consulta.mjs', flows: 'fluxos-pedidos.json',
  plan: 'plano.json', arch: 'arquitetura.json', recent: 'trabalho-recente.json',
};
const HTML = 'text/html; charset=utf-8';
const JSON_TYPE = 'application/json; charset=utf-8';

/** Uma impressão digital dos dois arquivos do servidor, para o open.mjs saber quando reiniciar um servidor antigo. */
export function serverHash(dir = HERE) {
  const h = crypto.createHash('sha1');
  for (const f of ['servidor.mjs', 'servidor-nucleo.mjs']) { try { h.update(fs.readFileSync(path.join(dir, f))); } catch {} h.update('\0'); }
  return h.digest('hex').slice(0, 12);
}

// ---------- exportar: uma cópia do mapa para compartilhar ----------
// A mesma página autossuficiente, marcada como exportada: sem barra de perguntas, sem pedidos ao Claude ou ao
// Codex, sem links para este computador, e só com os extras pedidos. Usada pelo botão Exportar e por --export.
export const EXPORT_PARTS = ['flows', 'notes', 'recent', 'health'];
export const EXPORT_DEFAULT = ['flows', 'notes'];
const DATA_START = '<script>window.FLOORPLAN = ';
const plainError = (message) => Object.assign(new Error(message), { plain: true });
/** Um nome de arquivo a partir do nome do projeto: "Gestão de Pedidos" vira "gestao-de-pedidos". */
const slugify = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function exportMap(mapDir, include = EXPORT_DEFAULT, extraFlows = []) {
  let html;
  try { html = fs.readFileSync(path.join(mapDir, FILES.page), 'utf8'); } catch { throw plainError('Este projeto ainda não tem mapa. Peça ao Claude ou ao Codex para fazer o mapa do código primeiro.'); }
  const a = html.indexOf(DATA_START), b = html.indexOf(';</script>', a);
  if (a < 0 || b < 0) throw plainError('Este mapa é antigo demais para exportar. Peça ao Claude ou ao Codex para atualizar o mapa do código primeiro.');
  const g = JSON.parse(html.slice(a + DATA_START.length, b));
  const on = EXPORT_PARTS.filter((p) => include.includes(p));
  const out = {
    ...g,
    // o remote pode levar um token de acesso; o caminho da pasta é deste computador
    meta: { ...g.meta, root: null, repos: (g.meta.repos || []).map(({ remote, ...r }) => r), exported: { at: new Date().toISOString(), include: on } },
    flows: on.includes('flows') ? [...(g.flows || []), ...extraFlows.filter((f) => !(g.flows || []).some((x) => x.id === f.id))] : [],
    tour: on.includes('flows') ? g.tour : [],
    files: on.includes('notes') ? g.files : g.files.map(({ note, ...f }) => f),
  };
  if (!on.includes('recent')) delete out.recent;
  if (!on.includes('health')) delete out.health;
  const json = JSON.stringify(out).replace(/<\/(script)/gi, '<\\/$1').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const slug = slugify(g.project?.name) || 'projeto';
  return { html: html.slice(0, a + DATA_START.length) + json + html.slice(b), name: `${slug}-mapa.html`, include: on, plan: !!g.meta?.blueprint };
}
/** Os fluxos pedidos no mapa desde o último build, do jeito que a página manda: conferidos e aparados. */
export const cleanFlows = (list) => (Array.isArray(list) ? list : []).slice(0, 50)
  .filter((f) => f && typeof f.id === 'string' && Array.isArray(f.steps))
  .map((f) => ({
    id: f.id.slice(0, 100), title: String(f.title || 'Fluxo').slice(0, 200), description: String(f.description || '').slice(0, 1000), custom: true,
    steps: f.steps.slice(0, 60).filter((s) => s && typeof s.ref === 'string').map((s) => ({ ref: s.ref.slice(0, 300), note: String(s.note || '').slice(0, 2000) })),
  }))
  .filter((f) => f.steps.length >= 2);

// ---------- achar a CLI que responde: Claude Code ou Codex ----------
function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}
/** Devolve { cmd, args, path } para rodar, ou null. Lida com instalações nativas, atalhos do npm no Windows e arquivos .js. */
function resolveCli(candidates, npmEntry) {
  for (const c of candidates) {
    if (!c || !fs.existsSync(c)) continue;
    if (/\.(m?js)$/i.test(c)) return { cmd: process.execPath, args: [c], path: c };
    if (/\.(cmd|bat|ps1)$/i.test(c) || (process.platform === 'win32' && !path.extname(c))) {
      // atalho do npm: roda o JS de entrada com o node direto (rodar .cmd exige um shell)
      const cli = path.join(path.dirname(c), 'node_modules', ...npmEntry);
      if (fs.existsSync(cli)) return { cmd: process.execPath, args: [cli], path: c };
      const exe = c.replace(/\.(cmd|bat|ps1)$/i, '.exe');
      if (exe !== c && fs.existsSync(exe)) return { cmd: exe, args: [], path: exe };
      // instalações novas do npm trazem um programa de verdade dentro do pacote (bin/claude.exe) e nenhum JS de entrada
      const pkgExe = path.join(path.dirname(c), 'node_modules', ...npmEntry.slice(0, 2), 'bin', path.basename(c).replace(/\.[^.]*$/, '') + '.exe');
      if (fs.existsSync(pkgExe)) return { cmd: pkgExe, args: [], path: pkgExe };
      continue;
    }
    return { cmd: c, args: [], path: c };
  }
  return null;
}
const HOME = process.env.HOME || process.env.USERPROFILE || '';
/** O app desktop do Codex guarda a CLI numa pasta com a versão no nome; a mais nova primeiro. */
function codexApp() {
  if (process.platform === 'darwin') return ['/Applications/Codex.app/Contents/Resources/codex'];
  if (process.platform !== 'win32') return [];
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    return fs.readdirSync(base).map((d) => path.join(base, d, 'codex.exe')).filter((f) => fs.existsSync(f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return []; }
}
// Os agentes que podem responder: como se chamam, onde instalar, como achar a CLI e se as respostas seguem um
// schema (structured). Alterar uma planta pelo mapa precisa disso, então Alterar só aparece com um motor assim.
// schemaFile: a CLI lê o schema de um arquivo em vez da linha de comando.
const ENGINES = {
  claude: {
    name: 'CLI do Claude Code', the: 'a CLI do Claude Code', site: 'https://docs.claude.com/en/docs/claude-code', structured: true,
    find: (given) => resolveCli(given ? [given] : [
      ...which('claude'),
      path.join(HOME, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'),
      ...(process.platform === 'win32' ? [path.join(process.env.APPDATA || '', 'npm', 'claude.cmd')] : []),
    ], ['@anthropic-ai', 'claude-code', 'cli.js']),
  },
  codex: {
    name: 'Codex', the: 'o Codex', site: 'https://developers.openai.com/codex', structured: true, schemaFile: true,
    find: (given) => resolveCli(given ? [given] : [...which('codex'), ...codexApp()], ['@openai', 'codex', 'bin', 'codex.js']),
  },
};
const isEngine = (k) => typeof k === 'string' && Object.hasOwn(ENGINES, k);
// O quadro cria um núcleo por projeto: a CLI encontrada e a versão dela valem para todos.
const found = new Map();
function findCli(k, given) {
  const key = `${k}|${given || ''}`;
  if (found.has(key)) return found.get(key);
  const cli = ENGINES[k].find(given);
  if (!cli) return null; // não guarda a ausência: ela pode ser instalada depois
  let version = null;
  try { version = execFileSync(cli.cmd, [...cli.args, '--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch {}
  const hit = { ...cli, version };
  found.set(key, hit);
  return hit;
}
// Iniciado de dentro de uma sessão do Claude Code ou do Codex? A CLI não pode achar que está aninhada nela.
function cliEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^CLAUDE_?CODE_(SESSION|ENTRYPOINT|CHILD|MESSAGING|HOST|SDK)|^CLAUDECODE$|^CODEX_(THREAD_ID|SESSION_ID|TOOL_CALL_ID|CI$|SANDBOX)/.test(k)) delete env[k];
  return env;
}

/** O OpenAI structured outputs quer toda propriedade obrigatória e nada a mais; listas opcionais só voltam vazias. */
function strict(s) {
  if (s?.type === 'object' && s.properties) return { ...s, properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strict(v)])), required: Object.keys(s.properties), additionalProperties: false };
  if (s?.type === 'array') return { ...s, items: strict(s.items) };
  return s;
}
function parseAnswer(ev) {
  if (ev.structured_output && typeof ev.structured_output === 'object') return ev.structured_output;
  const t = String(ev.result || '');
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
  for (const cand of [t, fence?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) { try { const v = JSON.parse(cand); if (v && typeof v === 'object') return v; } catch {} }
  return { title: 'Resposta', answer: t, items: [] };
}
const failCode = (msg) => /not logged in|logged out|\/login|log ?in again|sign in|authenticat|unauthori[sz]ed|\b401\b|não (está )?conectad|faça login|entre na sua conta/i.test(msg) ? 'not_logged_in'
  : /usage limit|rate limit|too many requests|\b429\b|limite de uso/i.test(msg) ? 'rate_limited' : 'cli_error';
/** As linhas "  - …" sob o título "✗ N erro(s)" dos scripts (os avisos vêm depois, sob "!"). */
function problems(text) {
  const out = [];
  let inErrors = false;
  for (const l of String(text || '').split('\n')) {
    if (/^✗/.test(l)) inErrors = true;
    else if (/^\S/.test(l)) inErrors = false;
    else if (inErrors && /^\s+- /.test(l)) out.push(l.trim().slice(2));
  }
  return out;
}
/** Quantos arquivos o build.mjs --check deixou sem parte (aceita a saída em português e a antiga, em inglês). */
const unassignedCount = (text) => +(/(\d+) (?:sem (?:parte|dono|nó|lugar)|não atribuídos?|fora de (?:todas as partes|qualquer parte)|unassigned)/i.exec(String(text || ''))?.[1] || 0);

// O que a pessoa lê vem em português do Brasil. As instruções do mapa (graph-query.js) já pedem isso; esta linha
// garante, caso venha uma versão que não peça.
const PT_ANSWER = 'Escreva em português do Brasil, de forma natural e direta, tudo o que a pessoa vai ler: title, answer, description, as notes e os followups. Ids, caminhos de arquivo, métodos e URLs e nomes no código ficam como estão.';
const PT_CHANGE = 'Escreva em português do Brasil tudo o que a pessoa vai ler: title, summary, as notes, os followups e os nomes, descrições, resumos, suposições e perguntas que você puser no plano e na arquitetura. Ids, caminhos de arquivo, métodos e URLs ficam como estão.';
const withPt = (text, pt) => (/portugu[eê]s do brasil/i.test(text) ? text : `${text}\n${pt}`);

const MSG = {
  noAsk: 'Você só pode ver este mapa: perguntar exige permissão de edição no projeto.',
  noChange: 'Alterar a planta exige ser gerente do projeto.',
  noFlows: 'Você só pode ver este mapa: salvar ou apagar fluxos exige permissão de edição no projeto.',
  tooBig: 'O pedido é grande demais.',
  noMap: 'Este projeto ainda não tem mapa. Peça ao Claude ou ao Codex para fazer o mapa do código.',
};
const CLOSED = Symbol('closed'); // o navegador foi embora no meio do pedido
const TOO_BIG = Symbol('too-big');

/**
 * Cria o núcleo do servidor de um mapa.
 * @param {object} o
 * @param {string} o.root        a raiz do código (onde as perguntas rodam)
 * @param {string} [o.mapDir]    a pasta do mapa (padrão: <root>/mapa-do-codigo)
 * @param {string} [o.skillDir]  a pasta da skill, com scripts/plan.mjs e scripts/build.mjs, para alterar uma planta
 *                               (padrão: a que o build.mjs gravou em <mapDir>/.cache/skill.json)
 * @param {'claude'|'codex'} [o.engine]  força um motor (padrão: FLOORPLAN_ENGINE, senão o que fez o mapa)
 * @param {string} [o.model]     modelo para a CLI (padrão: FLOORPLAN_MODEL)
 * @param {string} [o.claudePath] caminho da CLI do Claude Code (padrão: FLOORPLAN_CLAUDE, senão procura)
 * @param {string} [o.codexPath]  caminho da CLI do Codex (padrão: FLOORPLAN_CODEX, senão procura)
 * @param {number} [o.idleExit]  minutos sem nenhuma aba aberta até chamar onIdle (0 = nunca)
 * @param {Function} [o.onIdle]  o que fazer então (padrão: encerrar o processo)
 * @param {{log: Function, error: Function}} [o.log]  para onde vão as mensagens (padrão: console)
 */
export function createMapServer({
  root, mapDir, skillDir, engine: askedEngine, model, claudePath, codexPath, idleExit = 0, onIdle, log = console,
  // Código de consulta a usar no lugar do consulta.mjs da pasta do mapa. O quadro passa o do próprio
  // plugin, para não executar no processo dele um arquivo que veio da pasta de um projeto.
  querySource = null,
} = {}) {
  if (!root) throw new Error('createMapServer precisa de root (a raiz do código).');
  root = path.resolve(root);
  mapDir = path.resolve(mapDir || path.join(root, MAP_FOLDER));
  const file = (name) => path.join(mapDir, name);
  const cacheDir = path.join(mapDir, '.cache');
  const relMap = path.relative(root, mapDir).replace(/\\/g, '/') || '.';
  const queryCmd = `node ${relMap}/${FILES.query}`;
  const token = crypto.randomBytes(16).toString('hex');
  const hash = serverHash();
  model = model ?? process.env.FLOORPLAN_MODEL ?? '';
  const asked = askedEngine ?? process.env.FLOORPLAN_ENGINE;
  const given = { claude: claudePath ?? process.env.FLOORPLAN_CLAUDE, codex: codexPath ?? process.env.FLOORPLAN_CODEX };
  const say = (...a) => { try { log?.log?.(...a); } catch {} };
  const shout = (...a) => { try { log?.error?.(...a); } catch {} };

  // ---------- qual motor responde ----------
  // engine (ou FLOORPLAN_ENGINE) decide; senão o agente que fez o mapa, depois os outros, na ordem
  let want = 'claude', engine = null, cli = null, checkedAt = 0;
  function detect() {
    let builtBy = null;
    try { builtBy = JSON.parse(fs.readFileSync(file(FILES.graph), 'utf8')).meta?.agent; } catch {}
    want = isEngine(asked) ? asked : isEngine(builtBy) ? builtBy : 'claude';
    engine = null; cli = null;
    for (const k of isEngine(asked) ? [asked] : [want, ...Object.keys(ENGINES).filter((x) => x !== want)]) {
      try { cli = findCli(k, given[k]); } catch { cli = null; }
      if (cli) { engine = k; break; }
    }
    checkedAt = Date.now();
  }
  /** Sem CLI? Procura de novo de vez em quando: ela pode ter sido instalada com o quadro aberto. */
  const recheck = () => {
    if (cli || Date.now() - checkedAt <= 30000) return;
    detect();
    if (cli) { try { load(); } catch {} } // o Codex precisa dos schemas em arquivo
  };
  detect();
  const canChange = () => !engine || ENGINES[engine].structured;

  // ---------- o grafo e as instruções (do código de consulta que o build embutiu em consulta.mjs) ----------
  // Carregado no início e de novo sempre que o mapa é refeito. Um mapa que ainda não existe não é erro aqui:
  // a página e as perguntas avisam.
  let G = null, core = null, MODES = null;
  function load() {
    const g = JSON.parse(fs.readFileSync(file(FILES.graph), 'utf8'));
    const coreSrc = (querySource ?? fs.readFileSync(file(FILES.query), 'utf8')).split('// ---- cli ----')[0];
    const c = new Function(`${coreSrc.replace(/^import .*$/gm, '')}; return { FLOORPLAN_ANSWER_SCHEMA, FLOORPLAN_FLOW_SCHEMA, FLOORPLAN_CHANGE_SCHEMA, floorplanAskInstructions, floorplanFlowInstructions, floorplanChangeInstructions, createGraphQuery };`)();
    c.q = c.createGraphQuery(g);
    // tipos de pedido: uma pergunta (resposta + quadro), um fluxo novo e, numa planta, uma alteração do plano
    const modes = {
      ask: { instructions: withPt(c.floorplanAskInstructions(g, 'cli'), PT_ANSWER), schema: c.FLOORPLAN_ANSWER_SCHEMA, file: path.join(cacheDir, 'answer-schema.json') },
      flow: { instructions: withPt(c.floorplanFlowInstructions(g, 'cli'), PT_ANSWER), schema: c.FLOORPLAN_FLOW_SCHEMA, file: path.join(cacheDir, 'flow-schema.json') },
      ...(g.meta?.blueprint && canChange() ? { change: { instructions: withPt(c.floorplanChangeInstructions(g), PT_CHANGE), schema: c.FLOORPLAN_CHANGE_SCHEMA, file: path.join(cacheDir, 'change-schema.json') } } : {}),
    };
    if (ENGINES[engine]?.schemaFile) {
      fs.mkdirSync(cacheDir, { recursive: true });
      for (const m of Object.values(modes)) fs.writeFileSync(m.file, JSON.stringify(strict(m.schema)));
    }
    G = g; core = c; MODES = modes;
  }
  const ready = () => { if (!core) { try { load(); } catch { return false; } } return true; };
  ready();

  // ---------- abas abertas: recarregar ao vivo e encerrar por inatividade ----------
  const tabs = new Set();
  const running = new Map(); // id → { child, owner }
  let lastTab = Date.now();
  const broadcast = (event, data = {}) => { for (const t of tabs) { try { t.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} } };
  let reloadTimer = null;
  const watched = file(FILES.page);
  const onPageChange = (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) return;
    // o build grava vários arquivos: espera terminar, e continua com o mapa antigo se o novo estiver pela metade
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      try { if (!cli) detect(); load(); broadcast('reload'); say('mapa refeito: as abas abertas foram recarregadas'); } catch {}
    }, 800);
  };
  fs.watchFile(watched, { interval: 1000 }, onPageChange);
  const idleMs = Number(idleExit || 0) * 60000;
  const idleTimer = idleMs > 0
    ? setInterval(() => { if (!tabs.size && !running.size && Date.now() - lastTab > idleMs) (onIdle || (() => process.exit(0)))(); }, 60000)
    : null;
  idleTimer?.unref?.();
  const readFlows = () => { try { return JSON.parse(fs.readFileSync(file(FILES.flows), 'utf8')).flows || []; } catch { return []; } };

  // ---------- perguntar ----------
  const nameFor = (id) => { try { return core.q.brief(id)?.name || id; } catch { return id; } };
  const rel = (p) => String(p || '').replace(/\\/g, '/').replace(root.replace(/\\/g, '/') + '/', '');
  /** Um comando de shell, em palavras: consultas ao mapa pelo nome, depois buscas, leituras e listagens. */
  function describeCommand(command) {
    let c = String(command || '');
    // o Codex embrulha cada comando num shell: bash -lc '…' ou powershell.exe -Command "…"
    const wrapped = /\s-(?:l?c|Command)\s+(["'])([\s\S]*)\1\s*$/i.exec(c);
    if (wrapped) c = wrapped[2].replace(/\\(["'])/g, '$1');
    const cmds = c.split(/\s*(?:&&|;|\|\|?)\s*/).filter(Boolean);
    // os agentes costumam encadear várias consultas num comando só; descreve cada uma, pelo nome
    const parts = cmds.map((x) => /(?:consulta|query)\.mjs\s+([\w-]+)\s*(.*)$/.exec(x)).filter(Boolean);
    if (parts.length) {
      const one = ([, cmd, rest]) => {
        const a = rest.replace(/--[\w-]+\s+\S+/g, '').replace(/["']/g, '').trim();
        const names = (sep) => a.split(/\s+/).filter(Boolean).map(nameFor).join(sep);
        const kind = { 'visao-geral': 'overview', buscar: 'find', mostrar: 'show', caminho: 'path' }[cmd] || cmd;
        return {
          overview: 'Lendo a visão geral do mapa',
          find: a ? `Procurando "${a}" no mapa` : 'Procurando no mapa',
          show: `Olhando ${names(', ')}`,
          path: `Traçando um caminho ${names(' → ')}`,
        }[kind] || 'Consultando o mapa';
      };
      return parts.slice(0, 2).map(one).join(' · ') + (parts.length > 2 ? ` (+${parts.length - 2})` : '');
    }
    const first = cmds[0] || '';
    if (/^(rg|grep|git grep|Select-String|findstr)\b/i.test(first) && !/\s--files\b/.test(first)) {
      const pat = /\s(["'])(.+?)\1/.exec(first)?.[2] || /\s(?:-Pattern\s+)?([^\s-][^\s]*)/i.exec(first.replace(/^\S+(\s+-\S+)*/, ''))?.[1];
      return pat ? `Procurando "${pat}" no código` : 'Procurando no código';
    }
    if (/^(rg\s.*--files|ls|dir|Get-ChildItem|gci|find|tree)\b/i.test(first)) return 'Listando arquivos';
    if (/^(cat|type|Get-Content|gc|sed|head|tail|nl|more|less)\b/i.test(first)) {
      const f = [...first.matchAll(/[\w@.\\/-]+\.\w{1,6}\b/g)].map((m) => m[0]).pop();
      return f ? `Lendo ${rel(f)}` : 'Lendo um arquivo';
    }
    return 'Rodando um comando';
  }
  function describeTool(name, input = {}) {
    if (name === 'Bash') return describeCommand(input.command);
    // um resultado longo que a CLI guardou para ler em partes fica fora do projeto
    if (name === 'Read') return /[\\/]tool-results[\\/]/.test(input.file_path || '') ? 'Lendo o resto de um arquivo longo' : `Lendo ${rel(input.file_path)}`;
    if (name === 'Grep') return `Procurando "${input.pattern}" no código`;
    if (name === 'Glob') return `Listando ${input.pattern}`;
    return name;
  }
  // Claude Code: `claude -p` com ferramentas só de leitura, respondendo no schema; as continuações retomam a sessão
  function claudeRun(body, mode) {
    const args = [...cli.args, '-p', '--output-format', 'stream-json', '--verbose',
      '--json-schema', JSON.stringify(mode.schema), '--append-system-prompt', mode.instructions,
      '--tools', 'Read,Grep,Glob,Bash', '--allowedTools', `Bash(${queryCmd}:*)`, 'Read', 'Grep', 'Glob'];
    if (body.session) args.push('--resume', String(body.session));
    if (model) args.push('--model', model);
    return {
      args, input: String(body.question || '').slice(0, 4000),
      onEvent(ev, out) {
        if (ev.type === 'assistant') for (const c of ev.message?.content || []) if (c.type === 'tool_use') out.progress(describeTool(c.name, c.input));
        if (ev.type !== 'result') return;
        if (ev.is_error) out.fail(String(ev.result || ev.subtype || 'O Claude Code informou um erro.'));
        else out.answer({ ...parseAnswer(ev), session: ev.session_id });
      },
    };
  }
  // Codex: `codex exec` no sandbox só de leitura, respondendo no schema. As execuções são efêmeras (nada vai
  // para o histórico do Codex da pessoa), então uma continuação leva junto as últimas perguntas e respostas.
  const convos = new Map();
  function codexRun(body, mode) {
    const session = convos.has(body.session) ? body.session : crypto.randomBytes(8).toString('hex');
    const turns = convos.get(session) || [];
    const question = String(body.question || '').slice(0, 4000);
    const earlier = turns.length ? `\n\nAntes, nesta conversa:\n${turns.map((t) => `P: ${t.q}\nR: ${t.a}`).join('\n\n')}` : '';
    const args = [...cli.args, 'exec', '--json', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral',
      '--output-schema', mode.file, '-C', root];
    if (model) args.push('--model', model);
    args.push('-');
    let last = '', error = '';
    return {
      args, input: `${mode.instructions}${earlier}\n\nO pedido:\n${question}`,
      onEvent(ev, out) {
        if (ev.type === 'item.started' && ev.item?.type === 'command_execution') out.progress(describeCommand(ev.item.command));
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') last = String(ev.item.text || '');
        if (ev.type === 'error') error = String(ev.message || error);
        if (ev.type === 'turn.failed') out.fail(String(ev.error?.message || error || 'O Codex informou um erro.'));
        if (ev.type === 'turn.completed') {
          const a = parseAnswer({ result: last });
          convos.set(session, [...turns, { q: question.slice(0, 500), a: String(a.answer || '').slice(0, 1500) }].slice(-4));
          if (convos.size > 200) convos.delete(convos.keys().next().value);
          out.answer({ ...a, session });
        }
      },
      lastError: () => error,
    };
  }
  const RUNS = { claude: claudeRun, codex: codexRun };
  /** Roda o agente uma vez para um pedido e resolve com a resposta, mandando o progresso por `send`. */
  function runAgent(res, send, body, owner) {
    return new Promise((resolve, reject) => {
      const run = RUNS[engine](body, MODES[body.mode] || MODES.ask);
      const child = spawn(cli.cmd, run.args, { cwd: root, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const id = crypto.randomBytes(6).toString('hex');
      running.set(id, { child, owner });
      send('start', { id });
      child.stdin.on('error', () => {});
      child.stdin.end(run.input);
      let buf = '', stderr = '', done = false;
      // pensar e escrever um plano inteiro tem longos trechos sem nada a contar: avisa depois de um silêncio
      let quiet = null, said = '';
      const tell = (text) => { if (!done && text !== said) { said = text; send('progress', { text }); } };
      const hush = () => { clearTimeout(quiet); if (body.mode === 'change' && !done) quiet = setTimeout(() => tell('Trabalhando no plano atualizado'), 12000); };
      const out = {
        progress: (text) => { if (!done) { tell(text); hush(); } },
        answer: (data) => { if (!done) { done = true; clearTimeout(quiet); resolve(data); } },
        fail: (message) => { if (!done) { done = true; clearTimeout(quiet); reject(new Error(message)); } },
      };
      hush();
      child.stdout.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch { continue; }
          run.onEvent(ev, out);
        }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
      child.on('error', (e) => out.fail(e.message));
      child.on('close', (code) => {
        running.delete(id);
        out.fail(run.lastError?.() || stderr.trim() || `${ENGINES[engine].name} terminou com o código ${code}.`);
      });
      // o navegador foi embora (aba fechada, Parar): não deixa a CLI trabalhando. O 'close' do req dispara assim
      // que o corpo é lido, então observa a resposta.
      res.on('close', () => { if (!done) { done = true; clearTimeout(quiet); child.kill(); reject(CLOSED); } });
    });
  }
  function ask(res, body, owner) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    recheck();
    if (!cli) { send('failure', { code: 'cli_missing', message: `Não encontrei ${ENGINES[want].the}.` }); return res.end(); }
    if (!ready()) { send('failure', { code: 'cli_error', message: MSG.noMap }); return res.end(); }
    if (body.mode === 'change') return changePlan(res, send, body, owner);
    runAgent(res, send, body, owner)
      .then((a) => send('answer', a), (e) => { if (e !== CLOSED) send('failure', { code: failCode(e.message), message: e.message }); })
      .finally(() => res.end());
  }

  // ---------- alterar uma planta pelo mapa ----------
  // O agente continua só lendo: devolve o plano.json e o arquitetura.json inteiros, atualizados, e este servidor
  // confere os dois com o plan.mjs e o build.mjs da skill, salva e redesenha o mapa, o que recarrega todas as
  // abas abertas. Cada alteração guarda os arquivos que substituiu, para Desfazer.
  const historyDir = path.join(cacheDir, 'history');
  const PLAN_FILES = [FILES.plan, FILES.arch, FILES.recent];
  let changing = false;
  function snapshot() {
    const dir = path.join(historyDir, Date.now().toString(36) + crypto.randomBytes(2).toString('hex'));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of PLAN_FILES) if (fs.existsSync(file(f))) fs.copyFileSync(file(f), path.join(dir, f));
    for (const old of fs.readdirSync(historyDir).sort().slice(0, -20)) fs.rmSync(path.join(historyDir, old), { recursive: true, force: true });
    return dir;
  }
  function restore(dir) {
    for (const f of PLAN_FILES) { const from = path.join(dir, f), to = file(f); if (fs.existsSync(from)) fs.copyFileSync(from, to); else fs.rmSync(to, { force: true }); }
  }
  /** Roda um dos scripts da skill neste projeto; lança um erro com a saída dele quando falha. */
  function skillScript(name, ...args) {
    let dir = skillDir;
    if (!dir) { try { dir = JSON.parse(fs.readFileSync(path.join(cacheDir, 'skill.json'), 'utf8')).dir; } catch {} }
    if (!dir || !fs.existsSync(path.join(dir, 'scripts', name))) throw new Error('O servidor deste mapa não achou os scripts do Mapa do código. Peça ao Claude Code ou ao Codex para atualizar o mapa do código uma vez e tente de novo.');
    try { return execFileSync(process.execPath, [path.join(dir, 'scripts', name), root, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout: 120000 }); }
    catch (e) { throw Object.assign(new Error(String(e.stdout || '') + String(e.stderr || '') || e.message), { checks: true }); }
  }
  /** Confere e salva um plano atualizado. Devolve { ok, undo } ou { errors } sem mudar nada. */
  function applyChange(data, request, lastTry) {
    const parse = (text) => { try { const v = JSON.parse(String(text || '')); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };
    const plan = parse(data.plan), arch = parse(data.architecture);
    if (!plan || !arch) return { errors: [`o campo "${!plan ? 'plan' : 'architecture'}" não é um objeto JSON completo`] };
    const snap = snapshot();
    const write = (f, v) => fs.writeFileSync(file(f), JSON.stringify(v, null, 2) + '\n');
    try {
      write(FILES.plan, plan);
      write(FILES.arch, arch);
      const items = (Array.isArray(data.changes) ? data.changes : []).filter((c) => c && typeof c.ref === 'string').map((c) => ({ ref: c.ref, change: c.change === 'changed' ? 'changed' : 'new', note: String(c.note || '') }));
      // o painel Trabalho recente mostra texto simples: o primeiro parágrafo do resumo, sem marcas de Markdown
      const plain = String(data.summary || '').split(/\n\s*\n/)[0].replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
      write(FILES.recent, { updatedAt: new Date().toISOString(), tasks: [{ title: String(data.title || 'Plano alterado').slice(0, 80), request, summary: plain, status: 'planejado, ainda não construído', items }] });
      skillScript('plan.mjs');
      const check = skillScript('build.mjs', '--check');
      const unassigned = unassignedCount(check);
      if (unassigned && !lastTry) throw Object.assign(new Error(''), { checks: true, list: [`${unassigned} arquivo(s) planejado(s) não cabem nos paths de nenhum nó do ${FILES.arch} (adicione ou amplie os globs)`] });
      skillScript('build.mjs', '--no-claude-md');
      return { ok: true, undo: path.basename(snap) };
    } catch (e) {
      restore(snap);
      fs.rmSync(snap, { recursive: true, force: true });
      try { skillScript('plan.mjs'); } catch {}
      if (!e.checks) throw e;
      const found = problems(e.message);
      return { errors: e.list || found.slice(0, 12).concat(found.length ? [] : [e.message.trim().split('\n').pop()]) };
    }
  }
  async function changePlan(res, send, body, owner) {
    const request = String(body.question || '').slice(0, 4000);
    if (!MODES.change) { send('failure', { code: 'cli_error', message: G.meta?.blueprint ? `${ENGINES[engine].the} não consegue alterar uma planta pelo mapa.` : 'Só uma planta pode ser alterada pelo mapa.' }); return res.end(); }
    if (changing) { send('failure', { code: 'busy', message: 'Outra alteração nesta planta ainda está em andamento. Tente de novo quando ela terminar.' }); return res.end(); }
    changing = true;
    let session, errors = null;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const question = errors
          ? `Seu plano atualizado não passou nas verificações, então nada foi salvo:\n${errors.map((e) => `- ${e}`).join('\n')}\n\nCorrija esses pontos e responda de novo com os arquivos completos. O pedido era: ${request}`
          : request;
        const data = await runAgent(res, send, { question, session, mode: 'change' }, owner);
        session = data.session || session;
        send('progress', { text: 'Conferindo o plano atualizado' });
        const r = applyChange(data, request, attempt === 1);
        if (r.ok) {
          say(`planta alterada: ${data.title || request.slice(0, 60)}`);
          send('answer', { title: String(data.title || ''), summary: String(data.summary || ''), changes: (data.changes || []).length, followups: Array.isArray(data.followups) ? data.followups.map(String).slice(0, 3) : [], undo: r.undo });
          return;
        }
        errors = r.errors;
        send('progress', { text: `Corrigindo ${errors.length === 1 ? 'um problema' : `${errors.length} problemas`} que as verificações encontraram` });
      }
      send('failure', { code: 'change_invalid', message: `O plano atualizado não passou nas verificações, então nada mudou:\n${errors.slice(0, 6).map((e) => `- ${e}`).join('\n')}` });
    } catch (e) {
      if (e !== CLOSED) send('failure', { code: failCode(String(e.message || e)), message: String(e.message || e) });
    } finally { changing = false; res.end(); }
  }
  /** Devolve os arquivos que uma alteração substituiu (a mais recente primeiro) e redesenha. */
  function undoChange() {
    const all = fs.existsSync(historyDir) ? fs.readdirSync(historyDir).sort() : [];
    if (!all.length) return { ok: false, error: 'Nada para desfazer.' };
    const dir = path.join(historyDir, all[all.length - 1]);
    restore(dir);
    try { skillScript('plan.mjs'); skillScript('build.mjs', '--no-claude-md'); } catch (e) {
      shout(`✗ Desfazer não conseguiu redesenhar o plano: ${e.message || e}`);
      return { ok: false, error: 'Não consegui redesenhar o plano anterior. Os detalhes estão na saída do servidor do mapa.' };
    }
    fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true, left: all.length - 1 };
  }

  // ---------- HTTP ----------
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': JSON_TYPE, 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const deny = (res, message) => json(res, 403, { ok: false, code: 'forbidden', error: message, message });
  /** O corpo JSON do pedido. Aceita um corpo que quem monta o núcleo já leu (req.body). */
  function readBody(req, limit) {
    if (req.body !== undefined) {
      if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
      try { return Promise.resolve(JSON.parse(String(req.body || '')) || {}); } catch { return Promise.resolve({}); }
    }
    if (req.readableEnded) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      let raw = '', over = false;
      req.on('data', (d) => { if (over) return; raw += d; if (raw.length > limit) { over = true; reject(TOO_BIG); } });
      req.on('end', () => { if (over) return; let body = {}; try { body = JSON.parse(raw) || {}; } catch {} resolve(body); });
      req.on('error', () => { if (!over) { over = true; reject(CLOSED); } });
    });
  }
  async function bodyOr(req, res, limit) {
    try { return await readBody(req, limit); } catch (e) {
      if (e === TOO_BIG && !res.headersSent) { res.setHeader('Connection', 'close'); json(res, 413, { ok: false, error: MSG.tooBig }); }
      req.resume?.();
      return null;
    }
  }
  const ROUTES = {
    events: {
      GET(req, res) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 1000\n\n'); // reconecta logo depois de um reinício
        tabs.add(res);
        const bye = () => { if (tabs.delete(res)) lastTab = Date.now(); };
        req.on('close', bye); res.on('close', bye);
      },
    },
    status: { GET: (req, res) => json(res, 200, { tabs: tabs.size, pid: process.pid, hash, root }) },
    health: { GET: (req, res) => { recheck(); json(res, 200, { cli: !!cli, engine, want, version: cli?.version || null, path: cli?.path || null }); } },
    // os fluxos pedidos ficam ao lado do mapa; o build.mjs os junta no grafo.json
    flows: {
      GET: (req, res) => json(res, 200, { flows: readFlows() }),
      POST: (req, res, opts) => saveFlows(req, res, opts),
      DELETE: (req, res, opts) => saveFlows(req, res, opts),
    },
    'plan/undo': {
      POST(req, res, opts) {
        if (opts.allowChange === false) return deny(res, MSG.noChange);
        req.resume?.();
        json(res, 200, changing ? { ok: false, error: 'Uma alteração ainda está em andamento.' } : undoChange());
      },
    },
    cancel: {
      async POST(req, res, opts) {
        if (opts.allowAsk === false) return deny(res, MSG.noAsk);
        const body = await bodyOr(req, res, 2000);
        if (!body) return;
        const owner = opts.user ?? null;
        for (const [id, r] of running) if (body.id ? id === body.id : r.owner === owner) r.child.kill();
        res.writeHead(204); res.end();
      },
    },
    export: {
      async POST(req, res) {
        const body = await bodyOr(req, res, 500000);
        if (!body) return;
        try {
          const x = exportMap(mapDir, Array.isArray(body.include) ? body.include.map(String) : EXPORT_DEFAULT, cleanFlows(body.flows));
          res.writeHead(200, { 'Content-Type': HTML, 'Content-Disposition': `attachment; filename="${x.name}"`, 'Cache-Control': 'no-store' });
          res.end(x.html);
        } catch (e) {
          shout(`✗ Não consegui exportar o mapa: ${e.message}`);
          json(res, 500, { error: e.plain ? e.message : 'O servidor do mapa não conseguiu exportá-lo. Os detalhes estão na saída dele.' });
        }
      },
    },
    ask: {
      async POST(req, res, opts) {
        if (opts.allowAsk === false) { req.resume?.(); return deny(res, MSG.noAsk); }
        const body = await bodyOr(req, res, 20000);
        if (!body) return;
        if (body.mode === 'change' && opts.allowChange === false) return deny(res, MSG.noChange);
        ask(res, body, opts.user ?? null);
      },
    },
  };
  async function saveFlows(req, res, opts) {
    if (opts.allowFlows === false) { req.resume?.(); return deny(res, MSG.noFlows); }
    const body = await bodyOr(req, res, 50000);
    if (!body) return;
    let flows = readFlows().filter((x) => x.id !== body.id && x.id !== body.flow?.id);
    if (req.method === 'POST' && body.flow?.id && Array.isArray(body.flow.steps)) flows.push({ ...body.flow, createdAt: new Date().toISOString() });
    try { fs.writeFileSync(file(FILES.flows), JSON.stringify({ flows }, null, 2) + '\n'); }
    catch (e) { shout(`✗ Não consegui salvar os fluxos: ${e.message}`); return json(res, 500, { error: 'Não consegui salvar o fluxo. Os detalhes estão na saída do servidor do mapa.' }); }
    json(res, 200, { flows });
  }

  /**
   * Atende um pedido da API. subpath: 'ask', 'flows', 'export', 'plan/undo', 'cancel', 'events', 'status' ou
   * 'health' (aceita também '/api/ask', 'api/ask?x=1'). Devolve true quando respondeu e false quando o caminho
   * ou o método não é da API (quem chamou responde 404). Para 'ask' e 'events' resolve assim que a resposta
   * começa, sem esperar o fim do stream.
   * opts: { allowAsk, allowChange, allowFlows } (padrão: tudo liberado), user (de quem é a pergunta, para
   * Parar só as próprias), checkOrigin (false quando quem monta já conferiu a origem).
   */
  async function handle(req, res, subpath, opts = {}) {
    const sub = String(subpath || '').split('?')[0].replace(/^\/+/, '').replace(/^api\//, '').replace(/\/+$/, '');
    const route = Object.hasOwn(ROUTES, sub) ? ROUTES[sub] : null;
    const run = route && Object.hasOwn(route, req.method) ? route[req.method] : null;
    if (!run) return false;
    // só a página que este núcleo serviu: o token dela, da mesma origem. O EventSource não manda cabeçalhos,
    // então o stream de eventos recebe o token na query string.
    const url = new URL(req.url || '/', 'http://local');
    const host = String(req.headers.host || '');
    const origin = req.headers.origin;
    const sameOrigin = opts.checkOrigin === false || !origin || origin === `http://${host}` || origin === `https://${host}`;
    const sent = req.headers['x-floorplan-token'] || (sub === 'events' ? url.searchParams.get('token') : null);
    if (!sameOrigin || typeof sent !== 'string' || sent !== token) { req.resume?.(); res.writeHead(403); res.end(); return true; }
    try { await run(req, res, opts); }
    catch (e) {
      shout(`✗ Erro no servidor do mapa (${sub}): ${e?.stack || e}`);
      if (!res.headersSent) json(res, 500, { error: 'Algo deu errado no servidor do mapa. Os detalhes estão na saída dele.' });
      else if (!res.writableEnded) res.end();
    }
    return true;
  }

  /** O objeto que a página recebe como window.FLOORPLAN_SERVER. */
  function info() {
    recheck();
    return { token, cli: !!cli, engine, want, version: cli?.version || null, model: model || null, change: canChange() };
  }
  /** O index.html do mapa (lido agora, do disco) com window.FLOORPLAN_SERVER injetado; `extra` é somado a ele. */
  function page(extra = {}) {
    let html;
    try { html = fs.readFileSync(file(FILES.page), 'utf8'); } catch { throw Object.assign(new Error(MSG.noMap), { code: 'no_map' }); }
    const base = info();
    const data = { ...base, ...extra, token, change: base.change && extra.change !== false };
    // nomes de projeto vêm de fora: nada pode fechar a tag <script>
    const tag = `<script>window.FLOORPLAN_SERVER=${JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')};</script>`;
    return html.includes('</head>') ? html.replace('</head>', () => tag + '</head>') : tag + html;
  }
  function close() {
    for (const r of running.values()) { try { r.child.kill(); } catch {} }
    running.clear();
    for (const t of tabs) { try { t.end(); } catch {} }
    tabs.clear();
    clearTimeout(reloadTimer);
    if (idleTimer) clearInterval(idleTimer);
    fs.unwatchFile(watched, onPageChange);
  }

  return { info, page, handle, close, token, hash, root, mapDir, cliPath: () => cli?.path || null, engineName: () => (engine ? ENGINES[engine].name : null) };
}

/** Para as mensagens de quem monta o núcleo: o nome do motor, com artigo ("a CLI do Claude Code", "o Codex"). */
export const engineInfo = (k) => (isEngine(k) ? { name: ENGINES[k].name, the: ENGINES[k].the, site: ENGINES[k].site } : null);
