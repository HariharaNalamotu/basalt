import { rm } from 'node:fs/promises';
import { createDataProject, dataUrlFor, deleteDataProject } from './data-link.js';
import path from 'node:path';
import pg from 'pg';
import { setupApp } from '@basalt/api-mcp';
import { DEFAULT_PROTECTION, EMPTY_CSP, type EnvKind } from '@basalt/host-shared';
import type { Ctx } from './ctx.js';
import { id, secret } from './crypto.js';
import { HostedPlatform } from './hosted-platform.js';
import { appOrigins, envKey, hostFor, networkName, subnetFor } from './naming.js';

export interface AppRow {
  id: string;
  workspace_id: string;
  name: string;
}

export interface EnvRow {
  id: string;
  app_id: string;
  kind: EnvKind;
  slug: string;
  host: string;
  status: string;
  subnet_index: number;
  auth_project_id: string | null;
  /** Basalt Cloud data project served at /_basalt/data, and its admin key (sealed). */
  data_project_id: string | null;
  data_admin_key_enc: Buffer | null;
  current_release_id: string | null;
  sleeping: boolean;
  protection: Record<string, unknown>;
  csp: Record<string, unknown>;
  access_key_enc: Buffer | null;
  expires_at: Date | null;
  last_active_at: Date;
  created_at: Date;
}

const INFRA_ALIASES: Record<string, string> = {
  'basalt-postgres': 'postgres',
  'basalt-redis': 'redis',
  'basalt-auth': 'auth',
  'basalt-edge': 'edge',
  'basalt-egress': 'egress',
  'basalt-cloud': 'cloud',
};

export class CapacityError extends Error {}

export class Environments {
  constructor(
    private readonly ctx: Ctx,
    private readonly hooks: {
      applyToRunning: (env: EnvRow) => Promise<void>;
      execInRunning: (env: EnvRow, cmd: string[]) => Promise<{ exitCode: number; output: string }>;
      /** Serialized deletion (waits for in-flight releases). */
      destroy?: (app: AppRow, env: EnvRow) => Promise<void>;
    },
  ) {}

  platformFor(app: AppRow, env: EnvRow) {
    return new HostedPlatform(this.ctx, env.id, envKey(app.name, env.slug), {
      apply: env.current_release_id ? () => this.hooks.applyToRunning(env) : undefined,
      exec: env.current_release_id ? (cmd) => this.hooks.execInRunning(env, cmd) : undefined,
    });
  }

  async get(envId: string): Promise<EnvRow | null> {
    return (await this.ctx.db.query<EnvRow>('SELECT * FROM environments WHERE id = $1', [envId])).rows[0] ?? null;
  }

  async find(appId: string, slug: string): Promise<EnvRow | null> {
    return (await this.ctx.db.query<EnvRow>('SELECT * FROM environments WHERE app_id = $1 AND slug = $2', [appId, slug])).rows[0] ?? null;
  }

  async list(appId: string): Promise<EnvRow[]> {
    return (await this.ctx.db.query<EnvRow>('SELECT * FROM environments WHERE app_id = $1 ORDER BY created_at', [appId])).rows;
  }

  accessKey(env: EnvRow): string | null {
    return env.access_key_enc ? this.ctx.box.open(env.access_key_enc, `access:${env.id}`) : null;
  }

  /**
   * Creates (or repairs) an environment: private network, auth project, database with admin and
   * restricted runtime roles, database-enforced ownership, Redis ACL user, edge secret, env vars.
   */
  async ensure(app: AppRow, kind: EnvKind, slug: string): Promise<EnvRow> {
    let env = await this.find(app.id, slug);
    if (env?.status === 'ready') return env;
    if (!env) {
      await this.assertCapacity(app, kind);
      env = await this.ctx.db.tx(async (q) => {
        await q('SELECT pg_advisory_xact_lock(727455302)');
        const used = new Set((await q<{ subnet_index: number }>('SELECT subnet_index FROM environments')).rows.map((r) => r.subnet_index));
        let index = 0;
        while (used.has(index)) index++;
        if (index > 250) throw new CapacityError('No free environment networks left on this machine.');
        const envId = id('env');
        const expires = kind === 'preview' ? new Date(Date.now() + this.ctx.cfg.PREVIEW_TTL_HOURS * 3600_000) : null;
        const accessKey = kind === 'production' ? null : this.ctx.box.seal(secret(), `access:${envId}`);
        const { rows } = await q<EnvRow>(
          `INSERT INTO environments (id, app_id, kind, slug, host, subnet_index, protection, csp, access_key_enc, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [envId, app.id, kind, slug, hostFor(app.name, kind, slug, this.ctx.cfg.ROOT_DOMAIN), index, JSON.stringify(DEFAULT_PROTECTION), JSON.stringify(EMPTY_CSP), accessKey, expires],
        );
        return rows[0]!;
      });
    }
    try {
      await this.ensureNetwork(env);
      const platform = this.platformFor(app, env);
      const auth = this.ctx.authFor(app.workspace_id);
      const r = await setupApp({ platform, auth }, { app: envKey(app.name, slug), name: app.name, origins: appOrigins(env.host, this.ctx.cfg.LOCAL_HTTP_PORT) });
      await platform.restrictRedis(r.projectId);
      await platform.writeEnv(envKey(app.name, slug), {
        // Tokens carry the public issuer; the backend fetches keys over the private network.
        BASALT_AUTH_URL: { value: this.ctx.cfg.AUTH_PUBLIC_URL, secret: false },
        BASALT_AUTH_INTERNAL_URL: { value: this.ctx.cfg.AUTH_INTERNAL_URL, secret: false },
        // The only route to the internet is the egress proxy (private networks are blocked there).
        HTTPS_PROXY: { value: this.ctx.cfg.EGRESS_PROXY, secret: false },
        HTTP_PROXY: { value: this.ctx.cfg.EGRESS_PROXY, secret: false },
        NO_PROXY: { value: 'auth,cloud,postgres,redis,localhost,127.0.0.1', secret: false },
        NODE_USE_ENV_PROXY: { value: '1', secret: false },
        NODE_ENV: { value: 'production', secret: false },
        PORT: { value: '3000', secret: false },
        // 40 environments × 5 connections fits comfortably within Postgres's connection limit.
        DATABASE_MAX_CONNECTIONS: { value: '5', secret: false },
        BASALT_ENVIRONMENT: { value: kind, secret: false },
        BASALT_APP_HOST: { value: env.host, secret: false },
      });
      // The Data block: a Cloud data project that accepts this environment's Auth tokens. Keyed on
      // the environment id, so a retry gets the same project back, and recorded before anything
      // else can fail so deleting the environment always finds it.
      const link = this.ctx.cfg.dataLink;
      if (link) {
        // One provisioning per environment at a time (each Cloud reply rotates the admin key, so
        // two racing writers could otherwise save a stale one), and none once it's recorded.
        const envId = env.id;
        env = await this.ctx.db.tx(async (q) => {
          await q('SELECT pg_advisory_xact_lock(hashtext($1))', [`data:${envId}`]);
          const current = (await q<EnvRow>('SELECT * FROM environments WHERE id = $1', [envId])).rows[0]!;
          // Reused only while it's bound to the Auth project this setup produced. Otherwise Cloud is
          // asked again, and refuses (so setup fails loudly) if its database is tied to another one.
          if (current.data_project_id && current.data_admin_key_enc && current.auth_project_id === r.projectId) return current;
          const data = await createDataProject(link, { name: `${app.name} (${slug})`, authProjectId: r.projectId, authOwner: app.workspace_id, externalId: envId });
          return (
            await q<EnvRow>('UPDATE environments SET data_project_id = $2, data_admin_key_enc = $3 WHERE id = $1 RETURNING *', [envId, data.projectId, this.ctx.box.seal(data.adminKey, `data:${envId}`)])
          ).rows[0]!;
        });
        await platform.writeEnv(envKey(app.name, slug), { BASALT_DATA_URL: { value: dataUrlFor(link, env.data_project_id)!, secret: false } });
      }
      env = (await this.ctx.db.query<EnvRow>(`UPDATE environments SET status = 'ready', auth_project_id = $2, error = NULL WHERE id = $1 RETURNING *`, [env.id, r.projectId])).rows[0]!;
      this.ctx.routes.bump();
      return env;
    } catch (err) {
      await this.ctx.db.query(`UPDATE environments SET status = 'failed', error = $2 WHERE id = $1`, [env.id, (err as Error).message.slice(0, 1000)]);
      throw err;
    }
  }

  private async ensureNetwork(env: EnvRow) {
    const name = networkName(env.id);
    try {
      await this.ctx.docker.inspectNetwork(name);
    } catch {
      // Internal: no route to the internet or the host's LAN. Egress only via the proxy.
      await this.ctx.docker.createNetwork(name, {
        Driver: 'bridge',
        Internal: true,
        IPAM: { Config: [{ Subnet: subnetFor(env.subnet_index) }] },
        Labels: { 'basalt.env': env.id },
        Options: { 'com.docker.network.bridge.enable_icc': 'true' },
      });
    }
    for (const c of this.ctx.cfg.infraContainers) await this.ctx.docker.connect(name, c, INFRA_ALIASES[c] ? [INFRA_ALIASES[c]!] : undefined);
  }

  private async assertCapacity(app: AppRow, kind: EnvKind) {
    const { rows } = await this.ctx.db.query<{ n: string }>(`SELECT count(*) AS n FROM environments WHERE status <> 'deleting'`);
    if (Number(rows[0]!.n) >= this.ctx.cfg.MAX_RUNNING_APPS) {
      throw new CapacityError(`This machine is at capacity (${this.ctx.cfg.MAX_RUNNING_APPS} environments). Delete unused previews or apps first.`);
    }
    if (kind === 'preview') {
      const previews = (await this.ctx.db.query<EnvRow>(`SELECT * FROM environments WHERE app_id = $1 AND kind = 'preview' ORDER BY created_at`, [app.id])).rows;
      // Keep the newest previews; recycle the oldest beyond the limit.
      for (const old of previews.slice(0, Math.max(0, previews.length - this.ctx.cfg.MAX_PREVIEWS_PER_APP + 1))) await (this.hooks.destroy ?? this.destroy.bind(this))(app, old);
    }
  }

  /** The sealed admin key of an environment's data project. */
  dataAdminKey(env: EnvRow): string | null {
    return env.data_admin_key_enc ? this.ctx.box.open(env.data_admin_key_enc, `data:${env.id}`) : null;
  }

  /** Removes everything an environment owns. Irreversible. */
  async destroy(app: AppRow, env: EnvRow) {
    await this.ctx.db.query(`UPDATE environments SET status = 'deleting' WHERE id = $1`, [env.id]);
    const started = Date.now();
    const step = (name: string) => this.ctx.log.info('destroy_step', { env: env.id, step: name, ms: Date.now() - started });
    const d = this.ctx.docker;
    for (const c of await d.list({ 'basalt.env': env.id })) await d.remove(c.Id).catch(() => {});
    step('containers');
    if (env.auth_project_id) {
      await fetch(`${this.ctx.cfg.AUTH_INTERNAL_URL}/v1/platform/projects/${env.auth_project_id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${this.ctx.cfg.AUTH_PLATFORM_KEY}`, 'x-basalt-owner': app.workspace_id, connection: 'close' },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {});
    }
    step('auth');
    // Not swallowed: if Cloud can't delete it now, the environment stays 'deleting' with its
    // data project recorded, and deleting again finishes the job.
    if (this.ctx.cfg.dataLink) await deleteDataProject(this.ctx.cfg.dataLink, env.id, fetch, env.data_project_id);
    step('data');
    await this.ctx.redis.call('ACL', 'DELUSER', `u_${env.id}`).catch(() => {});
    await this.ctx.redis.call('ACL', 'SAVE').catch(() => {});
    step('redis');
    const db = `basalt_${envKey(app.name, env.slug).replace(/-/g, '_')}`;
    const root = new pg.Client({ connectionString: this.ctx.cfg.PG_ADMIN_URL });
    await root.connect();
    try {
      await root.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await root.query(`DROP ROLE IF EXISTS ${db}_app`);
      await root.query(`DROP ROLE IF EXISTS ${db}_admin`);
    } finally {
      await root.end();
    }
    step('database');
    // Network last: service-level cleanup above runs while everything is still attached.
    const net = networkName(env.id);
    for (const c of this.ctx.cfg.infraContainers) await d.disconnect(net, c).catch(() => {});
    step('disconnect');
    await d.removeNetwork(net).catch(() => {});
    step('network');
    await rm(path.join(this.ctx.cfg.DATA_DIR, 'test-runs', env.id), { recursive: true, force: true });
    await this.ctx.db.query('DELETE FROM environments WHERE id = $1', [env.id]);
    this.ctx.routes.bump();
  }

  async envVars(app: AppRow, env: EnvRow): Promise<string[]> {
    const vars = await this.platformFor(app, env).readEnv(envKey(app.name, env.slug));
    return Object.entries(vars).map(([k, v]) => `${k}=${v.value}`);
  }
}
