import { PGlite } from '@electric-sql/pglite';
import { randomBytes } from 'node:crypto';
import { createApp, createServices } from '../src/app.js';
import type { ServiceContext } from '../src/context.js';
import type { Db, QueryResult } from '../src/db/db.js';
import { migrate } from '../src/db/migrate.js';
import { KeyRing } from '../src/lib/crypto.js';
import { silentLogger } from '../src/lib/logger.js';
import { ConsoleMailer } from '../src/lib/mailer.js';
import { PasswordHasher } from '../src/lib/password.js';
import { MemoryRateLimiter } from '../src/lib/ratelimit.js';
import { Semaphore } from '../src/lib/semaphore.js';

const toBuffers = (row: Record<string, unknown>) => {
  for (const k of Object.keys(row)) if (row[k] instanceof Uint8Array) row[k] = Buffer.from(row[k] as Uint8Array);
  return row;
};

/** Real Postgres (WASM) behind the same Db interface production uses. */
export function pgliteDb(pg: PGlite): Db {
  type Runner = Pick<PGlite, 'query' | 'exec'>;
  const run = async <T>(r: Runner, sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
    if (params.length === 0) {
      const results = await r.exec(sql);
      const last = results[results.length - 1];
      return { rows: (last?.rows ?? []).map((x) => toBuffers(x as Record<string, unknown>)) as T[], rowCount: last?.affectedRows ?? last?.rows.length ?? 0 };
    }
    const res = await r.query<T>(sql, params);
    return { rows: res.rows.map((x) => toBuffers(x as Record<string, unknown>)) as T[], rowCount: res.affectedRows ?? res.rows.length };
  };
  const db: Db = {
    query: (sql, params) => run(pg, sql, params),
    transaction: (fn) =>
      pg.transaction(async (tx) => {
        const txDb: Db = {
          query: (sql, params) => run(tx as unknown as Runner, sql, params),
          transaction: (inner) => inner(txDb),
          close: async () => {},
        };
        return fn(txDb);
      }),
    close: () => pg.close(),
  };
  return db;
}

export const PLATFORM_KEY = 'test-platform-key-0123456789abcdef0123456789';
export const ORIGIN = 'https://app.example.com';

export class CookieJar {
  readonly cookies = new Map<string, string>();
  absorb(res: Response) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair!.indexOf('=');
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0\b/i.test(a.trim()) || /expires=thu, 01 jan 1970/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface Harness {
  ctx: ServiceContext;
  services: ReturnType<typeof createServices>;
  app: ReturnType<typeof createApp>;
  mailer: ConsoleMailer;
  breached: Set<string>;
  clock: { offsetMs: number };
  request(method: string, path: string, opts?: RequestOpts): Promise<Response>;
  createProject(body?: Record<string, unknown>): Promise<{ projectId: string; secretKey: string; project: any }>;
  lastCode(to: string): Promise<string>;
  close(): Promise<void>;
}

export interface RequestOpts {
  body?: unknown;
  origin?: string | null;
  jar?: CookieJar;
  headers?: Record<string, string>;
  ip?: string;
  bearer?: string;
}

export async function createHarness(): Promise<Harness> {
  const pg = new PGlite();
  const db = pgliteDb(pg);
  await migrate(db);
  const mailer = new ConsoleMailer();
  const breached = new Set<string>(['correct horse battery staple']);
  const clock = { offsetMs: 0 };
  const ctx: ServiceContext = {
    db,
    keyRing: new KeyRing(randomBytes(32)),
    // Cheap parameters keep the suite fast; production params are covered in password.test.ts.
    hasher: new PasswordHasher({ memoryKiB: 1024, passes: 1, parallelism: 1 }, new Semaphore(4, 1000)),
    rateLimiter: new MemoryRateLimiter(() => Date.now() + clock.offsetMs),
    mailer,
    breachChecker: { isBreached: async (p) => breached.has(p) },
    log: silentLogger,
    publicUrl: 'https://auth.test',
    now: () => new Date(Date.now() + clock.offsetMs),
  };
  const services = createServices(ctx);
  const app = createApp(ctx, services, {
    platformKey: PLATFORM_KEY,
    isProduction: false,
    trustProxyHops: 0,
    cookieSecure: true,
    remoteAddress: (c) => c.req.header('x-test-ip') ?? '203.0.113.10',
  });

  const request: Harness['request'] = async (method, path, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.origin !== null && opts.origin !== undefined) headers.origin = opts.origin;
    if (opts.body !== undefined) headers['content-type'] ??= 'application/json';
    if (opts.jar && opts.jar.cookies.size) headers.cookie = opts.jar.header();
    if (opts.ip) headers['x-test-ip'] = opts.ip;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const res = await app.request(path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    });
    opts.jar?.absorb(res);
    return res;
  };

  return {
    ctx,
    services,
    app,
    mailer,
    breached,
    clock,
    request,
    async createProject(body = {}) {
      const res = await request('POST', '/v1/platform/projects', {
        bearer: PLATFORM_KEY,
        body: { name: 'Test App', allowedOrigins: [ORIGIN], ...body },
      });
      if (res.status !== 201) throw new Error(`createProject failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as any;
      return { projectId: json.project.id, secretKey: json.secretKey, project: json.project };
    },
    async lastCode(to: string) {
      await services.accounts.drain();
      const msg = [...mailer.outbox].reverse().find((m) => m.to === to && 'code' in m);
      if (!msg || !('code' in msg)) throw new Error(`No code emailed to ${to}`);
      return msg.code;
    },
    async close() {
      await services.accounts.drain();
      (ctx.rateLimiter as MemoryRateLimiter).close();
      await db.close();
    },
  };
}

export const GOOD_PASSWORD = 'violet-anchor-58-tundra';
