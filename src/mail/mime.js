// Leitura e montagem de mensagens MIME (RFC 5322, 2045-2047, 2231) sem dependências.
// O parser é tolerante de propósito: e-mail real viola as RFCs o tempo todo, e uma
// mensagem mal formada deve virar tarefa mesmo assim em vez de derrubar a importação.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

const EMPTY = Buffer.alloc(0);

// ---------- charsets ----------

// Sem charset declarado (ou "us-ascii" com bytes de 8 bits), tenta UTF-8 e cai para
// Windows-1252, que é o que clientes antigos mandam na prática.
function bytesToText(buf, charset) {
  let cs = String(charset || '').trim().replace(/^["']+|["']+$/g, '').toLowerCase();
  if (!cs || cs === 'us-ascii' || cs === 'ascii' || cs === 'unknown-8bit' || cs === 'x-unknown') {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      cs = 'windows-1252';
    }
  }
  try {
    return new TextDecoder(cs).decode(buf);
  } catch {
    return Buffer.from(buf).toString('latin1');
  }
}

const isHex2 = (s) => /^[0-9a-f]{2}$/i.test(s);

function pctDecode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '%' && isHex2(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...Buffer.from(s[i]));
  }
  return Buffer.from(out);
}

// ---------- RFC 2047 ----------

const WORD = /=\?([^?\s]+)\?([BbQq])\?([^?]*)\?=/g;

function qWordDecode(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '_') out.push(0x20);
    else if (s[i] === '=' && isHex2(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...Buffer.from(s[i]));
  }
  return Buffer.from(out);
}

// Junta os bytes de palavras adjacentes do mesmo charset antes de decodificar:
// remetentes cortam caracteres UTF-8 de vários bytes no meio, entre duas palavras.
export function decodeWords(str) {
  if (str == null) return '';
  const s = String(str);
  if (!s.includes('=?')) return s;
  let out = '';
  let last = 0;
  let run = null;
  const flush = () => {
    if (run) out += bytesToText(Buffer.concat(run.chunks), run.charset);
    run = null;
  };
  for (const m of s.matchAll(WORD)) {
    const between = s.slice(last, m.index);
    // espaço entre duas palavras codificadas não faz parte do texto (RFC 2047 §6.2)
    if (!run || !/^\s*$/.test(between)) {
      flush();
      out += between;
    }
    const charset = m[1].split('*')[0].toLowerCase();
    const bytes = m[2].toUpperCase() === 'B' ? Buffer.from(m[3], 'base64') : qWordDecode(m[3]);
    if (run && run.charset !== charset) flush();
    if (!run) run = { charset, chunks: [] };
    run.chunks.push(bytes);
    last = m.index + m[0].length;
  }
  flush();
  return out + s.slice(last);
}

// Cada palavra fica com no máximo 39 bytes (52 em base64) para caber numa linha
// junto do nome do cabeçalho, sem cortar caracteres de vários bytes.
export function encodeWord(str) {
  const s = String(str ?? '');
  if (!/[^\x00-\x7f]/.test(s)) return s;
  const words = [];
  let chunk = '';
  let size = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch);
    if (chunk && size + n > 39) {
      words.push(chunk);
      chunk = '';
      size = 0;
    }
    chunk += ch;
    size += n;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(' ');
}

// ---------- cabeçalhos ----------

function splitHead(buf) {
  if (buf[0] === 0x0a) return { head: EMPTY, body: buf.subarray(1) };
  if (buf[0] === 0x0d && buf[1] === 0x0a) return { head: EMPTY, body: buf.subarray(2) };
  // parte sem cabeçalhos e sem a linha vazia inicial: é tudo corpo
  if (!/^[^\s:]+[ \t]*:/.test(buf.subarray(0, 200).toString('latin1'))) return { head: EMPTY, body: buf };
  let i = -1;
  while ((i = buf.indexOf(0x0a, i + 1)) >= 0) {
    let j = i + 1;
    if (buf[j] === 0x0d) j++;
    if (buf[j] === 0x0a) return { head: buf.subarray(0, i + 1), body: buf.subarray(j + 1) };
  }
  return { head: buf, body: EMPTY };
}

function parseHeaders(head) {
  const headers = {};
  const text = bytesToText(head).replace(/\r?\n(?=[ \t])/g, '');
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    if (!name || /\s/.test(name)) continue;
    headers[name] = line.slice(idx + 1).trim();
  }
  return headers;
}

function parseEntity(buf) {
  const { head, body } = splitHead(buf);
  return { headers: parseHeaders(head), body };
}

function splitParams(str) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quoted && c === '\\' && i + 1 < str.length) {
      cur += c + str[++i];
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ';' && !quoted) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

function unquote(v) {
  v = v.trim();
  if (!v.startsWith('"')) return v;
  return v.slice(1, v.endsWith('"') && v.length > 1 ? -1 : undefined).replace(/\\(.)/g, '$1');
}

// Valor principal + parâmetros, montando os estendidos da RFC 2231 (name*=, name*0*=, ...).
function parseParams(header) {
  const [first, ...rest] = splitParams(String(header || ''));
  const params = {};
  const ext = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    const val = unquote(p.slice(eq + 1));
    const m = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
    if (!m) {
      params[key] = val;
      continue;
    }
    const encoded = m[2] === undefined || m[3] === '*';
    (ext[m[1]] ||= [])[m[2] === undefined ? 0 : Number(m[2])] = { val, encoded };
  }
  for (const [name, segs] of Object.entries(ext)) {
    let charset = 'utf-8';
    const chunks = [];
    segs.forEach((seg, i) => {
      if (!seg) return;
      let v = seg.val;
      if (!seg.encoded) return chunks.push(Buffer.from(v));
      if (i === 0) {
        const q = /^([^']*)'[^']*'(.*)$/s.exec(v);
        if (q) {
          charset = q[1] || charset;
          v = q[2];
        }
      }
      chunks.push(pctDecode(v));
    });
    params[name] = bytesToText(Buffer.concat(chunks), charset);
  }
  return { value: first.trim().toLowerCase(), params };
}

// ---------- endereços ----------

// Divide na vírgula de nível superior; ":" abre grupo (o nome do grupo é descartado) e ";" fecha.
function splitAddresses(str) {
  const out = [];
  let cur = '';
  let quoted = false;
  let paren = 0;
  let angle = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (quoted || paren) {
      cur += c;
      if (c === '\\' && i + 1 < str.length) cur += str[++i];
      else if (quoted && c === '"') quoted = false;
      else if (paren && c === '(') paren++;
      else if (paren && c === ')') paren--;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '(') paren = 1;
    else if (c === '<') angle++;
    else if (c === '>' && angle) angle--;
    else if (!angle && (c === ',' || c === ';')) {
      out.push(cur);
      cur = '';
      continue;
    } else if (!angle && c === ':') {
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// "Pedro (TI) <p@x>" mantém o comentário no nome; em "p@x (Pedro)" o comentário é o nome.
function parseMailbox(token) {
  let phrase = '';
  let display = '';
  let comment = '';
  let address = null;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < token.length && token[j] !== '"') {
        if (token[j] === '\\' && j + 1 < token.length) j++;
        s += token[j++];
      }
      phrase += s;
      if (address == null) display += s;
      i = j;
    } else if (c === '(') {
      let depth = 1;
      let j = i + 1;
      let s = '';
      for (; j < token.length; j++) {
        const d = token[j];
        if (d === '\\' && j + 1 < token.length) {
          s += token[++j];
          continue;
        }
        if (d === '(') depth++;
        else if (d === ')' && !--depth) break;
        s += d;
      }
      comment += (comment ? ' ' : '') + s.trim();
      if (address == null) display += `(${s.trim()})`;
      i = j;
    } else if (c === '<') {
      const end = token.indexOf('>', i);
      address = token.slice(i + 1, end < 0 ? token.length : end);
      i = end < 0 ? token.length : end;
    } else {
      phrase += c;
      if (address == null) display += c;
    }
  }
  let name;
  if (address == null) {
    // endereço solto: o que sobrou fora de aspas/comentários é o próprio endereço
    address = phrase.replace(/\s+/g, '');
    name = decodeWords(comment.trim());
  } else {
    name = decodeWords(display.replace(/\s+/g, ' ').trim()) || decodeWords(comment.trim());
  }
  return { name, address: address.trim().replace(/^@[^:]*:/, '') };
}

// Aceita string ("a@b", "Nome <a@b>", listas), objeto {name, address} ou arrays de qualquer um.
export function parseAddressList(input) {
  if (input == null || input === '') return [];
  if (Array.isArray(input)) return input.flatMap(parseAddressList);
  if (typeof input === 'object') {
    return input.address ? [{ name: String(input.name || ''), address: String(input.address).trim() }] : [];
  }
  return splitAddresses(String(input)).map(parseMailbox).filter((a) => a.address);
}

// ---------- corpo ----------

function qpDecode(buf) {
  // espaço no fim da linha é lixo de transporte; "=" no fim é quebra suave
  const s = buf.toString('latin1').replace(/[ \t]+(?=\r?\n|$)/g, '').replace(/=\r?\n/g, '').replace(/=$/, '');
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d && isHex2(s.slice(i + 1, i + 3))) {
      out[n++] = parseInt(s.slice(i + 1, i + 3), 16);
      i += 2;
    } else out[n++] = c;
  }
  return out.subarray(0, n);
}

function decodeTransfer(body, cte) {
  const enc = String(cte || '').trim().toLowerCase();
  if (enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/]/g, ''), 'base64');
  if (enc === 'quoted-printable') return qpDecode(body);
  return Buffer.from(body);
}

// Opera em bytes: anexos "binary" podem ter qualquer coisa, inclusive CRLF e "--".
function splitMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  const parts = [];
  let start = -1;
  let pos = 0;
  for (;;) {
    const idx = body.indexOf(delim, pos);
    if (idx < 0) break;
    pos = idx + delim.length;
    const next = body[pos];
    const atLineStart = idx === 0 || body[idx - 1] === 0x0a;
    const endsWord = next === undefined || next === 0x2d || next === 0x0d || next === 0x0a || next === 0x20 || next === 0x09;
    if (!atLineStart || !endsWord) continue;
    if (start >= 0) {
      // o CRLF antes do delimitador pertence ao delimitador, não à parte
      let end = idx;
      if (end > start && body[end - 1] === 0x0a) end--;
      if (end > start && body[end - 1] === 0x0d) end--;
      parts.push(body.subarray(start, end));
    }
    if (next === 0x2d && body[pos + 1] === 0x2d) return parts;
    const nl = body.indexOf(0x0a, pos);
    if (nl < 0) return parts;
    start = pos = nl + 1;
  }
  // sem delimitador de fechamento: aproveita o que veio
  if (start >= 0 && start < body.length) parts.push(body.subarray(start));
  return parts;
}

function walk(entity, out, depth) {
  const ct = parseParams(entity.headers['content-type'] || 'text/plain');
  let type = ct.value.includes('/') ? ct.value : 'text/plain';
  if (type.startsWith('multipart/')) {
    if (ct.params.boundary && depth < 40) {
      for (const part of splitMultipart(entity.body, ct.params.boundary)) walk(parseEntity(part), out, depth + 1);
      return;
    }
    type = 'text/plain';
  }
  const disp = parseParams(entity.headers['content-disposition'] || '');
  // só o nome do arquivo: caminhos ("C:\...\x.pdf", "../x") não devem sair daqui
  const filename = decodeWords(disp.params.filename || ct.params.name || '').split(/[\\/]/).pop().trim();
  const content = decodeTransfer(entity.body, entity.headers['content-transfer-encoding']);
  const bodyText = type === 'text/plain' || type === 'text/html';
  if (disp.value === 'attachment' || filename || !bodyText) {
    const contentId = (entity.headers['content-id'] || '').replace(/[<>\s]/g, '') || null;
    out.attachments.push({
      filename: filename || `anexo-${out.attachments.length + 1}`,
      contentType: type,
      content,
      contentId,
      inline: disp.value === 'inline' || (!disp.value && !!contentId),
    });
    return;
  }
  const str = bytesToText(content, ct.params.charset).replace(/\r\n?/g, '\n');
  if (type === 'text/html') out.html ??= str;
  else out.text ??= str;
}

function parseDate(v) {
  if (!v) return null;
  const d = new Date(v.replace(/\([^)]*\)/g, '').trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function msgIds(v) {
  if (!v) return [];
  const ids = [...String(v).matchAll(/<([^<>]*)>/g)].map((m) => m[1].trim()).filter(Boolean);
  return ids.length ? ids : String(v).split(/[\s,]+/).filter(Boolean);
}

export function parseMessage(raw) {
  let buf = Buffer.isBuffer(raw)
    ? raw
    : raw instanceof Uint8Array
      ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
      : Buffer.from(String(raw ?? ''), 'utf8');
  // linha "From " do formato mbox, quando a mensagem vem de um arquivo
  if (buf.subarray(0, 5).toString('latin1') === 'From ') {
    const nl = buf.indexOf(0x0a);
    buf = nl < 0 ? EMPTY : buf.subarray(nl + 1);
  }
  const root = parseEntity(buf);
  const h = root.headers;
  const out = {
    headers: h,
    from: parseAddressList(h.from)[0] || null,
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    replyTo: parseAddressList(h['reply-to'])[0] || null,
    subject: decodeWords(h.subject || ''),
    date: parseDate(h.date),
    messageId: msgIds(h['message-id'])[0] || null,
    inReplyTo: msgIds(h['in-reply-to'])[0] || null,
    references: msgIds(h.references),
    text: undefined,
    html: undefined,
    attachments: [],
  };
  walk(root, out, 0);
  out.html ??= null;
  // muitos remetentes mandam um text/plain vazio ao lado do HTML
  if (!out.text?.trim() && out.html) out.text = htmlToText(out.html);
  out.text ??= '';
  return out;
}

// ---------- HTML -> texto ----------

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  shy: '', zwnj: '', zwj: '', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»',
  bull: '•', middot: '·', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', plusmn: '±',
  times: '×', divide: '÷', para: '¶', sect: '§', iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º',
  sup1: '¹', sup2: '²', sup3: '³', frac12: '½', frac14: '¼', frac34: '¾', micro: 'µ', szlig: 'ß',
  aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', check: '✓',
};
const MARKS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', cedil: '\u0327', ring: '\u030a' };

function namedEntity(name) {
  if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
  // letras acentuadas (&aacute;, &Ccedil;, &otilde;...) sem precisar listar uma a uma
  const m = /^([a-zA-Z])(acute|grave|circ|tilde|uml|cedil|ring)$/.exec(name);
  if (!m) return null;
  const ch = (m[1] + MARKS[m[2]]).normalize('NFC');
  return ch.length === 1 ? ch : null;
}

function decodeEntities(s) {
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z][a-z0-9]*));/gi, (all, dec, hex, name) => {
    if (name) return namedEntity(name) ?? all;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : '\ufffd';
  });
}

export function htmlToText(html) {
  const s = String(html ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/<br\b[^>]*>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/?(?:p|h[1-6]|blockquote|pre|table|ul|ol|dl)\b[^>]*>/gi, '\n\n')
    .replace(/<\/?(?:div|tr|section|article|header|footer|nav|aside|main|form|dt|dd|hr|address|figure|figcaption)\b[^>]*>/gi, '\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<\/?[a-z!][^>]*>/gi, '');
  return decodeEntities(s)
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------- montagem ----------

const MANAGED = new Set([
  'date', 'from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'message-id', 'in-reply-to', 'references',
  'mime-version', 'content-type', 'content-transfer-encoding', 'content-disposition',
]);

const TYPES = {
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', html: 'text/html', htm: 'text/html',
  json: 'application/json', xml: 'application/xml', zip: 'application/zip', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ics: 'text/calendar', eml: 'message/rfc822', md: 'text/markdown',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

// Quebra de linha em valor de cabeçalho abriria espaço para injetar cabeçalhos.
const oneLine = (v) => String(v ?? '').replace(/[\r\n\0]+/g, ' ');
const quote = (v) => `"${v.replace(/[\\"]/g, '\\$&')}"`;
const nonAscii = (v) => /[^\x00-\x7f]/.test(v);

function localDomain() {
  const h = String(hostname() || '').toLowerCase().replace(/[^a-z0-9.-]/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return h || 'localhost';
}

export function generateMessageId() {
  return `${Date.now().toString(36)}.${randomBytes(9).toString('hex')}@${localDomain()}`;
}

const bareId = (v) => oneLine(v).trim().replace(/^<|>$/g, '').trim();

// Dobra o cabeçalho nos espaços para ficar em até 76 colunas (nunca logo após o nome).
function fold(line, max = 76) {
  if (line.length <= max) return line;
  const words = line.split(' ');
  const out = [];
  let cur = words.shift();
  for (const w of words) {
    if (w && cur.length + 1 + w.length > max && /\S/.test(cur) && (out.length || cur.includes(' '))) {
      out.push(cur);
      cur = ` ${w}`;
    } else cur += ` ${w}`;
  }
  out.push(cur);
  return out.join('\r\n');
}

function formatAddress({ name, address }) {
  const addr = oneLine(address).trim();
  const label = oneLine(name).replace(/\s+/g, ' ').trim();
  if (!label) return addr;
  if (nonAscii(label)) return `${encodeWord(label)} <${addr}>`;
  if (/^[\w!#$%&'*+\-/^`{|}~ ]+$/.test(label)) return `${label} <${addr}>`;
  return `${quote(label)} <${addr}>`;
}

const formatList = (v) => parseAddressList(v).map(formatAddress).join(', ');

function qpEncode(text) {
  return String(text ?? '')
    .replace(/\r\n|\r|\n/g, '\n')
    .split('\n')
    .map((line) => {
      const bytes = Buffer.from(line, 'utf8');
      let out = '';
      let cur = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        // espaço/tab no fim da linha precisa ser codificado, senão o transporte pode cortá-lo
        const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && i < bytes.length - 1);
        const tok = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
        if (cur.length + tok.length > 75) {
          out += `${cur}=\r\n`;
          cur = '';
        }
        cur += tok;
      }
      return out + cur;
    })
    .join('\r\n');
}

const base64Lines = (buf) => (buf.length ? buf.toString('base64').match(/.{1,76}/g).join('\r\n') : '');

function filenameParam(filename) {
  if (!nonAscii(filename) && filename.length <= 50) return `filename=${quote(filename)}`;
  // RFC 2231 com continuações para nomes longos ou acentuados
  const enc = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const chunks = [];
  for (const tok of enc.match(/%[0-9A-F]{2}|[^%]/g) || []) {
    if (!chunks.length || chunks.at(-1).length + tok.length > 50) chunks.push('');
    chunks[chunks.length - 1] += tok;
  }
  if (chunks.length === 1) return `filename*=UTF-8''${enc}`;
  return chunks.map((c, i) => `filename*${i}*=${i ? '' : "UTF-8''"}${c}`).join('; ');
}

function textPart(body, subtype) {
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, 'Content-Transfer-Encoding: quoted-printable'],
    body: qpEncode(body),
  };
}

function attachmentPart(a, i) {
  let content = a.content ?? EMPTY;
  if (typeof content === 'string') content = Buffer.from(content, a.encoding || 'utf8');
  else if (!Buffer.isBuffer(content)) content = Buffer.from(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
  const filename = oneLine(a.filename || `anexo-${i + 1}`).trim();
  const ext = filename.split('.').pop().toLowerCase();
  const type = oneLine(a.contentType || TYPES[ext] || 'application/octet-stream').trim().toLowerCase();
  const cid = a.contentId ? bareId(a.contentId) : null;
  const inline = Boolean(a.inline);
  // name= com palavra codificada é o que Outlook/Gmail leem; filename* segue a RFC 2231
  const name = nonAscii(filename) ? `name="${encodeWord(filename)}"` : `name=${quote(filename)}`;
  const headers = [
    fold(`Content-Type: ${type}; ${name}`),
    'Content-Transfer-Encoding: base64',
    fold(`Content-Disposition: ${inline ? 'inline' : 'attachment'}; ${filenameParam(filename)}`),
  ];
  if (cid) headers.push(fold(`Content-ID: <${cid}>`));
  return { headers, body: base64Lines(content), inline: inline && !!cid };
}

function multipart(subtype, parts) {
  const boundary = `----=_Parte_${randomBytes(12).toString('hex')}`;
  const body = parts.map((p) => `--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body}`).join('\r\n');
  return {
    headers: [fold(`Content-Type: multipart/${subtype}; boundary="${boundary}"`)],
    body: `${body}\r\n--${boundary}--\r\n`,
  };
}

export function buildMessage({
  from, to, cc, replyTo, subject, text, html, headers, attachments, messageId, date, inReplyTo, references,
} = {}) {
  const lines = [];
  const add = (name, value) => {
    if (value != null && value !== '') lines.push(fold(`${name}: ${value}`));
  };
  const when = date == null ? new Date() : new Date(date);
  add('Date', formatDate(Number.isNaN(when.getTime()) ? new Date() : when));
  add('From', formatList(from));
  add('To', formatList(to));
  add('Cc', formatList(cc));
  add('Reply-To', formatList(replyTo));
  add('Subject', encodeWord(oneLine(subject).trim()));
  add('Message-ID', `<${bareId(messageId) || generateMessageId()}>`);
  if (inReplyTo) add('In-Reply-To', `<${bareId(inReplyTo)}>`);
  const refs = [].concat(references ?? []).flatMap((r) => msgIds(oneLine(r)));
  if (refs.length) add('References', refs.map((r) => `<${r}>`).join(' '));
  for (const [key, value] of Object.entries(headers || {})) {
    if (!/^[!-9;-~]+$/.test(key) || MANAGED.has(key.toLowerCase())) continue;
    for (const v of [].concat(value)) if (v != null) add(key, encodeWord(oneLine(v).trim()));
  }
  add('MIME-Version', '1.0');

  const hasText = text != null;
  const hasHtml = html != null;
  let content = hasText && hasHtml
    ? multipart('alternative', [textPart(text, 'plain'), textPart(html, 'html')])
    : hasHtml ? textPart(html, 'html') : textPart(text ?? '', 'plain');
  const files = (attachments || []).map(attachmentPart);
  // imagens com Content-ID só fazem sentido junto do HTML, em multipart/related
  const related = hasHtml ? files.filter((f) => f.inline) : [];
  const mixed = files.filter((f) => !related.includes(f));
  if (related.length) content = multipart('related', [content, ...related]);
  if (mixed.length) content = multipart('mixed', [content, ...mixed]);

  const body = content.body.endsWith('\r\n') ? content.body : `${content.body}\r\n`;
  return `${[...lines, ...content.headers].join('\r\n')}\r\n\r\n${body}`;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Formato da RFC 5322 no fuso local (nomes em inglês por exigência da RFC).
function formatDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const abs = Math.abs(off);
  return `${DAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `
    + `${off >= 0 ? '+' : '-'}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}
