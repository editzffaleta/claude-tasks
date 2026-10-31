// Chamadas à API, upload, streaming do chat e avisos (toast).
import { $ } from './util.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth')) window.dispatchEvent(new CustomEvent('auth-required'));
  if (!res.ok) throw new ApiError(res.status, data.error || `Erro ${res.status}`);
  return data;
}

export async function upload(taskId, file, name = file.name) {
  const res = await fetch(`/api/tasks/${taskId}/attachments`, {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(name || 'arquivo') },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Erro ${res.status}`);
  return data;
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
    throw new ApiError(res.status, data.error || `Erro ${res.status}`);
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
