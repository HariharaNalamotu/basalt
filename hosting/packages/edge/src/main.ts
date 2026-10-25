#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createLog, safeEqual } from '@basalt/host-shared';
import { createEdgeHandler } from './server.js';
import { RouteTableClient } from './table.js';

const log = createLog('edge');
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const controlUrl = need('CONTROL_URL').replace(/\/+$/, '');
const internalToken = need('INTERNAL_TOKEN');

const table = new RouteTableClient(`${controlUrl}/internal/routes`, internalToken, log);
table.start();

const edge = createEdgeHandler({
  table,
  edgeKey: need('EDGE_KEY'),
  authUrl: need('AUTH_INTERNAL_URL').replace(/\/+$/, ''),
  trustedProxies: new Set((process.env.TRUSTED_PROXIES ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  publicOrigin: { scheme: process.env.PUBLIC_SCHEME === 'http' ? 'http' : 'https', port: Number(process.env.PUBLIC_PORT) || undefined },
  log,
  wake: async (envId) => {
    await fetch(`${controlUrl}/internal/wake`, {
      method: 'POST',
      headers: { authorization: `Bearer ${internalToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ envId }),
      signal: AbortSignal.timeout(5000),
    });
  },
});

function harden(server: http.Server) {
  server.headersTimeout = 10_000; // slowloris
  server.requestTimeout = 120_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  server.maxConnections = 20_000;
  return server;
}

// Public listener: only cloudflared (or a local reverse proxy) connects here.
const pub = harden(http.createServer({ maxHeaderSize: 16 * 1024 }, (q, s) => void edge.handle(q, s)));
pub.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => log.info('listening', { port: Number(process.env.PORT ?? 8080), listener: 'public' }));

// Internal TLS listener: browser worker and test runners reach app environments here with
// production cookie semantics (Secure cookies need https).
const certDir = process.env.TLS_DIR ?? '/data/edge-tls';
if (!existsSync(`${certDir}/cert.pem`)) {
  mkdirSync(certDir, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3650', '-subj', '/CN=basalt-internal-edge', '-keyout', `${certDir}/key.pem`, '-out', `${certDir}/cert.pem`], { stdio: 'ignore' });
}
const internal = harden(https.createServer({ key: readFileSync(`${certDir}/key.pem`), cert: readFileSync(`${certDir}/cert.pem`), maxHeaderSize: 16 * 1024 }, (q, s) => void edge.handle(q, s)) as unknown as http.Server);
internal.listen(Number(process.env.INTERNAL_TLS_PORT ?? 8443), '0.0.0.0', () => log.info('listening', { port: Number(process.env.INTERNAL_TLS_PORT ?? 8443), listener: 'internal-tls' }));

// Admin listener (platform network only): metrics, bans, reload.
const admin = http.createServer(async (req, res) => {
  const auth = req.headers.authorization ?? '';
  if (!safeEqual(auth, `Bearer ${internalToken}`)) {
    res.writeHead(401).end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://admin');
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/metrics') return res.end(JSON.stringify(edge.metrics.snapshot()));
  if (url.pathname === '/bans' && req.method === 'GET') return res.end(JSON.stringify({ bans: edge.shield.bans() }));
  // The owner's dashboard: one site's traffic, and the security feed for a set of sites.
  if (url.pathname === '/detail' && req.method === 'GET') return res.end(JSON.stringify({ detail: edge.metrics.detail(url.searchParams.get('host') ?? '') }));
  if (url.pathname === '/security' && req.method === 'GET') {
    const hosts = new Set((url.searchParams.get('hosts') ?? '').split(',').filter(Boolean));
    return res.end(JSON.stringify({ events: edge.metrics.securityEvents(hosts), bans: edge.shield.bans() }));
  }
  if (url.pathname === '/bans' && req.method === 'DELETE') {
    edge.shield.unban(url.searchParams.get('ip') ?? '');
    return res.end('{"ok":true}');
  }
  if (url.pathname === '/reload' && req.method === 'POST') {
    await table.refresh();
    return res.end(JSON.stringify({ version: table.current.version }));
  }
  res.writeHead(404).end('{}');
});
admin.listen(Number(process.env.ADMIN_PORT ?? 9090), '0.0.0.0');

for (const s of ['SIGTERM', 'SIGINT']) {
  process.once(s, () => {
    table.stop();
    pub.close();
    internal.close();
    admin.close();
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
