import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { signEdgeRequest } from '@basalt/api';

/** One environment variable of the app. Secrets are stored but never shown to the agent. */
export interface EnvVar {
  value: string;
  secret: boolean;
}

/**
 * What the API tools need from the hosting platform. The hosted Basalt platform implements this
 * against its own infrastructure; LocalPlatform implements it on a developer machine.
 */
export interface ApiPlatform {
  /** Human-readable description of where things live. */
  describe(): string;
  readEnv(app: string): Promise<Record<string, EnvVar>>;
  /** Upserts variables; `null` deletes one. */
  writeEnv(app: string, vars: Record<string, EnvVar | null>): Promise<void>;
  /**
   * Ensures a Postgres database with two roles: an admin/migration role that owns the schema and
   * a restricted runtime role (no superuser, no BYPASSRLS, owns nothing) for DATABASE_URL.
   */
  ensureDatabase(app: string): Promise<{ created: boolean; database: string; appRole: string; adminRole: string; env: Record<string, EnvVar> }>;
  /** Runs SQL as the admin role and returns rows of the last statement. */
  adminQuery(app: string, sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  ensureRedis(app: string): Promise<{ created: boolean; env: Record<string, EnvVar> }>;
  /** Tell the edge about the app's backend and shared secret. */
  configureEdge(app: string, cfg: { edgeSecret: string; projectId: string; apiBasePath: string }): Promise<void>;
  /** Roll out env changes (restart/redeploy). */
  applyChanges(app: string): Promise<{ applied: boolean; note?: string }>;
  /** Edge-signed request to the running backend (for /_basalt/introspect). Optional. */
  callBackend?(app: string, pathAndQuery: string): Promise<Response>;
}

export interface LocalPlatformOptions {
  /** Where env files are written. Default ./.basalt (git-ignored automatically). */
  stateDir?: string;
  /** Superuser connection used only to create per-app databases and roles. */
  pgAdminUrl: string;
  redisUrl: string;
  /** Where the backend listens locally (for status checks). Default http://127.0.0.1:3000 */
  backendUrl?: string;
}

const appIdent = (app: string) => `basalt_${app.replace(/-/g, '_')}`;
const password = () => randomBytes(24).toString('base64url');

export class LocalPlatform implements ApiPlatform {
  private readonly stateDir: string;

  constructor(private readonly opts: LocalPlatformOptions) {
    this.stateDir = path.resolve(opts.stateDir ?? '.basalt');
  }

  describe() {
    return `local development (env files in ${this.stateDir}, Postgres and Redis on this machine)`;
  }

  private jsonPath(app: string) {
    return path.join(this.stateDir, `${app}.json`);
  }

  /** The dotenv file apps run with: node --env-file=.basalt/<app>.env ... */
  envFilePath(app: string) {
    return path.join(this.stateDir, `${app}.env`);
  }

  async readEnv(app: string): Promise<Record<string, EnvVar>> {
    try {
      return JSON.parse(await readFile(this.jsonPath(app), 'utf8')) as Record<string, EnvVar>;
    } catch {
      return {};
    }
  }

  async writeEnv(app: string, vars: Record<string, EnvVar | null>) {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    // Never let secrets be committed by accident.
    await writeFile(path.join(this.stateDir, '.gitignore'), '*\n', { mode: 0o600 });
    const env = await this.readEnv(app);
    for (const [k, v] of Object.entries(vars)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Invalid env var name ${k}`);
      if (v === null) delete env[k];
      else env[k] = v;
    }
    await writeFile(this.jsonPath(app), JSON.stringify(env, null, 2), { mode: 0o600 });
    const lines = Object.entries(env).map(([k, v]) => `${k}=${quoteEnv(v.value)}`);
    await writeFile(this.envFilePath(app), `# Managed by the Basalt MCP tools. Do not commit. Do not edit by hand.\n${lines.join('\n')}\n`, { mode: 0o600 });
    await chmod(this.envFilePath(app), 0o600);
  }

  async ensureDatabase(app: string) {
    const db = appIdent(app);
    const adminRole = `${db}_admin`;
    const appRole = `${db}_app`;
    const existing = await this.readEnv(app);
    const root = new pg.Client({ connectionString: this.opts.pgAdminUrl });
    await root.connect();
    let created = false;
    let fresh = true;
    const adminPw = password();
    const appPw = password();
    try {
      const exists = (await root.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount! > 0;
      fresh = !exists || !existing.DATABASE_URL || !existing.DATABASE_ADMIN_URL;
      for (const [role, pw, extra] of [
        [adminRole, adminPw, 'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB'],
        [appRole, appPw, 'NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOINHERIT'],
      ] as const) {
        const has = (await root.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount! > 0;
        // Identifiers are derived from a validated app name; passwords are base64url (no quotes).
        if (!has) await root.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' ${extra}`);
        else if (fresh) await root.query(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${pw}' ${extra}`);
      }
      if (!exists) {
        await root.query(`CREATE DATABASE ${db} OWNER ${adminRole}`);
        created = true;
      }
      await root.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
      await root.query(`GRANT CONNECT ON DATABASE ${db} TO ${appRole}`);
    } finally {
      await root.end();
    }

    const base = new URL(this.opts.pgAdminUrl);
    const urlFor = (user: string, pw: string) => {
      const u = new URL(base);
      u.username = user;
      u.password = pw;
      u.pathname = `/${db}`;
      return u.toString();
    };
    const keepOld = !fresh;
    const env: Record<string, EnvVar> = keepOld
      ? { DATABASE_URL: existing.DATABASE_URL!, DATABASE_ADMIN_URL: existing.DATABASE_ADMIN_URL! }
      : { DATABASE_URL: { value: urlFor(appRole, appPw), secret: true }, DATABASE_ADMIN_URL: { value: urlFor(adminRole, adminPw), secret: true } };

    // Default privileges: tables the admin role creates are usable (not owned) by the app role.
    const admin = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL!.value });
    await admin.connect();
    try {
      await admin.query(`
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA public TO ${appRole};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${appRole};
        ALTER DEFAULT PRIVILEGES FOR ROLE ${adminRole} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${appRole};
      `);
    } finally {
      await admin.end();
    }
    return { created, database: db, appRole, adminRole, env };
  }

  async adminQuery(app: string, sql: string, params: unknown[] = []) {
    const env = await this.readEnv(app);
    if (!env.DATABASE_ADMIN_URL) throw new Error('No database provisioned yet: run api_setup first.');
    const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL.value });
    await client.connect();
    try {
      const r = await client.query(sql, params);
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return (last?.rows ?? []) as Record<string, unknown>[];
    } finally {
      await client.end();
    }
  }

  async ensureRedis(app: string) {
    const env = await this.readEnv(app);
    if (env.REDIS_URL) return { created: false, env: { REDIS_URL: env.REDIS_URL } };
    return { created: true, env: { REDIS_URL: { value: this.opts.redisUrl, secret: true } } };
  }

  async configureEdge() {
    // The local dev edge (basalt-dev-edge) reads BASALT_EDGE_SECRET from the same env file.
  }

  async applyChanges(app: string) {
    return {
      applied: false,
      note: `Restart the backend and dev edge so they load ${path.relative(process.cwd(), this.envFilePath(app)) || this.envFilePath(app)}.`,
    };
  }

  async callBackend(app: string, pathAndQuery: string) {
    const env = await this.readEnv(app);
    const secret = env.BASALT_EDGE_SECRET?.value;
    if (!secret) throw new Error('No edge secret yet: run api_setup first.');
    const requestId = `mcp-${randomBytes(8).toString('hex')}`;
    const base = this.opts.backendUrl ?? `http://127.0.0.1:${env.PORT?.value ?? 3000}`;
    return fetch(`${base}${pathAndQuery}`, {
      headers: { 'x-request-id': requestId, 'basalt-edge-signature': signEdgeRequest(secret, { method: 'GET', pathAndQuery, requestId }) },
      signal: AbortSignal.timeout(3000),
    });
  }
}

/** dotenv quoting that survives JSON values: pick a quote character the value doesn't contain. */
function quoteEnv(value: string) {
  if (/^[A-Za-z0-9_./:@%+=,-]*$/.test(value)) return value;
  for (const q of ["'", '"', '`']) if (!value.includes(q) && !value.includes('\n')) return `${q}${value}${q}`;
  throw new Error('Env value contains every quote character or a newline; cannot store it safely.');
}
