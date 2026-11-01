// Aba "Mapa do código" de um projeto: mostra o mapa gerado pelo plugin (mapa-do-codigo/) num
// iframe servido pelo quadro, ou explica como gerar quando ainda não existe.
import { api, attempt, toast } from './api.js';
import { openTask } from './drawer.js';
import { t, tn } from './i18n.js';
import { currentProject, load, state, subscribe } from './state.js';
import { ICON, ago, esc, fmtNumber, tilde } from './util.js';

// Pedidos do mapa (dentro do iframe) para o painel: abrir uma tarefa, recarregar o quadro.
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  if (e.data.type === 'mapa:abrir-tarefa' && Number(e.data.id)) openTask(Number(e.data.id));
  if (e.data.type === 'mapa:tarefa-criada') load();
});

// Quando o quadro muda (outra aba, o Claude, uma automação), o mapa recarrega as tarefas dos cartões.
subscribe((what) => {
  if (what !== 'data') return;
  const frame = document.querySelector('iframe.mapa-frame');
  frame?.contentWindow?.postMessage({ type: 'mapa:tarefas-mudaram' }, location.origin);
});

const copy = (text) => navigator.clipboard.writeText(text).then(() => toast(t('Copiado'))).catch(() => toast(text));

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
              ${install.map((c) => `<div class="copy-row"><code>${esc(c)}</code><button class="btn ghost small" data-copy="${esc(c)}">${ICON.copy}</button></div>`).join('')}
              <small class="hint">${t('No Codex: {cmd} e depois instale “Mapa do código” em Plugins.', { cmd: `<code>${esc(installCodex)}</code>` })}</small>
            </li>
            <li>${t('Abra uma sessão do Claude Code (ou do Codex) na pasta do projeto, {path}, e peça:', { path: `<code>${esc(tilde(project.path))}</code>` })}
              <div class="copy-row"><code>${esc(ask)}</code><button class="btn ghost small" data-copy="${esc(ask)}">${ICON.copy}</button></div>
            </li>
            <li>${t('Volte aqui: o mapa aparece nesta aba e se atualiza sozinho quando o Claude refaz o mapa.')}</li>
          </ol>
          <div class="row"><button class="btn ghost bordered" data-refresh>${ICON.repeat} ${t('Conferir de novo')}</button></div>`
        : `<p class="notice">${esc(status.reason || t('Este projeto não tem pasta no computador.'))}</p>`}
      </section>
    </div>`;
}

function header(status) {
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
  return `
    <div class="mapa-barra">
      <span class="muted small">${bits.map(esc).join(' · ')}</span>
      ${health}
      <span class="spacer"></span>
      <button class="btn ghost small" data-copy-ask>${ICON.copy}${t('Pedir atualização ao Claude')}</button>
      <a class="btn ghost small" href="/mapa/${state.projectId}/" target="_blank" rel="noopener">${ICON.share}${t('Abrir em outra aba')}</a>
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
  } else {
    el.innerHTML = `${header(status)}<iframe class="mapa-frame" src="/mapa/${project.id}/" title="${esc(t('Mapa do código de {nome}', { nome: project.name }))}"></iframe>`;
  }
  el.onclick = async (e) => {
    const c = e.target.closest('[data-copy]');
    if (c) return copy(c.dataset.copy);
    if (e.target.closest('[data-copy-ask]')) return copy(t('Atualize o mapa do código deste projeto'));
    if (e.target.closest('[data-refresh]')) renderMapa(el);
  };
}
