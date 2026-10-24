import { randomBytes } from 'node:crypto';
import { LocalPlatform, type EnvVar } from '@basalt/api-mcp';
import { signEdgeRequest } from '@basalt/api';
import type { Ctx } from './ctx.js';

/**
 * The Basalt-hosted implementation of the API tools' platform interface, for ONE environment.
 * Env vars live encrypted in the control-plane database; Redis gets a per-environment ACL user
 * confined to that environment's key prefix; databases/roles reuse the reference implementation.
 */
export class HostedPlatform extends LocalPlatform {
  constructor(
    private readonly ctx: Ctx,
    private readonly envId: string,
    private readonly key: string,
    private readonly hooks: { apply?: () => Promise<void>; exec?: (cmd: string[]) => Promise<{ exitCode: number; output: string }> } = {},
  ) {
    super({ pgAdminUrl: ctx.cfg.PG_ADMIN_URL, redisUrl: '', stateDir: '/tmp/basalt-unused' });
  }

  override describe() {
    return `Basalt Host (${this.ctx.cfg.ROOT_DOMAIN})`;
  }

  private check(app: string) {
    if (app !== this.key) throw new Error(`This environment is "${this.key}", not "${app}".`);
  }

  override async readEnv(app: string): Promise<Record<string, EnvVar>> {
    this.check(app);
    const { rows } = await this.ctx.db.query<{ name: string; value_enc: Buffer; secret: boolean }>('SELECT name, value_enc, secret FROM env_vars WHERE env_id = $1', [this.envId]);
    return Object.fromEntries(rows.map((r) => [r.name, { value: this.ctx.box.open(r.value_enc, `env:${this.envId}:${r.name}`), secret: r.secret }]));
  }

  override async writeEnv(app: string, vars: Record<string, EnvVar | null>, managed = true) {
    this.check(app);
    await this.ctx.db.tx(async (q) => {
      for (const [name, v] of Object.entries(vars)) {
        if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`Invalid env var name ${name}`);
        if (v === null) await q('DELETE FROM env_vars WHERE env_id = $1 AND name = $2', [this.envId, name]);
        else {
          await q(
            `INSERT INTO env_vars (env_id, name, value_enc, secret, managed) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (env_id, name) DO UPDATE SET value_enc = $3, secret = $4, managed = $5, updated_at = now()`,
            [this.envId, name, this.ctx.box.seal(v.value, `env:${this.envId}:${name}`), v.secret, managed],
          );
        }
      }
    });
  }

  override async ensureRedis(app: string) {
    this.check(app);
    const env = await this.readEnv(app);
    if (env.REDIS_URL) return { created: false, env: { REDIS_URL: env.REDIS_URL } };
    const user = `u_${this.envId}`;
    const pw = randomBytes(24).toString('base64url');
    // Keys are confined after the auth project exists (see restrictRedis).
    await this.ctx.redis.call('ACL', 'SETUSER', user, 'reset', 'on', `>${pw}`, 'resetkeys', 'resetchannels', '-@all', '+ping');
    await this.ctx.redis.call('ACL', 'SAVE').catch(() => {}); // persist across Redis restarts
    return { created: true, env: { REDIS_URL: { value: `redis://${user}:${pw}@${this.ctx.cfg.REDIS_HOST}`, secret: true } } };
  }

  /** Confines the environment's Redis user to its project's key prefix and the commands the framework uses. */
  async restrictRedis(projectId: string) {
    await this.ctx.redis.call(
      'ACL', 'SETUSER', `u_${this.envId}`, 'resetkeys', `~bapi:${projectId}:*`, '-@all',
      '+ping', '+info', '+hello', '+auth', '+select', '+client|setname', '+client|setinfo',
      '+get', '+set', '+del', '+incr', '+pexpire', '+expire', '+eval', '+evalsha', '+script|load',
    );
    await this.ctx.redis.call('ACL', 'SAVE').catch(() => {});
  }

  override async configureEdge() {
    // The edge reads BASALT_EDGE_SECRET from the route table the control plane publishes.
    this.ctx.routes.bump();
  }

  override async applyChanges(app: string) {
    this.check(app);
    if (this.hooks.apply) {
      await this.hooks.apply();
      return { applied: true, note: 'Rolled out to the running release.' };
    }
    return { applied: true, note: 'Takes effect on the next deploy to this environment.' };
  }

  override async callBackend(app: string, pathAndQuery: string): Promise<Response> {
    this.check(app);
    if (!this.hooks.exec) throw new Error('No running release.');
    const env = await this.readEnv(app);
    const requestId = `ctl-${randomBytes(8).toString('hex')}`;
    const sig = signEdgeRequest(env.BASALT_EDGE_SECRET!.value, { method: 'GET', pathAndQuery, requestId });
    const r = await this.hooks.exec(['wget', '-qO-', '--header', `x-request-id: ${requestId}`, '--header', `basalt-edge-signature: ${sig}`, `http://127.0.0.1:3000${pathAndQuery}`]);
    return new Response(r.output, { status: r.exitCode === 0 ? 200 : 502, headers: { 'content-type': 'application/json' } });
  }
}
