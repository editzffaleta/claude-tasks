// Health ("Saúde") panel: plain-language warnings from graph.health (lib/health.mjs) — leaked keys,
// endpoints anyone can call, unused and oversized files — each with "Mostrar no mapa" and a ready
// prompt to paste into Claude Code or Codex (and, inside the task board, "Criar tarefa no quadro").
// On a blueprint it is the design review ("Revisão"). Talks to the viewer only through window.Floorplan.
(() => {
  const SC = window.Floorplan;
  // an exported copy without Health leaves the button out: an empty list would read as "all clear"
  if (!SC || (SC.exported && !SC.graph.health)) return;
  const { h } = SC;
  const A = SC.agent || { name: 'Claude', app: 'Claude Code' };
  const B = SC.board; // the task board, when the map is opened inside it
  const issues = (SC.graph.health && SC.graph.health.issues) || [];
  // a blueprint (planned, not built) gets a design review of the plan instead of a code check
  const PLAN = !!SC.graph.meta.blueprint;
  const FIX = PLAN ? 'Resolver' : 'Corrigir';
  const fixLabel = `${FIX} com o ${A.name}`;
  const REVIEW = PLAN ? 'revisão da planta' : 'verificação de saúde';

  const SEV = {
    high: { color: 'var(--sev-high)', group: 'Corrija primeiro', word: (n) => (n === 1 ? 'importante' : 'importantes') },
    medium: { color: 'var(--sev-medium)', group: 'Vale corrigir logo', word: () => 'a corrigir' },
    low: { color: 'var(--sev-low)', group: 'Bom arrumar quando der', word: (n) => (n === 1 ? 'menor' : 'menores') },
  };
  const ORDER = ['high', 'medium', 'low'];
  const count = (sev) => issues.filter((i) => i.severity === sev).length;
  const urgent = count('high') + count('medium');
  const sevText = (s) => `${count(s)} ${SEV[s].word(count(s))}`;

  SC.icons.health = '<path d="M3 12h4l2.5-6 4 12 2.5-6H21"/>';
  SC.icons.check = '<path d="m5 12.5 4.5 4.5L19 7.5"/>';

  const style = document.createElement('style');
  style.textContent = `
    .hc-issue { padding: 12px 14px; border-radius: 16px; background: rgba(var(--ink), .04); margin-bottom: 8px; }
    .hc-issue:last-child { margin-bottom: 0; }
    .hc-t { display: flex; gap: 9px; align-items: flex-start; font-weight: 500; line-height: 1.4; }
    .hc-t .dot { margin-top: 6px; }
    .hc-d { color: var(--text-2); font-size: 12.5px; line-height: 1.55; margin: 6px 0 0 17px; }
    .hc-n { color: var(--text-3); font-size: 12.5px; line-height: 1.45; margin: 4px 0 0 17px; }
    .hc-w { font-family: var(--mono); font-size: 11px; color: var(--text-3); margin: 6px 0 0 17px; word-break: break-all; line-height: 1.5; }
    .hc-a { display: flex; gap: 6px; flex-wrap: wrap; margin: 10px 0 0 17px; }
    .hc-a .btn { height: 30px; padding: 0 12px; font-size: 12.5px; gap: 6px; }
    .hc-a .btn svg.i { width: 14px; height: 14px; }
    .hc-calm { margin-top: 14px; padding: 11px 13px; border-radius: 14px; background: var(--ok-bg); color: var(--ok-text); font-size: 13px; line-height: 1.55; }
    .hc-sub { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 12px; font-size: 12px; color: var(--text-2); }
    .hc-sub span { display: inline-flex; align-items: center; gap: 6px; }
    #btn-health .badge { background: var(--hc-badge, var(--on)); color: var(--hc-badge-text, var(--on-text)); }
    #btn-health.calm svg.i { color: var(--ok); }
    #modal .hc-hint { margin: 0; }
    #modal .hc-hint b { color: var(--text); font-weight: 500; }
  `;
  document.head.appendChild(style);

  // ---------- actions ----------
  let isOpen = false, openedAt = null;
  const where = () => JSON.stringify([SC.state.selected, SC.state.container]);
  function closeList() { isOpen = false; SC.closePanel(); }
  function showOnMap(issue) {
    const items = (issue.items || []).filter((id) => SC.exists(id)).map((id) => ({ id, note: (issue.notes && issue.notes[id]) || '' }));
    if (!items.length) { SC.toast(`Este não aparece no mapa. Use “${fixLabel}”.`); return; }
    if (isOpen) closeList();
    SC.showBoard({ title: issue.title, question: issue.detail, items });
  }
  // a served blueprint settles review items on the map: the request goes into the Ask bar's Change mode,
  // for the person to finish (an open question needs their answer) or edit, then send
  const here = (issue) => PLAN && !!issue.change && !!SC.canChange?.();
  function resolveHere(issue) {
    if (isOpen) closeList();
    if (!SC.draftChange(issue.change)) { fixWith(issue); return; }
    SC.toast(issue.kind === 'question' ? 'Digite sua resposta e pressione Enter' : 'Edite o pedido se quiser e pressione Enter');
  }
  function fixWith(issue) {
    SC.modal({
      title: fixLabel,
      html: `<p class="hc-hint">Copie este pedido e cole no <b>${A.app}</b>, aberto na pasta do projeto. Ele explica o que mudar e pergunta antes de qualquer coisa arriscada.</p><pre>${h(issue.fix)}</pre>`,
      actions: [{ label: 'Copiar pedido', primary: true, icon: 'copy', onClick: () => { SC.copy(issue.fix); SC.toast(`Copiado. Cole no ${A.app}.`); } }],
    });
  }
  const onMap = (issue) => (issue.items || []).some((id) => SC.exists(id));

  // ---------- a task on the board for an issue ----------
  const ORIGIN = PLAN ? 'revisao' : 'saude';
  /** The endpoints ("POST /api/notes") and files ("src/config.js:12") an issue points at. */
  function placesOf(issue) {
    const eps = [], files = [];
    for (const id of issue.items || []) {
      if (id.startsWith('r:')) { const r = SC.routes[+id.slice(2)]; if (r) eps.push({ text: `${r.m} ${r.p}`, file: `${r.f}${r.l > 1 ? ':' + r.l : ''}` }); }
      else if (id.startsWith('f:')) files.push(id.slice(2));
    }
    const locs = (issue.locations || []).map((l) => `${l.file}${l.line > 1 ? ':' + l.line : ''}`);
    return { eps, files: [...new Set([...locs, ...files])] };
  }
  /** A fence longer than any run of backticks inside, so the prompt survives as one block. */
  const fenced = (text) => { const run = Math.max(2, ...(String(text).match(/`+/g) || []).map((m) => m.length)); const f = '`'.repeat(run + 1); return `${f}\n${text}\n${f}`; };
  function issueTask(issue) {
    const { eps, files } = placesOf(issue);
    const first = eps[0]?.text || files[0]?.replace(/:\d+$/, '') || '';
    const extra = (eps.length || files.length) - 1;
    const what = first ? `${first}${extra > 0 ? ` e mais ${extra}` : ''}` : '';
    const title = what && !issue.title.includes(first) ? `${issue.title} — ${what}` : issue.title;
    const lines = [...eps.map((e) => `- ${e.text} (${e.file})`), ...files.map((f) => `- ${f}`)].slice(0, 30);
    return {
      title: title.slice(0, 300),
      description: [
        issue.detail || '',
        '',
        `Pedido pronto para ${FIX.toLowerCase()} com o ${A.name} (cole no ${A.app}, aberto na pasta do projeto):`,
        '',
        fenced(issue.fix || ''),
        ...(lines.length ? ['', 'Onde:', ...lines] : []),
        '',
        `Criada a partir da ${REVIEW} do Mapa do código.`,
      ].join('\n'),
      priority: issue.severity === 'high' ? 'high' : 'medium',
      tags: [PLAN ? 'revisão' : 'saúde'],
      origin: { kind: ORIGIN, id: issue.id },
    };
  }
  const taskBtn = (issue, idx) => {
    if (!B?.canEdit || SC.exported) return '';
    const done = B.created(ORIGIN, issue.id);
    return done ? B.resultHtml(done) : `<button class="btn soft" data-hc-task="${idx}">${SC.iconI('board')}Criar tarefa no quadro</button>`;
  };

  // ---------- html ----------
  const locText = (issue) => {
    const locs = issue.locations || [];
    if (!SC.technical() || !locs.length) return '';
    const shown = locs.slice(0, 3).map((l) => `${l.file}${l.line > 1 ? ':' + l.line : ''}`);
    return `<div class="hc-w">${shown.map(h).join('<br>')}${locs.length > 3 ? `<br>+${locs.length - 3} outros` : ''}</div>`;
  };
  const issueHtml = (issue, idx, note) => `<div class="hc-issue">
      <div class="hc-t"><span class="dot" style="background:${SEV[issue.severity].color}"></span><span>${h(issue.title)}</span></div>
      ${note ? `<div class="hc-n">${h(note)}</div>` : `<div class="hc-d">${h(issue.detail)}</div>`}
      ${locText(issue)}
      <div class="hc-a">
        ${onMap(issue) ? `<button class="btn soft" data-hc-show="${idx}">${SC.iconI('search')}Mostrar no mapa</button>` : ''}
        ${SC.exported ? '' : here(issue) ? `<button class="btn soft" data-hc-here="${idx}">${SC.iconI('spark')}Resolver no mapa</button>` : `<button class="btn soft" data-hc-fix="${idx}">${SC.iconI('spark')}${h(fixLabel)}</button>`}
        ${taskBtn(issue, idx)}
      </div>
    </div>`;
  const bindIssues = (el) => {
    el.querySelectorAll('[data-hc-show]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); showOnMap(issues[+b.dataset.hcShow]); }));
    el.querySelectorAll('[data-hc-fix]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); fixWith(issues[+b.dataset.hcFix]); }));
    el.querySelectorAll('[data-hc-here]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); resolveHere(issues[+b.dataset.hcHere]); }));
    if (B) {
      el.querySelectorAll('[data-hc-task]').forEach((b) => B.wire(b, () => issueTask(issues[+b.dataset.hcTask])));
      B.bindResults(el);
    }
  };
  const headline = () => urgent ? `${SC.plural(urgent, 'ponto precisa', 'pontos precisam')} de atenção` : issues.length ? 'Nada urgente' : 'Nenhum problema encontrado';
  const breakdown = () => `<div class="hc-sub">${ORDER.filter(count).map((s) => `<span><i class="dot" style="background:${SEV[s].color}"></i>${sevText(s)}</span>`).join('')}</div>`;

  function listHtml() {
    const top = `<div class="sec">
        <div class="ph"><span class="ico" style="--c:${urgent ? SEV[count('high') ? 'high' : 'medium'].color : 'var(--ok)'}">${SC.icon('health')}</span><span class="kindlabel">${PLAN ? 'Revisão da planta' : 'Verificação de saúde'}</span></div>
        <h2 class="pt">${h(headline())}</h2>
        <p class="pd">${PLAN ? 'Conferimos no plano as partes que qualquer pessoa na internet poderia usar, as decisões que o PRD deixa em aberto e as peças que não se ligam a nada. Resolver isso agora sai mais barato do que depois de construído.' : 'Procuramos chaves deixadas no código ou enviadas ao navegador, dados e partes do app que qualquer pessoa na internet alcança (tabelas do Supabase, regras do Firebase, webhooks do Stripe, endpoints), arquivos que sobraram e arquivos grandes demais para editar com segurança. É uma verificação rápida, não uma auditoria de segurança.'}</p>
        ${issues.length ? breakdown() : `<div class="hc-calm">Nada chamou atenção. É uma verificação automática e rápida, não uma revisão completa ${PLAN ? 'do projeto' : 'de segurança'}.</div>`}
        <div class="actions"><button class="btn soft" data-hc-back>${SC.iconI('left')}Voltar</button></div>
      </div>`;
    const groups = ORDER.map((sev) => {
      const list = issues.map((i, idx) => [i, idx]).filter(([i]) => i.severity === sev);
      return list.length ? `<div class="sec"><h3>${h(SEV[sev].group)} <span class="c">${list.length}</span></h3>${list.map(([i, idx]) => issueHtml(i, idx)).join('')}</div>` : '';
    }).join('');
    const board = B?.canEdit ? ' “Criar tarefa no quadro” guarda o problema como uma tarefa deste projeto, com o pedido pronto dentro.' : '';
    const foot = !issues.length ? '' : SC.exported ? `<div class="sec" style="color:var(--text-3);font-size:12px;line-height:1.6">São dicas automáticas do momento em que esta cópia foi exportada.</div>` : `<div class="sec" style="color:var(--text-3);font-size:12px;line-height:1.6">São dicas automáticas. ${issues.some(here)
      ? `“Resolver no mapa” coloca um pedido no modo Alterar da barra Perguntar: complete ou edite, pressione Enter e o ${A.name} atualiza o plano e redesenha o mapa. Desfazer volta como estava.`
      : `“${fixLabel}” dá um pedido para colar no ${A.app}; ${PLAN ? 'ele explica a escolha e atualiza o plano quando você decidir' : 'ele confere o código antes de mudar qualquer coisa'}.`}${board}</div>`;
    return top + groups + foot;
  }
  function openList() {
    isOpen = true;
    openedAt = where();
    SC.showPanel(listHtml(), (panel) => {
      panel.querySelector('[data-hc-back]')?.addEventListener('click', closeList);
      bindIssues(panel);
    });
  }

  // ---------- chrome ----------
  const btn = SC.addHeaderButton({
    id: 'btn-health', label: PLAN ? 'Revisão' : 'Saúde', icon: urgent ? 'health' : 'check',
    title: `${PLAN ? 'Revisão da planta' : 'Verificação de saúde'}: ${urgent ? headline() : 'nada urgente'}`,
    onClick: () => (isOpen ? closeList() : openList()),
  });
  if (urgent) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = urgent > 99 ? '99+' : String(urgent);
    btn.style.setProperty('--hc-badge', count('high') ? SEV.high.color : SEV.medium.color);
    btn.style.setProperty('--hc-badge-text', 'var(--on-sev-text)');
    btn.appendChild(b);
  } else btn.classList.add('calm');
  btn.setAttribute('aria-label', btn.title); // keeps its name, with the count, when only the icon shows

  // Selecting something else on the map while the list is open shows that item instead.
  SC.on('panel', () => { if (isOpen && openedAt && where() !== openedAt) { isOpen = false; SC.closePanel(); } });

  SC.addPanelSection('overview', () => ({
    html: `<div class="sec"><h3>${PLAN ? 'Revisão da planta' : 'Saúde'}</h3><div class="list"><a class="row" data-hc-open>
        <span class="dot" style="background:${urgent ? SEV[count('high') ? 'high' : 'medium'].color : 'var(--ok)'}"></span>
        <span class="rt"><div class="rn">${h(headline())}</div><div class="rd">${issues.length ? ORDER.filter(count).map(sevText).join(' · ') : PLAN ? 'Verificação automática e rápida do plano' : 'Verificação automática e rápida de segredos, endpoints abertos e arquivos que sobraram'}</div></span>
        <span class="rc">${SC.iconI('right')}</span></a></div></div>`,
    bind: (el) => el.querySelector('[data-hc-open]')?.addEventListener('click', (ev) => { ev.preventDefault(); openList(); }),
  }));

  SC.addPanelSection('item', (itemId) => {
    if (!itemId || typeof itemId !== 'string' || !issues.length) return '';
    const hits = [];
    issues.forEach((issue, idx) => {
      const inside = (issue.items || []).filter((id) => id === itemId || (SC.exists(id) && SC.chain(id).includes(itemId)));
      if (!inside.length) return;
      const exact = issue.notes && inside.includes(itemId) ? issue.notes[itemId] : '';
      hits.push(issueHtml(issue, idx, exact || (inside.length > 1 || inside[0] !== itemId ? `Afeta ${SC.plural(inside.length, 'lugar', 'lugares')} aqui dentro` : '')));
    });
    if (!hits.length) return '';
    return { html: `<div class="sec"><h3>${PLAN ? 'Revisão da planta' : 'Saúde'} <span class="c">${hits.length}</span></h3>${hits.slice(0, 6).join('')}${hits.length > 6 ? `<div class="more" data-hc-open style="cursor:pointer">+${hits.length - 6} na ${REVIEW}</div>` : ''}</div>`, bind: (el) => { bindIssues(el); el.querySelector('[data-hc-open]')?.addEventListener('click', openList); } };
  });
})();
