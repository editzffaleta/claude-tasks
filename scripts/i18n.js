#!/usr/bin/env node
// Confere os dicionários do painel (public/js/i18n/<idioma>.js) contra os textos do código.
//
//   node scripts/i18n.js            relatório por idioma; sai com código 1 se faltar alguma chave
//   node scripts/i18n.js --strict   também falha com chaves sobrando (não usadas)
//   node scripts/i18n.js --keys     lista as chaves extraídas, agrupadas por arquivo (para começar um idioma)
//
// As chaves são os próprios textos em português. Este script as encontra assim:
//
// Painel (public/js/*.js, exceto i18n.js):
//   1. t('texto', …)            primeiro argumento literal de t()
//   2. tn(n, 'um', 'vários', …) segundo e terceiro argumentos literais de tn()
//   3. N_('texto')              marca um texto guardado agora e traduzido depois com t(variável)
//                               (N_ devolve o próprio texto; use em listas mistas, ex.: modelos de automação)
//   4. /* i18n */ { … } ou [ … ] todos os textos literais que são VALORES dentro do objeto/lista marcado
//                               (recursivo; nomes de propriedades ficam de fora). Use em mapas de rótulos
//                               traduzidos na exibição, ex.: const GROUPS = /* i18n */ { none: 'Sem agrupamento' }
//   5. labels({ … })            mesmo que o item 4 (o helper de util.js traduz ao ler)
//   Templates `…${x}…` não viram chave: use t('… {x} …', { x }).
//
// Servidor (src/**/*.js, exceto src/mcp/, que fala com o Claude e não com o painel):
//   mensagens literais que chegam ao painel e passam por t() em ApiError (api.js) ou no chat:
//   fail('…'), forbid('…'), o padrão de forbid, new HttpError(400, '…'), new Error('…'),
//   os valores dos mapas em SERVER_MAPS e os textos em SERVER_EXTRA. Mensagens com ${…} não
//   têm como bater com o dicionário e ficam de fora.
//
// Também confere em cada tradução se os {marcadores} são os mesmos da chave e se há chave repetida.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = join(ROOT, 'public/js');
const DICTS = join(PANEL, 'i18n');
const SERVER = join(ROOT, 'src');
const SERVER_SKIP = [join(SERVER, 'mcp')];
// Mapas do servidor cujos valores são mensagens mostradas no painel.
const SERVER_MAPS = ['LEVEL_MSG'];
// Mensagens do servidor que não seguem os padrões acima (devolvidas por funções auxiliares).
const SERVER_EXTRA = [
  'A CLI do Claude não está logada. Abra o Terminal, rode `claude` e use /login. Depois tente de novo.', // src/chat.js chatError()
  'O assistente encerrou sem responder', // src/chat.js chatError()
];
// Páginas HTML estáticas: o texto delas é aplicado por JS (document.title etc.), então não entra aqui.

// ---------- tokenizador (JS suficiente para os nossos arquivos) ----------

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
const isIdStart = (c) => /[A-Za-z_$À-￿]/.test(c);
const isId = (c) => /[\w$À-￿]/.test(c);

export function tokenize(src) {
  const tokens = [];
  const templates = []; // profundidade de chaves em que cada ${ … } de template abriu
  let depth = 0;
  let i = 0;
  const line = (pos) => src.slice(0, pos).split('\n').length;
  const lastSignificant = () => {
    for (let k = tokens.length - 1; k >= 0; k--) if (tokens[k].type !== 'comment') return tokens[k];
    return null;
  };
  const regexAllowed = () => {
    const p = lastSignificant();
    if (!p) return true;
    if (p.type === 'punct') return !/^[)\]]$/.test(p.value);
    if (p.type === 'ident') return KEYWORDS_BEFORE_REGEX.has(p.value);
    if (p.type === 'template') return !p.tail ? true : false;
    return false;
  };
  // Lê um pedaço de template a partir de i (logo depois de ` ou de }); termina em ` ou ${.
  const readTemplate = (head) => {
    const start = i;
    let raw = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { raw += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { i++; tokens.push({ type: 'template', raw, head, tail: true, pos: start, line: line(start) }); return; }
      if (c === '$' && src[i + 1] === '{') {
        i += 2;
        tokens.push({ type: 'template', raw, head, tail: false, pos: start, line: line(start) });
        templates.push(depth);
        return;
      }
      raw += c;
      i++;
    }
    throw new Error(`template sem fim na linha ${line(start)}`);
  };

  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end < 0 ? src.length : end;
      tokens.push({ type: 'comment', value: src.slice(i + 2, stop).trim(), pos: i, line: line(i) });
      i = stop;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error(`comentário sem fim na linha ${line(i)}`);
      tokens.push({ type: 'comment', value: src.slice(i + 2, end).trim(), block: true, pos: i, line: line(i) });
      i = end + 2;
      continue;
    }
    if (c === '\'' || c === '"') {
      const start = i;
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') throw new Error(`texto sem fim na linha ${line(start)}`);
        i++;
      }
      i++;
      tokens.push({ type: 'str', raw: src.slice(start, i), pos: start, line: line(start) });
      continue;
    }
    if (c === '`') { i++; readTemplate(true); continue; }
    if (c === '/' && regexAllowed()) {
      const start = i;
      i++;
      let cls = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '\n') throw new Error(`regex sem fim na linha ${line(start)}`);
        if (cls) { if (d === ']') cls = false; } else if (d === '[') cls = true; else if (d === '/') break;
        i++;
      }
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++;
      tokens.push({ type: 'regex', raw: src.slice(start, i), pos: start, line: line(start) });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1]))) {
      const start = i;
      while (i < src.length && /[\w.]/.test(src[i])) i++;
      tokens.push({ type: 'num', value: src.slice(start, i), pos: start, line: line(start) });
      continue;
    }
    if (isIdStart(c)) {
      const start = i;
      while (i < src.length && isId(src[i])) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i), pos: start, line: line(start) });
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') {
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        i++;
        readTemplate(false);
        continue;
      }
      depth--;
    }
    // Pontuação: um caractere basta (=> e ?. aparecem como dois tokens).
    tokens.push({ type: 'punct', value: c, pos: i, line: line(i) });
    i++;
  }
  return tokens;
}

// Valor de um literal '…' / "…" / `…` (sem ${}).
export function decode(raw, quoted = true) {
  const body = quoted ? raw.slice(1, -1) : raw;
  return body.replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r?\n|.)/g, (_, e) => {
    if (e[0] === 'u') return String.fromCodePoint(parseInt(e[1] === '{' ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === '\n' || e === '\r\n') return '';
    return { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' }[e] ?? e;
  });
}

// Literal simples (texto ou template sem ${}) na posição k, ou null.
function literalAt(tokens, k) {
  const tk = tokens[k];
  if (!tk) return null;
  if (tk.type === 'str') return decode(tk.raw);
  if (tk.type === 'template' && tk.head && tk.tail) return decode(tk.raw, false);
  return null;
}

// Próximo token que não é comentário, a partir de k (inclusive).
function next(tokens, k) {
  while (tokens[k]?.type === 'comment') k++;
  return k;
}

const isP = (tk, v) => tk?.type === 'punct' && tk.value === v;
const OPEN = { '(': ')', '[': ']', '{': '}' };

// Pula um argumento (até a vírgula ou o fecha-parênteses no mesmo nível); devolve o índice da vírgula/fecho.
function skipArg(tokens, k) {
  let level = 0;
  for (; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.type === 'template') { if (!tk.tail) level++; if (!tk.head) level--; continue; }
    if (tk.type !== 'punct') continue;
    if (OPEN[tk.value]) level++;
    else if (')]}'.includes(tk.value)) { if (level === 0) return k; level--; } else if (tk.value === ',' && level === 0) return k;
  }
  return k;
}

// Literal que ocupa o argumento inteiro em k: devolve [texto, índice depois dele] ou null.
function wholeLiteral(tokens, k) {
  k = next(tokens, k);
  const value = literalAt(tokens, k);
  if (value === null) return null;
  const after = next(tokens, k + 1);
  return isP(tokens[after], ',') || isP(tokens[after], ')') ? value : null;
}

// Textos-valor de um objeto/lista que começa em k ({ ou [).
function literalValues(tokens, k, out, add) {
  const stack = [];
  for (; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.type === 'punct' && OPEN[tk.value]) { stack.push(tk.value); continue; }
    if (tk.type === 'punct' && ')]}'.includes(tk.value)) { stack.pop(); if (!stack.length) return k; continue; }
    const value = literalAt(tokens, k);
    if (value === null) {
      if (tk.type === 'template' && tk.head) add(out, null, tk, 'template com ${} dentro de um mapa marcado');
      continue;
    }
    const isKey = stack[stack.length - 1] === '{' && isP(tokens[next(tokens, k + 1)], ':');
    if (!isKey) add(out, value, tk);
  }
  return k;
}

// Chaves de um arquivo do painel: Map(texto → [linhas]) e avisos.
export function panelKeys(src) {
  const tokens = tokenize(src);
  const keys = new Map();
  const warnings = [];
  const add = (_, value, tk, warning) => {
    if (warning) return warnings.push({ line: tk.line, message: warning });
    if (!value) return;
    if (!keys.has(value)) keys.set(value, []);
    keys.get(value).push(tk.line);
  };
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.type === 'comment' && tk.block && tk.value === 'i18n') {
      const open = next(tokens, k + 1);
      if (isP(tokens[open], '{') || isP(tokens[open], '[')) k = literalValues(tokens, open, null, add);
      else warnings.push({ line: tk.line, message: '/* i18n */ precisa vir logo antes de { ou [' });
      continue;
    }
    if (tk.type !== 'ident' || isP(tokens[k - 1], '.')) continue;
    const paren = next(tokens, k + 1);
    if (!isP(tokens[paren], '(')) continue;
    if (tk.value === 't' || tk.value === 'N_') {
      const value = wholeLiteral(tokens, paren + 1);
      const first = tokens[next(tokens, paren + 1)];
      if (value !== null) add(null, value, first);
      else if (first && (first.type === 'str' || (first.type === 'template' && first.head))) {
        warnings.push({ line: first.line, message: `${tk.value}() com texto montado: use marcadores {x}` });
      }
    } else if (tk.value === 'tn') {
      const c1 = skipArg(tokens, paren + 1);
      if (!isP(tokens[c1], ',')) continue;
      const one = wholeLiteral(tokens, c1 + 1);
      const c2 = skipArg(tokens, c1 + 1);
      const many = isP(tokens[c2], ',') ? wholeLiteral(tokens, c2 + 1) : null;
      if (one === null || many === null) { warnings.push({ line: tk.line, message: 'tn() sem singular/plural literais' }); continue; }
      add(null, one, tokens[next(tokens, c1 + 1)]);
      add(null, many, tokens[next(tokens, c2 + 1)]);
    } else if (tk.value === 'labels') {
      const open = next(tokens, paren + 1);
      if (isP(tokens[open], '{')) literalValues(tokens, open, null, add);
    }
  }
  return { keys, warnings };
}

// Mensagens literais do servidor que chegam ao painel.
export function serverKeys(src) {
  const tokens = tokenize(src);
  const keys = new Map();
  const add = (value, tk) => {
    if (!value) return;
    if (!keys.has(value)) keys.set(value, []);
    keys.get(value).push(tk.line);
  };
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (tk.type !== 'ident') continue;
    const n1 = next(tokens, k + 1);
    if (['fail', 'forbid'].includes(tk.value) && !isP(tokens[k - 1], '.') && isP(tokens[n1], '(')) {
      const value = wholeLiteral(tokens, n1 + 1);
      if (value !== null) add(value, tokens[next(tokens, n1 + 1)]);
    }
    // const forbid = (msg = '…') => …
    if (tk.value === 'forbid' && isP(tokens[n1], '=') && isP(tokens[n1 + 1], '(') && tokens[n1 + 2]?.type === 'ident' && isP(tokens[n1 + 3], '=')) {
      const value = literalAt(tokens, n1 + 4);
      if (value !== null) add(value, tokens[n1 + 4]);
    }
    if (tk.value === 'new' && tokens[n1]?.type === 'ident' && isP(tokens[n1 + 1], '(')) {
      const cls = tokens[n1].value;
      if (cls === 'Error') {
        const value = wholeLiteral(tokens, n1 + 2);
        if (value !== null) add(value, tokens[next(tokens, n1 + 2)]);
      }
      if (cls === 'HttpError') {
        const comma = skipArg(tokens, n1 + 2);
        if (isP(tokens[comma], ',')) {
          const value = wholeLiteral(tokens, comma + 1);
          if (value !== null) add(value, tokens[next(tokens, comma + 1)]);
        }
      }
    }
    if (SERVER_MAPS.includes(tk.value) && isP(tokens[n1], '=') && isP(tokens[next(tokens, n1 + 1)], '{')) {
      literalValues(tokens, next(tokens, n1 + 1), null, (_, value, at) => add(value, at));
    }
  }
  return keys;
}

// ---------- arquivos ----------

const walk = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (SERVER_SKIP.includes(path)) return [];
  return statSync(path).isDirectory() ? walk(path) : name.endsWith('.js') ? [path] : [];
});

export function collect() {
  const byFile = new Map(); // arquivo → Map(chave → linhas), na ordem dos arquivos
  const warnings = [];
  const panelFiles = readdirSync(PANEL).filter((f) => f.endsWith('.js') && f !== 'i18n.js').sort();
  for (const name of panelFiles) {
    const { keys, warnings: w } = panelKeys(readFileSync(join(PANEL, name), 'utf8'));
    byFile.set(`public/js/${name}`, keys);
    warnings.push(...w.map((x) => ({ file: `public/js/${name}`, ...x })));
  }
  for (const path of walk(SERVER).sort()) {
    const keys = serverKeys(readFileSync(path, 'utf8'));
    if (keys.size) byFile.set(relative(ROOT, path), keys);
  }
  byFile.set('(SERVER_EXTRA)', new Map(SERVER_EXTRA.map((k) => [k, []])));
  const all = new Map(); // chave → primeiro arquivo
  for (const [file, keys] of byFile) for (const key of keys.keys()) if (!all.has(key)) all.set(key, file);
  return { byFile, all, warnings };
}

const placeholders = (s) => [...new Set(String(s).match(/\{\w+\}/g) || [])].sort().join(' ');

// Chaves repetidas no arquivo do dicionário (no objeto, a última ganharia sem aviso).
function duplicates(src) {
  const tokens = tokenize(src);
  const seen = new Set();
  const dups = [];
  let level = 0;
  for (let k = 0; k < tokens.length; k++) {
    const tk = tokens[k];
    if (isP(tk, '{')) level++;
    if (isP(tk, '}')) level--;
    if (level === 1 && tk.type === 'str' && isP(tokens[next(tokens, k + 1)], ':')) {
      const key = decode(tk.raw);
      if (seen.has(key)) dups.push({ key, line: tk.line });
      seen.add(key);
    }
  }
  return dups;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const { byFile, all, warnings } = collect();

  if (args.has('--keys')) {
    for (const [file, keys] of byFile) {
      const own = [...keys.keys()].filter((k) => all.get(k) === file);
      if (!own.length) continue;
      console.log(`\n// ${file}`);
      for (const key of own) console.log(JSON.stringify(key));
    }
    return;
  }

  for (const w of warnings) console.warn(`aviso: ${w.file}:${w.line} ${w.message}`);
  console.log(`${all.size} chaves (${byFile.size} arquivos)`);

  const langs = readdirSync(DICTS).filter((f) => f.endsWith('.js')).sort();
  if (!langs.length) { console.error('nenhum dicionário em public/js/i18n/'); process.exit(1); }
  let failed = false;
  for (const file of langs) {
    const path = join(DICTS, file);
    const dict = (await import(pathToFileURL(path).href)).default || {};
    const missing = [...all.keys()].filter((k) => !(k in dict));
    const unused = Object.keys(dict).filter((k) => !all.has(k));
    const empty = Object.keys(dict).filter((k) => all.has(k) && !String(dict[k]).trim());
    const badVars = Object.keys(dict).filter((k) => all.has(k) && placeholders(k) !== placeholders(dict[k]));
    const dups = duplicates(readFileSync(path, 'utf8'));
    const problems = missing.length + empty.length + badVars.length + dups.length + (args.has('--strict') ? unused.length : 0);
    if (problems) failed = true;
    console.log(`\n${file.replace('.js', '')}: ${Object.keys(dict).length} traduções · ${missing.length} faltando · ${unused.length} sem uso · ${badVars.length} com marcadores diferentes · ${dups.length} repetidas`);
    for (const k of missing) console.log(`  faltando: ${JSON.stringify(k)}  (${all.get(k)})`);
    for (const k of empty) console.log(`  vazia: ${JSON.stringify(k)}`);
    for (const k of badVars) console.log(`  marcadores: ${JSON.stringify(k)} → ${JSON.stringify(dict[k])}`);
    for (const d of dups) console.log(`  repetida: ${JSON.stringify(d.key)} (linha ${d.line})`);
    for (const k of unused) console.log(`  sem uso: ${JSON.stringify(k)}`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
