// End to end tests for Basalt Cloud and its MCP server. Needs the local
// database (cd ../data && npm run db:up) and .env filled in.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { parseContract, pg } from '../../data/src/index.ts';
import { AuthLink } from '../src/auth.ts';
import { Projects } from '../src/projects.ts';
import { createCloudServer } from '../src/server.ts';
import { startAuth } from './auth-server.ts';

let authServer: Awaited<ReturnType<typeof startAuth>>;
let auth: AuthLink;
let projects: Projects;
let base: string;
let cloud: ReturnType<typeof createCloudServer>;

const RULES = {
  tables: {
    bookings: {
      fields: {
        service: { type: 'text', maxLength: 100, required: true },
        starts_at: { type: 'timestamp', required: true },
        phone: { type: 'text', format: 'phone' },
        staff_id: { type: 'user' },
      },
      shareWith: 'staff_id',
    },
  },
};

async function call(method: string, path: string, body?: unknown, key?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function newApp(name = 'Test salon') {
  const r = await call('POST', '/api/projects', { name });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.project.id as string, key: r.body.adminKey as string, dataUrl: r.body.project.dataUrl as string };
}

async function approve(approveUrl: string, decision = 'approve') {
  const u = new URL(approveUrl);
  return fetch(`${base}${u.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: u.searchParams.get('t')!, decision }).toString(),
  });
}

async function liveApp() {
  const app = await newApp();
  const set = await call('PUT', '/api/projects/me/rules', { contract: RULES }, app.key);
  await approve(set.body.approveUrl);
  return app;
}

async function login(key: string, who: string): Promise<{ token: string; userId: string }> {
  return (await call('POST', '/api/projects/me/test-login', { who }, key)).body;
}

async function data(dataUrl: string, token: string, op: string, body: unknown) {
  const res = await fetch(`${dataUrl}/v1/data/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  authServer = await startAuth(process.env.CLOUD_ADMIN_URL!);
  auth = new AuthLink({ url: authServer.url, platformKey: authServer.platformKey, masterKey: process.env.CLOUD_MASTER_KEY! });
  projects = new Projects({ adminUrl: process.env.CLOUD_ADMIN_URL!, dbHost: process.env.CLOUD_DB_HOST!, masterKey: process.env.CLOUD_MASTER_KEY! }, auth);
  await projects.init();
  cloud = createCloudServer({ projects, auth, publicUrl: 'http://placeholder', projectsPerIpPerHour: 1000 });
  await new Promise<void>((r) => cloud.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
  // Links in replies use the public URL; point it at the test server.
  cloud.server.close();
  cloud = createCloudServer({ projects, auth, publicUrl: base, projectsPerIpPerHour: 1000 });
  await new Promise<void>((r) => cloud.server.listen(Number(new URL(base).port), '127.0.0.1', () => r()));
});

after(async () => {
  await cloud.close();
  await new Promise((r) => cloud.server.close(r));
  await projects.close();
  await authServer.close();
});

describe('logins come from Basalt Auth', () => {
  test('test logins are real Auth users and sessions, the same person every time', async () => {
    const app = await liveApp();
    const maria = await login(app.key, 'maria');
    const again = await login(app.key, 'maria');
    const sam = await login(app.key, 'sam');
    assert.equal(maria.userId, again.userId);
    assert.notEqual(maria.userId, sam.userId);
    const p = (await projects.get(app.id))!;
    const users = await (await fetch(`${authServer.url}/v1/platform/projects/${p.authProjectId}/users?email=maria@test.basalt.invalid`, {
      headers: { authorization: `Bearer ${authServer.platformKey}`, 'x-basalt-owner': 'basalt-cloud' },
    })).json();
    assert.equal(users.users[0].id, maria.userId);
    const made = await data(app.dataUrl, maria.token, 'create', { table: 'bookings', input: { service: 'Cut', starts_at: '2026-10-25T15:00:00Z' } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.data.owner_id, maria.userId);
    const theirs = await data(app.dataUrl, sam.token, 'get', { table: 'bookings', id: made.body.data.id });
    assert.equal(theirs.status, 404);
  });

  test("the database checks Auth's issuer and signature: tokens from another app or self-made ones are refused", async () => {
    const one = await liveApp();
    const two = await liveApp();
    const fromTwo = await login(two.key, 'maria');
    assert.equal((await data(one.dataUrl, fromTwo.token, 'list', { table: 'bookings' })).status, 401);
    const { createHmac } = await import('node:crypto');
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc({ sub: fromTwo.userId, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 600 })}`;
    const selfMade = `${unsigned}.${createHmac('sha256', 'not-the-secret-not-the-secret-0123456789').update(unsigned).digest('base64url')}`;
    assert.equal((await data(one.dataUrl, selfMade, 'list', { table: 'bookings' })).status, 401);
  });

  test('signing out everywhere in Auth stops the token in the database after a sync', async () => {
    const app = await liveApp();
    const maria = await login(app.key, 'maria-revoke');
    assert.equal((await data(app.dataUrl, maria.token, 'list', { table: 'bookings' })).status, 200);
    const p = (await projects.get(app.id))!;
    const r = await fetch(`${authServer.url}/v1/platform/projects/${p.authProjectId}/users/${maria.userId}/revoke-sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${authServer.platformKey}`, 'x-basalt-owner': 'basalt-cloud', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(r.status, 200);
    assert.ok((await projects.syncRevocations(p)) >= 1);
    assert.equal((await data(app.dataUrl, maria.token, 'list', { table: 'bookings' })).status, 401);
    // Running the sync again is harmless.
    await projects.syncRevocations(p);
  });
});

describe('a new app', () => {
  test('gets its own database and roles, and nothing works until the owner approves', async () => {
    const app = await newApp();
    const admin = new pg.Client({ connectionString: process.env.CLOUD_ADMIN_URL });
    await admin.connect();
    try {
      assert.equal((await admin.query('select 1 from pg_database where datname = $1', [`app_${app.id}`])).rowCount, 1);
      assert.equal((await admin.query('select 1 from pg_roles where rolname = $1', [`app_${app.id}_data`])).rowCount, 1);
    } finally {
      await admin.end();
    }
    const before = await data(app.dataUrl, 'x.y.z', 'list', { table: 'bookings' });
    assert.equal(before.status, 503);

    const set = await call('PUT', '/api/projects/me/rules', { contract: RULES }, app.key);
    assert.equal(set.body.status, 'waiting_for_owner');
    assert.match(set.body.summary, /only the bookings they added/);
    const stillOff = await data(app.dataUrl, 'x.y.z', 'list', { table: 'bookings' });
    assert.equal(stillOff.status, 503);

    const pageRes = await fetch(set.body.approveUrl);
    const html = await pageRes.text();
    assert.equal(pageRes.status, 200);
    assert.match(html, /Who can see what/);
    assert.match(html, /can also see that one, but can&#39;t change it/);

    const done = await approve(set.body.approveUrl);
    assert.match(await done.text(), /These rules are live/);
    assert.equal((await call('GET', '/api/projects/me', undefined, app.key)).body.project.status, 'live');
  });

  test('test logins work, and one person never sees another person\'s data', async () => {
    const app = await liveApp();
    const maria = await login(app.key, 'maria');
    const sam = await login(app.key, 'sam');
    assert.equal((await login(app.key, 'maria')).userId, maria.userId);

    const made = await data(app.dataUrl, maria.token, 'create', { table: 'bookings', input: { service: 'Haircut', starts_at: '2026-10-25T15:00:00Z' } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal((await data(app.dataUrl, sam.token, 'get', { table: 'bookings', id: made.body.data.id })).status, 404);
    assert.equal((await data(app.dataUrl, maria.token, 'list', { table: 'bookings' })).body.data.rows.length, 1);
  });

  test('turning the rules down changes nothing', async () => {
    const app = await newApp();
    const set = await call('PUT', '/api/projects/me/rules', { contract: RULES }, app.key);
    const res = await approve(set.body.approveUrl, 'reject');
    assert.match(await res.text(), /Nothing changed/);
    assert.equal((await call('GET', '/api/projects/me', undefined, app.key)).body.project.status, 'no_rules_yet');
    const again = await approve(set.body.approveUrl);
    assert.equal(again.status, 410);
  });
});

describe('changing the rules later', () => {
  test('adding an optional field goes live right away', async () => {
    const app = await liveApp();
    const next = structuredClone(RULES) as any;
    next.tables.bookings.fields.note = { type: 'text', maxLength: 500 };
    const r = await call('PUT', '/api/projects/me/rules', { contract: next }, app.key);
    assert.equal(r.body.status, 'live');
    const maria = await login(app.key, 'maria');
    const made = await data(app.dataUrl, maria.token, 'create', { table: 'bookings', input: { service: 'Trim', starts_at: '2026-10-25T15:00:00Z', note: 'hi' } });
    assert.equal(made.body.data.note, 'hi');
  });

  test('anything that shows data to more people needs the owner again', async () => {
    const app = await liveApp();
    const next = structuredClone(RULES) as any;
    next.tables.reviews = { fields: { text: { type: 'text' }, about: { type: 'user' } }, shareWith: 'about' };
    const r = await call('PUT', '/api/projects/me/rules', { contract: next }, app.key);
    assert.equal(r.body.status, 'waiting_for_owner');
    assert.match(r.body.why.join(' '), /reviews/);
  });

  test('an unsafe change is refused with a plain reason Claude can act on', async () => {
    const app = await liveApp();
    const next = structuredClone(RULES) as any;
    delete next.tables.bookings.fields.phone;
    const r = await call('PUT', '/api/projects/me/rules', { contract: next }, app.key);
    assert.equal(r.status, 409);
    assert.match(r.body.error.message, /field phone was removed/);
  });

  test('broken rules get a message that says what to fix', async () => {
    const app = await newApp();
    const r = await call('PUT', '/api/projects/me/rules', { contract: { tables: { Bookings: { fields: {} } } } }, app.key);
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /lowercase letters/);
  });
});

describe('the owner as admin', () => {
  test('making someone an admin needs the owner, then they see everything and can archive', async () => {
    const app = await liveApp();
    const customer = await login(app.key, 'customer');
    const owner = await login(app.key, 'maria');
    const made = await data(app.dataUrl, customer.token, 'create', { table: 'bookings', input: { service: 'Color', starts_at: '2026-10-25T15:00:00Z' } });
    const id = made.body.data.id;
    assert.equal((await data(app.dataUrl, owner.token, 'get', { table: 'bookings', id })).status, 404);

    const req = await call('POST', '/api/projects/me/admins', { who: 'maria' }, app.key);
    assert.equal(req.body.status, 'waiting_for_owner');
    const html = await (await fetch(req.body.approveUrl)).text();
    assert.match(html, /can see and change everything/);
    assert.equal((await data(app.dataUrl, owner.token, 'get', { table: 'bookings', id })).status, 404);

    await approve(req.body.approveUrl);
    assert.equal((await data(app.dataUrl, owner.token, 'get', { table: 'bookings', id })).body.data.service, 'Color');
    const stylist = await login(app.key, 'stylist');
    const assigned = await data(app.dataUrl, owner.token, 'update', { table: 'bookings', id, input: { staff_id: stylist.userId } });
    assert.equal(assigned.body.data.staff_id, stylist.userId);
    assert.equal((await data(app.dataUrl, stylist.token, 'get', { table: 'bookings', id })).status, 200);

    const archived = await data(app.dataUrl, owner.token, 'archive', { table: 'bookings', id });
    assert.ok(archived.body.data.archived_at);
    assert.equal((await data(app.dataUrl, customer.token, 'list', { table: 'bookings' })).body.data.rows.length, 0);
    await data(app.dataUrl, customer.token, 'restore', { table: 'bookings', id });
    assert.equal((await data(app.dataUrl, customer.token, 'list', { table: 'bookings' })).body.data.rows.length, 1);
  });

  test("the owner is named by the email they signed up with, since nobody knows their user id", async () => {
    const app = await liveApp();
    const p = (await projects.get(app.id))!;
    const platform = (path: string, body: unknown) =>
      fetch(`${authServer.url}/v1/platform/projects/${p.authProjectId}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${authServer.platformKey}`, 'x-basalt-owner': 'basalt-cloud', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const password = `Pw-${randomUUID()}`;
    assert.equal((await platform('/users', { email: 'owner@salon.example', password })).status, 201);
    const signIn = await (await fetch(`${authServer.url}/v1/projects/${p.authProjectId}/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@salon.example', password }),
    })).json();
    const ownerToken = JSON.parse(Buffer.from(signIn.accessToken.split('.')[1], 'base64url').toString()).bdg;
    const customer = await login(app.key, 'customer');
    const made = await data(app.dataUrl, customer.token, 'create', { table: 'bookings', input: { service: 'Color', starts_at: '2026-10-25T15:00:00Z' } });

    const req = await call('POST', '/api/projects/me/admins', { email: ' Owner@Salon.example ' }, app.key);
    assert.equal(req.status, 202, JSON.stringify(req.body));
    assert.equal(req.body.userId, signIn.user.id);
    assert.match(await (await fetch(req.body.approveUrl)).text(), /owner@salon\.example/);
    assert.equal((await data(app.dataUrl, ownerToken, 'get', { table: 'bookings', id: made.body.data.id })).status, 404);
    await approve(req.body.approveUrl);
    assert.equal((await data(app.dataUrl, ownerToken, 'list', { table: 'bookings' })).body.data.rows.length, 1);

    const nobody = await call('POST', '/api/projects/me/admins', { email: 'nobody@salon.example' }, app.key);
    assert.equal(nobody.status, 404);
    assert.match(nobody.body.error.message, /sign up in the app first/);
  });

  test('turning down an admin request changes nothing', async () => {
    const app = await liveApp();
    const req = await call('POST', '/api/projects/me/admins', { who: 'stranger' }, app.key);
    await approve(req.body.approveUrl, 'reject');
    const stranger = await login(app.key, 'stranger');
    const customer = await login(app.key, 'customer');
    const made = await data(app.dataUrl, customer.token, 'create', { table: 'bookings', input: { service: 'X', starts_at: '2026-10-25T15:00:00Z' } });
    assert.equal((await data(app.dataUrl, stranger.token, 'get', { table: 'bookings', id: made.body.data.id })).status, 404);
  });
});

describe("the owner's data map", () => {
  test('shows where data lives, who can reach it and marks personal info, with live counts', async () => {
    const app = await liveApp();
    const maria = await login(app.key, 'maria');
    await data(app.dataUrl, maria.token, 'create', { table: 'bookings', input: { service: 'Color', starts_at: '2026-10-25T15:00:00Z', phone: '+1 413 555 0100' } });
    const status = (await call('GET', '/api/projects/me', undefined, app.key)).body.project;
    const res = await fetch(status.mapUrl);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Where Test salon/);
    assert.match(html, /The AI that built it/);
    assert.match(html, /no key/);
    assert.match(html, /class="pii">phone/);
    assert.match(html, /1 saved/);
    assert.match(html, /a new booking was added/);
    assert.ok(!html.includes('+1 413 555 0100'), 'the map must never show anyone\'s data');
    // The same link keeps working.
    assert.equal((await call('GET', '/api/projects/me', undefined, app.key)).body.project.mapUrl, status.mapUrl);
  });

  test('a wrong key shows nothing', async () => {
    const app = await liveApp();
    const res = await fetch(`${base}/owner/${app.id}?k=${'x'.repeat(43)}`);
    assert.equal(res.status, 404);
  });
});

describe('many people starting apps at once', () => {
  test('apps made at the same moment all get set up', async () => {
    const made = await Promise.all(Array.from({ length: 5 }, (_, i) => call('POST', '/api/projects', { name: `Rush ${i}` })));
    assert.deepEqual(made.map((r) => r.status), [201, 201, 201, 201, 201], JSON.stringify(made.map((r) => r.body)));
  });
});

describe('apps are walled off from each other', () => {
  test("one app's key can't manage another, and its database login can't open another's database", async () => {
    const a = await liveApp();
    const b = await liveApp();
    const pa = (await projects.get(a.id))!;
    const pb = (await projects.get(b.id))!;
    const crossUrl = projects.dataUrl(pa).replace(`/app_${a.id}`, `/app_${b.id}`);
    const c = new pg.Client({ connectionString: crossUrl });
    await assert.rejects(c.connect());
    // Each app has its own Auth project and therefore its own token signing secret.
    assert.notEqual(pa.authProjectId, pb.authProjectId);
    assert.notEqual((await auth.signing(pa.authProjectId!)).secret, (await auth.signing(pb.authProjectId!)).secret);

    // A token from app A means nothing in app B.
    const maria = await login(a.key, 'maria');
    assert.equal((await data(b.dataUrl, maria.token, 'list', { table: 'bookings' })).status, 401);
  });

  test('bad or missing keys are refused', async () => {
    assert.equal((await call('GET', '/api/projects/me')).status, 401);
    assert.equal((await call('GET', '/api/projects/me', undefined, 'bsk_aaaaaaaaaa_' + 'x'.repeat(43))).status, 401);
  });

  test('a mistyped approval link does nothing', async () => {
    const app = await newApp();
    const set = await call('PUT', '/api/projects/me/rules', { contract: RULES }, app.key);
    const u = new URL(set.body.approveUrl);
    const res = await fetch(`${base}${u.pathname}?t=wrong`);
    assert.equal(res.status, 404);
  });

  test("the app's name can't inject anything into the owner's page", async () => {
    const app = await newApp('<script>alert(1)</script>');
    const set = await call('PUT', '/api/projects/me/rules', { contract: RULES }, app.key);
    const html = await (await fetch(set.body.approveUrl)).text();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
  });

  test('the database secrets are stored encrypted', async () => {
    const app = await newApp();
    const p = (await projects.get(app.id))!;
    const admin = new pg.Client({ connectionString: process.env.CLOUD_ADMIN_URL });
    await admin.connect();
    try {
      const row = (await admin.query('select data_password, jwt_secret, admin_key_hash from cloud.projects where id = $1', [app.id])).rows[0];
      assert.ok(!row.data_password.includes(p.dataPassword));
      assert.ok(!row.jwt_secret.includes(p.jwtSecret));
      assert.ok(!row.admin_key_hash.includes(app.key));
    } finally {
      await admin.end();
    }
  });
});

describe('the MCP server Claude Code uses', () => {
  test('start, set rules, owner approves, connect, test login: all in plain words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'basalt-mcp-'));
    const child = spawn(process.execPath, [new URL('../src/mcp.ts', import.meta.url).pathname], {
      env: { ...process.env, BASALT_URL: base, BASALT_PROJECT_DIR: dir },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let buf = '';
    const waiting = new Map<number, (v: any) => void>();
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const msg = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        waiting.get(msg.id)?.(msg);
      }
    });
    let next = 1;
    const rpc = (method: string, params?: unknown) =>
      new Promise<any>((resolve) => {
        const id = next++;
        waiting.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    const tool = async (name: string, args = {}) => {
      const r = await rpc('tools/call', { name, arguments: args });
      return { text: r.result.content[0].text as string, isError: Boolean(r.result.isError) };
    };

    try {
      const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
      assert.equal(init.result.serverInfo.name, 'basalt');
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
      const names = (await rpc('tools/list')).result.tools.map((t: any) => t.name);
      assert.deepEqual(names, ['basalt_start', 'basalt_set_rules', 'basalt_status', 'basalt_connect_app', 'basalt_make_admin', 'basalt_test_login', 'basalt_check']);

      assert.match((await tool('basalt_status')).text, /call basalt_start first/i);
      assert.match((await tool('basalt_start', { app_name: "Maria's Salon" })).text, /locked down database/);
      assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.basalt\/$/m);
      assert.equal(statSync(join(dir, '.basalt', 'project.json')).mode & 0o777, 0o600);

      const set = await tool('basalt_set_rules', { rules: RULES });
      const link = /(http\S+\/approve\/\S+)/.exec(set.text)![1];
      assert.match((await tool('basalt_status')).text, /Waiting for the person/);
      assert.match((await tool('basalt_connect_app')).text, /aren't live yet/);
      await approve(link);

      assert.match((await tool('basalt_status')).text, /^Live/);
      const connect = await tool('basalt_connect_app');
      assert.match(connect.text, /export function basalt\(getToken\)/);
      const login1 = await tool('basalt_test_login', { who: 'maria' });
      assert.match(login1.text, /good for \d+ minutes/);

      // The check scans this folder for data kept outside Basalt, then tests the live app.
      writeFileSync(join(dir, 'app.js'), "localStorage.setItem('bookings', JSON.stringify(list));\n");
      const check = await tool('basalt_check');
      assert.equal(check.isError, false, check.text);
      assert.match(check.text, /checks passed/);
      assert.match(check.text, /app\.js, line 1/);
      assert.match(check.text, /owner\/[a-z0-9]{10}\/check\?k=/);

      const bad = await tool('basalt_set_rules', { rules: { tables: {} } });
      assert.equal(bad.isError, true);
      assert.match(bad.text, /no tables/);
    } finally {
      child.kill();
    }
  });
});

describe('the hosting platform API', () => {
  test('makes a database bound to an existing Auth project, only for the platform key and never from the internet', async () => {
    const platformKey = 'p'.repeat(64);
    const host = createCloudServer({ projects, auth, platformKey, publicUrl: 'http://placeholder', trustProxy: true });
    await new Promise<void>((r) => host.server.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
    try {
      const { projectId } = await auth.createProject('Hosted env');
      const make = (key: string, headers: Record<string, string> = {}) =>
        fetch(`${url}/api/platform/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
          body: JSON.stringify({ name: 'Hosted env', authProjectId: projectId, authOwner: auth.defaultOwner }),
        });
      assert.equal((await make('wrong')).status, 401);
      // Through the edge (which always sets X-Forwarded-For) the platform API doesn't exist.
      assert.equal((await make(platformKey, { 'x-forwarded-for': '203.0.113.9' })).status, 404);
      const ok = await make(platformKey);
      assert.equal(ok.status, 201);
      assert.match((await ok.json()).project.id, /^[a-z0-9]{10}$/);
    } finally {
      await host.close();
      await new Promise((r) => host.server.close(r));
    }
  });
});

describe('hosted environments on the platform API', () => {
  const platformKey = 'q'.repeat(64);
  let host: ReturnType<typeof createCloudServer>;
  let url: string;
  before(async () => {
    // Port picked first so Guard can be told to call the server directly (selfUrl).
    const probe = createCloudServer({ projects, auth, publicUrl: 'http://x' });
    await new Promise<void>((r) => probe.server.listen(0, '127.0.0.1', () => r()));
    const port = (probe.server.address() as AddressInfo).port;
    await new Promise((r) => probe.server.close(r));
    url = `http://127.0.0.1:${port}`;
    host = createCloudServer({ projects, auth, platformKey, publicUrl: 'https://cloud.example.com', selfUrl: url, trustProxy: true });
    await new Promise<void>((r) => host.server.listen(port, '127.0.0.1', () => r()));
  });
  after(async () => {
    await host.close();
    await new Promise((r) => host.server.close(r));
  });
  const make = (authProjectId: string, externalId: string) =>
    fetch(`${url}/api/platform/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platformKey}` },
      body: JSON.stringify({ name: 'Env', authProjectId, authOwner: auth.defaultOwner, externalId }),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  test('asking twice for the same environment returns the same database, with a fresh key', async () => {
    const { projectId } = await auth.createProject('Env');
    const a = await make(projectId, 'env_same1');
    const b = await make(projectId, 'env_same1');
    assert.equal(a.status, 201);
    assert.equal(b.body.project.id, a.body.project.id);
    assert.notEqual(b.body.adminKey, a.body.adminKey);
    const me = (key: string) => fetch(`${url}/api/projects/me`, { headers: { authorization: `Bearer ${key}` } }).then((r) => r.status);
    assert.equal(await me(b.body.adminKey), 200);
    assert.equal(await me(a.body.adminKey), 401);
  });

  test('a burst of retries for one environment neither hangs nor makes a second database', async () => {
    const { projectId } = await auth.createProject('Env');
    const all = await Promise.all(Array.from({ length: 8 }, () => make(projectId, 'env_burst1')));
    assert.deepEqual([...new Set(all.map((r) => r.status))], [201]);
    assert.equal(new Set(all.map((r) => r.body.project.id)).size, 1);
  });

  test('a retry tied to a different Auth project is refused instead of reusing the old database', async () => {
    const first = await auth.createProject('Env');
    const second = await auth.createProject('Env again');
    assert.equal((await make(first.projectId, 'env_rebind1')).status, 201);
    const r = await make(second.projectId, 'env_rebind1');
    assert.equal(r.status, 409);
  });

  test('an environment can be deleted by its id even if its project id was never recorded', async () => {
    const { projectId } = await auth.createProject('Env');
    const made = await make(projectId, 'env_lost1');
    const del = () => fetch(`${url}/api/platform/environments/env_lost1`, { method: 'DELETE', headers: { authorization: `Bearer ${platformKey}` } }).then((r) => r.status);
    assert.equal(await del(), 200);
    assert.equal(await projects.get(made.body.project.id), null);
    assert.equal(await del(), 404);
  });

  test("Guard checks a hosted environment's data directly, not through Cloud's public address", async () => {
    const { projectId } = await auth.createProject('Env');
    const made = await make(projectId, 'env_guard1');
    await fetch(`${url}/api/platform/projects/${made.body.project.id}/rules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platformKey}` },
      body: JSON.stringify({ contract: { tables: { notes: { fields: { text: { type: 'text' } } } } } }),
    });
    const r = await fetch(`${url}/api/projects/me/check`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${made.body.adminKey}` }, body: '{}' });
    const body = (await r.json()) as any;
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.failed, 0, JSON.stringify(body.results));
  });

  test("a hosted environment's data is only served on the app's own site, not on Cloud's public address", async () => {
    const { projectId } = await auth.createProject('Env');
    const made = await make(projectId, 'env_public1');
    const id = made.body.project.id;
    await fetch(`${url}/api/platform/projects/${id}/rules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${platformKey}` },
      body: JSON.stringify({ contract: { tables: { notes: { fields: { text: { type: 'text' } } } } } }),
    });
    const list = (forwardedHost: string) =>
      fetch(`${url}/p/${id}/v1/data/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer a.b.c', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-host': forwardedHost },
        body: '{"table":"notes"}',
      }).then((r) => r.status);
    assert.equal(await list('cloud.example.com'), 404);
    // Through the app's own site the request reaches the Data service (and fails on the bad token there).
    assert.equal(await list('todo.example.com'), 401);
  });
});

describe('deleting an app while something is using its database', () => {
  test("a revocation sync caught mid-way fails on its own and doesn't take Cloud down", async () => {
    const app = await liveApp();
    const p = (await projects.get(app.id))!;
    // A sync connected to the app's database, waiting on Basalt Auth when the app is deleted.
    let release!: () => void;
    const waiting = new Promise<void>((r) => (release = r));
    const slowAuth = { revocations: async () => (await waiting, { revocations: [], hasMore: false, nextCursor: null }) } as unknown as AuthLink;
    const slow = new Projects({ adminUrl: process.env.CLOUD_ADMIN_URL!, dbHost: process.env.CLOUD_DB_HOST!, masterKey: process.env.CLOUD_MASTER_KEY! }, slowAuth);
    const sync = slow.syncRevocations(p);
    await new Promise((r) => setTimeout(r, 300));
    await projects.delete(p); // DROP DATABASE ... WITH (FORCE) ends the sync's session
    await new Promise((r) => setTimeout(r, 300));
    release();
    await sync.catch(() => {}); // either way, only this sync is affected
    await slow.close();
    // Still serving.
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

describe('plain-English rules', () => {
  test('every field type reads as words, including file fields', async () => {
    const { summarize } = await import('../src/summary.ts');
    const { text } = summarize(parseContract({ tables: { bookings: { fields: { photo: { type: 'file' }, when: { type: 'timestamp', required: true } } } } }));
    assert.match(text, /photo: an uploaded photo or document/);
    assert.doesNotMatch(text, /undefined/);
  });
});
