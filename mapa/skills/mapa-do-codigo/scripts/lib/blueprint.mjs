// Plantas: o mapa de um sistema que ainda não foi construído, planejado a partir de um PRD ou de uma descrição.
//
// planToScan(plan, root) — transforma mapa-do-codigo/plano.json (os arquivos, endpoints e chamadas planejados,
//                          escritos pelo agente) no mesmo formato de scan.json que o scan.mjs grava para código
//                          de verdade, então o build.mjs e o visualizador funcionam sem mudança.
//                          Devolve { scan, errors, warnings }.
// buildPlanHealth(ctx)   — chamado pelo build.mjs no lugar do buildHealth numa planta: uma revisão do plano
//                          (quem pode chamar cada endpoint, pontas soltas, perguntas em aberto) no mesmo
//                          formato { summary, issues }, para o painel Saúde mostrar.

import path from 'node:path';
import { classify, toPosix, MAP_DIR, MAP_FILES } from './common.mjs';
import { matchCalls } from './routes.mjs';

// quem pode usar um endpoint. "team" são as pessoas que operam o serviço (as páginas de administração dele), não os usuários do app.
export const ACCESS = ['public', 'signed-in', 'team', 'webhook', 'internal'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'CALL', 'ANY'];
const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE', 'CALL']);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const strArr = (v) => (Array.isArray(v) ? v.filter(isStr) : []);
const routeKey = (m, p) => `${m} ${p}`;

/** "POST /api/orders" -> { method, path }, or null. */
export function parseCall(s) {
  const m = /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(String(s || ''));
  return m && METHODS.includes(m[1].toUpperCase()) ? { method: m[1].toUpperCase(), path: m[2] } : null;
}

export function planToScan(plan, root) {
  const errors = [], warnings = [];
  const err = (m) => errors.push(m), warn = (m) => warnings.push(m);
  if (!plan || typeof plan !== 'object') return { scan: null, errors: [`${MAP_FILES.plan} precisa ser um objeto`], warnings };
  const files = Array.isArray(plan.files) ? plan.files : [];
  const endpoints = Array.isArray(plan.endpoints) ? plan.endpoints : [];
  if (!files.length) err('files precisa ser uma lista não vazia com os arquivos que o sistema teria');

  const byPath = new Map();
  files.forEach((f, i) => {
    const where = `files[${i}]${f?.path ? ` ("${f.path}")` : ''}`;
    if (!isStr(f?.path)) return err(`${where}.path é obrigatório`);
    const p = toPosix(f.path.trim()).replace(/^\.\//, '');
    if (p.startsWith('/') || p.includes('..')) return err(`${where}.path precisa ser relativo à pasta do projeto`);
    if (byPath.has(p)) return err(`${where}.path repete um arquivo anterior`);
    if (!isStr(f.description)) warn(`${where} está sem description`);
    byPath.set(p, f);
  });
  const known = [...byPath.keys()];
  const near = (p) => { const base = p.split('/').pop(); const hit = known.find((k) => k.split('/').pop() === base); return hit ? ` (você quis dizer "${hit}"?)` : ''; };

  // endpoints, pela chave "MÉTODO /caminho"
  const routes = [], access = {}, seen = new Set();
  endpoints.forEach((e, i) => {
    const where = `endpoints[${i}]${e?.method && e?.path ? ` ("${e.method} ${e.path}")` : ''}`;
    const method = String(e?.method || '').toUpperCase();
    if (!METHODS.includes(method)) return err(`${where}.method precisa ser um destes: ${METHODS.join(', ')}`);
    if (!isStr(e.path) || !e.path.startsWith('/')) return err(`${where}.path precisa começar com "/"`);
    if (!isStr(e.file)) return err(`${where}.file é obrigatório: o arquivo planejado que atende esse endpoint`);
    const file = toPosix(e.file.trim()).replace(/^\.\//, '');
    if (!byPath.has(file)) return err(`${where}.file "${file}" não é um dos arquivos planejados${near(file)}`);
    const key = routeKey(method, e.path);
    if (seen.has(key)) return err(`${where} repete um endpoint anterior`);
    seen.add(key);
    if (e.access !== undefined && !ACCESS.includes(e.access)) err(`${where}.access "${e.access}" precisa ser um destes: ${ACCESS.join(', ')}${e.access === 'staff' ? ' ("team" é a sua própria equipe; para só alguns usuários do app, use "signed-in" com "who")' : ''}`);
    if (e.who !== undefined && !isStr(e.who)) err(`${where}.who precisa ser umas poucas palavras, por exemplo "gerentes daquela unidade"`);
    if (e.publicBecause !== undefined && !isStr(e.publicBecause)) err(`${where}.publicBecause precisa dizer por que ele fica aberto a qualquer pessoa`);
    if (ACCESS.includes(e.access)) access[key] = e.access;
    routes.push({ file, method, path: e.path, line: 0, ...(ACCESS.includes(e.access) ? { access: e.access } : {}), ...(isStr(e.who) ? { who: e.who.trim() } : {}), ...(isStr(e.publicBecause) ? { publicBecause: e.publicBecause.trim() } : {}), ...(isStr(e.name) ? { name: e.name.trim() } : {}), ...(isStr(e.description) ? { desc: e.description.trim() } : {}) });
  });
  const routeKeys = new Set(routes.map((r) => routeKey(r.method, r.path)));

  // imports, chamadas e ligações com serviços externos e bancos de dados
  const edges = [], nodeLinks = [], callFiles = [];
  for (const [p, f] of byPath) {
    for (const u of strArr(f.uses)) {
      const to = toPosix(u.trim()).replace(/^\.\//, '');
      if (!byPath.has(to)) { err(`files "${p}".uses "${u}" não é um dos arquivos planejados${near(to)}`); continue; }
      if (to !== p) edges.push({ from: p, to });
    }
    const calls = [];
    for (const c of strArr(f.calls)) {
      const pc = parseCall(c);
      if (!pc) { err(`files "${p}".calls "${c}" precisa estar no formato "POST /api/pedidos"`); continue; }
      if (!routeKeys.has(routeKey(pc.method, pc.path))) warn(`files "${p}".calls "${c}" não corresponde a nenhum endpoint planejado`);
      calls.push({ path: pc.path, method: pc.method, line: 0 });
    }
    if (calls.length) callFiles.push({ path: p, calls });
    for (const s of strArr(f.services)) nodeLinks.push({ from: p, to: s.trim(), kind: 'http' });
    for (const d of strArr(f.data)) nodeLinks.push({ from: p, to: d.trim(), kind: 'data' });
  }
  // uma chamada só chega ao endpoint planejado exato (método e caminho), nunca a um parecido
  const http = matchCalls(callFiles, routes).filter((h) => routeKeys.has(routeKey(h.method, h.path)) && h.call === h.path);

  const questions = [];
  (Array.isArray(plan.questions) ? plan.questions : []).forEach((q, i) => {
    const text = isStr(q) ? q : q?.question;
    if (!isStr(text)) return err(`questions[${i}] precisa de uma pergunta`);
    questions.push({ question: text.trim(), about: strArr(q?.about) });
  });

  const scan = {
    version: 1,
    blueprint: {
      source: isStr(plan.source) ? plan.source.trim() : '',
      stack: strArr(plan.stack),
      assumptions: strArr(plan.assumptions),
      questions,
      access,
    },
    generatedAt: new Date().toISOString(),
    root: toPosix(root),
    rootName: path.basename(root),
    repos: [],
    files: [...byPath].map(([p, f]) => {
      const c = classify(p, 0);
      return {
        path: p, repo: null, category: 'code', lang: c.lang || path.posix.extname(p).slice(1) || null, loc: 0, bytes: 0,
        ...(isStr(f.name) ? { name: f.name.trim() } : {}),
        ...(isStr(f.description) ? { desc: f.description.trim() } : {}),
        ...(isStr(f.screen) && f.screen.startsWith('/') ? { screens: [{ fw: 'plan', url: f.screen.trim() }] } : {}),
      };
    }),
    edges,
    externals: [],
    extEdges: [],
    routes,
    http,
    hosts: [],
    nodeLinks,
  };
  return { scan, errors, warnings };
}

/** A revisão do plano que aparece no painel Saúde de uma planta. */
export function buildPlanHealth({ graph, scan }) {
  const bp = scan.blueprint || {};
  const issues = [];
  const routes = graph.routes || [];
  const ridOf = new Map(routes.map((r, i) => [routeKey(r.m, r.p), 'r:' + i]));
  const fileIds = new Set(graph.files.map((f) => 'f:' + f.p));
  const nodeIds = new Set(graph.nodes.map((n) => 'n:' + n.id));
  const refOf = (s) => {
    if (!isStr(s)) return null;
    const t = s.trim();
    if (nodeIds.has('n:' + t)) return 'n:' + t;
    if (fileIds.has('f:' + t)) return 'f:' + t;
    const pc = parseCall(t);
    return pc ? ridOf.get(routeKey(pc.method, pc.path)) || null : null;
  };
  const line = (r) => `- ${r.m} ${r.p} (${r.f})${r.name ? ` — ${r.name}` : ''}`;
  const planRel = `${MAP_DIR}/${MAP_FILES.plan}`;
  const rebuild = 'Depois redesenhe a planta: rode plan.mjs e build.mjs da skill Mapa do código, como as instruções dela mandam.';
  // cada item também leva `change`: um pedido para resolvê-lo pelo mapa (o modo Mudar da barra de perguntas), para a pessoa completar ou editar
  const names = (xs, max = 6) => { const l = xs.slice(0, max).concat(xs.length > max ? [`mais ${xs.length - max}`] : []); return l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} e ${l.at(-1)}`; };
  const ep = (r) => `${r.m} ${r.p}`;

  // ---------- quem pode chamar cada endpoint ----------
  const accessOf = (r) => bp.access?.[routeKey(r.m, r.p)];
  // aberto de propósito, com um motivo (publicBecause), conta como revisado
  const openWrites = routes.map((r, i) => ({ r, i })).filter(({ r }) => accessOf(r) === 'public' && WRITE.has(r.m) && !r.publicBecause);
  if (openWrites.length) {
    const one = openWrites.length === 1;
    issues.push({
      id: 'plan-open-writes', kind: 'unprotected-endpoint', severity: 'medium',
      change: `Revise quem pode usar ${names(openWrites.map(({ r }) => ep(r)))}: hoje qualquer pessoa consegue alterar dados por ${one ? 'ele' : 'eles'}. `,
      title: one ? 'Qualquer pessoa poderia alterar dados por um endpoint planejado' : `Qualquer pessoa poderia alterar dados por ${openWrites.length} endpoints planejados`,
      detail: `O plano deixa ${one ? 'este endpoint' : 'estes endpoints'} criar, alterar ou apagar dados sem login. Isso faz sentido para coisas como cadastro ou compra sem conta, mas vale uma segunda olhada antes de construir: ${one ? 'ele é' : 'eles são'} o que um estranho tem mais facilidade para usar de forma indevida.`,
      items: openWrites.slice(0, 24).map(({ i }) => 'r:' + i),
      notes: Object.fromEntries(openWrites.slice(0, 24).map(({ i }) => ['r:' + i, 'Planejado como aberto a qualquer pessoa, e altera dados'])),
      locations: [],
      fix: [`Revisão do plano em ${planRel}: estes endpoints planejados alteram dados e estão marcados com "access": "public":`, ...openWrites.map(({ r }) => line(r)), ``, `Para cada um, me diga em palavras simples se um estranho deveria mesmo conseguir usá-lo. Onde não deveria, mude o access para "signed-in" (com "who" se só alguns usuários puderem) em ${MAP_FILES.plan}. Onde ele precisar continuar público (login, cadastro, compra sem conta), preencha "publicBecause" com o motivo, incluindo o que limita abusos (limite de tentativas, um CAPTCHA, confirmação por e-mail). Me pergunte se tiver dúvida.`, rebuild].join('\n'),
    });
  }
  const unknown = routes.map((r, i) => ({ r, i })).filter(({ r }) => !accessOf(r));
  if (unknown.length) issues.push({
    id: 'plan-no-access', kind: 'unprotected-endpoint', severity: 'medium',
    change: `Decida quem pode usar ${names(unknown.map(({ r }) => ep(r)))}, com base no PRD. `,
    title: unknown.length === 1 ? 'O plano não diz quem pode usar um endpoint' : `O plano não diz quem pode usar ${unknown.length} endpoints`,
    detail: 'Decidir agora quem pode usar cada parte do sistema (qualquer pessoa, clientes logados, só gerentes, a sua própria equipe, outro serviço) é muito mais fácil do que acrescentar verificações de login depois que ele estiver pronto.',
    items: unknown.slice(0, 24).map(({ i }) => 'r:' + i),
    notes: Object.fromEntries(unknown.slice(0, 24).map(({ i }) => ['r:' + i, 'Ainda não está decidido quem pode usar isto'])),
    locations: [],
    fix: [`Revisão do plano em ${planRel}: estes endpoints planejados estão sem "access":`, ...unknown.map(({ r }) => line(r)), ``, `Para cada um, escolha quem pode usá-lo: "public" (qualquer pessoa), "signed-in" (mais "who" quando só alguns usuários podem, como "gerentes daquela unidade"), "team" (só as pessoas que operam o serviço), "webhook" (o serviço de outra empresa, que precisa provar que é ele mesmo) ou "internal" (só os nossos próprios serviços). Baseie-se no PRD; me pergunte onde o PRD não disser.`, rebuild].join('\n'),
  });

  // ---------- perguntas em aberto do PRD ----------
  bp.questions?.forEach((q, k) => {
    const items = [...new Set(q.about.map(refOf).filter(Boolean))];
    issues.push({
      id: 'plan-question:' + k, kind: 'question', severity: 'medium',
      change: `Pergunta em aberto: "${q.question}" Minha resposta: `,
      title: q.question,
      detail: 'O PRD não responde isto, e a resposta muda o que vai ser construído. Decida antes de construir as partes que dependem disso.',
      items, notes: Object.fromEntries(items.map((id) => [id, 'Depende de uma pergunta em aberto'])),
      locations: [],
      fix: [`Pergunta em aberto na planta (${planRel}): ${q.question}`, ``, `Me explique as opções em palavras simples, com o que cada uma significaria para as partes envolvidas${q.about.length ? ` (${q.about.join(', ')})` : ''}, e recomende uma. Depois que eu decidir, atualize ${MAP_FILES.plan} e ${MAP_FILES.arch} de acordo e tire a pergunta da lista "questions" de ${MAP_FILES.plan}.`, rebuild].join('\n'),
    });
  });

  // ---------- pontas soltas ----------
  const called = new Set(graph.links.filter((l) => l.k === 'http' && l.calls).flatMap((l) => l.calls.map(([ri]) => ri)));
  const unusedRoutes = routes.map((r, i) => ({ r, i })).filter(({ r, i }) => !called.has(i) && !['webhook', 'internal', 'public'].includes(accessOf(r)));
  if (unusedRoutes.length) {
    const one = unusedRoutes.length === 1;
    issues.push({
      id: 'plan-unused-endpoints', kind: 'unused-file', severity: 'low',
      change: `Nada chama ${names(unusedRoutes.map(({ r }) => ep(r)))}. Acrescente a tela ou o serviço que deveria usar ${one ? 'esse endpoint' : 'esses endpoints'}, ou ${one ? 'remova-o se ele não for necessário' : 'remova-os se eles não forem necessários'}. `,
      title: one ? 'Nada no plano usa um endpoint' : `Nada no plano usa ${unusedRoutes.length} endpoints`,
      detail: `Nenhuma página ou serviço planejado chama ${one ? 'esse endpoint' : 'esses endpoints'}. Ou falta no plano uma tela que precisa ${one ? 'dele' : 'deles'}, ou ${one ? 'ele não é necessário' : 'eles não são necessários'}.`,
      items: unusedRoutes.slice(0, 24).map(({ i }) => 'r:' + i),
      notes: Object.fromEntries(unusedRoutes.slice(0, 24).map(({ i }) => ['r:' + i, 'Ninguém no plano chama este endpoint'])),
      locations: [],
      fix: [`Revisão do plano em ${planRel}: nada no plano chama estes endpoints:`, ...unusedRoutes.map(({ r }) => line(r)), ``, `Para cada um, descubra qual tela ou serviço planejado deveria chamá-lo e acrescente-o em "calls" desse arquivo, ou me diga que ele não é necessário e remova-o.`, rebuild].join('\n'),
    });
  }
  const linked = new Set();
  for (const l of graph.links) { linked.add(l.a); linked.add(l.b); }
  const screenFiles = new Set((graph.screens || []).map((s) => s.file));
  const routeFiles = new Set(routes.map((r) => r.f));
  const loose = graph.files.filter((f) => !linked.has('f:' + f.p) && !screenFiles.has(f.p) && !routeFiles.has(f.p));
  if (loose.length) {
    const one = loose.length === 1;
    issues.push({
      id: 'plan-loose-files', kind: 'unused-file', severity: 'low',
      change: `${names(loose.map((f) => f.p))} não ${one ? 'está ligado' : 'estão ligados'} a nada. Ligue ${one ? 'esse arquivo' : 'esses arquivos'} ao que deveria ${one ? 'usá-lo' : 'usá-los'}, ou ${one ? 'remova-o' : 'remova-os'}. `,
      title: one ? 'Um arquivo planejado não está ligado a nada' : `${loose.length} arquivos planejados não estão ligados a nada`,
      detail: `Nada no plano usa ${one ? 'esse arquivo' : 'esses arquivos'}, e ${one ? 'ele não usa' : 'eles não usam'} nada. Isso normalmente quer dizer que falta uma ligação no plano.`,
      items: loose.slice(0, 24).map((f) => 'f:' + f.p),
      notes: Object.fromEntries(loose.slice(0, 24).map((f) => ['f:' + f.p, 'Não está ligado a nada no plano'])),
      locations: [],
      fix: [`Revisão do plano em ${planRel}: estes arquivos planejados não estão ligados a nada:`, ...loose.map((f) => `- ${f.p}`), ``, `Acrescente as entradas que faltam em "uses", "calls", "services" ou "data", ou remova os arquivos que não forem necessários.`, rebuild].join('\n'),
    });
  }

  const ORDER = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
  const summary = { high: 0, medium: 0, low: 0 };
  for (const i of issues) summary[i.severity]++;
  return { summary, issues: issues.slice(0, 40), review: true };
}
