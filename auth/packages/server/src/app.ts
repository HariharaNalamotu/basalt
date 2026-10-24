import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';
import type { RequestMeta, ServiceContext } from './context.js';
import {
  type HttpOptions,
  clearSessionCookies,
  clientIp,
  clientMode,
  ipRateLimitKey,
  readAccessToken,
  readJson,
  readRefreshToken,
  sessionResponse,
} from './http.js';
import { AuthError } from './lib/errors.js';
import { AccountService, type Principal } from './services/accounts.js';
import { AdminService, UserPatchSchema } from './services/admin.js';
import { audit } from './services/audit.js';
import { LIMITS } from './services/limits.js';
import { ProjectService, type Project } from './services/projects.js';
import { SessionService } from './services/sessions.js';
import { SigningKeyStore } from './services/signing-keys.js';
import { OriginListSchema, ProjectSettingsPatchSchema } from './settings.js';

export interface Services {
  projects: ProjectService;
  signingKeys: SigningKeyStore;
  sessions: SessionService;
  accounts: AccountService;
  admin: AdminService;
}

export function createServices(ctx: ServiceContext): Services {
  const signingKeys = new SigningKeyStore(ctx);
  const projects = new ProjectService(ctx, signingKeys);
  const sessions = new SessionService(ctx, signingKeys);
  return {
    projects,
    signingKeys,
    sessions,
    accounts: new AccountService(ctx, sessions),
    admin: new AdminService(ctx, sessions),
  };
}

export interface AppOptions extends HttpOptions {
  platformKey: string;
  isProduction: boolean;
  /** Readiness probe (DB/Redis reachable). */
  ready?: () => Promise<boolean>;
}

type Env = { Variables: { project: Project; meta: RequestMeta; owner: string } };

export function createApp(ctx: ServiceContext, services: Services, opts: AppOptions) {
  const { projects, signingKeys, sessions, accounts, admin } = services;
  const app = new Hono<Env>();

  // ------------------------------------------------------------ global middleware

  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    c.header('Cross-Origin-Resource-Policy', 'same-site');
    if (opts.cookieSecure) c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
  });

  app.use(
    '*',
    bodyLimit({
      maxSize: 16 * 1024,
      onError: () => {
        throw new AuthError('payload_too_large', 'Request body too large.');
      },
    }),
  );

  app.onError((err, c) => {
    if (err instanceof AuthError) {
      if (err.extra.retryAfterSeconds) c.header('Retry-After', String(err.extra.retryAfterSeconds));
      return c.json({ error: { code: err.code, message: err.message, ...(err.extra.details ? { details: err.extra.details } : {}) } }, err.status);
    }
    if (err instanceof z.ZodError) {
      return c.json(
        { error: { code: 'invalid_request', message: 'Invalid request.', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } },
        400,
      );
    }
    ctx.log.error('unhandled_error', { err, path: c.req.path, method: c.req.method });
    return c.json({ error: { code: 'internal_error', message: 'Something went wrong.' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404));

  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/readyz', async (c) => {
    const ok = opts.ready ? await opts.ready().catch(() => false) : true;
    return c.json({ ok }, ok ? 200 : 503);
  });

  // ------------------------------------------------------------ platform control plane

  const platformKeyHash = createHash('sha256').update(opts.platformKey).digest();
  const platform = new Hono<Env>();
  platform.use('*', async (c, next) => {
    const presented = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const hash = createHash('sha256').update(presented).digest();
    if (!presented || !timingSafeEqual(hash, platformKeyHash)) {
      throw new AuthError('unauthenticated', 'Invalid platform key.');
    }
    // The platform names the workspace it is acting for; every project operation is scoped to it.
    const owner = c.req.header('x-basalt-owner') ?? '';
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(owner)) {
      throw new AuthError('invalid_request', 'X-Basalt-Owner header is required.');
    }
    c.set('owner', owner);
    const ip = clientIp(c, opts);
    c.set('meta', { ip, ipKey: ipRateLimitKey(ip), userAgent: 'basalt-platform' });
    await next();
  });
  const owned = (c: Context<Env>) => projects.getOwned(c.get('owner'), c.req.param('id') ?? '');

  const CreateProjectSchema = z
    .object({
      name: z.string().min(1).max(100),
      allowedOrigins: OriginListSchema.default([]),
      settings: ProjectSettingsPatchSchema.optional(),
    })
    .strict();
  const UpdateProjectSchema = z
    .object({ name: z.string().min(1).max(100), allowedOrigins: OriginListSchema, settings: ProjectSettingsPatchSchema })
    .partial()
    .strict();

  platform.get('/projects', async (c) => {
    const list = await projects.listOwned(c.get('owner'));
    return c.json({ projects: list.map((p) => publicProject(p, ctx)) });
  });
  platform.post('/projects', async (c) => {
    const input = CreateProjectSchema.parse(await readJson(c));
    const { project, secretKey } = await projects.create(c.get('owner'), input);
    return c.json({ project: publicProject(project, ctx), secretKey }, 201);
  });
  platform.get('/projects/:id', async (c) => c.json({ project: publicProject(await owned(c), ctx) }));
  platform.patch('/projects/:id', async (c) => {
    const input = UpdateProjectSchema.parse(await readJson(c));
    const project = await owned(c);
    return c.json({ project: publicProject(await projects.update(project.id, input), ctx) });
  });
  platform.delete('/projects/:id', async (c) => {
    await projects.delete((await owned(c)).id);
    return c.body(null, 204);
  });
  platform.post('/projects/:id/rotate-secret-key', async (c) => c.json(await projects.rotateSecretKey((await owned(c)).id)));
  platform.post('/projects/:id/rotate-signing-key', async (c) => c.json(await signingKeys.rotate((await owned(c)).id)));

  // User administration on behalf of the workspace owner (used by the MCP tools / dashboard).
  platform.get('/projects/:id/users', async (c) =>
    c.json(
      await admin.listUsers((await owned(c)).id, {
        limit: Number(c.req.query('limit') ?? 50) || 50,
        cursor: c.req.query('cursor'),
        email: c.req.query('email'),
      }),
    ),
  );
  platform.get('/projects/:id/users/:userId', async (c) =>
    c.json({ user: await admin.getUser((await owned(c)).id, c.req.param('userId')) }),
  );
  platform.patch('/projects/:id/users/:userId', async (c) => {
    const patch = UserPatchSchema.parse(await readJson(c));
    return c.json({ user: await admin.updateUser((await owned(c)).id, c.req.param('userId'), patch, c.get('meta')) });
  });
  platform.delete('/projects/:id/users/:userId', async (c) => {
    await admin.deleteUser((await owned(c)).id, c.req.param('userId'), c.get('meta'));
    return c.body(null, 204);
  });
  platform.post('/projects/:id/users/:userId/revoke-sessions', async (c) =>
    c.json(await admin.revokeSessions((await owned(c)).id, c.req.param('userId'), c.get('meta'))),
  );
  platform.get('/projects/:id/events', async (c) =>
    c.json(
      await admin.listEvents((await owned(c)).id, {
        userId: c.req.query('userId'),
        limit: Number(c.req.query('limit') ?? 50) || 50,
        before: c.req.query('before') ? Number(c.req.query('before')) : undefined,
      }),
    ),
  );
  app.route('/v1/platform', platform);

  // ------------------------------------------------------------ per-project API

  const p = new Hono<Env>();

  p.use('*', async (c, next) => {
    const project = await projects.find(c.req.param('projectId') ?? '');
    if (!project) throw new AuthError('not_found', 'Project not found.');
    c.set('project', project);
    const ip = clientIp(c, opts);
    c.set('meta', { ip, ipKey: ipRateLimitKey(ip), userAgent: c.req.header('user-agent') });

    // CORS: only exact allow-listed origins, always with credentials, never "*".
    const origin = c.req.header('origin');
    const allowed = origin !== undefined && project.allowedOrigins.includes(origin);
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403);
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
        'Access-Control-Allow-Headers': 'content-type, authorization',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    await next();
    c.header('Vary', 'Origin');
    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
    }
  });

  const verifierCache = new Map<string, { jwks: ReturnType<typeof createLocalJWKSet>; at: number }>();
  async function verifyAccessToken(project: Project, token: string) {
    let v = verifierCache.get(project.id);
    if (!v || Date.now() - v.at > 30_000) {
      v = { jwks: createLocalJWKSet(await signingKeys.publicJwks(project.id)), at: Date.now() };
      verifierCache.set(project.id, v);
    }
    try {
      const { payload } = await jwtVerify(token, v.jwks, {
        issuer: signingKeys.issuer(project.id),
        audience: project.id,
        algorithms: ['EdDSA'],
        typ: 'at+jwt',
        currentDate: ctx.now(),
      });
      return payload as { sub: string; sid: string; exp: number };
    } catch {
      return null;
    }
  }

  /** Verified JWT *and* a live session row: revocation takes effect immediately on these endpoints. */
  async function requirePrincipal(c: Context<Env>): Promise<Principal & { accessTokenExpiresAt: string }> {
    const project = c.get('project');
    const token = readAccessToken(c, project, opts);
    const claims = token ? await verifyAccessToken(project, token) : null;
    if (!claims) throw new AuthError('unauthenticated', 'Sign in required.');
    const session = await sessions.getActive(project.id, claims.sid);
    if (!session || session.user_id !== claims.sub) throw new AuthError('unauthenticated', 'Session expired. Please sign in again.');
    return { project, userId: claims.sub, sessionId: claims.sid, accessTokenExpiresAt: new Date(claims.exp * 1000).toISOString() };
  }

  p.get('/.well-known/jwks.json', async (c) => {
    c.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=60');
    c.header('Access-Control-Allow-Origin', '*');
    return c.json(await signingKeys.publicJwks(c.get('project').id));
  });

  p.get('/config', (c) => {
    const { settings, name } = c.get('project');
    return c.json({
      appName: settings.appName ?? name,
      requireEmailVerification: settings.requireEmailVerification,
      passwordMinLength: settings.passwordMinLength,
      allowTotp: settings.allowTotp,
    });
  });

  p.post('/signup', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const result = await accounts.signUp(project, await readJson(c), c.get('meta'));
    if (result.status === 'verification_required') return c.json(result, 202);
    return c.json(sessionResponse(c, project, mode, opts, result.user, result.tokens), 201);
  });

  p.post('/signup/verify', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const result = await accounts.verifySignup(project, await readJson(c), c.get('meta'));
    return c.json(sessionResponse(c, project, mode, opts, result.user, result.tokens), 201);
  });

  p.post('/signup/resend', async (c) => {
    const project = c.get('project');
    clientMode(c, project);
    await accounts.resendSignupCode(project, await readJson(c), c.get('meta'));
    return c.json({ status: 'sent' }, 202);
  });

  p.post('/signin', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const result = await accounts.signIn(project, await readJson(c), c.get('meta'));
    if (result.status === 'mfa_required') {
      return c.json({ status: result.status, mfaToken: result.mfaToken, mfaTokenExpiresAt: result.mfaTokenExpiresAt.toISOString() });
    }
    return c.json(sessionResponse(c, project, mode, opts, result.user, result.tokens));
  });

  p.post('/signin/mfa', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const result = await accounts.completeMfa(project, await readJson(c), c.get('meta'));
    return c.json(sessionResponse(c, project, mode, opts, result.user, result.tokens));
  });

  p.post('/email/verify', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const result = await accounts.verifyEmail(project, await readJson(c), c.get('meta'));
    if (result.status === 'email_verified') return c.json(result);
    return c.json(sessionResponse(c, project, mode, opts, result.user, result.tokens));
  });

  p.post('/email/verification/send', async (c) => {
    await accounts.sendEmailVerification(await requirePrincipal(c));
    return c.json({ status: 'sent' }, 202);
  });

  p.post('/password/reset/request', async (c) => {
    const project = c.get('project');
    clientMode(c, project);
    await accounts.requestPasswordReset(project, await readJson(c), c.get('meta'));
    return c.json({ status: 'sent' }, 202);
  });

  p.post('/password/reset/confirm', async (c) => {
    const project = c.get('project');
    clientMode(c, project);
    await accounts.resetPassword(project, await readJson(c), c.get('meta'));
    return c.json({ status: 'password_reset' });
  });

  p.post('/session/refresh', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const meta = c.get('meta');
    const body = await readJson(c);
    const rl = await ctx.rateLimiter.hit(`rf:ip:${project.id}:${meta.ipKey}`, LIMITS.refreshPerIp);
    if (!rl.allowed) throw new AuthError('rate_limited', 'Too many requests.', { retryAfterSeconds: rl.retryAfterSeconds });
    const token = readRefreshToken(c, mode, body, opts);
    try {
      const { user, tokens } = await sessions.refresh(project, token, meta);
      return c.json(sessionResponse(c, project, mode, opts, user, tokens));
    } catch (err) {
      if (mode === 'browser' && err instanceof AuthError && err.code === 'invalid_token') clearSessionCookies(c, project, opts);
      throw err;
    }
  });

  p.post('/session/signout', async (c) => {
    const project = c.get('project');
    const mode = clientMode(c, project);
    const meta = c.get('meta');
    const body = await readJson(c);
    // Sign-out is idempotent and always clears cookies, even if the session is already gone.
    const refresh = readRefreshToken(c, mode, body, opts);
    let userId = refresh ? await sessions.revokeByRefreshToken(project, refresh) : null;
    if (!userId) {
      const principal = await requirePrincipal(c).catch(() => null);
      if (principal && (await sessions.revoke(project.id, principal.userId, principal.sessionId, 'signed_out'))) {
        userId = principal.userId;
      }
    }
    if (userId) await audit(ctx.db, { projectId: project.id, userId, type: 'user.signed_out', meta });
    if (mode === 'browser') clearSessionCookies(c, project, opts);
    return c.json({ status: 'signed_out' });
  });

  p.get('/session', async (c) => {
    const principal = await requirePrincipal(c);
    return c.json({
      user: await accounts.getUser(principal),
      session: { id: principal.sessionId, accessTokenExpiresAt: principal.accessTokenExpiresAt },
    });
  });

  p.get('/sessions', async (c) => {
    const principal = await requirePrincipal(c);
    const list = await sessions.listActive(principal.project.id, principal.userId);
    return c.json({ sessions: list.map((s) => ({ ...s, current: s.id === principal.sessionId })) });
  });

  p.delete('/sessions/:sessionId', async (c) => {
    const principal = await requirePrincipal(c);
    const id = c.req.param('sessionId');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new AuthError('not_found', 'Session not found.');
    const ok = await sessions.revoke(principal.project.id, principal.userId, id, 'revoked_by_user');
    if (!ok) throw new AuthError('not_found', 'Session not found.');
    await audit(ctx.db, { projectId: principal.project.id, userId: principal.userId, type: 'session.revoked', meta: c.get('meta'), data: { sessionId: id } });
    return c.json({ status: 'revoked' });
  });

  p.post('/sessions/revoke-others', async (c) => {
    const principal = await requirePrincipal(c);
    const count = await sessions.revokeAllForUser(ctx.db, principal.project.id, principal.userId, 'revoked_by_user', principal.sessionId);
    await audit(ctx.db, { projectId: principal.project.id, userId: principal.userId, type: 'session.revoked_all', meta: c.get('meta'), data: { count } });
    return c.json({ revoked: count });
  });

  p.post('/password/change', async (c) => {
    const principal = await requirePrincipal(c);
    await accounts.changePassword(principal, await readJson(c), c.get('meta'));
    return c.json({ status: 'password_changed' });
  });

  p.post('/mfa/totp/enroll', async (c) => c.json(await accounts.beginTotpEnrollment(await requirePrincipal(c))));
  p.post('/mfa/totp/confirm', async (c) => {
    const principal = await requirePrincipal(c);
    return c.json(await accounts.confirmTotpEnrollment(principal, await readJson(c), c.get('meta')));
  });
  p.post('/mfa/totp/disable', async (c) => {
    const principal = await requirePrincipal(c);
    await accounts.disableTotp(principal, await readJson(c), c.get('meta'));
    return c.json({ status: 'disabled' });
  });
  p.post('/mfa/recovery-codes', async (c) => {
    const principal = await requirePrincipal(c);
    return c.json(await accounts.regenerateRecoveryCodes(principal, await readJson(c)));
  });

  p.post('/account/delete', async (c) => {
    const principal = await requirePrincipal(c);
    await accounts.deleteAccount(principal, await readJson(c), c.get('meta'));
    if (c.req.header('origin')) clearSessionCookies(c, principal.project, opts);
    return c.json({ status: 'deleted' });
  });

  // ------------------------------------------------------------ server-to-server (project secret key)

  const a = new Hono<Env>();
  a.use('*', async (c, next) => {
    // Secret keys must never be used from a browser. Reject any request that looks like one.
    if (c.req.header('origin') !== undefined) {
      throw new AuthError('forbidden', 'The secret key API cannot be called from a browser. Call it from your backend.');
    }
    const key = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!(await projects.verifySecretKey(c.get('project').id, key))) {
      throw new AuthError('unauthenticated', 'Invalid project secret key.');
    }
    await next();
  });

  a.get('/users', async (c) =>
    c.json(
      await admin.listUsers(c.get('project').id, {
        limit: Number(c.req.query('limit') ?? 50) || 50,
        cursor: c.req.query('cursor'),
        email: c.req.query('email'),
      }),
    ),
  );
  a.get('/users/:userId', async (c) => c.json({ user: await admin.getUser(c.get('project').id, c.req.param('userId')) }));
  a.patch('/users/:userId', async (c) => {
    const patch = UserPatchSchema.parse(await readJson(c));
    return c.json({ user: await admin.updateUser(c.get('project').id, c.req.param('userId'), patch, c.get('meta')) });
  });
  a.delete('/users/:userId', async (c) => {
    await admin.deleteUser(c.get('project').id, c.req.param('userId'), c.get('meta'));
    return c.body(null, 204);
  });
  a.post('/users/:userId/revoke-sessions', async (c) =>
    c.json(await admin.revokeSessions(c.get('project').id, c.req.param('userId'), c.get('meta'))),
  );
  a.get('/events', async (c) =>
    c.json(
      await admin.listEvents(c.get('project').id, {
        userId: c.req.query('userId'),
        limit: Number(c.req.query('limit') ?? 50) || 50,
        before: c.req.query('before') ? Number(c.req.query('before')) : undefined,
      }),
    ),
  );
  /** Strict check for high-stakes actions: is this access token valid AND its session still live? */
  a.post('/sessions/verify', async (c) => {
    const project = c.get('project');
    const body = await readJson(c);
    const token = typeof body.accessToken === 'string' ? body.accessToken : '';
    const claims = token ? await verifyAccessToken(project, token) : null;
    const session = claims ? await sessions.getActive(project.id, claims.sid) : null;
    if (!claims || !session || session.user_id !== claims.sub) return c.json({ active: false });
    return c.json({ active: true, user: await admin.getUser(project.id, claims.sub), session: { id: session.id, amr: session.amr } });
  });

  p.route('/admin', a);
  app.route('/v1/projects/:projectId', p);
  return app;
}

function publicProject(project: Project, ctx: ServiceContext) {
  return {
    id: project.id,
    name: project.name,
    allowedOrigins: project.allowedOrigins,
    settings: project.settings,
    secretKeyHint: project.secretKeyHint,
    issuer: `${ctx.publicUrl}/v1/projects/${project.id}`,
    jwksUrl: `${ctx.publicUrl}/v1/projects/${project.id}/.well-known/jwks.json`,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}
