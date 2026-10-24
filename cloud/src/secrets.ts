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

// A stable user id for a named test person, so "maria" is the same user every time.
export function testUserId(projectSecret: string, label: string): string {
  const h = createHmac('sha256', projectSecret).update(`test-user|${label}`).digest();
  h[6] = (h[6] & 0x0f) | 0x40;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Signs a login token in the shape basalt.uid() checks.
export function signToken(projectSecret: string, sub: string, seconds = 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + seconds })}`;
  return `${unsigned}.${createHmac('sha256', projectSecret).update(unsigned).digest('base64url')}`;
}
