/**
 * In-process per-host metrics the control plane polls (for status tools, auto-rollback, sleep and
 * the owner's dashboard). Everything is bounded: 24 hours of per-minute history, capped maps and
 * ring buffers, so a flood of unique paths or clients can't grow memory.
 */
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
  /** Per-minute history, keyed by minute number (ms / 60 000), last 24 h. */
  minutes: Map<number, Minute>;
  /** Unique visitors per hour (IP buckets), last 24 h. */
  hours: Map<number, Set<string>>;
  pages: Map<string, number>;
  api: Map<string, number>;
  referrers: Map<string, number>;
  devices: Record<Device, number>;
  browsers: Record<string, number>;
  /** The latest requests, newest last. */
  access: AccessEntry[];
}

type Minute = { r: number; s2: number; s3: number; s4: number; s5: number; b: number; lat: number };
type Device = 'phone' | 'computer' | 'tablet' | 'bot';

export interface RequestInfo {
  ip: string;
  method: string;
  path: string;
  userAgent?: string;
  referer?: string;
  /** The client is on the app owner's allowlist. */
  allowed?: boolean;
}

export interface AccessEntry {
  at: number;
  method: string;
  path: string;
  status: number;
  ms: number;
  ip: string;
  device: Device;
  blocked?: string;
  allowed?: boolean;
}

export interface SecurityEvent {
  at: number;
  host: string;
  ip: string;
  reason: string;
  method: string;
  path: string;
  status: number;
  /** The client is allowlisted: refused, but not counted towards a ban. */
  allowed?: boolean;
  /** This request pushed the client into a ban. */
  banned?: boolean;
}

const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, Infinity];
const DAY_MINUTES = 1440;
const MAX_KEYS = 300;
const MAX_ACCESS = 300;
const MAX_EVENTS = 2000;
const MAX_HOUR_VISITORS = 20_000;
/** Blocked reasons that aren't attacks (load, unknown sites) stay out of the security feed. */
const NOT_SECURITY = new Set(['overloaded', 'unknown_host']);

export function classifyDevice(ua = ''): Device {
  if (!ua || /bot|crawl|spider|slurp|curl|wget|python|go-http|httpclient|java\/|okhttp|axios|node-fetch|undici|headless|scanner|nmap|nikto|sqlmap|zgrab|masscan/i.test(ua)) return 'bot';
  if (/ipad|tablet|kindle|silk|playbook|(android(?!.*mobile))/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|blackberry|opera mini|iemobile|windows phone/i.test(ua)) return 'phone';
  return 'computer';
}

export function classifyBrowser(ua = ''): string {
  if (/edg\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/chrome|crios|chromium/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  return 'Other';
}

/** Collapses ids in API paths so /api/todos/42 and /api/todos/43 count as one feature. */
function apiKey(path: string) {
  return path
    .split('/')
    .map((seg) => (/^\d+$|^[0-9a-f]{8,}$|^[0-9a-f-]{36}$|^[A-Za-z0-9_-]{20,}$/i.test(seg) ? ':id' : seg))
    .join('/')
    .slice(0, 120);
}

function bump(map: Map<string, number>, key: string) {
  const v = map.get(key);
  if (v !== undefined) map.set(key, v + 1);
  else if (map.size < MAX_KEYS) map.set(key, 1);
}

function top(map: Map<string, number>, n: number) {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count }));
}

export class Metrics {
  readonly hosts = new Map<string, HostStats>();
  readonly events: SecurityEvent[] = [];
  inflight = 0;

  private get(host: string): HostStats {
    let h = this.hosts.get(host);
    if (!h) {
      h = {
        requests: 0, s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0, blocked: {}, latencyMsSum: 0, latencyBuckets: BUCKETS.map(() => 0), lastRequestAt: 0, recent: [],
        minutes: new Map(), hours: new Map(), pages: new Map(), api: new Map(), referrers: new Map(),
        devices: { phone: 0, computer: 0, tablet: 0, bot: 0 }, browsers: {}, access: [],
      };
      this.hosts.set(host, h);
    }
    return h;
  }

  record(host: string, status: number, ms: number, blockedReason?: string, info?: RequestInfo, banned = false) {
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

    const minute = Math.floor(now / 60_000);
    let m = h.minutes.get(minute);
    if (!m) {
      m = { r: 0, s2: 0, s3: 0, s4: 0, s5: 0, b: 0, lat: 0 };
      h.minutes.set(minute, m);
      for (const k of h.minutes.keys()) if (k <= minute - DAY_MINUTES) h.minutes.delete(k);
    }
    m.r++;
    m.lat += ms;
    if (blockedReason) m.b++;
    if (status >= 500) m.s5++;
    else if (status >= 400) m.s4++;
    else if (status >= 300) m.s3++;
    else m.s2++;

    if (!info) return;
    const device = classifyDevice(info.userAgent);
    h.access.push({ at: now, method: info.method, path: info.path.slice(0, 200), status, ms: Math.round(ms), ip: info.ip, device, ...(blockedReason ? { blocked: blockedReason } : {}), ...(info.allowed ? { allowed: true } : {}) });
    if (h.access.length > MAX_ACCESS) h.access.splice(0, h.access.length - MAX_ACCESS);
    if (blockedReason && !NOT_SECURITY.has(blockedReason)) {
      this.events.push({ at: now, host, ip: info.ip, reason: blockedReason, method: info.method, path: info.path.slice(0, 200), status, ...(info.allowed ? { allowed: true } : {}), ...(banned ? { banned: true } : {}) });
      if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    if (blockedReason) return;

    // Visitors, pages, devices: real traffic only.
    const hour = Math.floor(now / 3_600_000);
    let v = h.hours.get(hour);
    if (!v) {
      v = new Set();
      h.hours.set(hour, v);
      for (const k of h.hours.keys()) if (k <= hour - 24) h.hours.delete(k);
    }
    if (v.size < MAX_HOUR_VISITORS) v.add(info.ip);
    const isApi = info.path === '/api' || info.path.startsWith('/api/');
    if (isApi) bump(h.api, `${info.method} ${apiKey(info.path)}`);
    else if (info.method === 'GET' && status < 400 && !info.path.startsWith('/_basalt/') && (!info.path.includes('.') || info.path.endsWith('.html'))) {
      bump(h.pages, info.path.slice(0, 120));
      h.devices[device]++;
      const b = device === 'bot' ? 'Bot' : classifyBrowser(info.userAgent);
      h.browsers[b] = (h.browsers[b] ?? 0) + 1;
      if (info.referer) {
        try {
          const ref = new URL(info.referer).hostname;
          if (ref && ref !== host) bump(h.referrers, ref);
        } catch {
          /* not a URL */
        }
      }
    }
  }

  private percentiles(h: HostStats) {
    const p = (q: number) => {
      const target = h.requests * q;
      let acc = 0;
      for (let i = 0; i < BUCKETS.length; i++) {
        acc += h.latencyBuckets[i]!;
        if (acc >= target) return BUCKETS[i] === Infinity ? '>5000' : BUCKETS[i];
      }
      return null;
    };
    return { avg: h.requests ? Math.round(h.latencyMsSum / h.requests) : 0, p50: p(0.5), p95: p(0.95), p99: p(0.99) };
  }

  snapshot() {
    const out: Record<string, unknown> = {};
    for (const [host, h] of this.hosts) {
      const cut = Date.now() - 120_000;
      const recent = h.recent.filter(([t]) => t >= cut);
      out[host] = {
        requests: h.requests,
        status: { '2xx': h.s2xx, '3xx': h.s3xx, '4xx': h.s4xx, '5xx': h.s5xx },
        blocked: h.blocked,
        latencyMs: this.percentiles(h),
        lastRequestAt: h.lastRequestAt ? new Date(h.lastRequestAt).toISOString() : null,
        last2m: { requests: recent.length, errors5xx: recent.filter(([, s]) => s >= 500).length },
      };
    }
    return { inflight: this.inflight, hosts: out };
  }

  /** Everything the owner's dashboard shows for one host. */
  detail(host: string) {
    const h = this.hosts.get(host);
    if (!h) return null;
    const nowMin = Math.floor(Date.now() / 60_000);
    const series: Array<[number, number, number, number, number, number, number]> = [];
    for (let k = nowMin - DAY_MINUTES + 1; k <= nowMin; k++) {
      const m = h.minutes.get(k);
      // [minute, requests, 2xx+3xx, 4xx, 5xx, blocked, avg ms]
      if (m) series.push([k * 60_000, m.r, m.s2 + m.s3, m.s4, m.s5, m.b, Math.round(m.lat / m.r)]);
    }
    const hourNow = Math.floor(Date.now() / 3_600_000);
    const visitors: Array<[number, number]> = [];
    const day = new Set<string>();
    for (let k = hourNow - 23; k <= hourNow; k++) {
      const v = h.hours.get(k);
      visitors.push([k * 3_600_000, v?.size ?? 0]);
      if (v) for (const ip of v) if (day.size < 100_000) day.add(ip);
    }
    return {
      totals: { requests: h.requests, status: { '2xx': h.s2xx, '3xx': h.s3xx, '4xx': h.s4xx, '5xx': h.s5xx }, blocked: h.blocked, latencyMs: this.percentiles(h), lastRequestAt: h.lastRequestAt || null },
      latencyBuckets: BUCKETS.map((b, i) => ({ upToMs: b === Infinity ? null : b, count: h.latencyBuckets[i] })),
      series,
      visitors: { perHour: visitors, last24h: day.size },
      pages: top(h.pages, 10),
      api: top(h.api, 10),
      referrers: top(h.referrers, 10),
      devices: h.devices,
      browsers: h.browsers,
      access: h.access.slice(-200),
    };
  }

  /** Security events (newest last), optionally only for some hosts. */
  securityEvents(hosts?: Set<string>, limit = 500) {
    const list = hosts ? this.events.filter((e) => hosts.has(e.host)) : this.events;
    return list.slice(-limit);
  }
}
