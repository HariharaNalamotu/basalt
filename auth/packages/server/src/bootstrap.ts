import { Redis } from 'ioredis';
import { createApp, createServices } from './app.js';
import { loadConfig, type Config } from './config.js';
import type { ServiceContext } from './context.js';
import { createPgDb } from './db/db.js';
import { migrate } from './db/migrate.js';
import { KeyRing } from './lib/crypto.js';
import { createLogger } from './lib/logger.js';
import { ConsoleMailer, WebhookMailer } from './lib/mailer.js';
import { HibpBreachChecker, DEFAULT_ARGON2, PasswordHasher } from './lib/password.js';
import { MemoryRateLimiter, RedisRateLimiter } from './lib/ratelimit.js';
import { Semaphore } from './lib/semaphore.js';
import { runMaintenance } from './services/maintenance.js';

const MAINTENANCE_INTERVAL_MS = 5 * 60_000;

export async function bootstrap(config: Config = loadConfig()) {
  const log = createLogger(config.logLevel);
  const db = createPgDb({ connectionString: config.databaseUrl, maxConnections: config.databaseMaxConnections });
  const applied = await migrate(db);
  if (applied.length) log.info('migrations_applied', { applied });

  const redis = config.redisUrl ? new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableAutoPipelining: true }) : undefined;
  if (!redis) log.warn('rate_limits_in_memory', { note: 'Set REDIS_URL so limits are shared across replicas.' });

  const ctx: ServiceContext = {
    db,
    keyRing: new KeyRing(config.masterKey),
    hasher: new PasswordHasher(DEFAULT_ARGON2, new Semaphore(config.hashConcurrency, config.hashQueueLimit)),
    rateLimiter: redis ? new RedisRateLimiter(redis) : new MemoryRateLimiter(),
    mailer:
      config.mailer.kind === 'webhook'
        ? new WebhookMailer(config.mailer.url, config.mailer.secret)
        : new ConsoleMailer(createLogger('info', { allowKeys: ['text'] })),
    breachChecker: new HibpBreachChecker(),
    log,
    publicUrl: config.publicUrl,
    now: () => new Date(),
  };
  const services = createServices(ctx);
  const app = createApp(ctx, services, {
    platformKey: config.platformKey,
    isProduction: config.env === 'production',
    trustProxyHops: config.trustProxyHops,
    cookieSecure: config.cookieSecure,
    ready: async () => {
      await db.query('SELECT 1');
      if (redis) await redis.ping();
      return true;
    },
  });

  const timer = setInterval(() => {
    runMaintenance(ctx, services.signingKeys).catch((err) => log.error('maintenance_failed', { err }));
  }, MAINTENANCE_INTERVAL_MS);
  timer.unref();

  return {
    app,
    config,
    log,
    ctx,
    services,
    async shutdown() {
      clearInterval(timer);
      await services.accounts.drain();
      await db.close();
      await redis?.quit();
    },
  };
}
