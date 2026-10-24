import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { SignJWT, type JWK as JsonWebKey } from 'jose';
import type { ServiceContext } from '../context.js';
import type { Db } from '../db/db.js';
import { randomId } from '../lib/crypto.js';
import { AuthError } from '../lib/errors.js';

const CACHE_TTL_MS = 60_000;
/**
 * A rotated-out key stays published in the JWKS for this long so tokens it signed keep
 * verifying until they expire. Must exceed the maximum access token TTL (1h) plus verifier
 * JWKS cache time.
 */
export const RETIRE_AFTER_MS = 3 * 3600_000;

export interface AccessTokenClaims {
  sub: string;
  sid: string;
  email: string;
  email_verified: boolean;
  amr: string[];
}

interface KeyRow {
  kid: string;
  public_jwk: JsonWebKey;
  private_key_enc: Buffer;
  status: 'active' | 'retiring' | 'retired';
}

export class SigningKeyStore {
  private readonly signers = new Map<string, { kid: string; key: KeyObject; at: number }>();
  private readonly jwks = new Map<string, { keys: JsonWebKey[]; at: number }>();

  constructor(private readonly ctx: ServiceContext) {}

  issuer(projectId: string) {
    return `${this.ctx.publicUrl}/v1/projects/${projectId}`;
  }

  async createKey(tx: Db, projectId: string) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const kid = randomId('key_', 9);
    const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig' };
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const enc = this.ctx.keyRing.encrypt(pkcs8, `signing-key:${kid}`);
    await tx.query(
      `INSERT INTO auth_signing_keys (kid, project_id, public_jwk, private_key_enc, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [kid, projectId, JSON.stringify(jwk), enc],
    );
    return kid;
  }

  /** New key signs immediately; the old one stays verifiable until RETIRE_AFTER_MS passes. */
  async rotate(projectId: string) {
    const kid = await this.ctx.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE auth_signing_keys SET status = 'retiring', retired_at = $2 WHERE project_id = $1 AND status = 'active'`,
        [projectId, new Date(this.ctx.now().getTime() + RETIRE_AFTER_MS)],
      );
      return this.createKey(tx, projectId);
    });
    this.signers.delete(projectId);
    this.jwks.delete(projectId);
    return { kid };
  }

  async publicJwks(projectId: string): Promise<{ keys: JsonWebKey[] }> {
    const hit = this.jwks.get(projectId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { keys: hit.keys };
    const { rows } = await this.ctx.db.query<KeyRow>(
      `SELECT kid, public_jwk FROM auth_signing_keys
       WHERE project_id = $1 AND status IN ('active', 'retiring') ORDER BY created_at DESC`,
      [projectId],
    );
    const keys = rows.map((r) => r.public_jwk);
    this.jwks.set(projectId, { keys, at: Date.now() });
    return { keys };
  }

  /** Pass `db` when called inside a transaction so a cache miss doesn't take a second pool connection. */
  async signAccessToken(projectId: string, claims: AccessTokenClaims, ttlSeconds: number, db: Db = this.ctx.db) {
    const signer = await this.activeSigner(projectId, db);
    const nowSec = Math.floor(this.ctx.now().getTime() / 1000);
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'EdDSA', kid: signer.kid, typ: 'at+jwt' })
      .setIssuer(this.issuer(projectId))
      .setAudience(projectId)
      .setIssuedAt(nowSec)
      .setExpirationTime(nowSec + ttlSeconds)
      .sign(signer.key);
    return { token, expiresAt: new Date((nowSec + ttlSeconds) * 1000) };
  }

  /** Moves keys whose grace period has elapsed out of the JWKS. Run periodically. */
  async retireExpired() {
    await this.ctx.db.query(
      `UPDATE auth_signing_keys SET status = 'retired' WHERE status = 'retiring' AND retired_at <= $1`,
      [this.ctx.now()],
    );
    this.jwks.clear();
  }

  private async activeSigner(projectId: string, db: Db) {
    const hit = this.signers.get(projectId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    const { rows } = await db.query<KeyRow>(
      `SELECT kid, private_key_enc FROM auth_signing_keys WHERE project_id = $1 AND status = 'active'`,
      [projectId],
    );
    const row = rows[0];
    if (!row) throw new AuthError('internal_error', 'No active signing key for project.');
    const der = this.ctx.keyRing.decrypt(row.private_key_enc, `signing-key:${row.kid}`);
    const signer = { kid: row.kid, key: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), at: Date.now() };
    this.signers.set(projectId, signer);
    return signer;
  }
}
