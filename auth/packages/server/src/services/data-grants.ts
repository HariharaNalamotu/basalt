import { randomBytes } from 'node:crypto';
import type { ServiceContext } from '../context.js';
import type { Db } from '../db/db.js';
import { hmacSha256 } from '../lib/crypto.js';
import { AuthError } from '../lib/errors.js';
import { renderDataProtectionSql } from '../data-protection-sql.js';

const CACHE_TTL_MS = 60_000;
/** Revocations older than this are useless to app databases: no grant outlives 1 hour. */
const FEED_HORIZON_MS = 2 * 3600_000;
const FEED_PAGE = 1000;

/**
 * Data grants: short-lived proofs, bound to one live session, that the app's own database
 * verifies before returning a user's rows. Format:
 *
 *   bdg1.<keyVersion>.<projectId>.<userId>.<sessionId>.<expEpoch>.<hex HMAC-SHA256(dataKey, everything before)>
 *
 * The data key exists only here (encrypted at rest) and inside the app database's locked-down
 * basalt_auth schema — never in the app server — so the app can present grants but never mint them.
 */
export class DataGrantService {
  private readonly keys = new Map<string, { version: number; key: Buffer; at: number }>();

  constructor(private readonly ctx: ServiceContext) {}

  async mint(projectId: string, userId: string, sessionId: string, expSec: number, db: Db = this.ctx.db): Promise<string> {
    const { version, key } = await this.key(projectId, db);
    const body = `bdg1.${version}.${projectId}.${userId}.${sessionId}.${expSec}`;
    return `${body}.${hmacSha256(key, body).toString('hex')}`;
  }

  /** SQL that installs the verifier + this project's key into the app's database. Contains the key: treat as secret. */
  async installSql(projectId: string): Promise<string> {
    const { version, key } = await this.key(projectId, this.ctx.db);
    const block = Buffer.alloc(64);
    key.copy(block);
    const kIpad = Buffer.from(block.map((b) => b ^ 0x36));
    const kOpad = Buffer.from(block.map((b) => b ^ 0x5c));
    return renderDataProtectionSql({ projectId, version, kIpad, kOpad });
  }

  /**
   * Sessions that ended early, oldest first, for app databases to block. Keyset-paginated by
   * (revoked_at, id). `since` is inclusive so callers can re-read an overlap window safely.
   */
  async revocations(projectId: string, opts: { since?: Date; cursor?: string }) {
    const horizon = new Date(this.ctx.now().getTime() - FEED_HORIZON_MS);
    let afterAt = opts.since && opts.since > horizon ? opts.since : horizon;
    let afterId = 0n;
    let inclusive = true;
    if (opts.cursor) {
      const c = decodeCursor(opts.cursor);
      afterAt = c.at > horizon ? c.at : horizon;
      afterId = c.id;
      inclusive = false;
    }
    const { rows } = await this.ctx.db.query<{ id: string; session_id: string; revoked_at: Date }>(
      `SELECT id, session_id, revoked_at FROM auth_session_revocations
       WHERE project_id = $1 AND ${inclusive ? 'revoked_at >= $2' : '(revoked_at, id) > ($2, $3::bigint)'}
       ORDER BY revoked_at, id LIMIT ${FEED_PAGE + 1}`,
      inclusive ? [projectId, afterAt] : [projectId, afterAt, afterId.toString()],
    );
    const page = rows.slice(0, FEED_PAGE);
    const last = page[page.length - 1];
    return {
      revocations: page.map((r) => ({ sessionId: r.session_id, revokedAt: r.revoked_at.toISOString() })),
      hasMore: rows.length > FEED_PAGE,
      nextCursor: last ? encodeCursor(last.revoked_at, BigInt(last.id)) : opts.cursor ?? null,
    };
  }

  private async key(projectId: string, db: Db): Promise<{ version: number; key: Buffer }> {
    const hit = this.keys.get(projectId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    const aad = (v: number) => `data-key:${projectId}:${v}`;
    let { rows } = await db.query<{ data_key_enc: Buffer | null; data_key_version: number }>(
      'SELECT data_key_enc, data_key_version FROM auth_projects WHERE id = $1',
      [projectId],
    );
    let row = rows[0];
    if (!row) throw new AuthError('not_found', 'Project not found.');
    if (!row.data_key_enc) {
      // Lazily create; the IS NULL guard makes concurrent creators converge on one key.
      await db.query('UPDATE auth_projects SET data_key_enc = $2 WHERE id = $1 AND data_key_enc IS NULL', [
        projectId,
        this.ctx.keyRing.encrypt(randomBytes(32), aad(row.data_key_version)),
      ]);
      ({ rows } = await db.query('SELECT data_key_enc, data_key_version FROM auth_projects WHERE id = $1', [projectId]));
      row = rows[0]!;
    }
    const entry = {
      version: row.data_key_version,
      key: this.ctx.keyRing.decrypt(row.data_key_enc!, aad(row.data_key_version)),
      at: Date.now(),
    };
    this.keys.set(projectId, entry);
    return entry;
  }
}

function encodeCursor(at: Date, id: bigint) {
  return Buffer.from(`${at.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: bigint } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const at = new Date(iso ?? '');
  if (Number.isNaN(at.getTime()) || !/^\d{1,19}$/.test(id ?? '')) {
    throw new AuthError('invalid_request', 'Invalid cursor.');
  }
  return { at, id: BigInt(id!) };
}
