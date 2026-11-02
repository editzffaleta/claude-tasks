// Diálogos, confirmações e menus flutuantes reutilizáveis.
import { t } from './i18n.js';
import { $, ICON, esc } from './util.js';

// body: HTML do formulário. onSubmit(form) pode devolver false para manter aberto.
// onClose roda uma vez quando o diálogo fecha, por qualquer caminho (não depende do evento
// "close", que não dispara se o elemento já saiu da página).
export function openDialog({ title, body, submitLabel = t('Salvar'), cancelLabel = t('Cancelar'), danger = false, wide = false, onSubmit, onOpen, onClose, footer = '' }) {
  const dialog = document.createElement('dialog');
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  dialog.className = `dialog${wide ? ' wide' : ''}`;
  dialog.setAttribute('aria-labelledby', titleId);
  dialog.innerHTML = `
    <form method="dialog">
      <div class="dialog-head">
        <h2 id="${titleId}">${esc(title)}</h2>
        <button type="button" class="icon-btn small" data-close aria-label="${esc(t('Fechar'))}">${ICON.close}</button>
      </div>
      <div class="dialog-body">${body}</div>
      <div class="dialog-foot">
        ${footer}
        <span class="spacer"></span>
        ${cancelLabel ? `<button type="button" class="btn ghost" data-close>${esc(cancelLabel)}</button>` : ''}
        ${onSubmit ? `<button type="submit" class="btn ${danger ? 'danger-solid' : 'primary'}">${esc(submitLabel)}</button>` : ''}
      </div>
    </form>`;
  document.body.append(dialog);
  const form = $('form', dialog);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose?.();
  };
  dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]') || e.target === dialog) close();
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) form.requestSubmit();
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try {
      if ((await onSubmit?.(form, dialog)) !== false) close();
    } finally {
      btn.disabled = false;
    }
  });
  dialog.showModal();
  onOpen?.(form, dialog);
  $('input:not([type=hidden]):not([type=checkbox]), textarea, select', form)?.focus();
  return { dialog, form, close };
}

export function confirmAction(message, { title = t('Confirmar'), okLabel = t('Confirmar'), danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    openDialog({
      title,
      body: `<p class="dialog-text">${esc(message)}</p>`,
      submitLabel: okLabel,
      danger,
      onSubmit: () => { ok = true; },
      onClose: () => resolve(ok),
    });
  });
}

export function promptText({ title, label, value = '', placeholder = '', okLabel = t('Salvar') }) {
  return new Promise((resolve) => {
    let result = null;
    openDialog({
      title,
      body: `<label class="field"><span>${esc(label)}</span><input class="input" name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" required></label>`,
      submitLabel: okLabel,
      onSubmit: (form) => { result = form.elements.value.value.trim() || null; },
      onClose: () => resolve(result),
    });
  });
}

// Menu flutuante ancorado num elemento. items: [{ label, icon, onClick, danger, checked, divider, hint }]
// Abre com o foco no primeiro item (ou no marcado): setas, Home/End e a inicial do nome andam pelos
// itens, Esc e Tab fecham e devolvem o foco ao botão. keepFocus deixa o foco onde está (sugestões
// de @menção enquanto se digita no campo).
let openMenuEl = null;
let openMenuAnchor = null;
export function showMenu(anchor, items, { align = 'left', keepFocus = false } = {}) {
  // Clicar de novo no botão que abriu o menu fecha o menu.
  if (!keepFocus && openMenuEl && openMenuAnchor === anchor) return closeMenu({ restore: true });
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu-pop floating';
  if (!keepFocus) menu.setAttribute('role', 'menu');
  const name = anchor.getAttribute('aria-label') || anchor.textContent.trim();
  if (name && !keepFocus) menu.setAttribute('aria-label', name);
  menu.innerHTML = items.map((it, i) => (it.divider
    ? '<div class="menu-divider" role="separator"></div>'
    : it.heading
      ? `<div class="menu-heading" role="presentation">${esc(it.heading)}</div>`
      : `<button type="button" tabindex="-1" data-i="${i}" role="${'checked' in it ? 'menuitemcheckbox' : 'menuitem'}" ${'checked' in it ? `aria-checked="${!!it.checked}"` : ''} class="${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}">
          ${it.icon || ''}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}${it.checked ? ICON.check : ''}
        </button>`)).join('');
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = align === 'right' ? r.right - w : r.left;
  left = Math.max(8, Math.min(left, innerWidth - w - 8));
  let top = r.bottom + 6;
  if (top + h > innerHeight - 8) top = Math.max(8, r.top - h - 6);
  Object.assign(menu.style, { left: `${left}px`, top: `${top}px` });
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-i]');
    if (!btn) return;
    closeMenu({ restore: !keepFocus });
    items[Number(btn.dataset.i)].onClick?.();
  });
  openMenuEl = menu;
  openMenuAnchor = keepFocus ? null : anchor;
  if (!keepFocus) {
    anchor.setAttribute('aria-haspopup', 'menu');
    anchor.setAttribute('aria-expanded', 'true');
    menu.addEventListener('keydown', (e) => onMenuKey(e, menu));
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('[data-i]'))?.focus();
  }
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}

function onMenuKey(e, menu) {
  // As teclas ficam com o menu: os atalhos de uma tecla do painel não valem aqui dentro.
  e.stopPropagation();
  const list = [...menu.querySelectorAll('[data-i]')];
  const at = list.indexOf(document.activeElement);
  const go = (i) => { e.preventDefault(); list[(i + list.length) % list.length]?.focus(); };
  if (e.key === 'ArrowDown') return go(at + 1);
  if (e.key === 'ArrowUp') return go(at < 0 ? -1 : at - 1);
  if (e.key === 'Home') return go(0);
  if (e.key === 'End') return go(-1);
  if (e.key === 'Tab') { e.preventDefault(); return closeMenu({ restore: true }); }
  if (e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const key = e.key.toLowerCase();
    const label = (b) => b.querySelector('span:not(.dot):not(.avatar)')?.textContent.trim().toLowerCase() || b.textContent.trim().toLowerCase();
    const next = [...list.slice(at + 1), ...list.slice(0, at + 1)].find((b) => label(b).startsWith(key));
    next?.focus();
  }
}

function outside(e) {
  if (!openMenuEl || openMenuEl.contains(e.target) || openMenuAnchor?.contains(e.target)) return;
  closeMenu();
}

export function closeMenu({ restore = false } = {}) {
  const anchor = openMenuAnchor;
  openMenuEl?.remove();
  openMenuEl = null;
  openMenuAnchor = null;
  document.removeEventListener('pointerdown', outside, true);
  if (!anchor) return;
  anchor.setAttribute('aria-expanded', 'false');
  if (restore && anchor.isConnected) anchor.focus();
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenuEl) { e.stopPropagation(); closeMenu({ restore: true }); } }, true);
