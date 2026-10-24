import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Small helpers for ids, keys and encrypting the per-app secrets Basalt Cloud
// has to keep (each app's database password and token signing secret).

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomId(length = 10): string {
  const bytes = randomBytes(length);
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sameHash(value: string, expectedHex: string): boolean {
  const a = Buffer.from(sha256(value), 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

function key(masterHex: string): Buffer {
  const k = Buffer.from(masterHex, 'hex');
  if (k.length !== 32) throw new Error('CLOUD_MASTER_KEY must be 64 hex characters (openssl rand -hex 32).');
  return k;
}

// AES-256-GCM. The output is iv.tag.ciphertext, all base64url.
export function encrypt(masterHex: string, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(masterHex), iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

export function decrypt(masterHex: string, sealed: string): string {
  const [iv, tag, body] = sealed.split('.').map((p) => Buffer.from(p, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key(masterHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}
