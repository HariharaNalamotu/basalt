import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpControlPlane } from '@basalt/auth-mcp';
import { createHarness, PLATFORM_KEY, type Harness } from '../../../../auth/packages/server/test/helpers.js';
import { apiGuide, LocalPlatform, registerApiTools, reviewApiCode, scaffold, TOPICS, type ApiPlatform, type EnvVar } from '../src/index.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});

/** In-memory platform that records what the tools asked for. */
class FakePlatform implements ApiPlatform {
  envs = new Map<string, Record<string, EnvVar>>();
  sql: string[] = [];
  dbCreated = new Set<string>();
  applied = 0;
  unprotected: Array<{ table_name: string; owner_like_column: string }> = [];
  describe() {
    return 'fake';
  }
  async readEnv(app: string) {
    return { ...(this.envs.get(app) ?? {}) };
  }
  async writeEnv(app: string, vars: Record<string, EnvVar | null>) {
    const env = { ...(this.envs.get(app) ?? {}) };
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) delete env[k];
      else env[k] = v;
    }
    this.envs.set(app, env);
  }
  async ensureDatabase(app: string) {
    const created = !this.dbCreated.has(app);
    this.dbCreated.add(app);
    return {
      created,
      database: `basalt_${app}`,
      appRole: `basalt_${app}_app`,
      adminRole: `basalt_${app}_admin`,
      env: {
        DATABASE_URL: { value: `postgres://basalt_${app}_app:pw@db/basalt_${app}`, secret: true },
        DATABASE_ADMIN_URL: { value: `postgres://basalt_${app}_admin:pw@db/basalt_${app}`, secret: true },
      },
    };
  }
  async adminQuery(_app: string, sql: string) {
    this.sql.push(sql);
    if (sql.includes("to_regclass('basalt_auth.keys')")) return [{ ok: this.sql.some((s) => s.includes('CREATE SCHEMA IF NOT EXISTS basalt_auth')) }];
    if (sql.includes('unprotected_tables')) return this.unprotected;
    if (sql.includes('FROM pg_roles')) return [{ rolsuper: false, rolbypassrls: false }];
    return [];
  }
  async ensureRedis(app: string) {
    const env = this.envs.get(app) ?? {};
    return { created: !env.REDIS_URL, env: { REDIS_URL: env.REDIS_URL ?? { value: 'redis://cache:6379', secret: true } } };
  }
  async configureEdge() {}
  async applyChanges() {
    this.applied++;
    return { applied: true };
  }
}

async function connect(platform: ApiPlatform, owner = 'ws_api') {
  const auth = new HttpControlPlane('https://auth.test', PLATFORM_KEY, owner, async (input, init) => {
    const url = new URL(String(input));
    return h.app.request(url.pathname + url.search, init as RequestInit);
  });
  const server = new McpServer({ name: 'test', version: '0' });
  registerApiTools(server, { platform, auth });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'agent', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
  };
  return { client, call, auth };
}

describe('api_setup provisions everything, idempotently', () => {
  it('creates auth project, edge secret, database, protection, redis and env — without revealing secrets', async () => {
    const p = new FakePlatform();
    const { call } = await connect(p);
    const r = await call('api_setup', { app: 'todo-app', origins: ['http://localhost:8080'] });
    expect(r.isError).toBe(false);
    const env = p.envs.get('todo-app')!;
    for (const k of ['BASALT_PROJECT_ID', 'BASALT_AUTH_URL', 'BASALT_AUTH_SECRET_KEY', 'BASALT_EDGE_SECRET', 'DATABASE_URL', 'DATABASE_ADMIN_URL', 'REDIS_URL', 'BASALT_API_CONFIG']) {
      expect(env[k], k).toBeTruthy();
    }
    expect(env.BASALT_AUTH_SECRET_KEY!.secret).toBe(true);
    expect(env.BASALT_EDGE_SECRET!.value.length).toBeGreaterThanOrEqual(43);
    // Secrets never appear in what the agent sees.
    for (const k of ['BASALT_AUTH_SECRET_KEY', 'BASALT_EDGE_SECRET', 'DATABASE_URL', 'DATABASE_ADMIN_URL']) expect(r.text).not.toContain(env[k]!.value);
    expect(r.text).toContain(env.BASALT_PROJECT_ID!.value);
    expect(p.sql.some((s) => s.includes('CREATE OR REPLACE FUNCTION basalt_auth.uid()'))).toBe(true);
    const project = await h.request('GET', `/v1/platform/projects/${env.BASALT_PROJECT_ID!.value}`, { bearer: PLATFORM_KEY, owner: 'ws_api' });
    expect(((await project.json()) as any).project.allowedOrigins).toEqual(['http://localhost:8080']);
  });

  it('re-running keeps the same project and secrets and only adds new origins', async () => {
    const p = new FakePlatform();
    const { call } = await connect(p);
    await call('api_setup', { app: 'shop', origins: ['http://localhost:8080'] });
    const before = structuredClone(p.envs.get('shop')!);
    const again = await call('api_setup', { app: 'shop', origins: ['https://shop.example.com'] });
    expect(again.text).toMatch(/added origins/);
    const after = p.envs.get('shop')!;
    for (const k of ['BASALT_PROJECT_ID', 'BASALT_AUTH_SECRET_KEY', 'BASALT_EDGE_SECRET', 'REDIS_URL']) expect(after[k], k).toEqual(before[k]);
    const project = await h.request('GET', `/v1/platform/projects/${after.BASALT_PROJECT_ID!.value}`, { bearer: PLATFORM_KEY, owner: 'ws_api' });
    expect(((await project.json()) as any).project.allowedOrigins).toEqual(['http://localhost:8080', 'https://shop.example.com']);
  });

  it('rejects bad app names and insecure origins', async () => {
    const { call } = await connect(new FakePlatform());
    expect((await call('api_setup', { app: 'Bad Name' })).isError).toBe(true);
    const r = await call('api_setup', { app: 'okapp', origins: ['http://evil.example'] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/https/);
  });
});

describe('configuration through MCP', () => {
  async function ready() {
    const p = new FakePlatform();
    const c = await connect(p);
    await c.call('api_setup', { app: 'cfg-app' });
    const config = () => JSON.parse(p.envs.get('cfg-app')!.BASALT_API_CONFIG!.value);
    return { p, ...c, config };
  }

  it('updates, merges, removes and replaces config with validation', async () => {
    const { call, config } = await ready();
    expect((await call('api_update_config', { app: 'cfg-app', config: { limits: { defaultTimeoutMs: 5000 }, logLevel: 'debug' } })).isError).toBe(false);
    expect((await call('api_update_config', { app: 'cfg-app', config: { limits: { maxInFlight: 100 } } })).isError).toBe(false);
    expect(config()).toEqual({ limits: { defaultTimeoutMs: 5000, maxInFlight: 100 }, logLevel: 'debug' });
    await call('api_update_config', { app: 'cfg-app', config: { logLevel: null } });
    expect(config().logLevel).toBeUndefined();
    await call('api_update_config', { app: 'cfg-app', config: { revocationSync: true }, replace: true });
    expect(config()).toEqual({ revocationSync: true });
  });

  it('rejects out-of-bounds or unknown settings and writes nothing', async () => {
    const { call, config } = await ready();
    const before = config();
    for (const bad of [{ limits: { defaultTimeoutMs: 999_999 } }, { allowedOrigins: ['http://evil.example'] }, { surpriseKnob: 1 }, { routes: { 'GET /x': { auth: 'public' } } }]) {
      const r = await call('api_update_config', { app: 'cfg-app', config: bad });
      expect(r.isError, JSON.stringify(bad)).toBe(true);
      expect(r.text).toMatch(/nothing changed/);
    }
    expect(config()).toEqual(before);
  });

  it('sets and clears per-route policies; auth can only be tightened', async () => {
    const { call, config } = await ready();
    const r = await call('api_set_route_policy', { app: 'cfg-app', route: 'POST /todos', policy: { rateLimit: { limit: 10, windowSeconds: 60 }, auth: { mfa: true } } });
    expect(r.isError).toBe(false);
    expect(config().routes['POST /todos']).toEqual({ rateLimit: { limit: 10, windowSeconds: 60 }, auth: { mfa: true } });
    expect((await call('api_set_route_policy', { app: 'cfg-app', route: 'POST /todos', policy: { auth: 'public' } })).isError).toBe(true);
    expect((await call('api_set_route_policy', { app: 'cfg-app', route: 'todos', policy: { disabled: true } })).isError).toBe(true);
    await call('api_set_route_policy', { app: 'cfg-app', route: 'POST /todos', policy: null });
    expect(config().routes).toBeUndefined();
  });

  it('toggles maintenance mode and rotates the edge secret', async () => {
    const { p, call, config } = await ready();
    await call('api_set_maintenance', { app: 'cfg-app', enabled: true, message: 'Upgrading' });
    expect(config().maintenance).toEqual({ enabled: true, message: 'Upgrading' });
    await call('api_set_maintenance', { app: 'cfg-app', enabled: false });
    expect(config().maintenance).toBeUndefined();
    const old = p.envs.get('cfg-app')!.BASALT_EDGE_SECRET!.value;
    const r = await call('api_rotate_edge_secret', { app: 'cfg-app' });
    expect(r.text).not.toContain(p.envs.get('cfg-app')!.BASALT_EDGE_SECRET!.value);
    expect(p.envs.get('cfg-app')!.BASALT_EDGE_SECRET!.value).not.toBe(old);
  });

  it('refuses config changes before setup', async () => {
    const { call } = await connect(new FakePlatform());
    const r = await call('api_update_config', { app: 'never-setup', config: { logLevel: 'info' } });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/api_setup/);
  });
});

describe('api_status', () => {
  it('reports checks with concrete fixes', async () => {
    const p = new FakePlatform();
    const { call } = await connect(p);
    const before = await call('api_status', { app: 'status-app' });
    expect(before.text).toMatch(/✗ env BASALT_PROJECT_ID is set\n\s+fix: run api_setup/);
    await call('api_setup', { app: 'status-app', origins: ['http://localhost:8080'] });
    p.unprotected = [{ table_name: 'public.notes', owner_like_column: 'user_id' }];
    const after = await call('api_status', { app: 'status-app' });
    expect(after.text).toMatch(/✓ database-enforced ownership installed/);
    expect(after.text).toMatch(/✗ unprotected per-user tables: public.notes\(user_id\)/);
    expect(after.text).toContain("SELECT basalt_auth.protect('public.notes', 'user_id');");
    expect(after.text).toMatch(/DATABASE_URL=•••• \(secret, set\)/);
  });
});

describe('guides, scaffold and review', () => {
  it('exposes the full tool set', async () => {
    const { client } = await connect(new FakePlatform());
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['api_get_config', 'api_integration_guide', 'api_review_code', 'api_rotate_edge_secret', 'api_scaffold', 'api_security_rules', 'api_set_maintenance', 'api_set_route_policy', 'api_setup', 'api_status', 'api_update_config'].sort(),
    );
  });

  it('scaffolded code and every guide snippet pass the reviewer', () => {
    for (const [file, content] of Object.entries(scaffold('demo'))) {
      if (!/\.(ts|sql)$/.test(file)) continue;
      const serious = reviewApiCode(content, file).filter((f) => f.severity === 'critical' || f.severity === 'high');
      expect(serious, file).toEqual([]);
    }
    for (const topic of TOPICS) {
      const blocks = [...apiGuide(topic).matchAll(/```(?:ts|sql)\n([\s\S]*?)```/g)].map((m) => m[1]!);
      for (const block of blocks) {
        const serious = reviewApiCode(block, 'server/routes/example.ts').filter((f) => f.severity === 'critical' || f.severity === 'high');
        expect(serious, `${topic}: ${block.slice(0, 120)}`).toEqual([]);
      }
    }
  });

  it('flags the classic backend mistakes', () => {
    const bad = `
import express from 'express';
import pg from 'pg';
const pool = new pg.Pool();
app.get('/todos', async (req, res) => {
  const rows = await pool.query(\`SELECT * FROM todos WHERE owner_id = '\${req.query.userId}'\`);
  res.json({ error: err.message });
});
api.post('/admin/reset', { auth: 'public', body: z.object({}), response: z.any() }, async () => {});
const html = await fetch(body.url);
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
createApi({ edgeSecret: '' });
`;
    const rules = new Set(reviewApiCode(bad, 'server/index.ts').map((f) => f.rule));
    for (const r of ['competing-http-server', 'raw-database-client', 'sql-string-building', 'client-supplied-user-id', 'error-detail-leak', 'public-write-route', 'any-response-schema', 'unsafe-outbound-fetch', 'tls-verification-disabled', 'edge-check-disabled']) {
      expect(rules, r).toContain(r);
    }
  });
});

describe('LocalPlatform env files', () => {
  it('writes 0600 env files in a git-ignored directory with values that survive quoting', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'basalt-'));
    const p = new LocalPlatform({ stateDir: dir, pgAdminUrl: 'postgres://x@localhost/x', redisUrl: 'redis://localhost' });
    const config = JSON.stringify({ maintenance: { enabled: true, message: "We're upgrading" } });
    await p.writeEnv('demo', { BASALT_API_CONFIG: { value: config, secret: false }, BASALT_EDGE_SECRET: { value: 'abc-DEF_123', secret: true } });
    expect((await stat(p.envFilePath('demo'))).mode & 0o777).toBe(0o600);
    expect(await readFile(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    const parsed = (process as any).loadEnvFile ? (() => {
      const before = { ...process.env };
      process.loadEnvFile(p.envFilePath('demo'));
      const v = process.env.BASALT_API_CONFIG;
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      return v;
    })() : config;
    expect(parsed).toBe(config);
    expect((await p.readEnv('demo')).BASALT_EDGE_SECRET).toEqual({ value: 'abc-DEF_123', secret: true });
  });
});
