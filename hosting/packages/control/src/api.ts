import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { TokenBuckets, safeEqual } from '@basalt/host-shared';
import type { Ctx } from './ctx.js';
import { createMcpServer } from './mcp.js';
import { CapacityError } from './environments.js';
import { MAX_UPLOAD_BYTES } from './sources.js';
import { UserError, type Host } from './service.js';

type Env = { Variables: { ws: string } };

/** Public API (reached through the edge at host.<root>): workspace-token authenticated. */
export function createPublicApi(ctx: Ctx, host: Host) {
  const app = new Hono<Env>();
  const limits = new TokenBuckets();

  app.onError((err, c) => {
    const status = err instanceof UserError ? err.status : err instanceof CapacityError ? 503 : 500;
    if (status >= 500 && !(err instanceof CapacityError)) ctx.log.error('api_error', { err });
    return c.json({ error: status === 500 ? 'Internal error.' : err.message }, status as 400);
  });
  app.get('/v1/health', (c) => c.json({ ok: true }));

  const auth: MiddlewareHandler<Env> = async (c, next) => {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const ws = await host.authenticate(token);
    if (!ws) return c.json({ error: 'Invalid or missing workspace token.' }, 401);
    const r = limits.take(ws, 1200);
    if (!r.ok) return c.json({ error: 'Too many requests.' }, 429, { 'retry-after': String(r.retryAfter) });
    c.set('ws', ws);
    await next();
  };
  app.use('/v1/apps/*', auth);
  app.use('/mcp', auth);

  app.post('/v1/apps/:app/sources', bodyLimit({ maxSize: MAX_UPLOAD_BYTES, onError: (c) => c.json({ error: 'Upload too large (max 50 MB).' }, 413) }), async (c) => {
    const body = Buffer.from(await c.req.arrayBuffer());
    const r = await host.uploadSource(c.get('ws'), c.req.param('app'), body);
    return c.json({ sourceId: r.sha, size: r.size }, 201);
  });

  // Stateless MCP over Streamable HTTP: one server per request, bound to the caller's workspace.
  app.all('/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = createMcpServer(ctx, host, c.get('ws'));
    await server.connect(transport);
    const res = await transport.handleRequest(c.req.raw);
    return res;
  });
  return app;
}

/** Internal API on a separate port (platform network only): edge route table, wake, mail. */
export function createInternalApi(ctx: Ctx, host: Host) {
  const app = new Hono();
  app.use('/internal/*', async (c, next) => {
    const presented = c.req.header('authorization') ?? '';
    const isMail = c.req.path === '/internal/mail';
    if (!isMail && !safeEqual(presented, `Bearer ${ctx.cfg.INTERNAL_TOKEN}`)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  });
  app.onError((err, c) => {
    const status = err instanceof UserError ? err.status : 500;
    if (status >= 500) ctx.log.error('internal_api_error', { err });
    return c.json({ error: err.message }, status as 400);
  });
  app.get('/internal/routes', async (c) => {
    if (c.req.header('if-none-match') === String(ctx.routes.version)) return c.body(null, 304);
    return c.json(await host.routeTable());
  });
  app.post('/internal/wake', async (c) => {
    const { envId } = (await c.req.json()) as { envId: string };
    if (typeof envId !== 'string' || !/^env_[a-z0-9]+$/.test(envId)) return c.json({ error: 'bad env' }, 400);
    void host.wake(envId).catch((err) => ctx.log.warn('wake_failed', { envId, err: (err as Error).message }));
    return c.json({ ok: true }, 202);
  });
  app.post('/internal/mail', async (c) => {
    const raw = await c.req.text();
    await host.handleMail(raw, c.req.header('basalt-signature'));
    return c.json({ ok: true });
  });
  app.get('/healthz', (c) => c.json({ ok: true }));
  return app;
}
