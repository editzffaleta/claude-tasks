// Um alarme para o que o plugin pode fazer no computador de alguém. A promessa: nenhum hook, nenhum servidor
// MCP, nenhuma dependência nem passo de instalação, nada baixado ou executado da internet, nenhum pedido para
// fora deste computador (o Floorplan Cloud foi retirado), uma lista fixa de programas que ele executa, e
// arquivos de terceiros iguais às versões publicadas. Estes testes falham se algo disso mudar, para uma mudança
// assim não passar despercebida. Se for de propósito, atualize este arquivo e o mapa/AVISO.md juntos.
//
// A única exceção é a simulação no Breakscale (scripts/breakscale.mjs), que só roda quando a pessoa pede e
// fica fora da lista de comandos pré-aprovados, para ser aprovada a cada vez: ela roda o simulador pelo npx,
// numa versão fixa do pacote breakscale-mcp, ou, só com --remoto, manda o modelo ao servidor do Breakscale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO, SKILL } from './helpers.mjs';

// REPO é a pasta do plugin (mapa/); o repositório do quadro, com os marketplaces, fica um nível acima
const BOARD_REPO = path.resolve(REPO, '..');
/** Caminhos relativos de cada arquivo dentro de dir, com barras normais, sem a pasta do git e instalações. */
const allFiles = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)).replace(/\\/g, '/'))
  .filter((f) => !/^(\.git|node_modules)\//.test(f));
const UPDATE = 'Se for de propósito, atualize mapa/test/supply-chain.test.mjs e mapa/AVISO.md juntos.';
const rel = (f) => path.relative(SKILL, f).replace(/\\/g, '/');
const read = (f) => fs.readFileSync(f, 'utf8');
const json = (base, p) => JSON.parse(read(path.join(base, p)));
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const shipped = allFiles(SKILL).map((f) => path.join(SKILL, f));
const isVendor = (f) => rel(f).startsWith('assets/vendor/');
// o código que roda: scripts, o servidor do mapa, a página e os complementos dela (não o motor de layout de terceiros)
const code = shipped.filter((f) => /\.(mjs|js|html)$/.test(f) && !isVendor(f));
/** Cada ocorrência de `re` no código distribuído, como { file, text, line }, pulando linhas de comentário. */
function find(re) {
  const out = [];
  for (const f of code) {
    read(f).split('\n').forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      for (const m of line.matchAll(new RegExp(re, 'g'))) out.push({ file: rel(f), text: m[0], line: i + 1, m });
    });
  }
  return out;
}

test('o plugin é só uma skill: nenhum hook, servidor MCP ou comando que rode sozinho', () => {
  const all = allFiles(REPO);
  assert.deepEqual(all.filter((f) => /(^|\/)(hooks\.json|\.mcp\.json|\.lsp\.json)$/.test(f) || /(^|\/)hooks\//.test(f)), [], `nenhum hook nem servidor MCP/LSP. ${UPDATE}`);
  assert.deepEqual(Object.keys(json(REPO, '.claude-plugin/plugin.json')).sort(), ['author', 'description', 'keywords', 'license', 'name', 'version'], `manifesto do Claude Code: nada além da skill. ${UPDATE}`);
  assert.deepEqual(Object.keys(json(REPO, '.codex-plugin/plugin.json')).sort(), ['author', 'description', 'interface', 'keywords', 'license', 'name', 'requires_local_executor', 'skills', 'version'], `manifesto do Codex: nada além da skill. ${UPDATE}`);
  assert.equal(json(REPO, '.codex-plugin/plugin.json').skills, './skills/');
  // os dois marketplaces instalam a partir deste repositório, da pasta mapa/, nunca de outro lugar
  assert.deepEqual(json(BOARD_REPO, '.claude-plugin/marketplace.json').plugins.map((p) => p.source), ['./mapa']);
  for (const p of json(BOARD_REPO, '.agents/plugins/marketplace.json').plugins) assert.equal(typeof p.source === 'string' ? p.source : p.source?.path, './mapa', `marketplace do Codex. ${UPDATE}`);
});

test('nada para instalar: nenhuma dependência, nenhum script de instalação, só módulos do Node e arquivos próprios', () => {
  const all = allFiles(REPO);
  assert.ok(!all.some((f) => /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f) && !f.startsWith('test/fixtures/')), `nenhum package.json nem lockfile no plugin. ${UPDATE}`);
  // cada import do código distribuído é um módulo do Node (node:…) ou um arquivo da própria skill
  const specs = find(/^\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]/).map((x) => ({ ...x, spec: x.m[1] }));
  assert.ok(specs.length > 20, 'achou os imports');
  assert.deepEqual(specs.filter((s) => !/^node:|^\.\.?\//.test(s.spec)).map((s) => `${s.file}: ${s.spec}`), [], `imports de pacotes de fora. ${UPDATE}`);
});

test('os únicos comandos pré-aprovados são os scripts da própria skill, e a lista é fixa', () => {
  const front = /^---\n([\s\S]*?)\n---/.exec(read(path.join(SKILL, 'SKILL.md')).replace(/\r\n/g, '\n'))[1];
  // cada script roda sem pedir permissão enquanto a skill está em uso, então acrescentar um é uma mudança deliberada
  const SCRIPTS = ['build.mjs', 'describe.mjs', 'open.mjs', 'plan.mjs', 'recent.mjs', 'refresh.mjs', 'scan.mjs', 'status.mjs'];
  const granted = /^allowed-tools:\n((?: {2}- .*\n?)+)/m.exec(front + '\n')?.[1].trim().split('\n').map((l) => l.replace(/^\s*- /, '').trim());
  assert.deepEqual(granted, SCRIPTS.map((s) => `Bash(node \${CLAUDE_SKILL_DIR}/scripts/${s} *)`), `allowed-tools do SKILL.md: exatamente os scripts da skill. ${UPDATE}`);
  const scripts = fs.readdirSync(path.join(SKILL, 'scripts')).filter((n) => !fs.statSync(path.join(SKILL, 'scripts', n)).isDirectory()).sort();
  // breakscale.mjs baixa e roda o simulador do Breakscale (ou fala com o servidor dele): existe, mas de
  // propósito não é pré-aprovado, para a pessoa ver e aprovar o comando cada vez que ele roda
  assert.deepEqual(scripts, [...SCRIPTS, 'breakscale.mjs'].sort(), `lista de scripts/. ${UPDATE}`);
  assert.doesNotMatch(front, /breakscale/, 'a simulação no Breakscale nunca é pré-aprovada');
});

test('nenhum pedido sai deste computador', () => {
  // nenhum módulo de rede, a não ser o do servidor local do mapa
  const netImports = find(/from\s+['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]|require\(\s*['"](?:node:)?(https?|http2|net|tls|dgram|dns|undici)['"]\s*\)/);
  assert.deepEqual(netImports.map((x) => `${x.file}: ${x.text}`), [`assets/servidor.mjs: from 'node:http'`], `módulos de rede. ${UPDATE}`);
  // o servidor escuta só nesta máquina, e o núcleo não escuta em nada (quem o monta escolhe)
  assert.match(read(path.join(SKILL, 'assets', 'servidor.mjs')), /server\.listen\(port, '127\.0\.0\.1'\);/);
  assert.doesNotMatch(read(path.join(SKILL, 'assets', 'servidor.mjs')), /\.listen\([^)]*(0\.0\.0\.0|::)/);
  assert.doesNotMatch(read(path.join(SKILL, 'assets', 'servidor-nucleo.mjs')), /\.listen\(/);

  // todo pedido vai para o próprio servidor do mapa: caminhos relativos à página ou o endereço local salvo
  const LOCAL = /^(['"`](\/|\.\/|api\/)|s\.url \+)/;
  const calls = find(/\bfetch\(\s*([^,)]+)/).map((x) => ({ ...x, arg: x.m[1].trim() }));
  // a exceção: o cliente HTTP da simulação no Breakscale, usado só com --remoto
  const outside = calls.filter((c) => !LOCAL.test(c.arg)).map((c) => `${c.file}: fetch(${c.arg}`);
  assert.deepEqual(outside, ['scripts/lib/breakscale-mcp.mjs: fetch(url', 'scripts/lib/breakscale-mcp.mjs: fetch(url'], `pedidos que saem deste computador. ${UPDATE}`);
  assert.match(read(path.join(SKILL, 'scripts', 'lib', 'breakscale.mjs')), /export const REMOTE_URL = 'https:\/\/mcp\.breakscale\.tech\/mcp';/);
  const sim = read(path.join(SKILL, 'scripts', 'breakscale.mjs'));
  assert.equal([...sim.matchAll(/httpClient\(/g)].length, 1, 'um só lugar fala com o servidor do Breakscale');
  assert.match(sim, /const remote = !!args\.remoto;[\s\S]*if \(remote\) client = await httpClient\(/, 'e só com --remoto');
  assert.deepEqual(find(/\b(WebSocket|XMLHttpRequest|sendBeacon|importScripts)\b/).map((x) => `${x.file}: ${x.text}`), [], `outros jeitos de falar com um servidor. ${UPDATE}`);
  assert.deepEqual(find(/new EventSource\(\s*(?!['"`](\/|api\/))/).map((x) => `${x.file}:${x.line}`), [], 'a recarga ao vivo só vem do servidor local');

  // o Floorplan Cloud (lista de espera) foi retirado por inteiro
  const cloud = shipped.filter((f) => !isVendor(f) && /\.(mjs|js|html|md|json|yaml)$/.test(f))
    .flatMap((f) => [...read(f).matchAll(/api\/cloud\/|joinWaitlist|claudeEmail|WAITLIST_URL|floorplan-waitlist|Floorplan Cloud|FLOORPLAN_NO_PROMPTS/g)].map((m) => `${rel(f)}: ${m[0]}`));
  assert.deepEqual(cloud, [], 'nada do Floorplan Cloud');
  assert.ok(!shipped.some((f) => /(^|\/)ui\/\d+-cloud\.js$/.test(rel(f))), 'sem o complemento da lista de espera');

  // a página do mapa não carrega nada da internet: o motor de layout e as fontes vêm embutidos
  const page = read(path.join(SKILL, 'assets', 'viewer.html'));
  assert.doesNotMatch(page, /<script[^>]*\ssrc=/i, 'nenhum script de fora');
  assert.doesNotMatch(page, /<link[^>]*href=["']https?:/i, 'nenhuma folha de estilo ou fonte de fora');
  assert.doesNotMatch(page, /url\(\s*["']?https?:/i, 'nenhuma imagem ou fonte de fora no CSS');
});

test('a página chama a API por caminhos relativos, para funcionar em / e montada pelo quadro em /mapa/<projeto>/', () => {
  const page = code.filter((f) => /^assets\/(viewer\.html|ui\/)/.test(rel(f)));
  const absolute = page.flatMap((f) => read(f).split('\n').map((l, i) => [l, i + 1]).filter(([l]) => /(fetch|EventSource)\(\s*['"`]\/api\//.test(l)).map(([, n]) => `${rel(f)}:${n}`));
  assert.deepEqual(absolute, [], 'use api/… em vez de /api/…');
});

test('executa uma lista fixa de programas, e nunca por um shell', () => {
  const importers = find(/from\s+['"](?:node:)?child_process['"]/).map((x) => x.file).sort();
  assert.deepEqual(importers, ['assets/servidor-nucleo.mjs', 'assets/servidor.mjs', 'scripts/lib/breakscale-mcp.mjs', 'scripts/lib/common.mjs', 'scripts/open.mjs', 'scripts/refresh.mjs'], `arquivos que iniciam programas. ${UPDATE}`);
  // o simulador do Breakscale roda numa versão fixa do pacote, nunca na mais nova que estiver no npm
  assert.match(read(path.join(SKILL, 'scripts', 'lib', 'breakscale.mjs')), /export const BREAKSCALE_PACKAGE = 'breakscale-mcp@\d+\.\d+\.\d+';\nexport const LOCAL_COMMAND = \['npx', '-y', BREAKSCALE_PACKAGE, '--stdio'\];/);
  // só spawn e execFileSync, que recebem um programa e seus argumentos (o .exec() de regex é só texto)
  const names = find(/import\s*\{([^}]*)\}\s*from\s+['"](?:node:)?child_process['"]/).flatMap((x) => x.m[1].split(',').map((n) => n.trim()));
  assert.deepEqual([...new Set(names)].sort(), ['execFileSync', 'spawn'], `funções de child_process usadas. ${UPDATE}`);
  assert.deepEqual(find(/(?<![.\w])(exec|execSync|fork|spawnSync|execFile)\(/).map((x) => `${x.file}:${x.line} ${x.text}`), [], `outros jeitos de iniciar programas. ${UPDATE}`);
  assert.deepEqual(find(/shell:\s*true/).map((x) => `${x.file}:${x.line}`), [], 'nunca por um shell');
  // o que cada chamada inicia: where/which, a CLI do Claude Code ou do Codex, o Node rodando os scripts da
  // própria skill, o git, e o comando do sistema que abre um endereço no navegador
  const ALLOWED = new Set([
    "process.platform === 'win32' ? 'where' : 'which'",
    'cli.cmd',
    'process.execPath',
    'node',
    "'git'",
    'opener[0]',
    'cmd',
  ]);
  const starts = find(/\b(spawn|execFileSync)\(\s*([^,]+),/).map((x) => ({ ...x, prog: x.m[2].trim() }));
  assert.ok(starts.length >= 8, 'achou as chamadas');
  assert.deepEqual(starts.filter((s) => !ALLOWED.has(s.prog)).map((s) => `${s.file}:${s.line} ${s.prog}`), [], `programas iniciados. ${UPDATE}`);
  assert.match(read(path.join(SKILL, 'scripts', 'refresh.mjs')), /const node = process\.execPath;/);
  // os comandos que abrem o navegador abrem o endereço local do mapa e nada mais
  const openers = /\? \['cmd', \['\/c', 'start', '', u\]\] : process\.platform === 'darwin' \? \['open', \[u\]\] : \['xdg-open', \[u\]\]/;
  assert.match(read(path.join(SKILL, 'assets', 'servidor.mjs')), openers);
  assert.match(read(path.join(SKILL, 'scripts', 'open.mjs')), openers);
});

test('nenhum código é baixado, decodificado ou montado a partir de texto na hora de rodar', () => {
  assert.deepEqual(find(/(?<![.\w])eval\(/).map((x) => `${x.file}:${x.line}`), [], `eval. ${UPDATE}`);
  // a única exceção: o núcleo do servidor carrega o código de consulta do mapa. Sozinho, a partir de
  // mapa-do-codigo/consulta.mjs (um arquivo que o build gravou); dentro do quadro, o quadro passa o
  // código do próprio plugin (querySource), para não rodar um arquivo vindo da pasta de um projeto
  assert.deepEqual(find(/new Function\(/).map((x) => x.file), ['assets/servidor-nucleo.mjs'], `new Function. ${UPDATE}`);
  assert.match(read(path.join(SKILL, 'assets', 'servidor-nucleo.mjs')), /const coreSrc = \(querySource \?\? fs\.readFileSync\(file\(FILES\.query\), 'utf8'\)\)/);
  assert.match(read(path.join(SKILL, 'assets', 'servidor-nucleo.mjs')), /query: 'consulta\.mjs'/);
  assert.deepEqual(find(/\bimport\s*\(/).map((x) => `${x.file}:${x.line}`), [], `import dinâmico. ${UPDATE}`);
  assert.deepEqual(find(/from\s+['"](?:node:)?(vm|worker_threads|inspector|wasi)['"]|new Worker\(|WebAssembly\./).map((x) => `${x.file}: ${x.text}`), [], `outros jeitos de rodar código. ${UPDATE}`);
  // decodificar base64: só a Saúde lendo o meio de um token que achou, para saber que tipo de token é
  assert.deepEqual(find(/\batob\(|['"]base64['"]\s*\)/).filter((x) => x.file !== 'scripts/build.mjs').map((x) => x.file), ['scripts/lib/health.mjs'], `decodificação de base64. ${UPDATE}`);
  // nenhum texto longo e opaco que possa esconder uma carga (o build embute o logo e as fontes a partir de arquivos)
  assert.deepEqual(find(/[A-Za-z0-9+/=]{160,}/).map((x) => `${x.file}:${x.line}`), [], 'textos codificados longos');
});

test('cada arquivo distribuído é código, texto ou um tipo conhecido de imagem ou fonte', () => {
  const OK = ['.html', '.js', '.json', '.md', '.mjs', '.png', '.txt', '.woff2', '.yaml'];
  const kinds = new Set(allFiles(REPO).filter((f) => !f.startsWith('test/')).map((f) => path.extname(f).toLowerCase() || path.basename(f)));
  for (const k of kinds) assert.ok([...OK, 'LICENSE'].includes(k), `tipo de arquivo inesperado: ${k}. ${UPDATE}`);
});

test('a licença original e o aviso de origem acompanham o plugin', () => {
  const license = read(path.join(REPO, 'LICENSE'));
  assert.match(license, /^MIT License\n\nCopyright \(c\) 2026 Hayden Smith\n/);
  assert.match(license, /THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND/);
  const aviso = read(path.join(REPO, 'AVISO.md'));
  assert.match(aviso, /https:\/\/github\.com\/haydenschmitty\/floorplan/);
  assert.match(aviso, /EPL-2\.0/);
  assert.match(aviso, /OFL-1\.1/);
  for (const f of ['elkjs-LICENSE.md', 'fonts/inter-LICENSE.txt', 'fonts/jetbrains-mono-LICENSE.txt']) assert.ok(fs.existsSync(path.join(SKILL, 'assets', 'vendor', f)), f);
});

test('os arquivos de terceiros não mudaram: o motor de layout é igual ao elkjs 0.9.3 do npm, byte a byte', () => {
  const VENDOR = {
    // npm: elkjs@0.9.3, package/lib/elk.bundled.js
    'elk.bundled.js': 'b0745abd7f23cd91690a1587e377edbe19fd7233c783300290936720546216d4',
    'elkjs-LICENSE.md': null,
    'fonts/inter-LICENSE.txt': null,
    'fonts/inter-latin-ext-wght-normal.woff2': null,
    'fonts/inter-latin-wght-normal.woff2': null,
    'fonts/jetbrains-mono-LICENSE.txt': null,
    'fonts/jetbrains-mono-latin-ext-wght-normal.woff2': null,
    'fonts/jetbrains-mono-latin-wght-normal.woff2': null,
  };
  const dir = path.join(SKILL, 'assets', 'vendor');
  assert.deepEqual(allFiles(dir).sort(), Object.keys(VENDOR).sort(), `arquivos de terceiros. ${UPDATE}`);
  assert.equal(sha256(path.join(dir, 'elk.bundled.js')), VENDOR['elk.bundled.js'], `o elk.bundled.js mudou. ${UPDATE}`);
});
