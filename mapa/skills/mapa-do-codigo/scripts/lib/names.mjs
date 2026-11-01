// Nomes legíveis provisórios, usados até o agente escrever os de verdade em mapa-do-codigo/descricoes/.
import path from 'node:path';

const P = path.posix;
const ACRONYMS = /\b(api|ui|ux|id|ids|sku|skus|csv|url|urls|http|db|sql|bc|mcp|pos|gcs|s3|aws|gcp|jwt|pdf|ai|llm|cli|css|html|json|xml|oauth|sso|cdn|dns|ip|io|qa|ci|cd|crud|rpc|grpc|sdk|ttl|uuid|mtg)\b/g;
const GENERIC = /^(index|page|layout|route|routes|__init__|__main__|main|mod|lib|app|server|loading|error|not-found|template|default|handler|handlers|views?|urls|models?|schemas?|types?|constants?|utils?|helpers?|config|settings)$/i;

export function humanize(id) {
  let s = String(id)
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.\s]+/g, ' ')
    .trim()
    .toLowerCase();
  s = s.replace(ACRONYMS, (m) => m.toUpperCase());
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : String(id);
}

/** "Orders" → "orders", mas "API reports" continua "API reports" (uma sigla no começo não muda). */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
// "(shop)" → "shop" (grupos de rota); "[id]" → "detalhe id" (uma pasta de parâmetro é a página de um item)
const cleanSeg = (seg) => seg.replace(/^\((.*)\)$/, '$1').replace(/^\[\.{0,3}(.*)\]$/, 'detalhe $1');

// o papel de um arquivo de nome genérico, dito antes do nome da pasta: "Página de checkout"
const ROLES = { page: 'Página', layout: 'Layout', route: 'Rota', __init__: 'Pacote', loading: 'Tela de carregamento', error: 'Tela de erro', index: '' };

export function fallbackFileName(p) {
  const base = P.basename(p);
  const stem = base.replace(/\.(test|spec)(?=\.)/, '').replace(/\.[^.]+$/, '');
  const isTest = /\.(test|spec)\.[a-z]+$/i.test(base) || /^test_/.test(base) || /_test\.(py|go)$/.test(base);
  const core = stem.replace(/^test_/, '').replace(/_test$/, '');
  let name;
  if (GENERIC.test(core)) {
    const dirs = P.dirname(p).split('/').filter((d) => d && !/^(src|app|lib|pkg|internal)$/.test(d)).map(cleanSeg);
    const parent = dirs.slice(-1)[0] || '';
    const role = ROLES[core.toLowerCase()];
    if (!parent) name = humanize(core);
    else if (role === '') name = humanize(parent);
    else if (role === 'Pacote') name = `Pacote ${lowerFirst(humanize(parent))}`;
    else name = `${role ?? humanize(core)} de ${lowerFirst(humanize(parent))}`;
  } else name = humanize(core);
  return isTest ? `Testes de ${lowerFirst(name)}` : name;
}

const VERB = { GET: 'Buscar', POST: 'Criar', PUT: 'Substituir', PATCH: 'Atualizar', DELETE: 'Excluir' };

export function fallbackRouteName(r) {
  if (r.handler && !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)$/.test(r.handler)) return humanize(r.handler);
  const segs = r.path.split('/').filter((s) => s && !/[<{:[*]/.test(s));
  return `${VERB[r.method] || r.method} ${humanize(segs.slice(-2).join(' ') || 'raiz').toLowerCase()}`;
}

export const routeKey = (r) => `${r.method} ${r.path}`;
