import type { RequestMeta } from '../context.js';
import type { Db } from '../db/db.js';

export type AuditEventType =
  | 'user.signed_up'
  | 'user.email_verified'
  | 'user.signed_in'
  | 'user.sign_in_failed'
  | 'user.signed_out'
  | 'user.password_changed'
  | 'user.password_reset'
  | 'user.mfa_enabled'
  | 'user.mfa_disabled'
  | 'user.mfa_failed'
  | 'user.recovery_code_used'
  | 'user.deleted'
  | 'user.disabled'
  | 'user.enabled'
  | 'user.metadata_updated'
  | 'session.revoked'
  | 'session.revoked_all'
  | 'session.refresh_token_reuse';

export async function audit(
  db: Db,
  event: { projectId: string; userId?: string | null; type: AuditEventType; meta?: RequestMeta; data?: Record<string, unknown> },
) {
  await db.query(
    `INSERT INTO auth_events (project_id, user_id, type, ip, user_agent, data) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.projectId,
      event.userId ?? null,
      event.type,
      event.meta?.ip ?? null,
      event.meta?.userAgent?.slice(0, 512) ?? null,
      JSON.stringify(event.data ?? {}),
    ],
  );
}
