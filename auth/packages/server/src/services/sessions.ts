import { randomBytes } from 'node:crypto';
import type { RequestMeta, ServiceContext } from '../context.js';
import type { Db } from '../db/db.js';
import { constantTimeEqual, hmacSha256, uuidv7 } from '../lib/crypto.js';
import { AuthError } from '../lib/errors.js';
import { audit } from './audit.js';
import type { Project } from './projects.js';
import type { DataGrantService } from './data-grants.js';
import type { SigningKeyStore } from './signing-keys.js';
import { type UserRow, toPublicUser } from './users.js';

/** Concurrent refreshes (two tabs, a retry) within this window get 409 instead of tripping theft detection. */
const REFRESH_GRACE_MS = 10_000;
const REFRESH_PREFIX = 'bslt_rt_';
const TOKEN_RE = /^bslt_rt_([0-9a-f]{32})_(\d{1,9})_([A-Za-z0-9_-]{43})$/;

export interface SessionRow {
  id: string;
  project_id: string;
  user_id: string;
  amr: string[];
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  authenticated_at: Date;
  last_active_at: Date;
  idle_expires_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  refresh_secret_enc: Buffer;
  refresh_generation: number;
  refresh_rotated_at: Date | null;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

const uuidToHex = (id: string) => id.replace(/-/g, '');
const hexToUuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;

export class SessionService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly signingKeys: SigningKeyStore,
    private readonly dataGrants: DataGrantService,
  ) {}

  /**
   * The single place access tokens are minted: every token carries a data grant bound to the same
   * session and expiry, and the time the user last authenticated.
   */
  async issueAccess(
    db: Db,
    project: Project,
    user: UserRow,
    session: { id: string; amr: string[]; authenticated_at: Date },
  ): Promise<{ token: string; expiresAt: Date }> {
    return this.signingKeys.signAccessToken(
      project.id,
      async (expSec) => ({
        sub: user.id,
        sid: session.id,
        email: user.email,
        email_verified: user.email_verified_at !== null,
        amr: session.amr,
        auth_time: Math.floor(session.authenticated_at.getTime() / 1000),
        bdg: await this.dataGrants.mint(project.id, user.id, session.id, expSec, db),
      }),
      project.settings.accessTokenTtlSeconds,
      db,
    );
  }

  /** Step-up: records a fresh proof of identity on the session and issues a token reflecting it. */
  async markAuthenticated(tx: Db, project: Project, user: UserRow, sessionId: string, amr: string[]) {
    const { rows } = await tx.query<SessionRow>(
      `UPDATE auth_sessions SET authenticated_at = $3, amr = $4 WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING *`,
      [sessionId, project.id, this.ctx.now(), amr],
    );
    if (!rows[0]) throw new AuthError('unauthenticated', 'Session expired. Please sign in again.');
    return this.issueAccess(tx, project, user, rows[0]);
  }

  async create(
    tx: Db,
    project: Project,
    user: UserRow,
    amr: string[],
    meta: RequestMeta,
  ): Promise<IssuedSession> {
    const now = this.ctx.now();
    const s = project.settings;
    const id = uuidv7();
    const secret = randomBytes(32);
    const expiresAt = new Date(now.getTime() + s.sessionMaxLifetimeSeconds * 1000);
    const idleExpiresAt = new Date(Math.min(expiresAt.getTime(), now.getTime() + s.sessionIdleTimeoutSeconds * 1000));
    await tx.query(
      `INSERT INTO auth_sessions
         (id, project_id, user_id, amr, ip, user_agent, created_at, authenticated_at, last_active_at, idle_expires_at, expires_at, refresh_secret_enc)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, $8, $9, $10)`,
      [
        id,
        project.id,
        user.id,
        amr,
        meta.ip,
        meta.userAgent?.slice(0, 512) ?? null,
        now,
        idleExpiresAt,
        expiresAt,
        this.ctx.keyRing.encrypt(secret, `refresh:${id}`),
      ],
    );
    await tx.query('UPDATE auth_users SET last_sign_in_at = $2 WHERE id = $1', [user.id, now]);
    const access = await this.issueAccess(tx, project, user, { id, amr, authenticated_at: now });
    return {
      sessionId: id,
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: this.formatRefreshToken(id, 0, secret),
      refreshTokenExpiresAt: idleExpiresAt,
    };
  }

  async refresh(project: Project, presented: string, meta: RequestMeta) {
    const parsed = TOKEN_RE.exec(presented);
    if (!parsed) throw new AuthError('invalid_token', 'Session expired. Please sign in again.');
    const sessionId = hexToUuid(parsed[1]!);
    const generation = Number(parsed[2]);
    const now = this.ctx.now();

    const outcome = await this.ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<SessionRow>(
        'SELECT * FROM auth_sessions WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [sessionId, project.id],
      );
      const session = rows[0];
      if (!session || session.revoked_at) return { kind: 'invalid' as const };

      const secret = this.ctx.keyRing.decrypt(session.refresh_secret_enc, `refresh:${session.id}`);
      const expected = this.formatRefreshToken(session.id, generation, secret);
      // Forged / corrupted token: reject without touching the session (no DoS by guessing ids).
      if (!constantTimeEqual(Buffer.from(expected), Buffer.from(presented))) return { kind: 'invalid' as const };

      if (generation !== session.refresh_generation) {
        const rotatedAt = session.refresh_rotated_at?.getTime() ?? 0;
        if (generation === session.refresh_generation - 1 && now.getTime() - rotatedAt <= REFRESH_GRACE_MS) {
          return { kind: 'in_progress' as const };
        }
        // A genuine but superseded token was replayed: someone else holds a copy. Kill the session.
        await this.revokeById(tx, session.id, 'refresh_token_reuse');
        await audit(tx, {
          projectId: project.id,
          userId: session.user_id,
          type: 'session.refresh_token_reuse',
          meta,
          data: { sessionId: session.id, presentedGeneration: generation, currentGeneration: session.refresh_generation },
        });
        return { kind: 'reuse' as const };
      }

      if (now >= session.expires_at || now >= session.idle_expires_at) {
        await this.revokeById(tx, session.id, 'expired');
        return { kind: 'invalid' as const };
      }

      const userRes = await tx.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 AND project_id = $2', [
        session.user_id,
        project.id,
      ]);
      const user = userRes.rows[0];
      if (!user || user.disabled_at) {
        await this.revokeById(tx, session.id, 'user_disabled');
        return { kind: 'invalid' as const };
      }

      const nextGen = session.refresh_generation + 1;
      const idleExpiresAt = new Date(
        Math.min(session.expires_at.getTime(), now.getTime() + project.settings.sessionIdleTimeoutSeconds * 1000),
      );
      await tx.query(
        `UPDATE auth_sessions SET refresh_generation = $2, refresh_rotated_at = $3, last_active_at = $3,
           idle_expires_at = $4, ip = $5, user_agent = $6 WHERE id = $1`,
        [session.id, nextGen, now, idleExpiresAt, meta.ip, meta.userAgent?.slice(0, 512) ?? null],
      );
      return { kind: 'ok' as const, session, user, secret, nextGen, idleExpiresAt };
    });

    if (outcome.kind === 'in_progress') {
      throw new AuthError('refresh_in_progress', 'A refresh is already in progress. Retry with the latest token.');
    }
    if (outcome.kind !== 'ok') throw new AuthError('invalid_token', 'Session expired. Please sign in again.');

    const { session, user, secret, nextGen, idleExpiresAt } = outcome;
    const access = await this.issueAccess(this.ctx.db, project, user, session);
    return {
      user: toPublicUser(user),
      tokens: {
        sessionId: session.id,
        accessToken: access.token,
        accessTokenExpiresAt: access.expiresAt,
        refreshToken: this.formatRefreshToken(session.id, nextGen, secret),
        refreshTokenExpiresAt: idleExpiresAt,
      } satisfies IssuedSession,
    };
  }

  /** Returns the session if it is live right now (not revoked, not expired). */
  async getActive(projectId: string, sessionId: string): Promise<SessionRow | null> {
    const { rows } = await this.ctx.db.query<SessionRow>(
      `SELECT * FROM auth_sessions WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL
         AND expires_at > $3 AND idle_expires_at > $3`,
      [sessionId, projectId, this.ctx.now()],
    );
    return rows[0] ?? null;
  }

  async listActive(projectId: string, userId: string) {
    const { rows } = await this.ctx.db.query<SessionRow>(
      `SELECT * FROM auth_sessions WHERE project_id = $1 AND user_id = $2 AND revoked_at IS NULL
         AND expires_at > $3 AND idle_expires_at > $3 ORDER BY last_active_at DESC LIMIT 100`,
      [projectId, userId, this.ctx.now()],
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.created_at.toISOString(),
      lastActiveAt: r.last_active_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      ip: r.ip,
      userAgent: r.user_agent,
      amr: r.amr,
    }));
  }

  /**
   * Sign-out by refresh token. Any genuine token from the session (current or superseded) proves
   * the caller held it, so it is enough to end the session. Returns the user id, or null.
   */
  async revokeByRefreshToken(project: Project, presented: string): Promise<string | null> {
    const parsed = TOKEN_RE.exec(presented);
    if (!parsed) return null;
    const session = (
      await this.ctx.db.query<SessionRow>('SELECT * FROM auth_sessions WHERE id = $1 AND project_id = $2', [
        hexToUuid(parsed[1]!),
        project.id,
      ])
    ).rows[0];
    if (!session) return null;
    const secret = this.ctx.keyRing.decrypt(session.refresh_secret_enc, `refresh:${session.id}`);
    const expected = this.formatRefreshToken(session.id, Number(parsed[2]), secret);
    if (!constantTimeEqual(Buffer.from(expected), Buffer.from(presented))) return null;
    await this.revokeById(this.ctx.db, session.id, 'signed_out');
    return session.user_id;
  }

  async revoke(projectId: string, userId: string, sessionId: string, reason: string) {
    const { rowCount } = await this.ctx.db.query(
      `UPDATE auth_sessions SET revoked_at = $4, revoke_reason = $5
       WHERE id = $1 AND project_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
      [sessionId, projectId, userId, this.ctx.now(), reason],
    );
    return rowCount > 0;
  }

  async revokeAllForUser(db: Db, projectId: string, userId: string, reason: string, exceptSessionId?: string) {
    const { rowCount } = await db.query(
      `UPDATE auth_sessions SET revoked_at = $3, revoke_reason = $4
       WHERE project_id = $1 AND user_id = $2 AND revoked_at IS NULL AND ($5::uuid IS NULL OR id <> $5::uuid)`,
      [projectId, userId, this.ctx.now(), reason, exceptSessionId ?? null],
    );
    return rowCount;
  }

  private async revokeById(tx: Db, sessionId: string, reason: string) {
    await tx.query('UPDATE auth_sessions SET revoked_at = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL', [
      sessionId,
      this.ctx.now(),
      reason,
    ]);
  }

  private formatRefreshToken(sessionId: string, generation: number, secret: Buffer) {
    const mac = hmacSha256(secret, `${sessionId}:${generation}`).toString('base64url');
    return `${REFRESH_PREFIX}${uuidToHex(sessionId)}_${generation}_${mac}`;
  }
}
