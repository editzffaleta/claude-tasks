// Cliente SMTP mínimo (RFC 5321) para o quadro mandar e-mails sem dependências.
// Uma conexão por envio: TLS direto (465) ou STARTTLS (587), AUTH PLAIN/LOGIN.
import { Buffer } from 'node:buffer';
import net from 'node:net';
import { hostname } from 'node:os';
import tls from 'node:tls';
import { buildMessage, generateMessageId, parseAddressList } from './mime.js';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|::1|\[::1\])$/i;
const ADDRESS = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+$/;
const MAX_LINE = 64 * 1024;

function settings(config = {}) {
  if (!config.host) throw new Error('Informe o servidor SMTP (host)');
  const secure = Boolean(config.secure);
  // EHLO pede um nome de domínio; nomes de máquina com caracteres estranhos são trocados
  const name = String(config.name || hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '-') || 'localhost';
  return {
    host: String(config.host),
    // 587 sem TLS direto; com secure e sem porta, 465 é o que funciona na prática
    port: Number(config.port) || (secure ? 465 : 587),
    secure,
    starttls: config.starttls !== false,
    user: config.user,
    pass: config.pass ?? '',
    timeout: Number(config.timeout) || 20000,
    rejectUnauthorized: config.rejectUnauthorized !== false,
    allowInsecureAuth: Boolean(config.allowInsecureAuth),
    name,
  };
}

class SmtpConnection {
  constructor(cfg) {
    this.cfg = cfg;
    this.label = `${cfg.host}:${cfg.port}`;
    this.replies = [];
    this.lines = [];
    this.buf = Buffer.alloc(0);
    this.waiter = null;
    this.error = null;
    this.closing = false;
    this.encrypted = false;
    this.ext = new Map();
  }

  attach(socket) {
    const onData = (chunk) => this.feed(chunk);
    const onError = (err) => this.fail(new Error(`Falha na conexão com o servidor SMTP ${this.label}: ${err.message}`));
    const onClose = () => {
      if (!this.closing) this.fail(new Error(`O servidor SMTP ${this.label} fechou a conexão inesperadamente`));
    };
    socket.on('data', onData).on('error', onError).on('close', onClose);
    this.socket = socket;
    this.detach = () => socket.off('data', onData).off('error', onError).off('close', onClose);
  }

  tlsOptions() {
    const { host, rejectUnauthorized } = this.cfg;
    return { servername: net.isIP(host) ? undefined : host, rejectUnauthorized };
  }

  async open() {
    const { host, port, secure } = this.cfg;
    this.attach(secure ? tls.connect({ host, port, ...this.tlsOptions() }) : net.connect({ host, port }));
    this.encrypted = secure;
    // erros de conexão e de TLS chegam pelo evento "error" e rejeitam esta leitura
    const greeting = await this.read();
    if (greeting.code !== 220) throw new Error(`SMTP recusou a conexão: ${greeting.text}`);
  }

  // STARTTLS: o mesmo socket TCP passa a carregar TLS; nada em texto puro depois disso.
  async upgrade() {
    const plain = this.socket;
    this.detach();
    plain.on('error', () => {});
    const secure = tls.connect({ socket: plain, ...this.tlsOptions() });
    this.attach(secure);
    await new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.arm();
      secure.once('secureConnect', () => {
        if (this.waiter?.resolve !== resolve) return;
        this.waiter = null;
        this.disarm();
        resolve();
      });
    });
    this.encrypted = true;
  }

  feed(chunk) {
    if (this.waiter) this.arm();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let nl;
    while ((nl = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, nl).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(nl + 1);
      this.lines.push(line);
      // "250-..." continua a resposta; "250 ..." (ou só "250") encerra
      if (/^\d{3}-/.test(line)) continue;
      const lines = this.lines;
      this.lines = [];
      const code = Number(line.slice(0, 3)) || 0;
      const texts = lines.map((l) => l.slice(4).trim()).filter(Boolean);
      this.deliver({ code, lines: lines.map((l) => l.slice(4)), text: [code, ...texts].join(' ') });
    }
    if (this.buf.length > MAX_LINE) this.fail(new Error(`Resposta inválida do servidor SMTP ${this.label} (linha longa demais)`));
  }

  deliver(reply) {
    if (!this.waiter) return void this.replies.push(reply);
    const { resolve } = this.waiter;
    this.waiter = null;
    this.disarm();
    resolve(reply);
  }

  fail(err) {
    if (this.error) return;
    this.error = err;
    this.disarm();
    const w = this.waiter;
    this.waiter = null;
    w?.reject(err);
    this.socket?.destroy();
  }

  // O prazo conta inatividade enquanto esperamos o servidor, não a duração total.
  arm(ms = this.cfg.timeout) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.fail(new Error(`Tempo esgotado (${Math.round(ms / 1000)}s) esperando o servidor SMTP ${this.label}`));
    }, ms);
  }

  disarm() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  read(ms) {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.error) return Promise.reject(this.error);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
      this.arm(ms);
    });
  }

  write(data) {
    if (this.error) throw this.error;
    this.socket.write(data);
  }

  send(line, ms) {
    this.write(`${line}\r\n`);
    return this.read(ms);
  }

  async command(line, codes, label) {
    const r = await this.send(line);
    if (!codes.includes(r.code)) throw new Error(`${label}: ${r.text}`);
    return r;
  }

  async hello() {
    let r = await this.send(`EHLO ${this.cfg.name}`);
    this.ext = new Map();
    if (r.code !== 250) {
      // servidor antigo sem ESMTP: HELO e nenhuma extensão
      r = await this.send(`HELO ${this.cfg.name}`);
      if (r.code !== 250) throw new Error(`SMTP recusou a saudação (EHLO/HELO): ${r.text}`);
      return;
    }
    for (const line of r.lines.slice(1)) {
      const [key, ...rest] = line.trim().split(/[\s=]+/);
      if (!key) continue;
      const k = key.toUpperCase();
      this.ext.set(k, [this.ext.get(k), rest.join(' ')].filter(Boolean).join(' '));
    }
  }

  async login() {
    const { user, pass, host, allowInsecureAuth } = this.cfg;
    // sem TLS a senha iria em texto puro; um MITM pode ter removido o STARTTLS
    if (!this.encrypted && !allowInsecureAuth && !LOOPBACK.test(host)) {
      throw new Error(`O servidor SMTP ${this.label} não ofereceu TLS; a senha não será enviada sem criptografia (use secure/starttls ou allowInsecureAuth: true)`);
    }
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    const methods = (this.ext.get('AUTH') || '').toUpperCase().split(/\s+/);
    let r;
    if (methods.includes('PLAIN')) {
      r = await this.send(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
      if (r.code === 334) r = await this.send(b64(`\0${user}\0${pass}`));
    } else {
      r = await this.send('AUTH LOGIN');
      if (r.code === 334) r = await this.send(b64(user));
      if (r.code === 334) r = await this.send(b64(pass));
    }
    if (r.code !== 235) throw new Error(`SMTP recusou o login: ${r.text}`);
  }

  async handshake() {
    await this.open();
    await this.hello();
    if (!this.cfg.secure && this.cfg.starttls && this.ext.has('STARTTLS')) {
      await this.command('STARTTLS', [220], 'SMTP recusou o STARTTLS');
      await this.upgrade();
      await this.hello();
    }
    if (this.cfg.user) await this.login();
  }

  async quit() {
    if (this.error || !this.socket || this.socket.destroyed) return;
    this.closing = true;
    try {
      await this.send('QUIT', Math.min(this.cfg.timeout, 5000));
    } catch {
      // a mensagem já foi aceita (ou o erro original importa mais); falha no QUIT é irrelevante
    }
  }

  close() {
    this.closing = true;
    this.disarm();
    this.socket?.destroy();
  }
}

// Linha começando com "." ganha outro "." para não ser lida como fim dos dados (RFC 5321 §4.5.2).
function dotStuff(raw) {
  let s = String(raw).replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');
  if (!s.endsWith('\r\n')) s += '\r\n';
  return `${s}.\r\n`;
}

function checkAddress(address) {
  if (!ADDRESS.test(address)) throw new Error(`Endereço de e-mail inválido: "${address}"`);
  return address;
}

export async function sendMail(config, message = {}) {
  const cfg = settings(config);
  const from = parseAddressList(message.from)[0];
  if (!from) throw new Error('Informe o remetente (from)');
  checkAddress(from.address);
  const recipients = [...new Set(
    [message.to, message.cc, message.bcc].flatMap((list) => parseAddressList(list)).map((a) => checkAddress(a.address)),
  )];
  if (!recipients.length) throw new Error('Informe pelo menos um destinatário (to, cc ou bcc)');
  const messageId = String(message.messageId || '').trim().replace(/^<|>$/g, '') || generateMessageId();
  // bcc só vai no envelope (RCPT TO), nunca nos cabeçalhos
  const { bcc, ...visible } = message;
  const raw = buildMessage({ ...visible, messageId });

  const conn = new SmtpConnection(cfg);
  try {
    await conn.handshake();
    await conn.command(`MAIL FROM:<${from.address}>`, [250], 'SMTP recusou o remetente');
    const accepted = [];
    const rejected = [];
    const problems = [];
    for (const rcpt of recipients) {
      const r = await conn.send(`RCPT TO:<${rcpt}>`);
      if (r.code === 250 || r.code === 251) accepted.push(rcpt);
      else {
        rejected.push(rcpt);
        problems.push(`${rcpt} (${r.text})`);
      }
    }
    if (!accepted.length) throw new Error(`SMTP recusou todos os destinatários: ${problems.join('; ')}`);
    await conn.command('DATA', [354], 'SMTP recusou o envio dos dados (DATA)');
    conn.write(dotStuff(raw));
    const r = await conn.read();
    if (r.code !== 250) throw new Error(`SMTP recusou a mensagem: ${r.text}`);
    await conn.quit();
    return { messageId, accepted, rejected, response: r.text };
  } catch (err) {
    await conn.quit();
    throw err;
  } finally {
    conn.close();
  }
}

export async function verifySmtp(config) {
  const conn = new SmtpConnection(settings(config));
  try {
    await conn.handshake();
    await conn.quit();
    return true;
  } finally {
    conn.close();
  }
}
