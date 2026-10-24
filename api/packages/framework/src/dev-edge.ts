import { randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { EDGE_HEADER, signEdgeRequest } from './edge.js';

/**
 * Local stand-in for the Basalt platform edge, implementing the same contract so an app behaves
 * identically in development and production:
 *
 *   https://<app>/_basalt/auth/*  ->  <auth service>/v1/projects/<projectId>/*   (X-Forwarded-Prefix)
 *   https://<app>/api/*           ->  <backend>/api/*                             (HMAC-signed)
 *   everything else               ->  <frontend dev server>
 *
 * One origin for the browser means first-party HttpOnly cookies and no CORS.
 */
export interface DevEdgeOptions {
  port?: number;
  edgeSecret: string;
  authUrl: string;
  projectId: string;
  backendUrl: string;
  frontendUrl?: string;
  apiBasePath?: string;
}

// Headers a client must never be able to set: they carry the edge's authority.
const TRUST_HEADERS = ['basalt-edge-signature', 'x-request-id', 'x-forwarded-for', 'x-forwarded-prefix', 'x-forwarded-host', 'x-forwarded-proto'];
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-connection', 'te', 'trailer'];

export function createDevEdge(opts: DevEdgeOptions) {
  const apiBase = opts.apiBasePath ?? '/api';
  const app = new Hono();

  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const requestId = randomUUID();
    let clientIp = '127.0.0.1';
    try {
      clientIp = getConnInfo(c).remote.address ?? clientIp;
    } catch {
      /* not running under node-server (tests) */
    }
    const headers = new Headers(c.req.raw.headers);
    for (const h of [...TRUST_HEADERS, ...HOP_BY_HOP, 'host']) headers.delete(h);
    headers.set('x-request-id', requestId);
    headers.set('x-forwarded-for', clientIp);
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

    let target: string;
    if (url.pathname === '/_basalt/auth' || url.pathname.startsWith('/_basalt/auth/')) {
      target = `${opts.authUrl.replace(/\/+$/, '')}/v1/projects/${opts.projectId}${url.pathname.slice('/_basalt/auth'.length)}${url.search}`;
      headers.set('x-forwarded-prefix', '/_basalt/auth');
    } else if (url.pathname === apiBase || url.pathname.startsWith(`${apiBase}/`) || url.pathname.startsWith('/_basalt/')) {
      target = `${opts.backendUrl.replace(/\/+$/, '')}${url.pathname}${url.search}`;
      headers.set(EDGE_HEADER, signEdgeRequest(opts.edgeSecret, { method: c.req.method, pathAndQuery: url.pathname + url.search, requestId }));
    } else if (opts.frontendUrl) {
      target = `${opts.frontendUrl.replace(/\/+$/, '')}${url.pathname}${url.search}`;
    } else {
      return c.text('Not found (no frontend configured for the dev edge).', 404);
    }

    const hasBody = !['GET', 'HEAD'].includes(c.req.method);
    let upstream: Response;
    try {
      upstream = await fetch(target, {
        method: c.req.method,
        headers,
        body: hasBody ? c.req.raw.body : undefined,
        redirect: 'manual',
        // @ts-expect-error Node fetch requires duplex for streamed request bodies.
        duplex: hasBody ? 'half' : undefined,
      });
    } catch {
      return c.json({ error: { code: 'bad_gateway', message: 'Upstream unavailable.', requestId } }, 502);
    }
    const out = new Headers(upstream.headers);
    for (const h of HOP_BY_HOP) out.delete(h);
    out.delete('content-encoding'); // fetch already decompressed the body
    out.delete('content-length');
    return new Response(upstream.body, { status: upstream.status, headers: out });
  });
  return app;
}

export function serveDevEdge(opts: DevEdgeOptions) {
  const app = createDevEdge(opts);
  return serve({ fetch: app.fetch, port: opts.port ?? 8080, hostname: '127.0.0.1' });
}
