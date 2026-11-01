// O que o Mapa do código lê dos arquivos de código: imports, endpoints, requisições web e comentários de documentação.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const { extract, flattenTemplates, cleanDoc } = await lib('extract.mjs');
const routes = (src, lang, file) => extract(src, lang, file).routes.map((r) => `${r.method} ${r.path}`);

test('JavaScript: imports e endpoints do Express', () => {
  const r = extract([
    `import express from 'express';`,
    `import { db, cache as c } from './db.js';`,
    `const router = express.Router();`,
    `router.get('/orders', list);`,
    `router.post('/orders/:id/refund', refund);`,
  ].join('\n'), 'javascript', 'api/orders.js');
  assert.deepEqual(r.imports.map((i) => i.spec), ['express', './db.js']);
  assert.deepEqual(r.imports[1].names, ['db', 'cache']);
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /orders', 'POST /orders/:id/refund']);
  assert.equal(r.routes[0].var, 'router');
});

test('App router do Next.js: cada método exportado é um endpoint no caminho da pasta', () => {
  assert.deepEqual(
    routes(`export async function GET(req) { return Response.json([]) }\nexport async function POST(req) {}\n`, 'typescript', 'web/app/api/orders/route.ts'),
    ['GET /api/orders', 'POST /api/orders'],
  );
});

test('Flask: prefixo do blueprint, lista de métodos e docstring do handler', () => {
  const r = extract([
    `"""Order endpoints."""`,
    `from flask import Blueprint`,
    `bp = Blueprint('orders', __name__, url_prefix='/api')`,
    ``,
    `@bp.route('/orders', methods=['GET', 'POST'])`,
    `def list_orders():`,
    `    """List them."""`,
    `    return []`,
  ].join('\n'), 'python', 'api/orders.py');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /orders', 'POST /orders']);
  assert.equal(r.routes[0].handler, 'list_orders');
  assert.equal(r.routes[0].doc, 'List them.');
  assert.deepEqual(r.routers, { bp: '/api' });
  assert.equal(r.doc, 'Order endpoints.');
});

test('FastAPI: prefixo do router e parâmetros no caminho', () => {
  const r = extract([
    `from fastapi import APIRouter`,
    `router = APIRouter(prefix="/items")`,
    `@router.get("/{item_id}")`,
    `async def read_item(item_id: int):`,
    `    return {}`,
  ].join('\n'), 'python', 'api/items.py');
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['GET /{item_id}']);
  assert.equal(r.routes[0].handler, 'read_item');
  assert.deepEqual(r.routers, { router: '/items' });
});

test('Go: imports agrupados e endpoints com http.HandleFunc', () => {
  const r = extract(`package main\nimport (\n  "net/http"\n  "example.com/app/store"\n)\nfunc main() { http.HandleFunc("/health", h) }\n`, 'go', 'cmd/main.go');
  assert.deepEqual(r.imports.map((i) => i.spec), ['net/http', 'example.com/app/store']);
  assert.deepEqual(r.routes.map((x) => `${x.method} ${x.path}`), ['ANY /health']);
});

test('requisições web: fetch com template strings e axios com um método', () => {
  const r = extract([
    'export const load = (id) => fetch(`/api/orders/${id}`);',
    `export const pay = (id) => axios.post('/api/orders/' + id + '/pay');`,
  ].join('\n'), 'typescript', 'web/src/api.ts');
  const calls = r.calls.map((c) => `${c.method || '*'} ${c.path}`);
  assert.ok(calls.includes('* /api/orders/${x}'), calls.join(', '));
  assert.ok(calls.includes('POST /api/orders/'), calls.join(', '));
});

test('flattenTemplates troca todo ${…} por um marcador, aninhado ou não', () => {
  assert.equal(flattenTemplates('fetch(`${API}/users/${id}`)'), 'fetch(`${x}/users/${x}`)');
});

test('comentários de documentação: o JSDoc é limpo e os cabeçalhos de licença são ignorados', () => {
  assert.equal(cleanDoc('/**\n * Lists orders.\n * @param x\n */'), 'Lists orders.');
  assert.equal(cleanDoc('# Copyright 2020 Example Corp'), null);
});
