// Idiomas do painel. As chaves são os próprios textos em português: t('Salvar') devolve a
// tradução do idioma atual (dicionários em i18n/<idioma>.js) ou o original quando falta.
// Variáveis: t('{n} tarefas', { n: 3 }).

export const LANGUAGES = { pt: 'Português', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch' };
const LOCALES = { pt: 'pt-BR', en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };

let current = 'pt';
let dict = {};

export const lang = () => current;
export const locale = () => LOCALES[current];

export async function setLanguage(code) {
  current = LANGUAGES[code] ? code : 'pt';
  dict = {};
  if (current !== 'pt') {
    try { dict = (await import(`./i18n/${current}.js`)).default; } catch { dict = {}; }
  }
  document.documentElement.lang = locale();
}

// Idioma escolhido pela pessoa > padrão do quadro (Configurações) > português.
export const pickLanguage = (userLang, boardDefault) => [userLang, boardDefault].find((l) => LANGUAGES[l]) || 'pt';

// Textos sem tradução no idioma atual (para conferir: window.__i18nMissing no console).
const missing = new Set();
if (typeof window !== 'undefined') window.__i18nMissing = missing;

export function t(text, vars) {
  if (current !== 'pt' && !(text in dict) && text) missing.add(text);
  let out = dict[text] ?? text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return out;
}

// Singular/plural: tn(n, '{n} tarefa', '{n} tarefas').
export const tn = (n, one, many, vars = {}) => t(n === 1 ? one : many, { n, ...vars });

// Marca um texto guardado agora e traduzido depois com t(variável): N_('Texto') devolve 'Texto'.
// Mapas inteiros de rótulos podem ser marcados com /* i18n */ antes do { ou [ (veja scripts/i18n.js).
export const N_ = (text) => text;
