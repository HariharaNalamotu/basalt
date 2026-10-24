import type { Ctx } from './ctx.js';
import { id } from './crypto.js';
import { hardened } from './docker.js';
import type { AppRow, EnvRow, Environments } from './environments.js';
import { networkName } from './naming.js';

export interface DeploymentRow {
  id: string;
  app_id: string;
  status: string;
  image: string | null;
  static_dir: string | null;
  manifest: { backend?: { entry: string } | null; frontend?: { output: string } | null; migrations?: boolean; e2e?: boolean; dataRules?: Record<string, unknown> | null } | null;
  steps: Array<{ name: string; status: string; output?: string; ms?: number }>;
  error: string | null;
  message: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface ReleaseRow {
  id: string;
  env_id: string;
  deployment_id: string;
  status: string;
  container: string | null;
  reason: string | null;
  created_at: Date;
  live_at: Date | null;
  ended_at: Date | null;
}

const HEALTH_TIMEOUT_MS = 90_000;

/**
 * Releases: zero-downtime switch (start new → healthy → route → drain old), instant rollback to
 * the previous release, automatic rollback when production starts failing, sleep/wake.
 */
export class Runtime {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly ctx: Ctx,
    private readonly envs: Environments,
  ) {}

  /** Serializes release operations per environment (also used for deletion). */
  serial<T>(envId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(envId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(envId, next.catch(() => {}));
    return next;
  }

  async liveRelease(env: EnvRow): Promise<ReleaseRow | null> {
    if (!env.current_release_id) return null;
    return (await this.ctx.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [env.current_release_id])).rows[0] ?? null;
  }

  async releases(envId: string, limit = 10) {
    return (await this.ctx.db.query<ReleaseRow>('SELECT * FROM releases WHERE env_id = $1 ORDER BY created_at DESC LIMIT $2', [envId, limit])).rows;
  }

  private memoryFor(env: EnvRow) {
    return env.kind === 'production' ? this.ctx.cfg.PRODUCTION_MEMORY_MB : this.ctx.cfg.APP_MEMORY_MB;
  }

  private async startContainer(app: AppRow, env: EnvRow, dep: DeploymentRow, releaseId: string): Promise<string> {
    const name = `basalt-app-${env.id}-${releaseId.slice(-8)}`;
    const memory = this.memoryFor(env);
    await this.ctx.docker.remove(name).catch(() => {});
    await this.ctx.docker.createContainer(name, {
      Image: dep.image,
      User: '10001:10001',
      WorkingDir: '/app',
      Cmd: ['node', `--max-old-space-size=${Math.floor(memory * 0.75)}`, dep.manifest!.backend!.entry],
      Env: [...(await this.envs.envVars(app, env)), 'HOME=/tmp'],
      Labels: { 'basalt.env': env.id, 'basalt.release': releaseId, 'basalt.app': app.name, 'basalt.kind': 'app' },
      Healthcheck: {
        Test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/_basalt/health'],
        Interval: 2e9,
        Timeout: 2e9,
        Retries: 3,
        StartPeriod: 2e9,
      },
      HostConfig: hardened({ memoryMb: memory, cpus: env.kind === 'production' ? 1 : 0.5, network: networkName(env.id), restart: true }),
    });
    await this.ctx.docker.start(name);
    return name;
  }

  private async waitHealthy(container: string): Promise<{ ok: boolean; reason?: string }> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const info = await this.ctx.docker.inspectOrNull(container);
      if (!info) return { ok: false, reason: 'container disappeared' };
      if (info.State.Status === 'exited' || info.State.Status === 'dead') {
        return { ok: false, reason: `process exited with code ${info.State.ExitCode}` };
      }
      if (info.State.Health?.Status === 'healthy') return { ok: true };
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ok: false, reason: 'health check did not pass within 90s' };
  }

  /** Runs db/migrations with the environment's admin role in a throwaway hardened container. */
  async migrate(app: AppRow, env: EnvRow, dep: DeploymentRow): Promise<{ ok: boolean; output: string }> {
    if (!dep.manifest?.migrations || !dep.image) return { ok: true, output: 'no migrations' };
    const vars = await this.envs.platformFor(app, env).readEnv(`${app.name}-${env.slug}`);
    const name = `basalt-migrate-${env.id}-${dep.id.slice(-8)}`;
    await this.ctx.docker.remove(name).catch(() => {});
    await this.ctx.docker.createContainer(name, {
      Image: dep.image,
      User: '10001:10001',
      WorkingDir: '/app',
      Cmd: ['node', '/opt/basalt/migrate.mjs', '/app/db/migrations'],
      Env: [`DATABASE_ADMIN_URL=${vars.DATABASE_ADMIN_URL!.value}`, 'HOME=/tmp'],
      Labels: { 'basalt.env': env.id, 'basalt.kind': 'migration' },
      HostConfig: hardened({ memoryMb: 256, cpus: 0.5, network: networkName(env.id) }),
    });
    await this.ctx.docker.start(name);
    const code = await Promise.race([this.ctx.docker.wait(name), new Promise<number>((r) => setTimeout(() => r(-1), 120_000))]);
    const output = await this.ctx.docker.logs(name, { tail: 200 }).catch(() => '');
    await this.ctx.docker.remove(name);
    // 2 = applied but some per-user tables are unprotected: surfaced as a warning, not a failure.
    return { ok: code === 0 || code === 2, output: code === -1 ? `${output}\nmigration timed out` : output };
  }

  /** Deploys a built deployment to an environment with zero downtime. */
  release(app: AppRow, env: EnvRow, dep: DeploymentRow, reason = 'deploy'): Promise<ReleaseRow> {
    return this.serial(env.id, async () => {
      await this.assertActive(env.id);
      const releaseId = id('rel');
      await this.ctx.db.query('INSERT INTO releases (id, env_id, deployment_id, reason) VALUES ($1, $2, $3, $4)', [releaseId, env.id, dep.id, reason]);
      const fail = async (why: string) => {
        await this.ctx.db.query(`UPDATE releases SET status = 'failed', reason = $2, ended_at = now() WHERE id = $1`, [releaseId, why.slice(0, 4000)]);
        throw new Error(why);
      };

      const migration = await this.migrate(app, env, dep);
      if (!migration.ok) await fail(`migrations failed:\n${migration.output.slice(-3000)}`);

      let container: string | null = null;
      if (dep.manifest?.backend && dep.image) {
        container = await this.startContainer(app, env, dep, releaseId);
        const health = await this.waitHealthy(container);
        if (!health.ok) {
          const logs = await this.ctx.docker.logs(container, { tail: 80 }).catch(() => '');
          await this.ctx.docker.remove(container);
          await fail(`backend did not become healthy (${health.reason}). Last logs:\n${logs.slice(-3000)}`);
        }
      }

      const previous = await this.liveRelease((await this.envs.get(env.id))!);
      await this.ctx.db.tx(async (q) => {
        await q(`UPDATE releases SET status = 'live', container = $2, live_at = now() WHERE id = $1`, [releaseId, container]);
        await q(`UPDATE environments SET current_release_id = $2, sleeping = false, last_active_at = now() WHERE id = $1`, [env.id, releaseId]);
        if (previous) await q(`UPDATE releases SET status = 'superseded', ended_at = now() WHERE id = $1`, [previous.id]);
      });
      await (this.ctx.routes.sync?.() ?? this.ctx.routes.bump());

      // Drain: the edge picks up the new table within ~1s; give in-flight requests time to finish.
      if (previous?.container) {
        const old = previous.container;
        setTimeout(() => void this.ctx.docker.stop(old, 10).catch(() => {}), 15_000).unref();
      }
      await this.pruneOld(env.id);
      if (env.kind === 'production') this.watch(app, env.id, releaseId);
      return (await this.ctx.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [releaseId])).rows[0]!;
    });
  }

  /** Keeps the last 3 release containers (stopped) for instant rollback; removes the rest. */
  private async pruneOld(envId: string) {
    const old = (await this.ctx.db.query<ReleaseRow>(`SELECT * FROM releases WHERE env_id = $1 AND status <> 'live' AND container IS NOT NULL ORDER BY created_at DESC OFFSET 3`, [envId])).rows;
    for (const r of old) {
      await this.ctx.docker.remove(r.container!).catch(() => {});
      await this.ctx.db.query('UPDATE releases SET container = NULL WHERE id = $1', [r.id]);
    }
  }

  /** Rolls back to a specific release (default: the most recent superseded one). */
  rollback(app: AppRow, env: EnvRow, toReleaseId?: string, reason = 'manual rollback'): Promise<ReleaseRow> {
    return this.serial(env.id, async () => {
      await this.assertActive(env.id);
      const current = await this.liveRelease(env);
      const target = toReleaseId
        ? (await this.ctx.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1 AND env_id = $2', [toReleaseId, env.id])).rows[0]
        : (await this.ctx.db.query<ReleaseRow>(`SELECT * FROM releases WHERE env_id = $1 AND status IN ('superseded', 'rolled_back') AND id <> $2 ORDER BY live_at DESC NULLS LAST LIMIT 1`, [env.id, current?.id ?? ''])).rows[0];
      if (!target) throw new Error('There is no previous release to roll back to.');
      const dep = (await this.ctx.db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [target.deployment_id])).rows[0]!;
      let container = target.container;
      if (dep.manifest?.backend) {
        const exists = container ? await this.ctx.docker.inspectOrNull(container) : null;
        if (exists) await this.ctx.docker.start(container!).catch(() => {});
        else container = await this.startContainer(app, env, dep, target.id);
        const health = await this.waitHealthy(container!);
        if (!health.ok) throw new Error(`Rollback target is not healthy: ${health.reason}`);
      }
      await this.ctx.db.tx(async (q) => {
        await q(`UPDATE releases SET status = 'live', container = $2, live_at = now(), ended_at = NULL WHERE id = $1`, [target.id, container]);
        await q(`UPDATE environments SET current_release_id = $2, sleeping = false WHERE id = $1`, [env.id, target.id]);
        if (current) await q(`UPDATE releases SET status = 'rolled_back', reason = $2, ended_at = now() WHERE id = $1`, [current.id, reason]);
      });
      await (this.ctx.routes.sync?.() ?? this.ctx.routes.bump());
      if (current?.container && current.container !== container) {
        const c = current.container;
        setTimeout(() => void this.ctx.docker.stop(c, 10).catch(() => {}), 10_000).unref();
      }
      this.ctx.log.warn('rolled_back', { env: env.id, from: current?.id, to: target.id, reason });
      return (await this.ctx.db.query<ReleaseRow>('SELECT * FROM releases WHERE id = $1', [target.id])).rows[0]!;
    });
  }

  /**
   * Post-release guard for production: for 3 minutes, roll back automatically if the backend
   * becomes unhealthy or most requests fail.
   */
  private watch(app: AppRow, envId: string, releaseId: string) {
    const started = Date.now();
    const tick = async () => {
      const env = await this.envs.get(envId);
      // Stop watching once superseded, after 3 minutes, or when the environment is being deleted.
      if (!env || env.status !== 'ready' || env.current_release_id !== releaseId || Date.now() - started > 180_000) return;
      const rel = await this.liveRelease(env);
      let reason: string | null = null;
      if (rel?.container) {
        const info = await this.ctx.docker.inspectOrNull(rel.container);
        if (!info || info.State.Health?.Status === 'unhealthy' || info.State.Status !== 'running') reason = 'backend became unhealthy after release';
      }
      if (!reason) {
        const m = await this.edgeMetrics().catch(() => null);
        const h = m?.hosts?.[env.host] as { last2m?: { requests: number; errors5xx: number } } | undefined;
        if (h?.last2m && h.last2m.requests >= 20 && h.last2m.errors5xx / h.last2m.requests > 0.3) {
          reason = `error rate ${Math.round((100 * h.last2m.errors5xx) / h.last2m.requests)}% after release`;
        }
      }
      if (reason) {
        await this.rollback(app, env, undefined, `automatic: ${reason}`).catch((err) => this.ctx.log.error('auto_rollback_failed', { err }));
        return;
      }
      setTimeout(() => void tick(), 10_000).unref();
    };
    setTimeout(() => void tick(), 10_000).unref();
  }

  private async assertActive(envId: string) {
    const env = await this.envs.get(envId);
    if (!env || env.status === 'deleting') throw new Error('This environment is being deleted.');
  }

  async edgeMetrics(): Promise<{ hosts: Record<string, unknown> }> {
    const res = await fetch(`${this.ctx.cfg.EDGE_ADMIN_URL}/metrics`, { headers: { authorization: `Bearer ${this.ctx.cfg.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(3000) });
    return (await res.json()) as { hosts: Record<string, unknown> };
  }

  /** Restarts the live release with fresh env vars (secrets/config change), zero downtime. */
  async restartLive(app: AppRow, env: EnvRow) {
    const rel = await this.liveRelease(env);
    if (!rel) return;
    const dep = (await this.ctx.db.query<DeploymentRow>('SELECT * FROM deployments WHERE id = $1', [rel.deployment_id])).rows[0]!;
    await this.release(app, env, dep, 'config change');
  }

  async exec(env: EnvRow, cmd: string[]) {
    const rel = await this.liveRelease(env);
    if (!rel?.container) return { exitCode: 1, output: 'no running backend' };
    return this.ctx.docker.exec(rel.container, cmd);
  }

  async wake(envId: string) {
    const env = await this.envs.get(envId);
    if (!env?.sleeping || env.status !== 'ready') return;
    await this.serial(envId, async () => {
      await this.assertActive(envId);
      const rel = await this.liveRelease(env);
      if (rel?.container) {
        await this.ctx.docker.start(rel.container).catch(() => {});
        const h = await this.waitHealthy(rel.container);
        if (!h.ok) throw new Error(`wake failed: ${h.reason}`);
      }
      await this.ctx.db.query('UPDATE environments SET sleeping = false, last_active_at = now() WHERE id = $1', [envId]);
      await (this.ctx.routes.sync?.() ?? this.ctx.routes.bump());
    });
  }

  /**
   * Housekeeping: record activity from the edge, put idle non-production environments to sleep,
   * delete expired previews.
   */
  async janitor(apps: { get(id: string): Promise<AppRow | null> }) {
    // Resume deletions interrupted by a restart or crash.
    for (const env of (await this.ctx.db.query<EnvRow>(`SELECT * FROM environments WHERE status = 'deleting'`)).rows) {
      const app = await apps.get(env.app_id);
      if (app) await this.serial(env.id, () => this.envs.destroy(app, env)).catch((err) => this.ctx.log.error('destroy_retry_failed', { env: env.id, err }));
    }
    const metrics = await this.edgeMetrics().catch(() => null);
    const all = (await this.ctx.db.query<EnvRow>(`SELECT * FROM environments WHERE status = 'ready'`)).rows;
    for (const env of all) {
      const last = (metrics?.hosts?.[env.host] as { lastRequestAt?: string } | undefined)?.lastRequestAt;
      if (last && new Date(last) > env.last_active_at) {
        await this.ctx.db.query('UPDATE environments SET last_active_at = $2 WHERE id = $1', [env.id, new Date(last)]);
        env.last_active_at = new Date(last);
      }
      const app = await apps.get(env.app_id);
      if (!app) continue;
      if (env.kind === 'preview' && env.expires_at && env.expires_at < new Date()) {
        this.ctx.log.info('preview_expired', { env: env.id });
        await this.ctx.db.query(`UPDATE environments SET status = 'deleting' WHERE id = $1`, [env.id]);
        await this.serial(env.id, () => this.envs.destroy(app, env)).catch((err) => this.ctx.log.error('destroy_failed', { err }));
        continue;
      }
      const idleMs = Date.now() - env.last_active_at.getTime();
      if (env.kind !== 'production' && !env.sleeping && env.current_release_id && idleMs > this.ctx.cfg.SLEEP_AFTER_MINUTES * 60_000) {
        await this.serial(env.id, async () => {
          const rel = await this.liveRelease(env);
          if (rel?.container) await this.ctx.docker.stop(rel.container, 10).catch(() => {});
          await this.ctx.db.query('UPDATE environments SET sleeping = true WHERE id = $1', [env.id]);
          await (this.ctx.routes.sync?.() ?? this.ctx.routes.bump());
        });
      }
    }
  }
}
