// Mapa do código: graph queries, shared by the viewer (as page tools for the Claude app) and by
// mapa-do-codigo/consulta.mjs (as a CLI that the Claude Code CLI or Codex calls). Plain script: no imports, no exports.
// Item ids: n:<node id>  f:<file path>  r:<route index>  s:<file path>#<export index>

function createGraphQuery(G) {
  const nodes = new Map(G.nodes.map((n) => [n.id, n]));
  const files = new Map(G.files.map((f) => [f.p, f]));
  const routes = G.routes || [];
  const routesByFile = new Map();
  routes.forEach((r, i) => { if (!routesByFile.has(r.f)) routesByFile.set(r.f, []); routesByFile.get(r.f).push(i); });
  const kidsOf = new Map();
  for (const n of G.nodes) if (n.parent) { if (!kidsOf.has(n.parent)) kidsOf.set(n.parent, []); kidsOf.get(n.parent).push(n.id); }

  const nodeChain = (id) => { const out = []; let n = nodes.get(id); while (n) { out.push(n.id); n = n.parent ? nodes.get(n.parent) : null; } return out; };
  /** The node ids an item lives under, deepest first. */
  function owners(id) {
    if (id.startsWith('n:')) return nodeChain(id.slice(2));
    if (id.startsWith('f:')) { const f = files.get(id.slice(2)); return f ? nodeChain(f.n) : []; }
    if (id.startsWith('r:')) { const r = routes[+id.slice(2)]; return r ? owners('f:' + r.f) : []; }
    if (id.startsWith('s:')) return owners('f:' + id.slice(2).replace(/#\d+$/, ''));
    return [];
  }
  function brief(id) {
    if (id.startsWith('n:')) { const n = nodes.get(id.slice(2)); return n && { id, type: n.kind === 'external' ? 'external' : 'module', name: n.label, description: n.summary || '' }; }
    if (id.startsWith('f:')) { const f = files.get(id.slice(2)); return f && { id, type: 'file', name: f.name, description: f.d || '', path: f.p }; }
    if (id.startsWith('r:')) { const r = routes[+id.slice(2)]; return r && { id, type: 'endpoint', name: r.name, description: r.d || '', path: `${r.m} ${r.p}` }; }
    if (id.startsWith('s:')) {
      const m = /^s:(.*)#(\d+)$/.exec(id); const f = m && files.get(m[1]); const s = f?.s?.[+m[2]];
      return s && { id, type: s[1], name: s[0], description: s[4] || '', path: `${f.p}:${s[2]}` };
    }
    return null;
  }
  const exists = (id) => !!brief(id);
  const inside = (x, container) => x === container || (container.startsWith('n:') && owners(x).includes(container.slice(2))) || (container.startsWith('f:') && (x.startsWith('r:') ? 'f:' + routes[+x.slice(2)].f === container : x.startsWith('s:') ? 'f:' + x.slice(2).replace(/#\d+$/, '') === container : false));
  const ownerItem = (endpoint) => endpoint.startsWith('f:') ? 'n:' + (files.get(endpoint.slice(2))?.n || '') : endpoint;

  /** Accepts an id, or what people naturally pass: a file path, a module id, or "GET /path". */
  function normId(id) {
    id = String(id || '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
    if (brief(id)) return id;
    if (files.has(id)) return 'f:' + id;
    if (nodes.has(id)) return 'n:' + id;
    const m = /^([A-Z]+)\s+(\/\S*)$/i.exec(id);
    if (m) { const ri = routes.findIndex((r) => r.m === m[1].toUpperCase() && r.p === m[2]); if (ri >= 0) return 'r:' + ri; }
    return id;
  }

  // words that say nothing about what to find, in English and in Portuguese
  const FILLER = new Set(['how', 'does', 'do', 'did', 'the', 'a', 'an', 'is', 'are', 'where', 'what', 'which', 'who', 'of', 'to', 'for', 'in', 'on', 'and', 'or', 'we', 'i', 'my', 'our', 'it', 'work', 'works', 'happen', 'happens', 'get', 'gets', 'with',
    'como', 'onde', 'qual', 'quais', 'quem', 'que', 'o', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'de', 'do', 'da', 'dos', 'das', 'em', 'no', 'na', 'nos', 'nas', 'e', 'ou', 'é', 'são', 'para', 'pra', 'por', 'pelo', 'pela', 'com', 'se', 'eu', 'nós', 'meu', 'minha', 'nosso', 'nossa', 'isso', 'isto', 'ele', 'ela', 'funciona', 'funcionam', 'acontece', 'acontecem', 'faz', 'fazem', 'fica', 'ficam']);
  function find(query, kind, limit = 15) {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const terms = words.filter((t) => !FILLER.has(t)).length ? words.filter((t) => !FILLER.has(t)) : words;
    if (!terms.length) return [];
    const pool = [];
    if (!kind || kind === 'module') for (const n of G.nodes) pool.push(['n:' + n.id, n.label, n.summary || '', n.id, 4]);
    if (!kind || kind === 'file') for (const f of G.files) pool.push(['f:' + f.p, f.name, f.d || '', f.p, 3]);
    if (!kind || kind === 'endpoint') routes.forEach((r, i) => pool.push(['r:' + i, r.name, r.d || '', `${r.m} ${r.p}`, 3]));
    if (!kind || kind === 'symbol') for (const f of G.files) (f.s || []).forEach((s, i) => pool.push([`s:${f.p}#${i}`, s[0], s[4] || '', f.p, 1]));
    // everything matching every word; if nothing does, the best partial matches
    const scored = [];
    for (const [id, name, desc, p, w] of pool) {
      const n = name.toLowerCase(), d = desc.toLowerCase(), pp = p.toLowerCase();
      let s = 0, hit = 0;
      for (const t of terms) {
        const sc = n === t ? 30 : n.startsWith(t) ? 20 : n.includes(t) ? 12 : pp.includes(t) ? 7 : d.includes(t) ? 5 : 0;
        if (sc) { s += sc; hit++; }
      }
      if (hit) scored.push([hit, s + w * 2 - n.length * 0.02, id]);
    }
    const best = Math.max(0, ...scored.map((x) => x[0]));
    const floor = best === terms.length ? best : Math.max(1, Math.ceil(terms.length / 2));
    return scored.filter((x) => x[0] >= floor).sort((a, b) => b[0] - a[0] || b[1] - a[1])
      .slice(0, Math.min(Number(limit) || 15, 40)).map(([, , id]) => brief(id));
  }

  function connections(id, max = 15) {
    const out = new Map(), inn = new Map();
    for (const l of G.links) {
      const ia = inside(l.a, id), ib = inside(l.b, id);
      if (ia === ib) continue;
      const other = ia ? l.b : l.a;
      const key = (id.startsWith('n:') ? ownerItem(other) : other) + '|' + l.k;
      const m = ia ? out : inn;
      const cur = m.get(key) || { id: key.split('|')[0], via: l.k, weight: 0, endpoints: new Set() };
      cur.weight += l.w;
      for (const [ri] of l.calls || []) if (ri != null) cur.endpoints.add(ri);
      m.set(key, cur);
    }
    const fmt = (m) => [...m.values()].sort((a, b) => b.weight - a.weight).slice(0, max).map((c) => ({
      ...brief(c.id), via: c.via, weight: c.weight,
      ...(c.endpoints.size ? { endpoints: [...c.endpoints].slice(0, 6).map((ri) => `r:${ri} ${routes[ri].m} ${routes[ri].p}`) } : {}),
    })).filter((x) => x.id);
    return { dependsOn: fmt(out), usedBy: fmt(inn) };
  }

  function show(id) {
    id = normId(id);
    const b = brief(id);
    if (!b) throw new Error(`Id desconhecido "${id}". Use find primeiro; os ids são assim: n:api, f:src/app.ts, r:12, s:src/app.ts#3.`);
    const parent = owners(id)[id.startsWith('n:') ? 1 : 0];
    const res = { ...b, ...(parent ? { partOf: brief('n:' + parent) && { id: 'n:' + parent, name: nodes.get(parent).label } } : {}) };
    const recent = (G.recent?.items || []).filter((x) => x.id === id);
    if (recent.length) res.recentWork = recent.map((x) => `${G.recent.tasks[x.task]?.title}: ${x.note}`);
    if (id.startsWith('n:')) {
      const n = nodes.get(id.slice(2));
      if (n.details) res.details = n.details;
      res.size = { files: n.stats.files, loc: n.stats.loc };
      res.children = (kidsOf.get(n.id) || []).map((k) => ({ id: 'n:' + k, name: nodes.get(k).label, description: nodes.get(k).summary || '' }));
      const fl = G.files.filter((f) => owners('f:' + f.p).includes(n.id)).sort((a, z) => z.loc - a.loc);
      res.files = fl.slice(0, 12).map((f) => ({ id: 'f:' + f.p, name: f.name, description: f.d || '' }));
      if (fl.length > 12) res.moreFiles = fl.length - 12;
      res.endpoints = routes.filter((r) => owners('f:' + r.f).includes(n.id)).length;
      Object.assign(res, connections(id));
    } else if (id.startsWith('f:')) {
      const f = files.get(id.slice(2));
      Object.assign(res, { loc: f.loc, module: { id: 'n:' + f.n, name: nodes.get(f.n)?.label }, ...(f.note ? { note: f.note } : {}) });
      const rs = routesByFile.get(f.p) || [];
      if (rs.length) res.endpoints = rs.slice(0, 40).map((ri) => ({ id: 'r:' + ri, method: routes[ri].m, path: routes[ri].p, name: routes[ri].name }));
      const handlers = new Set(rs.map((ri) => routes[ri].h));
      const ex = (f.s || []).map((s, i) => [s, i]).filter(([s]) => !handlers.has(s[0]));
      if (ex.length) res.exports = ex.slice(0, 30).map(([s, i]) => `s:${f.p}#${i} ${s[0]} (${s[1]})`);
      Object.assign(res, connections(id, 20));
    } else if (id.startsWith('r:')) {
      const ri = +id.slice(2), r = routes[ri];
      Object.assign(res, { method: r.m, routePath: r.p, handler: r.h, line: r.l, file: { id: 'f:' + r.f, name: files.get(r.f)?.name } });
      const callers = new Map();
      for (const l of G.links) { const n = (l.calls || []).filter(([x]) => x === ri).length; if (n) callers.set(l.a, (callers.get(l.a) || 0) + n); }
      res.calledFrom = [...callers.entries()].map(([a, n]) => ({ ...brief(a), calls: n }));
    } else {
      const m = /^s:(.*)#(\d+)$/.exec(id); const f = files.get(m[1]); const s = f.s[+m[2]];
      res.file = { id: 'f:' + f.p, name: f.name };
      res.importedBy = G.links.filter((l) => l.b === 'f:' + f.p && (l.names || []).some((nm) => nm === s[0] || (nm === 'default' && s[3]))).slice(0, 25).map((l) => brief(l.a));
    }
    return res;
  }

  /** Shortest dependency chain from anything inside `from` to anything inside `to`. */
  function path(from, to) {
    from = normId(from); to = normId(to);
    if (!exists(from) || !exists(to)) throw new Error('Id desconhecido; use find primeiro.');
    const adj = new Map();
    const add = (a, b, l) => { if (!adj.has(a)) adj.set(a, []); adj.get(a).push([b, l]); };
    for (const l of G.links) add(l.a, l.b, l);
    const starts = [...new Set([...G.links.map((l) => l.a), ...G.links.map((l) => l.b)])].filter((x) => inside(x, from));
    const isGoal = (x) => inside(x, to);
    const prev = new Map(starts.map((s) => [s, null]));
    const queue = [...starts];
    let goal = null;
    while (queue.length && !goal) {
      const x = queue.shift();
      for (const [y, l] of adj.get(x) || []) {
        if (prev.has(y)) continue;
        prev.set(y, [x, l]);
        if (isGoal(y)) { goal = y; break; }
        queue.push(y);
      }
    }
    if (!goal) return { found: false, note: `Nenhuma cadeia de imports/chamadas leva de ${from} até ${to}. Tente na direção contrária; ou os dois só se encontram por uma dependência em comum.` };
    const hops = [];
    for (let x = goal; prev.get(x); x = prev.get(x)[0]) {
      const [p, l] = prev.get(x);
      hops.unshift({ from: brief(p), to: brief(x), via: l.k, ...(l.calls?.length ? { endpoints: l.calls.slice(0, 3).map(([ri]) => ri != null ? `r:${ri} ${routes[ri].m} ${routes[ri].p}` : '').filter(Boolean) } : {}) });
    }
    return { found: true, hops: hops.slice(0, 15) };
  }

  function overview() {
    return {
      project: G.project.name, summary: G.project.summary || '',
      systems: G.nodes.filter((n) => !n.parent).map((n) => ({ id: 'n:' + n.id, name: n.label, kind: n.kind, description: n.summary || '', modules: (kidsOf.get(n.id) || []).map((k) => `n:${k} ${nodes.get(k).label}`) })),
      flows: (G.flows || []).map((f) => ({ title: f.title, steps: f.steps.map((s) => `${s.ref} ${s.note}`) })),
      counts: { files: G.files.length, endpoints: routes.length },
      ...(G.recent ? { recentWork: (G.recent.tasks || []).map((t, ti) => ({ title: t.title, request: t.request, summary: t.summary, changed: G.recent.items.filter((x) => x.task === ti).map((x) => `${x.id} ${x.note}`) })) } : {}),
    };
  }

  return { find, show, path, overview, exists, brief };
}

// What an answer looks like, for both engines (JSON Schema). The keys stay in English (the viewer reads them);
// every text a person reads is written in Brazilian Portuguese.
const FLOORPLAN_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Título curto da visão da resposta, em português do Brasil, com no máximo 6 palavras.' },
    answer: { type: 'string', description: 'A resposta em Markdown, em português do Brasil, com no máximo ~180 palavras. Cite os itens do mapa no texto como [[id]].' },
    items: { type: 'array', description: 'De 3 a 14 itens do mapa mais relevantes para a resposta, do mais importante para o menos.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'Por que este item importa aqui, em no máximo 15 palavras, em português do Brasil.' } }, required: ['id', 'note'] } },
    steps: { type: 'array', description: 'Passo a passo opcional, em ordem, quando a resposta é uma sequência (o caminho de uma requisição, um fluxo de dados). Vazio caso contrário.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string' } }, required: ['id', 'note'] } },
    followups: { type: 'array', description: '2 ou 3 perguntas curtas, em português do Brasil, que a pessoa pode querer fazer em seguida.', items: { type: 'string' } },
  },
  required: ['title', 'answer', 'items'],
};

// A requested flow: an ordered walkthrough of map items (JSON Schema).
const FLOORPLAN_FLOW_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Título curto do fluxo, com no máximo 6 palavras, ex.: "Do carrinho ao pagamento no Stripe".' },
    description: { type: 'string', description: 'Uma frase sobre o que o fluxo mostra.' },
    steps: { type: 'array', description: 'De 3 a 9 passos na ordem em que as coisas acontecem, cada um com um item do mapa e o que acontece ali.', items: { type: 'object', properties: { id: { type: 'string' }, note: { type: 'string', description: 'O que acontece neste passo, em no máximo 18 palavras.' } }, required: ['id', 'note'] } },
  },
  required: ['title', 'steps'],
};

// A requested change to a blueprint: the whole updated plano.json and arquitetura.json, and what changed
// (JSON Schema). The documents travel as JSON text so the schema stays the same for every engine.
const FLOORPLAN_CHANGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'O que mudou, em 2 a 6 palavras, ex.: "Pagamentos planejados".' },
    summary: { type: 'string', description: 'Markdown, com no máximo ~150 palavras, em linguagem simples: o que você incluiu, mudou ou removeu e por quê, mais as novas premissas ou perguntas em aberto.' },
    plan: { type: 'string', description: 'O mapa-do-codigo/plano.json completo e atualizado, como texto JSON.' },
    architecture: { type: 'string', description: 'O mapa-do-codigo/arquitetura.json completo e atualizado, como texto JSON.' },
    changes: { type: 'array', description: 'Cada cartão novo ou alterado: um caminho de arquivo, um id de nó ou "MÉTODO /caminho".', items: { type: 'object', properties: { ref: { type: 'string' }, change: { type: 'string', enum: ['new', 'changed'] }, note: { type: 'string', description: 'Como este cartão atende ao pedido, numa frase simples.' } }, required: ['ref', 'change', 'note'] } },
    followups: { type: 'array', description: '2 ou 3 mudanças curtas que a pessoa pode querer pedir em seguida.', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'plan', 'architecture', 'changes'],
};

const PT_BR = 'Escreva todo texto que uma pessoa vai ler (títulos, respostas, notas, sugestões) em português do Brasil, natural e direto. As chaves do JSON continuam em inglês.';

function floorplanChangeInstructions(G) {
  const src = G.meta?.blueprint?.source;
  return [
    `Você altera uma planta: um mapa interativo de "${G.project.name}", um sistema planejado mas ainda não construído. A pessoa que olha o mapa pede uma mudança, inclusão ou remoção ("planeje também os pagamentos", "tire a página de administração", "a equipe deve entrar com o Google") e você atualiza o plano.`,
    `Leia primeiro mapa-do-codigo/plano.json e mapa-do-codigo/arquitetura.json${src ? `, e ${src} (o PRD de onde o plano saiu) quando o pedido mexer no que o PRD diz` : ''}. Você pode consultar o mapa com \`node mapa-do-codigo/consulta.mjs find "<palavras>"\` e \`show <id>\`.`,
    'Formato do plano.json: { source, stack[], assumptions[], questions[{question, about[]}], files[{path, name, description, screen?, uses[], calls["MÉTODO /caminho"], services[ids de nós], data[ids de nós]}], endpoints[{method, path, file, name, description, access: public|signed-in|team|webhook|internal, who?, publicBecause?}] }. O file de cada endpoint é um arquivo planejado, cada call corresponde exatamente a um endpoint planejado, e services/data citam nós do arquitetura.json.',
    'arquitetura.json: { project, nodes[{id, label, kind, parent?, summary, paths[globs]}], edges[], flows[{id, title, steps[{node, note}]}], tour[] }. Tipos (kind): ui service worker library feature data config test script infra external. Nós externos (serviços de fora, o banco de dados) não têm arquivos. Todo arquivo planejado precisa cair nos paths de algum nó, então inclua ou amplie globs para pastas novas. Passos de fluxos e do tour apontam para ids de nós ou caminhos de arquivos planejados.',
    'Mude só o que o pedido precisa, do jeito que o resto do plano está escrito: mesma stack e convenções, linguagem simples para todo mundo, caminhos de arquivo reais. Mantenha todos os outros arquivos, endpoints, ids e descrições exatamente como estão. Se o PRD ou o plano já decidiram algo, siga; registre uma escolha nova em assumptions e uma decisão realmente em aberto em questions. Se o pedido remove algo, remova tudo o que só aquilo usava. Se ele responde a uma das questions do plano.json, remova essa pergunta, incorpore a resposta ao plano e registre-a em assumptions; se ele define quem pode usar um endpoint, preencha access (e who ou publicBecause). Muitos pedidos vêm da revisão da planta no mapa: resolva exatamente o que ela aponta.',
    'Responda só com JSON: {"title", "summary", "plan", "architecture", "changes", "followups"}. plan e architecture são os arquivos completos e atualizados como texto JSON, não só as partes alteradas. changes lista cada arquivo, endpoint ("MÉTODO /caminho") ou id de nó novo ou alterado, com uma nota de como ele atende ao pedido.',
    PT_BR + ' Os nomes, descrições, premissas e perguntas do plano também ficam em português do Brasil.',
    'Não edite nenhum arquivo você mesmo: o servidor do mapa confere o seu JSON, salva e redesenha o mapa.',
  ].join('\n');
}

function floorplanFlowInstructions(G, engine) {
  return [
    `Você monta fluxos guiados para um mapa interativo da arquitetura do código "${G.project.name}". Um fluxo é um passo a passo em ordem: cada passo é um item do mapa (módulo n:..., arquivo f:..., endpoint r:... ou exportação s:...) com uma nota sobre o que acontece ali.`,
    engine === 'cli'
      ? 'Encontre os itens com `node mapa-do-codigo/consulta.mjs find "<palavras>"`, `show <id>` e `path <idOrigem> <idDestino>`; leia arquivos do código quando precisar confirmar a ordem dos acontecimentos.'
      : 'Encontre os itens com as ferramentas find_items, get_item e dependency_path.',
    'Siga o que a pessoa pediu desde o gatilho (uma ação de alguém, um webhook, uma tarefa agendada) até o efeito final (gravação no banco, chamada externa, resposta).',
    'Use de 3 a 9 passos. Prefira o item mais específico que conta a história (um endpoint em vez do arquivo dele, um arquivo em vez do módulo) e faça passos seguidos serem coisas que de fato chamam ou importam uma à outra.',
    'Responda só com JSON: {"title", "description", "steps": [{"id", "note"}]}. Use só ids que o mapa deu a você.',
    PT_BR,
  ].join('\n');
}

function floorplanAskInstructions(G, engine) {
  const tools = engine === 'cli'
    ? `Consulte o mapa pelo terminal: \`node mapa-do-codigo/consulta.mjs overview\`, \`node mapa-do-codigo/consulta.mjs find "<palavras>" [--kind module|file|endpoint|symbol]\`, \`node mapa-do-codigo/consulta.mjs show <id>\`, \`node mapa-do-codigo/consulta.mjs path <idOrigem> <idDestino>\`. Todo resultado é JSON com ids. Comece pelo mapa; leia ou procure (grep) nos arquivos do código quando precisar de detalhes que o mapa não tem.`
    : `Use as ferramentas find_items, get_item e dependency_path para explorar o mapa. Você não consegue ler os arquivos do código, então responda a partir dos nomes, descrições, endpoints e conexões do mapa, e diga quando uma pergunta precisa do código em si.`;
  const bp = G.meta?.blueprint;
  return [
    `Você responde perguntas sobre o código "${G.project.name}" para alguém que explora um mapa interativo da arquitetura dele.`,
    `O mapa tem cartões para módulos (ids n:...), arquivos (f:<caminho>), endpoints HTTP (r:<número>) e símbolos exportados (s:<caminho>#<número>), cada um com nome e descrição legíveis, ligados por imports e chamadas HTTP.`,
    tools,
    bp ? `Este mapa é uma planta: o plano de um sistema que ainda não foi construído, então os arquivos dele não existem.${engine === 'cli' ? ` Em vez dos arquivos do código, leia mapa-do-codigo/plano.json${bp.source ? ` e ${bp.source} (de onde o plano saiu)` : ''} quando precisar de mais do que o mapa.` : ''} Responda sobre o que seria construído e por quê, e diga claramente quando o plano não cobre algo.` : '',
    'Faça poucas consultas, não dezenas. Depois responda só com JSON: {"title", "answer", "items", "steps", "followups"}.',
    '- answer: Markdown, com no máximo ~180 palavras, simples e específico. Cite os itens do mapa no texto como [[id]] (eles viram links).',
    '- items: os 3 a 14 cartões que melhor mostram a resposta, do mais importante para o menos, cada um com uma nota (no máximo 15 palavras) sobre o papel dele.',
    '- steps: um passo a passo em ordem quando a resposta é uma sequência (o caminho de uma requisição, um fluxo de dados); senão, [].',
    '- followups: 2 ou 3 perguntas curtas para continuar.',
    'Use só ids que o mapa deu a você.',
    PT_BR,
  ].filter(Boolean).join('\n');
}
