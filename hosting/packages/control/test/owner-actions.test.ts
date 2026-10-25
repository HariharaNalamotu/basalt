import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { SecretBox } from '../src/crypto.js';
import { authFactory, type Ctx } from '../src/ctx.js';
import { createDashboard, dashboardLink } from '../src/dashboard.js';
import { migrate, type Db } from '../src/db.js';
import { hostGuide } from '../src/guides.js';
import { createMcpServer } from '../src/mcp.js';
import { Host } from '../src/service.js';

// Things an owner does from their dashboard, against the real control plane schema (in PGlite).

const here = path.dirname(fileURLToPath(import.meta.url));
const base = { ROOT_DOMAIN: 'basalt.localhost', DATABASE_URL: 'postgres://x', PG_ADMIN_URL: 'postgres://x', REDIS_ADMIN_URL: 'redis://x', AUTH_PUBLIC_URL: 'https://auth.basalt.localhost', AUTH_PLATFORM_KEY: 'k'.repeat(32), MASTER_KEY: Buffer.alloc(32, 1).toString('base64'), INTERNAL_TOKEN: 't'.repeat(32), MAIL_WEBHOOK_SECRET: 'm'.repeat(32) };
const cfg = loadConfig({ ...base, PUBLIC_SCHEME: 'http', PUBLIC_PORT: '8080', HOST_PUBLIC_URL: 'http://127.0.0.1:4000', EDGE_ADMIN_URL: 'http://127.0.0.1:9/' });

function pgliteDb(pg: PGlite): Db {
  const run = async (q: Pick<PGlite, 'query' | 'exec'>, sql: string, params: unknown[] = []) => {
    if (params.length) {
      const r = await q.query(sql, params);
      return { rows: r.rows as never[], rowCount: r.affectedRows ?? r.rows.length };
    }
    const r = (await q.exec(sql)).at(-1);
    return { rows: (r?.rows ?? []) as never[], rowCount: r?.affectedRows ?? r?.rows.length ?? 0 };
  };
  return {
    query: (sql, params) => run(pg, sql, params),
    tx: (fn) => pg.transaction((t) => fn((sql, params) => run(t, sql, params))),
    close: () => pg.close(),
  };
}

let pg: PGlite;
let ctx: Ctx;
let host: Host;
let dash: ReturnType<typeof createDashboard>;
let cookie: string;

beforeAll(async () => {
  pg = new PGlite();
  const db = pgliteDb(pg);
  await migrate(db);
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  ctx = { cfg, db, box: new SecretBox(cfg.masterKey), docker: {} as never, redis: {} as never, log: log as never, routes: { version: 0, bump() {} }, authFor: authFactory(cfg) };
  host = new Host(ctx);
  dash = createDashboard(ctx, host);
  await db.query(`INSERT INTO workspaces (id, name) VALUES ('ws_a', 'Ana'), ('ws_b', 'Ben')`);
  const open = await dash.request(`/open?t=${new URL(dashboardLink(cfg, 'ws_a')).searchParams.get('t')}`);
  cookie = open.headers.get('set-cookie')!.split(';')[0]!;
});
afterAll(() => pg?.close());

const post = (p: string, body: unknown, method = 'POST') => dash.request(p, { method, headers: { cookie, 'content-type': 'application/json', 'x-basalt-dashboard': '1' }, body: JSON.stringify(body) });
const appExists = async (name: string) => (await ctx.db.query('SELECT 1 FROM apps WHERE name = $1', [name])).rows.length === 1;

async function mcpClient(ws: string) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createMcpServer(ctx, host, ws).connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  return async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: Boolean(r.isError) };
  };
}

describe('deleting an app needs the owner', () => {
  it('host_delete_app only asks: nothing is deleted and Claude is told to send the owner to their dashboard', async () => {
    await host.createApp('ws_a', 'bakery');
    const tool = await mcpClient('ws_a');
    const r = await tool('host_delete_app', { app: 'bakery', confirm: true });
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/dashboard/i);
    expect(r.text).toMatch(/http:\/\/127\.0\.0\.1:4000\/dashboard\/open\?t=/);
    expect(r.text).toMatch(/Nothing is deleted/i);
    expect(await appExists('bakery')).toBe(true);
  });

  it('the dashboard shows the waiting deletion in plain words', async () => {
    const res = await dash.request('/api/state', { headers: { cookie } });
    expect(res.status).toBe(200);
    const s = (await res.json()) as { pendingDeletions: Array<{ app: string; message: string }> };
    expect(s.pendingDeletions).toHaveLength(1);
    expect(s.pendingDeletions[0]).toMatchObject({ app: 'bakery' });
    expect(s.pendingDeletions[0]!.message).toBe("Delete bakery? This removes every version and its data and can't be undone.");
  });

  it('Cancel keeps the app and clears the request', async () => {
    expect((await post('/api/delete-app', { app: 'bakery' }, 'DELETE')).status).toBe(200);
    expect(await appExists('bakery')).toBe(true);
    const s = (await (await dash.request('/api/state', { headers: { cookie } })).json()) as { pendingDeletions: unknown[] };
    expect(s.pendingDeletions).toEqual([]);
    // With nothing waiting, Confirm does nothing.
    expect((await post('/api/delete-app', { app: 'bakery' })).status).toBe(404);
    expect(await appExists('bakery')).toBe(true);
  });

  it('Confirm deletes the app, only from the dashboard page itself', async () => {
    const tool = await mcpClient('ws_a');
    await tool('host_delete_app', { app: 'bakery' });
    // Not from another site: no dashboard header.
    const forged = await dash.request('/api/delete-app', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ app: 'bakery' }) });
    expect(forged.status).toBe(403);
    // Not without the owner's session.
    expect((await dash.request('/api/delete-app', { method: 'POST', headers: { 'content-type': 'application/json', 'x-basalt-dashboard': '1' }, body: '{"app":"bakery"}' })).status).toBe(401);
    expect(await appExists('bakery')).toBe(true);

    const ok = await post('/api/delete-app', { app: 'bakery' });
    expect(ok.status).toBe(200);
    expect(await appExists('bakery')).toBe(false);
  });

  it("another workspace can't ask to delete someone else's app", async () => {
    await host.createApp('ws_a', 'florist');
    const tool = await mcpClient('ws_b');
    const r = await tool('host_delete_app', { app: 'florist' });
    expect(r.isError).toBe(true);
    const s = (await (await dash.request('/api/state', { headers: { cookie } })).json()) as { pendingDeletions: unknown[] };
    expect(s.pendingDeletions).toEqual([]);
  });
});

describe('Open site from the dashboard', () => {
  it('opens production at its address and private test versions through a fresh share link', async () => {
    const app = await host.createApp('ws_a', 'salon');
    const accessKey = ctx.box.seal('s'.repeat(43), 'access:env_stg');
    await ctx.db.query(`INSERT INTO environments (id, app_id, kind, slug, host, subnet_index, access_key_enc) VALUES ('env_prd', $1, 'production', 'prod', 'salon.basalt.localhost', 901, NULL), ('env_stg', $1, 'staging', 'staging', 'salon-staging.basalt.localhost', 902, $2)`, [app.id, accessKey]);

    const prod = await dash.request('/api/open?app=salon&env=production', { headers: { cookie } });
    expect(prod.status).toBe(303);
    expect(prod.headers.get('location')).toBe('http://salon.basalt.localhost:8080/');

    const stg = await dash.request('/api/open?app=salon&env=staging', { headers: { cookie } });
    expect(stg.status).toBe(303);
    expect(stg.headers.get('location')).toMatch(/^http:\/\/salon-staging\.basalt\.localhost:8080\/_basalt\/access\?t=/);

    expect((await dash.request('/api/open?app=salon&env=staging')).status).toBe(401);
    const other = await dash.request('/api/open?app=nope&env=staging', { headers: { cookie } });
    expect(other.status).toBe(404);
  });

  it('the page links the button through it', () => {
    const js = readFileSync(path.join(here, '../src/dashboard-ui/dashboard.js'), 'utf8');
    expect(js).toMatch(/\/dashboard\/api\/open\?app=/);
    expect(js).not.toMatch(/visit\.href = s\.url/);
  });
});

describe('signing out of the dashboard', () => {
  it('clears the session cookie and says how to get back in', async () => {
    const res = await dash.request('/signout', { headers: { cookie } });
    expect(res.status).toBe(200);
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/^basalt_dash=;/);
    expect(set).toMatch(/Path=\/dashboard/);
    expect(set).toMatch(/Max-Age=0/);
    expect(await res.text()).toMatch(/Ask Claude.*dashboard/i);
  });

  it('the dashboard has a Sign out link', () => {
    const html = readFileSync(path.join(here, '../src/dashboard-ui/index.html'), 'utf8');
    expect(html).toMatch(/href="\/dashboard\/signout"[^>]*>[^<]*Sign out/);
  });
});

describe('Connect Claude page', () => {
  const js = readFileSync(path.join(here, '../src/dashboard-ui/connect.js'), 'utf8');
  it('moves the newest downloaded connector file on Mac and Linux (two downloads must not break it)', () => {
    expect(js).not.toMatch(/mv ~\/Downloads\/\*mcp\.json/);
    expect(js.match(/ls -t ~\/Downloads\/\*mcp\*\.json \| head -1/g)).toHaveLength(2);
  });
  it('says Claude Code must be installed first', () => {
    const html = readFileSync(path.join(here, '../src/dashboard-ui/connect.html'), 'utf8');
    expect(html).toMatch(/https:\/\/claude\.com\/claude-code/);
  });
});

describe('owner sign up on a local Basalt', () => {
  it('tells Claude the confirmation email will not arrive without an email key, and to read it with host_test_emails', () => {
    const data = hostGuide('data', 'apps.dev');
    expect(data).toMatch(/sign up in the app[\s\S]{0,400}host_test_emails[\s\S]{0,400}host_data_admin/);
    expect(data).toMatch(/RESEND_API_KEY/);
  });
});
