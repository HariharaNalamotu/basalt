// Guard: the safety check Claude runs before an app goes live. Needs the local
// database (cd ../data && npm run db:up) and .env filled in.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { parseContract } from '../../data/src/index.ts';
import { runChecks } from '../src/guard.ts';
import { Projects } from '../src/projects.ts';
import { createCloudServer } from '../src/server.ts';

const projects = new Projects({ adminUrl: process.env.CLOUD_ADMIN_URL!, dbHost: process.env.CLOUD_DB_HOST!, masterKey: process.env.CLOUD_MASTER_KEY! });
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
  await projects.init();
  cloud = createCloudServer({ projects, publicUrl: 'http://placeholder', projectsPerIpPerHour: 1000 });
  await new Promise<void>((r) => cloud.server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(cloud.server.address() as AddressInfo).port}`;
  cloud.server.close();
  cloud = createCloudServer({ projects, publicUrl: base, projectsPerIpPerHour: 1000 });
  await new Promise<void>((r) => cloud.server.listen(Number(new URL(base).port), '127.0.0.1', () => r()));
});

after(async () => {
  await cloud.close();
  await new Promise((r) => cloud.server.close(r));
  await projects.close();
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
    assert.match(html, new RegExp(`${r.body.passed} of ${r.body.results.length} checks passed, 1 thing to fix in the code`));
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
