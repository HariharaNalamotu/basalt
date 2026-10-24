import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KeyRing, uuidv7 } from '../src/lib/crypto.js';
import { normalizeEmail } from '../src/lib/email.js';
import { DEFAULT_ARGON2, PasswordHasher } from '../src/lib/password.js';
import { MemoryRateLimiter } from '../src/lib/ratelimit.js';
import { Semaphore } from '../src/lib/semaphore.js';
import { totpCode, verifyTotp } from '../src/lib/totp.js';
import { base32Decode } from './totp-util.js';
import { base32Encode } from '../src/lib/totp.js';

describe('TOTP (RFC 6238 test vectors, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890');
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('t=%i -> %s', (t, code) => {
    expect(totpCode(secret, Math.floor(t / 30))).toBe(code);
  });

  it('accepts ±1 step of drift and rejects replays', () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30_000);
    expect(verifyTotp(secret, totpCode(secret, step - 1), null, now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, step + 1), null, now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, step - 2), null, now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step), step, now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', null, now)).toBeNull();
  });

  it('base32 round-trips', () => {
    const b = randomBytes(20);
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
});

describe('password hashing', () => {
  const hasher = new PasswordHasher(DEFAULT_ARGON2, new Semaphore(2, 10));

  it('produces PHC argon2id strings with OWASP parameters and verifies', async () => {
    const hash = await hasher.hash('violet-anchor-58-tundra');
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify('violet-anchor-58-tundra', hash)).toBe(true);
    expect(await hasher.verify('violet-anchor-58-tundrA', hash)).toBe(false);
    expect(await hasher.verify('x', 'not-a-hash')).toBe(false);
    expect(hasher.needsRehash(hash)).toBe(false);
    expect(hasher.needsRehash('$argon2id$v=19$m=1024,t=1,p=1$AAAA$AAAA')).toBe(true);
  });

  it('salts every hash', async () => {
    expect(await hasher.hash('same-password-123')).not.toBe(await hasher.hash('same-password-123'));
  });

  it('treats canonically equivalent unicode passwords as equal', async () => {
    const hash = await hasher.hash('café-password-1');
    expect(await hasher.verify('café-password-1', hash)).toBe(true);
  });
});

describe('semaphore', () => {
  it('sheds load once the queue is full', async () => {
    const sem = new Semaphore(1, 1);
    let release!: () => void;
    const blocker = sem.run(() => new Promise<void>((r) => (release = r)));
    const queued = sem.run(async () => 'ok');
    await expect(sem.run(async () => 'overflow')).rejects.toMatchObject({ code: 'server_busy' });
    release();
    await blocker;
    expect(await queued).toBe('ok');
  });
});

describe('rate limiter', () => {
  it('allows up to the limit, then blocks until the window slides', async () => {
    let now = 1_000_000_000_000;
    const rl = new MemoryRateLimiter(() => now);
    const rule = { limit: 3, windowSeconds: 60 };
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await rl.hit('k', rule)).allowed);
    expect(results).toEqual([true, true, true, false]);
    now += 120_000;
    expect((await rl.hit('k', rule)).allowed).toBe(true);
    await rl.reset('k');
    rl.close();
  });

  it('keeps different windows for the same key independent', async () => {
    const rl = new MemoryRateLimiter();
    await rl.hit('k', { limit: 1, windowSeconds: 60 });
    expect((await rl.hit('k', { limit: 1, windowSeconds: 3600 })).allowed).toBe(true);
    rl.close();
  });
});

describe('key ring', () => {
  it('binds ciphertext to its context (no swapping encrypted values between rows)', () => {
    const kr = new KeyRing(randomBytes(32));
    const blob = kr.encrypt(Buffer.from('secret'), 'totp:user-a');
    expect(kr.decrypt(blob, 'totp:user-a').toString()).toBe('secret');
    expect(() => kr.decrypt(blob, 'totp:user-b')).toThrow();
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1]! ^= 1;
    expect(() => kr.decrypt(tampered, 'totp:user-a')).toThrow();
  });

  it('rejects master keys of the wrong size', () => {
    expect(() => new KeyRing(randomBytes(16))).toThrow();
  });
});

describe('identifiers and emails', () => {
  it('uuidv7 is time-ordered and well-formed', () => {
    const a = uuidv7();
    const b = uuidv7();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.slice(0, 13) <= b.slice(0, 13)).toBe(true);
  });

  it('normalizes and validates emails', () => {
    expect(normalizeEmail('  Alice@Example.COM ').normalized).toBe('alice@example.com');
    for (const bad of ['', 'nope', 'a@b', 'a b@c.com', 'a@b.c', `${'x'.repeat(250)}@b.com`, 42, null]) {
      expect(() => normalizeEmail(bad)).toThrow();
    }
  });
});
