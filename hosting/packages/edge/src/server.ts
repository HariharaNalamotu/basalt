import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { Agent, request as undiciRequest } from 'undici';
import { Concurrency, ipBucket, verifyToken, type AppRoute, type Log, type Route, type ServiceRoute } from '@basalt/host-shared';
import { challengePage, CLEARANCE_COOKIE, hasClearance, issueChallenge, verifySolution } from './challenge.js';
import { Metrics } from './metrics.js';
import { normalizePath, Shield } from './shield.js';
import { serveStatic } from './static.js';
import type { RouteTableClient } from './table.js';

export const ACCESS_COOKIE = 'basalt_access';
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
// Never forwarded from clients: they carry the edge's authority or are hop-by-hop.
const STRIP_REQUEST = [
  'basalt-edge-signature', 'x-request-id', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-prefix',
  'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'x-basalt-access', 'connection', 'keep-alive',
  'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host',
];
const STRIP_RESPONSE = ['connection', 'keep-alive', 'transfer-encoding', 'server', 'x-powered-by'];
// Basalt's own routes on an app's site are same-site only: its page never needs a cross-site allowance.
const CROSS_SITE = ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers', 'access-control-max-age'];
// The only Data block routes a browser may reach through /_basalt/data.
const DATA_POST = /^\/v1\/(data\/(get|list|create|update|archive|restore)|files|files\/link)$/;
const DATA_GET = /^\/v1\/files\/download\/[0-9a-f]{64}$/;
const DATA_MAX_BODY = 256 * 1024;
const DATA_MAX_UPLOAD = 6 * 1024 * 1024; // the Data block takes files up to 5 MB

// Re-encodes a decoded path for forwarding. encodeURI leaves ? and # alone, so an encoded %3F in the
// path would come back out as a real query string the edge never checked: encode them too.
function encodePath(path: string): string {
  return encodeURI(path).replace(/[?#]/g, (c) => encodeURIComponent(c));
}

export interface EdgeOptions {
  table: RouteTableClient;
  /** Signs challenge/clearance tokens. */
  edgeKey: string;
  /** Auth service base URL on the platform network. */
  authUrl: string;
  /** Called to start a sleeping environment. */
  wake: (envId: string) => Promise<void>;
  /** Proxies whose CF-Connecting-IP header we trust (cloudflared). Exact IPs. */
  trustedProxies: Set<string>;
  log: Log;
  limits?: { globalInflight?: number; perIpInflight?: number; perIpPerMinute?: number };
  /**
   * How browsers reach the plain (non-TLS) listener. Behind Cloudflare that's https on the default
   * port (the default). The one-laptop demo serves http on :8080, so the origin backends compare
   * against (x-forwarded-proto/host) must say so. The internal TLS listener is always https.
   */
  publicOrigin?: { scheme: 'http' | 'https'; port?: number };
}

/** One canonical form for forwarding AND signing, identical to what the backend reconstructs. */
function canonicalUrl(raw: string): string {
  const u = new URL(raw, 'http://edge.invalid');
  return u.pathname + u.search;
}

export function createEdgeHandler(o: EdgeOptions) {
  const shield = new Shield();
  const metrics = new Metrics();
  const perIpInflight = new Concurrency();
  const backends = new Concurrency();
  const agent = new Agent({ keepAliveTimeout: 30_000, connections: 256, headersTimeout: 30_000, bodyTimeout: 60_000 });
  const globalInflight = o.limits?.globalInflight ?? 4000;
  const ipInflightMax = o.limits?.perIpInflight ?? 64;
  const ipPerMinute = o.limits?.perIpPerMinute ?? 2400;

  function clientIp(req: IncomingMessage): string {
    const remote = req.socket.remoteAddress ?? '0.0.0.0';
    if (o.trustedProxies.has(remote)) {
      const cf = req.headers['cf-connecting-ip'];
      if (typeof cf === 'string' && isIP(cf)) return cf;
    }
    return remote.replace(/^::ffff:/, '');
  }

  function cookie(req: IncomingMessage, name: string): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return undefined;
  }

  /** Our own cookies never reach apps. */
  function cookiesForUpstream(req: IncomingMessage): string | undefined {
    const raw = req.headers.cookie;
    if (!raw) return undefined;
    const kept = raw.split(';').filter((p) => {
      const n = p.split('=')[0]!.trim();
      return n !== ACCESS_COOKIE && n !== CLEARANCE_COOKIE;
    });
    return kept.length ? kept.join(';').trim() : undefined;
  }

  function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}) {
    if (res.headersSent) return res.destroy();
    const isHtml = body.startsWith('<!doctype');
    res.writeHead(status, {
      'content-type': isHtml ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Pages the edge writes itself (not found, private, expired link) are fixed text: nothing
      // on them loads, runs or is styled. The challenge page passes its own policy, which wins.
      ...(isHtml ? { 'content-security-policy': "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" } : {}),
      ...headers,
    });
    res.end(body);
  }

  const errorJson = (code: string, message: string, requestId: string) => JSON.stringify({ error: { code, message, requestId } });

  function securityHeaders(route: AppRoute, html: boolean, nonce?: string): Record<string, string> {
    const h: Record<string, string> = {
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'cross-origin-opener-policy': 'same-origin',
      'x-frame-options': 'DENY',
    };
    if (route.env === 'production') h['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
    else h['x-robots-tag'] = 'noindex, nofollow';
    if (html) {
      const c = route.csp;
      const list = (base: string[], extra: string[]) => [...base, ...extra].join(' ');
      h['content-security-policy'] = [
        `default-src 'self'`,
        `script-src ${list(["'self'"], [...c.scriptSrc, ...(nonce ? [`'nonce-${nonce}'`] : [])])}`,
        // No inline <style> blocks (injected CSS can read the page), but style="" attributes, which
        // React's style={...} writes, still work.
        `style-src ${list(["'self'"], c.styleSrc)}`,
        `style-src-attr 'unsafe-inline'`,
        `img-src ${list(["'self'", 'data:', 'blob:'], c.imgSrc)}`,
        `font-src ${list(["'self'", 'data:'], c.fontSrc)}`,
        `connect-src ${list(["'self'"], c.connectSrc)}`,
        `frame-src ${c.frameSrc.length ? c.frameSrc.join(' ') : "'none'"}`,
        `frame-ancestors 'none'`,
        `base-uri 'self'`,
        `form-action 'self'`,
        `object-src 'none'`,
      ].join('; ');
    }
    return h;
  }

  function signForBackend(secret: string, method: string, pathAndQuery: string, requestId: string) {
    const t = Math.floor(Date.now() / 1000).toString();
    const mac = createHmac('sha256', secret).update(`${t}\n${method}\n${pathAndQuery}\n${requestId}`).digest('hex');
    return `t=${t},v1=${mac}`;
  }

  async function proxy(
    req: IncomingMessage,
    res: ServerResponse,
    target: string,
    headers: Record<string, string>,
    maxBody: number,
    extraResponseHeaders: Record<string, string>,
    dropResponseHeaders: string[] = [],
  ): Promise<number> {
    const declared = Number(req.headers['content-length'] ?? 0);
    // The unread body would otherwise stall the next request on this connection.
    if (declared > maxBody) {
      res.setHeader('connection', 'close');
      return -413;
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method ?? 'GET') && (declared > 0 || req.headers['transfer-encoding'] !== undefined);
    let seen = 0;
    let tooLarge = false;
    const body = hasBody
      ? Readable.from(
          (async function* () {
            for await (const chunk of req) {
              seen += (chunk as Buffer).length;
              if (seen > maxBody) {
                tooLarge = true;
                throw new Error('body_too_large');
              }
              yield chunk as Buffer;
            }
          })(),
        )
      : undefined;
    let up;
    try {
      up = await undiciRequest(target, {
        method: req.method as 'GET',
        headers,
        body,
        dispatcher: agent,
        headersTimeout: 30_000,
        bodyTimeout: 60_000,
      });
    } catch (err) {
      // Chunked bodies have no declared length; the stream counter is what enforces the limit.
      if (tooLarge) {
        res.setHeader('connection', 'close');
        return -413;
      }
      throw err;
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined && !STRIP_RESPONSE.includes(k) && !dropResponseHeaders.includes(k)) out[k] = v;
    res.writeHead(up.statusCode, { ...out, ...extraResponseHeaders });
    for await (const chunk of up.body) if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    res.end();
    return up.statusCode;
  }

  function upstreamHeaders(req: IncomingMessage, ip: string, requestId: string, host: string): Record<string, string> {
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers as IncomingHttpHeaders)) {
      if (v === undefined || STRIP_REQUEST.includes(k) || k === 'cookie') continue;
      h[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    const c = cookiesForUpstream(req);
    if (c) h.cookie = c;
    h['x-forwarded-for'] = ip;
    const tls = Boolean((req.socket as { encrypted?: boolean }).encrypted);
    const port = tls ? undefined : o.publicOrigin?.port;
    h['x-forwarded-host'] = port ? `${host}:${port}` : host;
    h['x-forwarded-proto'] = tls ? 'https' : (o.publicOrigin?.scheme ?? 'https');
    h['x-request-id'] = requestId;
    return h;
  }

  async function handleService(req: IncomingMessage, res: ServerResponse, route: ServiceRoute, ip: string, requestId: string, path: string, query: string) {
    if (!route.methods.includes(req.method ?? 'GET')) {
      send(res, 405, errorJson('method_not_allowed', 'Method not allowed.', requestId), { allow: route.methods.join(', ') });
      return 405;
    }
    const target = `${route.upstream.replace(/\/+$/, '')}${encodePath(path)}${query ? `?${query}` : ''}`;
    const headers = upstreamHeaders(req, ip, requestId, route.host);
    // Platform services build absolute URLs from Host (the registry's tarball links, for one), so
    // they see the public name people used, never their internal one.
    headers.host = headers['x-forwarded-host']!;
    const r = await proxy(req, res, target, headers, 50 * 1024 * 1024, { 'strict-transport-security': 'max-age=63072000' });
    if (r === -413) send(res, 413, errorJson('payload_too_large', 'Request body too large.', requestId));
    return r === -413 ? 413 : r;
  }

  async function handleApp(req: IncomingMessage, res: ServerResponse, route: AppRoute, ip: string, ipKey: string, requestId: string, path: string, query: string, rawUrl: string, client: { allowed: boolean; penalize: (points: number, reason: string) => boolean }): Promise<number> {
    const method = req.method ?? 'GET';

    // Edge-owned endpoints.
    if (path === '/_basalt/edge-health') {
      send(res, 200, JSON.stringify({ ok: true }));
      return 200;
    }
    if (path === '/_basalt/access' && method === 'GET') {
      const t = new URLSearchParams(query).get('t');
      const payload = route.accessKey ? verifyToken<{ env: string; exp: number }>(route.accessKey, t) : null;
      if (!payload || payload.env !== route.envId) {
        send(res, 403, '<!doctype html><title>Link expired</title><p>This share link has expired or isn\'t valid.</p><p>Ask the person building the app (or Claude) for a fresh share link. If you own the app, open it from your Basalt dashboard instead.</p>', securityHeaders(route, false));
        return 403;
      }
      res.writeHead(303, {
        location: '/',
        'set-cookie': `${ACCESS_COOKIE}=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.max(1, payload.exp - Math.floor(Date.now() / 1000))}`,
        'cache-control': 'no-store',
        ...securityHeaders(route, false),
      });
      res.end();
      return 303;
    }
    if (path === '/_basalt/challenge' && method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2048) break;
      }
      let body: { challenge?: unknown; nonce?: unknown } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* invalid */
      }
      const clearance = verifySolution(o.edgeKey, ipKey, route.host, body.challenge, body.nonce);
      if (!clearance) {
        client.penalize(2, 'challenge_failed');
        send(res, 403, errorJson('challenge_failed', 'Challenge failed.', requestId));
        return 403;
      }
      send(res, 204, '', { 'set-cookie': `${CLEARANCE_COOKIE}=${clearance}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600` });
      return 204;
    }

    // Non-production environments are private: signed access token (cookie or header) required.
    if (route.accessKey) {
      const token = cookie(req, ACCESS_COOKIE) ?? (req.headers['x-basalt-access'] as string | undefined);
      const payload = verifyToken<{ env: string; exp: number }>(route.accessKey, token);
      if (!payload || payload.env !== route.envId) {
        const wantsHtml = (req.headers.accept ?? '').includes('text/html');
        if (wantsHtml) send(res, 401, '<!doctype html><title>Private test version</title><p>This is a private test version of the app, so it needs a share link.</p><p>Ask the person building the app (or Claude) for a fresh share link. If you own the app, open it from your Basalt dashboard instead.</p>', securityHeaders(route, false));
        else send(res, 401, errorJson('environment_private', 'This environment is private.', requestId));
        return 401;
      }
    }

    // Under attack: require proof-of-work clearance (the owner's allowlisted clients skip it).
    if (!client.allowed && (route.protection.underAttack || o.table.current.underAttack)) {
      if (!hasClearance(o.edgeKey, ipKey, route.host, cookie(req, CLEARANCE_COOKIE))) {
        if (method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
          const nonce = randomBytes(12).toString('base64');
          send(res, 200, challengePage(issueChallenge(o.edgeKey, ipKey, route.host), nonce), {
            ...securityHeaders(route, true, nonce),
            'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'nonce-${nonce}'`,
          });
          return 200;
        }
        send(res, 403, errorJson('challenge_required', 'Please load the site in a browser first.', requestId));
        return 403;
      }
    }

    // Auth service.
    if (path === '/_basalt/auth' || path.startsWith('/_basalt/auth/')) {
      const rest = path.slice('/_basalt/auth'.length);
      const target = `${o.authUrl}/v1/projects/${route.projectId}${encodePath(rest)}${query ? `?${query}` : ''}`;
      const headers = upstreamHeaders(req, ip, requestId, route.host);
      headers['x-forwarded-prefix'] = '/_basalt/auth';
      const r = await proxy(req, res, target, headers, 64 * 1024, securityHeaders(route, false));
      if (r === -413) {
        send(res, 413, errorJson('payload_too_large', 'Request body too large.', requestId));
        return 413;
      }
      return r;
    }

    // The Data block, on the app's own site so the session cookie reaches it. Only its data and
    // file routes pass; the Data service checks the cookie, its origin and every row itself.
    if (path === '/_basalt/data' || path.startsWith('/_basalt/data/')) {
      const rest = path.slice('/_basalt/data'.length);
      const allowed = route.dataUrl !== null && ((method === 'POST' && DATA_POST.test(rest)) || (method === 'GET' && DATA_GET.test(rest)));
      if (!allowed) {
        send(res, 404, errorJson('not_found', 'Not found.', requestId));
        return 404;
      }
      const headers = upstreamHeaders(req, ip, requestId, route.host);
      const limit = rest === '/v1/files' ? DATA_MAX_UPLOAD : DATA_MAX_BODY;
      const r = await proxy(req, res, `${route.dataUrl!.replace(/\/+$/, '')}${rest}`, headers, limit, securityHeaders(route, false), ['set-cookie', ...CROSS_SITE]);
      if (r === -413) {
        send(res, 413, errorJson('payload_too_large', 'Request body too large.', requestId));
        return 413;
      }
      return r;
    }

    // Backend internals (introspection, OpenAPI, readiness) are for the platform only, never public.
    if (path.startsWith('/_basalt/')) {
      send(res, 404, errorJson('not_found', 'Not found.', requestId));
      return 404;
    }

    // Backend API.
    if (path === '/api' || path.startsWith('/api/')) {
      if (!route.backend) {
        send(res, 404, errorJson('not_found', 'Not found.', requestId));
        return 404;
      }
      let current: AppRoute = route;
      if (current.sleeping) current = (await wakeAndWait(current)) ?? current;
      if (current.sleeping || !current.backend) {
        send(res, 503, errorJson('waking_up', 'The app is starting. Please retry.', requestId), { 'retry-after': '3' });
        return 503;
      }
      if (!backends.acquire(current.envId, current.protection.maxConcurrency)) {
        send(res, 503, errorJson('busy', 'The app is busy. Please retry.', requestId), { 'retry-after': '1' });
        return 503;
      }
      try {
        const headers = upstreamHeaders(req, ip, requestId, current.host);
        headers['basalt-edge-signature'] = signForBackend(current.edgeSecret, method, rawUrl, requestId);
        const attempt = () => proxy(req, res, `${current.backend}${rawUrl}`, headers, current.protection.maxBodyBytes, securityHeaders(current, false));
        let r: number;
        try {
          r = await attempt();
        } catch (err) {
          const code = (err as { code?: string }).code ?? '';
          // Backend container gone (slept/crashed): wake once for safe methods.
          if ((method === 'GET' || method === 'HEAD') && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT/.test(code + String((err as Error).message))) {
            const woken = await wakeAndWait({ ...current, sleeping: true });
            if (woken && !woken.sleeping && woken.backend) {
              current = woken;
              headers['basalt-edge-signature'] = signForBackend(current.edgeSecret, method, rawUrl, requestId);
              r = await attempt();
            } else throw err;
          } else throw err;
        }
        if (r === -413) {
          send(res, 413, errorJson('payload_too_large', 'Request body too large.', requestId));
          return 413;
        }
        return r;
      } finally {
        backends.release(current.envId);
      }
    }

    // Static frontend.
    if (!route.staticDir) {
      send(res, 404, errorJson('not_found', 'Not found.', requestId));
      return 404;
    }
    const isHtmlish = !path.includes('.') || path.endsWith('.html') || path.endsWith('/');
    const r = await serveStatic(req, res, route.staticDir, path, { production: route.env === 'production', headers: securityHeaders(route, isHtmlish) });
    if (r.status >= 400) {
      send(res, r.status, r.status === 404 ? '<!doctype html><title>Not found</title><p>Not found.</p>' : errorJson('method_not_allowed', 'Method not allowed.', requestId), {
        ...securityHeaders(route, false),
        ...(r.status === 405 ? { allow: 'GET, HEAD' } : {}),
      });
    }
    return r.status;
  }

  async function wakeAndWait(route: AppRoute): Promise<AppRoute | undefined> {
    await o.wake(route.envId).catch((err) => o.log.warn('wake_failed', { env: route.envId, err: (err as Error).message }));
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      await o.table.changed(1500);
      const r = o.table.lookup(route.host);
      if (r && r.kind === 'app' && !r.sleeping && r.backend) return r;
    }
    return undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = performance.now();
    const requestId = randomUUID();
    const ip = clientIp(req);
    const ipKey = ipBucket(ip);
    const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    let status = 0;
    let blocked: string | undefined;
    let bannedNow = false;
    let path = (req.url ?? '/').split('?')[0]!.slice(0, 200);
    metrics.inflight++;
    // The app's owner can always let some clients through (their own machine, a security test):
    // they're never banned or rate limited on that owner's apps. Other sites still apply bans.
    const route: Route | undefined = host ? o.table.lookup(host) : undefined;
    const allowed = route?.kind === 'app' && Boolean(route.allowIps?.includes(ipKey));
    const penalize = (points: number, reason: string) => {
      if (allowed) return false;
      const b = shield.penalize(ipKey, points, Date.now(), { reason, host });
      if (b) bannedNow = true;
      return b;
    };
    const ipSlot = perIpInflight.acquire(ipKey, allowed ? Number.MAX_SAFE_INTEGER : ipInflightMax);
    try {
      res.setHeader('x-request-id', requestId);
      const banned = allowed ? 0 : shield.bannedFor(ipKey);
      if (banned) {
        blocked = 'banned';
        send(res, 403, errorJson('blocked', 'Access temporarily blocked.', requestId), { 'retry-after': String(banned) });
        status = 403;
        return;
      }
      if (!ipSlot) {
        blocked = 'ip_concurrency';
        penalize(1, blocked);
        send(res, 429, errorJson('rate_limited', 'Too many concurrent requests.', requestId), { 'retry-after': '1' });
        status = 429;
        return;
      }
      if (metrics.inflight > globalInflight) {
        blocked = 'overloaded';
        send(res, 503, errorJson('overloaded', 'Server busy. Please retry.', requestId), { 'retry-after': '2' });
        status = 503;
        return;
      }
      const method = req.method ?? '';
      if (!ALLOWED_METHODS.has(method)) {
        blocked = 'bad_method';
        penalize(2, blocked);
        send(res, 405, errorJson('method_not_allowed', 'Method not allowed.', requestId));
        status = 405;
        return;
      }
      const target = normalizePath(req.url ?? '');
      if (!target || !host) {
        blocked = 'bad_request';
        penalize(3, blocked);
        send(res, 400, errorJson('bad_request', 'Bad request.', requestId));
        status = 400;
        return;
      }
      path = target.path.slice(0, 200);
      if (!allowed) {
        const g = shield.buckets.take(`ip:${ipKey}`, ipPerMinute);
        if (!g.ok) {
          blocked = 'rate_limited';
          penalize(1, blocked);
          send(res, 429, errorJson('rate_limited', 'Too many requests.', requestId), { 'retry-after': String(g.retryAfter) });
          status = 429;
          return;
        }
      }
      if (!route) {
        blocked = 'unknown_host';
        send(res, 404, errorJson('unknown_site', 'Unknown site.', requestId));
        status = 404;
        return;
      }
      const verdict = shield.inspect(target.path, target.query);
      if (!verdict.ok) {
        blocked = verdict.reason;
        if (penalize(verdict.score, verdict.reason)) o.log.warn('client_banned', { ip, reason: verdict.reason });
        send(res, verdict.status, errorJson(verdict.status === 404 ? 'not_found' : 'blocked', verdict.status === 404 ? 'Not found.' : 'Request blocked.', requestId));
        status = verdict.status;
        return;
      }
      if (!allowed) {
        const perMinute = route.kind === 'app' ? route.protection.perIpPerMinute : route.perIpPerMinute;
        const r = shield.buckets.take(`${host}|${ipKey}`, perMinute);
        if (!r.ok) {
          blocked = 'rate_limited';
          penalize(1, blocked);
          send(res, 429, errorJson('rate_limited', 'Too many requests.', requestId), { 'retry-after': String(r.retryAfter) });
          status = 429;
          return;
        }
      }
      status =
        route.kind === 'service'
          ? await handleService(req, res, route, ip, requestId, target.path, target.query)
          : await handleApp(req, res, route, ip, ipKey, requestId, target.path, target.query, canonicalUrl(req.url ?? '/'), { allowed, penalize });
    } catch (err) {
      status = 502;
      o.log.warn('upstream_error', { host, err: (err as Error).message, requestId });
      if (!res.headersSent) send(res, 502, errorJson('bad_gateway', 'The app could not be reached.', requestId));
      else res.destroy();
    } finally {
      metrics.inflight--;
      if (ipSlot) perIpInflight.release(ipKey);
      const ua = req.headers['user-agent'];
      const referer = req.headers.referer;
      metrics.record(host || '(none)', status, performance.now() - started, blocked, { ip, method: req.method ?? '', path, userAgent: typeof ua === 'string' ? ua : undefined, referer: typeof referer === 'string' ? referer : undefined, allowed }, bannedNow);
    }
  }

  return { handle, shield, metrics };
}
