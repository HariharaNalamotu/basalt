import { isIPv4, isIPv6 } from 'node:net';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { AuthError } from './lib/errors.js';
import type { Project } from './services/projects.js';
import type { IssuedSession } from './services/sessions.js';
import type { PublicUser } from './services/users.js';

export interface HttpOptions {
  trustProxyHops: number;
  cookieSecure: boolean;
  /** Overrides socket address lookup (tests, non-node runtimes). */
  remoteAddress?: (c: Context) => string | undefined;
}

export function cookieNames(secure: boolean) {
  // __Host- forces Secure, Path=/ and no Domain: the cookie can't be set or shadowed by subdomains.
  return secure
    ? { access: '__Host-basalt_at', refresh: '__Secure-basalt_rt' }
    : { access: 'basalt_at', refresh: 'basalt_rt' };
}

/** Normalizes IPv4-mapped IPv6 (::ffff:1.2.3.4) to plain IPv4. */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

/**
 * Rate-limit key for an address. A single IPv6 subscriber typically controls a whole /64, so
 * limiting per full IPv6 address would be trivially bypassed by rotating addresses.
 */
export function ipRateLimitKey(ip: string): string {
  if (isIPv4(ip)) return ip;
  if (!isIPv6(ip)) return ip;
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => g.toLowerCase().padStart(4, '0')).join(':')}::/64`;
}

export function clientIp(c: Context, opts: HttpOptions): string {
  return normalizeIp(rawClientIp(c, opts));
}

function rawClientIp(c: Context, opts: HttpOptions): string {
  if (opts.trustProxyHops > 0) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
      // The rightmost N entries were appended by our own proxies; the one before them is the client.
      const candidate = hops[Math.max(0, hops.length - opts.trustProxyHops)];
      if (candidate && isIp(candidate)) return candidate;
    }
  }
  const direct = opts.remoteAddress ? opts.remoteAddress(c) : safeConnInfo(c);
  return direct ?? '0.0.0.0';
}

function safeConnInfo(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function isIp(s: string) {
  return isIPv4(s) || isIPv6(s);
}

/**
 * Browsers send Origin on every non-GET request, so its presence identifies a browser caller.
 * - browser: Origin must be on the project's allow-list; credentials travel only in HttpOnly cookies.
 * - native: no Origin; tokens travel in JSON bodies / Authorization headers and cookies are ignored.
 */
export type ClientMode = 'browser' | 'native';

export function clientMode(c: Context, project: Project): ClientMode {
  const origin = c.req.header('origin');
  if (origin !== undefined) {
    if (!project.allowedOrigins.includes(origin)) {
      throw new AuthError(
        'origin_not_allowed',
        `Origin ${origin.slice(0, 100)} is not allowed for this project. Add it to the project's allowed origins.`,
      );
    }
    return 'browser';
  }
  if (!project.settings.allowBearerTokens) {
    throw new AuthError('forbidden', 'This project only accepts browser (cookie) sessions.');
  }
  return 'native';
}

/** Path the browser uses to reach this project's endpoints (the platform edge may mount us elsewhere). */
function mountPrefix(c: Context, project: Project, opts: HttpOptions) {
  if (opts.trustProxyHops > 0) {
    const p = c.req.header('x-forwarded-prefix');
    if (p && /^\/[A-Za-z0-9/_-]{0,200}$/.test(p)) return p.replace(/\/+$/, '');
  }
  return `/v1/projects/${project.id}`;
}

export function sessionResponse(
  c: Context,
  project: Project,
  mode: ClientMode,
  opts: HttpOptions,
  user: PublicUser,
  tokens: IssuedSession,
) {
  const base = {
    status: 'signed_in' as const,
    user,
    session: { id: tokens.sessionId, accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString() },
  };
  if (mode === 'native') {
    return {
      ...base,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    };
  }
  const names = cookieNames(opts.cookieSecure);
  const now = Date.now();
  setCookie(c, names.access, tokens.accessToken, {
    httpOnly: true,
    secure: opts.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(1, Math.floor((tokens.accessTokenExpiresAt.getTime() - now) / 1000)),
  });
  setCookie(c, names.refresh, tokens.refreshToken, {
    httpOnly: true,
    secure: opts.cookieSecure,
    sameSite: 'Strict',
    path: `${mountPrefix(c, project, opts)}/session`,
    maxAge: Math.max(1, Math.floor((tokens.refreshTokenExpiresAt.getTime() - now) / 1000)),
  });
  return base;
}

/** Response for a new access token on an existing session (step-up); the refresh cookie is untouched. */
export function accessResponse(
  c: Context,
  mode: ClientMode,
  opts: HttpOptions,
  user: PublicUser,
  sessionId: string,
  access: { token: string; expiresAt: Date },
) {
  const base = {
    status: 'signed_in' as const,
    user,
    session: { id: sessionId, accessTokenExpiresAt: access.expiresAt.toISOString() },
  };
  if (mode === 'native') return { ...base, accessToken: access.token };
  setCookie(c, cookieNames(opts.cookieSecure).access, access.token, {
    httpOnly: true,
    secure: opts.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.max(1, Math.floor((access.expiresAt.getTime() - Date.now()) / 1000)),
  });
  return base;
}

export function clearSessionCookies(c: Context, project: Project, opts: HttpOptions) {
  const names = cookieNames(opts.cookieSecure);
  deleteCookie(c, names.access, { path: '/', secure: opts.cookieSecure });
  deleteCookie(c, names.refresh, { path: `${mountPrefix(c, project, opts)}/session`, secure: opts.cookieSecure });
}

export function readRefreshToken(c: Context, mode: ClientMode, body: Record<string, unknown>, opts: HttpOptions) {
  if (mode === 'browser') return getCookie(c, cookieNames(opts.cookieSecure).refresh) ?? '';
  return typeof body.refreshToken === 'string' ? body.refreshToken : '';
}

/**
 * Access token for protected endpoints. Authorization header first; the cookie is only read for
 * browser requests (Origin already validated) or safe GETs, so cookies can never be used for CSRF.
 */
export function readAccessToken(c: Context, project: Project, opts: HttpOptions): string | null {
  const authz = c.req.header('authorization');
  if (authz?.startsWith('Bearer ')) return authz.slice(7).trim() || null;
  const isSafe = c.req.method === 'GET' || c.req.method === 'HEAD';
  if (!isSafe) clientMode(c, project); // throws unless Origin is present and allowed
  else {
    const origin = c.req.header('origin');
    if (origin !== undefined && !project.allowedOrigins.includes(origin)) return null;
  }
  return getCookie(c, cookieNames(opts.cookieSecure).access) ?? null;
}

export async function readJson(c: Context): Promise<Record<string, unknown>> {
  if (c.req.method === 'GET' || c.req.method === 'HEAD') return {};
  const ct = c.req.header('content-type') ?? '';
  // Requiring JSON forces a CORS preflight for cross-origin requests: plain HTML forms can't send it.
  if (!ct.toLowerCase().startsWith('application/json')) {
    throw new AuthError('invalid_request', 'Content-Type must be application/json.');
  }
  try {
    const body = await c.req.json();
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new AuthError('invalid_request', 'Request body must be a JSON object.');
  }
}
