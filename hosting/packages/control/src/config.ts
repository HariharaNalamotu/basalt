import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  PORT: z.coerce.number().int().default(4000),
  /** Root domain served through Cloudflare, e.g. basalt.example.com → apps at <app>.basalt.example.com */
  ROOT_DOMAIN: z.string().regex(/^([a-z0-9-]+\.)+[a-z]{2,}$/),
  /** Platform state database (control plane tables). */
  DATABASE_URL: z.string().min(1),
  /** Superuser connection used to create per-environment databases and roles. */
  PG_ADMIN_URL: z.string().min(1),
  /** Redis admin connection (creates per-environment ACL users). */
  REDIS_ADMIN_URL: z.string().min(1),
  /** Host:port app containers use for Redis, e.g. redis:6379. */
  REDIS_HOST: z.string().default('redis:6379'),
  AUTH_INTERNAL_URL: z.string().url().default('http://auth:8787'),
  /** Issuer prefix of the auth service (its PUBLIC_URL). */
  AUTH_PUBLIC_URL: z.string().url(),
  AUTH_PLATFORM_KEY: z.string().min(32),
  /** 32 bytes base64: encrypts secrets at rest. */
  MASTER_KEY: z.string().min(40),
  /** Shared with edge and browser worker for internal calls. */
  INTERNAL_TOKEN: z.string().min(32),
  /** Verifies auth-service mail webhooks. */
  MAIL_WEBHOOK_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().default('no-reply@example.com'),
  DATA_DIR: z.string().default('/data'),
  /** Docker volume that DATA_DIR is mounted from (build/test containers mount subpaths of it). */
  DATA_VOLUME: z.string().default('basalt-data'),
  DOCKER_SOCKET: z.string().default('/var/run/docker.sock'),
  REGISTRY_URL: z.string().url().default('http://verdaccio:4873/'),
  EGRESS_PROXY: z.string().default('http://egress:3128'),
  BROWSER_URL: z.string().url().default('http://browser:7070'),
  EDGE_ADMIN_URL: z.string().url().default('http://edge:9090'),
  /** Infra containers that join every environment network. */
  INFRA_CONTAINERS: z.string().default('basalt-postgres,basalt-redis,basalt-auth,basalt-edge,basalt-egress,basalt-cloud'),
  EDGE_CONTAINER: z.string().default('basalt-edge'),
  BUILD_NETWORK: z.string().default('basalt_build'),
  RUNTIME_IMAGE: z.string().default('basalt/runtime:1'),
  BUILD_IMAGE: z.string().default('node:24-alpine'),
  TEST_IMAGE: z.string().default('mcr.microsoft.com/playwright:v1.64.1-noble'),
  /** Capacity limits for a single machine. */
  MAX_RUNNING_APPS: z.coerce.number().int().default(40),
  MAX_PREVIEWS_PER_APP: z.coerce.number().int().default(3),
  MAX_CONCURRENT_BUILDS: z.coerce.number().int().default(2),
  PREVIEW_TTL_HOURS: z.coerce.number().int().default(24),
  SLEEP_AFTER_MINUTES: z.coerce.number().int().default(30),
  APP_MEMORY_MB: z.coerce.number().int().default(256),
  PRODUCTION_MEMORY_MB: z.coerce.number().int().default(512),
  BUILD_MEMORY_MB: z.coerce.number().int().default(1536),
  TEST_MEMORY_MB: z.coerce.number().int().default(1536),
  BUILD_TIMEOUT_MINUTES: z.coerce.number().int().default(15),
  /** Basalt Cloud (the Data block) on the platform network, like http://cloud:8790. Unset: no data projects. */
  CLOUD_INTERNAL_URL: z.string().url().optional(),
  /** Cloud's CLOUD_PLATFORM_KEY. */
  CLOUD_PLATFORM_KEY: z.string().min(32).optional(),
  /** How browsers reach apps: https behind Cloudflare; the one-laptop demo uses http and port 8080. */
  PUBLIC_SCHEME: z.enum(['https', 'http']).default('https'),
  PUBLIC_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /** Where coding agents reach the control API. Default https://host.<ROOT_DOMAIN>. */
  HOST_PUBLIC_URL: z.string().url().optional(),
  /** Where developers' npm reaches the @basalt registry. Default https://registry.<ROOT_DOMAIN>/. */
  REGISTRY_PUBLIC_URL: z.string().url().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const r = Env.safeParse(env);
  if (!r.success) throw new Error(`Invalid configuration:\n${r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  const c = r.data;
  const masterKey = Buffer.from(c.MASTER_KEY, 'base64');
  if (masterKey.length !== 32) throw new Error('MASTER_KEY must be 32 bytes, base64');
  if (Boolean(c.CLOUD_INTERNAL_URL) !== Boolean(c.CLOUD_PLATFORM_KEY)) throw new Error('Set both CLOUD_INTERNAL_URL and CLOUD_PLATFORM_KEY, or neither.');
  const dataLink = c.CLOUD_INTERNAL_URL && c.CLOUD_PLATFORM_KEY ? { url: c.CLOUD_INTERNAL_URL, platformKey: c.CLOUD_PLATFORM_KEY } : null;
  const hostPublicUrl = (c.HOST_PUBLIC_URL ?? `https://host.${c.ROOT_DOMAIN}`).replace(/\/+$/, '');
  const registryPublicUrl = (c.REGISTRY_PUBLIC_URL ?? `https://registry.${c.ROOT_DOMAIN}/`).replace(/\/*$/, '/');
  /** The URL people and their browsers use for an app host (what links and allowed origins say). */
  const appUrl = (host: string) => `${c.PUBLIC_SCHEME}://${host}${c.PUBLIC_PORT ? `:${c.PUBLIC_PORT}` : ''}`;
  return { ...c, masterKey, dataLink, hostPublicUrl, registryPublicUrl, appUrl, infraContainers: c.INFRA_CONTAINERS.split(',').map((s) => s.trim()).filter(Boolean) };
}
