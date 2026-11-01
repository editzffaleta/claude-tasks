// Cliente IMAP mínimo (RFC 3501) para buscar e-mails não lidos e transformá-los em tarefas.
// O ponto delicado é o enquadramento: um literal {n} traz n bytes crus, então o buffer é
// tratado em bytes e só as linhas de controle viram texto (mensagens podem ter 8 bits/binário).
import { Buffer } from 'node:buffer';
import net from 'node:net';
import tls from 'node:tls';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const MAX_LINE = 1024 * 1024;

// Strings ASCII vão entre aspas; o resto (acentos, quebras) só é seguro como literal.
function astring(value) {
  const s = String(value ?? '');
  if (s.includes('\0')) throw new Error('IMAP: usuário, senha ou pasta não podem conter o caractere NUL');
  if (/[^\x01-\x7f]|[\r\n]/.test(s)) return Buffer.from(s, 'utf8');
  return `"${s.replace(/[\\"]/g, '\\$&')}"`;
}

// Nomes de pasta com acento usam UTF-7 modificado (RFC 3501 §5.1.3), não UTF-8.
function encodeMailbox(name) {
  return String(name).replace(/&/g, '&-').replace(/[^\x20-\x7e]+/g, (run) => {
    const utf16 = Buffer.alloc(run.length * 2);
    for (let i = 0; i < run.length; i++) utf16.writeUInt16BE(run.charCodeAt(i), i * 2);
    return `&${utf16.toString('base64').replace(/=+$/, '').replace(/\//g, ',')}-`;
  });
}

function checkUid(uid) {
  const n = Number(uid);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`UID inválido: ${uid}`);
  return n;
}

export class ImapClient {
  constructor({ host, port, secure = true, user, pass, timeout = 30000, rejectUnauthorized = true, allowInsecureAuth = false } = {}) {
    if (!host) throw new Error('Informe o servidor IMAP (host)');
    this.host = String(host);
    this.secure = secure !== false;
    this.port = Number(port) || (this.secure ? 993 : 143);
    this.user = user;
    this.pass = pass ?? '';
    this.timeout = Number(timeout) || 30000;
    this.rejectUnauthorized = rejectUnauthorized !== false;
    this.allowInsecureAuth = Boolean(allowInsecureAuth);
    this.label = `${this.host}:${this.port}`;
    this.seq = 0;
    this.queue = Promise.resolve();
    this.pending = null;
    this.error = null;
    this.closing = false;
    this.preauth = false;
    this.bye = null;
    // estado do leitor: pedaços da linha atual, bytes que faltam do literal e a resposta em montagem
    this.lineChunks = [];
    this.lineSize = 0;
    this.literalLeft = 0;
    this.literalChunks = [];
    this.current = { text: '', literals: [] };
  }

  async connect() {
    if (this.socket) throw new Error('IMAP: conexão já aberta');
    const opts = { host: this.host, port: this.port };
    const socket = this.secure
      ? tls.connect({ ...opts, servername: net.isIP(this.host) ? undefined : this.host, rejectUnauthorized: this.rejectUnauthorized })
      : net.connect(opts);
    this.socket = socket;
    socket.on('data', (chunk) => this.feed(chunk));
    socket.on('error', (err) => this.fail(new Error(`Falha na conexão com o servidor IMAP ${this.label}: ${err.message}`)));
    socket.on('close', () => {
      const msg = this.closing
        ? 'Conexão IMAP encerrada'
        : this.bye
          ? `O servidor IMAP ${this.label} encerrou a conexão: ${this.bye}`
          : `O servidor IMAP ${this.label} fechou a conexão inesperadamente`;
      this.fail(new Error(msg));
    });
    const greeting = await new Promise((resolve, reject) => {
      this.pending = { greeting: true, untagged: [], resolve, reject };
      this.arm();
    });
    this.preauth = /^\* PREAUTH\b/i.test(greeting);
  }

  async login() {
    if (this.preauth) return;
    if (!this.user) throw new Error('Informe o usuário IMAP (user)');
    // sem TLS o LOGIN iria em texto puro pela rede
    if (!this.secure && !this.allowInsecureAuth && !LOOPBACK.test(this.host)) {
      throw new Error(`Conexão IMAP com ${this.label} sem TLS; a senha não será enviada sem criptografia (use secure: true ou allowInsecureAuth: true)`);
    }
    await this.run(['LOGIN ', astring(this.user), ' ', astring(this.pass)], 'IMAP recusou o login');
  }

  async select(mailbox = 'INBOX') {
    const { untagged } = await this.run(['SELECT ', astring(encodeMailbox(mailbox))], `IMAP não conseguiu abrir a pasta "${mailbox}"`);
    let exists = 0;
    let uidValidity = null;
    for (const { text } of untagged) {
      let m;
      if ((m = /^\* (\d+) EXISTS\b/i.exec(text))) exists = Number(m[1]);
      else if ((m = /\[UIDVALIDITY (\d+)\]/i.exec(text))) uidValidity = Number(m[1]);
    }
    return { exists, uidValidity };
  }

  async searchUnseen() {
    const { untagged } = await this.run(['UID SEARCH UNSEEN'], 'IMAP recusou a busca por não lidas');
    const uids = untagged.flatMap(({ text }) => (/^\* SEARCH\b/i.test(text) ? text.slice(8).trim().split(/\s+/).map(Number) : []));
    return [...new Set(uids.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  }

  async fetchRaw(uid) {
    const raw = await this.fetchBody(uid);
    if (!raw) throw new Error(`IMAP: mensagem UID ${uid} não encontrada na pasta`);
    return raw;
  }

  // null quando a mensagem sumiu entre a busca e o FETCH (apagada por outro cliente)
  async fetchBody(uid) {
    const id = checkUid(uid);
    const { untagged } = await this.run([`UID FETCH ${id} (BODY.PEEK[])`], 'IMAP recusou o FETCH');
    for (const { text, literals } of untagged) {
      if (!/^\* \d+ FETCH\b/i.test(text)) continue;
      const uidMatch = /\bUID (\d+)/i.exec(text);
      if (uidMatch && Number(uidMatch[1]) !== id) continue;
      const m = /BODY\[\](?:<\d+>)? ?/i.exec(text);
      if (!m) continue;
      const after = text.slice(m.index + m[0].length);
      if (/^~?\{\d+\}/.test(after)) {
        // o corpo é o literal anunciado logo após BODY[]; conta os literais anteriores
        const before = (text.slice(0, m.index).match(/~?\{\d+\}/g) || []).length;
        return literals[before] ?? null;
      }
      const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(after);
      if (quoted) return Buffer.from(quoted[1].replace(/\\(.)/g, '$1'), 'utf8');
    }
    return null;
  }

  async markSeen(uid) {
    const set = [].concat(uid).map(checkUid).join(',');
    if (set) await this.run([`UID STORE ${set} +FLAGS (\\Seen)`], 'IMAP recusou marcar como lida');
  }

  async logout() {
    if (!this.socket || this.error) return this.close();
    this.closing = true;
    try {
      await this.run(['LOGOUT'], 'IMAP recusou o LOGOUT');
    } catch {
      // alguns servidores fecham antes do OK; tanto faz, a sessão acabou
    } finally {
      this.close();
    }
  }

  close() {
    this.closing = true;
    this.disarm();
    this.socket?.destroy();
  }

  // ---------- protocolo ----------

  // Um comando por vez: respostas não marcadas (*) pertencem ao comando em andamento.
  run(pieces, label) {
    const job = this.queue.then(() => this.exec(pieces, label));
    this.queue = job.catch(() => {});
    return job;
  }

  async exec(pieces, label) {
    if (this.error) throw this.error;
    if (!this.socket) throw new Error('IMAP: chame connect() antes');
    const tag = `A${String(++this.seq).padStart(3, '0')}`;
    const done = new Promise((resolve, reject) => {
      this.pending = { tag, label, untagged: [], resolve, reject, onContinue: null };
    });
    this.arm();
    let line = `${tag} `;
    for (const piece of pieces) {
      if (typeof piece === 'string') {
        line += piece;
        continue;
      }
      // literal síncrono: manda o tamanho e só envia os bytes depois do "+" do servidor
      const cont = new Promise((resolve) => {
        this.pending.onContinue = resolve;
      });
      this.socket.write(`${line}{${piece.length}}\r\n`);
      await Promise.race([cont, done]);
      if (this.pending?.tag !== tag) return done;
      this.socket.write(piece);
      line = '';
    }
    this.socket.write(`${line}\r\n`);
    return done;
  }

  feed(chunk) {
    if (this.pending) this.arm();
    while (chunk.length) {
      if (this.literalLeft > 0) {
        const n = Math.min(this.literalLeft, chunk.length);
        this.literalChunks.push(chunk.subarray(0, n));
        this.literalLeft -= n;
        chunk = chunk.subarray(n);
        if (!this.literalLeft) {
          this.current.literals.push(Buffer.concat(this.literalChunks));
          this.literalChunks = [];
        }
        continue;
      }
      const nl = chunk.indexOf(0x0a);
      if (nl < 0) {
        this.lineChunks.push(chunk);
        this.lineSize += chunk.length;
        if (this.lineSize > MAX_LINE) this.fail(new Error(`Resposta inválida do servidor IMAP ${this.label} (linha longa demais)`));
        return;
      }
      const piece = this.lineChunks.length ? Buffer.concat([...this.lineChunks, chunk.subarray(0, nl)]) : chunk.subarray(0, nl);
      this.lineChunks = [];
      this.lineSize = 0;
      chunk = chunk.subarray(nl + 1);
      const text = piece.toString('utf8').replace(/\r$/, '');
      this.current.text += text;
      const literal = /~?\{(\d+)\}$/.exec(text);
      if (literal) {
        this.literalLeft = Number(literal[1]);
        if (!this.literalLeft) this.current.literals.push(Buffer.alloc(0));
        continue;
      }
      const resp = this.current;
      this.current = { text: '', literals: [] };
      this.dispatch(resp);
    }
  }

  dispatch(resp) {
    const p = this.pending;
    const { text } = resp;
    if (text.startsWith('+')) {
      if (p?.onContinue) {
        const go = p.onContinue;
        p.onContinue = null;
        go();
      }
      return;
    }
    if (text.startsWith('*')) {
      if (/^\* BYE\b/i.test(text)) this.bye = text;
      if (p?.greeting) {
        if (/^\* BYE\b/i.test(text)) return this.settle(new Error(`O servidor IMAP ${this.label} recusou a conexão: ${text}`));
        if (/^\* (OK|PREAUTH)\b/i.test(text)) return this.settle(null, text);
      }
      p?.untagged.push(resp);
      return;
    }
    const m = /^(\S+) (OK|NO|BAD)\b ?(.*)$/i.exec(text);
    if (!p || !m || m[1] !== p.tag) return;
    if (m[2].toUpperCase() === 'OK') this.settle(null, { untagged: p.untagged, text: m[3] });
    else this.settle(new Error(`${p.label}: ${m[2].toUpperCase()} ${m[3]}`.trim()));
  }

  settle(err, value) {
    const p = this.pending;
    this.pending = null;
    this.disarm();
    if (err) p.reject(err);
    else p.resolve(value);
  }

  fail(err) {
    if (this.error) return;
    this.error = err;
    this.disarm();
    const p = this.pending;
    this.pending = null;
    p?.reject(err);
    this.socket?.destroy();
  }

  // Prazo por inatividade enquanto há comando pendente: um FETCH grande pode demorar.
  arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fail(new Error(`Tempo esgotado (${Math.round(this.timeout / 1000)}s) esperando o servidor IMAP ${this.label}`));
    }, this.timeout);
  }

  disarm() {
    clearTimeout(this.timer);
    this.timer = null;
  }
}

export async function fetchUnseen(config, { mailbox = 'INBOX', limit = 50, markSeen = true } = {}) {
  const client = new ImapClient(config);
  try {
    await client.connect();
    await client.login();
    await client.select(mailbox);
    const max = Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(limit)) : 50;
    const uids = (await client.searchUnseen()).slice(0, max);
    const messages = [];
    for (const uid of uids) {
      const raw = await client.fetchBody(uid);
      if (raw) messages.push({ uid, raw });
    }
    // marca só depois de baixar tudo: se algo falhar no meio, nada some da caixa de não lidas
    if (markSeen && messages.length) await client.markSeen(messages.map((m) => m.uid));
    await client.logout();
    return messages;
  } finally {
    client.close();
  }
}

export async function verifyImap(config) {
  const client = new ImapClient(config);
  try {
    await client.connect();
    await client.login();
    await client.select('INBOX');
    await client.logout();
    return true;
  } finally {
    client.close();
  }
}
