import { z } from 'zod';

/**
 * Per-project settings. Every knob is bounded so no configuration — human or agent supplied —
 * can produce an insecure deployment (e.g. day-long access tokens or 4-char passwords).
 */
export const ProjectSettingsSchema = z
  .object({
    /** Require proving email ownership before an account exists. Strongly recommended. */
    requireEmailVerification: z.boolean().default(true),
    /** Lifetime of the stateless access JWT. Shorter = faster revocation. */
    accessTokenTtlSeconds: z.number().int().min(60).max(3600).default(600),
    /** Session ends after this long without a refresh. */
    sessionIdleTimeoutSeconds: z.number().int().min(300).max(30 * 86_400).default(7 * 86_400),
    /** Session ends this long after sign-in, regardless of activity. */
    sessionMaxLifetimeSeconds: z.number().int().min(3600).max(90 * 86_400).default(30 * 86_400),
    passwordMinLength: z.number().int().min(10).max(64).default(10),
    checkBreachedPasswords: z.boolean().default(true),
    /** Allow users to enroll TOTP authenticator apps. */
    allowTotp: z.boolean().default(true),
    /**
     * Allow token-in-body responses for clients that cannot use cookies (native mobile apps, CLIs).
     * Browser requests (which always carry an Origin header) always use HttpOnly cookies regardless.
     */
    allowBearerTokens: z.boolean().default(true),
    /** Display name used in emails and authenticator apps. Defaults to the project name. */
    appName: z.string().min(1).max(60).optional(),
  })
  .strict()
  .refine((s) => s.sessionMaxLifetimeSeconds >= s.sessionIdleTimeoutSeconds, {
    message: 'sessionMaxLifetimeSeconds must be >= sessionIdleTimeoutSeconds',
  });

export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const ProjectSettingsPatchSchema = z
  .object({
    requireEmailVerification: z.boolean(),
    accessTokenTtlSeconds: z.number().int(),
    sessionIdleTimeoutSeconds: z.number().int(),
    sessionMaxLifetimeSeconds: z.number().int(),
    passwordMinLength: z.number().int(),
    checkBreachedPasswords: z.boolean(),
    allowTotp: z.boolean(),
    allowBearerTokens: z.boolean(),
    appName: z.string(),
  })
  .partial()
  .strict();

export function parseSettings(raw: unknown): ProjectSettings {
  return ProjectSettingsSchema.parse(raw ?? {});
}

/**
 * Origins must be exact scheme://host[:port]. No wildcards, no paths. http is only accepted for
 * loopback hosts (localhost, *.localhost, 127.0.0.1, [::1]) so a production app can never be
 * configured to trust plaintext origins.
 */
export const OriginSchema = z.string().transform((value, ctx) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    ctx.addIssue({ code: 'custom', message: `Invalid origin: ${value}` });
    return z.NEVER;
  }
  // *.localhost always resolves to this machine (RFC 6761), like a one-laptop demo's app names.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname.endsWith('.localhost');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    ctx.addIssue({ code: 'custom', message: `Origin must use https (http allowed only for localhost): ${value}` });
    return z.NEVER;
  }
  if (!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:]+\]$/.test(url.hostname)) {
    ctx.addIssue({ code: 'custom', message: `Origin host must be a plain hostname (no wildcards): ${value}` });
    return z.NEVER;
  }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    ctx.addIssue({ code: 'custom', message: `Origin must not include a path, query, or credentials: ${value}` });
    return z.NEVER;
  }
  return url.origin;
});

export const OriginListSchema = z.array(OriginSchema).max(50);
