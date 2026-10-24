import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';

/**
 * Idempotency keys make retried writes safe: a client that resends a POST with the same
 * `Idempotency-Key` gets the original response instead of creating a second order/charge/row.
 */
export interface StoredResponse {
  status: number;
  body: string | null;
  location?: string;
}

export type BeginResult =
  | { state: 'new' }
  | { state: 'in_progress' }
  | { state: 'replay'; response: StoredResponse }
  | { state: 'mismatch' };

export interface IdempotencyStore {
  begin(key: string, fingerprint: string): Promise<BeginResult>;
  complete(key: string, fingerprint: string, response: StoredResponse): Promise<void>;
  /** Forget the key so the client may retry (used when the request failed with 5xx). */
  abandon(key: string): Promise<void>;
}

export const IDEMPOTENCY_TTL_SECONDS = 24 * 3600;
const PENDING_TTL_SECONDS = 60;

type Entry = { fingerprint: string; response?: StoredResponse; expiresAt: number };

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  async begin(key: string, fingerprint: string): Promise<BeginResult> {
    this.sweep();
    const e = this.entries.get(key);
    if (!e) {
      this.entries.set(key, { fingerprint, expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000 });
      return { state: 'new' };
    }
    if (e.fingerprint !== fingerprint) return { state: 'mismatch' };
    return e.response ? { state: 'replay', response: e.response } : { state: 'in_progress' };
  }

  async complete(key: string, fingerprint: string, response: StoredResponse) {
    this.entries.set(key, { fingerprint, response, expiresAt: Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000 });
  }

  async abandon(key: string) {
    this.entries.delete(key);
  }

  private sweep() {
    if (this.entries.size < 10_000) return;
    const now = Date.now();
    for (const [k, e] of this.entries) if (e.expiresAt < now) this.entries.delete(k);
  }
}

export class RedisIdempotencyStore implements IdempotencyStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'bapi:idem:',
  ) {}

  private k(key: string) {
    return this.prefix + createHash('sha256').update(key).digest('base64url');
  }

  async begin(key: string, fingerprint: string): Promise<BeginResult> {
    const k = this.k(key);
    const created = await this.redis.set(k, JSON.stringify({ fingerprint }), 'EX', PENDING_TTL_SECONDS, 'NX');
    if (created === 'OK') return { state: 'new' };
    const raw = await this.redis.get(k);
    if (!raw) return this.begin(key, fingerprint); // expired between calls
    const e = JSON.parse(raw) as Entry;
    if (e.fingerprint !== fingerprint) return { state: 'mismatch' };
    return e.response ? { state: 'replay', response: e.response } : { state: 'in_progress' };
  }

  async complete(key: string, fingerprint: string, response: StoredResponse) {
    await this.redis.set(this.k(key), JSON.stringify({ fingerprint, response }), 'EX', IDEMPOTENCY_TTL_SECONDS);
  }

  async abandon(key: string) {
    await this.redis.del(this.k(key));
  }
}
