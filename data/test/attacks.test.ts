// Attack tests for the Data block. Every one of these has to pass before a push.
// Needs the local database running (npm run db:up) and .env filled in.

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { BasaltData, BasaltError, createBasalt, createDataServer, FORMATS, parseContract } from '../src/index.ts';
import { migrate } from '../src/migrate.ts';
import { makeToken, userToken } from './helpers.ts';

const contractJson = JSON.parse(readFileSync(new URL('../contract.example.json', import.meta.url), 'utf8'));
const contract = parseContract(contractJson);
const DATA_URL = process.env.BASALT_DATA_URL!;
const ADMIN_URL = process.env.BASALT_ADMIN_URL!;
const START = '2026-10-25T15:00:00Z';

const alice = randomUUID();
const bob = randomUUID();
const aliceToken = userToken(alice);
const bobToken = userToken(bob);

let db: BasaltData;
let aliceBooking: Record<string, unknown>;

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof BasaltError, `expected a BasaltError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: ADMIN_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Connects straight to Postgres as the Data service's login, as if an attacker
// had taken over the Data service and could run any SQL they like.
async function asRawDataLogin<T>(fn: (c: pg.Client) => Promise<T>, url = DATA_URL): Promise<T> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// Expects the database itself to refuse, with permission denied (42501).
async function refusedByDb(fn: (c: pg.Client) => Promise<unknown>): Promise<void> {
  await assert.rejects(asRawDataLogin(fn), (err: { code?: string }) => {
    assert.equal(err.code, '42501', `expected permission denied, got ${err.code}`);
    return true;
  });
}

async function withToken(c: pg.Client, token: string): Promise<void> {
  await c.query('begin');
  await c.query(`select set_config('basalt.jwt', $1, true)`, [token]);
}

before(async () => {
  await migrate(ADMIN_URL, contractJson);
  await admin((c) => c.query('update basalt.settings set reads_per_minute = 1000000, writes_per_minute = 1000000'));
  db = new BasaltData({ connectionString: DATA_URL, contract });
  aliceBooking = await db.create(aliceToken, 'bookings', { service: 'Haircut', starts_at: START, phone: '+1 413 555 0100' });
});

after(async () => {
  await admin((c) => c.query('update basalt.settings set reads_per_minute = 600, writes_per_minute = 60'));
  await db.close();
});

describe('normal use still works', () => {
  test('a user can create, read, list and update their own booking', async () => {
    assert.equal(aliceBooking.owner_id, alice);
    const got = await db.get(aliceToken, 'bookings', aliceBooking.id as string);
    assert.equal(got.service, 'Haircut');
    const updated = await db.update(aliceToken, 'bookings', aliceBooking.id as string, { note: 'Short on the sides' });
    assert.equal(updated.note, 'Short on the sides');
    const { rows } = await db.list(aliceToken, 'bookings');
    assert.ok(rows.some((r) => r.id === aliceBooking.id));
  });

  test('list pages through rows without repeats', async () => {
    const t = userToken(randomUUID());
    for (let i = 0; i < 5; i++) await db.create(t, 'bookings', { service: `S${i}`, starts_at: START });
    const seen = new Set<unknown>();
    let next: string | null | undefined;
    do {
      const page = await db.list(t, 'bookings', { limit: 2, after: next ?? undefined });
      for (const r of page.rows) {
        assert.ok(!seen.has(r.id));
        seen.add(r.id);
      }
      next = page.next;
    } while (next);
    assert.equal(seen.size, 5);
  });

  test('valid formats are accepted', async () => {
    const row = await db.create(aliceToken, 'bookings', { service: 'X', starts_at: START, email: 'maria@salon.com', phone: '(413) 555-0100' });
    assert.equal(row.email, 'maria@salon.com');
  });
});

describe("someone else's data", () => {
  test("bob cannot read alice's booking, and it looks like it doesn't exist", async () => {
    await rejects(db.get(bobToken, 'bookings', aliceBooking.id as string), 'not_found');
  });

  test("bob's list never includes alice's rows", async () => {
    const { rows } = await db.list(bobToken, 'bookings', { limit: 100 });
    assert.ok(rows.every((r) => r.owner_id === bob));
  });

  test("bob cannot update alice's booking", async () => {
    await rejects(db.update(bobToken, 'bookings', aliceBooking.id as string, { note: 'hacked' }), 'not_found');
  });
});

describe('forged or broken logins', () => {
  const now = () => Math.floor(Date.now() / 1000);

  test('no token', async () => {
    await rejects(db.list('', 'bookings'), 'denied');
  });

  test('token signed with the wrong secret', async () => {
    await rejects(db.list(makeToken({ sub: alice, secret: 'not-the-real-secret-not-the-real-secret' }), 'bookings'), 'denied');
  });

  test('alg none token', async () => {
    await rejects(db.list(makeToken({ sub: alice, alg: 'none' }), 'bookings'), 'denied');
  });

  test('expired token', async () => {
    await rejects(db.list(makeToken({ sub: alice, expiresIn: -10 }), 'bookings'), 'denied');
  });

  test('token with no expiry or no issued-at time', async () => {
    await rejects(db.list(makeToken({ sub: alice, omitExp: true }), 'bookings'), 'denied');
    await rejects(db.list(makeToken({ sub: alice, omitIat: true }), 'bookings'), 'denied');
  });

  test('token that lives longer than allowed', async () => {
    await rejects(db.list(makeToken({ sub: alice, expiresIn: 7200 }), 'bookings'), 'denied');
  });

  test('token issued in the future', async () => {
    await rejects(db.list(makeToken({ sub: alice, issuedAgo: -600, expiresIn: 600 }), 'bookings'), 'denied');
  });

  test('expiry written as a string', async () => {
    await rejects(db.list(makeToken({ sub: alice, override: { exp: String(now() + 600) } }), 'bookings'), 'denied');
  });

  test('a hash of the user id is not a login', async () => {
    await rejects(db.list(createHash('sha256').update(alice).digest('hex'), 'bookings'), 'denied');
  });

  test('payload swapped to another user keeps the old signature', async () => {
    const [h, , s] = aliceToken.split('.');
    const forged = JSON.stringify({ sub: bob, aud: 'authenticated', role: 'authenticated', iat: now(), exp: now() + 600 });
    await rejects(db.list(`${h}.${Buffer.from(forged).toString('base64url')}.${s}`, 'bookings'), 'denied');
  });

  test('a service or admin role claim gets nothing', async () => {
    await rejects(db.list(makeToken({ sub: alice, role: 'service_role' }), 'bookings'), 'denied');
  });

  test('non-canonical encodings are refused by the database too', async () => {
    const padded = `${aliceToken}=`;
    const spaced = aliceToken.replace('.', ' .');
    for (const t of [padded, spaced]) {
      const res = await asRawDataLogin(async (c) => {
        await withToken(c, t);
        return c.query('select basalt.uid() as uid');
      });
      assert.equal(res.rows[0].uid, null);
    }
  });

  test('a token with a different spelling of the same signature is refused', async () => {
    const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const [h, p, sig] = aliceToken.split('.');
    const last = abc.indexOf(sig[42]);
    const twin = `${h}.${p}.${sig.slice(0, 42)}${abc[last ^ 1]}`;
    assert.deepEqual(Buffer.from(twin.split('.')[2], 'base64url'), Buffer.from(sig, 'base64url'));
    await rejects(db.list(twin, 'bookings'), 'denied');
  });

  test('fractional expiry and the all-zero user id are refused', async () => {
    await rejects(db.list(makeToken({ sub: alice, override: { exp: now() + 600.5 } }), 'bookings'), 'denied');
    await rejects(db.list(makeToken({ sub: '00000000-0000-0000-0000-000000000000' }), 'bookings'), 'denied');
  });

  test('an old transaction cannot keep using a token after it expires', async () => {
    const shortLived = makeToken({ sub: alice, expiresIn: 1 });
    const counts = await asRawDataLogin(async (c) => {
      await withToken(c, shortLived);
      const before = await c.query('select count(*)::int as n from app.bookings');
      await new Promise((r) => setTimeout(r, 1600));
      const afterExpiry = await c.query('select count(*)::int as n from app.bookings');
      return [before.rows[0].n, afterExpiry.rows[0].n];
    });
    assert.ok(counts[0] > 0);
    assert.equal(counts[1], 0);
  });
});

describe('injection and bad input', () => {
  test('SQL in a value is stored as plain text', async () => {
    const evil = "x'); drop table app.bookings; --";
    const row = await db.create(aliceToken, 'bookings', { service: 'Color', starts_at: START, note: evil });
    assert.equal(row.note, evil);
  });

  test('SQL in a table name is refused', async () => {
    await rejects(db.list(aliceToken, 'bookings; drop table app.bookings'), 'invalid_input');
  });

  test('SQL in an id is refused', async () => {
    await rejects(db.get(aliceToken, 'bookings', "1' or '1'='1"), 'invalid_input');
  });

  test('setting owner_id to someone else is refused', async () => {
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: START, owner_id: bob }), 'invalid_input');
  });

  test('changing owner_id or id on update is refused', async () => {
    await rejects(db.update(aliceToken, 'bookings', aliceBooking.id as string, { owner_id: bob }), 'invalid_input');
    await rejects(db.update(aliceToken, 'bookings', aliceBooking.id as string, { id: randomUUID() }), 'invalid_input');
  });

  test('__proto__ and unknown fields are refused', async () => {
    const payload = JSON.parse(`{"service":"X","starts_at":"${START}","__proto__":{"admin":true}}`);
    await rejects(db.create(aliceToken, 'bookings', payload), 'invalid_input');
  });

  test('values that break the contract are refused', async () => {
    await rejects(db.create(aliceToken, 'bookings', { service: 'x'.repeat(101), starts_at: START }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: 'tomorrow' }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: START, phone: 'call me' }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: START, email: 'not an email' }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: START, party_size: 500 }), 'invalid_input');
  });

  test('the database enforces formats and limits even if the code check is skipped', async () => {
    for (const sql of [
      `insert into app.bookings (service, starts_at, phone) values ('x', now(), 'call me')`,
      `insert into app.bookings (service, starts_at) values (repeat('x', 101), now())`,
      `insert into app.bookings (service, starts_at) values ('x', 'infinity')`,
      `insert into app.bookings (service, starts_at, party_size) values ('x', now(), 500)`,
    ]) {
      await assert.rejects(
        asRawDataLogin(async (c) => {
          await withToken(c, aliceToken);
          await c.query(sql);
        }),
        (err: { code?: string }) => err.code === '23514',
      );
    }
  });

  test('every text format compiles and behaves the same in Postgres', async () => {
    const samples: Record<string, [string, string]> = {
      email: ['maria@salon.com', 'maria at salon'],
      phone: ['+1 413 555 0100', 'call me'],
      url: ['https://salon.com/book', 'javascript:alert(1)'],
      postal_code: ['01003', '!!'],
      slug: ['marias-salon', 'Marias Salon'],
    };
    await admin(async (c) => {
      for (const [name, pattern] of Object.entries(FORMATS)) {
        const [good, badValue] = samples[name];
        const res = await c.query('select $1::text ~ $3 as good, $2::text ~ $3 as bad', [good, badValue, pattern]);
        assert.equal(res.rows[0].good, true, `${name} should accept ${good}`);
        assert.equal(res.rows[0].bad, false, `${name} should refuse ${badValue}`);
        assert.equal(new RegExp(pattern, 'u').test(good), true);
        assert.equal(new RegExp(pattern, 'u').test(badValue), false);
      }
    });
  });

  test('contracts with free-form regex patterns are refused', () => {
    assert.throws(() => parseContract({ tables: { t: { fields: { a: { type: 'text', pattern: '^(a|aa)+$' } } } } }));
  });

  test('page size is capped', async () => {
    await rejects(db.list(aliceToken, 'bookings', { limit: 100000 }), 'invalid_input');
  });

  test('a forged page cursor is refused', async () => {
    await rejects(db.list(aliceToken, 'bookings', { after: "'; drop table x; --" }), 'invalid_input');
    const fake = Buffer.from(JSON.stringify(['infinity', randomUUID()])).toString('base64url');
    await rejects(db.list(aliceToken, 'bookings', { after: fake }), 'invalid_input');
  });
});

describe('damage limits', () => {
  test('limits are enforced in the database, across every service instance', async () => {
    const user = userToken(randomUUID());
    const second = new BasaltData({ connectionString: DATA_URL, contract });
    await admin((c) => c.query('update basalt.settings set reads_per_minute = 30'));
    try {
      await db.list(user, 'bookings', { limit: 20 });
      // A different instance shares the same counter.
      await rejects(second.list(user, 'bookings', { limit: 20 }), 'rate_limited');
    } finally {
      await admin((c) => c.query('update basalt.settings set reads_per_minute = 1000000'));
      await second.close();
    }
  });
});

describe('damage limits stick', () => {
  test('requests that fail still count against the limit', async () => {
    const user = userToken(randomUUID());
    await admin((c) => c.query('update basalt.settings set reads_per_minute = 3'));
    try {
      for (let i = 0; i < 3; i++) await rejects(db.get(user, 'bookings', randomUUID()), 'not_found');
      await rejects(db.get(user, 'bookings', randomUUID()), 'rate_limited');
    } finally {
      await admin((c) => c.query('update basalt.settings set reads_per_minute = 1000000'));
    }
  });
});

describe('audit log', () => {
  test('records changes but skips updates that change nothing', async () => {
    const row = await db.create(aliceToken, 'bookings', { service: 'Trim', starts_at: START });
    const count = () =>
      admin((c) => c.query<{ n: number }>('select count(*)::int as n from basalt.audit where row_id = $1', [row.id])).then((r) => r.rows[0].n);
    assert.equal(await count(), 1);
    await db.update(aliceToken, 'bookings', row.id as string, { service: 'Trim' });
    assert.equal(await count(), 1);
    await db.update(aliceToken, 'bookings', row.id as string, { service: 'Fade' });
    assert.equal(await count(), 2);
    const cols = await admin((c) => c.query(`select columns from basalt.audit where row_id = $1 and op = 'UPDATE'`, [row.id]));
    assert.deepEqual(cols.rows[0].columns, ['service']);
  });
});

describe('migrations', () => {
  test('a stale permissive policy is removed when the contract is applied again', async () => {
    await admin((c) => c.query(`create policy sneaky on app.bookings for select to basalt_data using (true)`));
    await migrate(ADMIN_URL, contractJson);
    await rejects(db.get(bobToken, 'bookings', aliceBooking.id as string), 'not_found');
  });

  test('changing an existing table is refused, not silently half applied', async () => {
    const changed = structuredClone(contractJson);
    changed.tables.bookings.fields.vip = { type: 'boolean' };
    await assert.rejects(migrate(ADMIN_URL, changed), /needs a reviewed migration/);
  });

  test('loosening a rule on an existing field is refused too', async () => {
    const changed = structuredClone(contractJson);
    changed.tables.bookings.fields.service.maxLength = 5000;
    await assert.rejects(migrate(ADMIN_URL, changed), /needs a reviewed migration/);
    const fmt = structuredClone(contractJson);
    delete fmt.tables.bookings.fields.phone.format;
    await assert.rejects(migrate(ADMIN_URL, fmt), /needs a reviewed migration/);
  });
});

describe('even with the Data service fully taken over', () => {
  test('raw SQL with no token sees zero rows', async () => {
    const res = await asRawDataLogin((c) => c.query('select count(*)::int as n from app.bookings'));
    assert.equal(res.rows[0].n, 0);
  });

  test('cannot read the settings, usage counters or audit log', async () => {
    await refusedByDb((c) => c.query('select * from basalt.settings'));
    await refusedByDb((c) => c.query('select * from basalt.usage'));
    await refusedByDb((c) => c.query('select * from basalt.audit'));
    await refusedByDb((c) => c.query('delete from basalt.audit'));
    await refusedByDb((c) => c.query('select basalt.prune_usage()'));
  });

  test('cannot delete rows', async () => {
    await refusedByDb(async (c) => {
      await withToken(c, aliceToken);
      await c.query('delete from app.bookings');
    });
  });

  test('cannot drop, change or create tables', async () => {
    await refusedByDb((c) => c.query('drop table app.bookings'));
    await refusedByDb((c) => c.query('alter table app.bookings disable row level security'));
    await refusedByDb((c) => c.query('create table app.stash (x text)'));
    await refusedByDb((c) => c.query('create temp table stash (x text)'));
  });

  test('cannot turn off row rules for itself', async () => {
    await refusedByDb((c) => c.query('set row_security = off; select * from app.bookings'));
  });

  test('cannot write owner_id directly even with raw SQL', async () => {
    await refusedByDb(async (c) => {
      await withToken(c, aliceToken);
      await c.query(`insert into app.bookings (service, starts_at, owner_id) values ('x', now(), $1)`, [bob]);
    });
  });

  test('setting a fake user id variable does nothing', async () => {
    const res = await asRawDataLogin(async (c) => {
      await c.query(`select set_config('basalt.uid', $1, false)`, [alice]);
      await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [alice]);
      return c.query('select count(*)::int as n from app.bookings');
    });
    assert.equal(res.rows[0].n, 0);
  });

  test("cannot forge or reuse the verified-login note", async () => {
    // Grab a real note from alice's own transaction.
    const note = await asRawDataLogin(async (c) => {
      await withToken(c, aliceToken);
      await c.query('select basalt.uid()');
      return (await c.query(`select current_setting('basalt.verified') as v`)).rows[0].v as string;
    });
    assert.match(note, /^[0-9a-f-]{36}\|\d+\|[0-9a-f]{64}$/);
    const [, exp, tag] = note.split('|');
    const garbageToken = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(43)}`;

    const results = await asRawDataLogin(async (c) => {
      const out: (string | null)[] = [];
      for (const [tok, fake] of [
        [garbageToken, `${alice}|${exp}|${tag}`], // alice's real note with a different token
        [garbageToken, `${alice}|${exp}|${'0'.repeat(64)}`], // made up seal
        [bobToken, `${alice}|${exp}|${tag}`], // bob's real token, alice's note
        [aliceToken, `${bob}|${exp}|${tag}`], // alice's token, note edited to bob
      ]) {
        await c.query('begin');
        await c.query(`select set_config('basalt.jwt', $1, true), set_config('basalt.verified', $2, true)`, [tok, fake]);
        out.push((await c.query('select basalt.uid() as u')).rows[0].u);
        await c.query('rollback');
      }
      return out;
    });
    assert.deepEqual(results, [null, null, bob, alice]);
  });

  test('cannot stash data in large objects, hold advisory locks, sleep or kill sessions', async () => {
    await refusedByDb((c) => c.query(`select lo_from_bytea(0, 'stolen'::bytea)`));
    await refusedByDb((c) => c.query('select lo_create(0)'));
    await refusedByDb((c) => c.query('select pg_advisory_lock(1)'));
    await refusedByDb((c) => c.query('select pg_try_advisory_xact_lock(1)'));
    await refusedByDb((c) => c.query('select pg_sleep(1)'));
    await refusedByDb((c) => c.query('select pg_terminate_backend(pg_backend_pid())'));
  });

  test('cannot connect to other databases', async () => {
    await assert.rejects(asRawDataLogin(async () => {}, DATA_URL.replace(/\/postgres$/, '/template1')));
  });
});

describe('the HTTP service app code talks to', () => {
  let url: string;
  let server: ReturnType<typeof createDataServer>;

  before(async () => {
    server = createDataServer({ data: db, maxBodyBytes: 4096 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
  });

  test('the client does the four calls end to end', async () => {
    const basalt = createBasalt({ url, token: () => aliceToken });
    const row = await basalt.data.create('bookings', { service: 'Beard', starts_at: START });
    assert.equal((await basalt.data.get('bookings', row.id as string)).service, 'Beard');
    assert.equal((await basalt.data.update('bookings', row.id as string, { note: 'hi' })).note, 'hi');
    assert.ok((await basalt.data.list('bookings', { limit: 5 })).rows.length > 0);
  });

  test("bob's client can't see alice's booking", async () => {
    const basalt = createBasalt({ url, token: bobToken });
    await rejects(basalt.data.get('bookings', aliceBooking.id as string), 'not_found');
  });

  test('no login gets 401', async () => {
    const res = await fetch(`${url}/v1/data/list`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"table":"bookings"}' });
    assert.equal(res.status, 401);
  });

  test('unknown routes, like a raw SQL or delete endpoint, get 404', async () => {
    for (const op of ['sql', 'delete', 'query']) {
      const res = await fetch(`${url}/v1/data/${op}`, { method: 'POST', headers: { authorization: `Bearer ${aliceToken}` } });
      assert.equal(res.status, 404);
    }
  });

  test('oversized and non-JSON bodies are refused', async () => {
    const big = await fetch(`${url}/v1/data/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ table: 'bookings', input: { note: 'x'.repeat(10000) } }),
    });
    assert.equal(big.status, 400);
    const text = await fetch(`${url}/v1/data/list`, { method: 'POST', headers: { 'content-type': 'text/plain', authorization: `Bearer ${aliceToken}` }, body: 'hi' });
    assert.equal(text.status, 400);
  });

  test('errors never include database details', async () => {
    const res = await fetch(`${url}/v1/data/get`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
      body: JSON.stringify({ table: 'bookings', id: aliceBooking.id, extra: "' or 1=1" }),
    });
    const body = await res.text();
    assert.ok(!/postgres|sql|relation|syntax|pg_/i.test(body));
  });

  test('a bad token is refused before the body is read', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/v1/data/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer a', 'content-length': '1000' },
      });
      req.on('response', (res) => resolve(res.statusCode ?? 0));
      req.on('error', reject);
      req.write('{"table":'); // never finish the body
    });
    assert.equal(status, 401);
  });

  test('big pages are trimmed to fit and paging still covers every row', async () => {
    const user = randomUUID();
    const t = userToken(user);
    for (let i = 0; i < 6; i++) await db.create(t, 'bookings', { service: 'Big', starts_at: START, note: 'n'.repeat(900) });
    const small = createDataServer({ data: db, maxListBytes: 3000 });
    await new Promise<void>((r) => small.listen(0, '127.0.0.1', () => r()));
    try {
      const basalt = createBasalt({ url: `http://127.0.0.1:${(small.address() as AddressInfo).port}`, token: t });
      const seen = new Set<unknown>();
      let next: string | null | undefined;
      let pages = 0;
      do {
        const page = await basalt.data.list('bookings', { limit: 100, after: next ?? undefined });
        assert.ok(Buffer.byteLength(JSON.stringify(page.rows)) <= 3000 || page.rows.length === 1);
        page.rows.forEach((r) => seen.add(r.id));
        next = page.next;
        pages++;
      } while (next);
      assert.equal(seen.size, 6);
      assert.ok(pages > 1);
    } finally {
      await new Promise((r) => small.close(r));
    }
  });

  test('sheds load when too many requests are in flight', async () => {
    const tiny = createDataServer({ data: db, maxInFlight: 0 });
    await new Promise<void>((r) => tiny.listen(0, '127.0.0.1', () => r()));
    try {
      const res = await fetch(`http://127.0.0.1:${(tiny.address() as AddressInfo).port}/v1/data/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${aliceToken}` },
        body: '{"table":"bookings"}',
      });
      assert.equal(res.status, 503);
    } finally {
      await new Promise((r) => tiny.close(r));
    }
  });
});
