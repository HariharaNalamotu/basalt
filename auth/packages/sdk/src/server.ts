/**
 * Basalt Auth — backend SDK (Node, Bun, Deno, edge runtimes).
 *
 *   import { createAuthServer } from '@basalt/auth/server';
 *   const auth = createAuthServer();               // configured from env on Basalt
 *
 *   const user = await auth.getUser(request);      // AuthUser | null
 *   const user = await auth.requireUser(request);  // throws BasaltAuthError(401) if signed out
 *
 * `getUser` verifies the access token's signature locally (no network call per request), checks
 * issuer, audience, algorithm, token type and expiry, and blocks cross-site request forgery for
 * cookie-authenticated writes. Revocation lag is bounded by the access token TTL (10 min default);
 * pass `{ strict: true }` for actions that must see revocations instantly (payments, deletes).
 */
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose';
import { BasaltAuthError, toAuthError } from './errors.js';
import type { User } from './types.js';

export { BasaltAuthError } from './errors.js';
export type { AuthErrorCode } from './errors.js';
export type { User } from './types.js';

export interface AuthServerOptions {
  /** Defaults to env BASALT_PROJECT_ID. */
  projectId?: string;
  /** Base URL of the auth service. Defaults to env BASALT_AUTH_URL. */
  authUrl?: string;
  /** Project secret key (bslt_sk_...). Defaults to env BASALT_AUTH_SECRET_KEY. Needed for `admin` and `strict`. */
  secretKey?: string;
  /**
   * Extra browser origins allowed to make cookie-authenticated writes to this backend, besides
   * its own origin. Defaults to env BASALT_APP_ORIGINS (comma separated).
   */
  allowedOrigins?: string[];
  /**
   * Where this server reaches the auth service (JWKS, admin API) if different from the public
   * `authUrl`, e.g. a private network address. Defaults to env BASALT_AUTH_INTERNAL_URL, then authUrl.
   * Tokens are still verified against the public issuer.
   */
  internalUrl?: string;
  /** Custom fetch (tests). */
  fetch?: typeof fetch;
}

/** The verified identity attached to a request. */
export interface AuthUser {
  id: string;
  email: string;
  emailVerified: boolean;
  sessionId: string;
  /** How the user authenticated: 'pwd', 'otp' (authenticator app), 'recovery', 'email'. */
  amr: string[];
  /** True if this session passed a second factor. */
  mfa: boolean;
  /** When the user last proved their identity in this session (sign-in or re-authentication). */
  authTime: Date;
}

/** Minimal node-postgres–compatible pool (pg.Pool, or anything with the same shape). */
export interface PgPoolLike {
  connect(): Promise<PgClientLike & { release(err?: Error | boolean): void }>;
}
export interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface DbTransaction {
  client: PgClientLike;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

const isGrantError = (err: unknown) => (err as { code?: string } | null)?.code === '28000';
const sessionInvalid = () => new BasaltAuthError('unauthenticated', 'Session is no longer valid. Please sign in again.', 401);

export interface GetUserOptions {
  /** Also confirm with the auth service that the session is still live (one network call). */
  strict?: boolean;
}

export interface RequireUserOptions extends GetUserOptions {
  /** Reject (403) users whose email is not verified. */
  emailVerified?: boolean;
  /** Reject (403) sessions that did not pass a second factor. */
  mfa?: boolean;
  /**
   * Reject (403 `reauthentication_required`) unless the user proved their identity within this
   * many seconds. Use for payments, deleting data, changing email/roles. The client then calls
   * `auth.reauthenticate({ password })` and retries.
   */
  maxAgeSeconds?: number;
}

/** Anything with a `get(name)` method: Fetch Headers, Next.js `headers()`, etc. */
export interface HeaderReader {
  get(name: string): string | null | undefined;
}

/** Anything request-shaped: Fetch API Request, Node/Express IncomingMessage, or a headers bag. */
export type RequestLike =
  | Request
  | { headers: HeaderReader | Record<string, string | string[] | undefined>; method?: string; url?: string };

export interface AuthServer {
  getUser(req: RequestLike, opts?: GetUserOptions): Promise<AuthUser | null>;
  requireUser(req: RequestLike, opts?: RequireUserOptions): Promise<AuthUser>;
  /** Verify a raw access token (e.g. from a WebSocket handshake). No CSRF check — you chose the transport. */
  verifyAccessToken(token: string, opts?: GetUserOptions): Promise<AuthUser | null>;
  /**
   * Express/Connect middleware. Sets `req.auth` to the AuthUser or null. With `{ required: true }`
   * responds 401 JSON for signed-out requests.
   */
  middleware(opts?: RequireUserOptions & { required?: boolean }): (req: any, res: any, next: (err?: unknown) => void) => void;
  /**
   * Runs `fn` in a database transaction where Postgres itself verifies the user's session-bound
   * data grant. Tables protected with `basalt_auth.protect()` then only expose this user's rows,
   * even to queries with no WHERE clause. Commits on success, rolls back on error.
   *
   *   const todos = await auth.withUserDb(pool, req, (db) => db.query('SELECT * FROM todos'));
   */
  withUserDb<T>(pool: PgPoolLike, who: RequestLike | AuthUser, fn: (db: PgClientLike, user: AuthUser) => Promise<T>, opts?: RequireUserOptions): Promise<T>;
  /**
   * The data grant for a verified user, for ORMs that manage their own transactions. Inside a
   * transaction run `SELECT basalt_auth.authenticate($1)` with it before any other query.
   * Never log it or send it to the browser: it is a credential.
   */
  dataGrant(user: AuthUser): string;
  /** Lower-level form of withUserDb for frameworks that open the transaction lazily. */
  beginTransaction(pool: PgPoolLike, user: AuthUser | null, opts?: { statementTimeoutMs?: number }): Promise<DbTransaction>;
  /** Pulls revoked sessions into the app database once. Needs the secret key. */
  syncRevocations(pool: PgPoolLike): Promise<{ synced: number }>;
  /** Keeps revocations in sync in the background (default every 10s). Returns a stop function. */
  startRevocationSync(pool: PgPoolLike, opts?: { intervalMs?: number; onError?: (err: unknown) => void }): () => void;
  /** Server-side user management. Requires the project secret key; never use it in browser code. */
  admin: AdminApi;
}

export interface AdminApi {
  listUsers(opts?: { limit?: number; cursor?: string; email?: string }): Promise<{ users: User[]; nextCursor: string | null }>;
  getUser(userId: string): Promise<User>;
  /** `metadata` replaces the stored object. Use it for roles/plans: users cannot modify it themselves. */
  updateUser(userId: string, patch: { metadata?: Record<string, unknown>; disabled?: boolean }): Promise<User>;
  deleteUser(userId: string): Promise<void>;
  revokeSessions(userId: string): Promise<{ revoked: number }>;
  listEvents(opts?: { userId?: string; limit?: number; before?: number }): Promise<{ events: AuditEvent[] }>;
}

export interface AuditEvent {
  id: number;
  userId: string | null;
  type: string;
  ip: string | null;
  userAgent: string | null;
  data: unknown;
  createdAt: string;
}

const ACCESS_COOKIES = ['__Host-basalt_at', 'basalt_at'];
const JWKS_TTL_MS = 5 * 60_000;
// Unknown `kid` triggers a refetch (keys were rotated), at most once per second so garbage tokens
// can't turn into a JWKS request flood.
const JWKS_COOLDOWN_MS = 1_000;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createAuthServer(options: AuthServerOptions = {}): AuthServer {
  const env = ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {});
  const projectId = options.projectId ?? env.BASALT_PROJECT_ID;
  const authUrl = (options.authUrl ?? env.BASALT_AUTH_URL)?.replace(/\/+$/, '');
  const secretKey = options.secretKey ?? env.BASALT_AUTH_SECRET_KEY;
  const extraOrigins = options.allowedOrigins ?? (env.BASALT_APP_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []);
  const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));

  if (!projectId || !/^prj_[A-Za-z0-9]+$/.test(projectId)) {
    throw new Error('Basalt Auth: missing or invalid projectId (set BASALT_PROJECT_ID).');
  }
  if (!authUrl) throw new Error('Basalt Auth: missing authUrl (set BASALT_AUTH_URL).');
  if (secretKey && typeof window !== 'undefined' && typeof (globalThis as any).document !== 'undefined') {
    throw new Error('Basalt Auth: the secret key must never be used in browser code. Use @basalt/auth/client.');
  }

  const issuer = `${authUrl}/v1/projects/${projectId}`;
  const fetchBase = (options.internalUrl ?? env.BASALT_AUTH_INTERNAL_URL ?? authUrl).replace(/\/+$/, '');
  const projectBase = `${fetchBase}/v1/projects/${projectId}`;

  // ---------------------------------------------------------------- JWKS cache
  let jwks: { set: ReturnType<typeof createLocalJWKSet>; kids: Set<string>; at: number } | null = null;
  let lastFetch = 0;
  let inflight: Promise<void> | null = null;

  async function loadJwks(force: boolean) {
    const fresh = jwks && Date.now() - jwks.at < JWKS_TTL_MS;
    if (fresh && !force) return;
    if (force && Date.now() - lastFetch < JWKS_COOLDOWN_MS && jwks) return inflight ?? undefined;
    inflight ??= (async () => {
      lastFetch = Date.now();
      const res = await doFetch(`${projectBase}/.well-known/jwks.json`);
      if (!res.ok) throw new Error(`Basalt Auth: JWKS fetch failed (${res.status})`);
      const body = (await res.json()) as JSONWebKeySet;
      jwks = { set: createLocalJWKSet(body), kids: new Set(body.keys.map((k) => k.kid!).filter(Boolean)), at: Date.now() };
    })().finally(() => {
      inflight = null;
    });
    await inflight;
  }

  async function verify(token: string): Promise<JWTPayload | null> {
    if (token.split('.').length !== 3 || token.length > 4096) return null;
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      return null;
    }
    await loadJwks(false);
    if (kid && !jwks!.kids.has(kid)) await loadJwks(true); // key rotated since last fetch
    try {
      const { payload } = await jwtVerify(token, jwks!.set, {
        issuer,
        audience: projectId,
        algorithms: ['EdDSA'],
        typ: 'at+jwt',
        clockTolerance: 5,
      });
      return payload;
    } catch {
      return null;
    }
  }

  // Grants are kept off the user object so `console.log(user)` or `res.json(user)` can't leak them.
  const grants = new WeakMap<AuthUser, string>();

  function toAuthUser(p: JWTPayload): AuthUser | null {
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.email !== 'string') return null;
    const amr = Array.isArray(p.amr) ? (p.amr as string[]) : [];
    const user: AuthUser = {
      id: p.sub,
      email: p.email,
      emailVerified: p.email_verified === true,
      sessionId: p.sid,
      amr,
      mfa: amr.includes('otp') || amr.includes('recovery'),
      authTime: new Date((typeof p.auth_time === 'number' ? p.auth_time : (p.iat ?? 0)) * 1000),
    };
    if (typeof p.bdg === 'string') grants.set(user, p.bdg);
    return user;
  }

  async function strictCheck(token: string): Promise<boolean> {
    const r = await adminCall<{ active: boolean }>('POST', '/sessions/verify', { accessToken: token });
    return r.active;
  }

  async function verifyAccessToken(token: string, opts: GetUserOptions = {}) {
    const payload = await verify(token);
    const user = payload ? toAuthUser(payload) : null;
    if (!user) return null;
    if (opts.strict && !(await strictCheck(token))) return null;
    return user;
  }

  async function getUser(req: RequestLike, opts: GetUserOptions = {}) {
    const h = headerGetter(req);
    const authz = h('authorization');
    let token: string | undefined;
    let fromCookie = false;
    if (authz?.toLowerCase().startsWith('bearer ')) token = authz.slice(7).trim();
    else {
      token = readAccessCookie(h('cookie'), h('x-forwarded-proto'));
      fromCookie = token !== undefined;
    }
    if (!token) return null;
    if (fromCookie && UNSAFE.has((req.method ?? 'GET').toUpperCase()) && !originAllowed(req, h, extraOrigins)) {
      // Cookie-authenticated write from a foreign site: treat as signed out (CSRF).
      return null;
    }
    return verifyAccessToken(token, opts);
  }

  async function requireUser(req: RequestLike, opts: RequireUserOptions = {}) {
    const user = await getUser(req, opts);
    if (!user) throw new BasaltAuthError('unauthenticated', 'Sign in required.', 401);
    if (opts.emailVerified && !user.emailVerified) throw new BasaltAuthError('email_not_verified', 'Verify your email to continue.', 403);
    if (opts.mfa && !user.mfa) throw new BasaltAuthError('mfa_required', 'Two-factor authentication required.', 403);
    if (opts.maxAgeSeconds !== undefined && Date.now() - user.authTime.getTime() > opts.maxAgeSeconds * 1000) {
      throw new BasaltAuthError('reauthentication_required', 'Please confirm your password to continue.', 403);
    }
    return user;
  }

  // ---------------------------------------------------------------- database-enforced ownership
  const checkedPools = new WeakMap<PgPoolLike, Promise<void>>();
  const isProduction = env.NODE_ENV === 'production';

  /**
   * RLS is only a boundary if the app can't switch it off or read the grant key. Refuse to run
   * (production) or warn loudly (development) when connected as a role that defeats it.
   */
  async function assertSafeRole(db: PgClientLike) {
    let row: { rolsuper: boolean; rolbypassrls: boolean; owns_keys: boolean; can_read_keys: boolean } | undefined;
    try {
      row = (
        await db.query(
          `SELECT r.rolsuper, r.rolbypassrls,
                  pg_has_role(current_user, k.relowner, 'USAGE') AS owns_keys,
                  has_table_privilege(current_user, 'basalt_auth.keys', 'SELECT') AS can_read_keys
           FROM pg_roles r, pg_class k
           WHERE r.rolname = current_user AND k.oid = 'basalt_auth.keys'::regclass`,
        )
      ).rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '3F000') {
        throw new Error('Basalt Auth: data protection is not installed in this database. Run the auth_enable_data_protection MCP tool.');
      }
      throw err;
    }
    const problems: string[] = [];
    if (row?.rolsuper) problems.push('the database role is a superuser (bypasses row-level security)');
    if (row?.rolbypassrls) problems.push('the database role has BYPASSRLS');
    if (row?.owns_keys || row?.can_read_keys) problems.push('the database role can read the data-grant key (it owns the basalt_auth schema)');
    if (!problems.length) return;
    const message = `Basalt Auth: unsafe database role for withUserDb: ${problems.join('; ')}. Connect the app with the restricted app role the platform provides, not the admin/migration role.`;
    if (isProduction) throw new Error(message);
    console.warn(`${message} (allowed outside production)`);
  }

  /**
   * Opens a transaction on a pooled connection. With a user, Postgres verifies their data grant
   * first, so protected tables only show their rows; with `null` (public requests) no grant is
   * set and protected tables show nothing. Always finish with exactly one of commit()/rollback().
   */
  async function beginTransaction(
    pool: PgPoolLike,
    user: AuthUser | null,
    opts: { statementTimeoutMs?: number } = {},
  ): Promise<DbTransaction> {
    const grant = user ? dataGrant(user) : null;
    const client = await pool.connect();
    let done = false;
    const release = (err?: Error) => {
      if (done) return;
      done = true;
      client.release(err);
    };
    try {
      if (!checkedPools.has(pool)) {
        const check = assertSafeRole(client);
        checkedPools.set(pool, check);
        check.catch(() => checkedPools.delete(pool));
      }
      await checkedPools.get(pool);
      await client.query('BEGIN');
      if (opts.statementTimeoutMs) {
        // SET LOCAL can't take bind parameters; the value is a validated integer.
        await client.query(`SET LOCAL statement_timeout = ${Math.max(1, Math.floor(opts.statementTimeoutMs))}`);
      }
      if (grant) await client.query('SELECT basalt_auth.authenticate($1)', [grant]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      release(err instanceof Error && !isGrantError(err) ? err : undefined);
      throw isGrantError(err) ? sessionInvalid() : err;
    }
    return {
      client,
      async commit() {
        try {
          await client.query('COMMIT');
          release();
        } catch (err) {
          release(err instanceof Error ? err : undefined);
          throw err;
        }
      },
      async rollback() {
        if (done) return;
        await client.query('ROLLBACK').then(
          () => release(),
          (err: Error) => release(err), // broken connection: discard instead of reusing
        );
      },
    };
  }

  async function withUserDb<T>(
    pool: PgPoolLike,
    who: RequestLike | AuthUser,
    fn: (db: PgClientLike, user: AuthUser) => Promise<T>,
    opts: RequireUserOptions = {},
  ): Promise<T> {
    const user = grants.has(who as AuthUser) ? (who as AuthUser) : await requireUser(who as RequestLike, opts);
    const tx = await beginTransaction(pool, user);
    try {
      const result = await fn(tx.client, user);
      await tx.commit();
      return result;
    } catch (err) {
      await tx.rollback();
      throw isGrantError(err) ? sessionInvalid() : err;
    }
  }

  function dataGrant(user: AuthUser): string {
    const g = grants.get(user);
    if (!g) throw new Error('Basalt Auth: no data grant for this user object. Pass the object returned by getUser/requireUser.');
    return g;
  }

  async function syncRevocations(pool: PgPoolLike) {
    const client = await pool.connect();
    try {
      const last = (await client.query('SELECT basalt_auth.revocations_synced_to() AS t')).rows[0]?.t as Date | string | null;
      // Re-read a small overlap: revocations committed slightly out of order are still caught.
      let query = last ? `since=${encodeURIComponent(new Date(new Date(last).getTime() - 30_000).toISOString())}` : '';
      let synced = 0;
      for (let page = 0; page < 100; page++) {
        const r = await adminCall<{ revocations: { sessionId: string; revokedAt: string }[]; hasMore: boolean; nextCursor: string | null }>(
          'GET',
          `/revocations?${query}`,
        );
        if (r.revocations.length) {
          await client.query('SELECT basalt_auth.record_revocations($1::uuid[], $2::timestamptz[], $3::timestamptz)', [
            r.revocations.map((x) => x.sessionId),
            r.revocations.map((x) => x.revokedAt),
            r.revocations[r.revocations.length - 1]!.revokedAt,
          ]);
          synced += r.revocations.length;
        }
        if (!r.hasMore || !r.nextCursor) break;
        query = `cursor=${encodeURIComponent(r.nextCursor)}`;
      }
      return { synced };
    } finally {
      client.release();
    }
  }

  // ---------------------------------------------------------------- admin
  async function adminCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!secretKey) throw new Error('Basalt Auth: this operation needs the project secret key (set BASALT_AUTH_SECRET_KEY).');
    const res = await doFetch(`${projectBase}/admin${path}`, {
      method,
      headers: {
        authorization: `Bearer ${secretKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw await toAuthError(res);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }

  const enc = encodeURIComponent;
  const admin: AdminApi = {
    async listUsers(opts = {}) {
      const q = new URLSearchParams();
      if (opts.limit) q.set('limit', String(opts.limit));
      if (opts.cursor) q.set('cursor', opts.cursor);
      if (opts.email) q.set('email', opts.email);
      return adminCall('GET', `/users?${q}`);
    },
    getUser: async (id) => (await adminCall<{ user: User }>('GET', `/users/${enc(id)}`)).user,
    updateUser: async (id, patch) => (await adminCall<{ user: User }>('PATCH', `/users/${enc(id)}`, patch)).user,
    deleteUser: (id) => adminCall('DELETE', `/users/${enc(id)}`),
    revokeSessions: (id) => adminCall('POST', `/users/${enc(id)}/revoke-sessions`, {}),
    listEvents(opts = {}) {
      const q = new URLSearchParams();
      if (opts.userId) q.set('userId', opts.userId);
      if (opts.limit) q.set('limit', String(opts.limit));
      if (opts.before) q.set('before', String(opts.before));
      return adminCall('GET', `/events?${q}`);
    },
  };

  return {
    getUser,
    requireUser,
    verifyAccessToken,
    admin,
    withUserDb,
    beginTransaction,
    dataGrant,
    syncRevocations,
    startRevocationSync(pool, opts = {}) {
      const tick = () => {
        syncRevocations(pool).catch((err) => (opts.onError ?? ((e) => console.error('Basalt Auth: revocation sync failed', e)))(err));
      };
      tick();
      const timer = setInterval(tick, Math.max(1000, opts.intervalMs ?? 10_000));
      (timer as { unref?: () => void }).unref?.();
      return () => clearInterval(timer);
    },
    middleware(opts = {}) {
      return (req, res, next) => {
        requireUser(req, opts).then(
          (user) => {
            req.auth = user;
            next();
          },
          (err: unknown) => {
            if (!(err instanceof BasaltAuthError)) return next(err);
            if (!opts.required && err.code === 'unauthenticated') {
              req.auth = null;
              return next();
            }
            res.statusCode = err.status;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
          },
        );
      };
    },
  };
}

function headerGetter(req: RequestLike): (name: string) => string | undefined {
  const headers = req.headers as HeaderReader | Record<string, string | string[] | undefined>;
  if (typeof (headers as HeaderReader).get === 'function') {
    return (name) => (headers as HeaderReader).get(name) ?? undefined;
  }
  return (name) => {
    const v = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v;
  };
}

// The access cookie, by the same rule as the Data block (data/src/server.ts): __Host-basalt_at can only
// be set by this exact site, so it always wins. The plain name is only for plain-http setups; on https
// it can only have been planted by another site under the same parent domain. Two of the same name
// means one was planted, so refuse rather than guess.
function readAccessCookie(header: string | undefined, proto: string | undefined): string | undefined {
  if (!header) return undefined;
  const found: Record<string, string[]> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    const name = part.slice(0, eq).trim();
    if (eq > 0 && ACCESS_COOKIES.includes(name)) (found[name] ??= []).push(part.slice(eq + 1).trim());
  }
  const https = proto?.split(',')[0]?.trim().toLowerCase() === 'https';
  const pick = found['__Host-basalt_at'] ?? (https ? undefined : found['basalt_at']);
  if (!pick || pick.length > 1 || !pick[0]) return undefined;
  return decodeURIComponent(pick[0]);
}

/** Origin must equal this server's own origin (as seen by the browser) or be explicitly allowed. */
function originAllowed(req: RequestLike, h: (n: string) => string | undefined, extra: string[]): boolean {
  const origin = h('origin');
  if (!origin) {
    // Browsers always send Origin on cross-site writes. Fall back to Sec-Fetch-Site when present.
    const site = h('sec-fetch-site');
    return site === undefined || site === 'same-origin' || site === 'none';
  }
  if (extra.includes(origin)) return true;
  // A cross-site page can't set X-Forwarded-Host without a CORS preflight, so honoring it is safe here.
  const host = h('x-forwarded-host')?.split(',')[0]?.trim() ?? h('host');
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
