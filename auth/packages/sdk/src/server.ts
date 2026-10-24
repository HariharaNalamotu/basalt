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
}

export interface GetUserOptions {
  /** Also confirm with the auth service that the session is still live (one network call). */
  strict?: boolean;
}

export interface RequireUserOptions extends GetUserOptions {
  /** Reject (403) users whose email is not verified. */
  emailVerified?: boolean;
  /** Reject (403) sessions that did not pass a second factor. */
  mfa?: boolean;
}

/** Anything request-shaped: Fetch API Request, Node/Express IncomingMessage, or a headers bag. */
export type RequestLike =
  | Request
  | { headers: Headers | Record<string, string | string[] | undefined>; method?: string; url?: string };

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

  const projectBase = `${authUrl}/v1/projects/${projectId}`;
  const issuer = projectBase;

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

  function toAuthUser(p: JWTPayload): AuthUser | null {
    if (typeof p.sub !== 'string' || typeof p.sid !== 'string' || typeof p.email !== 'string') return null;
    const amr = Array.isArray(p.amr) ? (p.amr as string[]) : [];
    return {
      id: p.sub,
      email: p.email,
      emailVerified: p.email_verified === true,
      sessionId: p.sid,
      amr,
      mfa: amr.includes('otp') || amr.includes('recovery'),
    };
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
      token = readCookie(h('cookie'), ACCESS_COOKIES);
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
    return user;
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
  const headers = req.headers as Headers | Record<string, string | string[] | undefined>;
  if (typeof (headers as Headers).get === 'function') {
    return (name) => (headers as Headers).get(name) ?? undefined;
  }
  return (name) => {
    const v = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : v;
  };
}

function readCookie(header: string | undefined, names: string[]): string | undefined {
  if (!header) return undefined;
  const jar = new Map<string, string>();
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  for (const n of names) {
    const v = jar.get(n);
    if (v) return decodeURIComponent(v);
  }
  return undefined;
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
