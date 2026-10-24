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
 * Data tokens: short-lived proofs, bound to one live session, that the app's own database
 * verifies before reading or writing a user's rows. One format for every Basalt data path —
 * the Data block's basalt.api() and @basalt/api's row-level security both verify it in Postgres:
 *
 *   HS256 JWT  header { alg: "HS256", typ: "JWT", kid: "v<keyVersion>" }
 *              payload { sub, sid, iat, exp, aud: "authenticated", role: "authenticated", iss }
 *
 * Signed with the project's data secret (base64url of 32 random bytes, used as a text key, as
 * pgcrypto's hmac(text, text) does). The secret exists only here (encrypted at rest) and inside
 * each app database's locked-down schema — never in app servers or the Data service — so they
 * can present tokens but never mint them. Lifetime always equals the access token's (≤ 1 hour).
 */
export class DataGrantService {
  private readonly keys = new Map<string, { version: number; key: Buffer; at: number }>();

  constructor(private readonly ctx: ServiceContext) {}

  issuer(projectId: string) {
    return `${this.ctx.publicUrl}/v1/projects/${projectId}`;
  }

  async mint(projectId: string, userId: string, sessionId: string, expSec: number, db: Db = this.ctx.db): Promise<string> {
    const { version, key } = await this.key(projectId, db);
    const iat = Math.min(Math.floor(this.ctx.now().getTime() / 1000), expSec - 1);
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${enc({ alg: 'HS256', typ: 'JWT', kid: `v${version}` })}.${enc({
      sub: userId,
      sid: sessionId,
      iat,
      exp: expSec,
      aud: 'authenticated',
      role: 'authenticated',
      iss: this.issuer(projectId),
    })}`;
    return `${unsigned}.${hmacSha256(textKey(key), unsigned).toString('base64url')}`;
  }

  /**
   * What a database needs to verify this project's data tokens. Contains the secret: only for
   * the platform provisioning databases (owner-scoped control plane), never for apps.
   */
  async signing(projectId: string) {
    const { version, key } = await this.key(projectId, this.ctx.db);
    return { algorithm: 'HS256' as const, keyVersion: version, secret: textKey(key).toString('utf8'), issuer: this.issuer(projectId), maxTokenSeconds: 3600 };
  }

  /** SQL that installs the verifier + this project's key into the app's database. Contains the key: treat as secret. */
  async installSql(projectId: string): Promise<string> {
    const { version, key } = await this.key(projectId, this.ctx.db);
    const block = Buffer.alloc(64);
    textKey(key).copy(block);
    const kIpad = Buffer.from(block.map((b) => b ^ 0x36));
    const kOpad = Buffer.from(block.map((b) => b ^ 0x5c));
    return renderDataProtectionSql({ projectId, version, kIpad, kOpad, issuer: this.issuer(projectId) });
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

/** The secret as text (base64url, 43 chars): the exact bytes every verifier uses as the HMAC key. */
function textKey(key: Buffer): Buffer {
  return Buffer.from(key.toString('base64url'), 'utf8');
}
