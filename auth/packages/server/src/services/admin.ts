import { z } from 'zod';
import type { RequestMeta, ServiceContext } from '../context.js';
import { AuthError } from '../lib/errors.js';
import { audit } from './audit.js';
import type { SessionService } from './sessions.js';
import { type UserRow, toPublicUser } from './users.js';

const MAX_METADATA_BYTES = 16 * 1024;

export const UserPatchSchema = z
  .object({
    /** App-controlled data (roles, plan, profile). Replaces the stored object. Max 16 KB JSON. */
    metadata: z.record(z.string(), z.unknown()).optional(),
    disabled: z.boolean().optional(),
  })
  .strict();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Operations available to the app's backend using its project secret key. */
export class AdminService {
  constructor(
    private readonly ctx: ServiceContext,
    private readonly sessions: SessionService,
  ) {}

  async listUsers(projectId: string, opts: { limit?: number; cursor?: string; email?: string }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [projectId, limit + 1];
    let where = 'project_id = $1';
    if (opts.email) {
      params.push(opts.email.trim().normalize('NFKC').toLowerCase());
      where += ` AND email_normalized = $${params.length}`;
    }
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      params.push(c.createdAt, c.id);
      where += ` AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
    }
    const { rows } = await this.ctx.db.query<UserRow>(
      `SELECT * FROM auth_users WHERE ${where} ORDER BY created_at, id LIMIT $2`,
      params,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      users: page.map(toPublicUser),
      nextCursor: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null,
    };
  }

  async getUser(projectId: string, userId: string) {
    return toPublicUser(await this.load(projectId, userId));
  }

  async updateUser(projectId: string, userId: string, patch: z.infer<typeof UserPatchSchema>, meta: RequestMeta) {
    const user = await this.load(projectId, userId);
    if (patch.metadata && Buffer.byteLength(JSON.stringify(patch.metadata)) > MAX_METADATA_BYTES) {
      throw new AuthError('payload_too_large', 'User metadata must be at most 16 KB of JSON.');
    }
    return this.ctx.db.transaction(async (tx) => {
      const now = this.ctx.now();
      const { rows } = await tx.query<UserRow>(
        `UPDATE auth_users SET
           metadata = COALESCE($3::jsonb, metadata),
           disabled_at = CASE WHEN $4::boolean IS NULL THEN disabled_at WHEN $4 THEN COALESCE(disabled_at, $5) ELSE NULL END,
           updated_at = $5
         WHERE id = $1 AND project_id = $2 RETURNING *`,
        [userId, projectId, patch.metadata ? JSON.stringify(patch.metadata) : null, patch.disabled ?? null, now],
      );
      if (patch.metadata) await audit(tx, { projectId, userId, type: 'user.metadata_updated', meta });
      if (patch.disabled === true && !user.disabled_at) {
        await this.sessions.revokeAllForUser(tx, projectId, userId, 'user_disabled');
        await audit(tx, { projectId, userId, type: 'user.disabled', meta });
      }
      if (patch.disabled === false && user.disabled_at) await audit(tx, { projectId, userId, type: 'user.enabled', meta });
      return toPublicUser(rows[0]!);
    });
  }

  async deleteUser(projectId: string, userId: string, meta: RequestMeta) {
    await this.load(projectId, userId);
    await this.ctx.db.transaction(async (tx) => {
      await audit(tx, { projectId, userId, type: 'user.deleted', meta, data: { by: 'admin' } });
      await tx.query('DELETE FROM auth_users WHERE id = $1 AND project_id = $2', [userId, projectId]);
    });
  }

  async revokeSessions(projectId: string, userId: string, meta: RequestMeta) {
    await this.load(projectId, userId);
    const count = await this.sessions.revokeAllForUser(this.ctx.db, projectId, userId, 'admin');
    await audit(this.ctx.db, { projectId, userId, type: 'session.revoked_all', meta, data: { by: 'admin', count } });
    return { revoked: count };
  }

  async listEvents(projectId: string, opts: { userId?: string; limit?: number; before?: number }) {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const params: unknown[] = [projectId, limit];
    let where = 'project_id = $1';
    if (opts.userId) {
      if (!UUID_RE.test(opts.userId)) throw new AuthError('invalid_request', 'Invalid user id.');
      params.push(opts.userId);
      where += ` AND user_id = $${params.length}`;
    }
    if (opts.before) {
      params.push(opts.before);
      where += ` AND id < $${params.length}`;
    }
    const { rows } = await this.ctx.db.query<{
      id: string;
      user_id: string | null;
      type: string;
      ip: string | null;
      user_agent: string | null;
      data: unknown;
      created_at: Date;
    }>(`SELECT * FROM auth_events WHERE ${where} ORDER BY id DESC LIMIT $2`, params);
    return {
      events: rows.map((r) => ({
        id: Number(r.id),
        userId: r.user_id,
        type: r.type,
        ip: r.ip,
        userAgent: r.user_agent,
        data: r.data,
        createdAt: r.created_at.toISOString(),
      })),
    };
  }

  private async load(projectId: string, userId: string): Promise<UserRow> {
    if (!UUID_RE.test(userId)) throw new AuthError('not_found', 'User not found.');
    const { rows } = await this.ctx.db.query<UserRow>('SELECT * FROM auth_users WHERE id = $1 AND project_id = $2', [
      userId,
      projectId,
    ]);
    if (!rows[0]) throw new AuthError('not_found', 'User not found.');
    return rows[0];
  }
}

function encodeCursor(createdAt: Date, id: string) {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [string, string];
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt)) || !UUID_RE.test(id)) throw new Error();
    return { createdAt, id };
  } catch {
    throw new AuthError('invalid_request', 'Invalid cursor.');
  }
}
