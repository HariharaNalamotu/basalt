import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * SSRF-safe outbound HTTP for fetching URLs that users can influence (link previews, webhooks,
 * image imports). Blocks private, loopback, link-local (incl. cloud metadata 169.254.169.254),
 * CGNAT, multicast and reserved ranges. The check runs on the address actually connected to —
 * after DNS resolution, on every redirect hop — so DNS rebinding and redirect tricks don't work.
 */
export interface SafeFetchOptions {
  /** Default 10s, max 30s. */
  timeoutMs?: number;
  /** Max response body. Default 5 MB, max 50 MB. */
  maxBytes?: number;
  /** Default 3, max 5. */
  maxRedirects?: number;
  /** Allowed destination ports. Default [80, 443]. */
  ports?: number[];
}

export type SafeFetch = (url: string | URL, init?: SafeRequestInit) => Promise<Response>;
export type SafeRequestInit = { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal };

export class SafeFetchError extends Error {
  override readonly name = 'SafeFetchError';
  constructor(
    readonly reason: 'blocked_destination' | 'bad_url' | 'too_many_redirects' | 'too_large' | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

// Separate lists: a single BlockList matches IPv4 addresses against IPv4-mapped IPv6 rules.
const blocked4 = new BlockList();
const blocked6 = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked4.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked6.addSubnet(net, prefix, 'ipv6');

/** True if the address is anything other than a normal public unicast address. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked4.check(address, 'ipv4');
  if (family !== 6) return true;
  // IPv4-mapped/compatible IPv6 (::ffff:1.2.3.4, ::ffff:7f00:1, ::1.2.3.4) is never needed for public fetches.
  if (/^(0{0,4}:){0,5}:?(ffff:)?(\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}:[0-9a-f]{1,4})$/i.test(address) && address.includes('::')) return true;
  return blocked6.check(address, 'ipv6');
}

type LookupFn = (hostname: string, opts: { all: true }, cb: (err: NodeJS.ErrnoException | null, addrs: LookupAddress[]) => void) => void;

function guardedLookup(resolve: LookupFn) {
  return (hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
    resolve(hostname, { all: true }, (err, addrs) => {
      if (err) return callback(err);
      // Reject if ANY resolved address is internal: attackers control which one gets used.
      const bad = addrs.find((a) => isBlockedAddress(a.address));
      if (bad || addrs.length === 0) {
        return callback(new SafeFetchError('blocked_destination', `Destination ${hostname} resolves to a non-public address.`));
      }
      if (options.all) callback(null, addrs);
      else callback(null, addrs[0]!.address, addrs[0]!.family);
    });
  };
}

export function createSafeFetch(defaults: SafeFetchOptions = {}, internals: { lookup?: LookupFn } = {}): SafeFetch {
  const timeoutMs = Math.min(defaults.timeoutMs ?? 10_000, 30_000);
  const maxBytes = Math.min(defaults.maxBytes ?? 5 * 1024 * 1024, 50 * 1024 * 1024);
  const maxRedirects = Math.min(defaults.maxRedirects ?? 3, 5);
  const ports = new Set(defaults.ports ?? [80, 443]);
  const agent = new Agent({
    connect: { lookup: guardedLookup(internals.lookup ?? (dnsLookup as unknown as LookupFn)) as never, timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  function check(url: URL) {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SafeFetchError('bad_url', 'Only http(s) URLs are allowed.');
    if (url.username || url.password) throw new SafeFetchError('bad_url', 'URLs with credentials are not allowed.');
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (!ports.has(port)) throw new SafeFetchError('blocked_destination', `Port ${port} is not allowed.`);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Literal IPs skip DNS, so check them here.
    if (isIP(host) && isBlockedAddress(host)) throw new SafeFetchError('blocked_destination', 'Destination address is not public.');
  }

  return async (input, init = {}) => {
    let url: URL;
    try {
      url = new URL(String(input));
    } catch {
      throw new SafeFetchError('bad_url', 'Invalid URL.');
    }
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let method = (init.method ?? 'GET').toUpperCase();
    let body = init.body;
    for (let hop = 0; ; hop++) {
      check(url);
      let res;
      try {
        res = await undiciFetch(url, { method, headers: init.headers, body, redirect: 'manual', dispatcher: agent, signal });
      } catch (err) {
        const cause = (err as { cause?: unknown }).cause;
        if (cause instanceof SafeFetchError) throw cause;
        if ((err as Error).name === 'TimeoutError' || (err as Error).name === 'AbortError') throw new SafeFetchError('timeout', 'The request timed out.');
        throw err;
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        if (hop >= maxRedirects) throw new SafeFetchError('too_many_redirects', 'Too many redirects.');
        url = new URL(res.headers.get('location')!, url);
        if (res.status !== 307 && res.status !== 308) {
          method = 'GET';
          body = undefined;
        }
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        await res.body?.cancel();
        throw new SafeFetchError('too_large', 'Response is too large.');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          total += chunk.byteLength;
          if (total > maxBytes) throw new SafeFetchError('too_large', 'Response is too large.');
          chunks.push(chunk);
        }
      }
      const headers = new Headers();
      res.headers.forEach((v, k) => headers.set(k, v));
      return new Response(res.status === 204 || res.status === 304 ? null : Buffer.concat(chunks), { status: res.status, statusText: res.statusText, headers });
    }
  };
}
