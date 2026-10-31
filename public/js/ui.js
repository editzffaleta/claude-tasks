// Diálogos, confirmações e menus flutuantes reutilizáveis.
import { $, ICON, esc } from './util.js';

// body: HTML do formulário. onSubmit(form) pode devolver false para manter aberto.
export function openDialog({ title, body, submitLabel = 'Salvar', cancelLabel = 'Cancelar', danger = false, wide = false, onSubmit, onOpen, footer = '' }) {
  const dialog = document.createElement('dialog');
  dialog.className = `dialog${wide ? ' wide' : ''}`;
  dialog.innerHTML = `
    <form method="dialog">
      <div class="dialog-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn small" data-close aria-label="Fechar">${ICON.close}</button>
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
  const close = () => { dialog.close(); dialog.remove(); };
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

export function confirmAction(message, { title = 'Confirmar', okLabel = 'Confirmar', danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const { dialog } = openDialog({
      title,
      body: `<p class="dialog-text">${esc(message)}</p>`,
      submitLabel: okLabel,
      danger,
      onSubmit: () => { ok = true; },
    });
    dialog.addEventListener('close', () => resolve(ok));
  });
}

export function promptText({ title, label, value = '', placeholder = '', okLabel = 'Salvar' }) {
  return new Promise((resolve) => {
    let result = null;
    const { dialog } = openDialog({
      title,
      body: `<label class="field"><span>${esc(label)}</span><input class="input" name="value" value="${esc(value)}" placeholder="${esc(placeholder)}" required></label>`,
      submitLabel: okLabel,
      onSubmit: (form) => { result = form.elements.value.value.trim() || null; },
    });
    dialog.addEventListener('close', () => resolve(result));
  });
}

// Menu flutuante ancorado num elemento. items: [{ label, icon, onClick, danger, checked, divider, hint }]
let openMenuEl = null;
export function showMenu(anchor, items, { align = 'left' } = {}) {
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu-pop floating';
  menu.innerHTML = items.map((it, i) => (it.divider
    ? '<div class="menu-divider"></div>'
    : it.heading
      ? `<div class="menu-heading">${esc(it.heading)}</div>`
      : `<button data-i="${i}" class="${it.danger ? 'danger' : ''} ${it.checked ? 'checked' : ''}">
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
    closeMenu();
    items[Number(btn.dataset.i)].onClick?.();
  });
  openMenuEl = menu;
  setTimeout(() => document.addEventListener('pointerdown', outside, true));
}

function outside(e) {
  if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu();
}

export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = null;
  document.removeEventListener('pointerdown', outside, true);
}

document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openMenuEl) { e.stopPropagation(); closeMenu(); } }, true);
