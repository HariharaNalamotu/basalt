import { randomBytes } from 'node:crypto';
import { ApiServiceConfigSchema, RouteOverrideSchema, type ApiServiceConfig, type RouteOverride } from '@basalt/api';
import type { ControlPlane as AuthControlPlane } from '@basalt/auth-mcp';
import type { ApiPlatform, EnvVar } from './platform.js';

export const APP_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;

export interface Deps {
  platform: ApiPlatform;
  auth: AuthControlPlane;
}

export interface SetupInput {
  app: string;
  /** Display name for emails etc. */
  name?: string;
  /** Every origin the app is served from (production domain, dev edge e.g. http://localhost:8080). */
  origins?: string[];
}

export interface SetupResult {
  steps: string[];
  projectId: string;
  env: Record<string, string>;
  note?: string;
}

/**
 * Provisions everything an app's backend needs, idempotently: re-running repairs anything missing
 * and changes nothing that's already correct. Secrets go straight into the platform's env store.
 */
export async function setupApp({ platform, auth }: Deps, input: SetupInput): Promise<SetupResult> {
  if (!APP_NAME_RE.test(input.app)) throw new Error('app must be lowercase letters, digits and dashes (2–41 chars), starting with a letter.');
  const steps: string[] = [];
  const env = await platform.readEnv(input.app);
  const write: Record<string, EnvVar> = {};
  const origins = input.origins ?? [];

  // 1. Auth project (one per app).
  let projectId = env.BASALT_PROJECT_ID?.value;
  if (projectId) {
    const found = await auth.getProject(projectId).catch(() => null);
    if (!found) projectId = undefined;
    else {
      const merged = [...new Set([...found.project.allowedOrigins, ...origins])];
      if (merged.length !== found.project.allowedOrigins.length) {
        await auth.updateProject(projectId, { allowedOrigins: merged });
        steps.push(`added origins to auth project: ${origins.filter((o) => !found.project.allowedOrigins.includes(o)).join(', ')}`);
      } else steps.push(`auth project ${projectId} already set up`);
    }
  }
  if (!projectId) {
    const { project, secretKey } = await auth.createProject({ name: input.name ?? input.app, allowedOrigins: origins });
    projectId = project.id;
    write.BASALT_PROJECT_ID = { value: project.id, secret: false };
    write.BASALT_AUTH_SECRET_KEY = { value: secretKey, secret: true };
    steps.push(`created auth project ${project.id}`);
  }
  write.BASALT_AUTH_URL = { value: auth.authUrl, secret: false };

  // 2. Edge secret (backend accepts only edge-signed requests).
  const edgeSecret = env.BASALT_EDGE_SECRET?.value ?? randomBytes(32).toString('base64url');
  if (!env.BASALT_EDGE_SECRET) {
    write.BASALT_EDGE_SECRET = { value: edgeSecret, secret: true };
    steps.push('generated edge secret');
  }
  await platform.configureEdge(input.app, { edgeSecret, projectId, apiBasePath: '/api' });

  // 3. Database with separate admin and restricted runtime roles.
  const db = await platform.ensureDatabase(input.app);
  Object.assign(write, db.env);
  steps.push(db.created ? `created database ${db.database} (admin role ${db.adminRole}, runtime role ${db.appRole})` : `database ${db.database} already exists`);

  // 4. Redis for shared rate limits + idempotency.
  const redis = await platform.ensureRedis(input.app);
  Object.assign(write, redis.env);
  if (redis.created) steps.push('assigned Redis');

  if (!env.BASALT_API_CONFIG) write.BASALT_API_CONFIG = { value: '{}', secret: false };
  await platform.writeEnv(input.app, write);

  // 5. Database-enforced ownership (idempotent install of verifier + key).
  const installSql = await auth.getDataProtectionSql(projectId);
  await platform.adminQuery(input.app, installSql);
  steps.push('installed database-enforced ownership (basalt_auth schema)');

  const applied = await platform.applyChanges(input.app);
  return { steps, projectId, env: maskEnv({ ...env, ...write }), note: applied.note };
}

export function maskEnv(env: Record<string, EnvVar>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v.secret ? '•••• (secret, set)' : v.value]));
}

export async function readConfig(platform: ApiPlatform, app: string): Promise<ApiServiceConfig> {
  const env = await platform.readEnv(app);
  if (!env.BASALT_API_CONFIG) throw new Error(`App "${app}" is not set up yet. Run api_setup first.`);
  return ApiServiceConfigSchema.parse(JSON.parse(env.BASALT_API_CONFIG.value));
}

/** Validates the whole resulting config (bounds included) before anything is written. */
export async function writeConfig(platform: ApiPlatform, app: string, next: unknown) {
  const parsed = ApiServiceConfigSchema.safeParse(next);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`Invalid config, nothing changed:\n- ${issues.join('\n- ')}`);
  }
  await platform.writeEnv(app, { BASALT_API_CONFIG: { value: JSON.stringify(parsed.data), secret: false } });
  const applied = await platform.applyChanges(app);
  return { config: parsed.data, note: applied.note };
}

/** Deep merge where `null` removes a key (so agents can clear an override). */
export function mergeConfig(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else out[k] = v;
  }
  return out;
}

export async function setRoutePolicy(platform: ApiPlatform, app: string, route: string, policy: RouteOverride | null) {
  if (!/^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9._~:/-]*$/.test(route)) throw new Error('route must look like "POST /todos" (method, space, path as written in code).');
  if (policy) RouteOverrideSchema.parse(policy);
  const cfg = await readConfig(platform, app);
  const routes = { ...(cfg.routes ?? {}) };
  if (policy === null) delete routes[route];
  else routes[route] = policy;
  return writeConfig(platform, app, { ...cfg, routes: Object.keys(routes).length ? routes : undefined });
}

export async function rotateEdgeSecret({ platform }: Deps, app: string) {
  const env = await platform.readEnv(app);
  if (!env.BASALT_PROJECT_ID) throw new Error(`App "${app}" is not set up yet. Run api_setup first.`);
  const edgeSecret = randomBytes(32).toString('base64url');
  await platform.writeEnv(app, { BASALT_EDGE_SECRET: { value: edgeSecret, secret: true } });
  await platform.configureEdge(app, { edgeSecret, projectId: env.BASALT_PROJECT_ID.value, apiBasePath: '/api' });
  return platform.applyChanges(app);
}

export interface StatusReport {
  platform: string;
  env: Record<string, string>;
  checks: Array<{ ok: boolean; check: string; fix?: string }>;
  routes?: Array<Record<string, unknown>>;
  config?: ApiServiceConfig;
}

const REQUIRED_ENV = ['BASALT_PROJECT_ID', 'BASALT_AUTH_URL', 'BASALT_AUTH_SECRET_KEY', 'BASALT_EDGE_SECRET', 'DATABASE_URL', 'DATABASE_ADMIN_URL', 'REDIS_URL', 'BASALT_API_CONFIG'];

/** Everything an agent needs to know about the app's backend, with concrete fixes for problems. */
export async function status({ platform, auth }: Deps, app: string): Promise<StatusReport> {
  const env = await platform.readEnv(app);
  const checks: StatusReport['checks'] = [];
  for (const k of REQUIRED_ENV) {
    checks.push({ ok: Boolean(env[k]), check: `env ${k} is set`, fix: env[k] ? undefined : 'run api_setup' });
  }
  if (env.BASALT_PROJECT_ID) {
    const p = await auth.getProject(env.BASALT_PROJECT_ID.value).catch(() => null);
    checks.push({ ok: Boolean(p), check: 'auth project exists', fix: p ? undefined : 'run api_setup to recreate it' });
    if (p) {
      checks.push({
        ok: p.project.allowedOrigins.length > 0,
        check: `auth allowed origins: ${p.project.allowedOrigins.join(', ') || '(none)'}`,
        fix: p.project.allowedOrigins.length ? undefined : 'run api_setup with origins (every domain that serves the app)',
      });
    }
  }
  let config: ApiServiceConfig | undefined;
  if (env.BASALT_API_CONFIG) {
    try {
      config = ApiServiceConfigSchema.parse(JSON.parse(env.BASALT_API_CONFIG.value));
      checks.push({ ok: true, check: 'BASALT_API_CONFIG is valid' });
    } catch {
      checks.push({ ok: false, check: 'BASALT_API_CONFIG is valid', fix: 'rewrite it with api_update_config (replace: true)' });
    }
    if (config?.maintenance?.enabled) checks.push({ ok: false, check: 'maintenance mode is ON (all routes answer 503)', fix: 'api_set_maintenance enabled=false' });
  }
  if (env.DATABASE_ADMIN_URL) {
    try {
      const installed = await platform.adminQuery(app, `SELECT to_regclass('basalt_auth.keys') IS NOT NULL AS ok`);
      checks.push({ ok: installed[0]?.ok === true, check: 'database-enforced ownership installed', fix: installed[0]?.ok ? undefined : 'run api_setup' });
      if (installed[0]?.ok) {
        const unprotected = await platform.adminQuery(app, 'SELECT table_name, owner_like_column FROM basalt_auth.unprotected_tables()');
        checks.push({
          ok: unprotected.length === 0,
          check: unprotected.length ? `unprotected per-user tables: ${unprotected.map((t) => `${t.table_name}(${t.owner_like_column})`).join(', ')}` : 'all per-user tables are protected',
          fix: unprotected.length ? `add a migration: ${unprotected.map((t) => `SELECT basalt_auth.protect('${t.table_name}', '${t.owner_like_column}');`).join(' ')}` : undefined,
        });
      }
      const appUser = env.DATABASE_URL ? decodeURIComponent(new URL(env.DATABASE_URL.value).username) : '';
      if (appUser) {
        const role = await platform.adminQuery(app, 'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [appUser]);
        const safe = role[0] && !role[0].rolsuper && !role[0].rolbypassrls;
        checks.push({ ok: Boolean(safe), check: `runtime role ${appUser} cannot bypass row-level security`, fix: safe ? undefined : 'DATABASE_URL must use the restricted runtime role' });
      }
    } catch (err) {
      checks.push({ ok: false, check: 'database reachable', fix: (err as Error).message });
    }
  }
  let routes: StatusReport['routes'];
  if (platform.callBackend && env.BASALT_EDGE_SECRET) {
    try {
      const res = await platform.callBackend(app, '/_basalt/introspect');
      if (res.ok) {
        routes = ((await res.json()) as { routes: Array<Record<string, unknown>> }).routes;
        checks.push({ ok: true, check: `backend is running (${routes.length} routes)` });
        for (const r of routes) {
          if (r.auth === 'public' && r.method !== 'GET') {
            checks.push({ ok: true, check: `note: ${r.key} is a PUBLIC write route; confirm that's intended and its rate limit (${JSON.stringify(r.rateLimit)}) is tight` });
          }
        }
      } else checks.push({ ok: false, check: `backend responded ${res.status} to the signed introspection call`, fix: 'restart the backend so it loads the current env file' });
    } catch {
      checks.push({ ok: false, check: 'backend is running', fix: 'start the backend (see api_integration_guide topic "setup")' });
    }
  }
  return { platform: platform.describe(), env: maskEnv(env), checks, routes, config };
}
