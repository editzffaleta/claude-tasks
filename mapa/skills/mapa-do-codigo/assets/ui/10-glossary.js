// Glossary: explains, in plain Portuguese, the technical words a non-developer meets on the map.
// The first time a known term appears in a description (details panel, board title area), it gets a
// dotted underline; hovering or focusing it shows a one-sentence explanation. Off while
// "Mostrar detalhes técnicos" is on. Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  if (!SC) return;

  // [display name, plain explanation, aliases...]. Aliases are matched as whole words, ignoring case,
  // except those marked with a leading "=" (matched exactly, so "REST" doesn't fire on "o rest"). Descriptions
  // are written in Portuguese, but keep many English words of the trade, so both are listed.
  const TERMS = [
    ['API', 'O jeito como os programas conversam entre si: um pede algo (preços, um pedido) e o outro responde.', 'API', 'APIs', 'API client', 'cliente de API', 'clientes de API'],
    ['Endpoint', 'Uma requisição específica que o app sabe receber, como “marcar este pedido como enviado”; cada uma tem seu próprio endereço na web.', 'endpoint', 'endpoints'],
    ['Webhook', 'Uma mensagem que outro serviço manda para o seu app automaticamente quando algo acontece lá, como “um pagamento foi aprovado”.', 'webhook', 'webhooks'],
    ['Servidor', 'Um computador na nuvem que faz o trabalho de bastidores do app e responde às requisições das telas.', 'servidor', 'servidores', 'servidor principal', 'server', 'servers'],
    ['Frontend', 'A parte do app que as pessoas veem e clicam: as telas, os botões e os formulários no navegador.', 'frontend', 'front end', 'front-end'],
    ['Backend', 'A parte de bastidores do app, que guarda os registros, aplica as regras e conversa com outros serviços.', 'backend', 'back end', 'back-end'],
    ['Banco de dados', 'Onde o app guarda seus registros (produtos, pedidos, clientes) para nada se perder quando ele reinicia.', 'banco de dados', 'bancos de dados', 'database', 'databases', 'DB'],
    ['Registro', 'Uma entrada salva no banco de dados, como um único pedido ou cliente; uma tabela é a lista de todos os registros de um tipo.', 'registro do banco', 'registros do banco', 'tabela do banco', 'tabelas do banco', 'database record', 'database records', 'database table', 'database tables'],
    ['Modelo', 'No código, um modelo descreve como um tipo de registro (um pedido, um cliente) é guardado no banco de dados.', 'modelo de dados', 'modelos de dados', 'ORM', 'modelo ORM', 'modelos ORM', 'data model'],
    ['Consulta', 'Uma pergunta que o app faz ao banco de dados, como “todos os pedidos de hoje que ainda não foram enviados”.', 'consulta ao banco', 'consultas ao banco', 'consulta SQL', 'consultas SQL', 'query', 'queries'],
    ['Fila', 'Uma fila de espera de tarefas: o trabalho entra nela e é feito um por um, nos bastidores, para nada se perder.', 'fila', 'filas', 'enfileirado', 'enfileirada', 'enfileirados', 'fila de mensagens', 'outbox', 'queue', 'queues', 'message queue'],
    ['Tarefa em segundo plano', 'Uma tarefa que roda sozinha nos bastidores, para as pessoas não terem que esperar por ela na tela.', 'tarefa em segundo plano', 'tarefas em segundo plano', 'em segundo plano', 'background job', 'background jobs', 'worker', 'workers'],
    ['Tarefa agendada', 'Uma tarefa que roda sozinha num horário marcado, como a cada hora ou toda noite.', 'cron', 'cron job', 'cron jobs', 'tarefa agendada', 'tarefas agendadas', 'agendador', 'scheduler'],
    ['Variável de ambiente', 'Uma configuração guardada fora do código, como qual banco ou qual conta usar, para poder ser diferente entre o teste e o app no ar.', 'variável de ambiente', 'variáveis de ambiente', 'env var', 'env vars', '.env', 'environment variable', 'environment variables'],
    ['Segredo', 'Uma senha ou chave que o app usa para entrar em outro serviço; nunca deve ser compartilhada nem ficar escrita no código.', 'segredo', 'segredos', 'chave de API', 'chaves de API', 'chave secreta', 'chaves secretas', 'credenciais', 'secret', 'secrets', 'API key', 'API keys'],
    ['Deploy', 'Colocar no ar uma nova versão do app, para as pessoas começarem a usá-la.', 'deploy', 'deploys', 'implantação', 'implantações'],
    ['Migração', 'Uma mudança feita uma vez só no jeito como os registros são guardados, como acrescentar um campo novo em todos os pedidos.', 'migração', 'migrações', 'migration', 'migrations'],
    ['Cache', 'Uma cópia guardada por perto para carregar mais rápido, em vez de calcular tudo de novo.', 'cache', 'caches', 'em cache'],
    ['Login', 'Conferir quem é a pessoa (normalmente com uma senha) antes de deixá-la entrar.', 'login', 'autenticação', 'auth', 'fazer login', 'sign-in', 'sign in'],
    ['Permissões', 'As regras de quem pode fazer o quê, como só gerentes poderem fazer reembolsos.', 'permissões', 'autorização', 'RBAC', 'permissions', 'authorization'],
    ['Sessão', 'Como o app lembra que você já fez login, para não pedir a senha em toda tela.', 'sessão', 'sessões', 'session', 'sessions'],
    ['Token', 'Um passe digital temporário que o app entrega depois do login e confere em cada requisição.', 'token', 'tokens', 'token de acesso', 'bearer token', 'access token'],
    ['SDK', 'Um kit de código pronto que uma empresa oferece para os apps conversarem com o serviço dela mais facilmente.', 'SDK', 'SDKs'],
    ['Repositório', 'A pasta que guarda todo o código de um projeto e o histórico completo das mudanças.', 'repositório', 'repositórios', 'repo', 'repos'],
    ['Componente', 'Uma peça reutilizável das telas, como um botão, uma tabela ou um editor de produto inteiro.', 'componente', 'componentes', 'component', 'components'],
    ['Rota', 'Um endereço da web que o app atende: nas telas é uma página; no servidor, um tipo de requisição.', 'rota', 'rotas', 'roteamento', 'route', 'routes', 'routing', 'App Router'],
    ['Requisição', 'Uma mensagem pedindo ao servidor para fazer ou buscar algo; o servidor devolve uma resposta com o resultado.', 'requisição', 'requisições', 'request', 'requests', 'response', 'responses'],
    ['JSON', 'Um formato de texto simples que os programas usam para trocar dados, como uma lista com etiquetas.', 'JSON'],
    ['REST', 'Um estilo comum de montar APIs, em que cada endereço representa um tipo de coisa (pedidos, produtos).', '=REST', '=RESTful'],
    ['Método HTTP', 'O tipo da requisição: GET lê algo, POST cria, PUT ou PATCH alteram, DELETE apaga.', 'método HTTP', 'métodos HTTP', 'HTTP method', 'HTTP methods', '=GET', '=POST', '=PUT', '=PATCH', '=DELETE'],
    ['HTTP', 'A língua que navegadores e servidores usam para conversar pela web; HTTPS é a versão criptografada.', 'HTTP', 'HTTPS'],
    ['CDN', 'Uma rede de servidores espalhados pelo mundo que entrega imagens e arquivos rápido, de algum lugar perto de quem visita.', 'CDN', 'CDNs'],
    ['Bucket', 'Um armazenamento de arquivos na nuvem para coisas como fotos de produtos, uploads e exportações.', 'bucket', 'buckets', 'storage bucket', 'S3', 'GCS', 'Cloud Storage'],
    ['Pub/Sub', 'O serviço de mensagens do Google: uma parte do app publica um evento e outras o pegam para tratar nos bastidores.', 'Pub/Sub', 'PubSub'],
    ['MCP', 'Um padrão para conectar assistentes de IA (como o Claude ou o ChatGPT) a um app, para eles consultarem coisas nele.', 'MCP', 'servidor MCP', 'MCP server', 'Model Context Protocol'],
    ['Next.js', 'Um kit popular para construir sites e apps web com React.', 'Next.js', 'NextJS'],
    ['React', 'Uma biblioteca popular para montar telas interativas com peças reutilizáveis.', '=React'],
    ['Flask', 'Um kit em Python para construir servidores web.', 'Flask'],
    ['SQLAlchemy', 'Um kit em Python que deixa o código ler e gravar registros no banco de dados sem escrever os comandos do banco à mão.', 'SQLAlchemy'],
    ['Postgres', 'Um banco de dados muito usado; RDS e Cloud SQL são as versões dele hospedadas pela Amazon e pelo Google.', 'Postgres', 'PostgreSQL', 'RDS', 'Cloud SQL'],
    ['Docker', 'Um jeito de empacotar um app com tudo de que ele precisa, para rodar igual em qualquer computador ou nuvem.', 'Docker', 'contêiner', 'contêineres', 'container', 'containers'],
    ['Cloud Run', 'O serviço do Google para rodar na nuvem os servidores e as tarefas em segundo plano de um app, sem cuidar de máquinas.', 'Cloud Run'],
    ['Middleware', 'Uma checagem por onde toda requisição passa na entrada, como “essa pessoa fez login?”.', 'middleware', 'middlewares'],
    ['Blueprint', 'No Flask, um grupo de rotas relacionadas empacotadas juntas, como todas as rotas de pedidos.', 'blueprint', 'blueprints'],
    ['Testes', 'Verificações automáticas de que o código continua fazendo o que deve, rodadas antes das mudanças irem para o ar.', 'testes automatizados', 'teste unitário', 'testes unitários', 'suíte de testes', 'test suite', 'unit test', 'unit tests', 'pytest', 'Vitest'],
    ['Script', 'Um programinha rodado à mão para uma tarefa avulsa, como corrigir ou importar dados.', 'script', 'scripts'],
    ['OAuth', 'O padrão por trás dos botões “Entrar com…”: deixa um app usar outro em seu nome sem você compartilhar a senha.', 'OAuth'],
  ];

  const exact = new Map(), loose = new Map(), alts = [];
  TERMS.forEach(([name, text, ...aliases], i) => {
    for (let a of aliases) {
      const strict = a.startsWith('=');
      if (strict) a = a.slice(1);
      (strict ? exact : loose).set(strict ? a : a.toLowerCase(), i);
      alts.push(a);
    }
  });
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  alts.sort((a, b) => b.length - a.length);
  // letters with accents count as letters (u flag), so "rota" doesn't fire inside "rotação"
  const W = '\\p{L}\\p{N}_';
  const RE = new RegExp(`(?<![${W}./-])(?:${alts.map(esc).join('|')})(?![${W}/]|-[${W}]|\\.[${W}])`, 'giu');
  const termOf = (m) => exact.has(m) ? exact.get(m) : loose.has(m.toLowerCase()) ? loose.get(m.toLowerCase()) : -1;

  // Where to look, and what to leave alone.
  const TARGETS = '.pd, .rd, .callout';
  const SKIP = 'a[href], button, code, pre, kbd, samp, input, textarea, select, [contenteditable], .tag, .rp, .pp, .method, .kbd, .sc-term, [data-noglossary]';
  const CLICKABLE = 'a, [data-go], [data-sel], [data-flow], [data-open], [role="button"]';
  const isMono = (el) => /mono|monospace/i.test(el.style?.fontFamily || '');

  function annotate(scope, targets) {
    if (!scope || SC.technical()) return;
    const used = new Set([...scope.querySelectorAll('.sc-term')].map((s) => +s.dataset.term)); // max one per term per scope
    const skipped = (from, stop) => { for (let p = from; p && p !== stop; p = p.parentElement) if (p.matches(SKIP) || isMono(p)) return true; return false; };
    for (const el of targets) {
      if (skipped(el, scope)) continue;
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (t) => !t.nodeValue.trim() || skipped(t.parentElement, el) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      const texts = [];
      while (walker.nextNode()) texts.push(walker.currentNode);
      for (const t of texts) wrapIn(t, used);
    }
  }
  function wrapIn(textNode, used) {
    let node = textNode;
    while (node) {
      RE.lastIndex = 0;
      let m, hit = null;
      while ((m = RE.exec(node.nodeValue))) {
        const i = termOf(m[0]);
        if (i >= 0 && !used.has(i)) { hit = { m, i }; break; }
      }
      if (!hit) return;
      used.add(hit.i);
      const word = node.splitText(hit.m.index);
      const rest = word.splitText(hit.m[0].length);
      const span = document.createElement('span');
      span.className = 'sc-term';
      span.dataset.term = String(hit.i);
      if (!word.parentElement.closest(CLICKABLE)) span.tabIndex = 0; // inside clickable rows: hover only, clicks pass through
      word.replaceWith(span);
      span.appendChild(word);
      node = rest;
    }
  }
  function strip(scope) {
    if (!scope) return;
    for (const s of scope.querySelectorAll('.sc-term')) s.replaceWith(...s.childNodes);
    scope.normalize();
  }

  const panelEl = () => document.getElementById('panel');
  const contextEl = () => document.getElementById('context');
  const doPanel = () => { const p = panelEl(); if (p) annotate(p, p.querySelectorAll(TARGETS)); };
  const doContext = () => { const c = contextEl(); if (c) annotate(c, c.querySelectorAll('p, .callout')); };

  // Run after the viewer and any other extension listeners have finished filling the DOM.
  SC.on('panel', () => { hide(true); queueMicrotask(doPanel); });
  SC.on('render', () => { hide(true); queueMicrotask(doContext); });
  SC.on('technical', (on) => {
    hide(true);
    if (on) { strip(panelEl()); strip(contextEl()); }
    else { queueMicrotask(() => { strip(panelEl()); strip(contextEl()); doPanel(); doContext(); }); }
  });

  // ---------- popover ----------
  const style = document.createElement('style');
  style.textContent = `
.sc-term { pointer-events: auto; cursor: help; border-radius: 4px; text-decoration-line: underline; text-decoration-style: dotted; text-decoration-thickness: 1px; text-underline-offset: 3px;
  text-decoration-color: rgba(var(--ink), .32); text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); transition: text-decoration-color .2s var(--ease), color .2s var(--ease); }
.sc-term:hover, .sc-term.on { text-decoration-color: currentColor; color: var(--text); }
.callout .sc-term:hover, .callout .sc-term.on { color: inherit; }
.sc-term:focus { outline: none; }
.sc-term:focus-visible { box-shadow: 0 0 0 2px var(--focus); }
#sc-gloss { position: fixed; left: 0; top: 0; z-index: 55; max-width: 280px; padding: 11px 13px; border-radius: 14px; font-size: 12.5px; line-height: 1.5; color: var(--text-2);
  pointer-events: none; opacity: 0; transform: translateY(3px); transition: opacity .15s var(--ease), transform .25s var(--ease); }
#sc-gloss.on { opacity: 1; transform: none; }
#sc-gloss b { display: block; color: var(--text); font-weight: 600; margin-bottom: 2px; }`;
  document.head.appendChild(style);

  const pop = document.createElement('div');
  pop.id = 'sc-gloss';
  pop.className = 'glass';
  pop.setAttribute('role', 'tooltip');
  document.body.appendChild(pop);

  let current = null, showT = 0, hideT = 0;
  function show(el) {
    clearTimeout(hideT);
    if (current === el) return;
    const term = TERMS[+el.dataset.term];
    if (!term) return;
    current?.classList.remove('on'); current?.removeAttribute('aria-describedby');
    current = el;
    el.classList.add('on');
    el.setAttribute('aria-describedby', 'sc-gloss');
    pop.innerHTML = `<b>${SC.h(term[0])}</b>${SC.h(term[1])}`;
    const r = el.getClientRects()[0] || el.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 8;
    const x = Math.max(12, Math.min(r.left, innerWidth - pw - 12));
    const below = r.bottom + gap + ph <= innerHeight - 12;
    const y = below ? r.bottom + gap : Math.max(12, r.top - gap - ph);
    pop.style.left = `${Math.round(x)}px`;
    pop.style.top = `${Math.round(y)}px`;
    pop.classList.add('on');
  }
  function hide(now) {
    clearTimeout(showT); clearTimeout(hideT);
    const go = () => { pop.classList.remove('on'); current?.classList.remove('on'); current?.removeAttribute('aria-describedby'); current = null; };
    if (now === true) go(); else hideT = setTimeout(go, 90);
  }
  const termAt = (ev) => ev.target instanceof Element ? ev.target.closest('.sc-term') : null;
  document.addEventListener('mouseover', (ev) => { const t = termAt(ev); if (!t) return; clearTimeout(showT); showT = setTimeout(() => show(t), current ? 0 : 140); });
  document.addEventListener('mouseout', (ev) => { const t = termAt(ev); if (t && !t.contains(ev.relatedTarget)) { clearTimeout(showT); hide(); } });
  document.addEventListener('focusin', (ev) => { const t = termAt(ev); if (t) show(t); });
  document.addEventListener('focusout', (ev) => { if (termAt(ev)) hide(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && current) hide(true); });
  document.addEventListener('scroll', () => { if (current) hide(true); }, true);
  addEventListener('resize', () => { if (current) hide(true); });

  // initial pass, in case the first render/panel happened before this script ran
  if (document.readyState !== 'loading') queueMicrotask(() => { doPanel(); doContext(); });
})();
