// Aba "Mapa do código" de um projeto: mostra o mapa gerado pelo plugin (mapa-do-codigo/) num
// iframe servido pelo quadro, ou explica como gerar quando ainda não existe. Ao lado do mapa fica a
// Simulação: onde o sistema quebra quando o tráfego sobe, medido pelo Breakscale.
import { api, attempt, toast } from './api.js';
import { openTask } from './drawer.js';
import { locale, t, tn } from './i18n.js';
import { can, currentProject, load, state, subscribe } from './state.js';
import { ICON, STATUS_LABEL, ago, esc, fmtNumber, tilde } from './util.js';

// Pedidos do mapa (dentro do iframe) para o painel: abrir uma tarefa, recarregar o quadro.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'mapa:abrir-tarefa' && Number(e.data.id)) openTask(Number(e.data.id));
  if (e.data.type === 'mapa:tarefa-criada') load();
});

// Mapa ou Simulação, por projeto, enquanto a página estiver aberta.
const modes = new Map();
let simEl = null;

// Quando o quadro muda (outra aba, o Claude, uma automação), o mapa recarrega as tarefas dos cartões
// e a simulação, as tarefas dos gargalos.
subscribe((what) => {
  if (what !== 'data') return;
  const frame = document.querySelector('iframe.mapa-frame');
  frame?.contentWindow?.postMessage({ type: 'mapa:tarefas-mudaram' }, location.origin);
  if (simEl?.isConnected && !simEl.hidden) renderSim(simEl, currentProject(), { quiet: true });
});

const copy = (text) => navigator.clipboard.writeText(text).then(() => toast(t('Copiado'))).catch(() => toast(text));
const copyRow = (text) => `<div class="copy-row"><code>${esc(text)}</code><button class="btn ghost small" data-copy="${esc(text)}" aria-label="${esc(t('Copiar'))}">${ICON.copy}</button></div>`;

function emptyState(project, status) {
  const ask = t('Faça o mapa do código deste projeto');
  const install = [
    'claude plugin marketplace add ~/Developer/claude-tasks',
    'claude plugin install mapa-do-codigo@claude-tasks',
  ];
  const installCodex = 'codex plugin marketplace add ~/Developer/claude-tasks';
  return `
    <div class="page narrow mapa-vazio">
      <section class="card-box">
        <h3>${ICON.map} ${t('Este projeto ainda não tem mapa do código')}</h3>
        <p>${t('O mapa mostra como o app funciona por dentro: as partes, os arquivos, as telas e as chamadas entre frontend e backend, tudo com nomes e descrições em português simples. Inclui uma verificação de saúde (chaves expostas, endpoints abertos), fluxos guiados e o que mudou recentemente.')}</p>
        ${status.available ? `
          <ol class="mapa-passos">
            <li>${t('Instale o plugin uma vez (no Terminal):')}
              ${install.map(copyRow).join('')}
              <small class="hint">${t('No Codex: {cmd} e depois instale “Mapa do código” em Plugins.', { cmd: `<code>${esc(installCodex)}</code>` })}</small>
            </li>
            <li>${t('Abra uma sessão do Claude Code (ou do Codex) na pasta do projeto, {path}, e peça:', { path: `<code>${esc(tilde(project.path))}</code>` })}
              ${copyRow(ask)}
            </li>
            <li>${t('Volte aqui: o mapa aparece nesta aba e se atualiza sozinho quando o Claude refaz o mapa.')}</li>
          </ol>
          <div class="row"><button class="btn ghost bordered" data-refresh>${ICON.repeat} ${t('Conferir de novo')}</button></div>`
        : `<p class="notice">${esc(status.reason || t('Este projeto não tem pasta no computador.'))}</p>`}
      </section>
    </div>`;
}

function header(status, mode) {
  const bits = [
    status.blueprint ? t('Planta (planejado a partir de um documento)') : null,
    status.files != null ? tn(status.files, '{n} arquivo', '{n} arquivos', { n: fmtNumber(status.files) }) : null,
    status.screens ? tn(status.screens, '{n} tela', '{n} telas') : null,
    status.endpoints ? tn(status.endpoints, '{n} endpoint', '{n} endpoints') : null,
    status.generated_at ? t('atualizado {quando}', { quando: ago(status.generated_at) }) : null,
  ].filter(Boolean);
  const health = status.health?.high
    ? `<span class="chip due overdue">${ICON.shield}${esc(tn(status.health.high, '{n} problema importante', '{n} problemas importantes'))}</span>`
    : status.health?.total ? `<span class="chip">${ICON.shield}${esc(tn(status.health.total, '{n} aviso', '{n} avisos'))}</span>` : '';
  const sim = status.simulation;
  const simCount = sim?.bottlenecks ? `<span class="count${sim.urgent ? ' hot' : ''}">${sim.bottlenecks}</span>` : '';
  return `
    <div class="mapa-barra">
      <div class="mapa-modo" role="tablist" aria-label="${esc(t('Mapa do código'))}">
        <button role="tab" data-modo="mapa" aria-selected="${mode === 'mapa'}">${ICON.map}${t('Mapa')}</button>
        <button role="tab" data-modo="sim" aria-selected="${mode === 'sim'}">${ICON.zap}${t('Simulação')}${simCount}</button>
      </div>
      <span class="muted small" data-only="mapa" ${mode === 'mapa' ? '' : 'hidden'}>${bits.map(esc).join(' · ')}</span>
      <span data-only="mapa" ${mode === 'mapa' ? '' : 'hidden'}>${health}</span>
      <span class="spacer"></span>
      <button class="btn ghost small" data-only="mapa" ${mode === 'mapa' ? '' : 'hidden'} data-copy-ask>${ICON.copy}${t('Pedir atualização ao Claude')}</button>
      <a class="btn ghost small" data-only="mapa" ${mode === 'mapa' ? '' : 'hidden'} href="/mapa/${state.projectId}/" target="_blank" rel="noopener">${ICON.share}${t('Abrir em outra aba')}</a>
    </div>`;
}

export async function renderMapa(el) {
  const project = currentProject();
  if (!project) {
    el.innerHTML = `<div class="page narrow"><section class="card-box"><p>${t('Escolha um projeto na barra lateral para ver o mapa do código dele.')}</p></section></div>`;
    return;
  }
  const status = await attempt(() => api(`/api/projects/${project.id}/mapa`));
  if (!status || state.projectId !== project.id) return;
  el.classList.add('mapa-view');
  if (!status.exists) {
    el.innerHTML = emptyState(project, status);
    simEl = null;
  } else {
    const mode = modes.get(project.id) || 'mapa';
    el.innerHTML = `${header(status, mode)}
      <iframe class="mapa-frame" src="/mapa/${project.id}/" title="${esc(t('Mapa do código de {nome}', { nome: project.name }))}" ${mode === 'mapa' ? '' : 'hidden'}></iframe>
      <div class="mapa-sim" ${mode === 'sim' ? '' : 'hidden'}></div>`;
    simEl = el.querySelector('.mapa-sim');
    if (mode === 'sim') renderSim(simEl, project, { status });
  }
  el.onclick = async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copy(c.dataset.copy);
    if (e.target.closest('[data-copy-ask]')) return copy(t('Atualize o mapa do código deste projeto'));
    if (e.target.closest('[data-refresh]')) return renderMapa(el);
    const m = e.target.closest('[data-modo]');
    if (m) return switchMode(el, project, m.dataset.modo, status);
    const open = e.target.closest('[data-task]');
    if (open) return openTask(Number(open.dataset.task));
    const make = e.target.closest('[data-gargalo], [data-gargalos]');
    if (make) return createTasks(make, project);
  };
}

function switchMode(el, project, mode, status) {
  modes.set(project.id, mode);
  for (const b of el.querySelectorAll('[data-modo]')) b.setAttribute('aria-selected', String(b.dataset.modo === mode));
  for (const x of el.querySelectorAll('[data-only="mapa"]')) x.hidden = mode !== 'mapa';
  el.querySelector('.mapa-frame').hidden = mode !== 'mapa';
  simEl.hidden = mode !== 'sim';
  if (mode === 'sim') renderSim(simEl, project, { status });
}

async function createTasks(btn, project) {
  const ids = btn.dataset.gargalos ? btn.dataset.gargalos.split('\n') : [btn.dataset.gargalo];
  btn.disabled = true;
  const r = await attempt(() => api(`/api/projects/${project.id}/mapa/simulacao/tarefas`, { method: 'POST', body: { ids } }));
  btn.disabled = false;
  if (!r) return;
  const made = r.tasks.filter((x) => !x.duplicate).length;
  toast(made ? tn(made, '{n} tarefa criada', '{n} tarefas criadas') : t('Essas tarefas já existiam'));
  load();
  renderSim(simEl, project, { quiet: true });
}

// ---- Simulação ----

const nf = (opts) => new Intl.NumberFormat(locale(), opts);
const fmtPct = (v) => (v == null ? '—' : nf({ style: 'percent', maximumFractionDigits: v > 0 && v < 0.01 ? 2 : 1 }).format(v));
const fmtRate = (v) => (v == null ? '—' : t('{n}/s', { n: nf({ maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v) }));
const fmtMs = (v) => (v == null ? '—' : v >= 1000 ? t('{n} s', { n: nf({ maximumFractionDigits: 1 }).format(v / 1000) }) : t('{n} ms', { n: nf({ maximumFractionDigits: 0 }).format(v) }));
const fmtFactor = (f) => `${nf({ maximumFractionDigits: 2 }).format(f)}×`;
const scenarioName = (s) => (s.fator === 1 ? t('Tráfego de base') : t('{f} o tráfego', { f: fmtFactor(s.fator) }));
const SEVERITY = { alta: () => t('Urgente'), media: () => t('Atenção'), baixa: () => t('Pode esperar') };
// Por que os pedidos falharam, pelos códigos do Breakscale.
const MOTIVO = /* i18n */ {
  error: 'falharam sozinhos (taxa de erro)',
  shed: 'recusados por fila cheia',
  timeout: 'tempo de espera esgotado',
  'no-route': 'sem caminho para seguir',
  depth: 'passaram do limite de saltos',
  throttled: 'barrados pelo limitador de taxa',
  rejected: 'barrados por disjuntor aberto',
  crashed: 'componente fora do ar',
  partitioned: 'ligação de rede cortada',
  'region-down': 'nenhuma região no ar',
  'conn-refused': 'conexão WebSocket recusada',
  unauthorized: 'falha de autenticação no gateway',
  'bulkhead-full': 'bulkhead cheio',
  'acquire-timeout': 'sem vaga no pool',
  deprioritized: 'descartados pelo controle de carga',
};
const heat = (v) => (v == null ? '' : v >= 0.9 ? 'hot' : v >= 0.7 ? 'warm' : '');

function simEmpty(project) {
  const ask = t('Simule este projeto no Breakscale');
  return `
    <div class="page narrow">
      <section class="card-box">
        <h3>${ICON.zap} ${t('Onde este sistema quebra?')}</h3>
        <p>${t('O Breakscale é um simulador de arquitetura: ele monta o sistema com servidores, bancos e filas, aumenta o tráfego e mede o que acontece com cada pedido. O Claude monta esse modelo a partir do mapa, ajusta os números pelo código e simula com 1×, 2×, 5× e 10× o tráfego.')}</p>
        <ol class="mapa-passos">
          <li>${t('Abra uma sessão do Claude Code (ou do Codex) na pasta do projeto, {path}, e peça:', { path: `<code>${esc(tilde(project.path))}</code>` })}
            ${copyRow(ask)}
          </li>
          <li>${t('O simulador roda neste computador (pacote breakscale-mcp, licença MIT). Na primeira vez o Claude pede para baixá-lo.')}</li>
          <li>${t('Os gargalos aparecem aqui, cada um com um botão para virar tarefa.')}</li>
        </ol>
        <div class="row"><button class="btn ghost bordered" data-refresh>${ICON.repeat} ${t('Conferir de novo')}</button></div>
      </section>
    </div>`;
}

async function renderSim(el, project, { status, quiet } = {}) {
  if (!el || !project) return;
  if (status && !status.simulation) { el.innerHTML = simEmpty(project); return; }
  if (!quiet && !el.innerHTML) el.innerHTML = `<div class="page narrow"><p class="muted">${t('Carregando…')}</p></div>`;
  const sim = await api(`/api/projects/${project.id}/mapa/simulacao`).catch((e) => (e.status === 404 ? null : Promise.reject(e))).catch(() => undefined);
  if (sim === undefined || state.projectId !== project.id) return;
  if (!sim) { el.innerHTML = simEmpty(project); return; }
  const canEdit = can(project, 'edit');
  const names = new Map(sim.componentes.map((c) => [c.id, c.nome]));
  const guessed = sim.premissas.filter((p) => p.origem !== 'código').length;
  const pending = sim.gargalos.filter((g) => !sim.tarefas[g.id]);
  const scenarios = [...sim.cenarios].sort((a, b) => a.fator - b.fator);
  const top = scenarios.at(-1);

  const gargalo = (g) => {
    const task = sim.tarefas[g.id];
    return `
      <li class="sim-gargalo sev-${g.severidade}">
        <div class="sim-gargalo-topo">
          <span class="chip sev">${esc(SEVERITY[g.severidade]())}</span>
          <strong>${esc(g.titulo)}</strong>
        </div>
        ${g.porque ? `<p>${esc(g.porque)}</p>` : ''}
        ${g.sugestao ? `<p class="sim-sugestao"><b>${t('Sugestão:')}</b> ${esc(g.sugestao)}</p>` : ''}
        <div class="row">
          ${task
            ? `<button class="btn ghost small" data-task="${task.id}">${ICON.check}${esc(t('Tarefa {ref}: {status}', { ref: task.ref, status: STATUS_LABEL[task.status] || task.status }))}</button>`
            : canEdit ? `<button class="btn ghost bordered small" data-gargalo="${esc(g.id)}">${ICON.plus}${t('Criar tarefa')}</button>` : ''}
        </div>
      </li>`;
  };

  const occupancy = sim.componentes
    .filter((c) => c.tipo !== 'client')
    .map((c) => `
      <tr>
        <th scope="row">${esc(c.nome || c.id)}</th>
        ${scenarios.map((s) => {
          const v = s.componentes.find((x) => x.id === c.id)?.ocupacao;
          return `<td class="num ${heat(v)}">${fmtPct(v)}</td>`;
        }).join('')}
      </tr>`).join('');

  el.innerHTML = `
    <div class="page sim-page">
      <section class="card-box sim-topo">
        <div class="sim-titulo">
          <h3>${ICON.zap} ${t('Onde o sistema quebra')}</h3>
          <span class="muted small">${esc([
            sim.geradoEm ? t('simulado {quando}', { quando: ago(sim.geradoEm) }) : null,
            tn(scenarios.length, '{n} cenário', '{n} cenários'),
            sim.origem === 'hospedado' ? t('no servidor do Breakscale') : t('neste computador'),
          ].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="sim-acoes">
          ${sim.link ? `<a class="btn primary small" href="${esc(sim.link)}" target="_blank" rel="noopener noreferrer">${ICON.share}${t('Abrir no Breakscale')}</a>` : ''}
          ${sim.temArquivo ? `<a class="btn ghost bordered small" href="/api/projects/${project.id}/mapa/simulacao/arquivo" download>${ICON.download}${t('Baixar arquivo .breakscale')}</a>` : ''}
          <button class="btn ghost small" data-copy="${esc(t('Simule de novo este projeto no Breakscale'))}">${ICON.copy}${t('Pedir nova simulação ao Claude')}</button>
        </div>
        <p class="hint">${guessed
          ? esc(tn(guessed, 'Os números vêm do simulador do Breakscale, que mede cada pedido simulado. {n} premissa ainda é estimativa: confira em Premissas antes de decidir.', 'Os números vêm do simulador do Breakscale, que mede cada pedido simulado. {n} premissas ainda são estimativas: confira em Premissas antes de decidir.'))
          : esc(t('Os números vêm do simulador do Breakscale, que mede cada pedido simulado. Todas as premissas vêm do código.'))}</p>
      </section>

      <section class="card-box">
        <div class="section-label">${t('Gargalos')} <span class="count">${sim.gargalos.length}</span>
          ${canEdit && pending.length > 1 ? `<button class="btn ghost small push" data-gargalos="${esc(pending.map((g) => g.id).join('\n'))}">${ICON.plus}${t('Criar tarefas para todos')}</button>` : ''}
        </div>
        ${sim.gargalos.length
          ? `<ul class="sim-gargalos">${sim.gargalos.map(gargalo).join('')}</ul>`
          : `<p class="muted">${esc(t('Nenhum componente quebrou até {f} o tráfego de base.', { f: top ? fmtFactor(top.fator) : '' }))}</p>`}
      </section>

      <section class="card-box">
        <div class="section-label">${t('Cenários')}</div>
        <div class="table-scroll">
          <table class="sim-tabela">
            <thead><tr>
              <th scope="col">${t('Cenário')}</th><th scope="col" class="num">${t('Chegando')}</th><th scope="col" class="num">${t('Atendidos')}</th>
              <th scope="col" class="num">${t('Falhas')}</th><th scope="col" class="num">p95</th><th scope="col" class="num">p99</th><th scope="col"></th>
            </tr></thead>
            <tbody>${scenarios.map((s) => `
              <tr>
                <th scope="row">${esc(scenarioName(s))}${s.interrompido ? ` <span class="chip" title="${esc(t('O simulador parou antes do fim: o modelo ficou pesado demais.'))}">${t('parcial')}</span>` : ''}</th>
                <td class="num">${fmtRate(s.oferecido)}</td><td class="num">${fmtRate(s.servido)}</td>
                <td class="num ${s.falhas >= 0.01 ? 'hot' : ''}">${fmtPct(s.falhas)}</td>
                <td class="num">${fmtMs(s.p95)}</td><td class="num">${fmtMs(s.p99)}</td>
                <td>${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener noreferrer" class="muted small">${t('abrir')}</a>` : ''}</td>
              </tr>
              ${s.motivos.length ? `<tr class="sim-motivos"><td colspan="7">${esc(s.motivos.map((m) => t('{motivo}: {n}', { n: fmtNumber(m.n), motivo: MOTIVO[m.motivo] ? t(MOTIVO[m.motivo]) : m.texto })).join(' · '))}</td></tr>` : ''}`).join('')}
            </tbody>
          </table>
        </div>
      </section>

      ${occupancy ? `
      <section class="card-box">
        <div class="section-label">${t('Ocupação de cada componente')}</div>
        <div class="table-scroll">
          <table class="sim-tabela">
            <thead><tr><th scope="col">${t('Componente')}</th>${scenarios.map((s) => `<th scope="col" class="num">${esc(scenarioName(s))}</th>`).join('')}</tr></thead>
            <tbody>${occupancy}</tbody>
          </table>
        </div>
        <p class="hint">${t('Acima de 90% o componente está no limite: os pedidos começam a esperar em fila.')}</p>
      </section>` : ''}

      <details class="card-box sim-detalhes">
        <summary>${t('Premissas')} <span class="count">${sim.premissas.length}</span></summary>
        <ul>${sim.premissas.map((p) => `
          <li><span class="chip ${p.origem === 'código' ? '' : 'guess'}">${p.origem === 'código' ? t('do código') : t('estimativa')}</span>
            ${p.componente && names.has(p.componente) ? `<b>${esc(names.get(p.componente))}:</b> ` : ''}${esc(p.texto)}</li>`).join('')}
        </ul>
      </details>

      ${sim.deixadoDeFora.length ? `
      <details class="card-box sim-detalhes">
        <summary>${t('Deixado de fora do modelo')} <span class="count">${sim.deixadoDeFora.length}</span></summary>
        <ul>${sim.deixadoDeFora.map((x) => `<li>${esc(x.texto)}</li>`).join('')}</ul>
      </details>` : ''}

      <p class="hint sim-credito">${t('Simulação feita com o Breakscale, projeto aberto (MIT) de xevrion. O link guarda o modelo depois do #, parte do endereço que o navegador não envia a nenhum servidor.')}</p>
    </div>`;
}
