#!/usr/bin/env node
import { serve } from '@hono/node-server';
import { Redis } from 'ioredis';
import { createLog } from '@basalt/host-shared';
import { createInternalApi, createPublicApi } from './api.js';
import { loadConfig } from './config.js';
import { authFactory, type Ctx } from './ctx.js';
import { SecretBox } from './crypto.js';
import { createDb, migrate } from './db.js';
import { Docker } from './docker.js';
import { publishBasaltPackages } from './registry.js';
import { Host } from './service.js';

const cfg = loadConfig();
const log = createLog('control');
const db = createDb(cfg.DATABASE_URL);
await migrate(db);

let version = Date.now();
const ctx: Ctx = {
  cfg,
  db,
  box: new SecretBox(cfg.masterKey),
  docker: new Docker(cfg.DOCKER_SOCKET),
  redis: new Redis(cfg.REDIS_ADMIN_URL, { maxRetriesPerRequest: 3 }),
  log,
  routes: {
    get version() {
      return version;
    },
    bump() {
      version++;
    },
    async sync() {
      version++;
      // The edge polls every second; asking it to reload now makes "released" mean "serving".
      await fetch(`${cfg.EDGE_ADMIN_URL}/reload`, { method: 'POST', headers: { authorization: `Bearer ${cfg.INTERNAL_TOKEN}` }, signal: AbortSignal.timeout(3000) }).catch(() => {});
    },
  },
  authFor: authFactory(cfg),
};
const host = new Host(ctx);
await host.recover();

publishBasaltPackages(cfg.REGISTRY_URL, log).catch((err) => log.error('registry_publish_failed', { err }));

const janitor = setInterval(() => {
  host.runtime.janitor({ get: (id) => host.appById(id) }).catch((err) => log.error('janitor_failed', { err }));
}, 60_000);

// basalt-admin (a separate process) can flip global under-attack mode in the database; notice it
// here so the edge picks it up within seconds.
let underAttack: boolean | undefined;
const watchSettings = setInterval(() => {
  db.query<{ value: boolean }>(`SELECT value FROM platform_settings WHERE key = 'under_attack'`)
    .then(({ rows }) => {
      const now = rows[0]?.value === true;
      if (underAttack !== undefined && now !== underAttack) void ctx.routes.sync?.();
      underAttack = now;
    })
    .catch((err) => log.error('settings_watch_failed', { err }));
}, 3000);

const pub = serve({ fetch: createPublicApi(ctx, host).fetch, port: cfg.PORT, hostname: '0.0.0.0' }, () => log.info('listening', { port: cfg.PORT, api: 'public' }));
const internalPort = cfg.PORT + 1;
const internal = serve({ fetch: createInternalApi(ctx, host).fetch, port: internalPort, hostname: '0.0.0.0' }, () => log.info('listening', { port: internalPort, api: 'internal' }));

for (const s of ['SIGTERM', 'SIGINT'] as const) {
  process.once(s, () => {
    clearInterval(janitor);
    clearInterval(watchSettings);
    pub.close();
    internal.close();
    void db.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
