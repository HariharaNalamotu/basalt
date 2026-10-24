// Attack tests for the Data block. Every one of these has to pass before a push.
// Needs the local database running (npm run db:up) and .env filled in.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { BasaltData, BasaltError, parseContract } from '../src/index.ts';
import { migrate } from '../src/migrate.ts';
import { makeToken, userToken } from './helpers.ts';

const contractJson = JSON.parse(readFileSync(new URL('../contract.example.json', import.meta.url), 'utf8'));
const contract = parseContract(contractJson);
const DATA_URL = process.env.BASALT_DATA_URL!;
const ADMIN_URL = process.env.BASALT_ADMIN_URL!;

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

// Connects straight to Postgres as the Data block's login, as if an attacker
// had taken over the Data block and could run any SQL they like.
async function asRawDataLogin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: DATA_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

before(async () => {
  await migrate(ADMIN_URL, contractJson);
  db = new BasaltData({ connectionString: DATA_URL, contract, maxRowsReadPerMinute: 1000, maxWritesPerMinute: 1000 });
  aliceBooking = await db.create(aliceToken, 'bookings', {
    service: 'Haircut',
    starts_at: '2026-10-25T15:00:00Z',
    phone: '+1 413 555 0100',
  });
});

after(async () => {
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
    const carol = randomUUID();
    const t = userToken(carol);
    for (let i = 0; i < 5; i++) await db.create(t, 'bookings', { service: `S${i}`, starts_at: '2026-10-25T15:00:00Z' });
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
});

describe('someone else\'s data', () => {
  test('bob cannot read alice\'s booking, and it looks like it doesn\'t exist', async () => {
    await rejects(db.get(bobToken, 'bookings', aliceBooking.id as string), 'not_found');
  });

  test('bob\'s list never includes alice\'s rows', async () => {
    const { rows } = await db.list(bobToken, 'bookings', { limit: 100 });
    assert.ok(rows.every((r) => r.owner_id === bob));
  });

  test('bob cannot update alice\'s booking', async () => {
    await rejects(db.update(bobToken, 'bookings', aliceBooking.id as string, { note: 'hacked' }), 'not_found');
  });
});

describe('forged or broken logins', () => {
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

  test('token with no expiry', async () => {
    await rejects(db.list(makeToken({ sub: alice, omitExp: true }), 'bookings'), 'denied');
  });

  test('a hash of the user id is not a login', async () => {
    const { createHash } = await import('node:crypto');
    await rejects(db.list(createHash('sha256').update(alice).digest('hex'), 'bookings'), 'denied');
  });

  test('payload swapped to another user keeps the old signature', async () => {
    const [h, , s] = aliceToken.split('.');
    const forged = JSON.stringify({ sub: bob, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 600 });
    await rejects(db.list(`${h}.${Buffer.from(forged).toString('base64url')}.${s}`, 'bookings'), 'denied');
  });

  test('a service or admin role claim gets nothing extra', async () => {
    await rejects(db.list(makeToken({ sub: alice, role: 'service_role' }), 'bookings'), 'denied');
  });
});

describe('injection and bad input', () => {
  test('SQL in a value is stored as plain text', async () => {
    const evil = "x'); drop table app.bookings; --";
    const row = await db.create(aliceToken, 'bookings', { service: 'Color', starts_at: '2026-10-25T15:00:00Z', note: evil });
    assert.equal(row.note, evil);
    await db.get(aliceToken, 'bookings', row.id as string);
  });

  test('SQL in a table name is refused', async () => {
    await rejects(db.list(aliceToken, 'bookings; drop table app.bookings'), 'invalid_input');
  });

  test('SQL in an id is refused', async () => {
    await rejects(db.get(aliceToken, 'bookings', "1' or '1'='1"), 'invalid_input');
  });

  test('setting owner_id to someone else is refused', async () => {
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: '2026-10-25T15:00:00Z', owner_id: bob }), 'invalid_input');
  });

  test('changing owner_id or id on update is refused', async () => {
    await rejects(db.update(aliceToken, 'bookings', aliceBooking.id as string, { owner_id: bob }), 'invalid_input');
    await rejects(db.update(aliceToken, 'bookings', aliceBooking.id as string, { id: randomUUID() }), 'invalid_input');
  });

  test('__proto__ and unknown fields are refused', async () => {
    const payload = JSON.parse('{"service":"X","starts_at":"2026-10-25T15:00:00Z","__proto__":{"admin":true}}');
    await rejects(db.create(aliceToken, 'bookings', payload), 'invalid_input');
  });

  test('values that break the contract are refused', async () => {
    await rejects(db.create(aliceToken, 'bookings', { service: 'x'.repeat(101), starts_at: '2026-10-25T15:00:00Z' }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: 'tomorrow' }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: '2026-10-25T15:00:00Z', phone: 'call me' }), 'invalid_input');
    await rejects(db.create(aliceToken, 'bookings', { service: 'X', starts_at: '2026-10-25T15:00:00Z', party_size: 500 }), 'invalid_input');
  });

  test('page size is capped', async () => {
    await rejects(db.list(aliceToken, 'bookings', { limit: 100000 }), 'invalid_input');
  });

  test('a forged page cursor is refused', async () => {
    await rejects(db.list(aliceToken, 'bookings', { after: "'; drop table x; --" }), 'invalid_input');
  });
});

describe('damage limits', () => {
  test('one user pulling too many rows gets cut off', async () => {
    const small = new BasaltData({ connectionString: DATA_URL, contract, maxRowsReadPerMinute: 30 });
    try {
      await small.list(aliceToken, 'bookings', { limit: 20 });
      await rejects(small.list(aliceToken, 'bookings', { limit: 20 }), 'rate_limited');
    } finally {
      await small.close();
    }
  });
});

describe('even with the Data block fully taken over', () => {
  test('raw SQL with no token sees zero rows', async () => {
    const res = await asRawDataLogin((c) => c.query('select count(*)::int as n from app.bookings'));
    assert.equal(res.rows[0].n, 0);
  });

  test('cannot read the signing secret', async () => {
    await assert.rejects(asRawDataLogin((c) => c.query('select * from basalt.secrets')));
  });

  test('cannot read or edit the audit log', async () => {
    await assert.rejects(asRawDataLogin((c) => c.query('select * from basalt.audit')));
    await assert.rejects(asRawDataLogin((c) => c.query('delete from basalt.audit')));
  });

  test('cannot delete rows', async () => {
    await assert.rejects(
      asRawDataLogin(async (c) => {
        await c.query('begin');
        await c.query(`select set_config('basalt.jwt', $1, true)`, [aliceToken]);
        await c.query('delete from app.bookings');
      }),
    );
  });

  test('cannot drop or change tables', async () => {
    await assert.rejects(asRawDataLogin((c) => c.query('drop table app.bookings')));
    await assert.rejects(asRawDataLogin((c) => c.query('alter table app.bookings disable row level security')));
    await assert.rejects(asRawDataLogin((c) => c.query('create table app.stash (x text)')));
  });

  test('cannot turn off row rules for itself', async () => {
    await assert.rejects(asRawDataLogin((c) => c.query('set row_security = off; select * from app.bookings')));
  });

  test('cannot write owner_id directly even with raw SQL', async () => {
    await assert.rejects(
      asRawDataLogin(async (c) => {
        await c.query('begin');
        await c.query(`select set_config('basalt.jwt', $1, true)`, [aliceToken]);
        await c.query(`insert into app.bookings (service, starts_at, owner_id) values ('x', now(), $1)`, [bob]);
      }),
    );
  });

  test('setting a fake user id variable does nothing', async () => {
    const res = await asRawDataLogin(async (c) => {
      await c.query(`select set_config('basalt.uid', $1, false)`, [alice]);
      await c.query(`select set_config('request.jwt.claim.sub', $1, false)`, [alice]);
      return c.query('select count(*)::int as n from app.bookings');
    });
    assert.equal(res.rows[0].n, 0);
  });
});
