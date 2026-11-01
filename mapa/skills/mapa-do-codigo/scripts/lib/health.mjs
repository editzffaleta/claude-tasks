// Health check: plain-language warnings about the codebase (secrets, endpoints anyone can call,
// the usual Supabase / Firebase / Stripe / CORS mistakes, unused files, oversized files), written for
// people who built an app with AI and don't know its insides. It's a check, not an audit. Precision
// beats recall: a false alarm costs this audience more than a missed one.
//
// findIssues(src, file)  — called by scan.mjs for every code/config/docs file with its source.
//                           Returns raw findings for that file, stored in scan.json files[].issues.
//                           Findings never contain a secret's value, only its line, kind and a masked hint.
// buildHealth(ctx)       — called by build.mjs with { graph, scan, arch, root } after the graph is built.
//                           Returns { summary: { high, medium, low }, issues: [...] }, stored as graph.health.

import fs from 'node:fs';
import path from 'node:path';
import { git, compileGlob } from './common.mjs';

const lineIndex = (src) => {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
};

/** Shannon entropy in bits per character: random keys score ~4+, words and placeholders ~2-3. */
function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) || 0) + 1);
  let e = 0;
  for (const n of counts.values()) { const p = n / s.length; e -= p * Math.log2(p); }
  return e;
}

// Files where keys are usually fake: tests, fixtures, examples, docs.
const TEST_FILE = /(^|\/)(tests?|__tests__|__mocks__|spec|specs|e2e|fixtures?|testdata|mocks?)\/|\.(test|spec|stories)\.[a-z]+$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|(^|\/)conftest\.py$/i;
const EXAMPLE_FILE = /(^|\/)(examples?|samples?|docs?|demo)\/|\.(example|sample|template|dist|tmpl)(\.|$)|(^|\/)[^/]*example[^/]*$/i;
const PLACEHOLDER = /your|xxxx|example|changeme|change[-_]?me|placeholder|replace|dummy|fake|sample|redacted|insert|<[^>]*>|\$\{|\{\{|%\(|\*\*\*|0{8,}|1234567|abcdef|_here\b|-here\b/i;

// ---------- 1. secrets ----------

// Well-known key formats. `sev` defaults to high; `live` formats are flagged even in test files.
const FORMATS = [
  { re: /\bAKIA[0-9A-Z]{16}\b/g, what: 'uma chave de acesso da AWS (Amazon Web Services)', svc: 'AWS', live: true },
  { re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/g, what: 'uma chave secreta de produção do Stripe', svc: 'Stripe', live: true },
  { re: /\b(?:sk|rk)_test_[0-9a-zA-Z]{20,}/g, what: 'uma chave de teste do Stripe', svc: 'Stripe', sev: 'medium' },
  { re: /\bwhsec_[A-Za-z0-9]{24,}/g, what: 'um segredo de assinatura de webhook do Stripe', svc: 'Stripe' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, what: 'um token de acesso do GitHub', svc: 'GitHub', live: true },
  { re: /\bgithub_pat_[A-Za-z0-9_]{50,}/g, what: 'um token de acesso do GitHub', svc: 'GitHub', live: true },
  { re: /\bglpat-[A-Za-z0-9_-]{20,}/g, what: 'um token de acesso do GitLab', svc: 'GitLab', live: true },
  { re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, what: 'um token do Slack', svc: 'Slack', live: true },
  { re: /https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}/g, what: 'um endereço de webhook do Slack (quem tiver esse endereço pode postar no seu Slack)', svc: 'Slack', sev: 'medium' },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/g, what: 'uma chave de API do Google', svc: 'Google Cloud', sev: 'medium', skipIf: /firebase|authDomain|messagingSenderId/i },
  { re: /\bGOCSPX-[A-Za-z0-9_\-]{20,}/g, what: 'um segredo de cliente do login do Google', svc: 'Google Cloud' },
  { re: /\bsk-ant-[a-z]+\d*-[A-Za-z0-9_\-]{40,}/g, what: 'uma chave de API do Claude, da Anthropic', svc: 'Anthropic', live: true },
  { re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}T3BlbkFJ[A-Za-z0-9_\-]{16,}/g, what: 'uma chave de API da OpenAI', svc: 'OpenAI', live: true },
  { re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_\-]{40,}/g, what: 'uma chave de API da OpenAI', svc: 'OpenAI', live: true },
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, what: 'uma chave privada', svc: null, whole: true },
  { re: /\bSG\.[A-Za-z0-9_\-]{22}\.[A-Za-z0-9_\-]{43}\b/g, what: 'uma chave de API de e-mail do SendGrid', svc: 'SendGrid', live: true },
  { re: /\bsq0csp-[0-9A-Za-z_\-]{40,}/g, what: 'um segredo de app do Square', svc: 'Square', live: true },
  { re: /\bsq0atp-[0-9A-Za-z_\-]{20,}/g, what: 'um token de acesso do Square', svc: 'Square', live: true },
  { re: /\bEAAA[A-Za-z0-9_\-]{60,}/g, what: 'um token de acesso do Square', svc: 'Square', live: true },
  { re: /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/g, what: 'um token de acesso da Shopify', svc: 'Shopify', live: true },
  { re: /\bhf_[A-Za-z0-9]{30,}\b/g, what: 'um token do Hugging Face', svc: 'Hugging Face', live: true },
  { re: /\bnpm_[A-Za-z0-9]{36}\b/g, what: 'um token de publicação do npm', svc: 'npm', live: true },
  { re: /\bsbp_[a-f0-9]{40}\b/g, what: 'um token de conta do Supabase', svc: 'Supabase', live: true },
  { re: /\bsb_secret_[A-Za-z0-9_\-]{20,}/g, what: 'uma chave secreta do Supabase', svc: 'Supabase', live: true },
  { re: /\b\d{8,10}:AA[0-9A-Za-z_\-]{33}\b/g, what: 'um token de bot do Telegram', svc: 'Telegram', live: true },
  { re: /\bdop_v1_[a-f0-9]{64}\b/g, what: 'um token da DigitalOcean', svc: 'DigitalOcean', live: true },
  { re: /\bpat[A-Za-z0-9]{14}\.[a-f0-9]{64}\b/g, what: 'um token do Airtable', svc: 'Airtable', live: true },
];
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/g;
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?)(?:\+\w+)?:\/\/([^:\s\/'"@]+):([^@\s'"]+)@([^\/\s'":?,]+)/g;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|db|postgres|mysql|redis|mongo|database|host\.docker\.internal)$/i;

// Names that hold secrets (after camelCase → snake_case). Public-by-design keys are excluded below.
const SECRET_NAME = /(?:^|[_.-])(api_?key|apikey|secret(?:_?key)?|client_?secret|app_?secret|token|access_?token|refresh_?token|auth_?token|authtoken|bearer_?token|passw(?:or)?d|passwd|pwd|private_?key|secret_?access_?key|signing_?(?:key|secret)|signature_?key|webhook_?secret|encryption_?key|auth(?:orization)?_?key|master_?key|credentials?)$/i;
const PUBLIC_NAME = /(^|_)(public|publishable|anon|site_?key|example|sample|test|dummy|fake|mock|placeholder|default|field|label|header|name|type|url|uri|endpoint|path|file|env|var|prefix|length|len|min|max|regex|pattern|format|expires?|ttl)(_|$)|^(next_public|vite|react_app|expo_public|nuxt_public|gatsby)_/i;
const ENV_LOOKUP = /os\.environ|os\.getenv|getenv\(|process\.env|import\.meta\.env|ENV\[|ENV\.fetch|System\.getenv|Deno\.env|secrets\.|config\(\s*['"]|env\(\s*['"]|\$\{\{/;
const PASSWORD_NAME = /pass|pwd/i;
const CONFIG_LANGS = new Set(['yaml', 'yml', 'ini', 'cfg', 'conf', 'properties', 'env', 'toml']);

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const kindFromName = (name) => {
  const n = snake(name);
  if (/pass|pwd/.test(n)) return 'uma senha';
  if (/private_?key/.test(n)) return 'uma chave privada';
  if (/token/.test(n)) return 'um token de acesso';
  if (/api_?key|apikey/.test(n)) return 'uma chave de API';
  if (/credential/.test(n)) return 'dados de login';
  return 'uma chave secreta';
};
const mask = (v, password) => password || v.length < 12 ? `${v.length} caracteres` : `começa com “${v.slice(0, 4)}…”, ${v.length} caracteres`;

function valueLooksReal(v, name) {
  if (/\s/.test(v) || PLACEHOLDER.test(v)) return false;
  if (/^(none|null|nil|undefined|true|false|string|number|text|required|optional|bearer|basic|secret|token|password|test|dev|development|local|admin)$/i.test(v)) return false;
  if (/^[A-Z][A-Z0-9_]+$/.test(v)) return false;                 // the NAME of an env var
  if (/^env\([A-Za-z_][\w]*\)$/.test(v)) return false;           // Supabase config.toml reading one: "env(S3_SECRET_KEY)"
  if (/^[a-z_]+(\.[a-z_]+)+$/i.test(v)) return false;            // dotted identifier / key path
  if (/^(\.{0,2}\/|~\/|https?:\/\/|[a-z]:\\)/i.test(v)) return false; // paths and URLs
  if (/\.(json|pem|key|txt|ya?ml|env|crt|p12)$/i.test(v)) return false; // a file name, not the key
  if (/^x-[\w-]+$/i.test(v) || /^(application|text)\//.test(v)) return false;
  // Valores do HTML para campos de senha (autocomplete="new-password"), não senhas.
  if (/^(new|current)-password$|^one-time-code$|^(username|email|webauthn)$/i.test(v)) return false;
  if (/^(.)\1+$/.test(v)) return false;
  if (/^(pass(word)?|secret|admin|test|user|changeit|letmein|qwerty|demo|guest|root|welcome)[\d!@#$._-]*$/i.test(v)) return false;
  if (PASSWORD_NAME.test(name)) return v.length >= 6 && !/^[a-z]+$/.test(v);
  return v.length >= 16 && entropy(v) >= 3.2 && /\d/.test(v) && /[a-zA-Z]/.test(v);
}

// Tokens that are public by design, because the browser has to send them: Cloudflare Web Analytics'
// beacon (data-cf-beacon='{"token":"…"}') and Mapbox public tokens (pk.…)
const PUBLIC_TOKEN_LINE = /data-cf-beacon|cloudflareinsights\.com/i;
const PUBLIC_TOKEN_VALUE = /^pk\.[\w-]{20,}\.[\w-]{10,}$/;

/** 1-based line numbers inside docstrings or block comments (examples there aren't real config). */
function docLines(src, lang) {
  const set = new Set();
  if (!['python', 'typescript', 'javascript', 'java', 'kotlin', 'go', 'csharp', 'php', 'rust', 'swift'].includes(lang)) return set;
  const re = lang === 'python' ? /("""|''')[\s\S]*?\1/g : /\/\*[\s\S]*?\*\//g;
  const at = lineIndex(src);
  for (const m of src.matchAll(re)) { const a = at(m.index), b = at(m.index + m[0].length); for (let l = a; l <= b; l++) set.add(l); }
  return set;
}

function findSecrets(src, f, out) {
  const at = lineIndex(src);
  const isTest = TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path);
  const seenLines = new Set();
  const add = (line, rec) => { if (seenLines.has(line)) return; seenLines.add(line); out.push({ k: 'secret', line, ...rec }); };

  for (const fm of FORMATS) {
    if (fm.skipIf?.test(src)) continue;
    for (const m of src.matchAll(fm.re)) {
      const v = m[0];
      if (isTest && (!fm.live || fm.whole)) continue;
      if (!fm.whole && (/EXAMPLE|xxxx|XXXX|0{10,}/.test(v) || entropy(v) < 3)) continue;
      add(at(m.index), { what: fm.what, svc: fm.svc, sev: fm.sev || 'high', hint: fm.whole ? 'bloco de chave privada' : mask(v) });
    }
  }
  if (!isTest) {
    for (const m of src.matchAll(JWT)) {
      let payload = null;
      try { payload = JSON.parse(Buffer.from(m[0].split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); } catch { continue; }
      if (payload?.role !== 'service_role') continue; // "anon" keys are public by design
      add(at(m.index), { what: 'uma chave service-role do Supabase (acesso total ao seu banco de dados, passando por cima de todas as regras de segurança)', svc: 'Supabase', sev: 'high', hint: mask(m[0]) });
    }
    for (const m of src.matchAll(DB_URL)) {
      const [, user, pw, host] = m;
      if (LOCAL_HOST.test(host) || PLACEHOLDER.test(pw) || /^[:$%{<]/.test(pw) || pw.length < 4 || /^(password|pass|postgres|root|secret|admin|user)$/i.test(pw)) continue;
      add(at(m.index), { what: 'uma senha do banco de dados dentro de um endereço de conexão', svc: 'o seu banco de dados', sev: 'high', hint: mask(pw, true) });
    }
  }
  if (isTest || f.category === 'docs') return;

  // Assignments: api_key = "…", "password": "…", PASSWORD=… (config files may leave values unquoted).
  const lines = src.split('\n');
  const inDoc = docLines(src, f.lang);
  // CI / docker-compose database containers get throwaway passwords
  const throwawayDb = /(^|\/)\.github\/|(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i.test(f.path);
  const quoted = /(["']?)([A-Za-z_][\w.-]*)\1\s*(?::=|=>|=|:)\s*(?:[rbuRBU]{1,2})?(["'`])([^"'`\n]{6,200})\3/g;
  const unquoted = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*[:=]\s*([^\s#'"]{6,200})\s*(?:#.*)?$/;
  lines.forEach((text, i) => {
    if (text.length > 400 || ENV_LOOKUP.test(text) || PUBLIC_TOKEN_LINE.test(text) || inDoc.has(i + 1) || /^\s*(#|\/\/|\*|\/\*|<!--)/.test(text)) return;
    const pairs = [...text.matchAll(quoted)].map((m) => [m[2], m[4]]);
    if (!pairs.length && (f.category === 'config' && CONFIG_LANGS.has(f.lang))) { const u = unquoted.exec(text); if (u) pairs.push([u[1], u[2]]); }
    for (const [name, value] of pairs) {
      const n = snake(name.split('.').pop());
      if (!SECRET_NAME.test(n) || PUBLIC_NAME.test(n) || PUBLIC_TOKEN_VALUE.test(value) || !valueLooksReal(value, n)) continue;
      if (throwawayDb && /^(postgres|mysql|mariadb|mongo(_initdb_root)?|redis|pg|rabbitmq_default|db|database)_(root_)?(password|pass|pwd)$/.test(n)) continue;
      add(i + 1, { what: kindFromName(name), name: name.split('.').pop(), sev: 'high', hint: mask(value, PASSWORD_NAME.test(n)), generic: true });
    }
  });
}

// ---------- 2. who may call each endpoint ----------

// Decorators / middleware / dependencies whose names say "check who is calling".
const GUARD_NAME = /(^|_)(login|auth|authenticated|authorized?|jwt|token|permission|permissions|perm|role|roles|staff|admin|superuser|owner|scope|scopes|session|api_?key|signature|signed|hmac|device|member|user)(_|$)|_required$|^requires?_|^ensure_|^verify_|^check_(auth|token|user|session|permission|role|api)|protect|^is_?authenticated|^is_?admin/i;
const NOT_GUARD = /^(route|get|post|put|patch|delete|cached?|limit|limiter|rate_?limit\w*|cross_origin|wraps|staticmethod|classmethod|property|retry|timed|log\w*|swag_from|validate\w*|expects|marshal\w*|doc|json_required|fields?_required|params?_required|body_required|transaction\w*|csrf\w*|exempt)$/i;
const isGuardName = (name) => !!name && !NOT_GUARD.test(name) && GUARD_NAME.test(snake(name));
// FastAPI dependencies that hand over a database session rather than check the caller
// (SessionDep, get_db, get_sql_session, SessionLocal, a unit of work), matched on the snake_case name
const DB_DEPENDENCY = /^(get_|new_|create_)?(async_)?(db|database|session|db_session|sessionmaker)$|(^|_)(db|database|sql\w*|engine|conn|connection|cursor|uow|unit_of_work)(_|$)|session_?(local|maker|factory)/i;
const isDbDep = (name) => DB_DEPENDENCY.test(snake(name));
const isGuardDep = (name) => isGuardName(name) && !isDbDep(name);
// A handler body that inspects the caller itself.
const INLINE_CHECK = /request\.headers(?:\.get)?\(?\s*\[?\s*['"](authorization|x-api-key|x-[\w-]*(token|key|secret|signature)[\w-]*)['"]|req\.headers(?:\.|\[\s*['"])(authorization|x-api-key)|\b(verify|check|require|validate|authenticate|authorize)_?\w*(auth|token|session|user|key|signature|webhook|hmac|jwt|device|staff|admin|permission|role|request|caller)\w*\s*\(|\bcurrent_user\b|get_jwt_identity|verify_jwt_in_request|compare_digest|abort\(\s*40[13]\b|,\s*40[13]\s*\)?\s*$|status(?:Code)?\s*[:=(]\s*40[13]\b|\.status\(\s*40[13]\s*\)|req\.user\b|req\.session\.user|req\.auth\b|jwt\.verify|jwtVerify|getServerSession|auth\(\)|currentUser\(|getAuth\(|auth\.getUser|getSession\(|verifyIdToken|getToken\(/m;
const FIREBASE_CHECK = /\b\w+\.auth\b(?!\s*\()|HttpsError\(\s*["'](unauthenticated|permission-denied)["']|enforceAppCheck\s*:\s*true|\b\w+\.app\b\s*(==|!=|===|!==)\s*(undefined|null)|!\s*\w+\.app\b/;
const SIGNATURE_CHECK =/hmac|signature|verify_?webhook|construct_?event|x-hub-signature|compare_digest|svix|webhooks?\.verify|jwt\.decode|oidc|id_token|authenticated|verify_\w*(token|request|push)/i;
const NEXT_GUARD = /getServerSession|\bauth\(\)|currentUser\(|getAuth\(|auth\.getUser|supabase\.auth\.get(User|Session)|getSession\(|verifyIdToken|jwt\.verify|jwtVerify|getToken\(|clerkClient|requireAuth|requireUser|withAuth|validateRequest|headers\(\)\.get\(\s*['"]authorization|status:\s*40[13]\b/;
const NEXT_MIDDLEWARE_GUARD = /getToken|withAuth|clerkMiddleware|authMiddleware|auth\(|supabase|getSession|jwtVerify|jwt\.verify|cookies\.get\([^)]*(session|token|auth)|redirect\([^)]*login/i;

function blockAfter(lines, defIdx) {
  // A Python def's body: every line after it that's more indented, up to 120 lines.
  const ind = /^\s*/.exec(lines[defIdx])[0].length;
  let end = defIdx + 1;
  while (end < lines.length && end < defIdx + 120 && (!lines[end].trim() || /^\s*/.exec(lines[end])[0].length > ind || /^\s*[)\]]/.test(lines[end]))) end++;
  return lines.slice(defIdx, end).join('\n');
}

function pyRoutes(src, f, out) {
  const lines = src.split('\n');
  // Blueprint / app-wide before_request hooks and router-level dependencies that check the caller.
  const guardedVars = new Map();
  for (const m of src.matchAll(/^@(\w+)\.before_(?:app_)?request\s*\n(?:@.*\n)*\s*def\s+(\w+)/gm)) {
    const defIdx = src.slice(0, m.index + m[0].length).split('\n').length - 1;
    const body = blockAfter(lines, defIdx);
    if (!/\b40[13]\b|Unauthorized|Forbidden|verify_jwt_in_request|login_required|is_authenticated|current_user/.test(body)) continue;
    guardedVars.set(m[1], m[2]);
    if (m[1] === 'app') out.push({ k: 'global-guard', framework: 'flask', name: m[2], line: defIdx + 1 });
  }
  for (const m of src.matchAll(/^\s*(\w+)\s*=\s*(?:\w+\.)?APIRouter\(([^)]*(?:\([^)]*\)[^)]*)*)\)/gm)) {
    const dep = /dependencies\s*=\s*\[[^\]]*Depends\(\s*([\w.]+)/.exec(m[2]);
    if (dep && isGuardDep(dep[1].split('.').pop())) guardedVars.set(m[1], dep[1]);
  }
  // FastAPI dependency aliases, `AdminUser = Annotated[Session, Depends(admin_user)]`, and the dependency
  // functions behind them. They're usually imported from a shared deps.py, so build decides repo-wide
  // which ones check the caller (see pyAliasGuards).
  const lineAt = (i) => src.slice(0, i).split('\n').length - 1;
  const sigAt = (idx) => lines.slice(idx, idx + 15).join('\n').split(/\)\s*(->[^:]*)?:\s*$/m)[0];
  const depsIn = (text) => [...text.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/g)].map((m) => m[1].split('.').pop());
  const typesIn = (sig) => [...new Set([...sig.matchAll(/\b\w+\s*:\s*(?:[\w.]*Annotated\[\s*)?([A-Za-z_][\w.]*)/g)].map((m) => m[1].split('.').pop()))];
  if (/\b(Depends|Security)\(/.test(src)) {
    for (const m of src.matchAll(/^(?:type\s+)?(\w+)\s*(?::[^=\n]*)?=\s*(?:[\w.]+\.)?Annotated\[/gm)) {
      let depth = 1, j = m.index + m[0].length;
      while (j < src.length && depth && j - m.index < 800) { if (src[j] === '[') depth++; else if (src[j] === ']') depth--; j++; }
      const fn = depsIn(src.slice(m.index, j))[0];
      if (fn) out.push({ k: 'py-alias', name: m[1], fn, line: lineAt(m.index) + 1 });
    }
    // top-level functions that aren't routes, with the dependencies and types they take
    for (const m of src.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(/gm)) {
      const idx = lineAt(m.index);
      if (idx > 0 && /^\s*@/.test(lines[idx - 1])) continue;
      const sig = sigAt(idx), deps = depsIn(sig), types = typesIn(sig);
      if (deps.length || types.length) out.push({ k: 'py-dep-fn', name: m[1], ...(deps.length ? { deps } : {}), ...(types.length ? { types } : {}) });
    }
  }
  // Decorators defined here: auth-named ones, and project wrappers like `@endpoint(write=True)` whose
  // body applies an auth decorator itself. Repeat once so a wrapper of a wrapper counts too.
  const localGuards = new Set();
  const defs = [...src.matchAll(/^def\s+(\w+)\s*\(/gm)].map((m) => { const idx = src.slice(0, m.index).split('\n').length - 1; return { name: m[1], line: idx + 1, body: blockAfter(lines, idx) }; });
  const decoratorish = (body) => /wraps|decorat|def\s+\w+\(\s*\*args|return\s+\w+\s*$/m.test(body);
  for (let pass = 0; pass < 2; pass++) for (const d of defs) {
    if (localGuards.has(d.name) || !decoratorish(d.body)) continue;
    const applied = [...d.body.matchAll(/^\s*@([\w.]+)/gm)].map((m) => m[1].split('.').pop());
    const wraps = applied.some((a) => isGuardName(a) || localGuards.has(a));
    if (isGuardName(d.name) || wraps) { localGuards.add(d.name); out.push({ k: 'guard-def', name: d.name, line: d.line, ...(wraps && !isGuardName(d.name) ? { wrapper: true } : {}) }); }
  }

  for (const r of f.routes || []) {
    if (r.framework === 'django') continue;
    const i0 = r.line - 1;
    // decorators above the route decorator (wrong place in Flask/FastAPI: the route registers the unwrapped function)
    const above = [];
    for (let i = i0 - 1; i >= 0 && /^\s*@/.test(lines[i]); i--) above.push(/^\s*@([\w.]+)/.exec(lines[i])[1].split('.').pop());
    // decorators below it, up to the def
    const below = [];
    let defIdx = -1;
    for (let i = i0 + 1; i < lines.length && i < i0 + 30; i++) {
      if (/^\s*(async\s+)?def\s/.test(lines[i])) { defIdx = i; break; }
      const d = /^\s*@([\w.]+)/.exec(lines[i]);
      if (d) below.push(d[1].split('.').pop());
    }
    const decoText = lines.slice(i0, defIdx > 0 ? defIdx : i0 + 1).join('\n');
    const sig = defIdx > 0 ? lines.slice(defIdx, defIdx + 15).join('\n').split(/\)\s*(->[^:]*)?:\s*$/m)[0] : '';
    const body = defIdx > 0 ? blockAfter(lines, defIdx) : '';
    const rec = { k: 'route', line: r.line, method: r.method };
    const deco = below.find((d) => (isGuardName(d) || localGuards.has(d)) && !/^(route|get|post|put|patch|delete)$/.test(d));
    const dep = /Depends\(\s*([\w.]+)|Security\(\s*([\w.]+)/g;
    const deps = [...(decoText + '\n' + sig).matchAll(dep)].map((m) => (m[1] || m[2]).split('.').pop());
    if (deco) Object.assign(rec, { guard: deco, via: 'decorator' });
    else if (guardedVars.has(r.var)) Object.assign(rec, { guard: guardedVars.get(r.var), via: 'blueprint' });
    else if (deps.some(isGuardDep)) Object.assign(rec, { guard: deps.find(isGuardDep), via: 'dependency' });
    else if (INLINE_CHECK.test(body)) Object.assign(rec, { via: 'inline' });
    else {
      const misplaced = above.find((d) => isGuardName(d) && !/^(route|get|post|put|patch|delete)$/.test(d));
      if (misplaced) rec.misplaced = misplaced;
      // other decorators may be auth wrappers defined in another file; build resolves them
      const other = below.filter((d) => !/^(route|get|post|put|patch|delete|api_route|websocket)$/.test(d));
      if (other.length) rec.decos = other;
      // so may parameter types: `user: AdminUser`, a dependency alias (pyAliasGuards)
      const types = typesIn(sig);
      if (types.length) rec.types = types;
    }
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    if (defIdx > 0) rec.fn = /def\s+(\w+)/.exec(lines[defIdx])[1];
    out.push(rec);
  }
}

function jsRoutes(src, f, out) {
  const routes = f.routes || [];
  if (!routes.length && !/\.use\(/.test(src) && !/(^|\/)middleware\.(t|j)s$/.test(f.path)) return;
  const lines = src.split('\n');
  // Next.js middleware.ts protecting the app
  if (/(^|\/)(src\/)?middleware\.(t|j)s$/.test(f.path) && NEXT_MIDDLEWARE_GUARD.test(src)) {
    const matcher = /matcher\s*:\s*([^\n]+)/.exec(src)?.[1] || '';
    if (!matcher || /api|\(\?!/.test(matcher)) out.push({ k: 'global-guard', framework: 'next', line: 1 });
  }
  // app.use(auth) / router.use(requireAuth) without a path guards everything registered after it
  const uses = [];
  for (const m of src.matchAll(/\b(\w+)\.use\(\s*([^'"`)][^)]*)\)/g)) {
    const names = m[2].match(/[A-Za-z_$][\w$]*/g) || [];
    if (names.some(isGuardName)) uses.push({ v: m[1], line: src.slice(0, m.index).split('\n').length, name: names.find(isGuardName) });
  }
  for (const u of uses) if (u.v === 'app' || u.v === 'server') out.push({ k: 'global-guard', framework: 'express', name: u.name, line: u.line });

  routes.forEach((r, idx) => {
    const rec = { k: 'route', line: r.line, method: r.method };
    if (r.framework === 'firebase') {
      // a callable checks request.auth (v1: context.auth) or turns on App Check; an onRequest function
      // checks a token or signature itself, like any other handler
      const next = routes.slice(idx + 1).find((x) => x.line > r.line)?.line || r.line + 80;
      const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 80)).join('\n');
      if (FIREBASE_CHECK.test(body) || INLINE_CHECK.test(body)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(body)) rec.signed = true;
      rec.fn = r.handler;
      out.push(rec);
      return;
    }
    if (r.framework === 'next') {
      if (NEXT_GUARD.test(src)) rec.via = 'inline';
      if (SIGNATURE_CHECK.test(src)) rec.signed = true;
      rec.fn = r.method;
      out.push(rec);
      return;
    }
    // the route call's own arguments: router.post('/x', requireAuth, async (req, res) => …)
    const head = lines.slice(r.line - 1, r.line + 4).join('\n');
    const args = (/\.\w+\(\s*["'`][^"'`]*["'`]\s*,([\s\S]*?)(?:async\s*)?(?:\(\s*req\b|function\b|\breq\s*=>|\(\s*\{|\(\s*c\s*\)|\(\s*ctx\b)/.exec(head)?.[1] || '');
    const mw = (args.match(/[A-Za-z_$][\w$.]*/g) || []).map((x) => x.split('.').pop()).find(isGuardName);
    const next = routes[idx + 1]?.line || r.line + 60;
    const body = lines.slice(r.line - 1, Math.min(next - 1, r.line + 60)).join('\n');
    const prior = uses.find((u) => u.v === r.var && u.line < r.line);
    if (mw) Object.assign(rec, { guard: mw, via: 'middleware' });
    else if (prior) Object.assign(rec, { guard: prior.name, via: 'router' });
    else if (INLINE_CHECK.test(body)) rec.via = 'inline';
    if (SIGNATURE_CHECK.test(body)) rec.signed = true;
    out.push(rec);
  });
}

/**
 * FastAPI dependency aliases that check the caller, per repo: Map(repo -> Map(alias -> file)).
 * An alias checks the caller when its dependency function does: by its name (admin_user), by taking a
 * checking dependency (Depends(require_login)), or by taking a checking alias itself, e.g.
 * `AdminOffice = Annotated[Office, Depends(admin_owned_office)]` where admin_owned_office takes `admin: AdminUser`.
 * An alias whose own name reads as a check counts too (`AdminAccess = Annotated[dict, Depends(check)]`),
 * unless either name says it's a database session (`SqlSessionDep` over `get_sql_session`).
 */
function pyAliasGuards(files, findings) {
  const byRepo = new Map(); // repo -> { aliases: Map(name -> {fn, file}), fns: Map(name -> {deps, types}) }
  for (const f of files) for (const x of findings(f.path)) {
    if (x.k !== 'py-alias' && x.k !== 'py-dep-fn') continue;
    const k = f.repo ?? '';
    if (!byRepo.has(k)) byRepo.set(k, { aliases: new Map(), fns: new Map() });
    const r = byRepo.get(k);
    if (x.k === 'py-alias') r.aliases.set(x.name, { fn: x.fn, file: f.path });
    else r.fns.set(x.name, { deps: x.deps || [], types: x.types || [] });
  }
  const out = new Map();
  for (const [repo, { aliases, fns }] of byRepo) {
    const ok = new Map();
    const checks = (fn) => isGuardDep(fn) || (!isDbDep(fn) && !!fns.get(fn) && (fns.get(fn).deps.some(isGuardDep) || fns.get(fn).types.some((t) => ok.has(t))));
    const aliasChecks = (name, fn) => checks(fn) || (isGuardDep(name) && !isDbDep(fn));
    // a few passes, so aliases built on other aliases resolve in any file order
    for (let pass = 0; pass < 3; pass++) for (const [name, a] of aliases) if (!ok.has(name) && aliasChecks(name, a.fn)) ok.set(name, a.file);
    if (ok.size) out.set(repo, ok);
  }
  return out;
}

// ---------- 3. the usual mistakes in apps built on Supabase, Firebase, Stripe, Next.js and Vite ----------

// Frontend build tools copy variables with these prefixes into the code every visitor downloads.
// (A bare PUBLIC_ prefix only means that to SvelteKit and Astro, so it counts only where they read it.)
const PUBLIC_PREFIX = /^(NEXT_PUBLIC|VITE|REACT_APP|EXPO_PUBLIC|NUXT_PUBLIC|GATSBY|PUBLIC)_/;
const CLIENT_ONLY_PREFIX = /^(VITE|REACT_APP|EXPO_PUBLIC|GATSBY|PUBLIC)_/; // these exist only in browser code
// After the prefix: names that hold something private…
const PRIVATE_NAME = /(^|_)(SECRETS?|SERVICE_ROLE|SERVICE_KEY|PRIVATE|PASSWORD|PASSWD|PWD|DATABASE_URL|DB_URL|CONNECTION_STRING|ADMIN_KEY|ADMIN_TOKEN|AUTH_TOKEN|JWT_SECRET)(_|$)/;
// …or a key or token for a service that charges you or acts as you (AI, email, messaging, code hosting)
const PRIVATE_SERVICE = /(^|_)(OPENAI|ANTHROPIC|CLAUDE|GEMINI|GROQ|GROK|XAI|MISTRAL|REPLICATE|ELEVEN_?LABS|SENDGRID|RESEND|POSTMARK|MAILGUN|BREVO|TWILIO|OPENROUTER|DEEPSEEK|PERPLEXITY|COHERE|TOGETHER|FIREWORKS|HUGGING_?FACE|HF|STABILITY|FAL|ASSEMBLY_?AI|DEEPGRAM|PINECONE|SERPAPI|TAVILY|FIRECRAWL|AIRTABLE|NOTION|GITHUB|SLACK|DISCORD|TELEGRAM|STRIPE)(_|$)/;
const KEYISH = /(^|_)(KEY|API_?KEY|TOKEN|SECRET)$/;
// Keys that are public by design: Supabase's anon key, Stripe's publishable key, reCAPTCHA site keys, IDs
const PUBLIC_BY_DESIGN = /(^|_)(PUBLISHABLE|ANON|PK|PUBLIC|SITE|CLIENT_ID|APP_ID|PROJECT_ID|MEASUREMENT_ID)(_|$)/;
const SERVICE_LABEL = { OPENAI: 'OpenAI', ANTHROPIC: 'Anthropic', CLAUDE: 'Anthropic', GEMINI: 'Google Gemini', GROQ: 'Groq', GROK: 'xAI', XAI: 'xAI', ELEVENLABS: 'ElevenLabs', ELEVEN_LABS: 'ElevenLabs', SENDGRID: 'SendGrid', OPENROUTER: 'OpenRouter', DEEPSEEK: 'DeepSeek', HF: 'Hugging Face', HUGGINGFACE: 'Hugging Face', HUGGING_FACE: 'Hugging Face', ASSEMBLYAI: 'AssemblyAI', ASSEMBLY_AI: 'AssemblyAI', SERPAPI: 'SerpApi', GITHUB: 'GitHub' };

/** For a variable like VITE_OPENAI_API_KEY: the service it unlocks ('OpenAI', or '' for a generic secret), or null when it's fine to be public. */
export function leakyPublicVar(name) {
  const m = PUBLIC_PREFIX.exec(name);
  if (!m) return null;
  const rest = name.slice(m[0].length);
  if (PUBLIC_BY_DESIGN.test(rest)) return null;
  const svc = PRIVATE_SERVICE.exec(rest)?.[2];
  if (svc && KEYISH.test(rest)) return SERVICE_LABEL[svc] || svc.charAt(0) + svc.slice(1).toLowerCase();
  if (PRIVATE_NAME.test(rest)) return /SERVICE_ROLE|SERVICE_KEY/.test(rest) ? 'Supabase' : '';
  return null;
}

function findPublicEnv(src, f, out) {
  const at = lineIndex(src);
  const seen = new Set();
  const add = (name, idx) => { if (leakyPublicVar(name) === null || seen.has(name)) return; seen.add(name); out.push({ k: 'public-env', name, line: at(idx) }); };
  for (const m of src.matchAll(/\b(process\.env\.|process\.env\[\s*['"]|import\.meta\.env\.)([A-Z][A-Z0-9_]*)/g)) {
    if (/^PUBLIC_/.test(m[2]) && m[1].startsWith('process')) continue; // PUBLIC_ means nothing to Node
    add(m[2], m.index);
  }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]\$env\/(?:static|dynamic)\/public['"]/g)) for (const n of m[1].match(/[A-Z][A-Z0-9_]*/g) || []) add(n, m.index);
}

// Stripe: code that acts on payment events. Without checking Stripe's signature first, anyone can send
// a fake "payment succeeded" event to the webhook address.
const STRIPE_EVENT = /(?:\bcase\s*|[!=]==?\s*)["'](checkout\.session\.(?:completed|async_payment_succeeded)|payment_intent\.succeeded|invoice\.(?:paid|payment_succeeded|payment_failed)|customer\.subscription\.(?:created|updated|deleted)|charge\.(?:succeeded|refunded))["']/g;
const STRIPE_VERIFIED = /constructEvent(?:Async)?\s*\(|construct_event\s*\(|verifyHeader|verify_header|events\.retrieve\s*\(|Event\.retrieve\s*\(/;

function findStripeWebhook(src, f, out) {
  if (!/stripe/i.test(src) || STRIPE_VERIFIED.test(src)) return;
  const hits = [...src.matchAll(STRIPE_EVENT)];
  if (!hits.length) return;
  out.push({ k: 'stripe-unsigned', line: lineIndex(src)(hits[0].index), events: [...new Set(hits.map((m) => m[1]))].slice(0, 4) });
}

// CORS: a server that tells browsers any website may call it. Harmless for a public API without login
// cookies; with them, any site a signed-in visitor opens could act as them.
function findCors(src, f, out) {
  const at = lineIndex(src);
  const add = (idx, how, credentials) => out.push({ k: 'cors-any', line: at(idx), how, credentials });
  if (['typescript', 'javascript'].includes(f.lang)) {
    if (/require\(\s*['"]cors['"]\s*\)|from\s+['"]cors['"]/.test(src)) {
      for (const m of src.matchAll(/\bcors\(\s*\)/g)) add(m.index, 'cors()', false);
      for (const m of src.matchAll(/\bcors\(\s*\{([^}]*)\}/g)) {
        const origin = /\borigin\s*:\s*(?:(['"`])\*\1|(true)\b)/.exec(m[1]);
        // '*' with credentials is refused by browsers; origin: true echoes whichever site asks
        if (origin) add(m.index, origin[2] ? 'cors({ origin: true })' : "cors({ origin: '*' })", !!origin[2] && /\bcredentials\s*:\s*true/.test(m[1]));
      }
    }
    const credHeader = /['"]Access-Control-Allow-Credentials['"]\s*[,:]\s*['"`]?true/i.test(src);
    for (const m of src.matchAll(/['"]Access-Control-Allow-Origin['"]\s*[,:]\s*(?:(['"`])\*\1|(req(?:uest)?\.headers(?:\.origin\b|\[\s*['"]origin['"]\s*\]|\.get\(\s*['"]origin['"]\s*\))))/gi)) {
      add(m.index, m[2] ? 'Access-Control-Allow-Origin igual à origem de quem chama' : 'Access-Control-Allow-Origin: *', !!m[2] && credHeader);
    }
  } else if (f.lang === 'python') {
    for (const m of src.matchAll(/CORSMiddleware\s*,([\s\S]{0,800}?)\)\s*$/gm)) {
      if (/allow_origins\s*=\s*\[\s*(['"])\*\1\s*\]|allow_origin_regex\s*=\s*r?(['"])\.\*\2/.test(m[1])) add(m.index, 'CORSMiddleware com allow_origins=["*"]', /allow_credentials\s*=\s*True/.test(m[1]));
    }
    for (const m of src.matchAll(/\bCORS\(\s*\w+\s*(?:\)|,([^)]*)\))/g)) {
      const opts = m[1] || '';
      if (/\borigins["']?\s*[:=]\s*(?!(['"])\*\1)/.test(opts)) continue; // a list of allowed sites (origins=… or "origins": …)
      add(m.index, 'CORS(app) liberando todas as origens', /supports_credentials\s*=\s*True/.test(opts));
    }
    const all = /^\s*CORS_(?:ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)\s*=\s*True\b/m.exec(src);
    if (all) add(all.index, 'CORS_ALLOW_ALL_ORIGINS = True', /^\s*CORS_ALLOW_CREDENTIALS\s*=\s*True\b/m.test(src));
  }
}

// Supabase / Postgres migrations: tables, row-level security switched on or off, tables dropped or
// renamed, and security rules that let anyone change a table. build.mjs replays them in file order.
const SQL_ID = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const SQL_NAME = String.raw`(?:${SQL_ID}\s*\.\s*)?${SQL_ID}`;
const sqlName = (raw) => {
  const parts = raw.split(/\s*\.\s*(?=(?:"[^"]*"|[^"])*$)/).map((p) => p.trim().replace(/^"|"$/g, '').toLowerCase());
  return parts.length > 1 ? `${parts[0]}.${parts[1]}` : `public.${parts[0]}`;
};

function findSql(src, f, out) {
  // blank out comments, keeping line breaks so line numbers stay right
  const s = src.replace(/--[^\n]*/g, (m) => ' '.repeat(m.length)).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const at = lineIndex(s);
  const found = [];
  for (const m of s.matchAll(new RegExp(String.raw`\bcreate\s+(?:(temp|temporary)\s+|unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?(${SQL_NAME})`, 'gi'))) {
    if (!m[1]) found.push({ i: m.index, k: 'sql-table', table: sqlName(m[2]) });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${SQL_NAME})\s+(enable|disable|force|no\s+force)\s+row\s+level\s+security`, 'gi'))) {
    found.push({ i: m.index, k: 'sql-rls', table: sqlName(m[1]), on: !/^(disable|no)/i.test(m[2]) });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${SQL_NAME})\s+rename\s+to\s+(${SQL_ID})`, 'gi'))) {
    const from = sqlName(m[1]);
    found.push({ i: m.index, k: 'sql-rename', table: from, to: `${from.split('.')[0]}.${m[2].replace(/^"|"$/g, '').toLowerCase()}` });
  }
  for (const m of s.matchAll(new RegExp(String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(${SQL_NAME}(?:\s*,\s*${SQL_NAME})*)`, 'gi'))) {
    for (const t of m[1].split(/\s*,\s*/)) found.push({ i: m.index, k: 'sql-drop', table: sqlName(t) });
  }
  // a permissive rule that lets signed-out visitors add, change or delete rows: `using (true)` / `with check (true)`
  for (const m of s.matchAll(new RegExp(String.raw`\bcreate\s+policy\s+(${SQL_ID})\s+on\s+(${SQL_NAME})([^;]*)`, 'gi'))) {
    const body = m[3];
    if (/\bas\s+restrictive\b/i.test(body)) continue;
    const cmd = (/\bfor\s+(all|select|insert|update|delete)\b/i.exec(body)?.[1] || 'all').toLowerCase();
    if (cmd === 'select') continue;
    const to = /\bto\s+([\w\s,"]+?)(?=\s+(?:using|with)\b|\s*$)/i.exec(body)?.[1];
    const roles = to ? to.split(/\s*,\s*/).map((r) => r.replace(/"/g, '').trim().toLowerCase()) : ['public'];
    if (!roles.some((r) => r === 'anon' || r === 'public')) continue;
    const yes = (clause) => new RegExp(String.raw`\b${clause}\s*\(\s*\(?\s*true\s*\)?\s*\)`, 'i').test(body);
    const open = cmd === 'insert' ? yes('with\\s+check') : cmd === 'all' ? yes('using') || yes('with\\s+check') : yes('using');
    if (open) found.push({ i: m.index, k: 'sql-open-policy', table: sqlName(m[2]), policy: m[1].replace(/^"|"$/g, ''), cmd, signedOut: roles.includes('anon') || !to });
  }
  for (const x of found.sort((a, b) => a.i - b.i)) { const { i, ...rest } = x; out.push({ ...rest, line: at(i) }); }
}

const USES_SUPABASE = /@supabase\/(?:supabase-js|ssr|auth-helpers[\w-]*)|from\s+supabase\s+import|^\s*import\s+supabase\b/m;

// ---------- per-file entry point ----------

export function findIssues(src, f) {
  const out = [];
  findSecrets(src, f, out);
  if (f.category !== 'code') return out;
  if (f.lang === 'sql') findSql(src, f, out);
  if (!TEST_FILE.test(f.path) && !EXAMPLE_FILE.test(f.path)) {
    if (['typescript', 'javascript', 'vue', 'svelte', 'astro'].includes(f.lang)) findPublicEnv(src, f, out);
    if (['typescript', 'javascript', 'python'].includes(f.lang)) { findStripeWebhook(src, f, out); findCors(src, f, out); }
  }
  if (['typescript', 'javascript', 'python'].includes(f.lang) && USES_SUPABASE.test(src)) out.push({ k: 'uses-supabase' });
  if (f.lang === 'python') pyRoutes(src, f, out);
  else if (['typescript', 'javascript'].includes(f.lang)) jsRoutes(src, f, out);
  // run directly or registered by name (so "nothing imports it" doesn't mean unused)
  if (/^#!|if\s+__name__\s*==\s*['"]__main__['"]|@(?:\w+\.)*(?:task|shared_task|command|group|receiver|scheduled_job|on_event|listener|hookimpl|periodic_task|cli\.command)\b|require\.main\s*===\s*module|import\.meta\.main/m.test(src)) out.push({ k: 'runnable' });
  // a frontend calling a fixed localhost address (breaks once deployed)
  // (only in files with no environment / hostname switching, where it can't be a dev-only fallback)
  if (['typescript', 'javascript', 'vue', 'svelte'].includes(f.lang) && !TEST_FILE.test(f.path) && !/process\.env|import\.meta\.env|NODE_ENV|location\.(hostname|host|origin)|isDev|__DEV__/.test(src)) {
    src.split('\n').forEach((t, i) => {
      if (/["'`]https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(t) && !/\?\?|\|\||local|dev|fallback|default|^\s*(\/\/|\*)/i.test(t.replace(/https?:\/\/(localhost|127\.0\.0\.1)/g, ''))) out.push({ k: 'localhost', line: i + 1 });
    });
  }
  return out;
}

// ======================= build: turn findings into issues =======================

const SEV_ORDER = { high: 0, medium: 1, low: 2 };
const PUBLIC_PATH = /(^|\/)(health|healthz|healthcheck|ping|status|ready|readiness|live|liveness|version|metrics|robots\.txt|sitemap[\w.]*|favicon[\w.]*|\.well-known|login|logout|signin|pair|sign-in|signout|signup|sign-up|register|forgot[\w-]*|reset[\w-]*|verify[\w-]*|oauth\w*|callback|auth|token|refresh|static|assets|public|newsletter|contact|waitlist|unsubscribe|openapi\.json|docs|swagger[\w.]*|i|images?)(\/|$)/i;
const WEBHOOK_PATH = /webhook|\/hooks?\//i;
// endpoints under a webhook URL that manage the webhooks (create, list, test…) rather than receive them
const WEBHOOK_ADMIN = /\/(manage|admin|setup|settings|config|list|create|register|delete|test[\w-]*)(\/|$)/i;
const NOT_USED_KINDS = new Set(['test', 'script', 'infra', 'config', 'worker', 'external']);
const SPECIAL_FILE = /(^|\/)(index|main|app|server|cli|manage|wsgi|asgi|__init__|__main__|conftest|setup|config|settings|env|middleware|instrumentation|layout|page|route|loading|error|not-found|template|default|global-error|sitemap|robots|manifest|opengraph-image|twitter-image|icon|apple-icon|_app|_document|_error|404|500|models|admin|apps|views|urls|signals|tasks|forms|serializers|celery|gunicorn\.conf|vite-env\.d|worker|sw|service-worker)\.[a-z]+$|\.d\.ts$|\.config\.[a-z]+$|\.stories\.|(^|\/)(pages|migrations|alembic|versions|scripts|bin|tools|seeds?|fixtures?|examples?|docs?|public|static|templates|\.github|e2e|cypress|playwright)\//i;
const USED_LANGS = new Set(['typescript', 'javascript', 'python', 'vue', 'svelte', 'astro']);
const plural = (n, w, ws) => `${n} ${n === 1 ? w : ws || w + 's'}`;
const linhas = (n) => `${n.toLocaleString('pt-BR')} ${n === 1 ? 'linha' : 'linhas'}`;
// every fix prompt ends asking the agent (Claude Code or Codex) to answer in Brazilian Portuguese
const EM_PORTUGUES = 'Responda sempre em português do Brasil, em linguagem simples.';

export function buildHealth({ graph, scan, arch, root }) {
  const issues = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const fileByPath = new Map(graph.files.map((f) => [f.p, f]));
  const scanByPath = new Map(scan.files.map((f) => [f.path, f]));
  const lineage = (id) => { const out = []; let n = nodeById.get(id); while (n) { out.push(n); n = n.parent ? nodeById.get(n.parent) : null; } return out; };
  const kinds = (id) => lineage(id).map((n) => n.kind);
  const isFrontend = (p) => { const f = fileByPath.get(p); return !!f && kinds(f.n).includes('ui'); };
  const nameOf = (p) => fileByPath.get(p)?.name || p.split('/').pop();
  const label = (id) => nodeById.get(id)?.label || id;
  // Files outside the map (config, .env, Firebase rules) point at the module that owns their folder, or
  // failing that the most specific part of the map whose paths name them.
  const archGlobs = (arch?.nodes || []).filter((n) => n?.id && nodeById.has(n.id) && Array.isArray(n.paths)).flatMap((n) => n.paths.map((p) => ({ id: n.id, g: compileGlob(p) })));
  const globOwner = (p) => archGlobs.filter((x) => x.g.test(p)).sort((a, b) => b.g.specificity - a.g.specificity)[0]?.id;
  const dirOwner = new Map();
  for (const f of graph.files) { let d = f.p; while (d.includes('/')) { d = d.slice(0, d.lastIndexOf('/')); if (!dirOwner.has(d)) dirOwner.set(d, new Map()); const m = dirOwner.get(d); m.set(f.n, (m.get(f.n) || 0) + 1); } }
  const itemFor = (p) => {
    if (fileByPath.has(p)) return 'f:' + p;
    let d = p;
    while (d.includes('/')) {
      d = d.slice(0, d.lastIndexOf('/'));
      const m = dirOwner.get(d);
      const top = m && [...m.entries()].filter(([n]) => n !== 'unassigned').sort((a, b) => b[1] - a[1])[0];
      if (top) return 'n:' + top[0];
    }
    const owner = globOwner(p);
    return owner ? 'n:' + owner : null;
  };
  const findings = (p) => scanByPath.get(p)?.issues || [];

  // ---------- secrets in code and config ----------
  const secretFiles = [];
  for (const f of scan.files) {
    const s = findings(f.path).filter((x) => x.k === 'secret');
    if (s.length) secretFiles.push({ path: f.path, list: s });
  }
  // credential files (service-account JSON, .pem keys) that the scanner doesn't read as config
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (TEST_FILE.test(f.path) || EXAMPLE_FILE.test(f.path) || /\.pub$/.test(base)) continue;
    if (!/\.(pem|key|p12|pfx|jks|keystore)$|^id_(rsa|dsa|ecdsa|ed25519)$|service[-_]?account.*\.json$|^credentials?\.json$|firebase-adminsdk.*\.json$|^client_secret.*\.json$|-key\.json$/i.test(base)) continue;
    let head = '';
    try { head = readHead(path.join(root, f.path), 65536); } catch { continue; }
    if (/PRIVATE KEY|"private_key"\s*:\s*"-----|"client_secret"\s*:\s*"[^"]{8,}/.test(head) || /\.(p12|pfx|jks|keystore)$/i.test(base)) secretFiles.push({ path: f.path, list: [{ k: 'secret', line: 1, what: 'um arquivo de credenciais (uma chave privada que entra como se fosse o seu app)', sev: 'high', hint: 'arquivo inteiro' }], file: true });
  }
  const secretIssue = (group) => {
    const locations = [], notes = {}, items = [];
    const kinds = new Set(), svcs = new Set();
    let frontend = false;
    for (const { path: p, list, file } of group) {
      list.sort((a, b) => a.line - b.line);
      const it = itemFor(p);
      if (it && !items.includes(it)) items.push(it);
      for (const s of list) {
        locations.push({ file: p, line: s.line });
        kinds.add(s.what);
        if (s.svc) svcs.add(s.svc);
      }
      if (isFrontend(p)) frontend = true;
      if (it) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + list.slice(0, 4).map((s) => `${file ? p.split('/').pop() : `linha ${s.line}`}: ${s.name ? `${s.name}, ` : ''}${s.what.replace(/ \(.*\)$/, '')} (${s.hint})`).join(' · ') + (list.length > 4 ? ` · e mais ${list.length - 4}` : '');
    }
    const n = locations.length;
    const sev = group.some((g) => g.list.some((s) => s.sev === 'high')) ? 'high' : 'medium';
    const one = group.length === 1 ? group[0].path : null;
    const kindText = kinds.size === 1 ? [...kinds][0].replace(/ \(.*\)$/, '') : 'senhas ou chaves';
    const where = one ? one.split('/').pop() : `mais ${group.length} arquivos`;
    return {
      id: 'secret:' + (one || group.map((g) => g.path).join('|')),
      kind: 'secret', severity: sev,
      title: n === 1 ? `Uma chave secreta está escrita no código de ${where}` : `${n} senhas ou chaves estão escritas no código de ${where}`,
      detail: `${one ? `${nameOf(one)} (${one}) contém` : `${plural(group.length, 'arquivo')} contêm`} ${n === 1 ? kindText : `${n} segredos (${kindText})`}. Qualquer pessoa que veja o código pode usar ${n === 1 ? 'esse segredo' : 'esses segredos'} para acessar ${svcs.size ? [...svcs].slice(0, 4).join(', ') : n === 1 ? 'o serviço que ele libera' : 'os serviços que eles liberam'} em seu nome${frontend ? ', e esse código é enviado para o navegador de todo visitante' : ''}. Considere que ${n === 1 ? 'ele já vazou: tire-o do código e troque por um novo' : 'eles já vazaram: tire-os do código e troque por novos'}.`,
      items, notes, locations,
      fix: [
        `Correção de segurança: segredos escritos direto no código. Não mostre, copie nem repita nenhum valor secreto nas suas respostas, commits ou logs.`,
        ``,
        `Estas linhas têm ${n === 1 ? 'um segredo escrito' : 'segredos escritos'} direto no código:`,
        ...group.flatMap(({ path: p, list, file }) => list.map((s) => `- ${p}${file ? ' (o arquivo inteiro)' : `:${s.line}`}: ${s.name ? `${s.name} — ` : ''}${s.what.replace(/ \(.*\)$/, '')}`)),
        ``,
        `Para cada um:`,
        `1. Troque o valor escrito pela leitura de uma variável de ambiente (${group.some((g) => /\.py$/.test(g.path)) ? `os.environ["NOME"] em Python` : ''}${group.some((g) => /\.py$/.test(g.path)) && group.some((g) => /\.[jt]sx?$/.test(g.path)) ? ', ' : ''}${group.some((g) => /\.[jt]sx?$/.test(g.path)) ? 'process.env.NOME em JavaScript/TypeScript' : ''}${!group.some((g) => /\.(py|[jt]sx?)$/.test(g.path)) ? 'ou uma referência a um gerenciador de segredos' : ''}), com um nome de variável claro. Se o app não funcionar sem ela, faça ele parar com um erro claro quando ela estiver faltando, em vez de usar um valor escrito no código como reserva.`,
        `2. Adicione o nome de cada variável (com valor vazio, nunca o verdadeiro) ao .env.example, e confira se o .env está listado no .gitignore.`,
        frontend ? `3. Este é um código de frontend, que vai para o navegador. Leve a chamada que precisa do segredo para uma rota ou função no servidor, para que a chave nunca chegue aos visitantes.` : `3. Atualize a configuração de deploy (Docker, Cloud Run, Vercel etc.) para que a variável esteja definida em produção.`,
        group.some((g) => g.file) ? `4. Tire o arquivo de credenciais do repositório (git rm --cached), adicione o nome dele ao .gitignore e carregue-o de um caminho informado por uma variável de ambiente.` : `4. Rode o app ou os testes dele para confirmar que ele ainda inicia com as variáveis definidas.`,
        ``,
        `Depois me dê uma lista curta (sem os valores) dos serviços a que essas chaves pertencem, para eu trocar cada uma: criar uma chave nova no painel do serviço, colocá-la no meu ambiente e revogar a antiga. Como os valores antigos estão no histórico do git, considere que eles já vazaram.`,
        ``,
        EM_PORTUGUES,
      ].join('\n'),
    };
  };
  secretFiles.sort((a, b) => b.list.length - a.list.length);
  const MAX_SECRET_ISSUES = 8;
  secretFiles.slice(0, MAX_SECRET_ISSUES).forEach((g) => issues.push(secretIssue([g])));
  if (secretFiles.length > MAX_SECRET_ISSUES) issues.push(secretIssue(secretFiles.slice(MAX_SECRET_ISSUES)));

  // ---------- .env files that are (or will be) committed ----------
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!/^\.env(\.[\w.-]+)?$/i.test(base) || /example|sample|template|dist|defaults?|schema|test/i.test(base)) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    const secretVars = [];
    src.split('\n').forEach((t, i) => {
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*["']?([^"'#\s]*)/.exec(t);
      if (!m || !m[2]) return;
      const n = snake(m[1]);
      const known = FORMATS.some((fm) => { fm.re.lastIndex = 0; const hit = fm.re.test(m[2]); fm.re.lastIndex = 0; return hit; });
      if (known || (SECRET_NAME.test(n) && !PUBLIC_NAME.test(n) && valueLooksReal(m[2], n)) || (/url|uri|dsn/i.test(n) && /:\/\/[^:\s\/]+:[^@\s]+@/.test(m[2]))) secretVars.push({ name: m[1], line: i + 1 });
    });
    if (!secretVars.length) continue;
    const repoAbs = f.repo ? path.join(root, f.repo) : root;
    const relInRepo = f.repo ? f.path.slice(f.repo.length + 1) : f.path;
    const tracked = !!git(repoAbs, ['ls-files', '--', relInRepo]);
    const it = itemFor(f.path);
    issues.push({
      id: 'env-file:' + f.path, kind: 'env-file', severity: tracked ? 'high' : 'medium',
      title: tracked ? 'Seu arquivo de configurações privadas está salvo no git' : 'Seu arquivo de configurações privadas não está escondido do git',
      detail: tracked
        ? `${f.path} guarda ${plural(secretVars.length, 'senha ou chave', 'senhas e chaves')} e já entrou num commit, então todo mundo com acesso ao código (e ao histórico dele) consegue ler esses valores. Esse arquivo deveria ficar só no seu computador.`
        : `${f.path} guarda ${plural(secretVars.length, 'senha ou chave', 'senhas e chaves')} e não está listado no .gitignore, então o próximo commit vai enviar esse arquivo junto com o seu código.`,
      items: it ? [it] : [], notes: it ? { [it]: `${f.path}: ${secretVars.slice(0, 6).map((v) => v.name).join(', ')}${secretVars.length > 6 ? '…' : ''}` } : {},
      locations: secretVars.map((v) => ({ file: f.path, line: v.line })),
      fix: [
        `Correção de segurança: ${f.path} tem segredos e ${tracked ? 'já foi salvo no git (entrou num commit)' : 'não é ignorado pelo git'}. Não mostre nem repita nenhum valor dele.`,
        ``,
        `1. Adicione ${base} (e .env*.local) ao ${f.repo ? f.repo + '/' : ''}.gitignore, mantendo o .env.example no git.`,
        tracked ? `2. Pare de rastrear o arquivo sem apagar a minha cópia local: git rm --cached "${relInRepo}" (rode ${f.repo ? `dentro de ${f.repo}` : 'na pasta do repositório'}) e depois faça o commit.` : `2. Confirme com git status que o arquivo não aparece mais como arquivo novo.`,
        `3. Crie ou atualize o .env.example ao lado dele, com os mesmos nomes de variáveis e valores vazios: ${secretVars.map((v) => v.name).join(', ')}.`,
        tracked ? `4. Me dê uma lista (só os nomes, sem valores) das chaves que preciso trocar no painel de cada serviço, já que elas estão no histórico do git. Explique que tirá-las do histórico exige uma ferramenta como o git filter-repo, e pergunte antes de fazer isso.` : `4. Me diga quais configurações de deploy precisam dessas variáveis.`,
        ``,
        EM_PORTUGUES,
      ].join('\n'),
    });
  }

  // ---------- secret keys in variables the browser gets (NEXT_PUBLIC_, VITE_ …) ----------
  const live = (p) => !TEST_FILE.test(p) && !EXAMPLE_FILE.test(p);
  const publicVars = new Map(); // name -> { svc, refs: [{file, line}], defs: [{file, line}] }
  const publicVar = (name) => { if (!publicVars.has(name)) publicVars.set(name, { name, svc: leakyPublicVar(name), refs: [], defs: [] }); return publicVars.get(name); };
  for (const f of scan.files) if (live(f.path)) for (const x of findings(f.path)) if (x.k === 'public-env') publicVar(x.name).refs.push({ file: f.path, line: x.line });
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!/^\.env(\.[\w.-]+)?$/i.test(base) || /example|sample|template|dist|schema/i.test(base) || !live(f.path)) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    src.split('\n').forEach((t, i) => {
      const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*["']?([^"'#\s]*)/.exec(t);
      if (m && m[2] && !PLACEHOLDER.test(m[2]) && !/^\$/.test(m[2]) && leakyPublicVar(m[1]) !== null) publicVar(m[1]).defs.push({ file: f.path, line: i + 1 });
    });
  }
  if (publicVars.size) {
    const vars = [...publicVars.values()];
    const browserSide = (p) => isFrontend(p) || /\.(jsx|tsx|vue|svelte|astro)$/.test(p);
    const sev = vars.some((v) => CLIENT_ONLY_PREFIX.test(v.name) || v.refs.some((r) => browserSide(r.file))) ? 'high' : 'medium';
    const svcs = [...new Set(vars.map((v) => v.svc).filter(Boolean))];
    const locations = vars.flatMap((v) => [...v.defs, ...v.refs]);
    const items = [], notes = {};
    for (const v of vars) for (const loc of [...v.refs, ...v.defs]) {
      const it = itemFor(loc.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      const note = `linha ${loc.line}: ${v.name}`;
      if (!(notes[it] || '').includes(note)) notes[it] = (notes[it] ? notes[it] + ' · ' : '') + note;
    }
    const names = vars.map((v) => v.name);
    issues.push({
      id: 'public-env', kind: 'public-env-secret', severity: sev,
      title: vars.length === 1 ? `${names[0]} vai para o navegador de todo visitante` : `${vars.length} chaves secretas vão para o navegador de todo visitante`,
      detail: `Configurações cujo nome começa com NEXT_PUBLIC_, VITE_ e parecidos são copiadas para o código que o seu site envia a todo visitante, e lá qualquer pessoa consegue ler esses valores nas ferramentas de desenvolvedor do navegador. ${vars.length === 1 ? `${names[0]} parece uma chave secreta` : `${names.slice(0, 4).join(', ')}${vars.length > 4 ? '…' : ''} parecem chaves secretas`}${svcs.length ? ` (${svcs.length === 1 ? 'do serviço' : 'dos serviços'} ${svcs.slice(0, 4).join(', ')})` : ''}, então qualquer pessoa poderia ${vars.length === 1 ? 'usá-la' : 'usá-las'} em seu nome: gerar cobranças na sua conta, mandar mensagens como se fosse você ou chegar aos seus dados.${sev === 'medium' ? ' Por enquanto só o código do servidor parece ler essa variável, então talvez ela ainda não tenha chegado a nenhum navegador, mas o nome convida a isso.' : ''}`,
      items, notes, locations,
      fix: [
        `Correção de segurança: chaves secretas em variáveis de ambiente públicas (o navegador recebe toda variável com esses prefixos). Não mostre, copie nem repita nenhum valor de chave.`,
        ``,
        ...vars.map((v) => `- ${v.name}${v.svc ? ` (${v.svc})` : ''}: ${[...v.defs.map((d) => `definida em ${d.file}:${d.line}`), ...v.refs.map((r) => `usada em ${r.file}:${r.line}`)].slice(0, 6).join(', ')}`),
        ``,
        `Para cada uma:`,
        `1. Renomeie a variável sem o prefixo público (por exemplo OPENAI_API_KEY em vez de VITE_OPENAI_API_KEY) nos arquivos .env, no .env.example e nas configurações da hospedagem.`,
        `2. Leve todo lugar que usa a variável para código do servidor (um route handler ou server action do Next.js, uma Edge Function do Supabase, uma função serverless ou o backend que já existe) e faça o frontend chamar esse código, para que a chave nunca chegue ao navegador.`,
        vars.some((v) => v.svc === 'Supabase') ? `3. Sobre a chave service-role do Supabase: o código do navegador deve usar a chave anon e contar com a row-level security (RLS); só o código do servidor pode usar a chave service-role.` : `3. Mantenha o frontend funcionando do mesmo jeito e rode o app para conferir.`,
        ``,
        `Depois me dê uma lista (só os nomes, sem valores) das chaves para trocar no painel de cada serviço: qualquer pessoa que abriu o site pode ter copiado essas chaves.`,
        ``,
        EM_PORTUGUES,
      ].join('\n'),
    });
  }

  // ---------- Supabase tables anyone can read and change ----------
  const usesSupabase = scan.files.some((f) => /(^|\/)supabase\/(migrations\/|config\.toml$|functions\/)/.test(f.path) || findings(f.path).some((x) => x.k === 'uses-supabase'));
  if (usesSupabase) {
    const byRepo = new Map(); // repo -> [file, …] in path order (migrations are named by timestamp)
    for (const f of scan.files) if (f.lang === 'sql' && live(f.path) && findings(f.path).some((x) => x.k.startsWith('sql-'))) { const k = f.repo ?? ''; if (!byRepo.has(k)) byRepo.set(k, []); byRepo.get(k).push(f.path); }
    for (const [repo, sqlFiles] of byRepo) {
      const tables = new Map(); // table -> { file, line, rls, off }
      const policies = [];
      for (const p of sqlFiles.sort()) for (const x of findings(p)) {
        const t = tables.get(x.table);
        if (x.k === 'sql-table' && !t) tables.set(x.table, { file: p, line: x.line, rls: null });
        else if (x.k === 'sql-rls' && t) { t.rls = x.on; t.off = x.on ? null : { file: p, line: x.line }; }
        else if (x.k === 'sql-rename' && t) { tables.delete(x.table); tables.set(x.to, t); for (const pol of policies) if (pol.table === x.table) pol.table = x.to; }
        else if (x.k === 'sql-drop') tables.delete(x.table);
        else if (x.k === 'sql-open-policy') policies.push({ ...x, file: p });
      }
      const short = (t) => t.replace(/^public\./, '');
      const open = [...tables.entries()].filter(([name, t]) => name.startsWith('public.') && t.rls !== true);
      if (open.length) {
        const items = [], notes = {};
        for (const [name, t] of open) {
          const it = itemFor(t.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `linha ${t.line}: ${short(name)} (a segurança por linha ${t.off ? 'foi desligada' : 'nunca foi ligada'})`;
        }
        const list = open.map(([name]) => short(name));
        issues.push({
          id: 'rls:' + repo, kind: 'database-rules', severity: 'high',
          title: open.length === 1 ? `Qualquer pessoa pode ler e alterar a tabela ${list[0]} do seu Supabase` : `Qualquer pessoa pode ler e alterar ${open.length} tabelas do seu Supabase`,
          detail: `O seu app conversa com o Supabase usando uma chave pública que o navegador de todo visitante tem. A segurança por linha (row-level security, ou RLS) é o que impede uma pessoa de ler ou alterar as linhas de outra, e ela está desligada ${open.length === 1 ? `na tabela ${list[0]}` : `nas tabelas ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` e em mais ${list.length - 6}` : ''}`}. Sem ela, qualquer pessoa pode usar essa chave para ler, alterar ou apagar todas as linhas${open.length === 1 ? '' : ' dessas tabelas'}. Se o seu app só acessa o banco de dados pelo próprio servidor, o risco é menor, mas ligar essa proteção continua sendo o padrão seguro.`,
          items, notes,
          locations: open.map(([, t]) => t.off || { file: t.file, line: t.line }),
          fix: [
            `Correção de segurança: tabelas do Supabase sem row-level security (RLS). Não mostre nenhuma chave.`,
            ``,
            `Qualquer pessoa com a chave pública (anon) do app pode ler e alterar estas tabelas:`,
            ...open.map(([name, t]) => `- ${name}: criada em ${t.file}:${t.line}${t.off ? `, row-level security desligada em ${t.off.file}:${t.off.line}` : ''}`),
            ``,
            `1. Veja como o app usa cada tabela: quais páginas leem ou gravam nela, e se as linhas pertencem a um usuário (por exemplo, uma coluna user_id que deveria bater com auth.uid()).`,
            `2. Escreva uma migration nova (não edite as antigas) que rode \`alter table <tabela> enable row level security;\` para cada tabela, junto com políticas (policies) para o app continuar funcionando: normalmente, usuários logados podem ler e alterar só as próprias linhas (\`using (auth.uid() = user_id)\`), e tabelas que devem ser públicas ganham uma política só de leitura. Código de servidor que usa a chave service-role não é afetado por essas regras.`,
            `3. Me explique as políticas em palavras simples antes de aplicar qualquer coisa, e não afrouxe nenhuma política que já existe.`,
            `4. Me diga como aplicar a migration (por exemplo \`supabase db push\`) e como conferir, sem estar logado, que não consigo ler as linhas de outras pessoas.`,
            ``,
            EM_PORTUGUES,
          ].join('\n'),
        });
      }
      const loose = policies.filter((pol) => tables.get(pol.table)?.rls === true);
      if (loose.length) {
        const verb = (cmd) => ({ insert: 'adicionar', update: 'alterar', delete: 'apagar' }[cmd] || 'adicionar, alterar e apagar');
        const rowsOf = (cmd, t) => `${verb(cmd)} linhas ${{ insert: 'na', delete: 'da' }[cmd] || 'na'} tabela ${t}`;
        const items = [], notes = {};
        for (const pol of loose) {
          const it = itemFor(pol.file);
          if (!it) continue;
          if (!items.includes(it)) items.push(it);
          notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `linha ${pol.line}: “${pol.policy}” deixa qualquer pessoa ${rowsOf(pol.cmd, short(pol.table))}`;
        }
        const looseTables = [...new Set(loose.map((pol) => short(pol.table)))].slice(0, 5);
        issues.push({
          id: 'open-policy:' + repo, kind: 'database-rules', severity: 'medium',
          title: loose.length === 1 ? `Uma regra do banco de dados deixa qualquer pessoa alterar a tabela ${short(loose[0].table)}` : `${loose.length} regras do banco de dados deixam qualquer pessoa alterar os seus dados`,
          detail: `${loose.length === 1 ? `A regra “${loose[0].policy}” deixa qualquer pessoa` : `Estas regras deixam qualquer pessoa`}${loose.some((pol) => pol.signedOut) ? ', mesmo quem não entrou na conta,' : ''} ${loose.length === 1 ? rowsOf(loose[0].cmd, short(loose[0].table)) : `adicionar, alterar ou apagar linhas ${looseTables.length === 1 ? 'na tabela' : 'nas tabelas'} ${looseTables.join(', ')}`}. Se a tabela for um formulário público (como uma lista de espera ou um formulário de contato), deixar qualquer pessoa adicionar linhas não tem problema; caso contrário, limite isso a usuários logados e às linhas de cada um.`,
          items, notes,
          locations: loose.map((pol) => ({ file: pol.file, line: pol.line })),
          fix: [
            `Revisão de segurança: políticas de row-level security do Supabase que deixam qualquer pessoa alterar dados (\`using (true)\` / \`with check (true)\` para anon ou public):`,
            ...loose.map((pol) => `- “${pol.policy}” em ${pol.table} (para ${pol.cmd}) — ${pol.file}:${pol.line}`),
            ``,
            `Para cada uma, me diga em palavras simples o que ela permite e se o app precisa disso. Se a tabela não deve ser pública, troque \`true\` por uma verificação como \`auth.uid() = user_id\`, limitada a usuários autenticados, numa migration nova. Se for um formulário público, mantenha aberta a inclusão de linhas, mas garanta que ninguém consiga ler, alterar ou apagar as linhas de outras pessoas. Me mostre a mudança antes de aplicar.`,
            ``,
            EM_PORTUGUES,
          ].join('\n'),
        });
      }
    }
  }

  // ---------- Firebase security rules that let anyone in ----------
  const today = new Date();
  const longDate = (d) => d.toLocaleDateString('pt-BR', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  for (const f of scan.files) {
    const base = f.path.split('/').pop();
    if (!live(f.path) || !(/\.rules$/i.test(base) || /^database(\.[\w-]+)?\.rules\.json$/i.test(base))) continue;
    let src = '';
    try { src = readHead(path.join(root, f.path), 262144); } catch { continue; }
    const rtdb = /\.json$/i.test(base);
    const service = rtdb ? 'Realtime Database' : /service\s+firebase\.storage/.test(src) ? 'Storage' : /service\s+cloud\.firestore/.test(src) ? 'Firestore' : null;
    if (!service) continue;
    const rules = rtdb ? firebaseRtdbRules(src, today) : firebaseRules(src, today);
    // the whole database, or (Firestore and Storage) any change beyond adding new records to one place
    const severe = (r) => r.wide || (!rtdb && !r.createOnly);
    const writes = rules.filter((r) => r.write && r.open !== 'expired' && severe(r));
    const deepWrites = rules.filter((r) => r.write && r.open === 'always' && !severe(r));
    const reads = rules.filter((r) => r.read && !r.write && r.open !== 'expired' && r.wide);
    const until = rules.find((r) => r.open === 'until');
    const expired = rules.find((r) => r.open === 'expired');
    if (!writes.length && !deepWrites.length && !reads.length && !expired) continue;
    const files = service === 'Storage';
    const what = files ? 'arquivos' : 'dados';
    const deploy = { Firestore: 'firestore:rules', Storage: 'storage', 'Realtime Database': 'database' }[service];
    const shown = [...writes, ...deepWrites, ...reads, ...(expired ? [expired] : [])];
    let title, detail, severity;
    if (until && writes.length) {
      severity = 'high';
      title = `Seu Firebase ${service} está aberto para qualquer pessoa até ${longDate(until.until)}`;
      detail = `${base} ainda tem as regras de “modo de teste” do Firebase: qualquer pessoa pode ler e alterar ${files ? 'todos os arquivos' : 'tudo'} até ${longDate(until.until)}, sem entrar na conta nem usar o seu app. Depois dessa data todo pedido é recusado e o app para de funcionar, então troque essas regras por regras de verdade em vez de adiar a data.`;
    } else if (writes.length) {
      severity = 'high';
      title = files ? 'Qualquer pessoa pode enviar, substituir ou apagar os arquivos do seu Firebase' : `Qualquer pessoa pode alterar ou apagar os dados do seu Firebase ${service}`;
      detail = `Uma regra em ${base} (linha ${writes[0].line}, que vale para ${writes[0].where}) deixa qualquer pessoa, logada ou não, ${files ? 'enviar, substituir ou apagar arquivos' : 'adicionar, alterar ou apagar dados'}. As configurações do Firebase do seu app estão no navegador de todo visitante, então qualquer pessoa pode usá-las para chegar direto ao seu ${service}, sem passar pelo seu app.`;
    } else if (deepWrites.length || reads.length) {
      severity = 'medium';
      title = reads.length && !deepWrites.length ? `Qualquer pessoa pode ler tudo no seu Firebase ${service}` : `Qualquer pessoa pode alterar parte do seu Firebase ${service}`;
      detail = [
        reads.length ? `Uma regra em ${base} (linha ${reads[0].line}) deixa qualquer pessoa ler ${files ? 'todos os arquivos' : 'todos os registros'}, inclusive dados que podem ser dos seus usuários. Se tudo ali for para ser público, tudo bem; senão, é preciso exigir login.` : '',
        deepWrites.length ? `Uma regra em ${base} (linha ${deepWrites[0].line}) deixa qualquer pessoa ${deepWrites[0].createOnly ? 'adicionar itens em' : 'alterar o que está em'} ${deepWrites[0].where} sem entrar na conta. Se isso for um formulário público (como uma lista de espera ou um formulário de contato), pode não ter problema; senão, é preciso exigir login.` : '',
      ].filter(Boolean).join(' ');
    } else {
      severity = 'medium';
      title = `As regras de modo de teste do seu Firebase ${service} venceram em ${longDate(expired.until)}`;
      detail = `${base} tem as regras de “modo de teste” do Firebase, que pararam de liberar o acesso em ${longDate(expired.until)}. Agora toda leitura e gravação é recusada, então as partes do app que usam o ${service} não funcionam. Troque essas regras por regras de verdade em vez de adiar a data, o que abriria tudo para qualquer pessoa de novo.`;
    }
    const it = itemFor(f.path);
    issues.push({
      id: 'firebase-rules:' + f.path, kind: 'database-rules', severity, title, detail,
      items: it ? [it] : [], notes: it ? { [it]: shown.slice(0, 4).map((r) => `linha ${r.line}: ${r.text}`).join(' · ') } : {},
      locations: shown.map((r) => ({ file: f.path, line: r.line })),
      fix: [
        `Correção de segurança: regras de segurança do Firebase ${service} em ${f.path}.`,
        ``,
        `Estas regras deixam qualquer pessoa entrar (ou já venceram):`,
        ...shown.map((r) => `- linha ${r.line}: ${r.text}`),
        ``,
        `1. Veja como o app usa cada ${rtdb ? 'caminho' : files ? 'pasta do Storage' : 'coleção'}: o que cada tela lê e grava, e quais dados pertencem a um usuário (por exemplo ${files ? 'arquivos dentro de uma pasta com o nome do uid do usuário' : 'documentos identificados pelo uid do usuário, ou com um campo ownerId'}).`,
        `2. Reescreva as regras para que usuários logados só possam ler e gravar os próprios ${what} (${rtdb ? 'auth != null && auth.uid === $uid' : files ? 'request.auth != null && request.auth.uid == userId' : 'request.auth != null && request.auth.uid == resource.data.ownerId'}), o conteúdo público seja só de leitura e todo o resto seja negado. Não use datas de modo de teste.`,
        `3. Me explique as regras novas em palavras simples e espere o meu OK.`,
        `4. Depois publique as regras com \`firebase deploy --only ${deploy}\` e teste no Rules Playground do console do Firebase (ou no emulador): um usuário deslogado não deve conseguir ler nem alterar nada privado.`,
        ``,
        EM_PORTUGUES,
      ].join('\n'),
    });
  }

  // ---------- Stripe webhooks that don't check Stripe's signature ----------
  const stripeFiles = new Map(); // file -> finding
  for (const f of scan.files) if (live(f.path)) { const x = findings(f.path).find((y) => y.k === 'stripe-unsigned'); if (x) stripeFiles.set(f.path, x); }
  for (const [file, x] of stripeFiles) {
    const routesHere = graph.routes.map((r, i) => ({ r, i })).filter(({ r }) => r.f === file && r.m !== 'GET');
    const it = itemFor(file);
    const items = [...(it ? [it] : []), ...routesHere.map(({ i }) => 'r:' + i)];
    const py = /\.py$/.test(file);
    const next = /(^|\/)app\/.*route\.[jt]s$|(^|\/)pages\/api\//.test(file);
    issues.push({
      id: 'stripe-webhook:' + file, kind: 'stripe-webhook', severity: 'high',
      title: `Qualquer pessoa poderia forjar um pagamento do Stripe em ${nameOf(file)}`,
      detail: `${file.split('/').pop()} age a partir de eventos do Stripe (como “${x.events[0]}”) sem conferir a assinatura do Stripe, então qualquer pessoa que descobrir o endereço pode mandar uma mensagem falsa de “pagamento aprovado” e ganhar pedidos, créditos ou um plano pago de graça. O Stripe assina todo evento verdadeiro, e conferir essa assinatura leva poucas linhas.`,
      items, notes: Object.fromEntries(items.map((id) => [id, id.startsWith('r:') ? 'Recebe eventos do Stripe sem conferir se são verdadeiros' : `linha ${x.line}: trata ${x.events.join(', ')} sem conferir a assinatura do Stripe`])),
      locations: [{ file, line: x.line }],
      fix: [
        `Correção de segurança em ${file}: confira a assinatura dos webhooks do Stripe antes de agir sobre qualquer evento. Não mostre nenhum valor secreto.`,
        ``,
        `O arquivo trata ${x.events.join(', ')} (linha ${x.line}) sem chamar ${py ? 'stripe.Webhook.construct_event' : 'stripe.webhooks.constructEvent'}.`,
        ``,
        py
          ? `1. Leia o corpo bruto da requisição como bytes (FastAPI: \`await request.body()\`; Flask: \`request.get_data()\`), e não o JSON já interpretado.`
          : next ? `1. Leia o corpo bruto da requisição com \`await req.text()\` (App Router) ou desligue o body parser desta rota (Pages Router), e não use o JSON já interpretado.` : `1. Entregue o corpo bruto para esta rota: \`express.raw({ type: 'application/json' })\` nela, registrado antes de o \`express.json()\` rodar para ela.`,
        py
          ? `2. Chame \`stripe.Webhook.construct_event(payload, request.headers["stripe-signature"], os.environ["STRIPE_WEBHOOK_SECRET"])\` e responda 400 se ele lançar um erro.`
          : `2. Chame \`stripe.webhooks.constructEvent(rawBody, signatureHeader, process.env.STRIPE_WEBHOOK_SECRET)\` (com o cabeçalho \`stripe-signature\`) e responda 400 se ele lançar um erro.`,
        `3. Daí em diante use só o evento verificado, e trate cada evento uma vez só, mesmo que o Stripe mande de novo.`,
        `4. Adicione STRIPE_WEBHOOK_SECRET (vazia) ao .env.example e me diga onde conseguir o valor: no painel do Stripe (Developers → Webhooks → o endpoint → Signing secret), ou com \`stripe listen\` para testar no meu computador.`,
        ``,
        EM_PORTUGUES,
      ].join('\n'),
    });
  }

  // ---------- servers that let any website call them (CORS) ----------
  const cors = [];
  for (const f of scan.files) if (live(f.path)) for (const x of findings(f.path)) if (x.k === 'cors-any') cors.push({ file: f.path, ...x });
  if (cors.length) {
    const cred = cors.filter((c) => c.credentials);
    const filesC = [...new Set(cors.map((c) => c.file))];
    const items = [], notes = {};
    for (const c of cors) {
      const it = itemFor(c.file);
      if (!it) continue;
      if (!items.includes(it)) items.push(it);
      notes[it] = (notes[it] ? notes[it] + ' · ' : '') + `linha ${c.line}: ${c.how}${c.credentials ? ', com cookies de login' : ''}`;
    }
    issues.push({
      id: 'cors', kind: 'cors', severity: cred.length ? 'medium' : 'low',
      title: cred.length ? 'Qualquer site poderia agir como os seus usuários logados' : 'Qualquer site pode chamar o seu servidor pelo navegador de um visitante',
      detail: cred.length
        ? `${cred[0].file.split('/').pop()} deixa qualquer site chamar este servidor pelo navegador de um visitante, mandando junto os cookies de login dele. Assim, um site que um usuário logado visite por acaso poderia ler os dados dele ou agir como ele sem ninguém perceber. Libere só o endereço do seu próprio app.`
        : `${filesC.length === 1 ? `${filesC[0].split('/').pop()} diz` : `${filesC.length} arquivos dizem`} aos navegadores que qualquer site pode chamar este servidor. Isso não tem problema numa API pública que não usa cookies de login (por exemplo, uma que confere um token no cabeçalho Authorization); caso contrário, libere só o endereço do seu próprio app.`,
      items, notes,
      locations: cors.map((c) => ({ file: c.file, line: c.line })),
      fix: [
        `Revisão de segurança: configurações de CORS que liberam todos os sites:`,
        ...cors.map((c) => `- ${c.file}:${c.line}: ${c.how}${c.credentials ? ' (com credenciais)' : ''}`),
        ``,
        `Primeiro me diga em palavras simples se este servidor usa cookies de login ou sessões, e quais sites o chamam de verdade. Depois troque a configuração que libera tudo por uma lista explícita de origens permitidas, lida de uma variável de ambiente (por exemplo ALLOWED_ORIGINS=https://myapp.com,http://localhost:3000). Mantenha as credenciais só se o app fizer login com cookies, e nunca as combine com "*" nem com devolver qualquer origem que pedir. Me mostre a mudança antes de fazer, e não mude mais nada.`,
        ``,
        EM_PORTUGUES,
      ].join('\n'),
    });
  }

  // ---------- endpoints anyone can call ----------
  const routeFinding = new Map(); // `${file}|${line}|${method}` -> finding
  const globalGuards = new Map(); // repo -> [{framework, name, file}]
  const guardDefs = new Map();    // name -> [{ file, wrapper }]
  for (const f of scan.files) for (const x of findings(f.path)) {
    if (x.k === 'route') routeFinding.set(`${f.path}|${x.line}|${x.method}`, x);
    // app-wide checks count only from the app itself, not from scripts or tests that spin up their own
    if (x.k === 'global-guard' && !TEST_FILE.test(f.path) && !/(^|\/)(scripts?|tools|bin|examples?)\//.test(f.path) && !(fileByPath.has(f.path) && kinds(fileByPath.get(f.path).n).some((k) => NOT_USED_KINDS.has(k)))) { const k = f.repo ?? ''; if (!globalGuards.has(k)) globalGuards.set(k, []); globalGuards.get(k).push({ ...x, file: f.path }); }
    if (x.k === 'guard-def' && !TEST_FILE.test(f.path)) { if (!guardDefs.has(x.name)) guardDefs.set(x.name, []); guardDefs.get(x.name).push({ file: f.path, wrapper: !!x.wrapper }); }
  }
  const aliasGuards = pyAliasGuards(scan.files.filter((f) => !TEST_FILE.test(f.path)), findings);
  for (const [repo, aliases] of aliasGuards) for (const [name, file] of aliases) {
    if (!guardDefs.has(name)) guardDefs.set(name, []);
    guardDefs.get(name).push({ file, alias: true, repo });
  }
  // a sign-in check applied where the route's router is mounted: app.use('/admin', requireStaff, adminRouter),
  // or app.include_router(admin.router, dependencies=[Depends(require_admin)]) (a database session isn't one)
  const mountGuard = new Map((scan.routes || []).filter((r) => r.mountMw?.some(isGuardDep)).map((r) => [`${r.file}|${r.line}|${r.method}`, r.mountMw.find(isGuardDep)]));
  const perRepo = new Map(); // repo -> { guarded, open: [], guardCounts }
  graph.routes.forEach((r, i) => {
    const fnd = routeFinding.get(`${r.f}|${r.l}|${r.m}`);
    if (!fnd) return; // framework we don't analyse: say nothing
    const gf = fileByPath.get(r.f);
    if (!gf || kinds(gf.n).some((k) => NOT_USED_KINDS.has(k)) || TEST_FILE.test(r.f)) return;
    const repo = gf.r ?? '';
    if (!perRepo.has(repo)) perRepo.set(repo, { guarded: 0, total: 0, open: [], misplaced: [], guardCounts: new Map(), fileGuards: new Map(), guardedIn: new Map() });
    const pr = perRepo.get(repo);
    pr.total++;
    const global = (globalGuards.get(repo) || []).find((g) => g.framework === 'flask' || g.framework === 'express' || (g.framework === 'next' && fnd.fn === r.m));
    // an unrecognised decorator that turns out to be an auth wrapper defined elsewhere in the project
    const viaWrapper = !fnd.via && fnd.decos?.find((d) => guardDefs.get(d)?.some((g) => (g.file.split('/')[0] === r.f.split('/')[0])));
    const mounted = !fnd.via && mountGuard.get(`${r.f}|${r.l}|${r.m}`);
    // a parameter typed with a dependency alias that checks the caller: `user: AdminUser`
    const viaAlias = !fnd.via && fnd.types?.find((t) => aliasGuards.get(repo)?.has(t));
    if (fnd.via || global || viaWrapper || mounted || viaAlias) {
      pr.guarded++; pr.guardedIn.set(r.f, (pr.guardedIn.get(r.f) || 0) + 1);
      const name = fnd.guard || viaWrapper || mounted || viaAlias;
      if (name) {
        pr.guardCounts.set(name, (pr.guardCounts.get(name) || 0) + 1);
        if (!pr.fileGuards.has(r.f)) pr.fileGuards.set(r.f, new Map());
        pr.fileGuards.get(r.f).set(name, (pr.fileGuards.get(r.f).get(name) || 0) + 1);
      }
      return;
    }
    if (r.m === 'OPTIONS' || r.m === 'HEAD') return;
    // webhook receivers: by URL, or a webhook-ish handler in a webhook file (not that file's admin endpoints)
    const webhook = (WEBHOOK_PATH.test(r.p) && !WEBHOOK_ADMIN.test(r.p)) || (/webhook|hooks?\//i.test(r.f) && /webhook|hook|notify|event|ingress|pubsub|callback|receive|inbound/i.test(r.h || '') && !/create|list|manage|register|delete|test|setup|sync/i.test((r.h || '') + r.p));
    if (webhook && fnd.signed) return;
    // a Stripe webhook that doesn't check Stripe's signature has its own, more specific issue
    if (stripeFiles.has(r.f) && (webhook || /stripe|payment|hook/i.test(r.p) || graph.routes.filter((x) => x.f === r.f && x.m !== 'GET').length === 1)) return;
    if (!webhook && PUBLIC_PATH.test(r.p.replace(/<[^>]*>|\{[^}]*\}|:\w+|\[[^\]]*\]/g, 'x'))) return;
    if (r.p === '/' && r.m === 'GET') return;
    const entry = { i, r, fnd, write: !['GET', 'ANY'].includes(r.m), webhook };
    if (fnd.misplaced) pr.misplaced.push(entry); else pr.open.push(entry);
  });
  for (const [repo, pr] of perRepo) {
    const top = (m) => m && [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    // prefer what this file already uses, then the project's most common real (non-wrapper) check
    const guardHint = (file, lang) => {
      const local = top(pr.fileGuards.get(file));
      const name = local || top(new Map([...pr.guardCounts].filter(([n]) => !guardDefs.get(n)?.every((g) => g.wrapper))));
      if (!name) return `a verificação de login que o projeto já usa (descubra como os outros endpoints protegidos verificam o usuário; se não houver nenhuma, me pergunte antes de criar uma)`;
      const defs = guardDefs.get(name) || [];
      const where = defs.find((g) => g.file === file) ? 'definida neste arquivo' : defs.length ? `definida em ${defs[0].file}` : '';
      const how = defs.some((g) => g.alias) ? `um parâmetro do tipo ${name}` : `${lang === 'python' ? '@' : ''}${name}`;
      return `a mesma verificação que ${local ? 'os outros endpoints deste arquivo' : 'os endpoints protegidos'} já usam (${how}${where ? ', ' + where : ''})`;
    };
    const routeLine = (e) => `- ${e.r.m} ${e.r.p} — ${e.r.f}:${e.r.l}${e.fnd.fn && !/^[A-Z]+$/.test(e.fnd.fn) ? ` (${e.fnd.fn})` : ''}`;
    if (pr.misplaced.length) {
      const list = pr.misplaced;
      issues.push({
        id: 'misplaced-guard:' + repo, kind: 'unprotected-endpoint', severity: 'high',
        title: 'Uma verificação de login está no lugar errado e não faz nada',
        detail: `Em ${plural(list.length, 'endpoint')}, a verificação de login (@${list[0].fnd.misplaced}) está escrita acima da linha da rota, e não abaixo dela. O Flask só enxerga o que vem abaixo, então ${list.length === 1 ? 'esse endpoint está aberto' : 'esses endpoints estão abertos'} para qualquer pessoa, mesmo ${list.length === 1 ? 'parecendo protegido' : 'parecendo protegidos'}.`,
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, `@${e.fnd.misplaced} está acima da linha da rota, então é ignorado`])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [`Correção de segurança: estes endpoints têm o decorator de autenticação acima do decorator de rota, então o framework registra a função sem proteção:`, ...list.map(routeLine), ``, `Mova cada decorator de autenticação para logo abaixo da linha @…route(...) (primeiro o decorator de rota, depois o de autenticação, depois o def). Não mude mais nada e, no fim, rode os testes que cobrem esses endpoints.`, ``, EM_PORTUGUES].join('\n'),
      });
    }
    if (!pr.open.length) continue;
    // Nothing in this repo checks the caller: probably protected elsewhere (gateway, private network) or not at all.
    if (pr.guarded === 0) {
      const list = pr.open.sort((a, b) => b.write - a.write);
      issues.push({
        id: 'no-auth:' + repo, kind: 'unprotected-endpoint', severity: 'medium',
        title: `Nenhum endpoint ${repo ? `de ${repo}` : 'do seu app'} confere quem está chamando`,
        detail: `${plural(list.length, 'endpoint')} ${list.length === 1 ? 'responde' : 'respondem'} a qualquer pessoa que saiba o endereço, sem nenhuma verificação de login no código. Isso só não tem problema se este servidor for privado (por exemplo, atrás da rede de uma empresa ou de um gateway que confere o login); caso contrário, qualquer pessoa poderia ler ou alterar os dados dele.`,
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, e.write ? 'Altera dados, sem verificação de login' : 'Sem verificação de login'])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [`Revise o controle de acesso${repo ? ` em ${repo}` : ''}. Nenhum destes endpoints confere no código quem está chamando:`, ...list.slice(0, 40).map(routeLine), list.length > 40 ? `- …e mais ${list.length - 40}` : null, ``, `Primeiro me diga em palavras simples se este servidor pode ser acessado pela internet e se algo na frente dele (um gateway, regras de rede) confere o login. Se ele for público, proponha o jeito mais simples e seguro de exigir login, começando pelos endpoints que alteram dados (POST/PUT/PATCH/DELETE), me mostre o plano e espere o meu OK antes de mudar o código.`, ``, EM_PORTUGUES].filter((x) => x !== null).join('\n'),
      });
      continue;
    }
    // One issue per route file
    const byFile = new Map();
    for (const e of pr.open) { if (!byFile.has(e.r.f)) byFile.set(e.r.f, []); byFile.get(e.r.f).push(e); }
    for (const [file, list] of byFile) {
      list.sort((a, b) => b.write - a.write || a.r.l - b.r.l);
      const writes = list.filter((e) => e.write && !e.webhook), hooks = list.filter((e) => e.webhook), reads = list.filter((e) => !e.write && !e.webhook);
      // many providers can't sign webhooks at all, so an unsigned one alone stays low
      const sev = writes.length ? 'high' : reads.length > 2 ? 'medium' : 'low';
      const lang = scanByPath.get(file)?.lang;
      const fileGuarded = pr.guardedIn.get(file) || 0;
      const sv = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const parts = [];
      if (writes.length) parts.push(sv(writes.length, 'endpoint que altera dados (cria, atualiza ou apaga)', 'endpoints que alteram dados (criam, atualizam ou apagam)'));
      if (reads.length) parts.push(sv(reads.length, 'endpoint que devolve dados', 'endpoints que devolvem dados'));
      const nOpen = writes.length + reads.length;
      const hookText = hooks.length ? `${sv(hooks.length, 'webhook (uma mensagem automática de outro serviço) é aceito', 'webhooks (mensagens automáticas de outro serviço) são aceitos')} sem conferir se ${hooks.length === 1 ? 'ele vem mesmo' : 'eles vêm mesmo'} desse serviço, então qualquer pessoa poderia mandar mensagens falsas. Alguns serviços não conseguem assinar as mensagens que mandam; se for o caso, isso é esperado.` : '';
      issues.push({
        id: 'open-endpoints:' + file, kind: 'unprotected-endpoint', severity: sev,
        title: writes.length ? `Qualquer pessoa poderia alterar dados por meio de ${nameOf(file)}` : hooks.length ? `Qualquer pessoa poderia mandar eventos falsos para ${nameOf(file)}` : `Qualquer pessoa poderia ler dados de ${nameOf(file)}`,
        detail: [
          parts.length ? `${file.split('/').pop()} tem ${parts.join(' e ')} sem verificação de login, então qualquer pessoa que descobrir o endereço pode ${nOpen === 1 ? 'usá-lo' : 'usá-los'}${fileGuarded > 0 ? ` (${sv(fileGuarded, 'outro endpoint', 'outros endpoints')} do mesmo arquivo ${fileGuarded === 1 ? 'está protegido' : 'estão protegidos'})` : ''}. Se ${nOpen === 1 ? 'ele deve ser público' : 'alguns devem ser públicos'}, tudo bem; senão, ${nOpen === 1 ? 'ele precisa' : 'eles precisam'} de uma verificação de login.` : '',
          parts.length && hooks.length ? `O arquivo também aceita ${sv(hooks.length, 'webhook', 'webhooks')} sem conferir quem ${hooks.length === 1 ? 'o mandou' : 'os mandou'}.` : hookText,
        ].filter(Boolean).join(' '),
        items: list.slice(0, 24).map((e) => 'r:' + e.i),
        notes: Object.fromEntries(list.slice(0, 24).map((e) => ['r:' + e.i, e.webhook ? 'Webhook sem verificação de assinatura visível' : e.write ? 'Altera dados, sem verificação de login' : 'Devolve dados, sem verificação de login'])),
        locations: list.map((e) => ({ file: e.r.f, line: e.r.l })),
        fix: [
          `Correção de segurança em ${file}: estes endpoints não conferem quem está chamando:`,
          ...list.map((e) => routeLine(e) + (e.webhook ? ' [webhook]' : '')),
          ``,
          `Em cada endpoint que não deve ser público, adicione ${guardHint(file, lang)}.`,
          hooks.length ? `Nos webhooks, confira a assinatura do serviço que manda a mensagem (usando o segredo de assinatura dele, lido de uma variável de ambiente) antes de fazer qualquer coisa, e recuse as requisições que não passarem.` : null,
          `Se um endpoint for público de propósito (por exemplo, uma página pública ou um health check), deixe como está e me diga por quê. Não mude mais nada; no fim, liste exatamente quais endpoints você protegeu e rode os testes relacionados.`,
          ``,
          EM_PORTUGUES,
        ].filter((x) => x !== null).join('\n'),
      });
    }
  }

  // ---------- unused files ----------
  const incoming = new Set();
  for (const l of graph.links) if (l.a !== l.b && l.b.startsWith('f:')) incoming.add(l.b.slice(2));
  const entry = new Set(graph.project?.entrypoints || []);
  const routeFiles = new Set(graph.routes.map((r) => r.f));
  for (const fl of graph.flows || []) for (const s of fl.steps || []) if (s.ref?.startsWith('f:')) entry.add(s.ref.slice(2));
  const candidates = graph.files.filter((f) => {
    if (incoming.has(f.p) || entry.has(f.p) || routeFiles.has(f.p) || !USED_LANGS.has(f.l)) return false;
    if (TEST_FILE.test(f.p) || SPECIAL_FILE.test(f.p) || /(^|\/)app\/.*\/(page|layout|route|loading|error|template|default)\.[jt]sx?$/.test(f.p)) return false;
    if (/(^|\/)src\/routes\//.test(f.p) && /\+|\$|\[/.test(f.p.split('/').pop())) return false;
    if (kinds(f.n).some((k) => NOT_USED_KINDS.has(k))) return false;
    if (findings(f.p).some((x) => x.k === 'runnable' || x.k === 'route')) return false;
    return true;
  });
  // Safety net for dynamic loading: skip a file whose name appears in any other source file.
  if (candidates.length) {
    const want = new Map(candidates.map((f) => [stemOf(f.p), f.p]));
    const mentioned = new Set();
    for (const f of scan.files) {
      if (!['code', 'config', 'docs'].includes(f.category) || f.tooLarge) continue;
      let src;
      try { src = fs.readFileSync(path.join(root, f.path), 'utf8'); } catch { continue; }
      for (const tok of new Set(src.match(/[\w$-]+/g) || [])) { const p = want.get(tok); if (p && p !== f.path) mentioned.add(p); }
    }
    const unused = candidates.filter((f) => !mentioned.has(f.p));
    // A module where most files look unused is more likely loaded in a way we can't see; stay quiet.
    const byNode = new Map();
    for (const f of unused) { if (!byNode.has(f.n)) byNode.set(f.n, []); byNode.get(f.n).push(f); }
    const groups = [...byNode.entries()].filter(([n, list]) => { const total = graph.files.filter((f) => f.n === n).length; return n === 'unassigned' || list.length <= 3 || list.length / total <= 0.6; }).sort((a, b) => b[1].length - a[1].length);
    const MAX = 5;
    const merged = groups.length > MAX ? [...groups.slice(0, MAX - 1), ['', groups.slice(MAX - 1).flatMap(([, l]) => l)]] : groups;
    for (const [nid, list] of merged) {
      list.sort((a, b) => b.loc - a.loc);
      const where = nid ? label(nid) : 'outras áreas';
      const lines = list.reduce((s, f) => s + f.loc, 0);
      issues.push({
        id: 'unused:' + (nid || 'other'), kind: 'unused-file', severity: 'low',
        title: list.length === 1 ? `Um arquivo em ${where} parece não ser usado` : `${list.length} arquivos em ${where} parecem não ser usados`,
        detail: `Nada no app importa ou chama ${list.length === 1 ? 'este arquivo' : 'estes arquivos'} (${linhas(lines)}). Código que sobrou confunde os assistentes de IA, que podem editar ou copiar a versão errada. Confira antes de apagar: alguns arquivos são carregados de jeitos que o mapa não consegue ver.`,
        items: list.slice(0, 24).map((f) => 'f:' + f.p),
        notes: Object.fromEntries(list.slice(0, 24).map((f) => ['f:' + f.p, `Nada usa este arquivo (${linhas(f.loc)})`])),
        locations: list.map((f) => ({ file: f.p, line: 1 })),
        fix: [`Verificação de limpeza: estes arquivos parecem não ser usados (nada os importa nem os chama):`, ...list.slice(0, 40).map((f) => `- ${f.p}`), list.length > 40 ? `- …e mais ${list.length - 40}` : null, ``, `Para cada arquivo, procure no código todo (incluindo configurações, scripts, templates HTML e imports dinâmicos) para confirmar que nada o usa. Depois me diga quais podem ser apagados com segurança e quais são usados de fato, com uma linha de evidência para cada um. Não apague nada até eu confirmar.`, ``, EM_PORTUGUES].filter((x) => x !== null).join('\n'),
      });
    }
  }

  // ---------- very large files ----------
  const big = graph.files.filter((f) => f.loc > 1000 && USED_LANGS.has(f.l) && !TEST_FILE.test(f.p) && !/(^|\/)(migrations|alembic|versions|fixtures?|seeds?|generated|__generated__)\//i.test(f.p) && !/\.d\.ts$/.test(f.p)).sort((a, b) => b.loc - a.loc);
  if (big.length) {
    const huge = big.filter((f) => f.loc >= 2000);
    issues.push({
      id: 'large-files', kind: 'large-file', severity: huge.length ? 'medium' : 'low',
      title: big.length === 1 ? 'Um arquivo é grande demais para a IA editar com segurança' : `${big.length} arquivos são grandes demais para a IA editar com segurança`,
      detail: `${big.length === 1 ? 'Este arquivo tem' : 'Cada um destes arquivos tem'} mais de 1.000 linhas${huge.length ? ` (${big.length === 1 ? 'são' : 'o maior tem'} ${big[0].loc.toLocaleString('pt-BR')})` : ''}. Os assistentes de IA leem e editam arquivos grandes com menos segurança: perdem a noção do que está onde e podem quebrar uma parte enquanto corrigem outra. Dividir esses arquivos em arquivos menores, cada um com uma função, deixa as próximas mudanças mais seguras.`,
      items: big.slice(0, 24).map((f) => 'f:' + f.p),
      notes: Object.fromEntries(big.slice(0, 24).map((f) => ['f:' + f.p, `${linhas(f.loc)}${f.tooLarge ? ': grande demais para o Mapa do código ler, então as ligações dele e possíveis segredos nele não foram verificados' : ''}`])),
      locations: big.map((f) => ({ file: f.p, line: 1 })),
      fix: [`Plano de refatoração: estes arquivos estão muito grandes:`, ...big.slice(0, 15).map((f) => `- ${f.p} (${linhas(f.loc)})`), ``, `Comece por ${big[0].p}. Leia o arquivo e proponha como dividi-lo em arquivos menores, cada um com uma função clara (por exemplo, por funcionalidade ou por tipo de trabalho), mantendo iguais todos os nomes de funções públicas e o comportamento. Me mostre o plano primeiro. Depois que eu aprovar, mova o código em passos pequenos, atualize os imports e rode os testes depois de cada passo. Não mude o comportamento.`, ``, EM_PORTUGUES].join('\n'),
    });
  }

  // ---------- frontend hard-coded to localhost ----------
  const local = [];
  for (const f of graph.files) if (isFrontend(f.p)) for (const x of findings(f.p)) if (x.k === 'localhost') local.push({ file: f.p, line: x.line });
  if (local.length) {
    const filesL = [...new Set(local.map((x) => x.file))];
    issues.push({
      id: 'localhost-url', kind: 'hardcoded-url', severity: 'low',
      title: 'O app aponta para o endereço do seu próprio computador',
      detail: `${filesL.length === 1 ? 'Um arquivo do frontend chama' : `${filesL.length} arquivos do frontend chamam`} um endereço fixo “localhost”. Isso só funciona na sua máquina; quando o app estiver no ar, essas chamadas vão falhar para todo mundo.`,
      items: filesL.slice(0, 24).map((p) => 'f:' + p),
      notes: Object.fromEntries(filesL.slice(0, 24).map((p) => { const ls = local.filter((x) => x.file === p).map((x) => x.line); return ['f:' + p, `endereço localhost ${ls.length === 1 ? 'na linha' : 'nas linhas'} ${ls.join(', ')}`]; })),
      locations: local,
      fix: [`Estas linhas do frontend usam uma URL localhost escrita direto no código:`, ...local.map((x) => `- ${x.file}:${x.line}`), ``, `Troque cada uma pela configuração de URL base da API que o projeto já tem (ou crie uma, lida de uma variável de ambiente pública como NEXT_PUBLIC_API_URL / VITE_API_URL, com o valor localhost só no .env.development). Não mude mais nada.`, ``, EM_PORTUGUES].join('\n'),
    });
  }

  const KIND_ORDER = ['secret', 'public-env-secret', 'database-rules', 'stripe-webhook', 'env-file', 'unprotected-endpoint', 'cors', 'large-file', 'hardcoded-url', 'unused-file'];
  issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.locations?.length || 0) - (a.locations?.length || 0));
  const kept = issues.slice(0, 40);
  const summary = { high: 0, medium: 0, low: 0 };
  for (const i of kept) summary[i.severity]++;
  return { summary, issues: kept };
}

/** Test mode, in Firestore/Storage rules (request.time < timestamp.date(Y, M, D)) or Realtime Database rules (now < ms). */
const testModeEnd = (cond) => {
  const d = /^request\.time\s*<\s*timestamp\.date\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)$/.exec(cond);
  if (d) return new Date(Date.UTC(+d[1], +d[2] - 1, +d[3]));
  const ms = /^now\s*<\s*(\d{12,14})$/.exec(cond);
  return ms ? new Date(+ms[1]) : null;
};

/** Firestore / Storage rules that let anyone in: `allow …: if true`, `allow …;` (no condition) and test mode. */
function firebaseRules(src, now) {
  const s = src.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  const at = lineIndex(s);
  const matches = [...s.matchAll(/\bmatch\s+(\/\S*)\s*\{/g)].map((m) => ({ i: m.index, path: m[1] }));
  const out = [];
  for (const m of s.matchAll(/\ballow\s+([a-z][a-z,\s]*?)\s*(?::\s*if\s+([^;]+?))?\s*;/g)) {
    const ops = m[1].split(/[\s,]+/).filter(Boolean);
    const cond = (m[2] || 'true').trim().replace(/\s+/g, ' ');
    const end = cond === 'true' ? null : testModeEnd(cond);
    if (cond !== 'true' && !end) continue;
    const where = matches.filter((x) => x.i < m.index).pop()?.path || '/';
    const writeOps = ops.filter((o) => /^(write|create|update|delete)$/.test(o));
    out.push({
      line: at(m.index), text: `allow ${ops.join(', ')}${m[2] ? `: if ${cond}` : ' (sem condição)'} em ${where}`,
      read: ops.some((o) => /^(read|get|list)$/.test(o)), write: writeOps.length > 0, createOnly: writeOps.length > 0 && writeOps.every((o) => o === 'create'),
      open: !end ? 'always' : end > now ? 'until' : 'expired', until: end, where,
      wide: /=\*\*\}/.test(where) || /\/documents$/.test(where) || where === '/',
    });
  }
  return out;
}

/** Realtime Database rules (database.rules.json) with ".read" / ".write" set to true or test mode. */
function firebaseRtdbRules(src, now) {
  const s = src.replace(/(^|[^:"])\/\/[^\n]*/g, (m, pre) => pre + ' '.repeat(m.length - pre.length));
  const at = lineIndex(s);
  const out = [];
  for (const m of s.matchAll(/"\.(read|write)"\s*:\s*(true\b|"([^"]*)")/g)) {
    const cond = m[2] === 'true' ? 'true' : (m[3] || '').trim();
    const end = cond === 'true' ? null : testModeEnd(cond);
    if (cond !== 'true' && !end) continue;
    // how deep it sits: { "rules": { ".read": … } } is the whole database
    let depth = 0;
    for (let i = 0; i < m.index; i++) { if (s[i] === '{') depth++; else if (s[i] === '}') depth--; }
    const keys = [...s.slice(0, m.index).matchAll(/"([^".][^"]*)"\s*:\s*\{/g)].map((k) => k[1]);
    const where = depth <= 2 ? 'o banco de dados inteiro' : '/' + keys.slice(-(depth - 2)).join('/');
    out.push({
      line: at(m.index), text: `"${m[1] === 'read' ? '.read' : '.write'}": ${m[2]} para ${where}`,
      read: m[1] === 'read', write: m[1] === 'write', createOnly: false,
      open: !end ? 'always' : end > now ? 'until' : 'expired', until: end, where, wide: depth <= 2, root: depth <= 2,
    });
  }
  return out;
}

function readHead(file, max) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(max); const n = fs.readSync(fd, buf, 0, max, 0); return buf.subarray(0, n).toString('utf8'); } finally { fs.closeSync(fd); }
}
function stemOf(p) {
  const base = p.split('/').pop().replace(/\.[^.]+$/, '');
  return base === 'index' ? p.split('/').slice(-2, -1)[0] : base;
}
