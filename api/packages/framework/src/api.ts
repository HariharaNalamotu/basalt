import { createHash, randomUUID } from 'node:crypto';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Redis } from 'ioredis';
import pg from 'pg';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  BasaltAuthError,
  createAuthServer,
  type AuthServer,
  type AuthServerOptions,
  type AuthUser,
  type DbTransaction,
  type PgPoolLike,
} from '@basalt/auth/server';
import { EDGE_HEADER, verifyEdgeSignature } from './edge.js';
import { ApiError, errors, fromDatabaseError, type ValidationIssue } from './errors.js';
import { MemoryIdempotencyStore, RedisIdempotencyStore, type IdempotencyStore } from './idempotency.js';
import { createLogger, type Logger, type LogLevel } from './logger.js';
import { buildOpenApi } from './openapi.js';
import { parseServiceConfig, tightenAuth, type ApiServiceConfig } from './config.js';
import { ipRateLimitKey, MemoryRateLimiter, RedisRateLimiter, type RateLimiter, type RateLimitRule } from './ratelimit.js';
import { createSafeFetch, type SafeFetch } from './safe-fetch.js';
import { SqlQuery, type QueryResult } from './sql.js';
import { createDataClient, type DataClient } from './data.js';

// ------------------------------------------------------------------------------------ public types

/**
 * Who may call a route.
 * - omitted / 'required': a signed-in user (401 otherwise). THE DEFAULT.
 * - { mfa, emailVerified, maxAgeSeconds, strict }: signed in, plus extra requirements (403 otherwise).
 * - 'optional': user if signed in, else null.
 * - 'public': anyone; the user is never read. Database queries run without a grant, so tables
 *   protected by basalt_auth.protect() return nothing.
 */
export type AuthSpec =
  | 'required'
  | 'optional'
  | 'public'
  | { mfa?: boolean; emailVerified?: boolean; maxAgeSeconds?: number; strict?: boolean };

type AnySchema = z.ZodType;
type Out<S> = S extends z.ZodType ? z.output<S> : Record<string, never>;
type UserOf<A> = A extends 'public' ? null : A extends 'optional' ? AuthUser | null : AuthUser;

export interface RouteConfig<
  P extends AnySchema | undefined,
  Q extends AnySchema | undefined,
  B extends AnySchema | null | undefined,
  R extends AnySchema | null,
  A extends AuthSpec,
> {
  /** Defaults to 'required'. */
  auth?: A;
  /** Required when the path has :params. Validate ids (e.g. z.uuid()). */
  params?: P;
  query?: Q;
  /** Required for POST/PUT/PATCH (use `null` for an explicitly empty body). */
  body?: B;
  /**
   * Shape of the success response. Fields not in the schema are stripped before sending, so
   * internal columns can never leak. `null` means 204 No Content.
   */
  response: R;
  /** Success status. Default 200 (use 201 when creating, 202 when accepted for later processing). */
  status?: 200 | 201 | 202;
  /** Extra authorization after authentication; return false for 403. */
  authorize?: (ctx: { user: UserOf<A>; params: Out<P>; query: Out<Q> }) => boolean | Promise<boolean>;
  /** Per-route limit (bounded). Defaults: 120/min per user, 30/min per IP on public routes. */
  rateLimit?: RateLimitRule;
  /** Honor `Idempotency-Key` (default 'optional' on POST/PATCH) or demand it ('required', e.g. payments). */
  idempotency?: 'optional' | 'required' | 'off';
  /** Handler + database time budget. Default 10 000, max 30 000. */
  timeoutMs?: number;
  /** Shared caching, only for public GET routes. */
  cache?: { maxAgeSeconds: number };
  /** Max request body. Default 100 KB, max 10 MB. */
  bodyLimitBytes?: number;
  summary?: string;
  description?: string;
  tags?: string[];
}

export interface Reply<T> {
  readonly __reply: true;
  status: 200 | 201 | 202;
  body: T;
  location?: string;
}

/** Runs parameterized SQL in this request's transaction and returns the rows. */
export interface SqlRunner {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  /** Exactly one row, else 404 (also when the row exists but belongs to someone else). */
  one<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  /** One row or null. */
  maybeOne<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T | null>;
  /** Full result (rows + rowCount), e.g. to check how many rows an UPDATE touched. */
  exec<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<QueryResult<T>>;
}

export interface HandlerContext<P, Q, B, U> {
  user: U;
  params: P;
  query: Q;
  body: B;
  /** Injection-proof SQL in a per-request transaction; the database enforces row ownership. */
  sql: SqlRunner;
  /**
   * The Basalt Data block as the signed-in user (get/list/create/update/archive/restore).
   * Postgres checks the user's token inside basalt.api(), so each user only ever reaches their
   * own (or shared) rows. Needs a signed-in user and BASALT_DATA_URL.
   */
  data: DataClient;
  request: { id: string; ip: string; method: string; path: string; header(name: string): string | undefined };
  /** Aborted when the request times out; pass it to slow operations. */
  signal: AbortSignal;
  /** SSRF-safe fetch for URLs users can influence. */
  fetch: SafeFetch;
  log: Logger;
  /** Respond with a different 2xx status and/or a Location header. */
  reply<T>(status: 200 | 201 | 202, body: T, opts?: { location?: string }): Reply<T>;
}

type HandlerResult<R> = R extends z.ZodType ? z.input<R> | Reply<z.input<R>> : void;

export type Handler<P, Q, B, R, A> = (
  ctx: HandlerContext<Out<P>, Out<Q>, B extends z.ZodType ? z.output<B> : null, UserOf<A>>,
) => Promise<HandlerResult<R>>;

export interface ApiOptions {
  /**
   * Platform-managed service config (validated, bounded). Default: BASALT_API_CONFIG env var, which
   * the MCP tools maintain. Takes precedence over the operational options below.
   */
  config?: ApiServiceConfig | string;
  /** URL prefix for all routes. Default '/api' (the platform routes https://<app>/api/* here). */
  basePath?: string;
  /** Auth SDK instance or options. Default: configured from BASALT_* env vars. */
  auth?: AuthServer | AuthServerOptions;
  /** Postgres for ctx.sql. Default: DATABASE_URL (the restricted app role). `false` disables. */
  database?: { pool?: PgPoolLike & { end?: () => Promise<void> }; url?: string; maxConnections?: number } | false;
  /** Basalt Data service for ctx.data. Default BASALT_DATA_URL. */
  dataUrl?: string;
  /** Shared state for rate limits + idempotency. Default REDIS_URL. Required in production. */
  redisUrl?: string;
  /** Shared secret with the platform edge. Default BASALT_EDGE_SECRET. Required in production. */
  edgeSecret?: string;
  /** Cross-origin browser apps allowed to call this API with credentials. Default BASALT_APP_ORIGINS. */
  allowedOrigins?: string[];
  /** Pull revoked sessions into the database (default on when a database and secret key exist). */
  revocationSync?: boolean;
  limits?: {
    /** Concurrent requests per instance before shedding load with 503. Default 512. */
    maxInFlight?: number;
    defaultTimeoutMs?: number;
    defaultBodyLimitBytes?: number;
    /** Per-IP ceiling across all routes, checked before auth. Default 600/min. */
    perIp?: RateLimitRule;
  };
  env?: 'production' | 'development' | 'test';
  logLevel?: LogLevel;
  logger?: Logger;
  /** Test hook: socket address lookup. */
  remoteAddress?: (c: Context) => string | undefined;
  /** Test hook for the SSRF-safe fetch resolver. */
  safeFetch?: SafeFetch;
}

export interface Api {
  get: RouteMethod;
  post: RouteMethod;
  put: RouteMethod;
  patch: RouteMethod;
  delete: RouteMethod;
  /** Fetch-API handler (Node via serve(), Bun, Deno, workers). Freezes route registration. */
  fetch: (request: Request, env?: unknown, ctx?: unknown) => Promise<Response>;
  /** OpenAPI 3.1 document for all routes. */
  openapi(info?: { title?: string; version?: string }): Record<string, unknown>;
  /** Every route with its effective policy (code + service config). */
  routes(): Array<{ method: string; path: string; key: string; auth: AuthSpec; rateLimit: RateLimitRule; timeoutMs: number; bodyLimitBytes: number; disabled: boolean }>;
  /** Stops background work and closes the database pool the framework created. */
  close(): Promise<void>;
}

type RouteMethod = <
  A extends AuthSpec = 'required',
  P extends AnySchema | undefined = undefined,
  Q extends AnySchema | undefined = undefined,
  B extends AnySchema | null | undefined = undefined,
  R extends AnySchema | null = AnySchema | null,
>(
  path: string,
  config: RouteConfig<P, Q, B, R, A>,
  handler: Handler<P, Q, B, R, A>,
) => void;

// ------------------------------------------------------------------------------------ internals

interface RouteDef {
  id: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  fullPath: string;
  config: RouteConfig<any, any, any, any, any>;
  handler: (ctx: any) => Promise<any>;
}

interface RequestState {
  id: string;
  ip: string;
  ipKey: string;
  log: Logger;
  edgeVerified: boolean;
  route?: string;
  userId?: string;
}

type Env = { Variables: { rs: RequestState } };

const BOUNDS = {
  timeoutMs: [100, 30_000],
  bodyLimitBytes: [1, 10 * 1024 * 1024],
  rateLimit: [1, 100_000],
  rateWindow: [1, 86_400],
  cacheMaxAge: [0, 86_400],
} as const;
const DEFAULT_USER_LIMIT: RateLimitRule = { limit: 120, windowSeconds: 60 };
const DEFAULT_PUBLIC_LIMIT: RateLimitRule = { limit: 30, windowSeconds: 60 };
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,200}$/;

const inRange = (v: number, [min, max]: readonly [number, number], what: string) => {
  if (!Number.isFinite(v) || v < min || v > max) throw new Error(`Basalt API: ${what} must be between ${min} and ${max} (got ${v}).`);
  return v;
};

export function createApi(options: ApiOptions = {}): Api {
  const env = options.env ?? ((process.env.NODE_ENV as ApiOptions['env']) || 'development');
  const isProd = env === 'production';
  const svc = parseServiceConfig(options.config ?? process.env.BASALT_API_CONFIG);
  const log = options.logger ?? createLogger(svc.logLevel ?? options.logLevel ?? (env === 'test' ? 'warn' : 'info'));
  const basePath = (options.basePath ?? '/api').replace(/\/+$/, '');
  if (!/^(\/[A-Za-z0-9_-]+)*$/.test(basePath) || basePath.startsWith('/_basalt')) {
    throw new Error(`Basalt API: invalid basePath "${basePath}".`);
  }
  const edgeSecret = options.edgeSecret ?? process.env.BASALT_EDGE_SECRET;
  const redisUrl = options.redisUrl ?? process.env.REDIS_URL;
  const allowedOrigins = svc.allowedOrigins ?? options.allowedOrigins ?? (process.env.BASALT_APP_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);

  // Refuse insecure production deployments outright, like the auth service does.
  if (isProd) {
    const problems: string[] = [];
    if (!edgeSecret || edgeSecret.length < 32) problems.push('BASALT_EDGE_SECRET (>= 32 chars) is required so the backend only accepts requests from the platform edge');
    if (!redisUrl) problems.push('REDIS_URL is required so rate limits and idempotency are shared across instances');
    for (const o of allowedOrigins) if (!o.startsWith('https://')) problems.push(`allowed origin must be https: ${o}`);
    if (problems.length) throw new Error(`Basalt API refusing to start:\n  ${problems.join('\n  ')}`);
  } else if (!edgeSecret) {
    log.warn('edge_check_disabled', { note: 'BASALT_EDGE_SECRET not set: direct requests are accepted (development only).' });
  }

  const auth: AuthServer =
    options.auth && 'requireUser' in options.auth ? options.auth : createAuthServer(options.auth as AuthServerOptions | undefined);

  let ownedPool: (PgPoolLike & { end(): Promise<void> }) | undefined;
  let pool: PgPoolLike | undefined;
  const dbOpt = options.database;
  if (dbOpt !== false) {
    if (dbOpt?.pool) pool = dbOpt.pool;
    else {
      const url = dbOpt?.url ?? process.env.DATABASE_URL;
      if (url) {
        const created = createPool(url, dbOpt?.maxConnections ?? Number(process.env.DATABASE_MAX_CONNECTIONS ?? 10));
        pool = created;
        ownedPool = created;
      }
    }
  }

  let redis: Redis | undefined;
  let rateLimiter: RateLimiter;
  let idempotency: IdempotencyStore;
  if (redisUrl) {
    redis = createRedis(redisUrl);
    // Per-project prefix: apps sharing a Redis never share limits or idempotency records.
    const ns = (process.env.BASALT_PROJECT_ID ?? 'default').replace(/[^A-Za-z0-9_]/g, '');
    rateLimiter = new RedisRateLimiter(redis, `bapi:${ns}:rl:`);
    idempotency = new RedisIdempotencyStore(redis, `bapi:${ns}:idem:`);
  } else {
    rateLimiter = new MemoryRateLimiter();
    idempotency = new MemoryIdempotencyStore();
  }

  const maxInFlight = svc.limits?.maxInFlight ?? options.limits?.maxInFlight ?? 512;
  const defaultTimeout = inRange(svc.limits?.defaultTimeoutMs ?? options.limits?.defaultTimeoutMs ?? 10_000, BOUNDS.timeoutMs, 'defaultTimeoutMs');
  const defaultBodyLimit = inRange(
    svc.limits?.defaultBodyLimitBytes ?? options.limits?.defaultBodyLimitBytes ?? 100 * 1024,
    BOUNDS.bodyLimitBytes,
    'defaultBodyLimitBytes',
  );
  const perIp = svc.limits?.perIp ?? options.limits?.perIp ?? { limit: 600, windowSeconds: 60 };
  const defaultUserLimit = svc.defaultRateLimits?.user ?? DEFAULT_USER_LIMIT;
  const defaultPublicLimit = svc.defaultRateLimits?.public ?? DEFAULT_PUBLIC_LIMIT;

  /** What actually applies to a route: code declaration + platform config (auth can only tighten). */
  function effective(route: RouteDef) {
    const ov = svc.routes?.[`${route.method} ${route.path}`];
    const auth = tightenAuth(route.config.auth, ov?.auth) as AuthSpec;
    return {
      auth,
      rateLimit: ov?.rateLimit ?? route.config.rateLimit ?? (auth === 'public' ? defaultPublicLimit : defaultUserLimit),
      timeoutMs: ov?.timeoutMs ?? route.config.timeoutMs ?? defaultTimeout,
      bodyLimitBytes: ov?.bodyLimitBytes ?? route.config.bodyLimitBytes ?? defaultBodyLimit,
      disabled: ov?.disabled === true,
    };
  }
  const safeFetch = options.safeFetch ?? createSafeFetch();
  const dataUrl = options.dataUrl ?? process.env.BASALT_DATA_URL;

  const routes: RouteDef[] = [];
  let app: Hono<Env> | undefined;
  let inFlight = 0;
  let stopSync: (() => void) | undefined;

  // -------------------------------------------------------------------------------- registration

  function register(method: RouteDef['method']) {
    return (path: string, config: RouteConfig<any, any, any, any, any>, handler: (ctx: any) => Promise<any>) => {
      if (app) throw new Error('Basalt API: routes must be registered before the API starts serving.');
      validateRoute(method, path, config);
      const fullPath = `${basePath}${path === '/' ? '' : path}` || '/';
      if (routes.some((r) => r.method === method && r.fullPath === fullPath)) {
        throw new Error(`Basalt API: duplicate route ${method} ${fullPath}.`);
      }
      routes.push({ id: `${method} ${fullPath}`, method, path, fullPath, config, handler });
    };
  }

  function validateRoute(method: string, path: string, c: RouteConfig<any, any, any, any, any>) {
    const where = `${method} ${path}`;
    if (!/^\/([A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*)?(\/([A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*))*$/.test(path)) {
      throw new Error(`Basalt API: ${where}: path must be like /todos/:id (letters, digits, -_.~ and :params; no wildcards or regex).`);
    }
    if (path.startsWith('/_basalt')) throw new Error(`Basalt API: ${where}: /_basalt is reserved.`);
    const declared = [...path.matchAll(/:([A-Za-z][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
    if (declared.length) {
      if (!c.params) throw new Error(`Basalt API: ${where}: declares :${declared.join(', :')} but has no params schema. Validate ids, e.g. params: z.object({ id: z.uuid() }).`);
      const shapeKeys = c.params instanceof z.ZodObject ? Object.keys(c.params.shape) : [];
      for (const d of declared) {
        if (!shapeKeys.includes(d)) throw new Error(`Basalt API: ${where}: params schema is missing "${d}".`);
      }
    } else if (c.params) throw new Error(`Basalt API: ${where}: has a params schema but no :params in the path.`);
    if (!('response' in c)) {
      throw new Error(`Basalt API: ${where}: a response schema is required (use null for 204 No Content). It keeps internal fields from leaking.`);
    }
    if (UNSAFE.has(method) && method !== 'DELETE' && c.body === undefined) {
      throw new Error(`Basalt API: ${where}: a body schema is required (use body: null for no body).`);
    }
    if ((method === 'GET' || method === 'DELETE') && c.body) throw new Error(`Basalt API: ${where}: ${method} requests cannot have a body.`);
    const a = c.auth ?? 'required';
    if (typeof a === 'string' && !['required', 'optional', 'public'].includes(a)) throw new Error(`Basalt API: ${where}: invalid auth "${a}".`);
    if (typeof a === 'object' && a.maxAgeSeconds !== undefined) inRange(a.maxAgeSeconds, [1, 86_400], `${where} maxAgeSeconds`);
    if (c.timeoutMs !== undefined) inRange(c.timeoutMs, BOUNDS.timeoutMs, `${where} timeoutMs`);
    if (c.bodyLimitBytes !== undefined) inRange(c.bodyLimitBytes, BOUNDS.bodyLimitBytes, `${where} bodyLimitBytes`);
    if (c.rateLimit) {
      inRange(c.rateLimit.limit, BOUNDS.rateLimit, `${where} rateLimit.limit`);
      inRange(c.rateLimit.windowSeconds, BOUNDS.rateWindow, `${where} rateLimit.windowSeconds`);
    }
    if (c.cache) {
      if (method !== 'GET' || a !== 'public') {
        throw new Error(`Basalt API: ${where}: cache is only allowed on public GET routes (caching personal data in shared caches leaks it).`);
      }
      inRange(c.cache.maxAgeSeconds, BOUNDS.cacheMaxAge, `${where} cache.maxAgeSeconds`);
    }
    if (c.idempotency && c.idempotency !== 'off' && method !== 'POST' && method !== 'PATCH') {
      throw new Error(`Basalt API: ${where}: idempotency keys apply to POST/PATCH only (PUT/DELETE are idempotent by definition).`);
    }
  }

  // -------------------------------------------------------------------------------- serving

  function build(): Hono<Env> {
    const a = new Hono<Env>();

    a.use('*', async (c, next) => {
      const started = performance.now();
      const url = new URL(c.req.url);
      if (url.pathname === '/_basalt/health') return c.json({ ok: true });

      const presentedId = c.req.header('x-request-id');
      let edgeVerified = false;
      if (edgeSecret) {
        edgeVerified = verifyEdgeSignature(edgeSecret, c.req.header(EDGE_HEADER), {
          method: c.req.method,
          pathAndQuery: url.pathname + url.search,
          requestId: presentedId,
        });
        if (!edgeVerified) {
          // Direct hits to the origin (bypassing the edge) get nothing useful back.
          return applySecurityHeaders(errorResponse(new ApiError('direct_access_forbidden', 'Forbidden.'), randomUUID()), false);
        }
      }
      const id = edgeVerified && presentedId && REQUEST_ID_RE.test(presentedId) ? presentedId : randomUUID();
      const ip = clientIp(c, edgeVerified);
      const rs: RequestState = { id, ip, ipKey: ipRateLimitKey(ip), log: log.child({ requestId: id }), edgeVerified };
      c.set('rs', rs);

      if (inFlight >= maxInFlight) {
        return applySecurityHeaders(errorResponse(errors.unavailable(1, 'The server is busy. Please retry.'), id), false);
      }
      inFlight++;
      try {
        await next();
      } finally {
        inFlight--;
        const status = c.res.status;
        const ms = Math.round(performance.now() - started);
        const line = { method: c.req.method, route: rs.route ?? url.pathname, status, ms, userId: rs.userId };
        if (status >= 500) rs.log.error('request', line);
        else rs.log.info('request', line);
      }
      if (c.req.method === 'HEAD') c.res = new Response(null, c.res);
      c.res = applySecurityHeaders(c.res, Boolean(rs.userId));
      c.res.headers.set('x-request-id', id);
      applyCors(c);
    });

    // Origin policy + CORS preflight.
    a.use('*', async (c, next) => {
      const origin = c.req.header('origin');
      const verdict = origin === undefined ? 'none' : originVerdict(c, origin);
      if (c.req.method === 'OPTIONS') {
        if (verdict !== 'cross-allowed') return c.body(null, verdict === 'same' ? 204 : 403);
        return c.body(null, 204, {
          'access-control-allow-origin': origin!,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
          'access-control-allow-headers': 'content-type, authorization, idempotency-key, if-match',
          'access-control-max-age': '600',
          vary: 'Origin',
        });
      }
      // A foreign website may not drive state changes through a visitor's browser, even on public routes.
      if (verdict === 'foreign' && UNSAFE.has(c.req.method)) {
        throw new ApiError('origin_not_allowed', 'Cross-site requests are not allowed.');
      }
      await next();
    });

    a.get('/_basalt/ready', async (c) => {
      if (isProd && !c.get('rs').edgeVerified) throw errors.notFound();
      let ok = true;
      if (pool) {
        const client = await pool.connect().catch(() => null);
        if (!client) ok = false;
        else {
          ok = await client.query('SELECT 1').then(() => true, () => false);
          client.release(ok ? undefined : new Error('readiness'));
        }
      }
      if (redis) ok = ok && (await redis.ping().then(() => true, () => false));
      return c.json({ ok }, ok ? 200 : 503);
    });

    // Effective policy per route, for the platform / MCP tools (no secrets).
    a.get('/_basalt/introspect', (c) => {
      if (isProd && !c.get('rs').edgeVerified) throw errors.notFound();
      return c.json({ basePath, maintenance: svc.maintenance ?? { enabled: false }, allowedOrigins, routes: api.routes() });
    });

    a.get('/_basalt/openapi.json', (c) => {
      if (isProd && !c.get('rs').edgeVerified) throw errors.notFound();
      return c.json(api.openapi());
    });

    for (const route of routes) {
      const handler = (c: Context<Env>) => runRoute(c, route);
      a.on(route.method === 'GET' ? ['GET', 'HEAD'] : [route.method], route.fullPath, handler);
    }
    // 405 with Allow for known paths requested with the wrong method.
    const byPath = new Map<string, Set<string>>();
    for (const r of routes) {
      const set = byPath.get(r.fullPath) ?? new Set<string>();
      set.add(r.method);
      if (r.method === 'GET') set.add('HEAD');
      byPath.set(r.fullPath, set);
    }
    for (const [path, methods] of byPath) {
      a.all(path, () => {
        throw new ApiError('method_not_allowed', 'Method not allowed.', { allow: [...methods, 'OPTIONS'] });
      });
    }

    a.notFound((c) => errorResponse(errors.notFound(), c.get('rs')?.id ?? randomUUID()));
    a.onError((err, c) => {
      const rs = c.get('rs');
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) rs?.log.error('handler_error', { err, route: rs.route });
      return errorResponse(apiErr, rs?.id ?? randomUUID());
    });

    const known = new Set(routes.map((r) => `${r.method} ${r.path}`));
    for (const key of Object.keys(svc.routes ?? {})) {
      if (!known.has(key)) log.warn('config_unknown_route', { key, note: 'BASALT_API_CONFIG has an override for a route that does not exist.' });
    }

    if (pool && (svc.revocationSync ?? options.revocationSync ?? Boolean(process.env.BASALT_AUTH_SECRET_KEY))) {
      stopSync = auth.startRevocationSync(pool, { onError: (err) => log.warn('revocation_sync_failed', { err }) });
    } else if (pool && isProd) {
      log.warn('revocation_sync_disabled', { note: 'Set BASALT_AUTH_SECRET_KEY so revoked sessions lose database access within seconds.' });
    }
    return a;
  }

  function originVerdict(c: Context<Env>, origin: string): 'same' | 'cross-allowed' | 'foreign' {
    if (allowedOrigins.includes(origin)) return 'cross-allowed';
    const host = (c.get('rs')?.edgeVerified ? c.req.header('x-forwarded-host')?.split(',')[0]?.trim() : undefined) ?? c.req.header('host');
    try {
      return host && new URL(origin).host === host ? 'same' : 'foreign';
    } catch {
      return 'foreign';
    }
  }

  function applyCors(c: Context<Env>) {
    const origin = c.req.header('origin');
    c.res.headers.append('vary', 'Origin');
    if (origin && allowedOrigins.includes(origin)) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('access-control-allow-credentials', 'true');
      c.res.headers.set('access-control-expose-headers', 'x-request-id, retry-after, location, idempotent-replayed');
    }
  }

  function clientIp(c: Context<Env>, edgeVerified: boolean): string {
    if (edgeVerified) {
      // The edge appends the client address as the last X-Forwarded-For entry.
      const last = c.req.header('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean).pop();
      if (last) return last;
    }
    if (options.remoteAddress) return options.remoteAddress(c) ?? '0.0.0.0';
    try {
      return getConnInfo(c).remote.address ?? '0.0.0.0';
    } catch {
      return '0.0.0.0';
    }
  }

  async function limit(key: string, rule: RateLimitRule) {
    const r = await rateLimiter.hit(key, rule);
    if (!r.allowed) throw errors.tooManyRequests(r.retryAfterSeconds);
  }

  async function runRoute(c: Context<Env>, route: RouteDef): Promise<Response> {
    const rs = c.get('rs');
    rs.route = route.id;
    const cfg = route.config;
    const req = c.req.raw;
    const eff = effective(route);
    const spec: AuthSpec = eff.auth;
    if (svc.maintenance?.enabled) {
      throw new ApiError('service_unavailable', svc.maintenance.message ?? 'Down for maintenance. Please try again soon.', { retryAfterSeconds: 30 });
    }
    if (eff.disabled) throw new ApiError('service_unavailable', 'This feature is temporarily unavailable.', { retryAfterSeconds: 60 });

    await limit(`ip:${rs.ipKey}`, perIp);

    // 1. Authentication (default: required). Public routes never read credentials at all.
    let user: AuthUser | null = null;
    try {
      if (spec === 'optional') user = await auth.getUser(req);
      else if (spec !== 'public') user = await auth.requireUser(req, typeof spec === 'object' ? spec : {});
    } catch (err) {
      if (err instanceof BasaltAuthError && err.status === 401) throw new ApiError('unauthenticated', 'Sign in required.');
      throw err;
    }
    if (user) rs.userId = user.id;

    // 2. Rate limit per user (or per IP for anonymous callers).
    const routeRule = eff.rateLimit;
    await limit(`${route.id}:${user ? `u:${user.id}` : `ip:${rs.ipKey}`}`, routeRule);

    // 3. Input: params and query.
    const params = parse(cfg.params, c.req.param(), 'params', 'invalid_request');
    const query = parse(cfg.query, queryObject(new URL(c.req.url).searchParams), 'query', 'invalid_request');

    // 4. Authorization hook.
    if (cfg.authorize && !(await cfg.authorize({ user, params, query }))) throw errors.forbidden();

    // 5. Body.
    let rawBody = '';
    let body: unknown = null;
    if (cfg.body) {
      rawBody = await readBody(req, eff.bodyLimitBytes);
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new ApiError('malformed_json', 'Request body is not valid JSON.');
      }
      body = parse(cfg.body, json, 'body', 'validation_failed');
    } else if (UNSAFE.has(route.method) && hasBody(req)) {
      throw errors.badRequest('This endpoint does not accept a request body.');
    }

    // 6. Idempotency.
    const idemMode = cfg.idempotency ?? (route.method === 'POST' || route.method === 'PATCH' ? 'optional' : 'off');
    const idemKeyHeader = c.req.header('idempotency-key');
    let idemKey: string | undefined;
    let fingerprint = '';
    if (idemMode !== 'off' && (idemKeyHeader !== undefined || idemMode === 'required')) {
      if (!idemKeyHeader || !IDEMPOTENCY_KEY_RE.test(idemKeyHeader)) {
        throw errors.badRequest('A valid Idempotency-Key header (8–200 characters: letters, digits, . _ : -) is required.');
      }
      idemKey = `${route.id}:${user ? user.id : rs.ipKey}:${idemKeyHeader}`;
      fingerprint = createHash('sha256').update(`${new URL(c.req.url).pathname}\n${rawBody}`).digest('hex');
      const begun = await idempotency.begin(idemKey, fingerprint);
      if (begun.state === 'in_progress') throw new ApiError('idempotency_in_progress', 'A request with this Idempotency-Key is still being processed.');
      if (begun.state === 'mismatch') throw new ApiError('idempotency_key_reused', 'This Idempotency-Key was already used with a different request.');
      if (begun.state === 'replay') {
        const r = begun.response;
        const headers: Record<string, string> = { 'idempotent-replayed': 'true' };
        if (r.body !== null) headers['content-type'] = 'application/json; charset=utf-8';
        if (r.location) headers.location = r.location;
        return new Response(r.body, { status: r.status, headers });
      }
    }

    // 7. Execute.
    let response: Response;
    try {
      response = await execute(c, route, user, params, query, body, eff.timeoutMs);
    } catch (err) {
      if (idemKey) {
        const e = toApiError(err);
        // Server failures may be retried with the same key; client errors are remembered.
        if (e.status >= 500 || e.status === 409 || e.status === 429) await idempotency.abandon(idemKey).catch(() => {});
        else await idempotency.complete(idemKey, fingerprint, { status: e.status, body: JSON.stringify(errorBody(e, rs.id)) }).catch(() => {});
      }
      throw err;
    }
    if (idemKey) {
      const text = response.status === 204 ? null : await response.clone().text();
      await idempotency
        .complete(idemKey, fingerprint, { status: response.status, body: text, location: response.headers.get('location') ?? undefined })
        .catch((err) => rs.log.warn('idempotency_store_failed', { err }));
    }
    return response;
  }

  async function execute(c: Context<Env>, route: RouteDef, user: AuthUser | null, params: unknown, query: unknown, body: unknown, timeoutMs: number) {
    const rs = c.get('rs');
    const cfg = route.config;
    const controller = new AbortController();
    const db = new LazyTransaction(auth, pool, user, timeoutMs);
    const ctx: HandlerContext<unknown, unknown, unknown, AuthUser | null> = {
      user,
      params,
      query,
      body,
      sql: db.runner(),
      data: createDataClient(
        dataUrl ?? 'http://basalt-data.invalid',
        () => {
          if (!dataUrl) throw new Error('ctx.data needs BASALT_DATA_URL (the Basalt Data service).');
          if (!user) throw new ApiError('unauthenticated', 'Sign in required.');
          return auth.dataGrant(user);
        },
        controller.signal,
      ),
      request: {
        id: rs.id,
        ip: rs.ip,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        header: (name) => (/^(cookie|authorization)$/i.test(name) ? undefined : c.req.header(name)),
      },
      signal: controller.signal,
      fetch: (url, init) => safeFetch(url, { ...init, signal: init?.signal ?? controller.signal }),
      log: rs.log,
      reply: (status, replyBody, opts) => ({ __reply: true, status, body: replyBody, location: opts?.location }),
    };

    let timer: NodeJS.Timeout | undefined;
    let result: unknown;
    try {
      const run = route.handler(ctx);
      run.catch(() => {}); // a handler still running after a timeout must not crash the process
      result = await Promise.race([
        run,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new ApiError('timeout', 'The request took too long.'));
          }, timeoutMs);
        }),
      ]);
      await db.commit();
    } catch (err) {
      await db.rollback();
      throw err;
    } finally {
      clearTimeout(timer);
    }

    // Response: validate and strip undeclared fields.
    const isReply = typeof result === 'object' && result !== null && (result as Reply<unknown>).__reply === true;
    const status = isReply ? (result as Reply<unknown>).status : cfg.status ?? 200;
    const payload = isReply ? (result as Reply<unknown>).body : result;
    const headers: Record<string, string> = {};
    const location = isReply ? (result as Reply<unknown>).location : undefined;
    if (location) {
      if (!/^\/(?!\/)[^\s\\]*$/.test(location)) throw new Error('reply(): location must be a same-site path like /api/todos/123.');
      headers.location = location;
    }
    if (cfg.cache) headers['cache-control'] = `public, max-age=${cfg.cache.maxAgeSeconds}`;
    if (cfg.response === null) {
      if (payload !== undefined && payload !== null) {
        rs.log.warn('response_body_dropped', { route: route.id, note: 'response: null means 204; returned data was not sent.' });
      }
      return new Response(null, { status: 204, headers });
    }
    const checked = (cfg.response as z.ZodType).safeParse(payload);
    if (!checked.success) {
      rs.log.error('response_validation_failed', { route: route.id, issues: issues(checked.error, 'response') });
      throw new ApiError('internal_error', 'Something went wrong.');
    }
    headers['content-type'] = 'application/json; charset=utf-8';
    return new Response(JSON.stringify(checked.data, jsonReplacer), { status, headers });
  }

  /** Never includes internal error text, in any environment: details live in the server log under requestId. */
  function errorBody(e: ApiError, requestId: string) {
    return { error: { code: e.code, message: e.message, requestId, ...(e.extra.details ? { details: e.extra.details } : {}) } };
  }

  function errorResponse(e: ApiError, requestId: string): Response {
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (e.extra.retryAfterSeconds) headers['retry-after'] = String(Math.ceil(e.extra.retryAfterSeconds));
    if (e.extra.allow) headers.allow = e.extra.allow.join(', ');
    if (e.status === 401) headers['www-authenticate'] = 'Bearer realm="basalt"';
    return new Response(JSON.stringify(errorBody(e, requestId)), { status: e.status, headers });
  }

  const api: Api = {
    get: register('GET') as RouteMethod,
    post: register('POST') as RouteMethod,
    put: register('PUT') as RouteMethod,
    patch: register('PATCH') as RouteMethod,
    delete: register('DELETE') as RouteMethod,
    fetch: (request) => {
      app ??= build();
      return Promise.resolve(app.fetch(request));
    },
    openapi: (info) => buildOpenApi(routes, info),
    routes: () =>
      routes.map((r) => {
        const e = effective(r);
        return { method: r.method, path: r.fullPath, key: `${r.method} ${r.path}`, auth: e.auth, rateLimit: e.rateLimit, timeoutMs: e.timeoutMs, bodyLimitBytes: e.bodyLimitBytes, disabled: e.disabled };
      }),
    async close() {
      stopSync?.();
      if (rateLimiter instanceof MemoryRateLimiter) rateLimiter.close();
      await ownedPool?.end();
      await redis?.quit();
    },
  };
  return api;
}

// ------------------------------------------------------------------------------------ helpers

/** Opens the per-request transaction only when the handler first touches the database. */
class LazyTransaction {
  private tx: Promise<DbTransaction> | undefined;
  private closed = false;

  constructor(
    private readonly auth: AuthServer,
    private readonly pool: PgPoolLike | undefined,
    private readonly user: AuthUser | null,
    private readonly timeoutMs: number,
  ) {}

  private async exec(q: SqlQuery) {
    if (this.closed) throw new Error('Database used after the request finished (did you forget to await a query?).');
    if (!this.pool) throw new Error('No database configured: set DATABASE_URL or pass createApi({ database: { pool } }).');
    this.tx ??= this.auth.beginTransaction(this.pool, this.user, { statementTimeoutMs: this.timeoutMs });
    const t = await this.tx;
    const { text, values } = q.toQuery();
    const r = await t.client.query(text, values);
    return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length };
  }

  runner(): SqlRunner {
    const build = (strings: TemplateStringsArray, values: unknown[]) => {
      if (!Array.isArray(strings) || !('raw' in strings)) {
        throw new TypeError('ctx.sql must be used as a tagged template: ctx.sql`SELECT ... WHERE id = ${id}`');
      }
      for (const v of values) {
        if (v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function') {
          throw new TypeError('A Promise was interpolated into SQL. Use the imported `sql` tag for fragments.');
        }
      }
      return new SqlQuery(strings, values);
    };
    const run = (async (strings: TemplateStringsArray, ...values: unknown[]) => (await this.exec(build(strings, values))).rows) as SqlRunner;
    run.exec = async (strings, ...values) => (await this.exec(build(strings, values))) as never;
    run.maybeOne = async (strings, ...values) => {
      const { rows } = await this.exec(build(strings, values));
      if (rows.length > 1) throw new Error('maybeOne() query returned more than one row.');
      return (rows[0] ?? null) as never;
    };
    run.one = async (strings, ...values) => {
      const { rows } = await this.exec(build(strings, values));
      if (rows.length === 0) throw errors.notFound();
      if (rows.length > 1) throw new Error('one() query returned more than one row.');
      return rows[0] as never;
    };
    return run;
  }

  async commit() {
    this.closed = true;
    if (this.tx) await (await this.tx).commit();
  }

  async rollback() {
    this.closed = true;
    if (this.tx) await this.tx.then((t) => t.rollback(), () => {});
  }
}

function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof BasaltAuthError) {
    if (err.status === 401) return new ApiError('unauthenticated', err.message);
    if (err.code === 'email_not_verified' || err.code === 'mfa_required' || err.code === 'reauthentication_required') {
      return new ApiError(err.code, err.message);
    }
    if (err.status === 403) return new ApiError('forbidden', err.message);
    if (err.status === 429) return new ApiError('rate_limited', err.message, { retryAfterSeconds: err.retryAfterSeconds });
    return new ApiError('service_unavailable', 'Authentication is temporarily unavailable.', { retryAfterSeconds: 2 });
  }
  const db = fromDatabaseError(err);
  if (db) return db;
  if ((err as Error)?.name === 'SafeFetchError') {
    return new ApiError('invalid_request', `Could not fetch that URL: ${(err as Error).message}`);
  }
  return new ApiError('internal_error', 'Something went wrong.');
}

function parse(schema: AnySchema | undefined | null, value: unknown, where: string, code: 'invalid_request' | 'validation_failed') {
  if (!schema) return {};
  const r = schema.safeParse(value);
  if (!r.success) {
    const details = issues(r.error, where);
    throw code === 'validation_failed' ? errors.validation(details) : errors.badRequest('Some parameters are invalid.', details);
  }
  return r.data;
}

function issues(error: z.ZodError, where: string): ValidationIssue[] {
  return error.issues.slice(0, 50).map((i) => ({ path: [where, ...i.path.map(String)].join('.'), message: i.message }));
}

function queryObject(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(sp.keys())) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const all = sp.getAll(key);
    out[key] = all.length > 1 ? all : all[0]!;
  }
  return out;
}

function hasBody(req: Request) {
  const len = req.headers.get('content-length');
  return (len !== null && len !== '0') || req.headers.has('transfer-encoding');
}

async function readBody(req: Request, limitBytes: number): Promise<string> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  if (!ct.startsWith('application/json')) {
    throw new ApiError('unsupported_media_type', 'Content-Type must be application/json.');
  }
  const declared = Number(req.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > limitBytes) throw new ApiError('payload_too_large', 'Request body is too large.');
  if (!req.body) throw new ApiError('malformed_json', 'Request body is required.');
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new ApiError('payload_too_large', 'Request body is too large.');
    }
    chunks.push(value);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new ApiError('malformed_json', 'Request body is not valid UTF-8.');
  }
}

function jsonReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function applySecurityHeaders(res: Response, personal: boolean): Response {
  const h = res.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('x-frame-options', 'DENY');
  h.set('referrer-policy', 'no-referrer');
  h.set('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  h.set('cross-origin-resource-policy', 'same-origin');
  // Personal data is never stored by browsers or shared caches; public cacheable routes opt in.
  if (personal || !h.has('cache-control')) h.set('cache-control', 'no-store');
  if (personal) h.append('vary', 'Cookie, Authorization');
  return res;
}

function createPool(url: string, max: number) {
  return new pg.Pool({
    connectionString: url,
    max: Math.min(Math.max(1, max), 100),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'basalt-api',
  }) as unknown as PgPoolLike & { end(): Promise<void> };
}

function createRedis(url: string) {
  return new Redis(url, { maxRetriesPerRequest: 2, enableAutoPipelining: true });
}
