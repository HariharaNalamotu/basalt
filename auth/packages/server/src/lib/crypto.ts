import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

/** 256-bit random token, base64url encoded, with a recognizable prefix for secret scanners. */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function randomId(prefix: string, bytes = 12): string {
  return `${prefix}${randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x')}`;
}

/** Uniformly random numeric code (no modulo bias; uses crypto.randomInt). */
export function randomNumericCode(digits: number): string {
  let out = '';
  for (let i = 0; i < digits; i++) out += randomInt(0, 10).toString();
  return out;
}

export function sha256(input: string | Buffer): Buffer {
  return createHash('sha256').update(input).digest();
}

export function hmacSha256(key: Buffer, input: string | Buffer): Buffer {
  return createHmac('sha256', key).update(input).digest();
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** UUIDv7: time-ordered, so primary-key inserts stay index-local under heavy write load. */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ts = BigInt(Date.now());
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Derives purpose-specific subkeys from the master key, so one key never serves two roles.
 */
export class KeyRing {
  readonly encryptionKey: Buffer;
  readonly codePepper: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('Master key must be exactly 32 bytes');
    this.encryptionKey = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'basalt-auth:encryption:v1', 32));
    this.codePepper = Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'basalt-auth:code-pepper:v1', 32));
  }

  /** AES-256-GCM. Output layout: version(1) | iv(12) | tag(16) | ciphertext. `aad` binds the ciphertext to its owner. */
  encrypt(plaintext: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ct]);
  }

  decrypt(blob: Buffer, aad: string): Buffer {
    if (blob.length < 29 || blob[0] !== 1) throw new Error('Unsupported ciphertext');
    const iv = blob.subarray(1, 13);
    const tag = blob.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]);
  }

  /** Hash for short, low-entropy codes. Bound to a context (e.g. the row id) so codes can't be swapped between rows. */
  hashCode(context: string, code: string): Buffer {
    return hmacSha256(this.codePepper, `${context}:${code}`);
  }
}
