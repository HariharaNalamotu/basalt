// Guard: the safety check Claude runs before an app goes live. Needs the local
// database (cd ../data && npm run db:up) and .env filled in.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { parseContract } from '../../data/src/index.ts';
import { runChecks } from '../src/guard.ts';
import { renderReceipt } from '../src/receipt.ts';
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
        phone: { type: 'text', format: 'phone', required: true },
        guests: { type: 'integer', min: 1, max: 8, required: true },
        staff_id: { type: 'user' },
      },
      shareWith: 'staff_id',
      unique: [['starts_at']],
    },
    photos: { fields: { picture: { type: 'file', required: true }, caption: { type: 'text', format: 'slug' } } },
    visits: { fields: { count: { type: 'integer', min: 1, max: 5, required: true } } },
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

async function liveApp() {
  const r = await call('POST', '/api/projects', { name: 'Guard salon' });
  const app = { id: r.body.project.id as string, key: r.body.adminKey as string };
  const set = await call('PUT', '/api/projects/me/rules', { contract: RULES }, app.key);
  const u = new URL(set.body.approveUrl);
  await fetch(`${base}${u.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ t: u.searchParams.get('t')!, decision: 'approve' }).toString(),
  });
  return app;
}

before(async () => {
  authServer = await startAuth(process.env.CLOUD_ADMIN_URL!);
  auth = new AuthLink({ url: authServer.url, platformKey: authServer.platformKey, masterKey: process.env.CLOUD_MASTER_KEY! });
  projects = new Projects({ adminUrl: process.env.CLOUD_ADMIN_URL!, dbHost: process.env.CLOUD_DB_HOST!, masterKey: process.env.CLOUD_MASTER_KEY! }, auth);
  await projects.init();
  cloud = createCloudServer({ projects, auth, publicUrl: 'http://placeholder', projectsPerIpPerHour: 1000 });
  await new Promise<void>((r) => cloud.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
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

describe('Guard on a Basalt app', () => {
  test('every check passes, and the owner gets a receipt that lists them', async () => {
    const app = await liveApp();
    const scan = [{ rule: 'browser_storage', file: 'src/app.js', line: 2, problem: 'Data is saved in the browser.', fix: 'Save it with Basalt.' }];
    const r = await call('POST', '/api/projects/me/check', { scan }, app.key);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const failed = r.body.results.filter((c: { passed: boolean }) => !c.passed);
    assert.deepEqual(failed, []);
    const ids = new Set(r.body.results.map((c: { id: string }) => c.id));
    for (const id of ['no_login', 'bad_token', 'forged_token', 'expired_token', 'other_person_get', 'other_person_list', 'other_person_update', 'other_person_archive', 'fake_owner', 'unknown_table', 'filter_injection', 'other_person_file']) {
      assert.ok(ids.has(id), `missing check ${id}`);
    }
    // Every table is checked, not just the first.
    const tables = new Set(r.body.results.map((c: { table?: string }) => c.table).filter(Boolean));
    assert.deepEqual([...tables].sort(), ['bookings', 'photos', 'visits']);
    assert.equal(r.body.failed, 0);
    assert.equal(r.body.passed, r.body.results.length);
    assert.equal(r.body.codeFindings, 1);

    const receipt = await fetch(r.body.receiptUrl);
    const html = await receipt.text();
    assert.equal(receipt.status, 200);
    assert.match(html, new RegExp(`${r.body.passed} of ${r.body.results.length} attacks were refused, 1 thing to fix in the code`));
    assert.match(html, /src\/app\.js/);
    assert.match(html, /Data is saved in the browser/);
  });

  test("the check leaves nothing behind in the owner's data", async () => {
    const app = await liveApp();
    await call('POST', '/api/projects/me/check', {}, app.key);
    const p = (await projects.get(app.id))!;
    const stats = await projects.stats(p);
    assert.equal(stats.tables.bookings.active, 0);
    assert.equal(stats.tables.photos.active, 0);
    assert.equal(stats.tables.visits.active, 0);
  });

  test('needs live rules and the app key, and the receipt needs the owner link', async () => {
    const r = await call('POST', '/api/projects', { name: 'No rules yet' });
    const early = await call('POST', '/api/projects/me/check', {}, r.body.adminKey);
    assert.equal(early.status, 409);
    assert.equal((await call('POST', '/api/projects/me/check', {}, 'bsk_nope')).status, 401);

    const app = await liveApp();
    const done = await call('POST', '/api/projects/me/check', {}, app.key);
    const u = new URL(done.body.receiptUrl);
    assert.equal((await fetch(`${base}${u.pathname}?k=wrong`)).status, 404);
  });

  test('code findings sent with a check are cleaned and capped before the receipt shows them', async () => {
    const app = await liveApp();
    const scan = Array.from({ length: 300 }, (_, i) => ({ rule: 'browser_storage', file: `<script>alert(${i})</script>.js`, line: i, problem: 'x'.repeat(600), fix: 'y' }));
    const r = await call('POST', '/api/projects/me/check', { scan }, app.key);
    assert.equal(r.body.codeFindings, 100);
    const html = await (await fetch(r.body.receiptUrl)).text();
    assert.doesNotMatch(html, /<script>alert/);
  });
});

describe('Guard keeps its receipt honest', () => {
  test("a test entry that couldn't be tidied up isn't shown as a leak", () => {
    const results = [
      { id: 'other_person_get', title: "Opening someone else's entry", passed: true, detail: 'Refused.', table: 'visits' },
      { id: 'cleanup', title: 'Tidying up the test entry', passed: false, detail: "The test entry couldn't be archived. It's marked Basalt check.", table: 'visits' },
    ];
    const html = renderReceipt('demo', { results, findings: [], at: new Date().toISOString() });
    assert.doesNotMatch(html, /LEAKED|got through/);
    assert.match(html, /Leaked: 0/);
  });

  test('a check sent without a code scan says the code was not checked', async () => {
    const app = await liveApp();
    const r = await call('POST', '/api/projects/me/check', {}, app.key);
    assert.equal(r.body.codeFindings, null);
    const html = await (await fetch(r.body.receiptUrl)).text();
    assert.match(html, /wasn't checked this time/);
    assert.doesNotMatch(html, /All of the app/);
  });

  test('changing the rules marks the receipt as out of date', async () => {
    const app = await liveApp();
    const r = await call('POST', '/api/projects/me/check', { scan: [] }, app.key);
    const more = structuredClone(RULES) as any;
    more.tables.visits.fields.note = { type: 'text' };
    assert.equal((await call('PUT', '/api/projects/me/rules', { contract: more }, app.key)).body.status, 'live');
    assert.match(await (await fetch(r.body.receiptUrl)).text(), /rules changed after this check/);
  });

  test("a test person named like Guard's own doesn't break the check", async () => {
    const app = await liveApp();
    assert.equal((await call('POST', '/api/projects/me/test-login', { who: 'basalt-check-a' }, app.key)).status, 200);
    const r = await call('POST', '/api/projects/me/check', {}, app.key);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.failed, 0);
  });

  test('an app that was checked can still be removed completely', async () => {
    const app = await liveApp();
    await call('POST', '/api/projects/me/check', {}, app.key);
    await projects.delete((await projects.get(app.id))!);
    assert.equal(await projects.get(app.id), null);
  });

  test('one check at a time per app', async () => {
    const app = await liveApp();
    const [a, b] = await Promise.all([call('POST', '/api/projects/me/check', {}, app.key), call('POST', '/api/projects/me/check', {}, app.key)]);
    assert.deepEqual([a.status, b.status].sort(), [200, 429]);
  });
});

describe('Guard on an app that leaks', () => {
  // A plain data API like many vibe coded apps have: it answers every request
  // and never checks who's asking.
  test('the checks fail, so a leak is never reported as safe', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const leaky = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      const op = req.url!.split('/').pop();
      const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
      if (op === 'create') {
        const row = { id: randomUUID(), ...body.input };
        rows.set(row.id, row);
        return send(row);
      }
      if (op === 'get') return send(rows.get(body.id) ?? null);
      if (op === 'list') return send({ rows: [...rows.values()], next: null });
      if (op === 'update') return send(Object.assign(rows.get(body.id) ?? {}, body.input));
      if (op === 'archive' || op === 'restore') return send(rows.get(body.id) ?? null);
      res.writeHead(404).end('{}');
    });
    await new Promise<void>((r) => leaky.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(leaky.address() as AddressInfo).port}`;
      const contract = parseContract({ tables: { bookings: RULES.tables.bookings, visits: RULES.tables.visits } });
      const results = await runChecks(contract, { url, tokenA: 'a.a.a', tokenB: 'b.b.b', userA: randomUUID(), forged: 'f.f.f', expired: 'e.e.e' });
      const failed = new Set(results.filter((c) => !c.passed).map((c) => c.id));
      for (const id of ['no_login', 'bad_token', 'forged_token', 'expired_token', 'other_person_get', 'other_person_list', 'other_person_update', 'other_person_archive', 'fake_owner']) {
        assert.ok(failed.has(id), `${id} should fail on a leaky app`);
      }
      // The second table is checked too.
      assert.ok(results.some((c) => c.table === 'visits' && c.id === 'other_person_list' && !c.passed));
    } finally {
      leaky.close();
    }
  });
});

describe('Guard on a safe app with a unique number field', () => {
  // Stored rules come back from Postgres jsonb with short field names first, so Guard can pick a
  // unique number like "spot" for the change check. A's test entry gets a random spot; if Guard
  // guessed the entry held the default and tried the value it already had, a refused change looked
  // like B had changed it. This app is safe and always stores spot 2, the value that collided.
  test("a refused change is never reported as a change, whatever value A's entry holds", async () => {
    const rows = new Map<string, { owner: string; row: Record<string, unknown> }>();
    const app = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      const op = req.url!.split('/').pop();
      const who = req.headers.authorization ?? '';
      const send = (status: number, json: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      const notFound = () => send(404, { ok: false, error: { code: 'not_found', message: 'No such entry.' } });
      if (who !== 'Bearer a.a.a' && who !== 'Bearer b.b.b') return send(401, { ok: false, error: { code: 'unauthorized', message: 'Sign in.' } });
      if (op === 'create') {
        if (body.input?.owner_id !== undefined) return send(400, { ok: false, error: { code: 'invalid_input', message: 'No.' } });
        const row = { id: randomUUID(), ...body.input, ...('spot' in (body.input ?? {}) ? { spot: 2 } : {}) };
        rows.set(row.id, { owner: who, row });
        return send(200, { ok: true, data: row });
      }
      const mine = rows.get(body.id);
      if (op === 'list') return send(200, { ok: true, data: { rows: [...rows.values()].filter((r) => r.owner === who).map((r) => r.row), next: null } });
      if (!mine || mine.owner !== who) return notFound();
      if (op === 'get' || op === 'archive' || op === 'restore') return send(200, { ok: true, data: mine.row });
      if (op === 'update') return send(200, { ok: true, data: Object.assign(mine.row, body.input) });
      return notFound();
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
      const contract = parseContract({ tables: { bookings: { fields: { spot: { type: 'integer', min: 1, max: 20, required: true }, class_id: { type: 'text', maxLength: 40, required: true } }, unique: [['class_id', 'spot']] } } });
      const results = await runChecks(contract, { url, tokenA: 'a.a.a', tokenB: 'b.b.b', userA: randomUUID(), forged: 'f.f.f', expired: 'e.e.e' });
      const update = results.find((c) => c.id === 'other_person_update');
      assert.equal(update?.passed, true, update?.detail);
    } finally {
      app.close();
    }
  });
});

describe('Guard on an app that is down', () => {
  // Errors aren't proof of safety. An app that saves and shows the owner's own
  // entry but answers everything else with 503 must not get a clean receipt.
  test('errors count as "couldn\'t tell", never as passed', async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const flaky = createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      const op = req.url!.split('/').pop();
      const asA = req.headers.authorization === 'Bearer a.a.a';
      const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, data }));
      if (asA && op === 'create') {
        const row = { id: randomUUID(), ...body.input };
        rows.set(row.id, row);
        return send(row);
      }
      if (asA && (op === 'get' || op === 'update' || op === 'archive')) return send(rows.get(body.id) ?? null);
      res.writeHead(503, { 'content-type': 'application/json' }).end('{"ok":false,"error":{"code":"unavailable","message":"busy"}}');
    });
    await new Promise<void>((r) => flaky.listen(0, '127.0.0.1', () => r()));
    try {
      const url = `http://127.0.0.1:${(flaky.address() as AddressInfo).port}`;
      const contract = parseContract({ tables: { bookings: RULES.tables.bookings } });
      const results = await runChecks(contract, { url, tokenA: 'a.a.a', tokenB: 'b.b.b', userA: randomUUID(), forged: 'f.f.f', expired: 'e.e.e' });
      const passed = results.filter((c) => c.passed).map((c) => c.id);
      assert.deepEqual(passed, []);
      assert.ok(results.some((c) => /couldn't tell/i.test(c.detail)));
    } finally {
      flaky.close();
    }
  });
});
