import type { ServiceContext } from '../context.js';
import type { SigningKeyStore } from './signing-keys.js';

/** Expired rows deleted per statement, so cleanup never holds long locks on hot tables. */
const BATCH = 5_000;
const KEEP_DEAD_SESSIONS_DAYS = 7;
const KEEP_EVENTS_DAYS = 365;

/**
 * Housekeeping. Safe to run on every replica concurrently: statements are idempotent and batched,
 * and the advisory lock makes only one replica do the work per tick.
 */
export async function runMaintenance(ctx: ServiceContext, signingKeys: SigningKeyStore) {
  // Transaction-scoped lock: a session-level lock would be unsafe with a connection pool.
  const ran = await ctx.db.transaction(async (tx) => {
    const { rows } = await tx.query<{ locked: boolean }>('SELECT pg_try_advisory_xact_lock(727455002) AS locked');
    if (!rows[0]?.locked) return false;
    const now = ctx.now();
    const deadBefore = new Date(now.getTime() - KEEP_DEAD_SESSIONS_DAYS * 86_400_000);
    const eventsBefore = new Date(now.getTime() - KEEP_EVENTS_DAYS * 86_400_000);
    const sweeps: Array<[string, unknown[]]> = [
      ['DELETE FROM auth_pending_signups WHERE id IN (SELECT id FROM auth_pending_signups WHERE expires_at < $1 LIMIT $2)', [now, BATCH]],
      ['DELETE FROM auth_email_codes WHERE id IN (SELECT id FROM auth_email_codes WHERE expires_at < $1 LIMIT $2)', [now, BATCH]],
      [
        'DELETE FROM auth_mfa_challenges WHERE token_hash IN (SELECT token_hash FROM auth_mfa_challenges WHERE expires_at < $1 LIMIT $2)',
        [now, BATCH],
      ],
      [
        `DELETE FROM auth_sessions WHERE id IN (SELECT id FROM auth_sessions
           WHERE (expires_at < $1 OR idle_expires_at < $1 OR revoked_at < $1) LIMIT $2)`,
        [deadBefore, BATCH],
      ],
      ['DELETE FROM auth_events WHERE id IN (SELECT id FROM auth_events WHERE created_at < $1 LIMIT $2)', [eventsBefore, BATCH]],
    ];
    for (const [sql, params] of sweeps) await tx.query(sql, params);
    return true;
  });
  if (ran) await signingKeys.retireExpired();
}
