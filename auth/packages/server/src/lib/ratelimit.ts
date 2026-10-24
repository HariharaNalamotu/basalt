import type { Redis } from 'ioredis';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Maximum events allowed per window. */
  limit: number;
  windowSeconds: number;
}

/**
 * Sliding-window-approximation limiter (two fixed windows, weighted). Accurate to within a few
 * percent, O(1) memory per key, and a single atomic round-trip in Redis.
 */
export interface RateLimiter {
  hit(key: string, rule: RateLimitRule): Promise<RateLimitResult>;
  /** Clears a key, e.g. per-account failure counters after a successful sign-in. */
  reset(key: string): Promise<void>;
}

function weigh(prev: number, cur: number, windowMs: number, nowMs: number): number {
  const elapsed = (nowMs % windowMs) / windowMs;
  return prev * (1 - elapsed) + cur;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { window: number; windowMs: number; count: number; prev: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const nowMs = this.now();
    const windowMs = rule.windowSeconds * 1000;
    const window = Math.floor(nowMs / windowMs);
    const bucketKey = `${key}:${rule.windowSeconds}`;
    let b = this.buckets.get(bucketKey);
    if (!b) {
      b = { window, windowMs, count: 0, prev: 0 };
      this.buckets.set(bucketKey, b);
    } else if (b.window !== window) {
      b.prev = b.window === window - 1 ? b.count : 0;
      b.count = 0;
      b.window = window;
    }
    const estimated = weigh(b.prev, b.count, windowMs, nowMs);
    if (estimated >= rule.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds: retryAfter(windowMs, nowMs) };
    }
    b.count++;
    return { allowed: true, remaining: Math.max(0, Math.floor(rule.limit - estimated - 1)), retryAfterSeconds: 0 };
  }

  async reset(key: string): Promise<void> {
    for (const k of this.buckets.keys()) {
      if (k.slice(0, k.lastIndexOf(':')) === key) this.buckets.delete(k);
    }
  }

  private sweep() {
    const nowMs = this.now();
    for (const [k, b] of this.buckets) {
      // A bucket more than one full window behind carries no weight any more.
      if (Math.floor(nowMs / b.windowMs) - b.window > 1) this.buckets.delete(k);
    }
  }

  close() {
    clearInterval(this.sweeper);
  }
}

const REDIS_SCRIPT = `
local cur_key = KEYS[1]
local prev_key = KEYS[2]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local cur = tonumber(redis.call('GET', cur_key) or '0')
local prev = tonumber(redis.call('GET', prev_key) or '0')
local elapsed = (now_ms % window_ms) / window_ms
local estimated = prev * (1 - elapsed) + cur
if estimated >= limit then
  return {0, 0}
end
cur = redis.call('INCR', cur_key)
if cur == 1 then
  redis.call('PEXPIRE', cur_key, window_ms * 2)
end
return {1, math.floor(limit - estimated - 1)}
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = 'bauth:rl:',
  ) {}

  async hit(key: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const windowMs = rule.windowSeconds * 1000;
    const window = Math.floor(nowMs / windowMs);
    // Hash tag {key} keeps both windows in one Redis Cluster slot so the script stays atomic.
    const base = `${this.prefix}{${key}}:${rule.windowSeconds}`;
    const res = (await this.redis.eval(
      REDIS_SCRIPT,
      2,
      `${base}:${window}`,
      `${base}:${window - 1}`,
      rule.limit,
      windowMs,
      nowMs,
    )) as [number, number];
    const allowed = res[0] === 1;
    return {
      allowed,
      remaining: Math.max(0, res[1]),
      retryAfterSeconds: allowed ? 0 : retryAfter(windowMs, nowMs),
    };
  }

  async reset(key: string): Promise<void> {
    const stream = this.redis.scanStream({ match: `${this.prefix}{${key}}:*`, count: 100 });
    for await (const keys of stream as AsyncIterable<string[]>) {
      if (keys.length) await this.redis.del(...keys);
    }
  }
}

function retryAfter(windowMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((windowMs - (nowMs % windowMs)) / 1000));
}
