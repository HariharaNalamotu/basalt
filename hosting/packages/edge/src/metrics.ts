/** In-process per-host metrics the control plane polls (for status tools, auto-rollback and sleep). */
export interface HostStats {
  requests: number;
  s2xx: number;
  s3xx: number;
  s4xx: number;
  s5xx: number;
  blocked: Record<string, number>;
  latencyMsSum: number;
  latencyBuckets: number[];
  lastRequestAt: number;
  /** Recent requests window (for error-rate checks after a release). */
  recent: Array<[number, number]>;
}

const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];

export class Metrics {
  readonly hosts = new Map<string, HostStats>();
  inflight = 0;

  private get(host: string): HostStats {
    let h = this.hosts.get(host);
    if (!h) {
      h = { requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, blocked: {}, latencyMsSum: 0, latencyBuckets: BUCKETS.map(() => 0), lastRequestAt: 0, recent: [] };
      this.hosts.set(host, h);
    }
    return h;
  }

  record(host: string, status: number, ms: number, blockedReason?: string) {
    const h = this.get(host);
    const now = Date.now();
    h.requests++;
    h.lastRequestAt = now;
    if (status >= 500) h.s5xx++;
    else if (status >= 400) h.s4xx++;
    else if (status >= 300) h.s3xx++;
    else h.s2xx++;
    if (blockedReason) h.blocked[blockedReason] = (h.blocked[blockedReason] ?? 0) + 1;
    h.latencyMsSum += ms;
    h.latencyBuckets[BUCKETS.findIndex((b) => ms <= b)]!++;
    h.recent.push([now, status]);
    if (h.recent.length > 2000 || (h.recent[0] && h.recent[0][0] < now - 600_000)) h.recent.splice(0, Math.max(1, h.recent.length - 2000));
  }

  snapshot() {
    const out: Record<string, unknown> = {};
    for (const [host, h] of this.hosts) {
      const p = (q: number) => {
        const target = h.requests * q;
        let acc = 0;
        for (let i = 0; i < BUCKETS.length; i++) {
          acc += h.latencyBuckets[i]!;
          if (acc >= target) return BUCKETS[i] === Infinity ? '>5000' : BUCKETS[i];
        }
        return null;
      };
      const cut = Date.now() - 120_000;
      const recent = h.recent.filter(([t]) => t >= cut);
      out[host] = {
        requests: h.requests,
        status: { '2xx': h.s2xx, '3xx': h.s3xx, '4xx': h.s4xx, '5xx': h.s5xx },
        blocked: h.blocked,
        latencyMs: { avg: h.requests ? Math.round(h.latencyMsSum / h.requests) : 0, p50: p(0.5), p95: p(0.95), p99: p(0.99) },
        lastRequestAt: h.lastRequestAt ? new Date(h.lastRequestAt).toISOString() : null,
        last2m: { requests: recent.length, errors5xx: recent.filter(([, s]) => s >= 500).length },
      };
    }
    return { inflight: this.inflight, hosts: out };
  }
}
