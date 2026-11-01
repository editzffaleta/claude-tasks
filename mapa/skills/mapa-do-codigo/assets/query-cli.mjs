// mapa-do-codigo/consulta.mjs: consulta o grafo.json desta pasta. Gerado pelo build.mjs; o Claude Code e o Codex
// usam quando alguém pergunta pelo mapa (node mapa-do-codigo/servidor.mjs), e as sessões futuras também.
//
// uso: node mapa-do-codigo/consulta.mjs overview                (ou visao-geral)
//      node mapa-do-codigo/consulta.mjs find "<palavras>" [--kind module|file|endpoint|symbol] [--limit 15]   (ou buscar, --tipo, --limite)
//      node mapa-do-codigo/consulta.mjs show <id>               (ou mostrar)
//      node mapa-do-codigo/consulta.mjs path <deId> <paraId>    (ou caminho)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP = `Consulta o mapa do código desta pasta (grafo.json). Toda resposta é JSON, com ids.

uso: node mapa-do-codigo/consulta.mjs <comando> [opções]

  overview | visao-geral                      o sistema inteiro de relance: partes, fluxos, trabalho recente
  find | buscar "<palavras>"                   módulos, arquivos, endpoints e símbolos que combinam
      --kind | --tipo module|file|endpoint|symbol   (ou modulo, arquivo, endpoint, simbolo)
      --limit | --limite <n>                   quantos resultados (padrão 15, no máximo 40)
  show | mostrar <id>                          o que é, o que usa e o que usa isso
  path | caminho <de> <para>                   a cadeia de imports e chamadas que liga as duas coisas

Os ids têm a forma n:<módulo>, f:<caminho do arquivo>, r:<número do endpoint> e s:<arquivo>#<número>;
show e path também aceitam um caminho de arquivo, o id de um módulo ou "GET /caminho".`;

const COMMANDS = { overview: 'overview', 'visao-geral': 'overview', 'visão-geral': 'overview', find: 'find', buscar: 'find', show: 'show', mostrar: 'show', path: 'path', caminho: 'path' };
const KINDS = { module: 'module', modulo: 'module', 'módulo': 'module', file: 'file', arquivo: 'file', endpoint: 'endpoint', symbol: 'symbol', simbolo: 'symbol', 'símbolo': 'symbol' };

const argv = process.argv.slice(2);
/** O valor de --nome (ou de um dos apelidos), tirado da lista de argumentos. */
const flag = (...names) => {
  let v;
  for (const name of names) { const i = argv.indexOf('--' + name); if (i >= 0) { v = argv[i + 1]; argv.splice(i, 2); } }
  return v;
};
const kindArg = flag('kind', 'tipo'), limit = flag('limit', 'limite');
const [given, ...rest] = argv;
const cmd = COMMANDS[String(given || '').toLowerCase()];
if (!cmd) {
  const help = !given || ['--help', '-h', 'help', 'ajuda'].includes(given);
  (help ? console.log : console.error)(help ? HELP : `Comando desconhecido: "${given}".\n\n${HELP}`);
  process.exit(help ? 0 : 1);
}
try {
  // MAPA_GRAFO_DIR: o quadro roda a consulta do próprio plugin apontando para a pasta do mapa de um projeto.
  const here = process.env.MAPA_GRAFO_DIR || path.dirname(fileURLToPath(import.meta.url));
  const G = JSON.parse(fs.readFileSync(path.join(here, 'grafo.json'), 'utf8'));
  const q = createGraphQuery(G);
  const kind = kindArg == null ? undefined : KINDS[String(kindArg).toLowerCase()];
  if (kindArg != null && !kind) throw new Error(`Tipo desconhecido: "${kindArg}". Use module, file, endpoint ou symbol (ou modulo, arquivo, endpoint, simbolo).`);
  let out;
  if (cmd === 'overview') out = q.overview();
  else if (cmd === 'find') out = q.find(rest.join(' '), kind, limit);
  else if (cmd === 'show') out = q.show(rest[0]);
  else out = q.path(rest[0], rest[1]);
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  console.log(JSON.stringify({ error: e.code === 'ENOENT' ? 'Não achei o grafo.json ao lado deste arquivo. Refaça o mapa do código.' : e.message }));
  process.exit(1);
}
