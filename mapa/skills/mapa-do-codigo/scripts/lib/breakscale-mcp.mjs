// Cliente MCP mínimo para conversar com o servidor do Breakscale: pelo stdio (o pacote rodando neste
// computador) ou pelo HTTP (o servidor hospedado em mcp.breakscale.tech). Só o necessário para
// initialize e tools/call, sem dependências.
import { spawn } from 'node:child_process';

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'mapa-do-codigo', version: '1.0.0' };

function toolText(result, name) {
  const text = (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (result?.isError) throw Object.assign(new Error(`O Breakscale recusou o ${name}:\n${text}`), { code: 'tool_error' });
  return text;
}

/** O pacote do Breakscale rodando neste computador, falando JSON-RPC linha a linha pelo stdio. */
export async function stdioClient(command, { timeoutMs = 180000, env = process.env } = {}) {
  const [cmd, ...args] = command;
  // Sem shell, como todo programa que o plugin inicia. No Windows o npx é um .cmd, que o Node não roda
  // sem shell: lá, aponte MAPA_BREAKSCALE_CMD para o node e o npx-cli.js, ou use --remoto.
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  let buf = '';
  let stderr = '';
  let nextId = 0;
  let dead = null;
  const waiting = new Map();
  const failAll = (err) => { dead = err; for (const { reject } of waiting.values()) reject(err); waiting.clear(); };
  child.on('error', (e) => failAll(Object.assign(new Error(`Não deu para iniciar ${cmd}: ${e.message}.${process.platform === 'win32' ? ' No Windows, defina MAPA_BREAKSCALE_CMD (lista JSON com o node e o caminho do npx-cli.js) ou use --remoto.' : ' O npx vem com o Node; confira se o Node está instalado.'}`), { code: 'spawn' })));
  child.on('exit', (code) => failAll(new Error(`O servidor do Breakscale terminou (código ${code}).${stderr.trim() ? `\n${stderr.trim().slice(-600)}` : ''}`)));
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const w = msg.id != null && waiting.get(msg.id);
      if (!w) continue;
      waiting.delete(msg.id);
      if (msg.error) w.reject(new Error(`Breakscale: ${msg.error.message || JSON.stringify(msg.error)}`));
      else w.resolve(msg.result);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (dead) return reject(dead);
    const id = ++nextId;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`O Breakscale não respondeu ${method} em ${Math.round(timeoutMs / 1000)}s.`)); }, timeoutMs);
    waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT });
  } catch (e) {
    child.kill();
    throw e;
  }
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  return {
    call: async (name, args) => toolText(await request('tools/call', { name, arguments: args }), name),
    close: () => { child.removeAllListeners('exit'); child.kill(); },
  };
}

/** O servidor hospedado (Streamable HTTP). O projeto simulado sai deste computador. */
export async function httpClient(url, { timeoutMs = 60000 } = {}) {
  let session = null;
  let protocol = PROTOCOL;
  let nextId = 0;
  const post = async (body) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': protocol,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    session = res.headers.get('mcp-session-id') || session;
    const text = await res.text();
    if (!res.ok) throw new Error(`O Breakscale respondeu ${res.status}: ${text.slice(0, 300)}`);
    if (body.id == null || !text.trim()) return null;
    let msg = null;
    if ((res.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const block of text.split(/\r?\n\r?\n/)) {
        const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { const m = JSON.parse(data); if (m.id === body.id) msg = m; } catch {}
      }
    } else msg = JSON.parse(text);
    if (!msg) throw new Error('O Breakscale não mandou a resposta esperada.');
    if (msg.error) throw new Error(`Breakscale: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  };
  const init = await post({ jsonrpc: '2.0', id: ++nextId, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT } });
  protocol = init?.protocolVersion || PROTOCOL;
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    call: async (name, args) => toolText(await post({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name, arguments: args } }), name),
    close: () => {
      if (session) fetch(url, { method: 'DELETE', headers: { 'mcp-session-id': session, 'mcp-protocol-version': protocol }, signal: AbortSignal.timeout(5000) }).catch(() => {});
    },
  };
}
