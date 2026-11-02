// Editor de markdown: barra de formatação, atalhos (⌘B, ⌘I, ⌘K) e autocompletar de @menções.
import { N_, t } from './i18n.js';
import { state } from './state.js';
import { closeMenu, showMenu } from './ui.js';
import { ICON, avatar, esc } from './util.js';

const TOOLS = [
  ['bold', ICON.bold, N_('Negrito (⌘B)')],
  ['italic', ICON.italic, N_('Itálico (⌘I)')],
  ['heading', '<b class="tool-h">H</b>', N_('Título')],
  ['list', ICON.list, N_('Lista')],
  ['checklist', ICON.checklist, N_('Lista de tarefas')],
  ['quote', ICON.quote, N_('Citação')],
  ['code', ICON.code, N_('Código')],
  ['link', ICON.link, N_('Link (⌘K)')],
  ['mention', ICON.at, N_('Mencionar alguém')],
];

export function toolbar(target) {
  return `<div class="md-toolbar" data-editor="${target}" role="toolbar" aria-label="${esc(t('Formatação'))}">
    ${TOOLS.map(([kind, icon, label]) => `<button type="button" class="tool" data-format="${kind}" title="${esc(t(label))}" aria-label="${esc(t(label))}">${icon}</button>`).join('')}
  </div>`;
}

function replaceSelection(el, fn) {
  const { selectionStart: a, selectionEnd: b, value } = el;
  const { text, select = [0, 0] } = fn(value.slice(a, b), value, a, b);
  el.setRangeText(text, a, b, 'end');
  el.setSelectionRange(a + select[0], a + (select[1] || text.length));
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Prefixa cada linha selecionada (listas, citação, título).
function prefixLines(el, prefix) {
  const { value } = el;
  const start = value.lastIndexOf('\n', el.selectionStart - 1) + 1;
  let end = value.indexOf('\n', el.selectionEnd);
  if (end < 0) end = value.length;
  el.setSelectionRange(start, end);
  replaceSelection(el, (sel) => {
    const lines = sel.split('\n');
    const all = lines.every((l) => l.startsWith(prefix));
    const text = lines.map((l) => (all ? l.slice(prefix.length) : prefix + l)).join('\n');
    return { text, select: [text.length, text.length] };
  });
}

const wrap = (el, mark, placeholder) => replaceSelection(el, (sel) => {
  const inner = sel || placeholder;
  return { text: `${mark}${inner}${mark}`, select: [mark.length, mark.length + inner.length] };
});

export function applyFormat(el, kind) {
  if (!el) return;
  if (kind === 'bold') wrap(el, '**', t('texto'));
  if (kind === 'italic') wrap(el, '*', t('texto'));
  if (kind === 'code') {
    const multi = el.value.slice(el.selectionStart, el.selectionEnd).includes('\n');
    if (multi) replaceSelection(el, (sel) => ({ text: `\`\`\`\n${sel}\n\`\`\``, select: [4, 4 + sel.length] }));
    else wrap(el, '`', t('código'));
  }
  if (kind === 'heading') prefixLines(el, '### ');
  if (kind === 'list') prefixLines(el, '- ');
  if (kind === 'checklist') prefixLines(el, '- [ ] ');
  if (kind === 'quote') prefixLines(el, '> ');
  if (kind === 'link') {
    replaceSelection(el, (sel) => {
      const label = sel || t('texto');
      const text = `[${label}](https://)`;
      return { text, select: [label.length + 3, text.length - 1] };
    });
  }
  if (kind === 'mention') {
    replaceSelection(el, () => ({ text: '@', select: [1, 1] }));
    suggestMentions(el);
  }
}

// Nome usado na menção: primeiro nome, ou nome completo se houver outra pessoa com o mesmo primeiro nome.
function mentionName(u) {
  const first = u.name.split(/\s+/)[0];
  const clash = state.users.some((x) => x.id !== u.id && x.name.split(/\s+/)[0].toLowerCase() === first.toLowerCase());
  return clash ? u.name : first;
}

function suggestMentions(el) {
  const before = el.value.slice(0, el.selectionStart);
  const m = before.match(/(^|\s)@([\p{L}\p{N}._-]*)$/u);
  if (!m) return closeMenu();
  const q = m[2].toLowerCase();
  const people = state.users.filter((u) => u.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || u.email.toLowerCase().startsWith(q)).slice(0, 8);
  if (!people.length) return closeMenu();
  showMenu(el, people.map((u) => ({
    label: u.name,
    icon: avatar(u, { size: 18 }),
    hint: u.email,
    onClick: () => {
      const start = el.selectionStart - m[2].length;
      el.setRangeText(`${mentionName(u)} `, start, el.selectionStart, 'end');
      el.focus();
      el.dispatchEvent(new Event('input', { bubbles: true }));
    },
  })), { keepFocus: true });
}

// Liga a barra e os atalhos dentro de um container (o painel da tarefa usa delegação).
export function bindEditor(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-format]');
    if (!b) return;
    e.preventDefault();
    const target = b.closest('[data-editor]').dataset.editor;
    applyFormat(root.querySelector(`#${target}`), b.dataset.format);
  });
  root.addEventListener('keydown', (e) => {
    const el = e.target;
    if (!el.matches?.('textarea[data-md]')) return;
    if (!(e.metaKey || e.ctrlKey)) return;
    const kind = { b: 'bold', i: 'italic', k: 'link' }[e.key.toLowerCase()];
    if (kind) { e.preventDefault(); e.stopPropagation(); applyFormat(el, kind); }
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches?.('textarea[data-md]')) suggestMentions(e.target);
  });
}

export const mentionNames = () => state.users.map((u) => u.name);
