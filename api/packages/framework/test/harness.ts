import { PGlite } from '@electric-sql/pglite';
import { createAuthServer, type PgPoolLike } from '@basalt/auth/server';
import { CookieJar, createHarness, GOOD_PASSWORD, PLATFORM_KEY, type Harness } from '../../../../auth/packages/server/test/helpers.js';
import { createApi, signEdgeRequest, type Api, type ApiOptions } from '../src/index.js';

export const AUTH_URL = 'https://auth.test';
export const APP = 'https://app.example.com';
export const EDGE_SECRET = 'edge-secret-for-tests-0123456789abcdef';
export { CookieJar, GOOD_PASSWORD };

export interface ApiHarness {
  auth: Harness;
  projectId: string;
  secretKey: string;
  appDb: PGlite;
  pool: PgPoolLike;
  serverFetch: typeof fetch;
  makeApi(opts?: Partial<ApiOptions>): Api;
  signUp(): Promise<{ jar: CookieJar; userId: string; accessToken: string; email: string }>;
  call(api: Api, method: string, path: string, opts?: CallOpts): Promise<Response>;
  close(): Promise<void>;
}

export interface CallOpts {
  jar?: CookieJar;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  origin?: string | null;
  edge?: boolean | 'tamper' | 'stale';
  ip?: string;
}

/** Serialize all DB access: PGlite is a single connection, like one pooled client. */
function pglitePool(db: PGlite, role: string): PgPoolLike {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async connect() {
      let release!: () => void;
      const prev = chain;
      chain = new Promise<void>((r) => (release = r));
      await prev;
      await db.exec(`SET ROLE ${role}`);
      return {
        async query(sql: string, params: unknown[] = []) {
          const r = await db.query(sql, params);
          return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
        },
        release() {
          void db.exec('ROLLBACK; RESET ROLE').catch(() => {}).finally(release);
        },
      };
    },
  };
}

export async function createApiHarness(): Promise<ApiHarness> {
  const auth = await createHarness();
  const { projectId, secretKey } = await auth.createProject({ allowedOrigins: [APP], settings: { requireEmailVerification: false } });
  const serverFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url, AUTH_URL);
    return auth.app.request(url.pathname + url.search, init as RequestInit);
  };
  const appDb = new PGlite();
  const installSql = await (
    await serverFetch(`/v1/platform/projects/${projectId}/data-protection/install.sql`, {
      headers: { authorization: `Bearer ${PLATFORM_KEY}`, 'x-basalt-owner': 'ws_test' },
    })
  ).text();
  await appDb.exec(installSql);
  await appDb.exec(`
    CREATE ROLE app_user NOLOGIN;
    CREATE TABLE todos (id bigserial PRIMARY KEY, owner_id uuid, title text NOT NULL, internal_note text DEFAULT 'secret', UNIQUE (owner_id, title));
    SELECT basalt_auth.protect('todos');
    CREATE TABLE announcements (id serial PRIMARY KEY, body text NOT NULL);
    INSERT INTO announcements (body) VALUES ('hello world');
    GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO app_user;
    GRANT SELECT ON announcements TO app_user;
    GRANT USAGE ON SEQUENCE todos_id_seq TO app_user;
  `);
  const pool = pglitePool(appDb, 'app_user');
  const apis: Api[] = [];
  let n = 0;

  const h: ApiHarness = {
    auth,
    projectId,
    secretKey,
    appDb,
    pool,
    serverFetch,
    makeApi(opts = {}) {
      const api = createApi({
        env: 'test',
        auth: createAuthServer({ projectId, authUrl: AUTH_URL, secretKey, fetch: serverFetch }),
        database: { pool },
        edgeSecret: EDGE_SECRET,
        revocationSync: false,
        remoteAddress: (c) => c.req.header('x-test-ip') ?? '198.51.100.20',
        ...opts,
      });
      apis.push(api);
      return api;
    },
    async signUp() {
      const jar = new CookieJar();
      const email = `api${++n}-${Date.now()}@example.com`;
      const res = await auth.app.request(`/v1/projects/${projectId}/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: APP, 'x-test-ip': `10.9.${Math.floor(n / 250)}.${n % 250}` },
        body: JSON.stringify({ email, password: GOOD_PASSWORD }),
      });
      jar.absorb(res);
      const body = (await res.json()) as any;
      const native = await auth.app.request(`/v1/projects/${projectId}/signin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-test-ip': `10.9.${Math.floor(n / 250)}.${n % 250}` },
        body: JSON.stringify({ email, password: GOOD_PASSWORD }),
      });
      return { jar, userId: body.user.id, email, accessToken: ((await native.json()) as any).accessToken };
    },
    async call(api, method, path, o = {}) {
      const url = new URL(path, APP);
      const requestId = `req-${Math.random().toString(36).slice(2)}-${Date.now()}`;
      const headers: Record<string, string> = { host: 'app.example.com', 'x-request-id': requestId, ...(o.headers ?? {}) };
      if (o.edge !== false) {
        const now = o.edge === 'stale' ? Date.now() - 5 * 60_000 : Date.now();
        const signedPath = o.edge === 'tamper' ? '/api/something-else' : url.pathname + url.search;
        headers['basalt-edge-signature'] = signEdgeRequest(EDGE_SECRET, { method, pathAndQuery: signedPath, requestId, now });
        headers['x-forwarded-for'] = o.ip ?? '203.0.113.50';
      }
      const isUnsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (o.origin !== null && (o.origin !== undefined || isUnsafe)) headers.origin = o.origin ?? APP;
      if (o.jar?.cookies.size) headers.cookie = o.jar.header();
      let body: string | undefined;
      if (o.rawBody !== undefined) body = o.rawBody;
      else if (o.body !== undefined) {
        body = JSON.stringify(o.body);
        headers['content-type'] ??= 'application/json';
      }
      return api.fetch(new Request(url, { method, headers, body }));
    },
    async close() {
      for (const a of apis) await a.close();
      await auth.close();
    },
  };
  return h;
}
