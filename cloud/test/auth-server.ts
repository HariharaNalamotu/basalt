// Runs the real Basalt Auth service in-process for Cloud's tests, on its own database in the
// local Postgres. Cloud talks to it exactly as it talks to the deployed Auth service.

import { randomBytes } from 'node:crypto';
import { pg } from '../../data/src/index.ts';
import { serve } from '../../auth/node_modules/@hono/node-server/dist/index.mjs';
import {
  ConsoleMailer,
  createApp,
  createPgDb,
  createServices,
  KeyRing,
  MemoryRateLimiter,
  migrate,
  PasswordHasher,
  Semaphore,
} from '../../auth/packages/server/dist/index.js';

export async function startAuth(adminUrl: string) {
  // One database per test file, since test files run side by side.
  const dbName = `cloud_test_auth_${process.pid}`;
  const root = new pg.Client({ connectionString: adminUrl });
  await root.connect();
  await root.query(`drop database if exists ${dbName} with (force)`);
  await root.query(`create database ${dbName}`);
  await root.end();
  const u = new URL(adminUrl);
  u.pathname = `/${dbName}`;
  const db = createPgDb({ connectionString: u.toString(), maxConnections: 5 });
  await migrate(db);
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  const ctx = {
    db,
    keyRing: new KeyRing(randomBytes(32)),
    hasher: new PasswordHasher({ memoryKiB: 1024, passes: 1, parallelism: 1 }, new Semaphore(4, 100)),
    rateLimiter: new MemoryRateLimiter(),
    mailer: new ConsoleMailer(),
    breachChecker: undefined,
    log: silent,
    publicUrl: 'https://auth.cloud.test',
    now: () => new Date(),
  };
  const services = createServices(ctx);
  const platformKey = randomBytes(32).toString('hex');
  const app = createApp(ctx, services, { platformKey, isProduction: false, trustProxyHops: 0, cookieSecure: true });
  const server = await new Promise<any>((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    platformKey,
    async close() {
      await new Promise((r) => server.close(r));
      (ctx.rateLimiter as { close(): void }).close();
      await db.close();
    },
  };
}
