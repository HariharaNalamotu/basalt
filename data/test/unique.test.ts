// "Unique across everyone": no two active entries may share a value, like two bookings at the
// same time, even though each person only ever sees their own. Needs the local database and .env.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { BasaltData, BasaltError, parseContract } from '../src/index.ts';
import { migrate } from '../src/migrate.ts';
import { userToken } from './helpers.ts';

// Its own tables, so it never collides with the fields other test files add.
const contractJson = {
  tables: {
    slots: {
      fields: { starts_at: { type: 'timestamp', required: true }, chair: { type: 'integer', min: 1, max: 4, required: true }, note: { type: 'text' } },
      unique: [['starts_at', 'chair']],
    },
    handles: { fields: { handle: { type: 'text', format: 'slug', required: true } }, unique: [['handle']] },
  },
};
const DATA_URL = process.env.BASALT_DATA_URL!;
const ADMIN_URL = process.env.BASALT_ADMIN_URL!;

let db: BasaltData;
const alice = userToken(randomUUID());
const bob = userToken(randomUUID());

async function refused(p: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof BasaltError, String(err));
    assert.equal(err.code, code);
    if (message) assert.match(err.message, message);
    return true;
  });
}

before(async () => {
  await migrate(ADMIN_URL, contractJson);
  db = new BasaltData({ connectionString: DATA_URL, contract: parseContract(contractJson) });
});

after(async () => {
  await db.close();
});

describe('rules: unique across everyone', () => {
  test('only names required fields of the table, in up to 5 groups of up to 3', () => {
    const t = (unique: unknown, fields: Record<string, unknown> = { a: { type: 'text', required: true }, b: { type: 'text' } }) => () =>
      parseContract({ tables: { x: { fields, unique } } });
    assert.doesNotThrow(t([['a']]));
    assert.throws(t([['b']]), /required/);
    assert.throws(t([['nope']]), /isn't one of its fields/);
    assert.throws(t([[]]), /1 to 3/);
    assert.throws(t([['a', 'a']]), /twice/);
    assert.throws(t('a'), /list of field groups/);
    assert.throws(t(Array(6).fill(['a'])), /up to 5/);
  });
});

describe('the database keeps them unique', () => {
  test("a second booking at the same time and chair is refused, even from someone else, without saying whose it is", async () => {
    const at = '2026-11-06T15:00:00.000Z';
    await db.create(alice, 'slots', { starts_at: at, chair: 1, note: 'Alice private note' });
    await refused(db.create(bob, 'slots', { starts_at: at, chair: 1 }), 'conflict', /already taken/);
    await assert.rejects(db.create(bob, 'slots', { starts_at: at, chair: 1 }), (err: Error) => !/Alice|private|owner/i.test(err.message));
    // Another chair at the same time is fine.
    await db.create(bob, 'slots', { starts_at: at, chair: 2 });
  });

  test('archiving frees the slot, and restoring into a taken slot is refused', async () => {
    const at = '2026-11-07T10:00:00.000Z';
    const first = await db.create(alice, 'slots', { starts_at: at, chair: 3 });
    await db.archive(alice, 'slots', first.id as string);
    const second = await db.create(bob, 'slots', { starts_at: at, chair: 3 });
    assert.ok(second.id);
    await refused(db.restore(alice, 'slots', first.id as string), 'conflict');
  });

  test('moving an entry onto a taken value is refused', async () => {
    await db.create(alice, 'handles', { handle: 'shear-joy' });
    const mine = await db.create(bob, 'handles', { handle: 'bob-cuts' });
    await refused(db.update(bob, 'handles', mine.id as string, { handle: 'shear-joy' }), 'conflict');
  });

  test('the rule can only be set when a table is made, like other rules', async () => {
    const changed = structuredClone(contractJson) as any;
    changed.tables.handles.unique = [];
    await assert.rejects(migrate(ADMIN_URL, changed), /unique/);
  });
});

describe("which values are taken (so the app can grey out booked slots)", () => {
  test('anyone signed in sees the taken values in a range, and nothing else about those entries', async () => {
    const carol = userToken(randomUUID());
    const dave = userToken(randomUUID());
    await db.create(carol, 'slots', { starts_at: '2026-12-01T09:00:00.000Z', chair: 1, note: 'Carol private note' });
    await db.create(carol, 'slots', { starts_at: '2026-12-01T11:00:00.000Z', chair: 2 });
    await db.create(carol, 'slots', { starts_at: '2026-12-02T09:00:00.000Z', chair: 1 });
    const gone = await db.create(carol, 'slots', { starts_at: '2026-12-01T13:00:00.000Z', chair: 1 });
    await db.archive(carol, 'slots', gone.id as string);

    // Each taken combination of the unique group (time and chair), so chair 2 at 09:00 still shows as free.
    const r = await db.taken(dave, 'slots', { field: 'starts_at', gte: '2026-12-01T00:00:00.000Z', lt: '2026-12-02T00:00:00.000Z' });
    assert.deepEqual(
      r.taken.map((v) => ({ ...v, starts_at: new Date(v.starts_at as string).toISOString() })),
      [
        { starts_at: '2026-12-01T09:00:00.000Z', chair: 1 },
        { starts_at: '2026-12-01T11:00:00.000Z', chair: 2 },
      ],
    );
    assert.deepEqual(Object.keys(r), ['taken']);
    assert.doesNotMatch(JSON.stringify(r), /Carol|private|owner|note|"id"/i);
    // A single-field rule works the same way.
    await db.create(carol, 'handles', { handle: 'carols-cuts' });
    const h = await db.taken(dave, 'handles', { field: 'handle' });
    assert.ok(h.taken.some((v) => v.handle === 'carols-cuts'));
  });

  test("only for fields the rules keep unique, and only when signed in", async () => {
    await refused(db.taken(alice, 'slots', { field: 'note' }), 'invalid_input', /unique/);
    await refused(db.taken(alice, 'slots', { field: 'nope' }), 'invalid_input');
    await refused(db.taken('not.a.token', 'slots', { field: 'starts_at' }), 'denied');
  });
});
