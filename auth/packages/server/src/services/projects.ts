import type { ServiceContext } from '../context.js';
import { constantTimeEqual, randomId, randomToken, sha256 } from '../lib/crypto.js';
import { AuthError } from '../lib/errors.js';
import { parseSettings, ProjectSettingsSchema, type ProjectSettings } from '../settings.js';
import type { SigningKeyStore } from './signing-keys.js';

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  allowedOrigins: string[];
  settings: ProjectSettings;
  secretKeyHint: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProjectRow {
  id: string;
  owner_id: string;
  name: string;
  allowed_origins: string[];
  settings: unknown;
  secret_key_hint: string;
  secret_key_hash: Buffer;
  created_at: Date;
  updated_at: Date;
}

const SECRET_KEY_PREFIX = 'bslt_sk_';
const CACHE_TTL_MS = 15_000;

function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    allowedOrigins: r.allowed_origins,
    settings: parseSettings(r.settings),
    secretKeyHint: r.secret_key_hint,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function newSecretKey() {
  const key = randomToken(SECRET_KEY_PREFIX);
  return { key, hash: sha256(key), hint: `${key.slice(0, SECRET_KEY_PREFIX.length + 4)}…` };
}

export class ProjectService {
  // Project config is read on every request; a short-lived cache keeps that off the database.
  private readonly cache = new Map<string, { project: Project; hash: Buffer; at: number }>();

  constructor(
    private readonly ctx: ServiceContext,
    private readonly signingKeys: SigningKeyStore,
  ) {}

  async create(ownerId: string, input: { name: string; allowedOrigins: string[]; settings?: Partial<ProjectSettings> }) {
    const settings = ProjectSettingsSchema.parse(input.settings ?? {});
    const id = randomId('prj_');
    const secret = newSecretKey();
    const project = await this.ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<ProjectRow>(
        `INSERT INTO auth_projects (id, owner_id, name, secret_key_hash, secret_key_hint, allowed_origins, settings)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [id, ownerId, input.name, secret.hash, secret.hint, input.allowedOrigins, JSON.stringify(settings)],
      );
      await this.signingKeys.createKey(tx, id);
      return toProject(rows[0]!);
    });
    return { project, secretKey: secret.key };
  }

  async get(id: string): Promise<Project> {
    return (await this.load(id)).project;
  }

  /** Control-plane lookup: the project must belong to `ownerId`. Unknown and foreign projects look identical. */
  async getOwned(ownerId: string, id: string): Promise<Project> {
    const project = await this.get(id);
    if (project.ownerId !== ownerId) throw new AuthError('not_found', 'Project not found.');
    return project;
  }

  async listOwned(ownerId: string): Promise<Project[]> {
    const { rows } = await this.ctx.db.query<ProjectRow>(
      'SELECT * FROM auth_projects WHERE owner_id = $1 ORDER BY created_at LIMIT 500',
      [ownerId],
    );
    return rows.map(toProject);
  }

  async find(id: string): Promise<Project | null> {
    try {
      return await this.get(id);
    } catch (err) {
      if (err instanceof AuthError && err.code === 'not_found') return null;
      throw err;
    }
  }

  async update(id: string, patch: { name?: string; allowedOrigins?: string[]; settings?: Partial<ProjectSettings> }) {
    return this.ctx.db.transaction(async (tx) => {
      const { rows } = await tx.query<ProjectRow>('SELECT * FROM auth_projects WHERE id = $1 FOR UPDATE', [id]);
      const row = rows[0];
      if (!row) throw new AuthError('not_found', 'Project not found.');
      const settings = ProjectSettingsSchema.parse({ ...parseSettings(row.settings), ...(patch.settings ?? {}) });
      const res = await tx.query<ProjectRow>(
        `UPDATE auth_projects SET name = $2, allowed_origins = $3, settings = $4, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, patch.name ?? row.name, patch.allowedOrigins ?? row.allowed_origins, JSON.stringify(settings)],
      );
      this.cache.delete(id);
      return toProject(res.rows[0]!);
    });
  }

  async rotateSecretKey(id: string) {
    const secret = newSecretKey();
    const { rowCount } = await this.ctx.db.query(
      'UPDATE auth_projects SET secret_key_hash = $2, secret_key_hint = $3, updated_at = now() WHERE id = $1',
      [id, secret.hash, secret.hint],
    );
    if (rowCount === 0) throw new AuthError('not_found', 'Project not found.');
    this.cache.delete(id);
    return { secretKey: secret.key };
  }

  async delete(id: string) {
    const { rowCount } = await this.ctx.db.query('DELETE FROM auth_projects WHERE id = $1', [id]);
    this.cache.delete(id);
    if (rowCount === 0) throw new AuthError('not_found', 'Project not found.');
  }

  /** Verifies a server-side secret key belongs to this project. Constant-time. */
  async verifySecretKey(projectId: string, presented: string): Promise<boolean> {
    if (!presented.startsWith(SECRET_KEY_PREFIX)) return false;
    const entry = await this.load(projectId).catch(() => null);
    if (!entry) return false;
    return constantTimeEqual(sha256(presented), entry.hash);
  }

  private async load(id: string) {
    const hit = this.cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    if (!/^prj_[A-Za-z0-9]{8,40}$/.test(id)) throw new AuthError('not_found', 'Project not found.');
    const { rows } = await this.ctx.db.query<ProjectRow>('SELECT * FROM auth_projects WHERE id = $1', [id]);
    const row = rows[0];
    if (!row) throw new AuthError('not_found', 'Project not found.');
    const entry = { project: toProject(row), hash: row.secret_key_hash, at: Date.now() };
    this.cache.set(id, entry);
    if (this.cache.size > 10_000) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }
}
