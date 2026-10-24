import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import https from 'node:https';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { signToken } from '@basalt/host-shared';
import type { Ctx } from './ctx.js';
import { id } from './crypto.js';
import { hardened } from './docker.js';
import type { AppRow, EnvRow, Environments } from './environments.js';
import type { DeploymentRow } from './runtime.js';

export interface TestRunRow {
  id: string;
  env_id: string;
  deployment_id: string;
  kind: 'smoke' | 'e2e';
  status: 'running' | 'passed' | 'failed' | 'error';
  summary: Record<string, unknown>;
  created_at: Date;
  finished_at: Date | null;
}

export const PLAYWRIGHT_VERSION = '1.64';

export class Testing {
  constructor(
    private readonly ctx: Ctx,
    private readonly envs: Environments,
  ) {}

  /** Short-lived signed access for one non-production environment. */
  accessToken(env: EnvRow, ttlSeconds = 3600): string | null {
    const key = this.envs.accessKey(env);
    return key ? signToken(key, { env: env.id, exp: Math.floor(Date.now() / 1000) + ttlSeconds }) : null;
  }

  shareLink(env: EnvRow, ttlMinutes: number): string {
    const token = this.accessToken(env, ttlMinutes * 60);
    return token ? `https://${env.host}/_basalt/access?t=${token}` : `https://${env.host}/`;
  }

  /** GET through the internal TLS edge with the environment's Host and access token. */
  async edgeGet(env: EnvRow, p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
    const token = this.accessToken(env, 300);
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: 'edge',
          port: 443,
          path: p,
          method: 'GET',
          servername: env.host,
          rejectUnauthorized: false,
          headers: { host: env.host, accept: 'text/html,application/json', ...(token ? { 'x-basalt-access': token } : {}), ...headers },
          timeout: 15_000,
        },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: body.slice(0, 20_000), headers: res.headers }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    });
  }

  private async record(env: EnvRow, dep: DeploymentRow, kind: 'smoke' | 'e2e') {
    const runId = id('run');
    await this.ctx.db.query('INSERT INTO test_runs (id, env_id, deployment_id, kind) VALUES ($1, $2, $3, $4)', [runId, env.id, dep.id, kind]);
    return async (status: TestRunRow['status'], summary: Record<string, unknown>) => {
      await this.ctx.db.query('UPDATE test_runs SET status = $2, summary = $3, finished_at = now() WHERE id = $1', [runId, status, JSON.stringify(summary)]);
      return (await this.ctx.db.query<TestRunRow>('SELECT * FROM test_runs WHERE id = $1', [runId])).rows[0]!;
    };
  }

  /** Smoke test through the real edge: home page (frontend) and backend health/introspection. */
  async smoke(app: AppRow, env: EnvRow, dep: DeploymentRow): Promise<TestRunRow> {
    const finish = await this.record(env, dep, 'smoke');
    const checks: Array<{ check: string; ok: boolean; detail?: string }> = [];
    // The edge refreshes its route table every second.
    await new Promise((r) => setTimeout(r, 1500));
    try {
      if (dep.manifest?.frontend) {
        const r = await this.edgeGet(env, '/');
        checks.push({ check: 'GET / returns the app (200, HTML)', ok: r.status === 200 && /<html|<!doctype/i.test(r.body), detail: `status ${r.status}` });
        const csp = String(r.headers['content-security-policy'] ?? '');
        checks.push({ check: 'security headers present (CSP)', ok: csp.includes("default-src 'self'") });
      }
      if (dep.manifest?.backend) {
        const intro = await this.envs.platformFor(app, (await this.envs.get(env.id))!).callBackend(`${app.name}-${env.slug}`, '/_basalt/introspect').catch(() => null);
        checks.push({ check: 'backend is running and answers signed requests', ok: Boolean(intro?.ok), detail: intro ? `status ${intro.status}` : 'unreachable' });
        const anon = await this.edgeGet(env, '/api/__basalt_smoke__', { accept: 'application/json' });
        checks.push({ check: 'API reachable through the edge', ok: [401, 404, 405].includes(anon.status), detail: `status ${anon.status}` });
      }
    } catch (err) {
      checks.push({ check: 'edge reachable', ok: false, detail: (err as Error).message });
    }
    return finish(checks.every((c) => c.ok) ? 'passed' : 'failed', { checks });
  }

  async createTestUser(app: AppRow, env: EnvRow): Promise<{ email: string; password: string }> {
    if (env.kind === 'production') throw new Error('Test users can only be created in preview or staging environments.');
    if (!env.auth_project_id) throw new Error('Environment is not provisioned.');
    const email = `test-${randomBytes(5).toString('hex')}@test.basalt.invalid`;
    const password = `T3st-${randomBytes(12).toString('base64url')}`;
    const res = await fetch(`${this.ctx.cfg.AUTH_INTERNAL_URL}/v1/platform/projects/${env.auth_project_id}/users`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.ctx.cfg.AUTH_PLATFORM_KEY}`, 'x-basalt-owner': app.workspace_id, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`Could not create a test user: ${await res.text()}`);
    return { email, password };
  }

  /**
   * Runs the app's Playwright suite (e2e/*.spec.ts) in a sandbox that can reach ONLY the edge,
   * against the environment over https, with a fresh verified test user.
   */
  async e2e(app: AppRow, env: EnvRow, dep: DeploymentRow, workDir: string): Promise<TestRunRow> {
    const finish = await this.record(env, dep, 'e2e');
    if (!dep.manifest?.e2e) return finish('passed', { skipped: true, note: 'No e2e/*.spec.ts files. Add Playwright tests to verify user flows.' });
    const pwPkg = await readFile(path.join(workDir, 'node_modules/@playwright/test/package.json'), 'utf8').catch(() => null);
    const pwVersion = pwPkg ? (JSON.parse(pwPkg) as { version: string }).version : null;
    if (!pwVersion?.startsWith(PLAYWRIGHT_VERSION)) {
      return finish('error', { error: `Add "@playwright/test": "~${PLAYWRIGHT_VERSION}.0" to devDependencies (found ${pwVersion ?? 'none'}). The platform's browsers are Playwright ${PLAYWRIGHT_VERSION}.` });
    }
    const runId = id('e2e');
    const outRel = path.join('test-runs', env.id, runId);
    const out = path.join(this.ctx.cfg.DATA_DIR, outRel);
    await mkdir(out, { recursive: true });
    const hasConfig = await readFile(path.join(workDir, 'playwright.config.ts'), 'utf8').then(() => true, () => false);
    await writeFile(
      path.join(out, 'basalt.config.ts'),
      `import { defineConfig } from '@playwright/test';
${hasConfig ? "import base from '/work/playwright.config.ts';" : 'const base: any = {};'}
export default defineConfig({
  ...base,
  testDir: '/work/e2e',
  outputDir: '/out/test-results',
  reporter: [['json', { outputFile: '/out/results.json' }], ['list']],
  workers: 2,
  retries: 0,
  timeout: 30_000,
  webServer: undefined,
  use: {
    ...(base.use ?? {}),
    baseURL: process.env.BASE_URL,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { ...(base.use?.extraHTTPHeaders ?? {}), 'x-basalt-access': process.env.BASALT_ACCESS ?? '' },
    trace: 'off',
    screenshot: 'only-on-failure',
  },
});
`,
    );
    await symlink('/work/node_modules', path.join(out, 'node_modules')).catch(() => {});
    if (process.getuid?.() === 0) {
      const { chown } = await import('node:fs/promises');
      await chown(out, 10001, 10001);
      await chown(path.join(out, 'basalt.config.ts'), 10001, 10001);
    }
    const user = await this.createTestUser(app, env);
    const net = `basalt-test-${runId}`;
    const cname = `basalt-e2e-${runId}`;
    try {
      await this.ctx.docker.createNetwork(net, { Driver: 'bridge', Internal: true, Labels: { 'basalt.test': runId } });
      await this.ctx.docker.connect(net, this.ctx.cfg.EDGE_CONTAINER, ['edge']);
      const info = await this.ctx.docker.inspectNetwork(net);
      const edgeIp = (Object.values(info.Containers ?? {}) as Array<{ Name: string; IPv4Address: string }>).find((c) => c.Name === this.ctx.cfg.EDGE_CONTAINER)?.IPv4Address.split('/')[0];
      if (!edgeIp) throw new Error('edge not reachable on the test network');
      await this.ctx.docker.createContainer(cname, {
        Image: this.ctx.cfg.TEST_IMAGE,
        User: '10001:10001',
        WorkingDir: '/work',
        Cmd: ['npx', 'playwright', 'test', '-c', '/out/basalt.config.ts'],
        Env: [
          `BASE_URL=https://${env.host}`,
          `BASALT_ACCESS=${this.accessToken(env, 1800) ?? ''}`,
          `TEST_USER_EMAIL=${user.email}`,
          `TEST_USER_PASSWORD=${user.password}`,
          'HOME=/tmp',
          'CI=1',
        ],
        Labels: { 'basalt.kind': 'e2e', 'basalt.env': env.id },
        HostConfig: {
          ...hardened({
            memoryMb: this.ctx.cfg.TEST_MEMORY_MB,
            cpus: 2,
            pids: 2048,
            network: net,
            tmpfsMb: 512,
            extraHosts: [`${env.host}:${edgeIp}`],
            mounts: [
              { Type: 'volume', Source: this.ctx.cfg.DATA_VOLUME, Target: '/work', ReadOnly: true, VolumeOptions: { Subpath: path.relative(this.ctx.cfg.DATA_DIR, workDir) } },
              { Type: 'volume', Source: this.ctx.cfg.DATA_VOLUME, Target: '/out', VolumeOptions: { Subpath: outRel } },
            ],
          }),
          ShmSize: 256 * 1024 * 1024,
        },
      });
      await this.ctx.docker.start(cname);
      const code = await Promise.race([this.ctx.docker.wait(cname), new Promise<number>((r) => setTimeout(() => r(-1), 10 * 60_000))]);
      const log = await this.ctx.docker.logs(cname, { tail: 200 }).catch(() => '');
      const results = await readFile(path.join(out, 'results.json'), 'utf8').then((t) => JSON.parse(t), () => null);
      const summary = summarize(results);
      if (!results) return finish('error', { exitCode: code, error: code === -1 ? 'Test run timed out (10 min).' : 'Playwright produced no results.', log: log.slice(-6000) });
      return finish(summary.failed > 0 || code !== 0 ? 'failed' : 'passed', { ...summary, log: log.slice(-4000) });
    } catch (err) {
      return finish('error', { error: (err as Error).message });
    } finally {
      await this.ctx.docker.remove(cname).catch(() => {});
      await this.ctx.docker.disconnect(net, this.ctx.cfg.EDGE_CONTAINER).catch(() => {});
      await this.ctx.docker.removeNetwork(net).catch(() => {});
      await rm(path.join(out, 'node_modules'), { force: true }).catch(() => {});
    }
  }

  async latest(envId: string, deploymentId?: string) {
    return (
      await this.ctx.db.query<TestRunRow>(
        `SELECT * FROM test_runs WHERE env_id = $1 AND ($2::text IS NULL OR deployment_id = $2) ORDER BY created_at DESC LIMIT 10`,
        [envId, deploymentId ?? null],
      )
    ).rows;
  }

  async emails(envId: string, limit = 20) {
    return (await this.ctx.db.query('SELECT to_addr AS to, subject, body, created_at FROM emails WHERE env_id = $1 ORDER BY id DESC LIMIT $2', [envId, limit])).rows;
  }
}

function summarize(r: any) {
  if (!r) return { passed: 0, failed: 0, skipped: 0, failures: [] as unknown[] };
  const failures: Array<{ test: string; error: string }> = [];
  const walk = (suite: any, prefix: string[]) => {
    for (const s of suite.suites ?? []) walk(s, [...prefix, s.title].filter(Boolean));
    for (const spec of suite.specs ?? []) {
      for (const t of spec.tests ?? []) {
        const last = t.results?.[t.results.length - 1];
        if (last && last.status !== 'passed' && last.status !== 'skipped') {
          failures.push({ test: [...prefix, spec.title].join(' › '), error: String(last.error?.message ?? last.status).replace(/\u001b\[[0-9;]*m/g, '').slice(0, 1500) });
        }
      }
    }
  };
  walk(r, []);
  const st = r.stats ?? {};
  return { passed: st.expected ?? 0, failed: (st.unexpected ?? 0) + (st.flaky ?? 0), skipped: st.skipped ?? 0, durationMs: st.duration, failures: failures.slice(0, 20) };
}
