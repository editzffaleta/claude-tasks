// As pequenas funções em que todo o resto se apoia: globs de arquitetura.json, classificação de arquivos,
// opções de linha de comando, nomes provisórios e comparação de caminhos de endpoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const { compileGlob, classify, parseArgs } = await lib('common.mjs');
const { humanize, fallbackFileName, fallbackRouteName } = await lib('names.mjs');
const { routeSegments } = await lib('routes.mjs');

test('globs: ** atravessa pastas, * fica numa só, chaves e pastas sem curinga funcionam', () => {
  const g = (glob, p) => compileGlob(glob).test(p);
  assert.ok(g('src/**/*.ts', 'src/a/b.ts'));
  assert.ok(g('src/**/*.ts', 'src/b.ts'));
  assert.ok(!g('src/*.ts', 'src/a/b.ts'));
  assert.ok(g('src/{a,b}', 'src/b/z.js'), 'uma pasta entre chaves pega tudo o que está dentro dela');
  assert.ok(g('src/components', 'src/components/x/y.tsx'), 'uma pasta simples pega tudo o que está dentro dela');
  assert.ok(!g('src/components', 'src/components-old/y.tsx'));
  assert.ok(g('**/*.test.ts', 'x.test.ts'));
  assert.ok(g('./src/', 'src/a.ts'), 'o ./ no começo e a / no fim são ignorados');
});

test('globs: um nome de pasta entre colchetes ([id], [...slug]) é uma pasta, não uma classe de caracteres', () => {
  const g = (glob, p) => compileGlob(glob).test(p);
  assert.ok(g('app/orders/[id]/**', 'app/orders/[id]/page.tsx'));
  assert.ok(!g('app/orders/[id]/**', 'app/orders/i/page.tsx'));
  assert.ok(g('app/[...slug]', 'app/[...slug]/page.tsx'));
  assert.ok(g('app/[[...slug]]/page.tsx', 'app/[[...slug]]/page.tsx'));
  assert.ok(g('src/file[12].ts', 'src/file2.ts'), 'dentro de um nome, colchetes ainda pegam um caractere');
});

test('globs: um padrão mais específico ganha pontuação maior', () => {
  assert.ok(compileGlob('api/routes/**').specificity > compileGlob('api/**').specificity);
});

test('classify: código, documentação, arquivos de lock, assets e arquivos gerados', () => {
  assert.deepEqual(classify('src/a.ts', 100), { category: 'code', lang: 'typescript' });
  assert.deepEqual(classify('app/main.py', 100), { category: 'code', lang: 'python' });
  assert.equal(classify('README.md', 10).category, 'docs');
  assert.equal(classify('package-lock.json', 10).category, 'lock');
  assert.equal(classify('logo.png', 10).category, 'asset');
  assert.equal(classify('dist/app.min.js', 10).category, 'generated');
});

test('parseArgs: posicionais, --opção valor, --opção=valor e opções sem valor', () => {
  assert.deepEqual(parseArgs(['root', '--port', '9', '--no-open', '--x=1']), { _: ['root'], port: '9', 'no-open': true, x: '1' });
});

test('os nomes provisórios parecem palavras comuns, com o papel do arquivo em português', () => {
  assert.equal(humanize('order_service'), 'Order service');
  assert.equal(humanize('OrderService'), 'Order service');
  assert.equal(fallbackFileName('api/routes/order_service.py'), 'Order service');
  assert.equal(fallbackFileName('web/app/checkout/page.tsx'), 'Página de checkout');
  assert.equal(fallbackFileName('web/app/orders/layout.tsx'), 'Layout de orders');
  assert.equal(fallbackFileName('api/reports/__init__.py'), 'Pacote reports');
  assert.equal(fallbackFileName('web/src/checkout/index.ts'), 'Checkout');
  assert.equal(fallbackFileName('tests/test_orders.py'), 'Testes de orders');
  assert.equal(fallbackRouteName({ method: 'POST', path: '/orders/:id/refund' }), 'Criar orders refund');
  assert.equal(fallbackRouteName({ method: 'GET', path: '/api/reports' }), 'Buscar api reports');
  assert.equal(fallbackRouteName({ method: 'DELETE', path: '/' }), 'Excluir raiz');
  assert.equal(fallbackRouteName({ method: 'POST', path: '/x', handler: 'approveItem' }), 'Approve item');
});

test('caminhos de endpoints: parâmetros no estilo de qualquer framework pegam qualquer valor', () => {
  assert.deepEqual(routeSegments('/orders/:id/refund'), ['orders', '*', 'refund']);
  assert.deepEqual(routeSegments('/orders/{id}'), ['orders', '*']);
});
