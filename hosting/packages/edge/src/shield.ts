import { TokenBuckets } from '@basalt/host-shared';

/**
 * Per-client abuse tracking. Misbehaviour (rate-limit hits, exploit probes, malformed requests)
 * adds to a decaying score; crossing the threshold bans the client, with escalating durations
 * for repeat offenders. Bounded memory: least-recently-seen clients are evicted first.
 */
export interface ShieldOptions {
  banThreshold?: number;
  baseBanMs?: number;
  maxBanMs?: number;
  /** Score points that decay per minute. */
  decayPerMinute?: number;
  maxClients?: number;
}

type Entry = { score: number; at: number; bannedUntil: number; bans: number };

const SCANNER_PATH = /^\/(?:\.env|\.git|\.svn|\.hg|\.ds_store|\.aws|\.ssh|\.htaccess|\.htpasswd|wp-admin|wp-login\.php|wp-content|wp-includes|xmlrpc\.php|phpmyadmin|pma|myadmin|admin\.php|cgi-bin|server-status|actuator|vendor\/phpunit|boaform|hnap1|solr|console|owa|autodiscover|telescope|_profiler|debug\/default)(?:\/|$|\?)/i;
const ATTACK = [
  /\.\.[/\\]/, // traversal (after decoding)
  /<\s*script/i,
  /\bunion(\s|\/\*.*?\*\/)+(all\s+)?select\b/i,
  /\/etc\/(passwd|shadow)/i,
  /\$\{\s*jndi\s*:/i,
  /;\s*(rm|wget|curl|nc|bash|sh)\s/i,
  /\bsleep\(\s*\d+\s*\)/i,
  /\bwaitfor\s+delay\b/i,
];

export type Verdict = { ok: true } | { ok: false; status: number; reason: string; score: number };

export class Shield {
  private readonly clients = new Map<string, Entry>();
  private readonly o: Required<ShieldOptions>;
  readonly buckets = new TokenBuckets();

  constructor(opts: ShieldOptions = {}) {
    this.o = { banThreshold: 30, baseBanMs: 10 * 60_000, maxBanMs: 24 * 3600_000, decayPerMinute: 2, maxClients: 200_000, ...opts };
  }

  private entry(key: string, now: number): Entry {
    let e = this.clients.get(key);
    if (e) {
      this.clients.delete(key);
      e.score = Math.max(0, e.score - ((now - e.at) / 60_000) * this.o.decayPerMinute);
      e.at = now;
    } else {
      if (this.clients.size >= this.o.maxClients) this.clients.delete(this.clients.keys().next().value!);
      e = { score: 0, at: now, bannedUntil: 0, bans: 0 };
    }
    this.clients.set(key, e);
    return e;
  }

  bannedFor(key: string, now = Date.now()): number {
    const e = this.clients.get(key);
    return e && e.bannedUntil > now ? Math.ceil((e.bannedUntil - now) / 1000) : 0;
  }

  /** Adds misbehaviour points; returns true if this pushed the client into a ban. */
  penalize(key: string, points: number, now = Date.now()): boolean {
    const e = this.entry(key, now);
    if (e.bannedUntil > now) return false;
    e.score += points;
    if (e.score >= this.o.banThreshold) {
      e.bans++;
      e.bannedUntil = now + Math.min(this.o.maxBanMs, this.o.baseBanMs * 2 ** (e.bans - 1));
      e.score = 0;
      return true;
    }
    return false;
  }

  /** Static request inspection: exploit scanners and attack signatures. */
  inspect(path: string, query: string): Verdict {
    if (SCANNER_PATH.test(path)) return { ok: false, status: 404, reason: 'scanner_path', score: 5 };
    let decodedQuery = query;
    try {
      decodedQuery = decodeURIComponent(query.replace(/\+/g, ' '));
    } catch {
      return { ok: false, status: 400, reason: 'bad_encoding', score: 3 };
    }
    for (const re of ATTACK) {
      if (re.test(path) || re.test(decodedQuery)) return { ok: false, status: 403, reason: 'attack_signature', score: 10 };
    }
    return { ok: true };
  }

  unban(key: string) {
    this.clients.delete(key);
  }

  bans(now = Date.now()) {
    return [...this.clients].filter(([, e]) => e.bannedUntil > now).map(([ip, e]) => ({ ip, until: new Date(e.bannedUntil).toISOString(), bans: e.bans }));
  }
}

/**
 * Validates and normalizes the request target. Rejects anything a filesystem or upstream could
 * interpret differently from us (encoded traversal, NUL, backslashes, control characters).
 */
export function normalizePath(rawUrl: string): { path: string; query: string } | null {
  if (!rawUrl.startsWith('/') || rawUrl.length > 8192) return null;
  const q = rawUrl.indexOf('?');
  const rawPath = q === -1 ? rawUrl : rawUrl.slice(0, q);
  const query = q === -1 ? '' : rawUrl.slice(q + 1);
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (/[\x00-\x1f\x7f\\]/.test(path)) return null;
  if (path.split('/').some((seg) => seg === '..' || seg === '.')) return null;
  if (/%(2e|2f|5c|00)/i.test(path)) return null; // double-encoding tricks
  return { path, query };
}
