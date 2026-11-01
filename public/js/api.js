// Chamadas à API, upload, streaming do chat e avisos (toast).
import { N_, t } from './i18n.js';
import { $ } from './util.js';

// As mensagens de erro do servidor vêm em português; as fixas têm tradução nos dicionários.
export class ApiError extends Error {
  constructor(status, message, vars) {
    super(t(message, vars));
    this.status = status;
  }
}
const failure = (res, data) => new ApiError(res.status, data.error || N_('Erro {status}'), { status: res.status });

export async function api(path, { method = 'GET', body } = {}) {
  // POST/PATCH/PUT sempre como JSON (o servidor recusa outros tipos, contra CSRF por formulário).
  const json = body !== undefined || ['POST', 'PATCH', 'PUT'].includes(method);
  const res = await fetch(path, {
    method,
    headers: json ? { 'content-type': 'application/json' } : {},
    body: json ? JSON.stringify(body ?? {}) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) window.dispatchEvent(new CustomEvent('auth-required'));
  if (!res.ok) throw failure(res, data);
  return data;
}

// Corpo binário (anexos, avatares, importação de CSV/Trello). O servidor exige o cabeçalho Origin,
// que o navegador manda sozinho em POST.
export async function uploadTo(path, file, { name = file.name, type = file.type } = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': type || 'application/octet-stream', 'x-filename': encodeURIComponent(name || 'arquivo') },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) window.dispatchEvent(new CustomEvent('auth-required'));
  if (!res.ok) throw failure(res, data);
  return data;
}

export const upload = (taskId, file, name = file.name) => uploadTo(`/api/tasks/${taskId}/attachments`, file, { name });

// Escolhe um arquivo pelo seletor do sistema. accept: ".csv,text/csv", "image/*"…
export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// Lê uma resposta NDJSON evento a evento.
export async function stream(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw failure(res, data);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

let toastTimer;
export function toast(message, error = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('error', error);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), error ? 4200 : 2600);
}

// Envolve uma ação assíncrona mostrando o erro num toast.
export async function attempt(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    return r;
  } catch (e) {
    toast(e.message, true);
    return undefined;
  }
}
