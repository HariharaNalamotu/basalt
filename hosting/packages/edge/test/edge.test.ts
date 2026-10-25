import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PROTECTION, EMPTY_CSP, signToken, silentLog, type AppRoute, type RouteTable } from '@basalt/host-shared';
import { verifyEdgeSignature } from '../../../../api/packages/framework/src/edge.js';
import { createEdgeHandler } from '../src/server.js';
import { RouteTableClient } from '../src/table.js';

const EDGE_KEY = 'edge-key-for-tests-0123456789';
const ACCESS_KEY = 'access-key-for-tests-0123456789';
const BACKEND_SECRET = 'backend-edge-secret-0123456789abcdef';

let staticDir: string;
let backend: http.Server;
let backendUrl: string;
let lastBackend: { headers: http.IncomingHttpHeaders; url: string; method: string; body: string } | undefined;
let auth: http.Server;
let authUrl: string;
let lastAuth: { url: string; headers: http.IncomingHttpHeaders } | undefined;
let data: http.Server;
let dataUrl: string;
let lastData: { url: string; method: string; headers: http.IncomingHttpHeaders; bytes: number } | undefined;
let edgeServer: http.Server;
let edgeUrl: string;
let table: RouteTableClient;
let wakes: string[] = [];
let edge: ReturnType<typeof createEdgeHandler>;

const route = (over: Partial<AppRoute> = {}): AppRoute => ({
  kind: 'app',
  host: 'todo.example.com',
  app: 'todo',
  envId: 'env_prod',
  env: 'production',
  projectId: 'prj_test123',
  edgeSecret: BACKEND_SECRET,
  staticDir,
  backend: backendUrl,
  sleeping: false,
  accessKey: null,
  protection: { ...DEFAULT_PROTECTION },
  csp: { ...EMPTY_CSP, connectSrc: ['https://api.stripe.com'] },
  dataUrl: `${dataUrl}/p/abcde12345`,
  ...over,
});

function setRoutes(routes: AppRoute[], underAttack = false) {
  table.set({ version: Date.now(), generatedAt: new Date().toISOString(), underAttack, routes } satisfies RouteTable);
}

/** node:http (fetch can't set Host). Returns a fetch-like Response. */
async function call(p: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string; ip?: string } = {}, base = edgeUrl): Promise<Response> {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: init.method ?? 'GET', path: p, headers: { ...(init.headers ?? {}), host: init.host ?? 'todo.example.com', 'cf-connecting-ip': init.ip ?? '203.0.113.7' } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const headers = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
            else if (v !== undefined) headers.set(k, v);
          }
          const body = Buffer.concat(chunks);
          const encoding = res.headers['content-encoding'];
          const decoded = encoding === 'br' ? brotliDecompressSync(body) : encoding === 'gzip' ? gunzipSync(body) : body;
          resolve(new Response([204, 304].includes(res.statusCode!) ? null : decoded, { status: res.statusCode, headers }));
        });
      },
    );
    req.on('error', reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

beforeAll(async () => {
  staticDir = await mkdtemp(path.join(tmpdir(), 'edge-static-'));
  await mkdir(path.join(staticDir, 'assets'), { recursive: true });
  const indexHtml = '<!doctype html><html><body><div id="app"></div><script src="/assets/app-AbCdEf12.js"></script></body></html>';
  await writeFile(path.join(staticDir, 'index.html'), indexHtml);
  await writeFile(path.join(staticDir, 'assets/app-AbCdEf12.js'), 'console.log("app")'.repeat(50));
  await writeFile(path.join(staticDir, 'assets/app-AbCdEf12.js.br'), brotliCompressSync(Buffer.from('console.log("app")'.repeat(50))));
  await writeFile(path.join(staticDir, 'assets/app-AbCdEf12.js.gz'), gzipSync(Buffer.from('console.log("app")'.repeat(50))));
  await writeFile(path.join(staticDir, 'assets/app-AbCdEf12.js.map'), '{"sources":["secret.ts"]}');
  await writeFile(path.join(staticDir, '.env'), 'SECRET=1');
  await writeFile(path.join(staticDir, 'robots.txt'), 'User-agent: *');

  backend = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      lastBackend = { headers: req.headers, url: req.url ?? '', method: req.method ?? '', body };
      if (req.url?.startsWith('/api/slow')) await new Promise((r) => setTimeout(r, 300));
      res.writeHead(200, { 'content-type': 'application/json', 'x-powered-by': 'leaky', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => backend.listen(0, '127.0.0.1', r));
  backendUrl = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;

  auth = http.createServer((req, res) => {
    lastAuth = { url: req.url ?? '', headers: req.headers };
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"auth":true}');
  });
  await new Promise<void>((r) => auth.listen(0, '127.0.0.1', r));
  authUrl = `http://127.0.0.1:${(auth.address() as AddressInfo).port}`;

  data = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', (d) => (bytes += d.length));
    req.on('end', () => {
      lastData = { url: req.url ?? '', method: req.method ?? '', headers: req.headers, bytes };
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sneaky=1; Path=/', 'content-security-policy': "default-src 'none'; sandbox" });
      res.end('{"ok":true,"data":{"rows":[]}}');
    });
  });
  await new Promise<void>((r) => data.listen(0, '127.0.0.1', r));
  dataUrl = `http://127.0.0.1:${(data.address() as AddressInfo).port}`;

  table = new RouteTableClient('http://unused.invalid', 'x', silentLog);
  edge = createEdgeHandler({
    table,
    edgeKey: EDGE_KEY,
    authUrl,
    trustedProxies: new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']),
    log: silentLog,
    wake: async (envId) => {
      wakes.push(envId);
      setTimeout(() => setRoutes([route({ envId, sleeping: false })]), 50);
    },
  });
  edgeServer = http.createServer((q, s) => void edge.handle(q, s));
  await new Promise<void>((r) => edgeServer.listen(0, '127.0.0.1', r));
  edgeUrl = `http://127.0.0.1:${(edgeServer.address() as AddressInfo).port}`;
});

afterAll(() => {
  backend.close();
  auth.close();
  data.close();
  edgeServer.close();
});

let ipCounter = 0;
beforeEach(() => {
  setRoutes([route()]);
  wakes = [];
  ipCounter++;
});
const freshIp = () => `198.51.100.${ipCounter % 250}`;

describe('static frontend', () => {
  it('serves index.html with strict security headers and CSP', async () => {
    const r = await call('/', { ip: freshIp() });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/text\/html/);
    const csp = r.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain('connect-src \'self\' https://api.stripe.com');
    // Inline <style> blocks are refused (injected CSS can read the page); style="" attributes still work.
    expect(csp).toMatch(/style-src 'self'(;| )/);
    expect(csp).not.toMatch(/style-src [^;]*'unsafe-inline'/);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(r.headers.get('strict-transport-security')).toMatch(/max-age/);
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('cache-control')).toBe('no-cache');
  });

  it('falls back to index.html for client-side routes but 404s missing assets', async () => {
    expect((await call('/todos/123', { ip: freshIp(), headers: { accept: 'text/html' } })).status).toBe(200);
    expect((await call('/assets/missing.js', { ip: freshIp() })).status).toBe(404);
  });

  it('serves precompressed, immutable hashed assets and honors ETags', async () => {
    const r = await call('/assets/app-AbCdEf12.js', { ip: freshIp(), headers: { 'accept-encoding': 'br, gzip' } });
    expect(r.headers.get('content-encoding')).toBe('br');
    expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await r.text()).toContain('console.log');
    const again = await call('/assets/app-AbCdEf12.js', { ip: freshIp(), headers: { 'if-none-match': r.headers.get('etag')! } });
    expect(again.status).toBe(304);
  });

  it('never serves dotfiles or production source maps, and rejects traversal', async () => {
    expect((await call('/.env', { ip: freshIp() })).status).toBe(404);
    expect((await call('/assets/app-AbCdEf12.js.map', { ip: freshIp() })).status).toBe(404);
    for (const p of ['/..%2f..%2fetc/passwd', '/assets/%2e%2e/%2e%2e/x', '/a%00b', '/a\\b']) {
      expect([400, 404], p).toContain((await call(p, { ip: freshIp() })).status);
    }
  });

  it('refuses writes to static files', async () => {
    const r = await call('/index.html', { method: 'DELETE', ip: freshIp() });
    expect(r.status).toBe(405);
  });
});

describe('proxying', () => {
  it('signs backend requests verifiably, sets the real client IP and strips spoofed headers', async () => {
    const r = await call('/api/todos?x=1', {
      ip: '203.0.113.99',
      headers: {
        'x-forwarded-for': '6.6.6.6',
        'basalt-edge-signature': 't=1,v1=' + 'f'.repeat(64),
        cookie: 'session=abc; basalt_access=zzz; basalt_clearance=yyy',
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-powered-by')).toBeNull();
    expect(r.headers.getSetCookie()).toHaveLength(2);
    const h = lastBackend!.headers;
    expect(h['x-forwarded-for']).toBe('203.0.113.99');
    expect(h.cookie).toBe('session=abc');
    expect(verifyEdgeSignature(BACKEND_SECRET, h['basalt-edge-signature'] as string, { method: 'GET', pathAndQuery: '/api/todos?x=1', requestId: h['x-request-id'] as string })).toBe(true);
  });

  it('only trusts CF-Connecting-IP from configured proxies', async () => {
    const other = createEdgeHandler({ table, edgeKey: EDGE_KEY, authUrl, trustedProxies: new Set(), log: silentLog, wake: async () => {} });
    const s = http.createServer((q, res) => void other.handle(q, res));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    await call('/api/x', { ip: '1.2.3.4' }, `http://127.0.0.1:${(s.address() as AddressInfo).port}`);
    expect(lastBackend!.headers['x-forwarded-for']).not.toBe('1.2.3.4');
    s.close();
  });

  it('maps /_basalt/auth to the project on the auth service with the forwarded prefix', async () => {
    const r = await call('/_basalt/auth/session/refresh', { method: 'POST', ip: freshIp(), headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
    expect(lastAuth!.url).toBe('/v1/projects/prj_test123/session/refresh');
    expect(lastAuth!.headers['x-forwarded-prefix']).toBe('/_basalt/auth');
  });

  it("an encoded ? or # in the path stays part of the path, so it can't add a query the edge never saw", async () => {
    const r = await call('/_basalt/auth/signin%3Fredirect=evil%23x', { method: 'POST', ip: freshIp(), headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
    expect(lastAuth!.url).toBe('/v1/projects/prj_test123/signin%3Fredirect=evil%23x');
  });

  it('keeps backend internals private', async () => {
    for (const p of ['/_basalt/introspect', '/_basalt/openapi.json', '/_basalt/ready']) {
      expect((await call(p, { ip: freshIp() })).status, p).toBe(404);
    }
  });

  it('enforces the body limit', async () => {
    setRoutes([route({ protection: { ...DEFAULT_PROTECTION, maxBodyBytes: 100 } })]);
    const r = await call('/api/upload', { method: 'POST', ip: freshIp(), body: 'x'.repeat(1000), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(413);
  });

  it('caps concurrent requests per app (bulkhead)', async () => {
    setRoutes([route({ protection: { ...DEFAULT_PROTECTION, maxConcurrency: 1 } })]);
    const [a, b] = await Promise.all([call('/api/slow', { ip: freshIp() }), call('/api/slow', { ip: freshIp() })]);
    expect([a.status, b.status].sort()).toEqual([200, 503]);
  });

  it('wakes sleeping environments on demand', async () => {
    setRoutes([route({ sleeping: true, envId: 'env_sleepy' })]);
    const r = await call('/api/todos', { ip: freshIp() });
    expect(r.status).toBe(200);
    expect(wakes).toEqual(['env_sleepy']);
  });

  it('returns 404 for unknown hosts', async () => {
    expect((await call('/', { host: 'nope.example.com', ip: freshIp() })).status).toBe(404);
  });
});

describe('private (non-production) environments', () => {
  const staging = () => route({ host: 'todo--staging.example.com', env: 'staging', envId: 'env_staging', accessKey: ACCESS_KEY });

  it('require a signed access token, exchanged for a cookie via share link', async () => {
    setRoutes([staging()]);
    const host = 'todo--staging.example.com';
    const blocked = await call('/', { host, ip: freshIp(), headers: { accept: 'text/html' } });
    expect(blocked.status).toBe(401);
    expect(blocked.headers.get('x-robots-tag')).toMatch(/noindex/);
    const token = signToken(ACCESS_KEY, { env: 'env_staging', exp: Math.floor(Date.now() / 1000) + 600 });
    const link = await call(`/_basalt/access?t=${token}`, { host, ip: freshIp() });
    expect(link.status).toBe(303);
    const setCookie = link.headers.get('set-cookie')!;
    expect(setCookie).toMatch(/HttpOnly/);
    const ok = await call('/', { host, ip: freshIp(), headers: { cookie: setCookie.split(';')[0]! } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    // Header form (test runners) works too; another environment's token does not.
    expect((await call('/api/x', { host, ip: freshIp(), headers: { 'x-basalt-access': token } })).status).toBe(200);
    const other = signToken(ACCESS_KEY, { env: 'env_other', exp: Math.floor(Date.now() / 1000) + 600 });
    expect((await call('/api/x', { host, ip: freshIp(), headers: { 'x-basalt-access': other } })).status).toBe(401);
    const expired = signToken(ACCESS_KEY, { env: 'env_staging', exp: Math.floor(Date.now() / 1000) - 1 });
    expect((await call(`/_basalt/access?t=${expired}`, { host, ip: freshIp() })).status).toBe(403);
  });

  it("the edge's own pages (not found, private, expired link) get a lock-everything CSP", async () => {
    setRoutes([route(), staging()]);
    const host = 'todo--staging.example.com';
    const expired = signToken(ACCESS_KEY, { env: 'env_staging', exp: Math.floor(Date.now() / 1000) - 1 });
    const pages = [
      await call('/missing-page.html', { ip: freshIp(), headers: { accept: 'text/html' } }),
      await call('/', { host, ip: freshIp(), headers: { accept: 'text/html' } }),
      await call(`/_basalt/access?t=${expired}`, { host, ip: freshIp() }),
    ];
    expect(pages.map((p) => p.status)).toEqual([404, 401, 403]);
    for (const p of pages) {
      expect(p.headers.get('content-type')).toMatch(/text\/html/);
      expect(p.headers.get('content-security-policy')).toMatch(/^default-src 'none';.*frame-ancestors 'none'/);
    }
    // JSON errors stay JSON, without a page policy.
    const json = await call('/api/x', { host, ip: freshIp() });
    expect(json.headers.get('content-type')).toMatch(/application\/json/);
    expect(json.headers.get('content-security-policy')).toBeNull();
  });
});

describe('abuse protection', () => {
  it('rate limits per IP per app with Retry-After', async () => {
    setRoutes([route({ protection: { ...DEFAULT_PROTECTION, perIpPerMinute: 60 } })]);
    const ip = '192.0.2.200';
    const statuses: number[] = [];
    for (let i = 0; i < 15; i++) statuses.push((await call('/robots.txt', { ip })).status);
    expect(statuses.filter((s) => s === 200).length).toBe(10); // burst
    expect(statuses.at(-1)).toBe(429);
  });

  it('bans clients probing for exploits, and blocks attack signatures', async () => {
    const ip = '192.0.2.201';
    expect((await call('/api/x?q=1%20UNION%20SELECT%20password%20FROM%20users', { ip })).status).toBe(403);
    expect((await call('/wp-login.php', { ip })).status).toBe(404);
    for (const p of ['/.git/config', '/phpmyadmin/', '/.env', '/wp-admin/']) await call(p, { ip });
    const r = await call('/', { ip });
    expect(r.status).toBe(403);
    expect(((await r.json()) as any).error.code).toBe('blocked');
    expect(edge.shield.bans().some((b) => b.ip === ip)).toBe(true);
    // Others are unaffected.
    expect((await call('/', { ip: freshIp() })).status).toBe(200);
  });

  it('rejects unusual methods', async () => {
    expect((await call('/', { method: 'TRACE', ip: freshIp() })).status).toBe(405);
  });

  it('under-attack mode: challenge for browsers, 403 for scripts, clearance after proof-of-work', async () => {
    setRoutes([route({ protection: { ...DEFAULT_PROTECTION, underAttack: true } })]);
    const ip = '192.0.2.150';
    const page = await call('/', { ip, headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Checking your browser');
    expect((await call('/api/todos', { ip })).status).toBe(403);
    const challenge = JSON.parse(/const challenge = ("[^"]+")/.exec(html)![1]!);
    let nonce = 0;
    while (!createHash('sha256').update(challenge + nonce.toString(36)).digest('hex').startsWith('0000')) nonce++;
    const solved = await call('/_basalt/challenge', { method: 'POST', ip, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challenge, nonce: nonce.toString(36) }) });
    expect(solved.status).toBe(204);
    const clearance = solved.headers.get('set-cookie')!.split(';')[0]!;
    expect((await call('/api/todos', { ip, headers: { cookie: clearance } })).status).toBe(200);
    // Clearance is bound to the client IP.
    expect((await call('/api/todos', { ip: '192.0.2.151', headers: { cookie: clearance } })).status).toBe(403);
  });
});

describe('metrics', () => {
  it('records per-host status classes and blocked reasons', async () => {
    await call('/', { ip: freshIp() });
    const snap = edge.metrics.snapshot() as any;
    expect(snap.hosts['todo.example.com'].requests).toBeGreaterThan(0);
    expect(snap.hosts['todo.example.com'].blocked).toBeTruthy();
  });
});

describe('/_basalt/data: the Data block on the app\'s own site', () => {
  const post = (p: string, body = '{}', headers: Record<string, string> = {}) =>
    call(p, { method: 'POST', ip: freshIp(), body, headers: { 'content-type': 'application/json', ...headers } });

  it("forwards data calls to the environment's Data project with the session cookie, never the edge's own cookies", async () => {
    lastData = undefined;
    const r = await post('/_basalt/data/v1/data/list', '{"table":"bookings"}', { cookie: '__Host-basalt_at=tok; basalt_access=edge-only', origin: 'https://todo.example.com' });
    expect(r.status).toBe(200);
    expect(lastData!.url).toBe('/p/abcde12345/v1/data/list');
    expect(lastData!.headers.cookie).toBe('__Host-basalt_at=tok');
    expect(lastData!.headers['x-forwarded-host']).toBe('todo.example.com');
    expect(lastData!.headers.origin).toBe('https://todo.example.com');
  });

  it('passes uploads, file links and downloads, and keeps the download safety headers', async () => {
    expect((await post('/_basalt/data/v1/files', 'x'.repeat(1000), { 'content-type': 'text/plain', 'x-file-name': 'a.txt' })).status).toBe(200);
    expect(lastData!.url).toBe('/p/abcde12345/v1/files');
    expect((await post('/_basalt/data/v1/files/link', '{"id":"x"}')).status).toBe(200);
    const dl = await call(`/_basalt/data/v1/files/download/${'a'.repeat(64)}`, { ip: freshIp() });
    expect(dl.status).toBe(200);
    expect(lastData!.method).toBe('GET');
    expect(dl.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(dl.headers.get('set-cookie')).toBeNull();
  });

  it('only lets the Data API through, nothing else on the Data service', async () => {
    lastData = undefined;
    for (const [method, p] of [
      ['GET', '/_basalt/data/v1/data/list'],
      ['POST', '/_basalt/data/v1/data/drop'],
      ['POST', '/_basalt/data/healthz'],
      ['GET', '/_basalt/data/v1/files/download/../../api/projects/me'],
      ['POST', '/_basalt/data/v1/data/list/../../../api/projects'],
      ['GET', '/_basalt/data/v1/files/download/short'],
      ['POST', '/_basalt/data'],
    ] as const) {
      const r = await call(p, { method, ip: freshIp(), body: method === 'POST' ? '{}' : undefined, headers: { 'content-type': 'application/json' } });
      expect([400, 404], `${method} ${p}`).toContain(r.status);
    }
    expect(lastData).toBeUndefined();
  });

  it('caps data calls at 256 KB and uploads at 6 MB', async () => {
    // The edge answers 413 and closes the connection, so a client still sending may only see the
    // connection cut. Either way the request must never reach the Data service.
    const tooBig = async (p: string, size: number, headers: Record<string, string> = {}) => {
      lastData = undefined;
      const status = await post(p, 'x'.repeat(size), headers).then((r) => r.status, (err: NodeJS.ErrnoException) => {
        if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return 'closed';
        throw err;
      });
      expect([413, 'closed']).toContain(status);
      expect(lastData).toBeUndefined();
    };
    await tooBig('/_basalt/data/v1/data/create', 300 * 1024);
    expect((await post('/_basalt/data/v1/files', 'x'.repeat(5 * 1024 * 1024), { 'content-type': 'text/plain' })).status).toBe(200);
    await tooBig('/_basalt/data/v1/files', 7 * 1024 * 1024, { 'content-type': 'text/plain' });
  });

  it('is not found for environments without a Data project', async () => {
    setRoutes([route({ dataUrl: null })]);
    expect((await post('/_basalt/data/v1/data/list')).status).toBe(404);
  });
});

describe('the public origin backends and services see', () => {
  it('platform services get the public host as Host (registry tarball links), and the local demo origin', async () => {
    const t = new RouteTableClient('http://unused.invalid', 'x', silentLog);
    const local = createEdgeHandler({ table: t, edgeKey: EDGE_KEY, authUrl, trustedProxies: new Set(), log: silentLog, wake: async () => {}, publicOrigin: { scheme: 'http', port: 8080 } });
    const server = http.createServer((q, s) => void local.handle(q, s));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const routes = [{ kind: 'service', host: 'registry.example.com', upstream: dataUrl, methods: ['GET'], perIpPerMinute: 100 }, route()];
      t.set({ version: 1, generatedAt: new Date().toISOString(), underAttack: false, routes } as unknown as RouteTable);
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      lastData = undefined;
      expect((await call('/ignore', { host: 'registry.example.com:8080' }, base)).status).toBe(200);
      expect(lastData!.headers.host).toBe('registry.example.com:8080');
      expect(lastData!.headers['x-forwarded-proto']).toBe('http');
      // The Data service compares the browser's Origin (http://todo.example.com:8080) with this.
      await call('/_basalt/data/v1/data/list', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }, base);
      expect(lastData!.headers['x-forwarded-host']).toBe('todo.example.com:8080');
    } finally {
      server.close();
    }
  });

  it('behind Cloudflare (the default) it is https on the default port', async () => {
    setRoutes([{ kind: 'service', host: 'registry.example.com', upstream: dataUrl, methods: ['GET'], perIpPerMinute: 100 } as unknown as AppRoute]);
    lastData = undefined;
    await call('/ignore', { host: 'registry.example.com' });
    expect(lastData!.headers.host).toBe('registry.example.com');
    expect(lastData!.headers['x-forwarded-proto']).toBe('https');
  });
});

describe('owner allowlist and dashboard analytics', () => {
  it('an allowlisted client is refused attack by attack, but never banned or rate limited on that app', async () => {
    const ip = '192.0.2.77';
    setRoutes([route({ allowIps: [ip], protection: { ...DEFAULT_PROTECTION, perIpPerMinute: 10 } }), route({ host: 'other.example.com', envId: 'env_other' })]);
    // Each attack is still refused by the WAF, so the protection stays visible...
    expect((await call('/api/x?q=1%20UNION%20SELECT%20password%20FROM%20users', { ip })).status).toBe(403);
    for (const p of ['/.git/config', '/phpmyadmin/', '/.env', '/wp-admin/', '/wp-login.php']) expect((await call(p, { ip })).status).toBe(404);
    // ...but it never adds up to a ban, and the per-app rate limit doesn't apply.
    for (let i = 0; i < 25; i++) expect((await call('/', { ip })).status).toBe(200);
    expect(edge.shield.bans().some((b) => b.ip === ip)).toBe(false);
    const events = edge.metrics.securityEvents(new Set(['todo.example.com'])).filter((e) => e.ip === ip);
    expect(events.length).toBe(6);
    expect(events.every((e) => e.allowed && !e.banned)).toBe(true);
  });

  it('the allowlist only covers the owner\'s own apps', async () => {
    const ip = '192.0.2.78';
    setRoutes([route({ allowIps: [ip] }), route({ host: 'other.example.com', envId: 'env_other' })]);
    for (const p of ['/.git/config', '/phpmyadmin/', '/.env', '/wp-admin/', '/wp-login.php', '/.aws/x', '/.ssh/id']) await call(p, { ip, host: 'other.example.com' });
    expect((await call('/', { ip, host: 'other.example.com' })).status).toBe(403);
    const ban = edge.shield.bans().find((b) => b.ip === ip)!;
    expect(ban.host).toBe('other.example.com');
    expect(ban.reason).toBe('scanner_path');
    expect(edge.metrics.securityEvents(new Set(['other.example.com'])).some((e) => e.ip === ip && e.banned)).toBe(true);
    // Still let through on the app that allowlisted it.
    expect((await call('/', { ip })).status).toBe(200);
  });

  it('keeps per-minute history, visitors, pages, devices and a visit log, without query strings', async () => {
    setRoutes([route({ host: 'stats.example.com', envId: 'env_stats' })]);
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
    await call('/todos/123?token=secret', { host: 'stats.example.com', ip: '198.18.0.1', headers: { accept: 'text/html', 'user-agent': iphone, referer: 'https://news.example.org/post' } });
    await call('/', { host: 'stats.example.com', ip: '198.18.0.2', headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36' } });
    await call('/api/todos/42', { host: 'stats.example.com', ip: '198.18.0.2' });
    const d = edge.metrics.detail('stats.example.com')!;
    expect(d.totals.requests).toBe(3);
    expect(d.series.at(-1)![1]).toBe(3);
    expect(d.visitors.last24h).toBe(2);
    expect(d.pages.map((p) => p.key).sort()).toEqual(['/', '/todos/123']);
    expect(d.api[0]!.key).toBe('GET /api/todos/:id');
    expect(d.devices.phone).toBe(1);
    expect(d.devices.computer).toBe(1);
    expect(d.referrers[0]!.key).toBe('news.example.org');
    expect(d.access.map((a) => a.path)).toContain('/todos/123');
    expect(JSON.stringify(d)).not.toContain('secret');
  });
});
