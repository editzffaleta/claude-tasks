// Cifra segredos guardados no banco (senhas de SMTP/IMAP, chaves de API) com AES-256-GCM.
// A chave fica em data/secret.key (0600), fora do banco e fora do git.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PREFIX = 'enc:v1:';
const keys = new Map();

function keyFor(dir) {
  if (keys.has(dir)) return keys.get(dir);
  const file = join(dir, 'secret.key');
  let key;
  if (existsSync(file)) key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  else {
    mkdirSync(dir, { recursive: true });
    key = randomBytes(32);
    writeFileSync(file, key.toString('base64'), { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch {}
  }
  keys.set(dir, key);
  return key;
}

export function encrypt(text, dir) {
  if (text == null || text === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFor(dir), iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}

export function decrypt(value, dir) {
  if (!value) return null;
  if (!String(value).startsWith(PREFIX)) return value;
  const raw = Buffer.from(String(value).slice(PREFIX.length), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keyFor(dir), raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export const isEncrypted = (value) => String(value || '').startsWith(PREFIX);
