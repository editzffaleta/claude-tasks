#!/usr/bin/env node
// Um servidor MCP falso do Breakscale para os testes: fala JSON-RPC pelo stdio (ou responde por HTTP, com
// handleHttp) e devolve o create_view no mesmo formato de texto do breakscale-mcp 0.1.x, com números de
// uma conta simples de fila. Não é o simulador de verdade; só serve para testar a leitura e o caminho todo.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEFAULTS = { client: [1, 0], lb: [256, 0.5], service: [8, 25], cache: [32, 3], db: [6, 12], queue: [64, 1], worker: [4, 50] };
const KINDS = ['client', 'lb', 'service', 'cache', 'db', 'queue', 'worker', 'replica', 'shard', 'apigateway', 'objectstore'];

const r1 = (v) => (v >= 100 ? `${Math.round(v)}/s` : `${v.toFixed(1)}/s`);
const pct = (v) => `${(v * 100).toFixed(v > 0 && v < 0.01 ? 2 : 1)}%`;
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

export function simulate(design) {
  const bad = (design.nodes || []).filter((n) => !KINDS.includes(n.kind));
  if (bad.length) return { error: bad.map((n) => `node '${n.id}' has kind ${JSON.stringify(n.kind)}, which is not a component.`) };
  const nodes = new Map(design.nodes.map((n) => [n.id, n]));
  const out = new Map(design.nodes.map((n) => [n.id, []]));
  for (const e of design.edges || []) out.get(e.from)?.push(e.to);
  const arrival = new Map(design.nodes.map((n) => [n.id, 0]));
  const order = [];
  const visit = (id, rate, depth = 0) => {
    if (depth > 20) return;
    arrival.set(id, arrival.get(id) + rate);
    if (!order.includes(id)) order.push(id);
    const n = nodes.get(id);
    const [cap, svc] = DEFAULTS[n.kind] || [8, 25];
    const capacity = (n.config?.capacity ?? cap) * (n.config?.instances ?? 1);
    const max = n.kind === 'client' ? Infinity : svc ? (capacity * 1000) / (n.config?.serviceMs ?? svc) : Infinity;
    const passed = Math.min(rate, max) * (n.kind === 'cache' ? 0.2 : 1);
    const kids = out.get(id);
    for (const k of kids) visit(k, n.kind === 'lb' ? passed / kids.length : passed, depth + 1);
  };
  for (const n of design.nodes.filter((x) => x.kind === 'client')) visit(n.id, n.config?.rps ?? 50);
  const rows = [];
  let offered = 0;
  let worst = 0;
  for (const id of order) {
    const n = nodes.get(id);
    const a = arrival.get(id);
    if (n.kind === 'client') { offered += a; continue; }
    const [cap, svc] = DEFAULTS[n.kind] || [8, 25];
    const capacity = (n.config?.capacity ?? cap) * (n.config?.instances ?? 1);
    const max = (capacity * 1000) / (n.config?.serviceMs ?? svc);
    const util = Math.min(a / max, 1);
    const done = Math.min(a, max);
    const failed = a > 0 ? (a - done) / a : 0;
    worst = Math.max(worst, failed);
    rows.push({ n, a, done, util, failed, away: a - done });
  }
  const p50 = 20 + worst * 400;
  const lines = [
    'Simulated 30s with seed 1.',
    `Offered ${r1(offered)}, served ${r1(offered * (1 - worst))}, ${pct(worst)} failed. Latency p50 ${ms(p50)}, p95 ${ms(p50 * 3)}, p99 ${ms(p50 * 9)}.`,
  ];
  if (worst > 0) lines.push(`Failed requests over the run: ${Math.round(offered * worst * 30)} were turned away by a full queue; 3 timed out.`);
  rows.sort((x, y) => y.util - x.util);
  lines.push('', 'Components (busiest first):');
  for (const r of rows) {
    const parts = [`${r1(r.a)} in, ${r1(r.done)} done`];
    if (r.util > 0) parts.push(`${pct(r.util)} busy`);
    if (r.failed > 0) parts.push('48 waiting');
    if (r.done > 0) parts.push(`p99 ${ms(p50 * 4)}`);
    if (r.failed > 0) parts.push(`${pct(r.failed)} failed`, `${r1(r.away)} turned away`);
    if (r.n.kind === 'cache') parts.push('hit rate 80.0%');
    lines.push(`- ${r.n.label ?? r.n.id} (${r.n.kind}, id '${r.n.id}'): ${parts.join(', ')}`);
  }
  const link = `https://breakscale.tech/#d3.${Buffer.from(JSON.stringify({ n: design.nodes.length })).toString('base64url')}`;
  lines.push('', `Link to the design, which opens it on breakscale.tech: ${link}`, '', 'A changed design can be shown by passing the whole updated design to create_view.');
  return { text: lines.join('\n') };
}

export function handle(msg) {
  if (msg.method === 'initialize') return { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Breakscale', version: '0.1.0' } };
  if (msg.method !== 'tools/call') return {};
  const { name, arguments: design } = msg.params;
  if (name === 'create_view') {
    const r = simulate(design);
    if (r.error) return { content: [{ type: 'text', text: `The design was not accepted:\n${r.error.map((e) => `- ${e}`).join('\n')}` }], isError: true };
    return { content: [{ type: 'text', text: r.text }] };
  }
  if (name === 'export_design') {
    const topology = { nodes: design.nodes.map((n, i) => ({ ...n, label: n.label ?? n.id, x: i * 264, y: 40, config: n.config ?? {} })), edges: design.edges };
    return { content: [{ type: 'text', text: JSON.stringify({ app: 'breakscale', version: 1, savedAt: '2026-11-01T00:00:00.000Z', name: design.name, topology }, null, 2) }] };
  }
  return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
}

/** Responde como o servidor hospedado (Streamable HTTP): JSON no initialize, SSE nas ferramentas. */
export function startHttp() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    if (req.method === 'DELETE') { res.writeHead(200); return res.end(); }
    const msg = JSON.parse(body);
    calls.push({ method: msg.method, session: req.headers['mcp-session-id'] || null, accept: req.headers.accept });
    if (msg.id == null) { res.writeHead(202); return res.end(); }
    const reply = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: handle(msg) });
    if (msg.method === 'initialize') {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sessao-teste' });
      return res.end(reply);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`event: message\ndata: ${reply}\n\n`);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}/mcp` })));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  let buf = '';
  process.stdin.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id == null) continue;
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: handle(msg) })}\n`);
    }
  });
}
