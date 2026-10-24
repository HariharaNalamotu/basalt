// Load test: seeds rows across many users, then runs concurrent users through
// the HTTP service with a read-heavy mix. Local only.
//
//   node --env-file=.env bench/load.ts [seconds] [concurrency]

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { BasaltData, createBasalt, createDataServer, parseContract } from '../src/index.ts';
import { migrate } from '../src/migrate.ts';
import { userToken } from '../test/helpers.ts';

const seconds = Number(process.argv[2] ?? 10);
const concurrency = Number(process.argv[3] ?? 64);
const USERS = 2000;
const ROWS_PER_USER = 100;

const contractJson = JSON.parse(readFileSync(new URL('../contract.example.json', import.meta.url), 'utf8'));
await migrate(process.env.BASALT_ADMIN_URL!, contractJson);

const users = Array.from({ length: USERS }, () => randomUUID());
const admin = new pg.Client({ connectionString: process.env.BASALT_ADMIN_URL });
await admin.connect();
const saved = (await admin.query('select reads_per_minute, writes_per_minute from basalt.settings')).rows[0];
await admin.query('update basalt.settings set reads_per_minute = 100000000, writes_per_minute = 100000000');
let restored = false;
const restore = async () => {
  if (restored) return;
  restored = true;
  await admin.query('update basalt.settings set reads_per_minute = $1, writes_per_minute = $2', [saved.reads_per_minute, saved.writes_per_minute]);
};
process.on('uncaughtException', async (err) => {
  await restore().catch(() => {});
  console.error(err);
  process.exit(1);
});
await admin.query(
  `insert into app.bookings (owner_id, service, starts_at)
   select u, 'Seed ' || g, now() + (g || ' minutes')::interval
   from unnest($1::uuid[]) u, generate_series(1, $2) g`,
  [users, ROWS_PER_USER],
);
await admin.query('analyze app.bookings');
const total = (await admin.query('select count(*)::int as n from app.bookings')).rows[0].n;

const data = new BasaltData({ connectionString: process.env.BASALT_DATA_URL!, contract: parseContract(contractJson), poolSize: 40 });
const server = createDataServer({ data, maxInFlight: 1024 });
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const latencies: number[] = [];
let errors = 0;
const deadline = Date.now() + seconds * 1000;

async function worker(): Promise<void> {
  while (Date.now() < deadline) {
    const uid = users[Math.floor(Math.random() * USERS)];
    const basalt = createBasalt({ url, token: userToken(uid) });
    const roll = Math.random();
    const t0 = performance.now();
    try {
      if (roll < 0.7) {
        const page = await basalt.data.list('bookings', { limit: 20 });
        if (page.rows.length && roll < 0.35) await basalt.data.get('bookings', page.rows[0].id as string);
      } else if (roll < 0.9) {
        await basalt.data.create('bookings', { service: 'Load', starts_at: '2026-10-25T15:00:00Z' });
      } else {
        const page = await basalt.data.list('bookings', { limit: 1 });
        if (page.rows.length) await basalt.data.update('bookings', page.rows[0].id as string, { note: String(Math.random()) });
      }
      latencies.push(performance.now() - t0);
    } catch {
      errors++;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));
latencies.sort((a, b) => a - b);
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(1);
console.log(
  JSON.stringify(
    {
      rows_in_table: total,
      users: USERS,
      concurrency,
      seconds,
      operations: latencies.length,
      ops_per_second: Math.round(latencies.length / seconds),
      errors,
      p50_ms: pct(50),
      p95_ms: pct(95),
      p99_ms: pct(99),
    },
    null,
    2,
  ),
);

await restore();
await admin.end();
server.close();
await data.close();
