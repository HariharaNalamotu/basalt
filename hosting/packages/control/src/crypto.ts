import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** AES-256-GCM with associated data binding each ciphertext to its owner (no swapping rows). */
export class SecretBox {
  constructor(private readonly key: Buffer) {}
  seal(plaintext: string, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
  }
  open(blob: Buffer, aad: string): string {
    if (blob[0] !== 1) throw new Error('unsupported ciphertext');
    const d = createDecipheriv('aes-256-gcm', this.key, blob.subarray(1, 13));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(blob.subarray(13, 29));
    return Buffer.concat([d.update(blob.subarray(29)), d.final()]).toString('utf8');
  }
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest();
export const id = (prefix: string, bytes = 9) => `${prefix}_${randomBytes(bytes).toString('base64url').replace(/[-_]/g, 'x').toLowerCase()}`;
export const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
