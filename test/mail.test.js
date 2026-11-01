// Biblioteca de e-mail: servidores SMTP/IMAP falsos em 127.0.0.1 e casos de MIME do mundo real.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:net';
import { after, test } from 'node:test';
import { ImapClient, fetchUnseen, verifyImap } from '../src/mail/imap.js';
import { buildMessage, decodeWords, encodeWord, htmlToText, parseAddressList, parseMessage } from '../src/mail/mime.js';
import { sendMail, verifySmtp } from '../src/mail/smtp.js';

const servers = [];
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

const listen = (server) => new Promise((resolve) => {
  servers.push(server);
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const crlf = (...lines) => lines.join('\r\n');

async function waitConnections(server, n = 0) {
  for (let i = 0; i < 100; i++) {
    const count = await new Promise((r) => server.getConnections((_, c) => r(c)));
    if (count === n) return count;
    await delay(10);
  }
  return -1;
}

// ---------- SMTP falso ----------

async function fakeSmtp({ user = 'bruno', pass = 'segredo' } = {}) {
  const sessions = [];
  const server = createServer((sock) => {
    const s = { ehlo: null, auth: null, from: null, rcpt: [], data: null, quit: false };
    sessions.push(s);
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let inData = false;
    const reply = (...lines) => sock.write(lines.map((l) => `${l}\r\n`).join(''));
    reply('220-fake.local ESMTP', '220 pronto para receber');
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          // desfaz o dot-stuffing como um servidor de verdade faria
          s.data = buf.subarray(0, end + 2).toString('utf8').split('\r\n').map((l) => (l.startsWith('.') ? l.slice(1) : l)).join('\r\n');
          buf = buf.subarray(end + 5);
          inData = false;
          reply('250 2.0.0 Ok: queued as FAKE123');
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          s.ehlo = line.slice(5);
          reply('250-fake.local olá', '250-AUTH PLAIN LOGIN', '250-8BITMIME', '250 SIZE 10485760');
        } else if (verb === 'AUTH') {
          const [, mech, arg = ''] = line.split(' ');
          const [, u, p] = Buffer.from(arg, 'base64').toString('utf8').split('\0');
          if (mech !== 'PLAIN') reply('504 5.5.4 Mechanism not supported');
          else if (u === user && p === pass) {
            s.auth = u;
            reply('235 2.7.0 Authentication successful');
          } else reply('535 5.7.8 Error: authentication failed');
        } else if (verb === 'MAIL') {
          if (!s.auth) reply('530 5.7.0 Authentication required');
          else {
            s.from = /<(.*)>/.exec(line)[1];
            reply('250 2.1.0 Ok');
          }
        } else if (verb === 'RCPT') {
          const addr = /<(.*)>/.exec(line)[1];
          if (addr.startsWith('inexistente')) reply('550 5.1.1 <' + addr + '>: Recipient address rejected');
          else {
            s.rcpt.push(addr);
            reply('250 2.1.5 Ok');
          }
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          s.quit = true;
          reply('221 2.0.0 Bye');
          sock.end();
          return;
        } else reply('502 5.5.2 Error: command not recognized');
      }
    });
  });
  const port = await listen(server);
  return { server, sessions, port, config: { host: '127.0.0.1', port, secure: false, user, pass, name: 'teste.local' } };
}

const anexo = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);

const mensagem = () => ({
  from: 'Bruno Faleta <bruno@exemplo.com.br>',
  to: 'Maria Souza <maria@exemplo.com>',
  bcc: 'oculto@exemplo.com',
  subject: 'Relatório de ação ✓',
  text: 'Olá, Maria!\nSegue o relatório da ação.\n.linha que começa com ponto\n..e outra com dois',
  html: '<p>Olá, <b>Maria</b>!</p><p>Segue o relatório da ação.</p>',
  attachments: [{ filename: 'relatório.pdf', content: anexo, contentType: 'application/pdf' }],
});

test('sendMail entrega pelo SMTP com AUTH PLAIN, anexo e bcc só no envelope', async () => {
  const smtp = await fakeSmtp();
  const info = await sendMail(smtp.config, mensagem());

  assert.deepEqual(info.accepted, ['maria@exemplo.com', 'oculto@exemplo.com']);
  assert.deepEqual(info.rejected, []);
  assert.match(info.messageId, /^[^<>]+@[^<>]+$/);
  assert.match(info.response, /^250 /);

  const [s] = smtp.sessions;
  assert.equal(s.ehlo, 'teste.local');
  assert.equal(s.auth, 'bruno');
  assert.equal(s.from, 'bruno@exemplo.com.br');
  assert.deepEqual(s.rcpt, ['maria@exemplo.com', 'oculto@exemplo.com']);
  assert.ok(s.quit, 'deveria encerrar com QUIT');

  assert.ok(!/oculto@/.test(s.data), 'bcc não pode aparecer na mensagem');
  const parsed = parseMessage(s.data);
  assert.equal(parsed.subject, 'Relatório de ação ✓');
  assert.equal(parsed.text, mensagem().text);
  assert.equal(parsed.html, mensagem().html);
  assert.equal(parsed.messageId, info.messageId);
  assert.deepEqual(parsed.from, { name: 'Bruno Faleta', address: 'bruno@exemplo.com.br' });
  assert.deepEqual(parsed.to, [{ name: 'Maria Souza', address: 'maria@exemplo.com' }]);
  assert.ok(!('bcc' in parsed.headers));
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'relatório.pdf');
  assert.equal(parsed.attachments[0].contentType, 'application/pdf');
  assert.ok(parsed.attachments[0].content.equals(anexo));
  assert.equal(await waitConnections(smtp.server), 0);
});

test('sendMail separa destinatários recusados e falha se todos forem recusados', async () => {
  const smtp = await fakeSmtp();
  const info = await sendMail(smtp.config, { ...mensagem(), cc: 'inexistente@exemplo.com' });
  assert.deepEqual(info.accepted, ['maria@exemplo.com', 'oculto@exemplo.com']);
  assert.deepEqual(info.rejected, ['inexistente@exemplo.com']);

  await assert.rejects(
    sendMail(smtp.config, { from: 'bruno@exemplo.com.br', to: 'inexistente@exemplo.com', text: 'oi' }),
    /SMTP recusou todos os destinatários: inexistente@exemplo\.com \(550 5\.1\.1/,
  );
});

test('sendMail com senha errada falha com erro em português e a resposta do servidor', async () => {
  const smtp = await fakeSmtp();
  await assert.rejects(sendMail({ ...smtp.config, pass: 'errada' }, mensagem()), (err) => {
    assert.match(err.message, /^SMTP recusou o login: 535 5\.7\.8 Error: authentication failed$/);
    return true;
  });
  assert.equal(smtp.sessions[0].data, null);
  assert.ok(smtp.sessions[0].quit, 'deveria encerrar com QUIT mesmo após o erro');
});

test('verifySmtp confirma credenciais e o prazo esgota com servidor mudo', async () => {
  const smtp = await fakeSmtp();
  assert.equal(await verifySmtp(smtp.config), true);
  await assert.rejects(verifySmtp({ ...smtp.config, pass: 'x' }), /SMTP recusou o login/);

  const mudo = createServer((sock) => sock.on('error', () => {}));
  const port = await listen(mudo);
  await assert.rejects(verifySmtp({ host: '127.0.0.1', port, timeout: 150 }), /Tempo esgotado .* SMTP 127\.0\.0\.1:/);
});

test('sendMail não manda a senha sem TLS fora do loopback', async () => {
  // o mesmo servidor local, mas por um endereço que o cliente não reconhece como loopback
  const smtp = await fakeSmtp();
  const remoto = { ...smtp.config, host: '::ffff:127.0.0.1' };
  await assert.rejects(sendMail(remoto, mensagem()), /não ofereceu TLS; a senha não será enviada sem criptografia/);
  assert.equal(smtp.sessions[0].auth, null);
  const info = await sendMail({ ...remoto, allowInsecureAuth: true }, mensagem());
  assert.deepEqual(info.accepted, ['maria@exemplo.com', 'oculto@exemplo.com']);
});

// ---------- IMAP falso ----------

const unicos = [0x00, 0x0d, 0x0a, 0xff, 0x7b];
const binario = Buffer.concat([
  Buffer.from('\r\n.\r\nx--fronteira\r\n--fronteiraX\r\n{5}\r\nA004 OK falso\r\n* 9 FETCH {3}\r\n'),
  Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  Buffer.from(unicos),
]);

const raw41 = Buffer.from(crlf(
  'From: Ana <ana@exemplo.com>',
  'To: bruno@exemplo.com.br',
  'Subject: Primeira',
  'Message-ID: <m41@exemplo.com>',
  '',
  'Corpo simples.',
  '',
));

const raw42 = Buffer.concat([
  Buffer.from(crlf(
    'From: Sistema <sistema@exemplo.com>',
    'To: bruno@exemplo.com.br',
    'Subject: =?UTF-8?Q?Relat=C3=B3rio_bin=C3=A1rio?=',
    'Date: Wed, 15 Oct 2025 08:00:00 +0000',
    'Message-ID: <bin-42@exemplo.com>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="fronteira"',
    '',
    '--fronteira',
    'Content-Type: text/plain; charset=iso-8859-1',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
  )),
  Buffer.from('Segue o arquivo com a cota\xe7\xe3o. Linha que termina com {5}', 'latin1'),
  Buffer.from(crlf(
    '',
    '--fronteira',
    'Content-Type: application/octet-stream',
    'Content-Disposition: attachment; filename="dados.bin"',
    'Content-Transfer-Encoding: binary',
    '',
    '',
  )),
  binario,
  Buffer.from('\r\n--fronteira--\r\n'),
]);

function tokenize(line, literals) {
  return [...line.matchAll(/\0(\d+)\0|"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((m) => {
    if (m[1] !== undefined) return literals[Number(m[1])];
    if (m[2] !== undefined) return m[2].replace(/\\(.)/g, '$1');
    return m[3];
  });
}

// Manda a resposta em pedaços tortos para exercitar o enquadramento do cliente.
async function writeInPieces(sock, buf) {
  const sizes = [5, 1, 17, 2, 64, 3, 1, 300, 7];
  for (let pos = 0, i = 0; pos < buf.length; i++) {
    const n = sizes[i % sizes.length];
    sock.write(buf.subarray(pos, pos + n));
    pos += n;
    await delay(1);
  }
}

async function fakeImap({ users = { bruno: 'se"nh\\a' }, messages }) {
  const log = [];
  const box = new Map(messages.map(([uid, raw]) => [uid, { raw, seen: false }]));
  const server = createServer((sock) => {
    sock.setNoDelay(true);
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let pendingLine = '';
    let literals = [];
    let need = 0;
    let queue = Promise.resolve();
    let authed = false;
    sock.write('* OK [CAPABILITY IMAP4rev1] Fake IMAP pronto\r\n');

    async function handle(line, lits) {
      const [tag, cmd = '', ...args] = tokenize(line, lits);
      const send = (s) => sock.write(s);
      const seqOf = (uid) => [...box.keys()].indexOf(uid) + 1;
      switch (cmd.toUpperCase()) {
        case 'LOGIN':
          if (Object.hasOwn(users, args[0]) && users[args[0]] === args[1]) {
            authed = true;
            send(`${tag} OK LOGIN completed\r\n`);
          } else send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
          return;
        case 'SELECT':
          if (!authed) return send(`${tag} BAD not authenticated\r\n`);
          if (args[0] !== 'INBOX') return send(`${tag} NO [NONEXISTENT] Unknown Mailbox\r\n`);
          return send([
            '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)',
            `* ${box.size} EXISTS`,
            '* 0 RECENT',
            '* OK [UIDVALIDITY 1700000001] UIDs valid',
            '* OK [UIDNEXT 50] Predicted next UID',
            `${tag} OK [READ-WRITE] SELECT completed\r\n`,
          ].join('\r\n'));
        case 'UID': {
          const sub = (args[0] || '').toUpperCase();
          if (sub === 'SEARCH' && args[1] === 'UNSEEN') {
            const unseen = [...box].filter(([, m]) => !m.seen).map(([uid]) => uid);
            return send(`* SEARCH${unseen.map((u) => ` ${u}`).join('')}\r\n${tag} OK SEARCH completed\r\n`);
          }
          if (sub === 'FETCH' && args[2] === '(BODY.PEEK[])') {
            const uid = Number(args[1]);
            const msg = box.get(uid);
            const parts = [Buffer.from('* 1 FETCH (FLAGS (\\Seen))\r\n')];
            if (msg) parts.push(Buffer.from(`* ${seqOf(uid)} FETCH (UID ${uid} BODY[] {${msg.raw.length}}\r\n`), msg.raw, Buffer.from(')\r\n'));
            parts.push(Buffer.from(`${tag} OK FETCH completed\r\n`));
            return writeInPieces(sock, Buffer.concat(parts));
          }
          if (sub === 'STORE' && args[2] === '+FLAGS' && args[3] === '(\\Seen)') {
            const out = [];
            for (const uid of args[1].split(',').map(Number)) {
              const msg = box.get(uid);
              if (!msg) continue;
              msg.seen = true;
              out.push(`* ${seqOf(uid)} FETCH (UID ${uid} FLAGS (\\Seen))\r\n`);
            }
            return send(`${out.join('')}${tag} OK STORE completed\r\n`);
          }
          return send(`${tag} BAD UID desconhecido\r\n`);
        }
        case 'LOGOUT':
          send(`* BYE Fake IMAP saindo\r\n${tag} OK LOGOUT completed\r\n`);
          return sock.end();
        default:
          return send(`${tag} BAD comando desconhecido\r\n`);
      }
    }

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (need) {
          if (buf.length < need) return;
          literals.push(buf.subarray(0, need).toString('utf8'));
          pendingLine += `\0${literals.length - 1}\0`;
          buf = buf.subarray(need);
          need = 0;
          continue;
        }
        const nl = buf.indexOf('\r\n');
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString('utf8');
        buf = buf.subarray(nl + 2);
        const lit = /\{(\d+)\}$/.exec(line);
        if (lit) {
          pendingLine += line.slice(0, lit.index);
          need = Number(lit[1]);
          sock.write('+ pode mandar\r\n');
          continue;
        }
        const full = pendingLine + line;
        const lits = literals;
        pendingLine = '';
        literals = [];
        log.push(full);
        queue = queue.then(() => handle(full, lits));
      }
    });
  });
  const port = await listen(server);
  return { server, box, log, port, config: { host: '127.0.0.1', port, secure: false, user: 'bruno', pass: 'se"nh\\a' } };
}

test('fetchUnseen baixa os literais byte a byte e marca como lidas', async () => {
  const imap = await fakeImap({ messages: [[41, raw41], [42, raw42]] });
  const got = await fetchUnseen(imap.config);

  assert.deepEqual(got.map((m) => m.uid), [41, 42]);
  assert.ok(Buffer.isBuffer(got[1].raw));
  assert.ok(got[0].raw.equals(raw41));
  assert.ok(got[1].raw.equals(raw42), 'a mensagem 42 deveria chegar idêntica');
  assert.ok(imap.box.get(41).seen && imap.box.get(42).seen);

  assert.equal(imap.log[0], 'A001 LOGIN "bruno" "se\\"nh\\\\a"');
  assert.deepEqual(imap.log.slice(1).map((l) => l.slice(5)), [
    'SELECT "INBOX"',
    'UID SEARCH UNSEEN',
    'UID FETCH 41 (BODY.PEEK[])',
    'UID FETCH 42 (BODY.PEEK[])',
    'UID STORE 41,42 +FLAGS (\\Seen)',
    'LOGOUT',
  ]);
  assert.equal(await waitConnections(imap.server), 0, 'o socket deveria ser fechado');

  const parsed = parseMessage(got[1].raw);
  assert.equal(parsed.subject, 'Relatório binário');
  assert.equal(parsed.text, 'Segue o arquivo com a cotação. Linha que termina com {5}');
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].filename, 'dados.bin');
  assert.ok(parsed.attachments[0].content.equals(binario));

  // já marcadas: a segunda busca volta vazia
  assert.deepEqual(await fetchUnseen(imap.config), []);
});

test('fetchUnseen respeita limit e markSeen: false', async () => {
  const imap = await fakeImap({ messages: [[7, raw41], [8, raw41], [9, raw42]] });
  const got = await fetchUnseen(imap.config, { limit: 2, markSeen: false });
  assert.deepEqual(got.map((m) => m.uid), [7, 8]);
  assert.ok(![...imap.box.values()].some((m) => m.seen));
  assert.ok(!imap.log.some((l) => l.includes('STORE')));
});

test('ImapClient: select, senha errada e login com literal para texto acentuado', async () => {
  const imap = await fakeImap({ users: { bruno: 'se"nh\\a', 'joão': 'senha çã' }, messages: [[3, raw41]] });

  const client = new ImapClient(imap.config);
  await client.connect();
  await client.login();
  assert.deepEqual(await client.select(), { exists: 1, uidValidity: 1700000001 });
  assert.deepEqual(await client.searchUnseen(), [3]);
  assert.ok((await client.fetchRaw(3)).equals(raw41));
  await assert.rejects(client.fetchRaw(99), /IMAP: mensagem UID 99 não encontrada/);
  await assert.rejects(client.select('Arquivo'), /IMAP não conseguiu abrir a pasta "Arquivo": NO \[NONEXISTENT\]/);
  await client.logout();
  assert.ok(client.socket.destroyed);

  await assert.rejects(
    fetchUnseen({ ...imap.config, pass: 'errada' }),
    /^Error: IMAP recusou o login: NO \[AUTHENTICATIONFAILED\] Invalid credentials$/,
  );
  assert.equal(await verifyImap({ ...imap.config, user: 'joão', pass: 'senha çã' }), true);
  assert.ok(imap.log.some((l) => /^A\d+ LOGIN \0\d\0 \0\d\0$/.test(l)), 'usuário e senha acentuados deveriam ir como literais');
  assert.equal(await waitConnections(imap.server), 0);
});

// ---------- MIME ----------

test('parseMessage: quoted-printable ISO-8859-1 e palavra codificada no assunto', () => {
  const raw = crlf(
    'Received: from a by b; Tue, 14 Oct 2025 09:30:01 -0300',
    'Received: from c by d; Tue, 14 Oct 2025 09:30:02 -0300',
    'From: =?ISO-8859-1?Q?Jos=E9_da_Silva?= <jose@exemplo.com.br>',
    'To: equipe@exemplo.com.br',
    'Subject: =?ISO-8859-1?Q?Cota=E7=E3o?=',
    'Date: Tue, 14 Oct 2025 09:30:00 -0300 (BRT)',
    'Message-ID: <abc123@exemplo.com.br>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="ISO-8859-1"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Segue a cota=E7=E3o solicitada. Pre=E7o total: R$ 1.234,56 =',
    '(v=E1lido por 30 dias).   ',
    'Atenciosamente, Jos=E9',
  );
  const m = parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(m.subject, 'Cotação');
  assert.deepEqual(m.from, { name: 'José da Silva', address: 'jose@exemplo.com.br' });
  assert.deepEqual(m.to, [{ name: '', address: 'equipe@exemplo.com.br' }]);
  assert.equal(m.date, '2025-10-14T12:30:00.000Z');
  assert.equal(m.messageId, 'abc123@exemplo.com.br');
  assert.equal(m.text, 'Segue a cotação solicitada. Preço total: R$ 1.234,56 (válido por 30 dias).\nAtenciosamente, José');
  assert.equal(m.html, null);
  assert.deepEqual(m.attachments, []);
  assert.match(m.headers.received, /09:30:02/);
});

test('parseMessage: multipart aninhado com anexos RFC 2231 e imagem inline', () => {
  const pdf = Buffer.from('%PDF-1.4 falso\n');
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2]);
  const raw = crlf(
    'From: Financeiro <financeiro@exemplo.com.br>',
    'To: bruno@exemplo.com.br',
    'Subject: =?UTF-8?B?UmVsYXTDs3JpbyBtZW5z?=',
    ' =?UTF-8?B?YWw=?=',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="externo"',
    '',
    'Preâmbulo que deve ser ignorado.',
    '--externo',
    'Content-Type: multipart/alternative;',
    '\tboundary=interno',
    '',
    '--interno',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Segue o relatório.',
    '--interno',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('<p>Segue o <b>relatório</b>.</p>').toString('base64'),
    '--interno--',
    '--externo',
    'Content-Type: application/pdf',
    "Content-Disposition: attachment; filename*=UTF-8''relat%C3%B3rio.pdf",
    'Content-Transfer-Encoding: base64',
    '',
    pdf.toString('base64'),
    '--externo',
    'Content-Type: image/png; name="logo.png"',
    'Content-Disposition: inline',
    'Content-ID: <logo@exemplo>',
    'Content-Transfer-Encoding: base64',
    '',
    png.toString('base64'),
    '--externo',
    'Content-Type: text/csv',
    'Content-Disposition: attachment;',
    " filename*0*=UTF-8''or%C3%A7amento%20;",
    ' filename*1="2025.csv"',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'a;b=0D=0A1;2',
    '--externo',
    'Content-Type: application/octet-stream',
    '',
    'sem nome',
    '--externo--',
    'Epílogo ignorado.',
  );
  const m = parseMessage(raw);
  assert.equal(m.subject, 'Relatório mensal');
  assert.equal(m.text, 'Segue o relatório.');
  assert.equal(m.html, '<p>Segue o <b>relatório</b>.</p>');
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.inline, a.contentId]), [
    ['relatório.pdf', 'application/pdf', false, null],
    ['logo.png', 'image/png', true, 'logo@exemplo'],
    ['orçamento 2025.csv', 'text/csv', false, null],
    ['anexo-4', 'application/octet-stream', false, null],
  ]);
  assert.ok(m.attachments[0].content.equals(pdf));
  assert.ok(m.attachments[1].content.equals(png));
  assert.equal(m.attachments[2].content.toString(), 'a;b\r\n1;2');
  assert.equal(m.attachments[3].content.toString(), 'sem nome');
});

test('parseMessage: só HTML vira texto pelo htmlToText', () => {
  const raw = crlf(
    'From: agenda@exemplo.com',
    'Subject: =?windows-1252?Q?Reuni=E3o?=',
    'Content-Type: text/html; charset=windows-1252',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    '<html><head><title>x</title></head><body><p>Reuni=E3o =E0s 10h &ndash; sala 2</p>',
    '<ul><li>Pauta</li><li>Or=E7amento</li></ul></body></html>',
  );
  const m = parseMessage(Buffer.from(raw, 'latin1'));
  assert.equal(m.subject, 'Reunião');
  assert.match(m.html, /<p>Reunião às 10h/);
  assert.equal(m.text, 'Reunião às 10h – sala 2\n\n- Pauta\n- Orçamento');
});

test('parseMessage: listas de endereços, grupos, comentários e cabeçalhos dobrados', () => {
  const raw = crlf(
    'From: "Faleta, Bruno" <bruno@exemplo.com.br>',
    'To: "Silva, João" <joao@x.com>, Maria Souza <maria@x.com>, pedro@x.com,',
    '  =?UTF-8?Q?Ana_Lu=C3=ADza?= <ana@x.com>, carlos@x.com (Carlos Lima),',
    '  "Aspas \\"internas\\"" <aspas@x.com>',
    'Cc: Equipe: dev1@x.com, "Dev, Dois" <dev2@x.com>;, outro@x.com',
    'Reply-To: <respostas@x.com>',
    'Subject: Assunto',
    '  dobrado',
    'Message-ID: <id-1@x.com>',
    'In-Reply-To: <pai@x.com>',
    'References: <avo@x.com>',
    ' <pai@x.com>',
    'X-Repetido: primeiro',
    'X-Repetido: segundo',
    '',
    'corpo',
  );
  const m = parseMessage(raw);
  assert.deepEqual(m.from, { name: 'Faleta, Bruno', address: 'bruno@exemplo.com.br' });
  assert.deepEqual(m.to, [
    { name: 'Silva, João', address: 'joao@x.com' },
    { name: 'Maria Souza', address: 'maria@x.com' },
    { name: '', address: 'pedro@x.com' },
    { name: 'Ana Luíza', address: 'ana@x.com' },
    { name: 'Carlos Lima', address: 'carlos@x.com' },
    { name: 'Aspas "internas"', address: 'aspas@x.com' },
  ]);
  assert.deepEqual(m.cc.map((a) => a.address), ['dev1@x.com', 'dev2@x.com', 'outro@x.com']);
  assert.equal(m.cc[1].name, 'Dev, Dois');
  assert.deepEqual(m.replyTo, { name: '', address: 'respostas@x.com' });
  assert.equal(m.subject, 'Assunto  dobrado');
  assert.equal(m.inReplyTo, 'pai@x.com');
  assert.deepEqual(m.references, ['avo@x.com', 'pai@x.com']);
  assert.equal(m.headers['x-repetido'], 'segundo');
  assert.equal(m.text, 'corpo');
  assert.equal(m.date, null);
});

test('decodeWords/encodeWord e htmlToText', () => {
  // caractere de vários bytes cortado entre duas palavras adjacentes
  assert.equal(decodeWords('=?UTF-8?Q?a=C3?= =?UTF-8?Q?=A7=C3=A3o?= e =?iso-8859-1?q?Cota=E7=E3o?='), 'ação e Cotação');
  assert.equal(decodeWords('=?us-ascii?Q?ol=E1?= mundo'), 'olá mundo');
  assert.equal(decodeWords('=?UTF-8?B?4pyT?==?UTF-8?B?4pyT?='), '✓✓');
  assert.equal(encodeWord('plain ascii'), 'plain ascii');
  const longo = 'Atualização — '.repeat(10);
  const enc = encodeWord(longo);
  assert.ok(enc.split(' ').every((w) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w) && w.length <= 75));
  assert.equal(decodeWords(enc), longo);

  const html = '<html><head><style>p{color:red}</style></head><body><h1>Pedido&nbsp;n&ordm; 42</h1>'
    + '<p>Ol&aacute;, Jo&#227;o &amp; Maria!</p><script>alert(1)</script>'
    + '<ul><li>Item um</li><li>Item &lt;dois&gt;</li></ul><div>Total: R&#x24; 10</div>'
    + '<br><br><br><br><table><tr><td>a</td><td>b</td></tr></table><p>Fim &desconhecida;</p></body></html>';
  assert.equal(htmlToText(html), 'Pedido nº 42\n\nOlá, João & Maria!\n\n- Item um\n- Item <dois>\n\nTotal: R$ 10\n\na b\n\nFim &desconhecida;');
  assert.deepEqual(parseAddressList([{ name: 'A', address: 'a@x.com' }, 'B <b@x.com>, c@x.com']).map((a) => a.address), ['a@x.com', 'b@x.com', 'c@x.com']);
});

test('buildMessage faz ida e volta pelo parseMessage', () => {
  const bin = Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const text = `${'Linha longa com acentuação e símbolos € ✓ '.repeat(8)}fim\n.ponto no começo\nFrom no início\nespaço no fim   \n\tTab`;
  const input = {
    from: { name: 'Bruno Faleta', address: 'bruno@exemplo.com.br' },
    to: ['"Silva, João" <joao@x.com>', { name: 'Zé Ninguém', address: 'ze@x.com' }],
    cc: 'maria@x.com, Pedro (TI) <pedro@x.com>',
    replyTo: 'respostas@x.com',
    subject: 'Atualização da tarefa #42: revisão concluída — próximos passos e prazos combinados com a equipe ✓',
    text,
    html: '<p>Olá <img src="cid:logo@x"></p>',
    attachments: [
      { filename: 'relatório trimestral de atividades e orçamento detalhado 2025 — versão final.pdf', content: bin },
      { filename: 'logo.png', content: png, contentId: '<logo@x>', inline: true },
      { filename: 'notas.txt', content: 'texto do anexo' },
    ],
    messageId: '<tarefa-42@exemplo.com.br>',
    date: '2025-10-14T12:30:00Z',
    inReplyTo: 'pai@x.com',
    references: ['avo@x.com', '<pai@x.com>'],
    headers: { 'X-Tarefa': '42', 'X-Projeto': 'Quadro de ação', Bcc: 'nao@deve.aparecer', 'X-Injeção\r\nBcc': 'x' },
  };
  const raw = buildMessage(input);

  assert.ok(!/[^\r]\n/.test(raw) && !/\r[^\n]/.test(raw), 'só CRLF');
  assert.ok(raw.endsWith('\r\n'));
  for (const line of raw.split('\r\n')) assert.ok(line.length <= 78, `linha longa demais: ${line}`);
  assert.ok(/^[\x00-\x7f]*$/.test(raw), 'a mensagem montada deve ser ASCII puro');
  assert.ok(!/nao@deve/.test(raw));
  assert.match(raw, /^Content-Type: multipart\/mixed;/m);
  assert.match(raw, /^Content-Type: multipart\/related;/m);
  assert.match(raw, /^Content-Type: multipart\/alternative;/m);

  const m = parseMessage(raw);
  assert.deepEqual(m.from, { name: 'Bruno Faleta', address: 'bruno@exemplo.com.br' });
  assert.deepEqual(m.to, [{ name: 'Silva, João', address: 'joao@x.com' }, { name: 'Zé Ninguém', address: 'ze@x.com' }]);
  assert.deepEqual(m.cc, [{ name: '', address: 'maria@x.com' }, { name: 'Pedro (TI)', address: 'pedro@x.com' }]);
  assert.deepEqual(m.replyTo, { name: '', address: 'respostas@x.com' });
  assert.equal(m.subject, input.subject);
  assert.equal(m.date, '2025-10-14T12:30:00.000Z');
  assert.equal(m.messageId, 'tarefa-42@exemplo.com.br');
  assert.equal(m.inReplyTo, 'pai@x.com');
  assert.deepEqual(m.references, ['avo@x.com', 'pai@x.com']);
  assert.equal(m.text, text);
  assert.equal(m.html, input.html);
  assert.equal(m.headers['x-tarefa'], '42');
  assert.equal(decodeWords(m.headers['x-projeto']), 'Quadro de ação');
  assert.ok(!('bcc' in m.headers));
  assert.deepEqual(m.attachments.map((a) => [a.filename, a.contentType, a.inline, a.contentId]), [
    ['logo.png', 'image/png', true, 'logo@x'],
    [input.attachments[0].filename, 'application/pdf', false, null],
    ['notas.txt', 'text/plain', false, null],
  ]);
  assert.ok(m.attachments[0].content.equals(png));
  assert.ok(m.attachments[1].content.equals(bin));
  assert.equal(m.attachments[2].content.toString(), 'texto do anexo');

  // sem anexos e só texto: parte única, Message-ID gerado
  const simples = buildMessage({ from: 'a@x.com', to: 'b@x.com', subject: 'Oi', text: 'só texto' });
  assert.match(simples, /^Content-Type: text\/plain; charset=utf-8$/m);
  assert.doesNotMatch(simples, /multipart/);
  const p = parseMessage(simples);
  assert.match(p.messageId, /^[^<>@]+@[^<>@]+$/);
  assert.equal(p.text, 'só texto\n');
});
