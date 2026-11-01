// Ponte entre o Mapa do código e o Breakscale (https://breakscale.tech, licença MIT, de xevrion/workersio):
// um simulador que monta o sistema com balanceadores, servidores, bancos e filas e mostra onde ele quebra
// quando o tráfego sobe. Aqui ficam as partes sem efeito colateral: o rascunho tirado do mapa, a leitura
// do texto que o Breakscale devolve e a escolha dos gargalos. O simulador em si é o do Breakscale, que
// roda pelo servidor MCP dele (no computador, pelo npx, ou no servidor hospedado, se a pessoa pedir).

/** Versão fixa do pacote: a leitura do resultado depende do texto que essa versão escreve. */
export const BREAKSCALE_PACKAGE = 'breakscale-mcp@0.1.1';
export const LOCAL_COMMAND = ['npx', '-y', BREAKSCALE_PACKAGE, '--stdio'];
export const REMOTE_URL = 'https://mcp.breakscale.tech/mcp';
export const SITE = 'https://breakscale.tech/';
/** Múltiplos do tráfego de base simulados por padrão. */
export const DEFAULT_SCENARIOS = [1, 2, 5, 10];
export const SIM_FILES = { design: 'simulacao-projeto.json', result: 'simulacao.json', file: 'simulacao.breakscale' };
export const DESIGN_SCHEMA = 'mapa/simulacao-projeto@1';
export const RESULT_SCHEMA = 'mapa/simulacao@1';

/** Os 33 tipos de componente do Breakscale. */
export const BREAKSCALE_KINDS = [
  'client', 'lb', 'service', 'cache', 'db', 'queue', 'worker', 'replica', 'shard', 'autoscaler', 'region', 'cdn',
  'ratelimiter', 'breaker', 'objectstore', 'searchindex', 'timeseriesdb', 'graphdb', 'coldstorage', 'vectordb',
  'streambroker', 'pubsub', 'websocket', 'apigateway', 'sidecar', 'lambda', 'cron', 'bulkhead', 'retryqueue',
  'transcoder', 'edgecompute', 'writebehind', 'loadshedder',
];

/** Nome em português de cada tipo, para os textos. */
export const KIND_NAMES = {
  client: 'origem do tráfego', lb: 'balanceador', service: 'servidor', cache: 'cache', db: 'banco de dados', queue: 'fila',
  worker: 'processador de fila', replica: 'réplica de leitura', shard: 'partição do banco', autoscaler: 'escalonador',
  region: 'região', cdn: 'CDN', ratelimiter: 'limitador de taxa', breaker: 'disjuntor', objectstore: 'armazenamento de arquivos',
  searchindex: 'índice de busca', timeseriesdb: 'banco de séries temporais', graphdb: 'banco de grafos', coldstorage: 'arquivo morto',
  vectordb: 'banco vetorial', streambroker: 'stream de eventos', pubsub: 'pub/sub', websocket: 'servidor de websocket',
  apigateway: 'gateway de API', sidecar: 'sidecar', lambda: 'função serverless', cron: 'agendador', bulkhead: 'bulkhead',
  retryqueue: 'fila de novas tentativas', transcoder: 'conversor de mídia', edgecompute: 'função na borda',
  writebehind: 'cache com gravação adiada', loadshedder: 'controle de carga',
};

// Serviços externos que são lugares onde o sistema guarda ou passa dados, pelo nome, pacotes e hosts.
// A ordem importa: "redis" vira cache antes de cair na regra genérica de banco.
const STORE_RULES = [
  ['streambroker', /kafka|kinesis|redpanda/],
  ['pubsub', /pub ?\/ ?sub|pubsub|\bsns\b/],
  ['queue', /bullmq|\bbull\b|amqp|rabbit|\bsqs\b|celery|sidekiq|resque|\bnats\b|beanstalk|\bfilas?\b|\bqueues?\b/],
  ['cache', /redis|valkey|memcache|\bcache\b/],
  ['searchindex', /elastic|opensearch|algolia|meili|typesense/],
  ['vectordb', /pinecone|pgvector|qdrant|weaviate|chroma|milvus/],
  ['timeseriesdb', /influx|timescale/],
  ['graphdb', /neo4j|neptune|dgraph/],
  ['objectstore', /\bs3\b|storage\.googleapis|\bgcs\b|blob\.core|minio|cloudflare r2|\bbuckets?\b|cloud storage/],
  ['db', /postgres|\bpg\b|psycopg|mysql|maria|sqlite|mssql|sql server|oracle|prisma|sqlalchemy|typeorm|sequelize|knex|drizzle|mongo|dynamo|firestore|supabase|cockroach|cassandra|planetscale|\bbanco\b|database|\bdb\b/],
];
const STORE_KINDS = new Set(STORE_RULES.map(([k]) => k));
const RUNTIME_LINKS = new Set(['http', 'rpc', 'call', 'data', 'queue', 'event']);

export function storeKind(node) {
  const text = [node.id, node.label, ...(node.packages || []), ...(node.hosts || [])].join(' ').toLowerCase();
  for (const [kind, re] of STORE_RULES) if (re.test(text)) return kind;
  return null;
}

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'x';

/**
 * Um rascunho do sistema para o Breakscale, tirado do grafo.json do mapa. Só entram as peças que rodam
 * (telas, servidores, processadores de fila e os bancos, caches e filas externos); bibliotecas, testes e
 * scripts ficam de fora. Todos os números são os padrões do Breakscale e ficam listados em `premissas`,
 * para quem revisar trocar pelos números do código.
 */
export function draftFromGraph(graph, { name, scenarios = DEFAULT_SCENARIOS, now = new Date() } = {}) {
  const all = graph?.nodes || [];
  const byId = new Map(all.map((n) => [n.id, n]));
  const rootOf = (id) => {
    let n = byId.get(id);
    for (let i = 0; n?.parent && byId.has(n.parent) && i < 64; i++) n = byId.get(n.parent);
    return n?.id ?? null;
  };
  const fileNode = new Map((graph?.files || []).map((f) => [f.p, f.n]));
  const endpoint = (ref) => {
    const s = String(ref || '');
    if (s.startsWith('n:')) return rootOf(s.slice(2));
    if (s.startsWith('f:')) return rootOf(fileNode.get(s.slice(2)));
    return null;
  };

  // O papel de cada parte de cima do mapa no sistema que roda.
  const role = new Map();
  for (const n of all.filter((x) => !x.parent || !byId.has(x.parent))) {
    if (n.kind === 'ui') role.set(n.id, 'ui');
    else if (n.kind === 'service') role.set(n.id, 'service');
    else if (n.kind === 'worker') role.set(n.id, 'worker');
    else if (n.kind === 'external') role.set(n.id, storeKind(n) || 'api');
  }

  // As ligações entre partes, juntadas no nível de cima. Importar o pacote de um banco conta como usar o banco.
  const pairs = new Map();
  for (const l of graph?.links || []) {
    const a = endpoint(l.a);
    const b = endpoint(l.b);
    if (!a || !b || a === b || !role.has(a) || !role.has(b)) continue;
    if (!RUNTIME_LINKS.has(l.k) && !(l.k === 'import' && STORE_KINDS.has(role.get(b)))) continue;
    const key = `${a}>${b}`;
    const p = pairs.get(key) || { a, b, kinds: new Set(), labels: new Set() };
    p.kinds.add(l.k);
    for (const x of l.labels || []) p.labels.add(x);
    pairs.set(key, p);
  }

  const label = (id) => clip(byId.get(id)?.label || id, 60);
  const nodes = [];
  const edges = [];
  const premissas = [];
  const fora = [];
  const ids = new Set();
  const addNode = (node) => { if (!ids.has(node.id)) { ids.add(node.id); nodes.push(node); } return node.id; };
  const addEdge = (from, to) => { if (from !== to && !edges.some((e) => e.from === from && e.to === to)) edges.push({ from, to }); };
  const clientFor = new Map();
  const client = (id, text) => {
    if (!clientFor.has(id)) {
      const cid = addNode({ id: `origem-${slug(id)}`, kind: 'client', label: clip(text, 60) });
      clientFor.set(id, cid);
      premissas.push({ componente: cid, texto: '50 pedidos por segundo, o padrão do Breakscale. Troque pelo tráfego real (métricas, logs) ou por uma estimativa explicada.', origem: 'chute' });
    }
    return clientFor.get(id);
  };

  const internal = (r) => r === 'service' || r === 'worker' || STORE_KINDS.has(r);
  for (const [id, r] of role) {
    if (!internal(r)) continue;
    addNode({ id, kind: r, label: label(id) });
    premissas.push({
      componente: id,
      texto: `Como ${KIND_NAMES[r]}, capacidade, tempo de resposta e número de cópias no padrão do Breakscale. Troque pelos números do código (tamanho do pool, réplicas, limites, tempo médio).`,
      origem: 'chute',
    });
  }

  for (const p of pairs.values()) {
    const ra = role.get(p.a);
    const rb = role.get(p.b);
    if (ra === 'ui' && internal(rb)) { addEdge(client(p.a, `Usuários de ${label(p.a)}`), p.b); continue; }
    if (ra === 'api' && internal(rb)) { addEdge(client(p.a, `Chamadas de ${label(p.a)}`), p.b); continue; }
    if (internal(ra) && rb === 'api') {
      fora.push({ texto: `${label(p.a)} chama ${label(p.b)} (serviço de fora). No Breakscale, cada pedido segue por todas as ligações de um servidor; incluir esta faria todo pedido passar por ${label(p.b)}. Se ela pesa, modele como um fluxo à parte, com uma origem de tráfego própria.` });
      continue;
    }
    if (!internal(ra) || !internal(rb)) continue;
    // Um processador de fila ligado a uma fila sempre a consome, para qualquer lado que a ligação aponte.
    if (ra === 'worker' && (rb === 'queue' || rb === 'retryqueue')) { addEdge(p.b, p.a); continue; }
    addEdge(p.a, p.b);
  }

  // Servidores que nada chama recebem uma origem de tráfego genérica, para o rascunho ter por onde começar.
  const called = new Set(edges.map((e) => e.to));
  const entry = nodes.filter((n) => n.kind === 'service' && !called.has(n.id));
  if (!nodes.some((n) => n.kind === 'client') && entry.length) for (const n of entry) addEdge(client('usuarios', 'Usuários'), n.id);
  else if (entry.length) for (const n of entry) fora.push({ texto: `${n.label} não recebe tráfego de nenhuma origem no rascunho. Ligue uma origem a ele se ele atende pedidos de fora.` });
  for (const n of nodes.filter((x) => x.kind === 'worker' && !edges.some((e) => e.to === x.id))) {
    fora.push({ texto: `${n.label} é um processador de fila sem fila ligada a ele no mapa. Ligue a fila que ele consome, senão ele fica parado na simulação.` });
  }
  // Peças que nada usa só poluem a simulação.
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  const kept = nodes.filter((n) => used.has(n.id));
  for (const n of nodes.filter((x) => !used.has(x.id))) fora.push({ texto: `${n.label} ficou de fora: nenhuma ligação do mapa chega a ele ou sai dele.` });

  return {
    $schema: DESIGN_SCHEMA,
    nome: clip(name || graph?.project?.name || graph?.meta?.rootName || 'Projeto', 80),
    criadoEm: now.toISOString(),
    cenarios: scenarios,
    nodes: kept,
    edges,
    premissas: premissas.filter((x) => used.has(x.componente)),
    deixadoDeFora: fora,
    sugestoes: {},
  };
}

/** Confere o projeto antes de mandar ao Breakscale. Devolve a lista de problemas (vazia quando está tudo certo). */
export function checkDesign(design) {
  const problems = [];
  if (!design || typeof design !== 'object') return ['O arquivo não é um objeto JSON.'];
  if (!Array.isArray(design.nodes) || !design.nodes.length) problems.push('`nodes` precisa ter pelo menos um componente.');
  const ids = new Set();
  for (const [i, n] of (design.nodes || []).entries()) {
    if (!n || typeof n.id !== 'string' || !n.id.trim()) { problems.push(`nodes[${i}] precisa de um \`id\`.`); continue; }
    if (ids.has(n.id)) problems.push(`Dois componentes com o id '${n.id}'.`);
    ids.add(n.id);
    if (!BREAKSCALE_KINDS.includes(n.kind)) problems.push(`'${n.id}' tem o tipo ${JSON.stringify(n.kind)}, que o Breakscale não conhece. Tipos: ${BREAKSCALE_KINDS.join(', ')}.`);
  }
  if (!(design.nodes || []).some((n) => n?.kind === 'client')) problems.push('Falta uma origem de tráfego (`client`): sem ela nada chega ao sistema.');
  for (const [i, e] of (design.edges || []).entries()) {
    if (!ids.has(e?.from) || !ids.has(e?.to)) problems.push(`edges[${i}] liga '${e?.from}' a '${e?.to}', mas um dos dois não existe.`);
  }
  const sc = design.cenarios ?? DEFAULT_SCENARIOS;
  if (!Array.isArray(sc) || !sc.length || sc.some((x) => !(Number(x) > 0) || Number(x) > 1000)) problems.push('`cenarios` deve ser uma lista de multiplicadores do tráfego, como [1, 2, 5, 10].');
  return problems;
}

/** O projeto no formato curto que o create_view do Breakscale aceita, com o tráfego multiplicado. */
export function forBreakscale(design, factor = 1) {
  const nodes = design.nodes.map((n) => {
    const out = { id: n.id, kind: n.kind };
    if (n.label) out.label = clip(n.label, 60);
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) { out.x = n.x; out.y = n.y; }
    const config = { ...(n.config || {}) };
    if (n.kind === 'client') config.rps = round((Number(config.rps) || 50) * factor);
    if (Object.keys(config).length) out.config = config;
    return out;
  });
  const edges = (design.edges || []).map((e) => {
    const out = { from: e.from, to: e.to };
    for (const k of ['weight', 'control', 'latencyMs']) if (e[k] !== undefined) out[k] = e[k];
    return out;
  });
  return { name: clip(factor === 1 ? design.nome : `${design.nome} (${fmtFactor(factor)} o tráfego)`, 80), nodes, edges };
}

const round = (n) => Math.round(n * 100) / 100;
export const fmtFactor = (f) => `${String(round(f)).replace('.', ',')}×`;

// ---- leitura do texto do create_view (formato do run.ts do breakscale-mcp 0.1.x) ----

const REASONS = {
  'failed on their own (errorRate)': ['error', 'falharam sozinhos (taxa de erro)'],
  'were turned away by a full queue': ['shed', 'foram recusados por uma fila cheia'],
  'timed out': ['timeout', 'esgotaram o tempo de espera'],
  'had nowhere to go': ['no-route', 'não tinham para onde ir'],
  'looped past the hop limit': ['depth', 'passaram do limite de saltos'],
  'were refused by a rate limiter': ['throttled', 'foram barrados pelo limitador de taxa'],
  'were refused by an open circuit breaker': ['rejected', 'foram barrados por um disjuntor aberto'],
  'hit a crashed component': ['crashed', 'bateram num componente fora do ar'],
  'crossed a cut network link': ['partitioned', 'passaram por uma ligação de rede cortada'],
  'found no region serving': ['region-down', 'não acharam nenhuma região no ar'],
  'were refused a websocket connection': ['conn-refused', 'tiveram a conexão websocket recusada'],
  'failed authentication at the API gateway': ['unauthorized', 'falharam na autenticação do gateway'],
  'were refused by a full bulkhead': ['bulkhead-full', 'foram barrados por um bulkhead cheio'],
  'gave up waiting for a pool slot': ['acquire-timeout', 'desistiram de esperar uma vaga no pool'],
  'were dropped by a load shedder': ['deprioritized', 'foram descartados pelo controle de carga'],
};

export const parseRate = (s) => { const m = /^([\d.]+)\/s$/.exec(String(s).trim()); return m ? Number(m[1]) : null; };
export const parsePct = (s) => { const m = /^([\d.]+)%$/.exec(String(s).trim()); return m ? round(Number(m[1]) / 100 * 10000) / 10000 : null; };
export const parseMs = (s) => { const m = /^([\d.]+)(ms|s)$/.exec(String(s).trim()); return m ? Number(m[1]) * (m[2] === 's' ? 1000 : 1) : null; };

/** Lê o texto de um create_view em números. Lança um erro quando o texto não tem o formato esperado. */
export function parseRun(text) {
  const src = String(text || '');
  const sim = /^Simulated (\d+)s with seed (\d+)( \(stopped at)?/m.exec(src);
  const sys = /^Offered (\S+), served (\S+), (\S+) failed\. Latency p50 (\S+), p95 (\S+), p99 (\S+)\.$/m.exec(src);
  if (!sim || !sys) throw new Error(`O Breakscale respondeu num formato que esta versão não reconhece:\n${src.slice(0, 400)}`);
  const run = {
    segundos: Number(sim[1]),
    semente: Number(sim[2]),
    interrompido: !!sim[3],
    oferecido: parseRate(sys[1]),
    servido: parseRate(sys[2]),
    falhas: parsePct(sys[3]),
    p50: parseMs(sys[4]),
    p95: parseMs(sys[5]),
    p99: parseMs(sys[6]),
    motivos: [],
    componentes: [],
    link: null,
  };
  const failed = /^Failed requests over the run: (.*)\.$/m.exec(src);
  if (failed) {
    for (const part of failed[1].split('; ')) {
      const m = /^(\d+) (.*)$/.exec(part);
      if (!m) continue;
      const [motivo, texto] = REASONS[m[2]] || ['outro', m[2]];
      run.motivos.push({ motivo, texto, n: Number(m[1]) });
    }
  }
  for (const line of src.split('\n')) {
    const m = /^- (.*) \(([a-z]+), id '(.*)'\): (.*)$/.exec(line);
    if (!m) continue;
    const c = { id: m[3], nome: m[1], tipo: m[2] };
    for (const part of m[4].split(', ')) {
      let x;
      if ((x = /^(\S+) in$/.exec(part))) c.entrada = parseRate(x[1]);
      else if ((x = /^(\S+) done$/.exec(part))) c.concluidas = parseRate(x[1]);
      else if ((x = /^(\S+) busy$/.exec(part))) c.ocupacao = parsePct(x[1]);
      else if ((x = /^(\d+) waiting$/.exec(part))) c.esperando = Number(x[1]);
      else if ((x = /^p99 (\S+)$/.exec(part))) c.p99 = parseMs(x[1]);
      else if ((x = /^(\S+) failed$/.exec(part))) c.falhas = parsePct(x[1]);
      else if ((x = /^(\S+) turned away$/.exec(part))) c.recusadas = parseRate(x[1]);
      else if ((x = /^(\S+) timed out$/.exec(part))) c.tempoEsgotado = parseRate(x[1]);
      else if ((x = /^hit rate (\S+)$/.exec(part))) c.acertoCache = parsePct(x[1]);
    }
    run.componentes.push(c);
  }
  const link = /opens it on breakscale\.tech: (https:\/\/breakscale\.tech\/\S+)/.exec(src);
  if (link) run.link = link[1];
  return run;
}

// ---- gargalos ----

const pctText = (f) => `${String(Math.round(f * 1000) / 10).replace('.', ',')}%`;
const numText = (r) => (r >= 100 ? String(Math.round(r)) : String(Math.round(r * 10) / 10).replace('.', ','));

/** Sinais de que um componente não aguenta, num cenário. Vazio quando ele está bem. */
export function strainSignals(c) {
  const s = [];
  if (c.ocupacao >= 0.9) s.push(`fica ${pctText(Math.min(c.ocupacao, 1))} ocupado`);
  if (c.esperando >= 10) s.push(`${c.esperando} pedidos esperam na fila`);
  if (c.falhas >= 0.01) s.push(`${pctText(c.falhas)} dos pedidos falham`);
  if (c.recusadas > 0) s.push(`${numText(c.recusadas)} por segundo são recusados por fila cheia`);
  if (c.tempoEsgotado > 0) s.push(`${numText(c.tempoEsgotado)} por segundo esgotam o tempo de espera`);
  return s;
}

const SEVERITY = (factor) => (factor <= 2 ? 'alta' : factor <= 5 ? 'media' : 'baixa');

/**
 * O primeiro cenário em que cada componente deixa de aguentar vira um gargalo. Quem quebra já no
 * tráfego de base (ou no dobro) é urgente; quem só quebra com 10× pode esperar.
 */
export function findBottlenecks(scenarios, design) {
  const names = new Map((design.nodes || []).map((n) => [n.id, n]));
  const out = [];
  const seen = new Set();
  for (const sc of [...scenarios].sort((a, b) => a.fator - b.fator)) {
    for (const c of sc.componentes) {
      if (seen.has(c.id) || c.tipo === 'client') continue;
      const signals = strainSignals(c);
      if (!signals.length) continue;
      seen.add(c.id);
      const nome = names.get(c.id)?.label || c.nome;
      const quando = sc.fator === 1 ? 'no tráfego de base' : `com ${fmtFactor(sc.fator)} o tráfego`;
      out.push({
        id: c.id,
        componente: c.id,
        nome,
        tipo: c.tipo,
        fator: sc.fator,
        trafego: sc.oferecido,
        severidade: SEVERITY(sc.fator),
        titulo: clip(sc.fator === 1 ? `${nome} não aguenta o tráfego de base` : `${nome} não aguenta ${fmtFactor(sc.fator)} o tráfego`, 140),
        porque: `${quando[0].toUpperCase()}${quando.slice(1)} (${numText(sc.oferecido ?? 0)} pedidos por segundo), ${nome} ${joinPt(signals)}.`,
        sugestao: clip(design.sugestoes?.[c.id] || '', 600) || null,
      });
    }
  }
  return out;
}

function joinPt(list) {
  return list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} e ${list.at(-1)}`;
}

/** Os textos dos gargalos sem refazer a simulação (quando só as sugestões mudaram). */
export function applySuggestions(result, design) {
  for (const g of result.gargalos || []) g.sugestao = clip(design.sugestoes?.[g.componente] || '', 600) || null;
  return result;
}
