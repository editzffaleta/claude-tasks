// Blueprints ("Planta"): a map planned from a PRD or a description, before any code exists (graph.meta.blueprint,
// from scripts/plan.mjs). Cards get a dashed outline and the project name a "Planta" pill, the overview says what it
// was planned from, and every planned part offers "Construir isto com o Claude": a ready prompt to build just that
// part, following the plan (and, inside the task board, "Criar tarefa para construir"). Talks to the viewer only
// through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  const BP = SC && SC.graph.meta.blueprint;
  if (!BP) return;
  const { h } = SC;
  const Cap = (t) => t[0].toUpperCase() + t.slice(1);
  const A = SC.agent || { name: 'Claude', app: 'Claude Code' };
  const G = SC.graph;
  const B = SC.board; // the task board, when the map is opened inside it

  document.documentElement.classList.add('blueprint');
  const style = document.createElement('style');
  style.textContent = `
    /* planned, not built: a dashed outline on every card */
    html.blueprint .card:not(.connector)::after { content: ""; position: absolute; inset: 0; border-radius: inherit; border: 2.5px dashed rgba(var(--ink), .32); pointer-events: none; }
    .bp-pill { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin-left: 8px; border-radius: 999px; font-size: 11px; font-weight: 500; letter-spacing: .02em; color: var(--text-2); border: 1px dashed rgba(var(--ink), .35); flex: none; }
    .bp-list { margin: 8px 0 0; padding-left: 18px; color: var(--text-2); font-size: 13px; line-height: 1.55; }
    .bp-list li + li { margin-top: 4px; }
  `;
  document.head.appendChild(style);

  // a "Planta" pill beside the board's title, which is redrawn on every move
  const addPill = () => {
    const k = document.querySelector('#context .k');
    if (!k || k.querySelector('.bp-pill')) return;
    k.insertAdjacentHTML('beforeend', '<span class="bp-pill" title="Planejado, ainda não construído: cada cartão é uma parte de que o sistema precisaria.">Planta</span>');
  };
  SC.on('render', addPill);
  SC.on('ready', addPill);

  const ACCESS = { public: 'qualquer pessoa', 'signed-in': 'quem fez login', team: 'só a equipe que opera o serviço', webhook: 'o serviço que envia a chamada, que precisa provar quem é', internal: 'só os nossos próprios serviços' };
  /** "para quem fez login: gerentes daquela loja", or the open question when nobody decided. */
  const whoMay = (r) => !r.access ? 'quem pode usar ainda não foi decidido: pergunte para mim'
    : `para ${r.access === 'signed-in' && r.who ? r.who : ACCESS[r.access] || r.access}${r.publicBecause ? `, porque ${r.publicBecause.replace(/\.$/, '')}` : ''}`;

  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>Planta</h3>
      <p class="pd">Planejado${BP.source ? ` a partir de <b>${h(BP.source)}</b>` : ''}, ainda não construído. Cada cartão tracejado é uma parte de que o sistema precisaria.${SC.exported ? '' : ` Escolha um e use <b>Construir isto com o ${h(A.name)}</b> para começar.`}</p>
      ${BP.stack?.length ? `<div class="tags" style="margin-top:10px">${BP.stack.map((s) => `<span class="tag">${h(s)}</span>`).join('')}</div>` : ''}
      ${BP.assumptions?.length ? `<h3 style="margin-top:14px">Premissas</h3><ul class="bp-list">${BP.assumptions.map((a) => `<li>${h(a)}</li>`).join('')}</ul>` : ''}
    </div>`,
  }));

  /** The planned files inside an item (a part, a folder or one file). */
  const filesIn = (id) => G.files.filter((f) => id === 'f:' + f.p || SC.chain('f:' + f.p).includes(id));
  function buildPrompt(id) {
    const i = SC.info(id);
    const fl = filesIn(id);
    const paths = new Set(fl.map((f) => 'f:' + f.p));
    const eps = SC.routes.filter((r) => paths.has('f:' + r.f));
    const deps = new Map();
    for (const l of G.links) {
      if (!paths.has(l.a) || paths.has(l.b)) continue;
      const o = SC.info(l.b);
      if (o) deps.set(l.b, `${o.name}${l.b.startsWith('f:') ? ` (${l.b.slice(2)})` : ''}`);
    }
    // open questions from the PRD that touch this part
    const inside = (x) => x === id || paths.has(x) || (x.startsWith('r:') && paths.has('f:' + SC.routes[+x.slice(2)]?.f)) || (SC.exists(x) && SC.chain(x).includes(id));
    const questions = (G.health?.issues || []).filter((q) => q.kind === 'question' && (q.items || []).some(inside)).map((q) => q.title);
    return [
      `Construa "${i.name}" a partir da planta de ${G.project.name}: mapa-do-codigo/plano.json e mapa-do-codigo/arquitetura.json${BP.source ? `, planejada a partir de ${BP.source}` : ''}.`,
      i.desc ? `\nPara que serve: ${i.desc}` : '',
      BP.stack?.length ? `\nStack: ${BP.stack.join('; ')}.` : '',
      `\nArquivos a criar:`,
      ...fl.map((f) => `- ${f.p}: ${f.name}${f.d ? `. ${f.d}` : ''}`),
      eps.length ? `\nEndpoints a criar (mantenha o método, o caminho e quem pode usá-los exatamente como planejado):` : '',
      ...eps.map((r) => `- ${r.m} ${r.p} (${whoMay(r)}): ${r.name}${r.d ? `. ${r.d}` : ''}`),
      deps.size ? `\nDepende de: ${[...deps.values()].join('; ')}.` : '',
      questions.length ? `\nAinda não decidido (pergunte para mim antes de construir o que depende disso):\n${questions.map((q) => `- ${q}`).join('\n')}` : '',
      `\nAntes de escrever código, leia estas partes do plano.json e confira quais das coisas de que ela depende já existem; se alguma ainda não existir, me avise e sugira o que construir primeiro. Mantenha os caminhos e os nomes de arquivo do plano. Se o plano parecer errado ou incompleto para esta parte, me avise antes de mudá-lo. Quando terminar, rode a parte ou os testes dela e me diga como experimentar.`,
    ].filter((x) => x !== '').join('\n');
  }

  SC.addPanelSection('item', (id) => {
    if (!id || typeof id !== 'string') return '';
    // an endpoint: who the plan lets use it
    if (id.startsWith('r:')) {
      const r = SC.routes[+id.slice(2)];
      if (!r) return '';
      const text = !r.access ? `Ainda não decidido.${SC.graph.health ? ' A revisão da planta aponta isso.' : ''}` : `${Cap(r.access === 'signed-in' && r.who ? r.who : ACCESS[r.access] || r.access)}.${r.publicBecause ? ` Aberto de propósito: ${r.publicBecause}` : ''}`;
      return `<div class="sec"><h3>Quem pode usar</h3><p class="pd">${h(text)}</p></div>`;
    }
    const i = SC.info(id);
    if (SC.exported || !i || (i.type === 'node' && i.n.kind === 'external') || !filesIn(id).length) return '';
    const done = B?.created('construir', id);
    const taskBtn = !B?.canEdit ? '' : done ? B.resultHtml(done) : `<button class="btn soft" data-bp-task>${SC.iconI('board')}Criar tarefa para construir</button>`;
    return {
      html: `<div class="sec"><h3>Construir</h3><p class="pd">Um pedido pronto para o ${h(A.app)} construir ${i.type === 'file' ? 'este arquivo' : 'esta parte'} do jeito que o plano descreve.</p>
        <div class="actions"><button class="btn soft" data-bp-build>${SC.iconI('spark')}Construir isto com o ${h(A.name)}</button>${taskBtn}</div></div>`,
      bind: (el) => {
        el.querySelector('[data-bp-build]')?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const prompt = buildPrompt(id);
          SC.modal({
            title: `Construir isto com o ${A.name}`,
            html: `<p class="hc-hint">Copie este pedido e cole no <b>${h(A.app)}</b>, aberto na pasta do projeto.</p><pre>${h(prompt)}</pre>`,
            actions: [{ label: 'Copiar pedido', primary: true, icon: 'copy', onClick: () => { SC.copy(prompt); SC.toast(`Copiado. Cole no ${A.app}.`); } }],
          });
        });
        // inside the board: the same request, kept as a task of the project
        B?.wire(el.querySelector('[data-bp-task]'), () => ({
          title: `Construir ${i.name}`,
          description: buildPrompt(id),
          priority: 'medium',
          tags: ['construir'],
          origin: { kind: 'construir', id },
        }));
        B?.bindResults(el);
      },
    };
  });
})();
