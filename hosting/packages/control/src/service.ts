import { createHmac, timingSafeEqual } from 'node:crypto';
import { dataUrlFor } from './data-link.js';
import { z } from 'zod';
import { mergeConfig, readConfig, setRoutePolicy, writeConfig } from '@basalt/api-mcp';
import { DEFAULT_PROTECTION, EMPTY_CSP, type AppRoute, type CspSettings, type ProtectionSettings, type Route, type RouteTable } from '@basalt/host-shared';
import type { Ctx } from './ctx.js';
import { id, sha256 } from './crypto.js';
import { Environments, type AppRow, type EnvRow } from './environments.js';
import { APP_NAME_RE, envKey, RESERVED_APP_NAMES } from './naming.js';
import { Pipeline } from './pipeline.js';
import { Runtime, type DeploymentRow } from './runtime.js';
import { storeSource } from './sources.js';
import { Testing } from './testing.js';

export class UserError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const ProtectionPatch = z
  .object({
    perIpPerMinute: z.number().int().min(10).max(10_000),
    maxConcurrency: z.number().int().min(1).max(512),
    underAttack: z.boolean(),
    maxBodyBytes: z.number().int().min(1024).max(50 * 1024 * 1024),
  })
  .partial()
  .strict();

const Source = z.string().regex(/^https:\/\/(\*\.)?[a-z0-9.-]+\.[a-z]{2,}(:\d{1,5})?$/, 'sources must be https origins like https://api.stripe.com or https://*.example.com');
export const CspPatch = z
  .object({
    connectSrc: z.array(Source).max(20),
    scriptSrc: z.array(Source).max(20),
    imgSrc: z.array(Source).max(20),
    styleSrc: z.array(Source).max(20),
    fontSrc: z.array(Source).max(20),
    frameSrc: z.array(Source).max(20),
  })
  .partial()
  .strict();

const RESERVED_VARS = /^(BASALT_|DATABASE_|REDIS_|NODE_|HTTPS?_PROXY$|NO_PROXY$|PORT$|HOME$|PATH$)/;
export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

type PipelineLog = Array<{ at: string; stage: string; message: string }>;

export class Host {
  readonly envs: Environments;
  readonly runtime: Runtime;
  readonly pipeline: Pipeline;
  readonly testing: Testing;

  constructor(readonly ctx: Ctx) {
    this.envs = new Environments(ctx, {
      applyToRunning: async (env) => {
        const app = await this.appById(env.app_id);
        if (app) await this.runtime.restartLive(app, (await this.envs.get(env.id))!);
      },
      execInRunning: (env, cmd) => this.runtime.exec(env, cmd),
      destroy: (app, env) => this.destroyEnv(app, env),
    });
    this.runtime = new Runtime(ctx, this.envs);
    this.pipeline = new Pipeline(ctx);
    this.testing = new Testing(ctx, this.envs);
  }

  private audit(workspaceId: string | null, action: string, target: string, data: Record<string, unknown> = {}) {
    return this.ctx.db.query('INSERT INTO audit (workspace_id, action, target, data) VALUES ($1, $2, $3, $4)', [workspaceId, action, target, JSON.stringify(data)]);
  }

  // -------------------------------------------------------------------------- workspaces & tokens

  async createWorkspace(name: string) {
    const wsId = id('ws');
    const token = `bht_${(await import('node:crypto')).randomBytes(32).toString('base64url')}`;
    await this.ctx.db.tx(async (q) => {
      await q('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [wsId, name]);
      await q('INSERT INTO api_tokens (id, workspace_id, token_hash, name) VALUES ($1, $2, $3, $4)', [id('tok'), wsId, sha256(token), 'agent']);
    });
    return { workspaceId: wsId, token };
  }

  async authenticate(token: string): Promise<string | null> {
    if (!/^bht_[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const { rows } = await this.ctx.db.query<{ workspace_id: string; id: string }>('SELECT id, workspace_id FROM api_tokens WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(token)]);
    if (!rows[0]) return null;
    void this.ctx.db.query('UPDATE api_tokens SET last_used_at = now() WHERE id = $1', [rows[0].id]);
    return rows[0].workspace_id;
  }

  // -------------------------------------------------------------------------- apps

  async appById(appId: string): Promise<AppRow | null> {
    return (await this.ctx.db.query<AppRow>('SELECT * FROM apps WHERE id = $1', [appId])).rows[0] ?? null;
  }

  /** Workspace-scoped lookup: other workspaces' apps are indistinguishable from missing ones. */
  async app(ws: string, name: string): Promise<AppRow> {
    const a = (await this.ctx.db.query<AppRow>('SELECT * FROM apps WHERE name = $1 AND workspace_id = $2', [name, ws])).rows[0];
    if (!a) throw new UserError(`No app named "${name}" in this workspace. Create it with host_create_app.`, 404);
    return a;
  }

  async createApp(ws: string, name: string): Promise<AppRow> {
    if (!APP_NAME_RE.test(name) || name.includes('--') || RESERVED_APP_NAMES.has(name)) {
      throw new UserError('App names are 3–32 lowercase letters, digits and single dashes, starting with a letter (and not reserved).');
    }
    const existing = (await this.ctx.db.query<AppRow>('SELECT * FROM apps WHERE name = $1', [name])).rows[0];
    if (existing) {
      if (existing.workspace_id === ws) return existing;
      throw new UserError(`The name "${name}" is taken. Pick another.`, 409);
    }
    const app = (await this.ctx.db.query<AppRow>('INSERT INTO apps (id, workspace_id, name) VALUES ($1, $2, $3) RETURNING *', [id('app'), ws, name])).rows[0]!;
    await this.audit(ws, 'app.created', name);
    return app;
  }

  async listApps(ws: string) {
    const apps = (await this.ctx.db.query<AppRow>('SELECT * FROM apps WHERE workspace_id = $1 ORDER BY created_at', [ws])).rows;
    return Promise.all(
      apps.map(async (a) => ({
        name: a.name,
        environments: (await this.envs.list(a.id)).map((e) => ({ name: e.kind === 'preview' ? e.slug : e.kind, kind: e.kind, url: `https://${e.host}`, status: e.status, sleeping: e.sleeping, release: e.current_release_id, expiresAt: e.expires_at })),
      })),
    );
  }

  async deleteApp(ws: string, name: string) {
    const app = await this.app(ws, name);
    for (const env of await this.envs.list(app.id)) await this.destroyEnv(app, env);
    for (const d of (await this.ctx.db.query<DeploymentRow>('SELECT * FROM deployments WHERE app_id = $1', [app.id])).rows) {
      if (d.image) await this.ctx.docker.removeImage(d.image).catch(() => {});
    }
    await this.ctx.db.query('DELETE FROM apps WHERE id = $1', [app.id]);
    await this.audit(ws, 'app.deleted', name);
  }

  // -------------------------------------------------------------------------- environments

  /** Deletion waits for any in-flight release/rollback on the environment, then removes it. */
  async destroyEnv(app: AppRow, env: EnvRow) {
    await this.ctx.db.query(`UPDATE environments SET status = 'deleting' WHERE id = $1`, [env.id]);
    this.ctx.log.info('destroy_queued', { env: env.id });
    await this.runtime.serial(env.id, () => this.envs.destroy(app, env));
  }

  async env(ws: string, appName: string, envName: string): Promise<{ app: AppRow; env: EnvRow }> {
    const app = await this.app(ws, appName);
    const slug = envName === 'production' ? 'prod' : envName;
    const env = await this.envs.find(app.id, slug);
    if (!env) throw new UserError(`Environment "${envName}" of "${appName}" does not exist yet (deploy or promote to create it).`, 404);
    return { app, env };
  }

  // -------------------------------------------------------------------------- deploy pipeline

  async uploadSource(ws: string, appName: string, body: Buffer) {
    await this.app(ws, appName);
    return storeSource(this.ctx.cfg.DATA_DIR, body);
  }

  private async log(pipelineId: string, stage: string, message: string, status?: string) {
    const entry = { at: new Date().toISOString(), stage, message };
    await this.ctx.db.query(
      `UPDATE pipelines SET stage = $2, log = log || $3::jsonb${status ? ', status = $4, finished_at = now()' : ''} WHERE id = $1`,
      status ? [pipelineId, stage, JSON.stringify([entry]), status] : [pipelineId, stage, JSON.stringify([entry])],
    );
  }

  /**
   * Starts a deployment from an uploaded source. target 'preview' builds, deploys to a fresh
   * preview and tests it; 'production' (ship) continues through staging to production, stopping
   * at the first failure. Returns immediately; poll with deploymentStatus().
   */
  async deploy(ws: string, appName: string, sourceSha: string, opts: { message?: string; target: 'preview' | 'production' }) {
    const app = await this.app(ws, appName);
    if (!/^[0-9a-f]{64}$/.test(sourceSha)) throw new UserError('Invalid source id.');
    const sourcePath = `${this.ctx.cfg.DATA_DIR}/sources/${sourceSha}.tgz`;
    const depId = id('dep');
    const pipelineId = id('pl');
    await this.ctx.db.tx(async (q) => {
      await q('INSERT INTO deployments (id, app_id, source_sha, message) VALUES ($1, $2, $3, $4)', [depId, app.id, sourceSha, opts.message?.slice(0, 500) ?? null]);
      await q('INSERT INTO pipelines (id, app_id, deployment_id, target) VALUES ($1, $2, $3, $4)', [pipelineId, app.id, depId, opts.target]);
    });
    await this.audit(ws, 'deploy.started', appName, { deploymentId: depId, target: opts.target });
    void this.runPipeline(app, depId, pipelineId, sourcePath, opts.target).catch((err) => this.log(pipelineId, 'error', (err as Error).message, 'failed'));
    return { deploymentId: depId, pipelineId };
  }

  private async runPipeline(app: AppRow, depId: string, pipelineId: string, sourcePath: string, target: 'preview' | 'production') {
    await this.log(pipelineId, 'build', 'building');
    await this.pipeline.build({ id: depId, app: app.name, sourcePath });
    const dep = (await this.pipeline.get(depId))!;
    if (dep.status !== 'built') return this.log(pipelineId, 'build', `build failed: ${dep.error}`, 'failed');
    await this.log(pipelineId, 'build', 'build passed');

    const preview = await this.envs.ensure(app, 'preview', `p${depId.slice(-6)}`);
    await this.copyUserSecrets(app, preview);
    const passed = await this.deployAndTest(app, preview, dep, pipelineId);
    if (!passed) return this.log(pipelineId, 'preview', 'preview tests failed', 'failed');
    if (target === 'preview') return this.log(pipelineId, 'done', `preview ready at https://${preview.host}`, 'passed');

    const staging = await this.envs.ensure(app, 'staging', 'staging');
    if (!(await this.deployAndTest(app, staging, dep, pipelineId))) return this.log(pipelineId, 'staging', 'staging tests failed', 'failed');
    const prod = await this.envs.ensure(app, 'production', 'prod');
    await this.runtime.release(app, prod, dep, 'ship');
    await this.log(pipelineId, 'production', `live at https://${prod.host} (watching for errors; automatic rollback is armed)`);
    const smoke = await this.testing.smoke(app, prod, dep);
    if (smoke.status !== 'passed') {
      await this.runtime.rollback(app, (await this.envs.get(prod.id))!, undefined, 'automatic: production smoke test failed').catch(() => {});
      return this.log(pipelineId, 'production', `production smoke test failed; rolled back: ${JSON.stringify(smoke.summary)}`, 'failed');
    }
    return this.log(pipelineId, 'done', `shipped to https://${prod.host}`, 'passed');
  }

  private async deployAndTest(app: AppRow, env: EnvRow, dep: DeploymentRow, pipelineId: string): Promise<boolean> {
    const stage = env.kind === 'preview' ? 'preview' : env.kind;
    try {
      await this.runtime.release(app, env, dep, stage);
    } catch (err) {
      await this.log(pipelineId, stage, `release failed: ${(err as Error).message}`);
      return false;
    }
    await this.log(pipelineId, stage, `deployed to https://${env.host}; running smoke tests`);
    const fresh = (await this.envs.get(env.id))!;
    const smoke = await this.testing.smoke(app, fresh, dep);
    if (smoke.status !== 'passed') {
      await this.log(pipelineId, stage, `smoke tests failed: ${JSON.stringify(smoke.summary)}`);
      return false;
    }
    await this.log(pipelineId, stage, dep.manifest?.e2e ? 'smoke passed; running e2e tests' : 'smoke passed (no e2e tests in e2e/)');
    const e2e = await this.testing.e2e(app, fresh, dep, this.pipeline.workDir(dep.id));
    if (e2e.status !== 'passed') {
      await this.log(pipelineId, stage, `e2e ${e2e.status}: ${JSON.stringify(e2e.summary).slice(0, 3000)}`);
      return false;
    }
    await this.log(pipelineId, stage, 'e2e passed');
    return true;
  }

  /** Promotes an already-built deployment. Production requires passing tests in staging. */
  async promote(ws: string, appName: string, depId: string, to: 'staging' | 'production') {
    const app = await this.app(ws, appName);
    const dep = await this.deployment(ws, depId);
    if (dep.status !== 'built') throw new UserError(`Deployment ${depId} is ${dep.status}; only built deployments can be promoted.`);
    if (to === 'production') {
      const staging = await this.envs.find(app.id, 'staging');
      const runs = staging ? await this.testing.latest(staging.id, depId) : [];
      const smoke = runs.find((r) => r.kind === 'smoke');
      const e2e = runs.find((r) => r.kind === 'e2e');
      if (smoke?.status !== 'passed' || (dep.manifest?.e2e && e2e?.status !== 'passed')) {
        throw new UserError('Production promotion requires this deployment to pass its tests in staging first: promote to staging (tests run automatically), fix any failures, then promote to production.', 409);
      }
    }
    const env = await this.envs.ensure(app, to, to === 'production' ? 'prod' : 'staging');
    if (to === 'staging') {
      const pipelineId = id('pl');
      await this.ctx.db.query('INSERT INTO pipelines (id, app_id, deployment_id, target) VALUES ($1, $2, $3, $4)', [pipelineId, app.id, depId, 'staging']);
      void this.deployAndTest(app, env, dep, pipelineId).then((ok) => this.log(pipelineId, 'done', ok ? 'staging passed' : 'staging failed', ok ? 'passed' : 'failed'));
      await this.audit(ws, 'promote', appName, { depId, to });
      return { pipelineId, url: `https://${env.host}` };
    }
    const release = await this.runtime.release(app, env, dep, 'promote');
    const smoke = await this.testing.smoke(app, (await this.envs.get(env.id))!, dep);
    if (smoke.status !== 'passed') {
      await this.runtime.rollback(app, (await this.envs.get(env.id))!, undefined, 'automatic: production smoke test failed').catch(() => {});
      throw new UserError(`Released, but the production smoke test failed, so it was rolled back: ${JSON.stringify(smoke.summary)}`, 500);
    }
    await this.audit(ws, 'promote', appName, { depId, to, releaseId: release.id });
    return { releaseId: release.id, url: `https://${env.host}` };
  }

  async deployment(ws: string, depId: string): Promise<DeploymentRow> {
    const d = (await this.ctx.db.query<DeploymentRow & { workspace_id: string }>('SELECT d.*, a.workspace_id FROM deployments d JOIN apps a ON a.id = d.app_id WHERE d.id = $1', [depId])).rows[0];
    if (!d || d.workspace_id !== ws) throw new UserError('Deployment not found.', 404);
    return d;
  }

  async deploymentStatus(ws: string, depId: string) {
    const d = await this.deployment(ws, depId);
    const pipelines = (await this.ctx.db.query('SELECT id, target, status, stage, log, created_at, finished_at FROM pipelines WHERE deployment_id = $1 ORDER BY created_at', [depId])).rows;
    const tests = (await this.ctx.db.query('SELECT t.kind, t.status, t.summary, e.kind AS env FROM test_runs t JOIN environments e ON e.id = t.env_id WHERE t.deployment_id = $1 ORDER BY t.created_at', [depId])).rows;
    const envs = (await this.ctx.db.query<EnvRow>(`SELECT e.* FROM environments e JOIN releases r ON r.id = e.current_release_id WHERE r.deployment_id = $1`, [depId])).rows;
    return {
      deploymentId: d.id,
      status: d.status,
      error: d.error,
      steps: d.steps.map((s) => ({ ...s, output: s.status === 'failed' ? s.output : s.output?.slice(-500) })),
      manifest: d.manifest,
      pipelines,
      tests,
      liveIn: envs.map((e) => ({ env: e.kind === 'preview' ? e.slug : e.kind, url: `https://${e.host}` })),
    };
  }

  async waitFor(ws: string, depId: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const s = await this.deploymentStatus(ws, depId);
      const active = s.pipelines.some((p: { status: string }) => p.status === 'running') || s.status === 'queued' || s.status === 'building';
      if (!active || Date.now() >= deadline) return { done: !active, ...s };
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  // -------------------------------------------------------------------------- secrets & config

  private async copyUserSecrets(app: AppRow, preview: EnvRow) {
    const staging = await this.envs.find(app.id, 'staging');
    if (!staging) return;
    const { rows } = await this.ctx.db.query<{ name: string; value_enc: Buffer; secret: boolean }>('SELECT name, value_enc, secret FROM env_vars WHERE env_id = $1 AND managed = false', [staging.id]);
    const platform = this.envs.platformFor(app, preview);
    for (const r of rows) {
      await platform.writeEnv(envKey(app.name, preview.slug), { [r.name]: { value: this.ctx.box.open(r.value_enc, `env:${staging.id}:${r.name}`), secret: r.secret } }, false);
    }
  }

  private async targetEnvs(ws: string, appName: string, envName: string) {
    const app = await this.app(ws, appName);
    const all = await this.envs.list(app.id);
    const targets = envName === 'all' ? all.filter((e) => e.status === 'ready') : all.filter((e) => (envName === 'production' ? e.slug === 'prod' : e.slug === envName));
    if (!targets.length) throw new UserError(envName === 'all' ? 'No environments yet. Deploy first, then set secrets (or set them before promoting; they apply on the next release).' : `Environment "${envName}" does not exist yet.`, 404);
    return { app, targets };
  }

  async setSecret(ws: string, appName: string, envName: string, name: string, value: string) {
    if (!SECRET_NAME.test(name) || RESERVED_VARS.test(name)) throw new UserError('Secret names are UPPER_SNAKE_CASE and must not start with BASALT_, DATABASE_, REDIS_ or NODE_ (those are platform-managed).');
    if (value.length > 16_384) throw new UserError('Secret value too long (max 16 KB).');
    const { app, targets } = await this.targetEnvs(ws, appName, envName);
    for (const env of targets) {
      await this.envs.platformFor(app, env).writeEnv(envKey(app.name, env.slug), { [name]: { value, secret: true } }, false);
      if (env.current_release_id) await this.runtime.restartLive(app, env);
    }
    await this.audit(ws, 'secret.set', `${appName}/${envName}`, { name });
    return { environments: targets.map((e) => (e.kind === 'preview' ? e.slug : e.kind)) };
  }

  async deleteSecret(ws: string, appName: string, envName: string, name: string) {
    const { app, targets } = await this.targetEnvs(ws, appName, envName);
    for (const env of targets) {
      await this.ctx.db.query('DELETE FROM env_vars WHERE env_id = $1 AND name = $2 AND managed = false', [env.id, name]);
      if (env.current_release_id) await this.runtime.restartLive(app, env);
    }
    await this.audit(ws, 'secret.deleted', `${appName}/${envName}`, { name });
  }

  async listSecrets(ws: string, appName: string, envName: string) {
    const { env } = await this.env(ws, appName, envName);
    const { rows } = await this.ctx.db.query<{ name: string; managed: boolean; updated_at: Date }>('SELECT name, managed, updated_at FROM env_vars WHERE env_id = $1 ORDER BY managed, name', [env.id]);
    return { yours: rows.filter((r) => !r.managed).map((r) => ({ name: r.name, updatedAt: r.updated_at })), platformManaged: rows.filter((r) => r.managed).map((r) => r.name) };
  }

  async apiConfig(ws: string, appName: string, envName: string) {
    const { app, env } = await this.env(ws, appName, envName);
    return readConfig(this.envs.platformFor(app, env), envKey(app.name, env.slug));
  }

  async updateApiConfig(ws: string, appName: string, envName: string, patch: Record<string, unknown>, replace = false) {
    const { app, env } = await this.env(ws, appName, envName);
    const platform = this.envs.platformFor(app, env);
    const key = envKey(app.name, env.slug);
    const current = replace ? {} : ((await readConfig(platform, key)) as Record<string, unknown>);
    const r = await writeConfig(platform, key, mergeConfig(current, patch));
    await this.audit(ws, 'api_config.updated', `${appName}/${envName}`);
    return r;
  }

  async routePolicy(ws: string, appName: string, envName: string, route: string, policy: Record<string, unknown> | null) {
    const { app, env } = await this.env(ws, appName, envName);
    return setRoutePolicy(this.envs.platformFor(app, env), envKey(app.name, env.slug), route, policy as never);
  }

  async setProtection(ws: string, appName: string, envName: string, patch: unknown) {
    const p = ProtectionPatch.parse(patch);
    const { env } = await this.env(ws, appName, envName);
    const next = { ...DEFAULT_PROTECTION, ...(env.protection as Partial<ProtectionSettings>), ...p };
    await this.ctx.db.query('UPDATE environments SET protection = $2 WHERE id = $1', [env.id, JSON.stringify(next)]);
    await (this.ctx.routes.sync?.() ?? this.ctx.routes.bump());
    await this.audit(ws, 'protection.updated', `${appName}/${envName}`, p);
    return next;
  }

  async setCsp(ws: string, appName: string, envName: string, patch: unknown) {
    const p = CspPatch.parse(patch);
    const { env } = await this.env(ws, appName, envName);
    const next = { ...EMPTY_CSP, ...(env.csp as Partial<CspSettings>), ...p };
    await this.ctx.db.query('UPDATE environments SET csp = $2 WHERE id = $1', [env.id, JSON.stringify(next)]);
    await (this.ctx.routes.sync?.() ?? this.ctx.routes.bump());
    return next;
  }

  // -------------------------------------------------------------------------- observability

  async logs(ws: string, appName: string, envName: string, opts: { tail?: number; sinceMinutes?: number; grep?: string }) {
    const { env } = await this.env(ws, appName, envName);
    const rel = await this.runtime.liveRelease(env);
    if (!rel?.container) return 'No running backend in this environment.';
    let text = await this.ctx.docker.logs(rel.container, {
      tail: Math.min(opts.tail ?? 200, 2000),
      since: opts.sinceMinutes ? Math.floor(Date.now() / 1000) - opts.sinceMinutes * 60 : undefined,
    });
    if (opts.grep) {
      const needle = opts.grep.toLowerCase();
      text = text.split('\n').filter((l) => l.toLowerCase().includes(needle)).join('\n');
    }
    return text.slice(-60_000);
  }

  async metrics(ws: string, appName: string, envName: string) {
    const { env } = await this.env(ws, appName, envName);
    const m = await this.runtime.edgeMetrics().catch(() => null);
    const rel = await this.runtime.liveRelease(env);
    const container = rel?.container ? await this.ctx.docker.inspectOrNull(rel.container) : null;
    return {
      url: `https://${env.host}`,
      edge: m?.hosts?.[env.host] ?? { requests: 0 },
      backend: container ? { state: container.State.Status, health: container.State.Health?.Status, restarts: container.RestartCount, startedAt: container.State.StartedAt } : null,
      sleeping: env.sleeping,
    };
  }

  // -------------------------------------------------------------------------- edge integration

  async routeTable(): Promise<RouteTable> {
    const rows = (
      await this.ctx.db.query<EnvRow & { app_name: string; static_dir: string | null; container: string | null }>(
        `SELECT e.*, a.name AS app_name, d.static_dir, r.container
         FROM environments e JOIN apps a ON a.id = e.app_id
         JOIN releases r ON r.id = e.current_release_id
         JOIN deployments d ON d.id = r.deployment_id
         WHERE e.status = 'ready'`,
      )
    ).rows;
    const routes: Route[] = [];
    for (const e of rows) {
      const secret = (await this.ctx.db.query<{ value_enc: Buffer }>(`SELECT value_enc FROM env_vars WHERE env_id = $1 AND name = 'BASALT_EDGE_SECRET'`, [e.id])).rows[0];
      if (!secret || !e.auth_project_id) continue;
      const route: AppRoute = {
        kind: 'app',
        host: e.host,
        app: e.app_name,
        envId: e.id,
        env: e.kind,
        projectId: e.auth_project_id,
        edgeSecret: this.ctx.box.open(secret.value_enc, `env:${e.id}:BASALT_EDGE_SECRET`),
        staticDir: e.static_dir,
        backend: e.container ? `http://${e.container}:3000` : null,
        sleeping: e.sleeping,
        accessKey: this.envs.accessKey(e),
        protection: { ...DEFAULT_PROTECTION, ...(e.protection as Partial<ProtectionSettings>) },
        csp: { ...EMPTY_CSP, ...(e.csp as Partial<CspSettings>) },
        dataUrl: dataUrlFor(this.ctx.cfg.dataLink, e.data_project_id),
      };
      routes.push(route);
    }
    const root = this.ctx.cfg.ROOT_DOMAIN;
    routes.push({ kind: 'service', host: `registry.${root}`, upstream: this.ctx.cfg.REGISTRY_URL, methods: ['GET', 'HEAD'], perIpPerMinute: 1200 });
    // Basalt Cloud's owner pages (approvals, data map, safety receipt) and its API for Claude.
    if (this.ctx.cfg.dataLink) routes.push({ kind: 'service', host: `cloud.${root}`, upstream: this.ctx.cfg.dataLink.url, methods: ['GET', 'POST', 'PUT', 'OPTIONS'], perIpPerMinute: 600 });
    routes.push({ kind: 'service', host: `host.${root}`, upstream: `http://control:${this.ctx.cfg.PORT}`, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], perIpPerMinute: 600 });
    const attack = (await this.ctx.db.query<{ value: boolean }>(`SELECT value FROM platform_settings WHERE key = 'under_attack'`)).rows[0]?.value === true;
    return { version: this.ctx.routes.version, generatedAt: new Date().toISOString(), underAttack: attack, routes };
  }

  async wake(envId: string) {
    await this.runtime.wake(envId);
  }

  /** Mail from the auth service: captured for test environments, delivered for production. */
  async handleMail(rawBody: string, signature: string | undefined) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(signature ?? '');
    if (!m || Math.abs(Date.now() / 1000 - Number(m[1])) > 300) throw new UserError('bad signature', 401);
    const expected = createHmac('sha256', this.ctx.cfg.MAIL_WEBHOOK_SECRET).update(`${m[1]}.${rawBody}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(m[2]!, 'hex'))) throw new UserError('bad signature', 401);
    const msg = JSON.parse(rawBody) as { projectId: string; to: string; subject: string; text: string };
    const env = (await this.ctx.db.query<EnvRow>('SELECT * FROM environments WHERE auth_project_id = $1', [msg.projectId])).rows[0];
    if (!env) return;
    await this.ctx.db.query('INSERT INTO emails (env_id, to_addr, subject, body) VALUES ($1, $2, $3, $4)', [env.id, msg.to, msg.subject, msg.text]);
    await this.ctx.db.query(`DELETE FROM emails WHERE env_id = $1 AND id NOT IN (SELECT id FROM emails WHERE env_id = $1 ORDER BY id DESC LIMIT 200)`, [env.id]);
    if (env.kind !== 'production') return;
    if (!this.ctx.cfg.RESEND_API_KEY) {
      this.ctx.log.warn('production_mail_not_delivered', { env: env.id, note: 'Set RESEND_API_KEY to deliver production email.' });
      return;
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.ctx.cfg.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.ctx.cfg.MAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    if (!res.ok) throw new Error(`email provider responded ${res.status}`);
  }

  async setUnderAttack(on: boolean) {
    await this.ctx.db.query(`INSERT INTO platform_settings (key, value) VALUES ('under_attack', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(on)]);
    this.ctx.routes.bump();
  }

  /** On restart, anything mid-flight is marked interrupted so agents see a clear state. */
  async recover() {
    await this.ctx.db.query(`UPDATE deployments SET status = 'failed', error = 'interrupted by platform restart; deploy again', finished_at = now() WHERE status IN ('queued', 'building')`);
    await this.ctx.db.query(`UPDATE pipelines SET status = 'failed', finished_at = now(), log = log || '[{"stage":"error","message":"interrupted by platform restart"}]'::jsonb WHERE status = 'running'`);
    await this.ctx.db.query(`UPDATE test_runs SET status = 'error', finished_at = now() WHERE status = 'running'`);
    await this.ctx.db.query(`UPDATE releases SET status = 'failed', reason = 'interrupted', ended_at = now() WHERE status = 'starting'`);
  }
}
