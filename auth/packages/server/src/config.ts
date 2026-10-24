import { availableParallelism } from 'node:os';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  /** Public base URL of this service. Used as the JWT issuer prefix. */
  PUBLIC_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().min(1).max(500).default(20),
  /** Required in production: rate limits must be shared across replicas. */
  REDIS_URL: z.string().optional(),
  /** 32 random bytes, base64. Encrypts signing keys and TOTP secrets; derives the code pepper. */
  BASALT_AUTH_MASTER_KEY: z.string().min(1),
  /** Bearer key the Basalt platform control plane uses for /v1/platform. */
  BASALT_AUTH_PLATFORM_KEY: z.string().min(32),
  /** How many reverse-proxy hops to trust for X-Forwarded-For / X-Forwarded-Prefix. 0 = trust none. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /** Set false only for plain-http local development. */
  COOKIE_SECURE: bool.default(true),
  MAILER: z.enum(['console', 'webhook']).default('console'),
  MAIL_WEBHOOK_URL: z.string().url().optional(),
  MAIL_WEBHOOK_SECRET: z.string().min(32).optional(),
  HASH_CONCURRENCY: z.coerce.number().int().min(1).max(256).optional(),
  HASH_QUEUE_LIMIT: z.coerce.number().int().min(1).max(100_000).default(200),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  publicUrl: string;
  databaseUrl: string;
  databaseMaxConnections: number;
  redisUrl: string | undefined;
  masterKey: Buffer;
  platformKey: string;
  trustProxyHops: number;
  cookieSecure: boolean;
  mailer: { kind: 'console' } | { kind: 'webhook'; url: string; secret: string };
  hashConcurrency: number;
  hashQueueLimit: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const masterKey = Buffer.from(e.BASALT_AUTH_MASTER_KEY, 'base64');
  if (masterKey.length !== 32) {
    throw new Error('BASALT_AUTH_MASTER_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  }
  const publicUrl = e.PUBLIC_URL.replace(/\/+$/, '');

  if (e.NODE_ENV === 'production') {
    const problems: string[] = [];
    if (!e.REDIS_URL) problems.push('REDIS_URL is required in production (rate limits must be shared across replicas)');
    if (!e.COOKIE_SECURE) problems.push('COOKIE_SECURE=false is not allowed in production');
    if (!publicUrl.startsWith('https://')) problems.push('PUBLIC_URL must be https in production');
    if (e.MAILER === 'console') problems.push('MAILER=console is not allowed in production');
    if (problems.length) throw new Error(`Refusing to start:\n  ${problems.join('\n  ')}`);
  }

  let mailer: Config['mailer'] = { kind: 'console' };
  if (e.MAILER === 'webhook') {
    if (!e.MAIL_WEBHOOK_URL || !e.MAIL_WEBHOOK_SECRET) {
      throw new Error('MAILER=webhook requires MAIL_WEBHOOK_URL and MAIL_WEBHOOK_SECRET');
    }
    mailer = { kind: 'webhook', url: e.MAIL_WEBHOOK_URL, secret: e.MAIL_WEBHOOK_SECRET };
  }

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    publicUrl,
    databaseUrl: e.DATABASE_URL,
    databaseMaxConnections: e.DATABASE_MAX_CONNECTIONS,
    redisUrl: e.REDIS_URL,
    masterKey,
    platformKey: e.BASALT_AUTH_PLATFORM_KEY,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    cookieSecure: e.COOKIE_SECURE,
    mailer,
    hashConcurrency: e.HASH_CONCURRENCY ?? Math.max(2, availableParallelism()),
    hashQueueLimit: e.HASH_QUEUE_LIMIT,
    logLevel: e.LOG_LEVEL,
  };
}
