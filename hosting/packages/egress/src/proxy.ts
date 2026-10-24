import { lookup } from 'node:dns/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net from 'node:net';
import { Concurrency, TokenBuckets, isNonPublicAddress, type Log } from '@basalt/host-shared';

/**
 * Forward proxy for user workloads. Containers live on internal networks with no route out; this
 * proxy is their only path to the internet, so it is where outbound policy is enforced:
 * - destinations must resolve ONLY to public addresses (no host LAN, other containers, metadata)
 * - connect to the vetted IP, never re-resolve (defeats DNS rebinding)
 * - web ports only (no SMTP spam relaying from our machine)
 * - per-client connection and rate caps (our laptop is never an attack platform)
 */
export interface EgressOptions {
  ports?: number[];
  maxConnsPerClient?: number;
  newConnsPerMinute?: number;
  idleTimeoutMs?: number;
  maxLifetimeMs?: number;
  resolve?: (host: string) => Promise<string[]>;
  log?: Log;
}

export class EgressDenied extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function createEgressProxy(opts: EgressOptions = {}) {
  const ports = new Set(opts.ports ?? [80, 443]);
  const maxConns = opts.maxConnsPerClient ?? 128;
  const perMinute = opts.newConnsPerMinute ?? 1200;
  const idle = opts.idleTimeoutMs ?? 60_000;
  const lifetime = opts.maxLifetimeMs ?? 15 * 60_000;
  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true, verbatim: true })).map((a) => a.address));
  const conns = new Concurrency();
  const rate = new TokenBuckets(50_000);
  const stats = { allowed: 0, denied: 0 };

  async function vet(host: string, port: number, client: string): Promise<string> {
    if (!ports.has(port)) throw new EgressDenied(403, `port ${port} is not allowed (web ports only)`);
    if (!host || host.length > 253 || !/^[A-Za-z0-9.\-:[\]]+$/.test(host)) throw new EgressDenied(400, 'bad host');
    if (!rate.take(client, perMinute, Math.ceil(perMinute / 4)).ok) throw new EgressDenied(429, 'too many outbound connections');
    const bare = host.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(bare) ? [bare] : await resolve(bare).catch(() => [] as string[]);
    if (!addrs.length) throw new EgressDenied(502, `cannot resolve ${host}`);
    if (addrs.some(isNonPublicAddress)) throw new EgressDenied(403, `${host} is not a public internet destination`);
    return addrs[0]!;
  }

  const deny = (client: string, target: string, err: unknown) => {
    stats.denied++;
    opts.log?.warn('egress_denied', { client, target, reason: (err as Error).message });
  };

  const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // Plain-HTTP proxying (absolute-form URLs).
    const client = req.socket.remoteAddress ?? 'unknown';
    let url: URL;
    try {
      url = new URL(req.url ?? '');
      if (url.protocol !== 'http:') throw new Error();
    } catch {
      res.writeHead(400).end('absolute http:// URL required');
      return;
    }
    if (!conns.acquire(client, maxConns)) {
      res.writeHead(429).end('too many connections');
      return;
    }
    try {
      const port = Number(url.port || 80);
      const ip = await vet(url.hostname, port, client);
      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: url.host };
      delete headers['proxy-connection'];
      delete headers['proxy-authorization'];
      const upstream = http.request({ host: ip, port, method: req.method, path: url.pathname + url.search, headers, timeout: idle }, (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
      upstream.on('error', () => res.headersSent ? res.destroy() : res.writeHead(502).end('upstream error'));
      req.pipe(upstream);
      stats.allowed++;
      res.on('close', () => conns.release(client));
    } catch (err) {
      conns.release(client);
      deny(client, url.host, err);
      res.writeHead(err instanceof EgressDenied ? err.status : 502).end((err as Error).message);
    }
  });

  // HTTPS tunnelling (CONNECT host:port).
  server.on('connect', async (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    const client = socket.remoteAddress ?? 'unknown';
    const m = /^([^:]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/.exec(req.url ?? '');
    if (!m) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    if (!conns.acquire(client, maxConns)) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return;
    }
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        conns.release(client);
      }
    };
    socket.on('close', release);
    socket.on('error', () => {});
    try {
      const port = Number(m[2]);
      const ip = await vet(m[1]!, port, client);
      const upstream = net.connect({ host: ip, port }, () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.setTimeout(idle, () => upstream.destroy());
      const cap = setTimeout(() => {
        upstream.destroy();
        socket.destroy();
      }, lifetime);
      cap.unref();
      upstream.on('close', () => {
        clearTimeout(cap);
        socket.destroy();
      });
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      stats.allowed++;
    } catch (err) {
      deny(client, req.url ?? '', err);
      const status = err instanceof EgressDenied ? err.status : 502;
      socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`);
      release();
    }
  });

  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  return { server, stats };
}
