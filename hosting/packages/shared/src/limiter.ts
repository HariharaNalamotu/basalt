/**
 * Single-node token buckets with bounded memory (LRU eviction). The edge is one process on one
 * machine, so in-memory state is the fastest correct choice; Cloudflare handles global volume.
 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly maxKeys = 200_000) {}

  /** Takes one token; `perMinute` refill rate, `burst` capacity. Returns seconds to wait when denied. */
  take(key: string, perMinute: number, burst = Math.max(10, Math.ceil(perMinute / 6)), now = Date.now()): { ok: boolean; retryAfter: number } {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
      b = { tokens: burst, at: now };
    } else {
      this.buckets.delete(key); // re-insert to keep LRU order
      b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60_000) * perMinute);
      b.at = now;
    }
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: Math.max(1, Math.ceil(((1 - b.tokens) * 60) / perMinute)) };
  }

  get size() {
    return this.buckets.size;
  }
}

/** Counts concurrent work per key with a hard ceiling. */
export class Concurrency {
  private readonly counts = new Map<string, number>();
  acquire(key: string, max: number): boolean {
    const n = this.counts.get(key) ?? 0;
    if (n >= max) return false;
    this.counts.set(key, n + 1);
    return true;
  }
  release(key: string) {
    const n = (this.counts.get(key) ?? 1) - 1;
    if (n <= 0) this.counts.delete(key);
    else this.counts.set(key, n);
  }
  get(key: string) {
    return this.counts.get(key) ?? 0;
  }
}
