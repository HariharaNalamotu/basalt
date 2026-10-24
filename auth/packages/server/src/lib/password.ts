import { argon2 as argon2Cb, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AuthError } from './errors.js';
import { COMMON_PASSWORDS } from './common-passwords.js';
import type { Semaphore } from './semaphore.js';

const argon2 = promisify(argon2Cb);

export interface Argon2Params {
  memoryKiB: number;
  passes: number;
  parallelism: number;
}

/** OWASP Password Storage Cheat Sheet (2025) recommended Argon2id baseline. */
export const DEFAULT_ARGON2: Argon2Params = { memoryKiB: 19_456, passes: 2, parallelism: 1 };

export const PASSWORD_MAX_LENGTH = 128;

const TAG_LENGTH = 32;
const SALT_LENGTH = 16;

const b64 = (buf: Buffer) => buf.toString('base64').replace(/=+$/, '');

export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  constructor(
    private readonly params: Argon2Params,
    private readonly limiter: Semaphore,
  ) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const tag = await this.derive(password, salt, this.params);
    const { memoryKiB: m, passes: t, parallelism: p } = this.params;
    return `$argon2id$v=19$m=${m},t=${t},p=${p}$${b64(salt)}$${b64(tag)}`;
  }

  async verify(password: string, phc: string): Promise<boolean> {
    const parsed = parsePhc(phc);
    if (!parsed) return false;
    const tag = await this.derive(password, parsed.salt, parsed.params);
    return tag.length === parsed.hash.length && timingSafeEqual(tag, parsed.hash);
  }

  /** True when a stored hash was made with weaker parameters than current; rehash on next successful login. */
  needsRehash(phc: string): boolean {
    const parsed = parsePhc(phc);
    if (!parsed) return true;
    const cur = this.params;
    return (
      parsed.params.memoryKiB < cur.memoryKiB ||
      parsed.params.passes < cur.passes ||
      parsed.params.parallelism !== cur.parallelism
    );
  }

  /**
   * Burns the same CPU time as a real verification. Used when the account doesn't exist so
   * response timing doesn't reveal which emails are registered.
   */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(password, await this.dummyHash);
  }

  private derive(password: string, salt: Buffer, params: Argon2Params): Promise<Buffer> {
    return this.limiter.run(() =>
      argon2('argon2id', {
        message: Buffer.from(password.normalize('NFKC'), 'utf8'),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength: TAG_LENGTH,
        memory: params.memoryKiB,
        passes: params.passes,
      }),
    );
  }
}

function parsePhc(phc: string): { params: Argon2Params; salt: Buffer; hash: Buffer } | null {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc);
  if (!m) return null;
  return {
    params: { memoryKiB: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) },
    salt: Buffer.from(m[4]!, 'base64'),
    hash: Buffer.from(m[5]!, 'base64'),
  };
}

export interface PasswordPolicy {
  minLength: number;
  checkBreached: boolean;
}

/**
 * NIST SP 800-63B-aligned policy: length over composition rules, block known-common and
 * known-breached passwords, no forced complexity. Throws AuthError with a user-presentable message.
 */
export async function assertAcceptablePassword(
  password: string,
  policy: PasswordPolicy,
  context: { email?: string; breachChecker?: BreachChecker },
): Promise<void> {
  if (typeof password !== 'string') throw new AuthError('invalid_request', 'Password is required.');
  const length = [...password.normalize('NFKC')].length;
  if (length < policy.minLength) {
    throw new AuthError('weak_password', `Password must be at least ${policy.minLength} characters.`);
  }
  if (length > PASSWORD_MAX_LENGTH) {
    throw new AuthError('weak_password', `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered)) {
    throw new AuthError('weak_password', 'This password is too common. Choose a less predictable one.');
  }
  if (/^(.)\1+$/.test(password)) {
    throw new AuthError('weak_password', 'Password cannot be a single repeated character.');
  }
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lowered.includes(local)) {
    throw new AuthError('weak_password', 'Password cannot contain your email address.');
  }
  if (policy.checkBreached && context.breachChecker && (await context.breachChecker.isBreached(password))) {
    throw new AuthError(
      'breached_password',
      'This password has appeared in a data breach. Choose a different password.',
    );
  }
}

export interface BreachChecker {
  isBreached(password: string): Promise<boolean>;
}

/**
 * Have I Been Pwned range API (k-anonymity: only the first 5 hex chars of the SHA-1 leave the
 * server). Fails open on network errors so an outage there never blocks sign-ups.
 */
export class HibpBreachChecker implements BreachChecker {
  constructor(private readonly timeoutMs = 1500) {}

  async isBreached(password: string): Promise<boolean> {
    const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);
    try {
      const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
        headers: { 'Add-Padding': 'true', 'User-Agent': 'basalt-auth' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return false;
      const body = await res.text();
      for (const line of body.split('\n')) {
        const [s, count] = line.trim().split(':');
        if (s === suffix && Number(count) > 0) return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

