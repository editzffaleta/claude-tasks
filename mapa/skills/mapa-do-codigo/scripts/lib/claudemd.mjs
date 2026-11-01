// Mantém um bloco curto no CLAUDE.local.md do projeto apontando as próximas sessões do Claude Code para o mapa,
// para que "onde fica X / como Y funciona" comece pelo mapa em vez de uma busca nova no código.
// O CLAUDE.local.md é a memória pessoal e fora do git do Claude Code para o projeto (carregada no início, como o
// CLAUDE.md, inclusive de pastas acima); o mapa não vai para o git, então o aviso sobre ele também não. O arquivo
// entra na lista de ignorados local do repositório (.git/info/exclude), sem mexer em nada versionado.
// O bloco fica entre marcadores e é reescrito no lugar; o resto do arquivo nunca é tocado.
// Só é adicionado quando o usuário pede (build.mjs --claude-md); um bloco que já existe é mantido em dia.
// Para desligar, ponha <!-- mapa-do-codigo:desligado --> no CLAUDE.local.md.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './common.mjs';

const START = '<!-- mapa-do-codigo:inicio -->';
const END = '<!-- mapa-do-codigo:fim -->';
const OFF = '<!-- mapa-do-codigo:desligado -->';
// os marcadores do Floorplan original, em que esta versão se baseia: um bloco antigo é trocado pelo novo
const OLD = { start: '<!-- floorplan:start -->', end: '<!-- floorplan:end -->', off: '<!-- floorplan:off -->' };
const NAME = 'CLAUDE.local.md';

function block(rel) {
  return `${START}
## Mapa do código deste projeto

\`${rel}/\` guarda um mapa deste código: cada módulo, arquivo e endpoint com um nome em linguagem simples e uma descrição de uma linha, e o que se liga a quê. Para perguntas como "onde fica X", "como Y funciona" ou "o que usa Z", consulte o mapa antes de procurar no código (rode estes comandos a partir da pasta deste arquivo):

- \`node ${rel}/consulta.mjs find "<palavras>"\` (ou \`buscar\`): módulos, arquivos e endpoints que combinam
- \`node ${rel}/consulta.mjs show <caminho do arquivo | id do módulo | "GET /caminho">\` (ou \`mostrar\`): o que é, o que usa e o que usa isso
- \`node ${rel}/consulta.mjs path <de> <para>\` (ou \`caminho\`): como duas coisas se ligam
- \`node ${rel}/consulta.mjs overview\` (ou \`visao-geral\`): o sistema inteiro de relance

O mapa pode estar atrás das edições mais recentes, então confirme no código antes de mudar qualquer coisa. Abra o mapa com \`node ${rel}/servidor.mjs\`. Depois de mudanças grandes, atualize com a skill mapa-do-codigo (o usuário pode só pedir para "atualizar o mapa do código"; só os arquivos que mudaram são relidos).
${END}`;
}

const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
/** Onde está o bloco (com os marcadores novos ou os do Floorplan), ou null. */
function findBlock(text) {
  for (const [s, e] of [[START, END], [OLD.start, OLD.end]]) {
    const a = text.indexOf(s), b = text.indexOf(e);
    if (a >= 0 && b > a) return { a, b: b + e.length };
  }
  return null;
}
/** O texto sem o bloco (normalizado para \n), ou null quando não há bloco. */
const stripBlock = (text) => {
  const at = findBlock(text);
  if (!at) return null;
  return [text.slice(0, at.a).trimEnd(), text.slice(at.b).trimStart()].filter(Boolean).join('\n\n').replace(/\r\n/g, '\n');
};

/** Põe o CLAUDE.local.md no .git/info/exclude do repositório, a menos que o git já o ignore. */
function excludeLocally(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return 'fora de um repositório git';
  if (git(root, ['ls-files', '--', NAME])) return `o ${NAME} está versionado neste repositório; a seção do Mapa do código vai aparecer nele`;
  if (git(root, ['check-ignore', '-q', NAME]) !== null) return 'já ignorado pelo git';
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const excl = git(root, ['rev-parse', '--git-path', 'info/exclude']);
  if (!excl) return 'não achei o .git/info/exclude';
  const file = path.resolve(root, excl);
  const line = '/' + prefix + NAME;
  const cur = read(file) || '';
  if (!cur.split(/\r?\n/).includes(line)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cur.replace(/\s*$/, cur.trim() ? '\n' : '') + `# notas pessoais do Claude Code (adicionado pelo Mapa do código)\n${line}\n`);
  }
  return 'ignorado localmente via .git/info/exclude';
}

/** Atualiza o bloco, ou adiciona quando `add` (o usuário pediu); tira o bloco de um CLAUDE.md versionado, onde versões antigas o punham. */
export function writeClaudeMd(root, outDir, { add = false } = {}) {
  const rel = path.relative(root, outDir).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'ignorado (o mapa está fora do código)';
  const had = ['CLAUDE.local.md', 'CLAUDE.md', path.join('.claude', 'CLAUDE.md')].some((f) => stripBlock(read(path.join(root, f)) ?? '') != null);
  if (!add && !had) return 'não adicionado (ofereça ao usuário; adicione com --claude-md)';
  const notes = [];

  // versões antigas punham o bloco no CLAUDE.md, que costuma ser versionado: tira de lá
  for (const f of [path.join(root, 'CLAUDE.md'), path.join(root, '.claude', 'CLAUDE.md')]) {
    const t = read(f);
    const rest = t == null ? null : stripBlock(t);
    if (rest == null) continue;
    const eol = t.includes('\r\n') ? '\r\n' : '\n';
    const tracked = !!git(path.dirname(f), ['ls-files', '--', path.basename(f)]);
    if (!rest.trim() && !tracked) fs.unlinkSync(f);
    else fs.writeFileSync(f, rest.replace(/\n/g, eol) + (rest.trim() ? eol : ''));
    notes.push(`seção do mapa tirada de ${path.relative(root, f).replace(/\\/g, '/')}${!rest.trim() && tracked ? ' (agora vazio; apague se quiser)' : ''}`);
  }

  const file = path.join(root, NAME);
  const old = read(file);
  if (old?.includes(OFF) || old?.includes(OLD.off)) return 'ignorado (desligado pelo usuário)';
  const eol = old?.includes('\r\n') ? '\r\n' : '\n';
  const text = block(rel).replace(/\n/g, eol);
  let next;
  if (old == null) next = text + eol;
  else {
    const at = findBlock(old);
    next = at ? old.slice(0, at.a) + text + old.slice(at.b) : old.replace(/\s*$/, '') + eol + eol + text + eol;
  }
  if (next !== old) { fs.writeFileSync(file, next); notes.unshift(`${NAME} ${old == null ? 'criado' : 'atualizado'}`); }
  else notes.unshift(`${NAME} sem mudanças`);
  notes.push(excludeLocally(root));
  return notes.join('; ');
}
