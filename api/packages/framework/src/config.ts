import { z } from 'zod';

/**
 * Service configuration managed by the platform (and editable by coding agents through the MCP
 * tools) without code changes. Delivered to the app as the BASALT_API_CONFIG environment variable.
 *
 * Code defines WHAT the API is (routes, schemas, who may call them); this config tunes HOW it runs.
 * Every value is bounded. Per-route auth overrides can only make a route STRICTER — loosening auth
 * (e.g. making a route public) requires a visible code change.
 */
const Rule = z.object({ limit: z.number().int().min(1).max(100_000), windowSeconds: z.number().int().min(1).max(86_400) }).strict();

const Origin = z
  .string()
  .refine((o) => {
    try {
      const u = new URL(o);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
      return u.origin === o && (u.protocol === 'https:' || (u.protocol === 'http:' && loopback));
    } catch {
      return false;
    }
  }, 'must be an exact origin like https://app.example.com (http only for localhost)');

const RouteAuthTightening = z.union([
  z.literal('required'),
  z
    .object({
      mfa: z.boolean().optional(),
      emailVerified: z.boolean().optional(),
      maxAgeSeconds: z.number().int().min(1).max(86_400).optional(),
      strict: z.boolean().optional(),
    })
    .strict(),
]);

export const RouteOverrideSchema = z
  .object({
    rateLimit: Rule.optional(),
    timeoutMs: z.number().int().min(100).max(30_000).optional(),
    bodyLimitBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
    /** Can only add requirements; never relaxes what the code declares. */
    auth: RouteAuthTightening.optional(),
    /** Kill switch: the route answers 503 until re-enabled (e.g. during an incident). */
    disabled: z.boolean().optional(),
  })
  .strict();

export const ApiServiceConfigSchema = z
  .object({
    allowedOrigins: z.array(Origin).max(50).optional(),
    limits: z
      .object({
        maxInFlight: z.number().int().min(1).max(10_000).optional(),
        defaultTimeoutMs: z.number().int().min(100).max(30_000).optional(),
        defaultBodyLimitBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
        perIp: Rule.optional(),
      })
      .strict()
      .optional(),
    defaultRateLimits: z.object({ user: Rule.optional(), public: Rule.optional() }).strict().optional(),
    /** Keyed by "METHOD /path" as written in code, e.g. "POST /todos" or "GET /todos/:id". */
    routes: z.record(z.string().regex(/^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9._~:/-]*$/, 'keys look like "POST /todos"'), RouteOverrideSchema).optional(),
    /** Every route answers 503 with Retry-After (health checks still pass). */
    maintenance: z.object({ enabled: z.boolean(), message: z.string().max(200).optional() }).strict().optional(),
    revocationSync: z.boolean().optional(),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).optional(),
  })
  .strict();

export type ApiServiceConfig = z.infer<typeof ApiServiceConfigSchema>;
export type RouteOverride = z.infer<typeof RouteOverrideSchema>;

/** Parses BASALT_API_CONFIG (or an object). Throws a readable error so bad config fails at startup. */
export function parseServiceConfig(raw: unknown): ApiServiceConfig {
  if (raw === undefined || raw === null || raw === '') return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Basalt API: BASALT_API_CONFIG is not valid JSON.');
    }
  }
  const r = ApiServiceConfigSchema.safeParse(value);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`Basalt API: invalid BASALT_API_CONFIG:\n${lines}`);
  }
  return r.data;
}

type AuthSpecLike = 'required' | 'optional' | 'public' | { mfa?: boolean; emailVerified?: boolean; maxAgeSeconds?: number; strict?: boolean };

/** Combines code-declared auth with a config tightening; the result is never weaker than either. */
export function tightenAuth(code: AuthSpecLike | undefined, override: RouteOverride['auth']): AuthSpecLike {
  const base = code ?? 'required';
  if (!override) return base;
  const asObj = (a: AuthSpecLike) => (typeof a === 'object' ? a : {});
  const o = override === 'required' ? {} : override;
  const c = asObj(base);
  const maxAge = [c.maxAgeSeconds, o.maxAgeSeconds].filter((v): v is number => v !== undefined);
  const merged = {
    mfa: Boolean(c.mfa || o.mfa) || undefined,
    emailVerified: Boolean(c.emailVerified || o.emailVerified) || undefined,
    strict: Boolean(c.strict || o.strict) || undefined,
    maxAgeSeconds: maxAge.length ? Math.min(...maxAge) : undefined,
  };
  const hasExtra = Object.values(merged).some((v) => v !== undefined);
  return hasExtra ? merged : 'required';
}
